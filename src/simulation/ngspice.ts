// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { chmod, lstat, mkdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AnyCircuitElement } from "tscircuit";
import { refreshBuildInputSnapshot, type BuildInputSnapshot } from "../artifacts/inputs";
import { canonicalCircuitJson, parseCanonicalCircuitJson } from "../circuit-json";
import { defineDiagnostic, diagnosticId, type Diagnostic } from "../diagnostics";
import {
  NGSPICE_EXECUTABLE_BYTES_LIMIT,
  probeNgspice,
  type ExternalToolProbe,
} from "../external-tools";
import { readBoundedRegularFile } from "../internal/bounded-file";
import {
  isFulmetryCancellationError,
  throwIfFulmetryCancelled,
} from "../internal/cancellation";
import { spawnContainedProcess } from "../internal/contained-process";
import {
  isNgspiceDcSweepAxisName,
  isSemanticallyRealFrequencySample,
  parseNgspiceRawVariableDeclaration,
} from "./ngspice-raw-variable";
import { assuranceStatus } from "../status";
import { requireSupportedBunRuntime } from "../runtime";
import {
  MAX_SIMULATION_MODEL_ARTIFACT_BYTES,
  MAX_SIMULATION_MODEL_BYTES,
  validateStaticSimulationModel,
  verifySimulationModelAssets,
} from "./assets";
import { parseSimulationDefinition, simulationVectorBaseUnit, type SimulationDefinition, type SimulationVectorOperand } from "./definition";
import {
  assertSimulationDirectoryIdentity,
  captureSimulationDirectoryIdentity,
  SIMULATION_ARTIFACT_FILE_BYTES_LIMIT,
  SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT,
  verifyExactSimulationArtifacts,
} from "./exact-output";
import {
  isIssuedNgspiceQualification,
  qualifyCapturedNgspice,
} from "./ngspice-qualification";
import {
  authenticateSimulationDefinitionAuthority,
  type AuthenticatedSimulationDefinitionIdentity,
  type IssuedSimulationDefinitionAuthority,
} from "./loader";
import {
  assessQualifiedSimulationResult,
  MAX_SIMULATION_SAMPLES_PER_VECTOR,
  MAX_SIMULATION_TOTAL_SAMPLES,
  MAX_SIMULATION_VECTORS,
  simulationDefinitionDigest,
  type SimulationAssessment,
  type SimulationResultEvidence,
  type SimulationSample,
} from "./result";

export interface IssuedFunctionalSimulationAuthority {
  readonly evidence: Readonly<SimulationResultEvidence>;
  readonly inputSnapshotDigest: string;
  readonly definitionIdentity: Readonly<AuthenticatedSimulationDefinitionIdentity>;
}

const ISSUED_FUNCTIONAL_SIMULATIONS = new WeakSet<object>();
const PRISTINE_FUNCTIONAL_WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const PRISTINE_FUNCTIONAL_WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;

function issueFunctionalSimulationAuthority(options: {
  readonly evidence: Readonly<SimulationResultEvidence>;
  readonly assessment: Readonly<SimulationAssessment>;
  readonly inputSnapshotDigest: string;
  readonly definitionIdentity: Readonly<AuthenticatedSimulationDefinitionIdentity>;
}): Readonly<IssuedFunctionalSimulationAuthority> {
  if (options.assessment.status.state !== "passed" || options.assessment.diagnostics.length !== 0) {
    throw new Error("Only a diagnostic-free passing simulation can issue functional authority");
  }
  if (!/^[a-f0-9]{64}$/u.test(options.inputSnapshotDigest)) {
    throw new TypeError("Functional authority requires a build-input snapshot digest");
  }
  if (options.evidence.definitionDigest !== options.definitionIdentity.definitionDigest) {
    throw new Error("Functional authority definition identity does not match simulation evidence");
  }
  const authority = Object.freeze({
    evidence: options.evidence,
    inputSnapshotDigest: options.inputSnapshotDigest,
    definitionIdentity: options.definitionIdentity,
  });
  PRISTINE_FUNCTIONAL_WEAK_SET_ADD(ISSUED_FUNCTIONAL_SIMULATIONS, authority);
  return authority;
}

/** Persisted or caller-constructed data can never authenticate itself. */
export function authenticateFunctionalSimulationAuthority(
  authority: Readonly<IssuedFunctionalSimulationAuthority> | undefined,
  expected: {
    readonly circuitDigest: string;
    readonly inputSnapshot: Readonly<BuildInputSnapshot>;
  },
): Readonly<SimulationResultEvidence> | undefined {
  if (
    authority === undefined ||
    !PRISTINE_FUNCTIONAL_WEAK_SET_HAS(ISSUED_FUNCTIONAL_SIMULATIONS, authority)
  ) return undefined;
  if (
    authority.inputSnapshotDigest !== expected.inputSnapshot.digest ||
    authority.evidence.circuitDigest !== expected.circuitDigest ||
    authority.evidence.definitionDigest !== authority.definitionIdentity.definitionDigest
  ) return undefined;
  for (const source of authority.definitionIdentity.sourceEntries) {
    const input = expected.inputSnapshot.inputs.find(({ path }) => path === source.path);
    if (
      input === undefined ||
      (source.path === authority.definitionIdentity.path && input.role !== "test") ||
      input.sha256 !== source.sha256 || input.size !== source.size
    ) return undefined;
  }
  return authority.evidence;
}

export const NGSPICE_ADAPTER_VERSION = "3";
export const NGSPICE_OUTPUT_LIMIT = 8 * 1024 * 1024;
export const NGSPICE_STDIO_LIMIT = 1024 * 1024;

