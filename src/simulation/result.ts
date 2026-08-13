// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { defineDiagnostic, diagnosticId, type Diagnostic } from "../diagnostics";
import { assuranceStatus, type AssuranceStatus } from "../status";
import { simulationVectorBaseUnit, type SimulationAssertion, type SimulationDefinition, type SimulationVectorOperand } from "./definition";
import { binary64Ulp } from "./precision";
import {
  MAX_SIMULATION_MODELS,
  MAX_SIMULATION_SAMPLES_PER_VECTOR,
  MAX_SIMULATION_TOTAL_SAMPLES,
  MAX_SIMULATION_VECTORS,
} from "./limits";

export {
  MAX_SIMULATION_SAMPLES_PER_VECTOR,
  MAX_SIMULATION_TOTAL_SAMPLES,
  MAX_SIMULATION_VECTORS,
} from "./limits";

export const SIMULATION_RESULT_SCHEMA_VERSION = 2 as const;
export type SimulationSample = number | Readonly<{ real: number; imaginary: number }>;
export interface SimulationVector {
  readonly name: string;
  readonly unit: string;
  readonly samples: readonly SimulationSample[];
}
export interface SimulationResultEvidence {
  readonly schemaVersion: typeof SIMULATION_RESULT_SCHEMA_VERSION;
  readonly definitionDigest: string;
  readonly circuitDigest: string;
  readonly netlistDigest: string;
  readonly qualificationSha256: string;
  readonly modelDigests: Readonly<Record<string, string>>;
  readonly adapter: {
    readonly name: "pcboo-ngspice";
    readonly version: string;
    readonly primitiveSemantics: "ngspice-built-in-rcl";
    readonly modelFileUse: "provenance-only-not-included-for-built-in-rcl";
  };
  readonly tool: {
    readonly name: "ngspice";
    readonly version: string;
    readonly executableSha256: string;
  };
  readonly execution: {
    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly stdoutSha256: string;
    readonly stderrSha256: string;
    readonly rawOutputSha256: string;
  };
  readonly solverStatus: "converged";
  readonly analysisKind: SimulationDefinition["analysis"]["kind"];
  readonly axis: null | Readonly<{ name: string; unit: string; values: readonly number[] }>;
  readonly vectors: readonly SimulationVector[];
}
export interface SimulationEvidenceBinding {
  readonly circuitDigest: string;
  readonly netlistDigest: string;
  readonly qualificationSha256: string;
  readonly modelDigests: Readonly<Record<string, string>>;
  readonly adapterVersion: string;
  readonly tool: { readonly version: string; readonly executableSha256: string };
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly rawOutputSha256: string;
}
export interface SimulationAssessment {
  readonly status: AssuranceStatus<"functional">;
  readonly diagnostics: readonly Diagnostic[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new TypeError(`${path} contains unknown field ${unknown[0]}`);
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${path} must be non-empty`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${path} cannot contain control characters`);
  if (new TextEncoder().encode(value).byteLength > 4_096) throw new TypeError(`${path} exceeds 4096 bytes`);
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
  return value;
}
function digest(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new TypeError(`${path} must be sha256`);
  return parsed;
}