export interface QualifiedNgspiceRun {
  readonly assessment: Readonly<SimulationAssessment>;
  readonly evidence?: Readonly<SimulationResultEvidence>;
  readonly artifacts: readonly Readonly<{ kind: string; path: string; digest: string }>[];
  readonly tool: Readonly<ExternalToolProbe>;
  readonly promotionAuthority?: Readonly<IssuedFunctionalSimulationAuthority>;
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function throwIfSimulationCancelled(signal: AbortSignal | undefined): void {
  throwIfFulmetryCancelled(signal, "ngspice execution was cancelled");
}

function functionalDiagnostic(id: string, message: string, name: string, evidence: readonly string[] = []): Diagnostic {
  return defineDiagnostic({
    id: diagnosticId(id), severity: "error", dimension: "functional", message,
    waiverPolicy: "forbidden", objects: [name], sourceLocations: [], evidence,
    nextCommand: `fulmetry simulate ${name}`,
  });
}

function failed(id: string, message: string, name: string, tool: ExternalToolProbe, evidence: readonly string[] = []): QualifiedNgspiceRun {
  const diagnostic = functionalDiagnostic(id, message, name, evidence);
  return Object.freeze({
    assessment: Object.freeze({
      status: assuranceStatus("functional", "failed", { diagnosticIds: [diagnostic.id], summary: message }),
      diagnostics: Object.freeze([diagnostic]),
    }),
    artifacts: Object.freeze([]),
    tool,
  });
}

function incomplete(id: string, message: string, name: string, tool: ExternalToolProbe): QualifiedNgspiceRun {
  const diagnostic = functionalDiagnostic(id, message, name);
  return Object.freeze({
    assessment: Object.freeze({
      status: assuranceStatus("functional", "incomplete", { diagnosticIds: [diagnostic.id], summary: message }),
      diagnostics: Object.freeze([diagnostic]),
    }),
    artifacts: Object.freeze([]),
    tool,
  });
}

function unavailable(id: string, message: string, name: string, tool: ExternalToolProbe): QualifiedNgspiceRun {
  const diagnostic = functionalDiagnostic(id, message, name);
  return Object.freeze({
    assessment: Object.freeze({
      status: assuranceStatus("functional", "unavailable", { diagnosticIds: [diagnostic.id], summary: message }),
      diagnostics: Object.freeze([diagnostic]),
    }),
    artifacts: Object.freeze([]), tool,
  });
}

type JsonRecord = Record<string, unknown>;
function records(circuitJson: readonly AnyCircuitElement[], type: string): JsonRecord[] {
  return circuitJson.filter((value) => value.type === type) as unknown as JsonRecord[];
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  add(value: string): void { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }
  union(a: string, b: string): void {
    const left = this.find(a); const right = this.find(b);
    if (left !== right) this.parent.set(right, left);
  }
}

function spiceNumber(value: string | number): string {
  const text = String(value);
  if (!/^[A-Za-z0-9_+.-]{1,128}$/.test(text)) throw new Error("unsafe SPICE value");
  return text;
}

function spiceNumericValue(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(t|g|meg|k|m|u|n|p|f)?$/i.exec(value);
  if (match === null) throw new Error(`SPICE value ${value} is not a plain qualified numeric value`);
  const scales: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  return Number(match[1]) * (match[2] === undefined ? 1 : scales[match[2].toLowerCase()]!);
}

function reconciledPrimitiveValue(component: JsonRecord, field: "resistance" | "capacitance" | "inductance", declared: string | number | undefined): number {
  const authored = component[field];
  if (typeof authored !== "number" || !Number.isFinite(authored) || authored <= 0) throw new Error(`Circuit JSON component lacks positive finite authored ${field}`);
  if (declared === undefined) throw new Error(`Simulation binding lacks ${field}`);
  const parsed = spiceNumericValue(declared);
  if (!Number.isFinite(parsed) || Math.abs(parsed - authored) > Math.max(1e-15, Math.abs(authored) * 1e-12)) {
    throw new Error(`Simulation binding ${field} ${declared} does not match authored Circuit JSON value ${authored}`);
  }
  return authored;
}

function requireExactPrimitiveParameters(parameters: Readonly<Record<string, string | number>>, field: "resistance" | "capacitance" | "inductance"): void {
  const keys = Object.keys(parameters);
  if (keys.length !== 1 || keys[0] !== field) throw new Error(`Built-in ${field} binding must contain exactly the ${field} parameter`);
}

function stimulusValue(stimulus: SimulationDefinition["stimuli"][number]): string {
  const parts = [`DC ${stimulus.dcValue}`];
  if (stimulus.ac !== null) parts.push(`AC ${stimulus.ac.magnitude} ${stimulus.ac.phaseDegrees}`);
  if (stimulus.transient?.kind === "pulse") {
    const value = stimulus.transient;
    parts.push(`PULSE(${value.initialValue} ${value.pulsedValue} ${value.delaySeconds} ${value.riseSeconds} ${value.fallSeconds} ${value.widthSeconds} ${value.periodSeconds})`);
  } else if (stimulus.transient?.kind === "pwl") {
    parts.push(`PWL(${stimulus.transient.points.flatMap(({ timeSeconds, value }) => [timeSeconds, value]).join(" ")})`);
  } else if (stimulus.transient?.kind === "sine") {
    const value = stimulus.transient;
    parts.push(`SIN(${value.offset} ${value.amplitude} ${value.frequencyHz} ${value.delaySeconds} ${value.dampingFactor} ${value.phaseDegrees})`);
  }
  return parts.join(" ");
}

function operands(definition: SimulationDefinition): readonly SimulationVectorOperand[] {
  const values = definition.assertions.flatMap(({ expression }) =>
    expression.kind === "vector" ? [expression.operand] : [expression.left, expression.right]
  );
  const unique = new Map<string, SimulationVectorOperand>();
  for (const value of values) {
    const key = value.vector.toLowerCase();
    // The saved ngspice vector has one physical base unit (V or A), while
    // assertions may project that same evidence into magnitude and degrees.
    // Save it once; projection units are validated by the definition parser.
    unique.set(key, value);
  }
  return Object.freeze([...unique.values()].sort((a, b) => a.vector.localeCompare(b.vector)));
}

export function generateNgspiceNetlist(options: {
  readonly definition: SimulationDefinition;
  readonly circuitJson: readonly AnyCircuitElement[];
  readonly modelPaths: Readonly<Record<string, string>>;
}): string {
  const { definition, circuitJson } = options;
  const components = records(circuitJson, "source_component");
  const ports = records(circuitJson, "source_port");
  const nets = records(circuitJson, "source_net");
  const traces = records(circuitJson, "source_trace");
  const componentByToken = new Map<string, JsonRecord>();
  for (const component of components) {
    for (const value of [component.source_component_id, component.name]) {
      if (typeof value === "string") {
        const previous = componentByToken.get(value);
        if (previous !== undefined && previous !== component) throw new Error(`Component token ${value} is ambiguous`);
        componentByToken.set(value, component);
      }
    }
  }
  const netByToken = new Map<string, JsonRecord>();
  for (const net of nets) {
    for (const value of [net.source_net_id, net.name]) if (typeof value === "string") {
      const previous = netByToken.get(value);
      if (previous !== undefined && previous !== net) throw new Error(`Net token ${value} is ambiguous`);
      netByToken.set(value, net);
    }
  }
  const selectedNets = definition.region.netIds.map((id) => {
    const net = netByToken.get(id);
    if (net === undefined) throw new Error(`Selected net ${id} is absent from Circuit JSON`);
    return { id, canonical: String(net.source_net_id), name: typeof net.name === "string" ? net.name : id };
  });
  if (!selectedNets.some(({ id, name }) => /^(?:0|gnd)$/i.test(id) || /^gnd$/i.test(name))) {
    throw new Error("Explicit simulation region must contain a GND or 0 reference net");
  }
  const uf = new UnionFind();
  for (const trace of traces) {
    const members = [
      ...(Array.isArray(trace.connected_source_port_ids) ? trace.connected_source_port_ids : []),
      ...(Array.isArray(trace.connected_source_net_ids) ? trace.connected_source_net_ids : []),
    ].filter((value): value is string => typeof value === "string");
    for (const member of members) uf.add(member);
    for (let index = 1; index < members.length; index += 1) uf.union(members[0]!, members[index]!);
  }
  const nodeByRoot = new Map<string, string>();
  const selectedNetBySpiceNode = new Map<string, { canonical: string; id: string }>();
  for (const net of selectedNets) {
    const node = /^(?:0|gnd)$/i.test(net.id) || /^gnd$/i.test(net.name) ? "0" : net.id;
    const nodeKey = node.toLowerCase();
    const previousNodeOwner = selectedNetBySpiceNode.get(nodeKey);
    if (previousNodeOwner !== undefined && previousNodeOwner.canonical !== net.canonical) {
      throw new Error(
        `Selected nets ${previousNodeOwner.id} and ${net.id} produce case-insensitively duplicated SPICE node ${node}`,
      );
    }
    selectedNetBySpiceNode.set(nodeKey, { canonical: net.canonical, id: net.id });
    const root = uf.find(net.canonical);
    const previous = nodeByRoot.get(root);
    if (previous !== undefined && previous !== node) throw new Error(`Selected nets ${previous} and ${node} resolve to one electrical net`);
    nodeByRoot.set(root, node);
  }
  const lines = [
    `* Fulmetry qualified ngspice adapter ${NGSPICE_ADAPTER_VERSION}`,
    ".option noacct",
    ".options filetype=ascii",
  ];
  const spiceElementNames = new Set<string>();
  const claimElementName = (name: string) => {
    const key = name.toLowerCase();
    if (spiceElementNames.has(key)) throw new Error(`SPICE element name ${name} is duplicated case-insensitively`);
    spiceElementNames.add(key);
    return name;
  };
  for (const model of definition.models) {
    if (model.device.kind === "subcircuit") throw new Error("Subcircuit pin ordering is not yet qualified by Fulmetry's ngspice fixtures");
    for (const binding of model.bindings) {
      const component = componentByToken.get(binding.componentId);
      if (component === undefined) throw new Error(`Modeled component ${binding.componentId} is absent from Circuit JSON`);
      const sourceComponentId = String(component.source_component_id);
      if (binding.componentId !== sourceComponentId) throw new Error(`Model binding ${binding.componentId} must use exact source_component_id ${sourceComponentId}`);
      const componentPorts = ports.filter((port) => port.source_component_id === sourceComponentId);
      const pinEntries = Object.entries(binding.pinMap).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
      const nodes = pinEntries.map(([, portToken]) => {
        const matches = componentPorts.filter((candidate) =>
          candidate.name === portToken || String(candidate.pin_number ?? "") === portToken || candidate.source_port_id === portToken
        );
        if (matches.length > 1) throw new Error(`Model ${model.id} port ${portToken} is ambiguous on ${binding.componentId}`);
        const port = matches[0];
        if (port === undefined) throw new Error(`Model ${model.id} cannot resolve port ${portToken} on ${binding.componentId}`);
        const root = uf.find(String(port.source_port_id));
        const node = nodeByRoot.get(root);
        if (node === undefined) throw new Error(`Port ${portToken} on ${binding.componentId} is outside the declared simulation nets`);
        return node;
      });
      const id = binding.componentId;
      if (model.device.kind === "primitive" && model.device.name === "resistor") {
        if (component.ftype !== "simple_resistor" || nodes.length !== 2) throw new Error(`Resistor ${id} does not match a two-pin simple_resistor`);
        requireExactPrimitiveParameters(binding.parameters, "resistance");
        lines.push(`${claimElementName(id.startsWith("R") ? id : `R${id}`)} ${nodes.join(" ")} ${reconciledPrimitiveValue(component, "resistance", binding.parameters.resistance)}`);
      } else if (model.device.kind === "primitive" && model.device.name === "capacitor") {
        if (component.ftype !== "simple_capacitor" || nodes.length !== 2) throw new Error(`Capacitor ${id} does not match a two-pin simple_capacitor`);
        requireExactPrimitiveParameters(binding.parameters, "capacitance");
        lines.push(`${claimElementName(id.startsWith("C") ? id : `C${id}`)} ${nodes.join(" ")} ${reconciledPrimitiveValue(component, "capacitance", binding.parameters.capacitance)}`);
      } else if (model.device.kind === "primitive" && model.device.name === "inductor") {
        if (component.ftype !== "simple_inductor" || nodes.length !== 2) throw new Error(`Inductor ${id} does not match a two-pin simple_inductor`);
        requireExactPrimitiveParameters(binding.parameters, "inductance");
        lines.push(`${claimElementName(id.startsWith("L") ? id : `L${id}`)} ${nodes.join(" ")} ${reconciledPrimitiveValue(component, "inductance", binding.parameters.inductance)}`);
      } else {
        throw new Error(`Primitive ${model.device.name} is not yet qualified by Fulmetry's ngspice fixtures`);
      }
    }
  }
  for (const stimulus of definition.stimuli) {
    const positive = selectedNets.find(({ id }) => id === stimulus.positiveNode);
    const negative = selectedNets.find(({ id }) => id === stimulus.negativeNode);
    if (positive === undefined || negative === undefined) throw new Error(`Stimulus ${stimulus.sourceId} is outside the selected net set`);
    const node = (net: typeof positive) => /^(?:0|gnd)$/i.test(net.id) || /^gnd$/i.test(net.name) ? "0" : net.id;
    const prefix = stimulus.kind === "voltage" ? "V" : "I";
    const sourceName = stimulus.sourceId.toUpperCase().startsWith(prefix) ? stimulus.sourceId : `${prefix}${stimulus.sourceId}`;
    lines.push(`${claimElementName(sourceName)} ${node(positive)} ${node(negative)} ${stimulusValue(stimulus)}`);
  }
  const saved = operands(definition).map(({ vector }) => vector);
  lines.push(`.save ${saved.join(" ")}`);
  if (definition.analysis.kind === "operating-point") lines.push(".op");
  else if (definition.analysis.kind === "dc-sweep") {
    const analysis = definition.analysis;
    const stimulus = definition.stimuli.find(({ sourceId }) => sourceId === analysis.sourceId)!;
    const prefix = stimulus.kind === "voltage" ? "V" : "I";
    const sourceName = analysis.sourceId.toUpperCase().startsWith(prefix) ? analysis.sourceId : `${prefix}${analysis.sourceId}`;
    lines.push(`.dc ${sourceName} ${analysis.start} ${analysis.stop} ${analysis.step}`);
  } else if (definition.analysis.kind === "ac") {
    const scale = definition.analysis.scale === "decade" ? "dec" : definition.analysis.scale === "octave" ? "oct" : "lin";
    lines.push(`.ac ${scale} ${definition.analysis.points} ${definition.analysis.startHz} ${definition.analysis.stopHz}`);
  } else {
    lines.push(`.tran ${definition.analysis.stepSeconds} ${definition.analysis.stopSeconds} ${definition.analysis.startSeconds}`);
  }
  lines.push(".end", "");
  return lines.join("\n");
}

function parseRawNumber(value: string): SimulationSample {
  if (value.includes(",")) {
    const parts = value.split(",");
    if (parts.length !== 2) throw new Error("complex sample must have real,imaginary form");
    const real = Number(parts[0]); const imaginary = Number(parts[1]);
    if (!Number.isFinite(real) || !Number.isFinite(imaginary)) throw new Error("raw output contains a non-finite complex sample");
    return Object.freeze({ real, imaginary });
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("raw output contains a non-finite sample");
  return parsed;
}

/** Parses ngspice ASCII raw output and only admits the exact generated vector set. */
export function parseNgspiceAsciiRaw(bytes: Uint8Array, definition: SimulationDefinition): Readonly<{
  axis: SimulationResultEvidence["axis"];
  vectors: SimulationResultEvidence["vectors"];
}> {
  if (bytes.byteLength === 0 || bytes.byteLength > NGSPICE_OUTPUT_LIMIT) throw new Error("ngspice raw output size is invalid");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("ngspice raw output must be UTF-8 ASCII raw format"); }
  if (text.includes("\0") || /(?:^|\n)Binary:/i.test(text)) throw new Error("binary or NUL-containing ngspice raw output is unsupported");
  const lines = text.split(/\r?\n/);
  const variablesAt = lines.findIndex((line) => line.trim() === "Variables:");
  const valuesAt = lines.findIndex((line) => line.trim() === "Values:");
  if (variablesAt < 0 || valuesAt <= variablesAt) throw new Error("ngspice raw output lacks ordered Variables and Values sections");
  const header = Object.fromEntries(lines.slice(0, variablesAt).map((line) => {
    const index = line.indexOf(":"); return index < 0 ? ["", ""] : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
  }));
  const headerKeys = lines.slice(0, variablesAt).map((line) => line.slice(0, line.indexOf(":"))).filter(Boolean).map((key) => key.trim().toLowerCase());
  if (new Set(headerKeys).size !== headerKeys.length) throw new Error("ngspice raw output contains duplicate headers");
  const expectedPlot = definition.analysis.kind === "operating-point" ? "operating point"
    : definition.analysis.kind === "dc-sweep" ? "dc transfer characteristic"
    : definition.analysis.kind === "ac" ? "ac analysis" : "transient analysis";
  if (header.plotname?.toLowerCase() !== expectedPlot) throw new Error(`ngspice raw plot ${header.plotname ?? "missing"} does not match ${expectedPlot}`);
  const flags = header.flags?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const expectedFlag = definition.analysis.kind === "ac" ? "complex" : "real";
  if (flags.length !== 1 || flags[0] !== expectedFlag) throw new Error(`ngspice raw flags must be exactly ${expectedFlag}`);
  const count = Number(header["no. variables"]); const points = Number(header["no. points"]);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SIMULATION_VECTORS + 1) throw new Error("ngspice raw variable count is invalid");
  if (!Number.isSafeInteger(points) || points < 1 || points > MAX_SIMULATION_SAMPLES_PER_VECTOR) throw new Error("ngspice raw point count is invalid");
  if (count * points > MAX_SIMULATION_TOTAL_SAMPLES + points) throw new Error("ngspice raw sample count exceeds the bounded result schema");
  const variables = lines.slice(variablesAt + 1, valuesAt).filter((line) => line.trim()).map((line) => {
    return parseNgspiceRawVariableDeclaration(
      line,
      "ngspice raw variable declaration is malformed",
    );
  });
  if (variables.length !== count || variables.some(({ index }, i) => index !== i)) throw new Error("ngspice raw variables are missing, duplicated, or out of order");
  if (new Set(variables.map(({ name }) => name.toLowerCase())).size !== variables.length) throw new Error("ngspice raw output contains duplicate vector names");
  const samples: SimulationSample[][] = Array.from({ length: count }, () => []);
  const valueLines = lines.slice(valuesAt + 1).filter((line) => line.trim());
  let lineIndex = 0;
  for (let point = 0; point < points; point += 1) {
    for (let variable = 0; variable < count; variable += 1) {
      const line = valueLines[lineIndex++];
      if (line === undefined) throw new Error("ngspice raw output ended before every declared sample");
      const tokens = line.trim().split(/\s+/);
      let value: string;
      if (variable === 0) {
        if (tokens.length !== 2 || Number(tokens[0]) !== point) throw new Error("ngspice raw point indices are malformed or replayed");
        value = tokens[1]!;
      } else {
        if (tokens.length !== 1) throw new Error("ngspice raw sample row is malformed");
        value = tokens[0]!;
      }
      samples[variable]!.push(parseRawNumber(value));
    }
  }
  if (lineIndex !== valueLines.length) throw new Error("ngspice raw output contains trailing sample data");
  const expected = operands(definition);
  const axisExpected = definition.analysis.kind === "operating-point" ? null : definition.analysis.kind === "ac" ? "frequency" : definition.analysis.kind === "transient" ? "time" : "v-sweep";
  const axisIndex = axisExpected === null ? -1 : variables.findIndex(({ name }) =>
    definition.analysis.kind === "dc-sweep"
      ? isNgspiceDcSweepAxisName(name)
      : name.toLowerCase() === axisExpected
  );
  if (axisExpected !== null && axisIndex < 0) throw new Error(`ngspice raw output lacks ${axisExpected} axis`);
  const expectedNames = new Set(expected.map(({ vector }) => vector.toLowerCase()));
  const dataVariables = variables.filter((_, index) => index !== axisIndex);
  if (dataVariables.length !== expected.length || dataVariables.some(({ name }) => !expectedNames.has(name.toLowerCase()))) {
    throw new Error("ngspice raw output does not exactly match the Fulmetry-generated vector set");
  }
  for (const operand of expected) {
    const variable = variables.find(({ name }) => name.toLowerCase() === operand.vector.toLowerCase())!;
    const expectedType = operand.vector.toLowerCase().startsWith("i(") ? "current" : "voltage";
    if (variable.type.toLowerCase() !== expectedType) throw new Error(`ngspice raw vector ${operand.vector} has wrong type ${variable.type}`);
  }
  if (axisIndex >= 0) {
    const expectedAxisType = definition.analysis.kind === "ac" ? "frequency" : definition.analysis.kind === "transient" ? "time" : "voltage";
    if (variables[axisIndex]!.type.toLowerCase() !== expectedAxisType) throw new Error(`ngspice raw axis has wrong type ${variables[axisIndex]!.type}`);
  }
  for (let index = 0; index < variables.length; index += 1) {
    const variable = variables[index]!;
    const expectedGrid = definition.analysis.kind === "ac" && index === axisIndex
      ? definition.analysis.scale === "linear" ? 1 : 3
      : null;
    if (variable.grid !== expectedGrid) {
      throw new Error("ngspice raw variable grid metadata does not match the requested analysis");
    }
  }
  const axis = axisIndex < 0 ? null : (() => {
    const values = samples[axisIndex]!.map((sample) => {
      if (typeof sample === "number") return sample;
      if (
        definition.analysis.kind === "ac" &&
        isSemanticallyRealFrequencySample(sample.real, sample.imaginary)
      ) return sample.real;
      throw new Error("ngspice frequency axis must be semantically real");
    });
    return Object.freeze({
      name: definition.analysis.kind === "dc-sweep" ? definition.analysis.sourceId : axisExpected!,
      unit: definition.analysis.kind === "dc-sweep" ? definition.analysis.unit : definition.analysis.kind === "ac" ? "Hz" : "s",
      values: Object.freeze(values),
    });
  })();
  const vectors = expected.map((operand) => {
    const index = variables.findIndex(({ name }) => name.toLowerCase() === operand.vector.toLowerCase());
    return Object.freeze({ name: operand.vector, unit: simulationVectorBaseUnit(operand.vector), samples: Object.freeze(samples[index]!) });
  });
  return Object.freeze({ axis, vectors: Object.freeze(vectors) });
}

async function readBounded(stream: ReadableStream<Uint8Array>, terminate: () => void): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > NGSPICE_STDIO_LIMIT) { terminate(); throw new Error(`ngspice stdio exceeded ${NGSPICE_STDIO_LIMIT} bytes`); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function assertSymlinkFreeContainedPath(root: string, target: string, label: string): Promise<void> {
  const relativePath = relative(resolve(root), resolve(target));
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${label} must be a strict descendant of its authorized root`);
  let current = resolve(root);
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`${label} contains symlink ancestor ${current}`);
  }
}

export async function runQualifiedNgspice(options: {
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly outputRoot: string;
  readonly definition: SimulationDefinition;
  /** Loader-issued identity for this exact source-controlled definition. */
  readonly definitionAuthority?: Readonly<IssuedSimulationDefinitionAuthority>;
  readonly circuitJson: readonly AnyCircuitElement[];
  readonly executable?: string | null;
  readonly signal?: AbortSignal;
  /** Complete source/config/test/profile/waiver/lock/vendor epoch for production reuse. */
  readonly inputSnapshot?: Readonly<BuildInputSnapshot>;
  /** @internal Adversarial test hook; cannot grant qualification authority. */
  readonly beforeQualificationCheck?: () => void;
  /** @internal Runs immediately before the final exact artifact capture. */
  readonly beforeArtifactPublication?: (simulationDirectory: string) => void | Promise<void>;
}): Promise<Readonly<QualifiedNgspiceRun>> {
  requireSupportedBunRuntime();
  const definition = parseSimulationDefinition(JSON.parse(JSON.stringify(options.definition)));
  const circuitBytes = canonicalCircuitJson(options.circuitJson);
  const circuitJson = parseCanonicalCircuitJson(circuitBytes);
  const inputSnapshot = options.inputSnapshot === undefined
    ? undefined
    : structuredClone(options.inputSnapshot);
  throwIfSimulationCancelled(options.signal);
  const firstProbe = await probeNgspice({ ...(options.executable === undefined ? {} : { executable: options.executable }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  throwIfSimulationCancelled(options.signal);
  if (firstProbe.state === "unavailable") {
    const unsupported = firstProbe.version !== undefined && firstProbe.reason?.includes("outside Fulmetry's detected compatibility range");
    return unavailable(unsupported ? "SIM_NGSPICE_VERSION_UNSUPPORTED_001" : "SIM_NGSPICE_UNAVAILABLE_001", firstProbe.reason!, definition.name, firstProbe);
  }
  const simulationDirectory = join(options.runDirectory, "simulation");
  try {
    const suppliedRunStat = await lstat(options.runDirectory);
    if (suppliedRunStat.isSymbolicLink() || !suppliedRunStat.isDirectory()) throw new Error("Simulation run directory must be a regular non-symlinked directory");
    const projectRoot = await realpath(options.projectRoot);
    if (inputSnapshot !== undefined) {
      const current = await refreshBuildInputSnapshot(projectRoot, inputSnapshot);
      if (current.digest !== inputSnapshot.digest) {
        throw new Error("Simulation build-input snapshot is stale before execution");
      }
    }
    await assertSymlinkFreeContainedPath(options.projectRoot, options.outputRoot, "Simulation output authority");
    const outputRoot = await realpath(options.outputRoot);
    await assertSymlinkFreeContainedPath(options.outputRoot, options.runDirectory, "Simulation run directory");
    const outputWithinProject = relative(projectRoot, outputRoot);
    if (outputWithinProject.startsWith("..") || isAbsolute(outputWithinProject) || outputWithinProject === "") throw new Error("Simulation output authority must be project-contained");
    const runRoot = await realpath(options.runDirectory);
    const runWithinProject = relative(projectRoot, runRoot);
    if (runWithinProject.startsWith("..") || isAbsolute(runWithinProject) || runWithinProject === "") throw new Error("Simulation run directory must be a project-contained output directory");
    const verifiedModels = await verifySimulationModelAssets({ projectRoot, definition });
    throwIfSimulationCancelled(options.signal);
    await mkdir(simulationDirectory);
    const simulationDirectoryIdentity = await captureSimulationDirectoryIdentity(simulationDirectory);
    if (firstProbe.executable === undefined || firstProbe.executableSha256 === undefined) throw new Error("Detected ngspice probe omitted executable identity");
    const toolDirectory = join(simulationDirectory, "tool");
    await mkdir(toolDirectory);
    const toolDirectoryIdentity = await captureSimulationDirectoryIdentity(toolDirectory);
    const toolBytes = await readBoundedRegularFile(firstProbe.executable, NGSPICE_EXECUTABLE_BYTES_LIMIT);
    if (sha256(toolBytes).slice("sha256:".length) !== firstProbe.executableSha256) throw new Error("ngspice executable changed after identity probe");
    const capturedToolPath = join(toolDirectory, process.platform === "win32" ? "ngspice.exe" : "ngspice");
    await writeFile(capturedToolPath, toolBytes, { flag: "wx", mode: 0o500 });
    await chmod(capturedToolPath, 0o500);
    await assertSimulationDirectoryIdentity(simulationDirectoryIdentity);
    await assertSimulationDirectoryIdentity(toolDirectoryIdentity);
    const capturedProbe = await probeNgspice({ executable: capturedToolPath, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    if (capturedProbe.state !== "detected" || capturedProbe.version !== firstProbe.version || capturedProbe.executableSha256 !== firstProbe.executableSha256) throw new Error("Captured ngspice executable does not preserve the probed identity and version");
    const qualification = await qualifyCapturedNgspice({
      executable: capturedToolPath,
      directory: join(toolDirectory, "qualification"),
      tool: capturedProbe,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    throwIfSimulationCancelled(options.signal);
    const modelDirectory = join(simulationDirectory, "models");
    await mkdir(modelDirectory);
    const modelPaths: Record<string, string> = {};
    const capturedModelBytes = new Map<string, Uint8Array>();
    const sourceModelBytes = new Map<string, Uint8Array>();
    const modelBytesById = new Map<string, Uint8Array>();
    let modelArtifactBytes = 0;
    for (const model of verifiedModels) {
      const source = join(projectRoot, ...model.path.split("/"));
      const cacheKey = `${model.path}\0${model.digest}`;
      let bytes = sourceModelBytes.get(cacheKey);
      if (bytes === undefined) {
        bytes = await readBoundedRegularFile(source, MAX_SIMULATION_MODEL_BYTES);
        sourceModelBytes.set(cacheKey, bytes);
      }
      if (sha256(bytes) !== model.digest) throw new Error(`Model ${model.id} changed after identity verification`);
      validateStaticSimulationModel(bytes, model.id);
      modelArtifactBytes += bytes.byteLength;
      if (!Number.isSafeInteger(modelArtifactBytes) || modelArtifactBytes > MAX_SIMULATION_MODEL_ARTIFACT_BYTES) {
        throw new Error(`Simulation model artifacts exceed ${MAX_SIMULATION_MODEL_ARTIFACT_BYTES} aggregate bytes`);
      }
      modelBytesById.set(model.id, bytes);
    }
    for (const model of verifiedModels) {
      const bytes = modelBytesById.get(model.id)!;
      const targetName = `${model.id}.model`;
      await writeFile(join(modelDirectory, targetName), bytes, { flag: "wx" });
      modelPaths[model.id] = `models/${targetName}`;
      capturedModelBytes.set(`models/${targetName}`, bytes);
    }
    const netlist = generateNgspiceNetlist({ definition, circuitJson, modelPaths });
    const netlistBytes = new TextEncoder().encode(netlist);
    const netlistPath = join(simulationDirectory, "input.cir");
    await writeFile(netlistPath, netlistBytes, { flag: "wx" });
    const rawName = "result.raw";
    const rawPath = join(simulationDirectory, rawName);
    const child = await spawnContainedProcess({
      command: [capturedToolPath, "-n", "-b", "-r", rawName, basename(netlistPath)],
      cwd: simulationDirectory,
      env: {
        HOME: simulationDirectory, USERPROFILE: simulationDirectory,
        TMPDIR: simulationDirectory, TEMP: simulationDirectory, TMP: simulationDirectory,
        LC_ALL: "C", LANG: "C",
        ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
        ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
      },
    });
    const terminate = () => child.terminate();
    let timedOut = false; let cancelled = options.signal?.aborted ?? false; let oversized = false;
    const onAbort = () => { cancelled = true; terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (cancelled) terminate();
    const timer = setTimeout(() => { timedOut = true; terminate(); }, definition.timeoutMs);
    const monitor = setInterval(async () => {
      try { if ((await stat(rawPath)).size > NGSPICE_OUTPUT_LIMIT) { oversized = true; terminate(); } } catch { /* file may not exist yet */ }
    }, 20);
    let stdout: Uint8Array; let stderr: Uint8Array; let exitCode: number;
    try {
      try {
        [stdout, stderr, exitCode] = await Promise.all([readBounded(child.stdout, terminate), readBounded(child.stderr, terminate), child.exited]);
      } catch (error) {
        terminate();
        await child.exited.catch(() => undefined);
        throw error;
      }
    } finally {
      clearTimeout(timer); clearInterval(monitor); options.signal?.removeEventListener("abort", onAbort); terminate();
    }
    if (cancelled) throwIfFulmetryCancelled(options.signal, "ngspice execution was cancelled");
    throwIfSimulationCancelled(options.signal);
    await writeFile(join(simulationDirectory, "stdout.bin"), stdout, { flag: "wx" });
    await writeFile(join(simulationDirectory, "stderr.bin"), stderr, { flag: "wx" });
    if (timedOut || oversized || exitCode !== 0) {
      return failed("SIM_EXECUTION_FAILED_001", timedOut ? "ngspice execution timed out" : oversized ? `ngspice raw output exceeded ${NGSPICE_OUTPUT_LIMIT} bytes` : `ngspice exited ${exitCode}`, definition.name, capturedProbe, [`tool:ngspice:${capturedProbe.version}:${capturedProbe.executableSha256}`]);
    }
    const raw = await readBoundedRegularFile(rawPath, NGSPICE_OUTPUT_LIMIT);
    if (raw.byteLength < 1) throw new Error("ngspice raw output is missing, unsafe, or oversized");
    throwIfSimulationCancelled(options.signal);
    const combinedOutput = `${new TextDecoder().decode(stdout)}\n${new TextDecoder().decode(stderr)}`;
    if (/singular matrix|no convergence|timestep too small|fatal error|simulation interrupted|internal error/i.test(combinedOutput)) {
      return failed("SIM_EXECUTION_FAILED_001", "ngspice reported non-convergence or a fatal solver error", definition.name, capturedProbe);
    }
    const parsed = parseNgspiceAsciiRaw(raw, definition);
    throwIfSimulationCancelled(options.signal);
    await assertSimulationDirectoryIdentity(simulationDirectoryIdentity);
    await assertSimulationDirectoryIdentity(toolDirectoryIdentity);
    const secondProbe = await probeNgspice({ executable: capturedToolPath, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    throwIfSimulationCancelled(options.signal);
    if (secondProbe.state !== "detected" || secondProbe.version !== capturedProbe.version || secondProbe.executableSha256 !== capturedProbe.executableSha256) {
      throw new Error("ngspice executable identity or version changed during simulation");
    }
    await assertSimulationDirectoryIdentity(simulationDirectoryIdentity);
    await assertSimulationDirectoryIdentity(toolDirectoryIdentity);
    const capturedToolEntry = await lstat(capturedToolPath);
    if (capturedToolEntry.isSymbolicLink() || !capturedToolEntry.isFile()) throw new Error("Captured ngspice executable path changed during simulation");
    const recapturedToolBytes = await readBoundedRegularFile(capturedToolPath, NGSPICE_EXECUTABLE_BYTES_LIMIT);
    if (sha256(recapturedToolBytes).slice("sha256:".length) !== capturedProbe.executableSha256) {
      throw new Error("Captured ngspice executable bytes changed during simulation");
    }
    await assertSimulationDirectoryIdentity(simulationDirectoryIdentity);
    await assertSimulationDirectoryIdentity(toolDirectoryIdentity);
    await rm(capturedToolPath);
    await assertSimulationDirectoryIdentity(toolDirectoryIdentity);
    await rmdir(toolDirectory);
    await assertSimulationDirectoryIdentity(simulationDirectoryIdentity);
    const modelDigests = Object.freeze(Object.fromEntries(verifiedModels.map(({ id, digest }) => [id, digest])));
    const evidence: SimulationResultEvidence = Object.freeze({
      schemaVersion: 2,
      definitionDigest: simulationDefinitionDigest(definition),
      circuitDigest: sha256(circuitBytes),
      netlistDigest: sha256(netlistBytes), modelDigests,
      qualificationSha256: qualification.sha256,
      adapter: Object.freeze({ name: "fulmetry-ngspice" as const, version: NGSPICE_ADAPTER_VERSION, primitiveSemantics: "ngspice-built-in-rcl" as const, modelFileUse: "provenance-only-not-included-for-built-in-rcl" as const }),
      tool: Object.freeze({ name: "ngspice" as const, version: capturedProbe.version!, executableSha256: capturedProbe.executableSha256! }),
      execution: Object.freeze({ exitCode, timedOut: false, stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr), rawOutputSha256: sha256(raw) }),
      solverStatus: "converged", analysisKind: definition.analysis.kind,
      axis: parsed.axis, vectors: parsed.vectors,
    });
    let assessment = assessQualifiedSimulationResult(definition, evidence, {
      circuitDigest: evidence.circuitDigest, netlistDigest: evidence.netlistDigest,
      qualificationSha256: qualification.sha256,
      modelDigests, tool: evidence.tool,
      adapterVersion: NGSPICE_ADAPTER_VERSION,
      stdoutSha256: evidence.execution.stdoutSha256, stderrSha256: evidence.execution.stderrSha256,
      rawOutputSha256: evidence.execution.rawOutputSha256,
    });
    throwIfSimulationCancelled(options.signal);
    const identityKey = `${process.platform}:${process.arch}:${capturedProbe.version}:${capturedProbe.executableSha256}`;
    options.beforeQualificationCheck?.();
    if (
      assessment.status.state === "passed" &&
      !isIssuedNgspiceQualification(qualification, capturedProbe)
    ) {
      const failedCase = qualification.evidence.cases.find(({ status }) => status === "failed");
      const diagnostic = functionalDiagnostic("SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001", "The exact ngspice executable did not pass Fulmetry's bounded four-case behavioral qualification", definition.name, [
        `tool:ngspice:${identityKey}`,
        `qualification:${qualification.sha256}`,
        ...(failedCase === undefined ? [] : [`qualification-case:${failedCase.id}:${failedCase.failure ?? "failed"}`]),
      ]);
      assessment = Object.freeze({ status: assuranceStatus("functional", "incomplete", { diagnosticIds: [diagnostic.id], summary: "Exact ngspice identity lacks behavioral compatibility qualification" }), diagnostics: Object.freeze([diagnostic]) });
    }
    const qualificationPath = join(simulationDirectory, "qualification.json");
    if (qualification.evidenceBytes.byteLength > SIMULATION_ARTIFACT_FILE_BYTES_LIMIT) {
      throw new Error(`Simulation qualification evidence exceeds ${SIMULATION_ARTIFACT_FILE_BYTES_LIMIT} bytes`);
    }
    await writeFile(qualificationPath, qualification.evidenceBytes, { flag: "wx" });
    const expectedBytes = new Map<string, Uint8Array>([
      ["input.cir", netlistBytes], ["result.raw", raw], ["stdout.bin", stdout], ["stderr.bin", stderr],
      ["qualification.json", qualification.evidenceBytes],
      ...capturedModelBytes,
    ]);
    const expectedArtifacts = Object.freeze([...expectedBytes].map(([path, bytes]) => Object.freeze({
      path, size: bytes.byteLength, sha256: sha256(bytes).slice("sha256:".length),
    })));
    await verifyExactSimulationArtifacts({ rootIdentity: simulationDirectoryIdentity, expected: expectedArtifacts });
    throwIfSimulationCancelled(options.signal);
    const evidencePath = join(simulationDirectory, "evidence.json");
    const evidenceBytes = new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`);
    if (evidenceBytes.byteLength > SIMULATION_ARTIFACT_FILE_BYTES_LIMIT) {
      throw new Error(`Simulation evidence exceeds ${SIMULATION_ARTIFACT_FILE_BYTES_LIMIT} bytes`);
    }
    const finalArtifactBytes = expectedArtifacts.reduce((total, artifact) => total + artifact.size, 0) + evidenceBytes.byteLength;
    if (!Number.isSafeInteger(finalArtifactBytes) || finalArtifactBytes > SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT) {
      throw new Error(`Simulation artifacts exceed ${SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT} aggregate bytes`);
    }
    throwIfSimulationCancelled(options.signal);
    await writeFile(evidencePath, evidenceBytes, { flag: "wx" });
    const finalExpectedArtifacts = Object.freeze([
      ...expectedArtifacts,
      Object.freeze({
        path: "evidence.json",
        size: evidenceBytes.byteLength,
        sha256: sha256(evidenceBytes).slice("sha256:".length),
      }),
    ]);
    await options.beforeArtifactPublication?.(simulationDirectory);
    throwIfSimulationCancelled(options.signal);
    await verifyExactSimulationArtifacts({
      rootIdentity: simulationDirectoryIdentity,
      expected: finalExpectedArtifacts,
    });
    throwIfSimulationCancelled(options.signal);
    if (inputSnapshot !== undefined) {
      const current = await refreshBuildInputSnapshot(projectRoot, inputSnapshot);
      if (current.digest !== inputSnapshot.digest) {
        throw new Error("Simulation build-input snapshot changed during execution");
      }
    }
    for (const model of verifiedModels) {
      const source = join(projectRoot, ...model.path.split("/"));
      const currentBytes = await readBoundedRegularFile(source, MAX_SIMULATION_MODEL_BYTES);
      if (sha256(currentBytes) !== model.digest) {
        throw new Error(`Model ${model.id} changed during simulation`);
      }
    }
    const artifact = (kind: string, name: string, bytes: Uint8Array | string) => Object.freeze({ kind, path: `simulation/${name}`, digest: sha256(bytes) });
    const artifacts = Object.freeze([
      artifact("simulation-netlist", "input.cir", netlistBytes), artifact("simulation-raw", "result.raw", raw),
      artifact("simulation-stdout", "stdout.bin", stdout), artifact("simulation-stderr", "stderr.bin", stderr),
      artifact("simulation-qualification", "qualification.json", qualification.evidenceBytes),
      ...[...capturedModelBytes].map(([path, bytes]) => artifact("simulation-model", path, bytes)),
      artifact("simulation-evidence", "evidence.json", evidenceBytes),
    ]);
    const definitionIdentity = inputSnapshot === undefined
      ? undefined
      : await authenticateSimulationDefinitionAuthority(options.definitionAuthority, {
          projectRoot,
          definition,
          inputSnapshot,
        });
    const promotionAuthority = assessment.status.state === "passed" && inputSnapshot !== undefined && definitionIdentity !== undefined
      ? issueFunctionalSimulationAuthority({
          evidence,
          assessment,
          inputSnapshotDigest: inputSnapshot.digest,
          definitionIdentity,
        })
      : undefined;
    return Object.freeze({
      assessment,
      evidence,
      tool: capturedProbe,
      artifacts,
      ...(promotionAuthority === undefined ? {} : { promotionAuthority }),
    });
  } catch (error) {
    if (options.signal?.aborted || isFulmetryCancellationError(error)) {
      await rm(simulationDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const id = /[Mm]odel(?: | artifacts)/.test(message) ? "SIM_MODEL_ASSET_INVALID_001" : /Primitive |Subcircuit |Selected |Port |reference net|SPICE|Component token|Net token/.test(message) ? "SIM_NETLIST_UNSUPPORTED_001" : "SIM_OUTPUT_INVALID_001";
    if (id === "SIM_MODEL_ASSET_INVALID_001") {
      await rm(simulationDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    return id === "SIM_NETLIST_UNSUPPORTED_001" ? incomplete(id, message, definition.name, firstProbe) : failed(id, message, definition.name, firstProbe);
  }
}