export function simulationDefinitionDigest(definition: SimulationDefinition): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(definition)).digest("hex")}`;
}

export function parseSimulationResultEvidence(value: unknown): Readonly<SimulationResultEvidence> {
  const root = record(value, "result");
  exact(root, ["schemaVersion", "definitionDigest", "circuitDigest", "netlistDigest", "qualificationSha256", "modelDigests", "adapter", "tool", "execution", "solverStatus", "analysisKind", "axis", "vectors"], "result");
  if (root.schemaVersion !== SIMULATION_RESULT_SCHEMA_VERSION) throw new TypeError("Unsupported simulation result schemaVersion");
  if (!(["operating-point", "dc-sweep", "ac", "transient"] as const).includes(root.analysisKind as never)) throw new TypeError("result.analysisKind is invalid");
  if (root.solverStatus !== "converged") throw new TypeError("result.solverStatus must be converged");
  const rawModelDigests = record(root.modelDigests, "result.modelDigests");
  if (Object.keys(rawModelDigests).length > MAX_SIMULATION_MODELS) {
    throw new TypeError(`result.modelDigests exceeds ${MAX_SIMULATION_MODELS} entries`);
  }
  const modelDigests = Object.freeze(Object.fromEntries(Object.entries(rawModelDigests).map(([id, value]) => [text(id, "model id"), digest(value, `result.modelDigests.${id}`)])));
  const adapter = record(root.adapter, "result.adapter");
  exact(adapter, ["name", "version", "primitiveSemantics", "modelFileUse"], "result.adapter");
  if (adapter.name !== "pcboo-ngspice") throw new TypeError("result.adapter.name must be pcboo-ngspice");
  if (adapter.primitiveSemantics !== "ngspice-built-in-rcl" || adapter.modelFileUse !== "provenance-only-not-included-for-built-in-rcl") throw new TypeError("result.adapter must declare exact built-in R/C/L model semantics");
  const tool = record(root.tool, "result.tool");
  exact(tool, ["name", "version", "executableSha256"], "result.tool");
  if (tool.name !== "ngspice") throw new TypeError("result.tool.name must be ngspice");
  const executableSha256 = text(tool.executableSha256, "result.tool.executableSha256");
  if (!/^[a-f0-9]{64}$/.test(executableSha256)) throw new TypeError("result.tool.executableSha256 must be sha256 hex");
  const execution = record(root.execution, "result.execution");
  exact(execution, ["exitCode", "timedOut", "stdoutSha256", "stderrSha256", "rawOutputSha256"], "result.execution");
  if (!Number.isSafeInteger(execution.exitCode)) throw new TypeError("result.execution.exitCode must be an integer");
  if (typeof execution.timedOut !== "boolean") throw new TypeError("result.execution.timedOut must be boolean");
  if (!Array.isArray(root.vectors)) throw new TypeError("result.vectors must be an array");
  if (root.vectors.length > MAX_SIMULATION_VECTORS) throw new TypeError(`result.vectors exceeds ${MAX_SIMULATION_VECTORS}`);
  const axis = root.axis === null ? null : (() => {
    const parsed = record(root.axis, "result.axis");
    exact(parsed, ["name", "unit", "values"], "result.axis");
    if (!Array.isArray(parsed.values) || parsed.values.length === 0) throw new TypeError("result.axis.values must be non-empty");
    if (parsed.values.length > MAX_SIMULATION_SAMPLES_PER_VECTOR) throw new TypeError(`result.axis.values exceeds ${MAX_SIMULATION_SAMPLES_PER_VECTOR}`);
    return Object.freeze({ name: text(parsed.name, "result.axis.name"), unit: text(parsed.unit, "result.axis.unit"), values: Object.freeze(parsed.values.map((value, index) => finite(value, `result.axis.values[${index}]`))) });
  })();
  let totalSamples = 0;
  const vectors = root.vectors.map((raw, vectorIndex) => {
    const vector = record(raw, `vectors[${vectorIndex}]`);
    exact(vector, ["name", "unit", "samples"], `vectors[${vectorIndex}]`);
    if (!Array.isArray(vector.samples) || vector.samples.length === 0) throw new TypeError(`vectors[${vectorIndex}].samples must be non-empty`);
    if (vector.samples.length > MAX_SIMULATION_SAMPLES_PER_VECTOR) throw new TypeError(`vectors[${vectorIndex}].samples exceeds ${MAX_SIMULATION_SAMPLES_PER_VECTOR}`);
    totalSamples += vector.samples.length;
    if (totalSamples > MAX_SIMULATION_TOTAL_SAMPLES) throw new TypeError(`result samples exceed ${MAX_SIMULATION_TOTAL_SAMPLES}`);
    const samples = vector.samples.map((sample, sampleIndex): SimulationSample => {
      if (typeof sample === "number") return finite(sample, `vectors[${vectorIndex}].samples[${sampleIndex}]`);
      const complex = record(sample, `vectors[${vectorIndex}].samples[${sampleIndex}]`);
      exact(complex, ["real", "imaginary"], `vectors[${vectorIndex}].samples[${sampleIndex}]`);
      return Object.freeze({ real: finite(complex.real, "complex.real"), imaginary: finite(complex.imaginary, "complex.imaginary") });
    });
    return Object.freeze({ name: text(vector.name, `vectors[${vectorIndex}].name`), unit: text(vector.unit, `vectors[${vectorIndex}].unit`), samples: Object.freeze(samples) });
  });
  if (new Set(vectors.map(({ name }) => name.toLowerCase())).size !== vectors.length) throw new TypeError("result contains duplicate vector names");
  return Object.freeze({
    schemaVersion: SIMULATION_RESULT_SCHEMA_VERSION,
    definitionDigest: digest(root.definitionDigest, "result.definitionDigest"),
    circuitDigest: digest(root.circuitDigest, "result.circuitDigest"),
    netlistDigest: digest(root.netlistDigest, "result.netlistDigest"),
    qualificationSha256: digest(root.qualificationSha256, "result.qualificationSha256"),
    modelDigests,
    adapter: Object.freeze({ name: "pcboo-ngspice" as const, version: text(adapter.version, "result.adapter.version"), primitiveSemantics: "ngspice-built-in-rcl" as const, modelFileUse: "provenance-only-not-included-for-built-in-rcl" as const }),
    tool: Object.freeze({ name: "ngspice" as const, version: text(tool.version, "result.tool.version"), executableSha256 }),
    execution: Object.freeze({ exitCode: execution.exitCode as number, timedOut: execution.timedOut, stdoutSha256: digest(execution.stdoutSha256, "result.execution.stdoutSha256"), stderrSha256: digest(execution.stderrSha256, "result.execution.stderrSha256"), rawOutputSha256: digest(execution.rawOutputSha256, "result.execution.rawOutputSha256") }),
    solverStatus: "converged" as const,
    analysisKind: root.analysisKind as SimulationResultEvidence["analysisKind"],
    axis,
    vectors: Object.freeze(vectors),
  });
}

function projected(sample: SimulationSample, projection: SimulationVectorOperand["projection"]): number | undefined {
  if (typeof sample === "number") return projection === "value" ? sample : undefined;
  if (projection === "value") return undefined;
  if (projection === "magnitude") return Math.hypot(sample.real, sample.imaginary);
  return Math.atan2(sample.imaginary, sample.real) * 180 / Math.PI;
}

interface SimulationEvaluationContext {
  readonly vectors: ReadonlyMap<string, SimulationVector>;
  readonly selected: Map<string, number | undefined>;
}

function operandVector(
  context: SimulationEvaluationContext,
  operand: SimulationVectorOperand,
): SimulationVector | undefined {
  const vector = context.vectors.get(operand.vector.toLowerCase());
  return vector?.unit === simulationVectorBaseUnit(operand.vector) ? vector : undefined;
}

function expressionLength(
  context: SimulationEvaluationContext,
  expression: SimulationAssertion["expression"],
): number | undefined {
  if (expression.kind === "vector") return operandVector(context, expression.operand)?.samples.length;
  const left = operandVector(context, expression.left)?.samples.length;
  const right = operandVector(context, expression.right)?.samples.length;
  return left !== undefined && left === right ? left : undefined;
}

function expressionAt(
  context: SimulationEvaluationContext,
  expression: SimulationAssertion["expression"],
  index: number,
): number | undefined {
  const project = (operand: SimulationVectorOperand): number | undefined => {
    const sample = operandVector(context, operand)?.samples[index];
    if (sample === undefined) return undefined;
    const value = projected(sample, operand.projection);
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  };
  if (expression.kind === "vector") return project(expression.operand);
  const left = project(expression.left);
  const right = project(expression.right);
  if (left === undefined || right === undefined) return undefined;
  const value = expression.kind === "difference" ? left - right : left / right;
  return Number.isFinite(value) ? value : undefined;
}

function selectedExpression(
  context: SimulationEvaluationContext,
  expression: SimulationAssertion["expression"],
  sample: SimulationAssertion["sample"],
  axis: SimulationResultEvidence["axis"],
): number | undefined {
  const key = JSON.stringify([expression, sample]);
  if (context.selected.has(key)) return context.selected.get(key);
  const length = expressionLength(context, expression);
  let result: number | undefined;
  if (length === undefined || length === 0) result = undefined;
  else if (sample.kind === "first") result = expressionAt(context, expression, 0);
  else if (sample.kind === "last") result = expressionAt(context, expression, length - 1);
  else if (sample.kind === "at") {
    if (axis === null || axis.unit !== sample.axisUnit || axis.values.length !== length) result = undefined;
    else {
      let closestIndex = -1;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < axis.values.length; index += 1) {
        const distance = Math.abs(axis.values[index]! - sample.axisValue);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      }
      if (closestDistance <= sample.axisTolerance) result = expressionAt(context, expression, closestIndex);
      else if (sample.interpolation === "linear") {
        for (let index = 1; index < axis.values.length; index += 1) {
          const before = axis.values[index - 1]!;
          const after = axis.values[index]!;
          if (sample.axisValue > before && sample.axisValue < after) {
            const beforeValue = expressionAt(context, expression, index - 1);
            const afterValue = expressionAt(context, expression, index);
            if (beforeValue !== undefined && afterValue !== undefined) {
              const fraction = (sample.axisValue - before) / (after - before);
              const interpolated = beforeValue + fraction * (afterValue - beforeValue);
              result = Number.isFinite(interpolated) ? interpolated : undefined;
            }
            break;
          }
        }
      }
    }
  } else {
    result = expressionAt(context, expression, 0);
    for (let index = 1; index < length && result !== undefined; index += 1) {
      const value = expressionAt(context, expression, index);
      if (value === undefined) result = undefined;
      else if (sample.kind === "minimum" ? value < result : value > result) result = value;
    }
  }
  context.selected.set(key, result);
  return result;
}

function expressionObjects(expression: SimulationAssertion["expression"]): readonly string[] {
  return expression.kind === "vector" ? [expression.operand.vector] : [expression.left.vector, expression.right.vector];
}

function approximately(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-9);
}

function transientAxisApproximately(actual: number, expected: number, stepSeconds: number): boolean {
  const ulpTolerance = Math.max(binary64Ulp(actual), binary64Ulp(expected)) * 16;
  const stepTolerance = Math.max(Number.EPSILON, stepSeconds * 1e-9);
  return Math.abs(actual - expected) <= Math.max(ulpTolerance, stepTolerance);
}

function matchesDcAxis(
  axis: NonNullable<SimulationResultEvidence["axis"]>,
  analysis: Extract<SimulationDefinition["analysis"], { kind: "dc-sweep" }>,
): boolean {
  const intervalCount = Math.floor((analysis.stop - analysis.start) / analysis.step + 1e-9);
  if (axis.name !== analysis.sourceId || axis.unit !== analysis.unit || axis.values.length !== intervalCount + 1) return false;
  return axis.values.every((value, index) => approximately(value, analysis.start + index * analysis.step));
}

function matchesAcAxis(
  axis: NonNullable<SimulationResultEvidence["axis"]>,
  analysis: Extract<SimulationDefinition["analysis"], { kind: "ac" }>,
): boolean {
  if (axis.name !== "frequency" || axis.unit !== "Hz") return false;
  if (analysis.scale === "linear") {
    if (axis.values.length !== analysis.points || analysis.points < 2) return false;
    const step = (analysis.stopHz - analysis.startHz) / (analysis.points - 1);
    return axis.values.every((value, index) => approximately(value, analysis.startHz + index * step));
  }
  const base = analysis.scale === "decade" ? 10 : 2;
  const intervalCount = Math.floor((Math.log(analysis.stopHz / analysis.startHz) / Math.log(base)) * analysis.points + 1e-9);
  if (axis.values.length !== intervalCount + 1) return false;
  return axis.values.every((value, index) => approximately(value, analysis.startHz * base ** (index / analysis.points)));
}

function matchesTransientAxis(
  axis: NonNullable<SimulationResultEvidence["axis"]>,
  analysis: Extract<SimulationDefinition["analysis"], { kind: "transient" }>,
): boolean {
  if (
    axis.name !== "time" || axis.unit !== "s" || axis.values.length < 2 ||
    !transientAxisApproximately(axis.values[0]!, analysis.startSeconds, analysis.stepSeconds) ||
    !transientAxisApproximately(axis.values.at(-1)!, analysis.stopSeconds, analysis.stepSeconds)
  ) return false;
  for (let index = 1; index < axis.values.length; index += 1) {
    const current = axis.values[index]!;
    const previous = axis.values[index - 1]!;
    const gap = current - previous;
    if (
      gap <= 0 ||
      gap > analysis.stepSeconds + Math.max(
        Math.max(binary64Ulp(current), binary64Ulp(previous)) * 4,
        analysis.stepSeconds * 1e-9,
      )
    ) return false;
  }
  return true;
}

function assessSimulationResultInternal(
  definition: SimulationDefinition,
  rawResult: unknown,
  binding: SimulationEvidenceBinding,
  qualified: boolean,
): Readonly<SimulationAssessment> {
  const diagnostics: Diagnostic[] = [];
  const covered = new Set(definition.models.flatMap(({ bindings }) => bindings.map(({ componentId }) => componentId)));
  const missingModels = definition.region.componentIds.filter((id) => !covered.has(id));
  if (missingModels.length > 0) {
    const visible = missingModels.slice(0, 16);
    const omitted = missingModels.length - visible.length;
    const diagnostic = defineDiagnostic({ id: diagnosticId("SIM_MODEL_COVERAGE_INCOMPLETE_001"), severity: "error", dimension: "functional", message: `Selected components lack explicit models: ${visible.join(", ")}${omitted > 0 ? `, …(+${omitted})` : ""}`, waiverPolicy: "forbidden", objects: missingModels, sourceLocations: [], evidence: ["model-substitution:forbidden"] });
    return Object.freeze({ status: assuranceStatus("functional", "incomplete", { diagnosticIds: [diagnostic.id], summary: "Simulation model coverage is incomplete" }), diagnostics: Object.freeze([diagnostic]) });
  }
  let result: Readonly<SimulationResultEvidence>;
  try {
    result = parseSimulationResultEvidence(rawResult);
  } catch (error) {
    const diagnostic = defineDiagnostic({ id: diagnosticId("SIM_RESULT_INVALID_001"), severity: "error", dimension: "functional", message: error instanceof Error ? error.message : String(error), waiverPolicy: "forbidden", objects: [definition.name], sourceLocations: [] });
    return Object.freeze({ status: assuranceStatus("functional", "failed", { diagnosticIds: [diagnostic.id], summary: "Simulation result evidence is invalid" }), diagnostics: Object.freeze([diagnostic]) });
  }
  if (result.analysisKind !== definition.analysis.kind) {
    diagnostics.push(defineDiagnostic({ id: diagnosticId("SIM_ANALYSIS_MISMATCH_001"), severity: "error", dimension: "functional", message: `Result analysis ${result.analysisKind} does not match ${definition.analysis.kind}`, waiverPolicy: "forbidden", objects: [definition.name], sourceLocations: [] }));
  }
  if (result.definitionDigest !== simulationDefinitionDigest(definition)) {
    diagnostics.push(defineDiagnostic({ id: diagnosticId("SIM_DEFINITION_DIGEST_MISMATCH_001"), severity: "error", dimension: "functional", message: "Simulation result is not bound to the current testbench definition", waiverPolicy: "forbidden", objects: [definition.name], sourceLocations: [] }));
  }
  const declaredModelDigests = Object.fromEntries(
    [...definition.models].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, digest }) => [id, digest]),
  );
  const resultModelDigests = Object.fromEntries(
    Object.entries(result.modelDigests).sort(([a], [b]) => a.localeCompare(b)),
  );
  if (JSON.stringify(resultModelDigests) !== JSON.stringify(declaredModelDigests)) {
    diagnostics.push(defineDiagnostic({ id: diagnosticId("SIM_MODEL_DIGEST_MISMATCH_001"), severity: "error", dimension: "functional", message: "Simulation evidence model identities do not exactly match the declared model set", waiverPolicy: "forbidden", objects: definition.models.map(({ id }) => id), sourceLocations: [] }));
  }
  const bindingMismatch = result.circuitDigest !== binding.circuitDigest ||
    result.netlistDigest !== binding.netlistDigest ||
    result.qualificationSha256 !== binding.qualificationSha256 ||
    result.tool.version !== binding.tool.version ||
    result.tool.executableSha256 !== binding.tool.executableSha256 ||
    result.execution.stdoutSha256 !== binding.stdoutSha256 ||
    result.execution.stderrSha256 !== binding.stderrSha256 ||
    result.execution.rawOutputSha256 !== binding.rawOutputSha256 ||
    result.adapter.version !== binding.adapterVersion ||
    JSON.stringify(Object.entries(result.modelDigests).sort(([a], [b]) => a.localeCompare(b))) !==
      JSON.stringify(Object.entries(binding.modelDigests).sort(([a], [b]) => a.localeCompare(b)));
  if (bindingMismatch) {
    diagnostics.push(defineDiagnostic({ id: diagnosticId("SIM_EXECUTION_BINDING_MISMATCH_001"), severity: "error", dimension: "functional", message: "Simulation evidence does not match independently captured circuit, model, netlist, tool, or raw-output identity", waiverPolicy: "forbidden", objects: [definition.name], sourceLocations: [] }));
  }
  if (result.execution.timedOut || result.execution.exitCode !== 0) {
    diagnostics.push(defineDiagnostic({ id: diagnosticId("SIM_EXECUTION_FAILED_001"), severity: "error", dimension: "functional", message: result.execution.timedOut ? "ngspice execution timed out" : `ngspice exited ${result.execution.exitCode}`, waiverPolicy: "forbidden", objects: [definition.name], sourceLocations: [], evidence: [`ngspice:${result.tool.version}:${result.tool.executableSha256}`] }));
  }
  const axisValues = result.axis?.values;
  const monotonicAxis = axisValues === undefined || axisValues.every((value, index) => index === 0 || value > axisValues[index - 1]!);
  let coverageValid = monotonicAxis && result.vectors.every(({ samples }) =>
    definition.analysis.kind === "operating-point" ? samples.length === 1 : samples.length === axisValues?.length
  );
  if (definition.analysis.kind === "operating-point") coverageValid &&= result.axis === null;
  else if (result.axis === null || axisValues === undefined) coverageValid = false;
  else if (definition.analysis.kind === "dc-sweep") {
    coverageValid &&= matchesDcAxis(result.axis, definition.analysis);
  } else if (definition.analysis.kind === "ac") {
    coverageValid &&= matchesAcAxis(result.axis, definition.analysis);
  } else if (definition.analysis.kind === "transient") {
    coverageValid &&= matchesTransientAxis(result.axis, definition.analysis);
  }
  if (!coverageValid) {
    diagnostics.push(defineDiagnostic({ id: diagnosticId("SIM_VECTOR_COVERAGE_INVALID_001"), severity: "error", dimension: "functional", message: "Simulation axis or vector sample coverage does not match the declared analysis", waiverPolicy: "forbidden", objects: [definition.name], sourceLocations: [] }));
  }
  const evaluationContext: SimulationEvaluationContext = {
    vectors: new Map(result.vectors.map((vector) => [vector.name.toLowerCase(), vector])),
    selected: new Map(),
  };
  for (const assertion of definition.assertions) {
    const actual = selectedExpression(evaluationContext, assertion.expression, assertion.sample, result.axis);
    const tolerance = assertion.absoluteTolerance + assertion.relativeTolerance * Math.abs(assertion.expected);
    const difference = actual === undefined ? undefined : Math.abs(actual - assertion.expected);
    if (actual === undefined || difference === undefined || !Number.isFinite(tolerance) || !Number.isFinite(difference) || difference > tolerance) {
      const objects = expressionObjects(assertion.expression);
      diagnostics.push(defineDiagnostic({ id: diagnosticId("SIM_ASSERTION_FAILED_001"), severity: "error", dimension: "functional", message: actual === undefined ? `Assertion vectors ${objects.join(", ")} are missing, non-finite, complex-incompatible, unit-mismatched, or unavailable at the selected coordinate` : !Number.isFinite(tolerance) || !Number.isFinite(difference) ? `Assertion over ${objects.join(", ")} produced a non-finite comparison` : `Assertion over ${objects.join(", ")} is outside tolerance`, waiverPolicy: "forbidden", objects, sourceLocations: [], measurement: { actual: actual === undefined ? "unavailable" : `${actual} ${assertion.unit}`, required: Number.isFinite(tolerance) ? `${assertion.expected} ± ${tolerance} ${assertion.unit}` : "finite derived tolerance" } }));
    }
  }
  if (diagnostics.length === 0) {
    if (qualified) {
      return Object.freeze({
        status: assuranceStatus("functional", "passed", {
          summary: "Qualified ngspice execution and all numeric assertions passed",
        }),
        diagnostics: Object.freeze([]),
      });
    }
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("SIM_EXECUTION_ADAPTER_UNAVAILABLE_001"),
      severity: "error",
      dimension: "functional",
      message: "Recorded evidence is internally consistent, but PCBoo does not yet own a qualified ngspice execution adapter",
      waiverPolicy: "forbidden",
      objects: [definition.name],
      sourceLocations: [],
    }));
    return Object.freeze({
      status: assuranceStatus("functional", "incomplete", {
        diagnosticIds: diagnostics.map(({ id }) => id),
        summary: "Simulation execution provenance is incomplete",
      }),
      diagnostics: Object.freeze(diagnostics),
    });
  }
  const status = assuranceStatus("functional", "failed", { diagnosticIds: diagnostics.map(({ id }) => id), summary: "Simulation assertions failed" });
  return Object.freeze({ status, diagnostics: Object.freeze(diagnostics) });
}

export function assessSimulationResult(
  definition: SimulationDefinition,
  rawResult: unknown,
  binding: SimulationEvidenceBinding,
): Readonly<SimulationAssessment> {
  return assessSimulationResultInternal(definition, rawResult, binding, false);
}

/** @internal Only the pinned execution adapter may turn validated evidence into a pass. */
export function assessQualifiedSimulationResult(
  definition: SimulationDefinition,
  rawResult: unknown,
  binding: SimulationEvidenceBinding,
): Readonly<SimulationAssessment> {
  return assessSimulationResultInternal(definition, rawResult, binding, true);
}
