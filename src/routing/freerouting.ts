// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnyCircuitElement } from "circuit-json";
import {
  convertCircuitJsonToDsnJson,
  convertDsnSessionToCircuitJson,
  parseDsnToDsnJson,
  stringifyDsnJson,
  type DsnPcb,
  type DsnSession,
} from "dsn-converter";
import { canonicalCircuitJson } from "../circuit-json";
import { probeExternalTool } from "../external-tools";
import { hashBoundedRegularFile, readBoundedRegularFile } from "../internal/bounded-file";
import { spawnContainedProcess } from "../internal/contained-process";
import { parseJsonWithoutDuplicateKeys } from "../upgrade/jsonc";

export const FREEROUTING_ADAPTER_VERSION = "3" as const;
export const FREEROUTING_SUPPORTED_VERSION = "2.2.4" as const;
export const FREEROUTING_REQUIRED_JAVA_MAJOR = 25 as const;
export const FREEROUTING_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const FREEROUTING_DEFAULT_HEAP_MB = 1_024;
export const FREEROUTING_DEFAULT_MAX_ELEMENTS = 25_000;
export const FREEROUTING_SES_BYTES_LIMIT = 64 * 1024 * 1024;
export const FREEROUTING_DRC_BYTES_LIMIT = 8 * 1024 * 1024;
const FREEROUTING_JAR_BYTES_LIMIT = 256 * 1024 * 1024;
const FREEROUTING_LOG_BYTES_LIMIT = 2 * 1024 * 1024;

export interface FreeroutingDsnArtifact {
  readonly dsn: string;
  readonly dsnSha256: string;
  readonly layerNames: readonly string[];
  readonly clearanceMm: number;
  readonly clearanceDsnUnits: number;
  readonly removedExistingRoutingElements: number;
  readonly approximatedSlottedHoles: number;
  readonly exportedKeepouts: number;
}

export interface FreeroutingRunOptions {
  readonly circuitJson: readonly AnyCircuitElement[];
  /** Existing PCBoo run directory. The adapter creates one fresh child. */
  readonly runDirectory: string;
  readonly clearanceMm: number;
  readonly jarPath: string;
  readonly jarSha256: string;
  readonly freeroutingVersion: typeof FREEROUTING_SUPPORTED_VERSION;
  readonly javaExecutable?: string | null;
  readonly heapMb?: number;
  readonly threads?: number;
  readonly maxPasses?: number;
  readonly maxElements?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FreeroutingCandidate {
  readonly state: "candidate" | "unavailable" | "failed";
  readonly message: string;
  readonly candidateCircuitJson?: readonly AnyCircuitElement[];
  readonly evidence: Readonly<{
    schemaVersion: 1;
    adapter: { name: "pcboo-freerouting"; version: typeof FREEROUTING_ADAPTER_VERSION };
    tool: { name: "freerouting"; version: string; jarSha256: string };
    java?: { version: string; executableSha256: string };
    limits: { heapMb: number; threads: number; maxPasses: number; maxElements: number; timeoutMs: number };
    input: { dsnSha256: string; circuitSha256: string; clearanceMm: number; layerNames: readonly string[] };
    output?: { sesSha256: string; drcSha256?: string; candidateCircuitSha256: string };
  }>;
  readonly directory?: string;
  readonly workspaceArtifacts?: readonly Readonly<{ path: string; kind: string; digest: string }>[];
}

function sha256(value: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function positiveFinite(value: number, context: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${context} must be positive and finite`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${context} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function expectedLayerNames(numLayers: number): readonly string[] {
  boundedInteger(numLayers, 2, 10, "PCB layer count");
  return Object.freeze([
    "F.Cu",
    ...Array.from({ length: numLayers - 2 }, (_, index) => `In${index + 1}.Cu`),
    "B.Cu",
  ]);
}

function circuitLayerFromDsn(layer: string): string {
  if (layer === "F.Cu") return "top";
  if (layer === "B.Cu") return "bottom";
  const inner = /^In(\d+)\.Cu$/u.exec(layer);
  if (inner !== null) return `inner${inner[1]}`;
  throw new Error(`Unsupported Freerouting copper layer ${layer}`);
}

function dsnLayerFromCircuit(layer: string): string {
  if (layer === "top") return "F.Cu";
  if (layer === "bottom") return "B.Cu";
  const inner = /^inner(\d+)$/u.exec(layer);
  if (inner !== null) return `In${inner[1]}.Cu`;
  throw new Error(`Unsupported Circuit JSON copper layer ${layer}`);
}

function injectFreeroutingKeepouts(
  dsn: string,
  circuitJson: readonly AnyCircuitElement[],
  layerNames: readonly string[],
): Readonly<{ dsn: string; count: number }> {
  const statements: string[] = [];
  for (const element of circuitJson) {
    if (element.type !== "pcb_keepout") continue;
    if ((element.excluded_pcb_component_ids?.length ?? 0) > 0) {
      throw new Error(`${element.pcb_keepout_id} has component exclusions that Specctra DSN cannot preserve`);
    }
    for (const circuitLayer of element.layers) {
      const dsnLayer = dsnLayerFromCircuit(circuitLayer);
      if (!layerNames.includes(dsnLayer)) {
        throw new Error(`${element.pcb_keepout_id} references unavailable layer ${circuitLayer}`);
      }
      const name = JSON.stringify(`${element.pcb_keepout_id}:${dsnLayer}`);
      if (element.shape === "rect") {
        const x1 = (element.center.x - element.width / 2) * 1_000;
        const y1 = (element.center.y - element.height / 2) * 1_000;
        const x2 = (element.center.x + element.width / 2) * 1_000;
        const y2 = (element.center.y + element.height / 2) * 1_000;
        statements.push(`    (keepout ${name}\n      (rect ${dsnLayer} ${x1} ${y1} ${x2} ${y2})\n    )`);
      } else {
        statements.push(`    (keepout ${name}\n      (circle ${dsnLayer} ${element.radius * 2_000} ${element.center.x * 1_000} ${element.center.y * 1_000})\n    )`);
      }
    }
  }
  if (statements.length === 0) return Object.freeze({ dsn, count: 0 });
  const marker = "    (via ";
  const markerIndex = dsn.indexOf(marker);
  if (markerIndex < 0) throw new Error("Generated Freerouting DSN has no structure via marker");
  return Object.freeze({
    dsn: `${dsn.slice(0, markerIndex)}${statements.join("\n")}\n${dsn.slice(markerIndex)}`,
    count: statements.length,
  });
}

/**
 * dsn-converter 0.0.x collapses every session path other than F.Cu to the
 * Circuit JSON bottom layer. Restore the authoritative SES layer names after
 * conversion, including the layer transitions attached to generated vias.
 */
export function restoreFreeroutingSessionLayers(
  converted: readonly AnyCircuitElement[],
  session: DsnSession,
): AnyCircuitElement[] {
  const corrected = structuredClone(converted) as AnyCircuitElement[];
  const sessionTraces = new Map<string, string>();
  const viaTransitions = new Map<string, readonly [string, string]>();

  for (const net of session.routes.network_out.nets) {
    net.wires?.forEach((wire, wireIndex) => {
      if (!("path" in wire)) return;
      sessionTraces.set(`pcb_trace_${net.name}_${wireIndex}`, circuitLayerFromDsn(wire.path.layer));
    });
    for (const via of net.vias ?? []) {
      const touchingLayers: string[] = [];
      for (const wire of net.wires ?? []) {
        if (!("path" in wire)) continue;
        const coordinates = wire.path.coordinates;
        for (let index = 0; index < coordinates.length; index += 2) {
          if (coordinates[index] === via.x && coordinates[index + 1] === via.y) {
            const layer = circuitLayerFromDsn(wire.path.layer);
            if (!touchingLayers.includes(layer)) touchingLayers.push(layer);
            break;
          }
        }
      }
      if (touchingLayers.length >= 2) {
        viaTransitions.set(`${net.name}:${via.x / 1e4}:${via.y / 1e4}`, [touchingLayers[0]!, touchingLayers[1]!]);
      }
    }
  }

  for (const element of corrected) {
    if (element.type === "pcb_trace") {
      const layer = sessionTraces.get(element.pcb_trace_id);
      const sessionNet = /^(?:pcb_trace_)(.+)_\d+$/u.exec(element.pcb_trace_id)?.[1];
      if (layer !== undefined) {
        for (const point of element.route) {
          if (point.route_type === "wire") point.layer = layer as typeof point.layer;
        }
      }
      for (const point of element.route) {
        if (point.route_type !== "via") continue;
        const transition = sessionNet === undefined
          ? undefined
          : viaTransitions.get(`${sessionNet}:${point.x}:${point.y}`);
        if (transition !== undefined) {
          point.from_layer = transition[0] as typeof point.from_layer;
          point.to_layer = transition[1] as typeof point.to_layer;
        }
      }
    } else if (element.type === "pcb_via") {
      const netName = element.pcb_trace_id?.replace(/^pcb_trace_/u, "");
      if (netName === undefined) continue;
      const transition = viaTransitions.get(`${netName}:${element.x}:${element.y}`);
      if (transition !== undefined) {
        element.from_layer = transition[0] as typeof element.from_layer;
        element.to_layer = transition[1] as typeof element.to_layer;
        element.layers = [...transition] as typeof element.layers;
      }
    }
  }
  return corrected;
}

/**
 * Builds a routing-only view of Circuit JSON. Freerouting must solve the whole
 * board from connectivity, so existing physical routes are deliberately not
 * carried into the DSN. dsn-converter cannot represent rectangular-pad slots;
 * those are conservatively bounded by circles for obstacle and pin placement.
 * The authored Circuit JSON and manufacturing geometry remain untouched.
 */
function prepareFreeroutingInput(circuitJson: readonly AnyCircuitElement[]): Readonly<{
  circuitJson: AnyCircuitElement[];
  removedExistingRoutingElements: number;
  approximatedSlottedHoles: number;
}> {
  let removedExistingRoutingElements = 0;
  let approximatedSlottedHoles = 0;
  const prepared: AnyCircuitElement[] = [];
  for (const element of circuitJson) {
    if (element.type === "pcb_trace" || element.type === "pcb_via") {
      removedExistingRoutingElements += 1;
      continue;
    }
    if (
      element.type === "pcb_plated_hole" &&
      (element.shape === "pill_hole_with_rect_pad" ||
        element.shape === "rotated_pill_hole_with_rect_pad")
    ) {
      const rotated = element.shape === "rotated_pill_hole_with_rect_pad";
      const padWidth = positiveFinite(
        rotated ? element.rect_pad_height : element.rect_pad_width,
        `${element.pcb_plated_hole_id} routing pad width`,
      );
      const padHeight = positiveFinite(
        rotated ? element.rect_pad_width : element.rect_pad_height,
        `${element.pcb_plated_hole_id} routing pad height`,
      );
      const holeWidth = positiveFinite(
        rotated ? element.hole_height : element.hole_width,
        `${element.pcb_plated_hole_id} routing hole width`,
      );
      const holeHeight = positiveFinite(
        rotated ? element.hole_width : element.hole_height,
        `${element.pcb_plated_hole_id} routing hole height`,
      );
      approximatedSlottedHoles += 1;
      prepared.push({
        ...element,
        shape: "circle",
        hole_diameter: Math.hypot(holeWidth, holeHeight),
        outer_diameter: Math.hypot(padWidth, padHeight),
      } as AnyCircuitElement);
      continue;
    }
    prepared.push(element);
  }
  return Object.freeze({ circuitJson: prepared, removedExistingRoutingElements, approximatedSlottedHoles });
}

/** Creates and independently checks the exact DSN contract sent to Freerouting. */
export function createFreeroutingDsn(
  circuitJson: readonly AnyCircuitElement[],
  options: { readonly clearanceMm: number; readonly maxElements?: number },
): Readonly<FreeroutingDsnArtifact> {
  const clearanceMm = positiveFinite(options.clearanceMm, "Freerouting clearance");
  const maxElements = boundedInteger(
    options.maxElements ?? FREEROUTING_DEFAULT_MAX_ELEMENTS,
    1,
    100_000,
    "Freerouting maximum element count",
  );
  if (circuitJson.length > maxElements) {
    throw new Error(`Freerouting input has ${circuitJson.length} elements; limit is ${maxElements}`);
  }
  const boards = circuitJson.filter((element) => element.type === "pcb_board");
  if (boards.length !== 1) throw new Error(`Freerouting requires exactly one PCB board; found ${boards.length}`);
  const layerNames = expectedLayerNames(boards[0]!.num_layers);
  // dsn-converter's geometry and rule values are expressed in micrometres.
  // Its `(resolution um 10)` declaration describes coordinate precision; it
  // is not an additional scale factor for clearance values. For example,
  // 0.20 mm must be emitted as 200, matching the converter's 150 µm default.
  const clearanceDsnUnits = clearanceMm * 1_000;
  const routingInput = prepareFreeroutingInput(circuitJson);
  const dsnJson = convertCircuitJsonToDsnJson(routingInput.circuitJson, {
    traceClearance: clearanceDsnUnits,
  });
  const actualLayers = dsnJson.structure.layers.map((layer) => layer.name);
  if (JSON.stringify(actualLayers) !== JSON.stringify(layerNames)) {
    throw new Error(
      `DSN layer mapping mismatch: expected ${layerNames.join("/")}; received ${actualLayers.join("/")}`,
    );
  }
  const globalClearance = dsnJson.structure.rule.clearances.find((entry) => entry.type === undefined)?.value;
  const classClearances = dsnJson.network.classes.flatMap((item) =>
    item.rule.clearances.filter((entry) => entry.type === undefined).map((entry) => entry.value)
  );
  if (
    globalClearance !== clearanceDsnUnits || classClearances.length === 0 ||
    classClearances.some((value) => value !== clearanceDsnUnits)
  ) throw new Error("DSN converter did not preserve the requested manufacturing clearance");
  const keepouts = injectFreeroutingKeepouts(stringifyDsnJson(dsnJson), routingInput.circuitJson, layerNames);
  const dsn = keepouts.dsn;
  const reparsed = parseDsnToDsnJson(dsn);
  if (!reparsed.is_dsn_pcb) throw new Error("Generated Freerouting input did not parse back as a DSN PCB");
  if (JSON.stringify(reparsed.structure.layers.map((layer) => layer.name)) !== JSON.stringify(layerNames)) {
    throw new Error("Generated Freerouting DSN changed layer order during parse-back");
  }
  return Object.freeze({
    dsn,
    dsnSha256: sha256(dsn),
    layerNames,
    clearanceMm,
    clearanceDsnUnits,
    removedExistingRoutingElements: routingInput.removedExistingRoutingElements,
    approximatedSlottedHoles: routingInput.approximatedSlottedHoles,
    exportedKeepouts: keepouts.count,
  });
}

async function consumeBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  terminate: () => void,
): Promise<Readonly<{ sha256: string; bytes: number }>> {
  const reader = stream.getReader();
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        terminate();
        throw new Error(`Freerouting log output exceeded ${limit} bytes`);
      }
      hasher.update(chunk.value);
    }
    return Object.freeze({ sha256: hasher.digest("hex"), bytes });
  } finally {
    reader.releaseLock();
  }
}

function parseJavaMajor(output: string): number | null {
  const match = /(?:java|openjdk) version "(\d+)(?:[._][0-9]+)*/iu.exec(output);
  return match === null ? null : Number(match[1]);
}

async function requireRegularJar(path: string, expectedSha256: string): Promise<Readonly<{ path: string; sha256: string }>> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new TypeError("Freerouting JAR digest must be lowercase SHA-256");
  const resolved = await realpath(path);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Freerouting JAR must resolve to a regular file");
  const actual = await hashBoundedRegularFile(resolved, FREEROUTING_JAR_BYTES_LIMIT);
  if (actual !== expectedSha256) throw new Error("Freerouting JAR digest does not match the requested tool identity");
  return Object.freeze({ path: resolved, sha256: actual });
}

async function captureWorkspaceArtifacts(directory: string): Promise<readonly Readonly<{
  path: string;
  kind: string;
  digest: string;
}>[]> {
  const candidates = [
    { path: join(directory, "input.dsn"), kind: "freerouting-input-dsn", limit: FREEROUTING_SES_BYTES_LIMIT },
    { path: join(directory, "candidate.ses"), kind: "freerouting-output-session", limit: FREEROUTING_SES_BYTES_LIMIT },
    { path: join(directory, "drc.json"), kind: "freerouting-drc", limit: FREEROUTING_DRC_BYTES_LIMIT },
    { path: join(directory, "home", "freerouting", "freerouting.json"), kind: "freerouting-tool-config", limit: FREEROUTING_LOG_BYTES_LIMIT },
    { path: join(directory, "home", "freerouting", "freerouting.log"), kind: "freerouting-tool-log", limit: FREEROUTING_LOG_BYTES_LIMIT },
  ] as const;
  const artifacts: Readonly<{ path: string; kind: string; digest: string }>[] = [];
  for (const candidate of candidates) {
    const exists = await lstat(candidate.path).then(
      (stat) => {
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Freerouting workspace artifact ${candidate.kind} is not a regular file`);
        }
        return true;
      },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      },
    );
    if (!exists) continue;
    artifacts.push(Object.freeze({
      path: candidate.path,
      kind: candidate.kind,
      digest: await hashBoundedRegularFile(candidate.path, candidate.limit),
    }));
  }
  return Object.freeze(artifacts);
}

export async function runFreeroutingCandidate(
  options: FreeroutingRunOptions,
): Promise<Readonly<FreeroutingCandidate>> {
  if (options.freeroutingVersion !== FREEROUTING_SUPPORTED_VERSION) {
    throw new TypeError(`PCBoo qualifies Freerouting ${FREEROUTING_SUPPORTED_VERSION}`);
  }
  const heapMb = boundedInteger(options.heapMb ?? FREEROUTING_DEFAULT_HEAP_MB, 128, 4_096, "Freerouting heap");
  const threads = boundedInteger(options.threads ?? 1, 1, 4, "Freerouting thread count");
  const maxPasses = boundedInteger(options.maxPasses ?? 100, 1, 2_000, "Freerouting pass count");
  const maxElements = boundedInteger(
    options.maxElements ?? FREEROUTING_DEFAULT_MAX_ELEMENTS,
    1,
    100_000,
    "Freerouting maximum element count",
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? FREEROUTING_DEFAULT_TIMEOUT_MS,
    1_000,
    30 * 60_000,
    "Freerouting timeout",
  );
  const dsn = createFreeroutingDsn(options.circuitJson, { clearanceMm: options.clearanceMm, maxElements });
  const circuitSha256 = sha256(canonicalCircuitJson(options.circuitJson));
  const jar = await requireRegularJar(options.jarPath, options.jarSha256);
  const baseEvidence = {
    schemaVersion: 1 as const,
    adapter: { name: "pcboo-freerouting" as const, version: FREEROUTING_ADAPTER_VERSION },
    tool: { name: "freerouting" as const, version: options.freeroutingVersion, jarSha256: jar.sha256 },
    limits: { heapMb, threads, maxPasses, maxElements, timeoutMs },
    input: { dsnSha256: dsn.dsnSha256, circuitSha256, clearanceMm: dsn.clearanceMm, layerNames: dsn.layerNames },
  };
  const javaProbe = await probeExternalTool({
    tool: "java",
    ...(options.javaExecutable === undefined ? {} : { executable: options.javaExecutable }),
    versionArguments: ["-version"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (javaProbe.state === "unavailable") {
    return Object.freeze({ state: "unavailable", message: javaProbe.reason ?? "Java is unavailable", evidence: Object.freeze(baseEvidence) });
  }
  const javaMajor = parseJavaMajor(javaProbe.versionOutput ?? "");
  if (
    javaMajor !== FREEROUTING_REQUIRED_JAVA_MAJOR ||
    javaProbe.executableSha256 === undefined
  ) {
    return Object.freeze({
      state: "unavailable",
      message: `Freerouting ${FREEROUTING_SUPPORTED_VERSION} requires Java ${FREEROUTING_REQUIRED_JAVA_MAJOR}`,
      evidence: Object.freeze(baseEvidence),
    });
  }
  const parent = await realpath(options.runDirectory);
  const directory = await mkdtemp(join(parent, "freerouting-"));
  const home = join(directory, "home");
  await mkdir(home);
  const dsnPath = join(directory, "input.dsn");
  const sesPath = join(directory, "candidate.ses");
  const drcPath = join(directory, "drc.json");
  await Bun.write(dsnPath, dsn.dsn);
  const child = await spawnContainedProcess({
    command: [
      javaProbe.executable!,
      `-Xms64m`,
      `-Xmx${heapMb}m`,
      `-XX:ActiveProcessorCount=${threads}`,
      "-Dlog4j2.disableJndi=true",
      `-Duser.home=${home}`,
      `-Djava.io.tmpdir=${home}`,
      "-jar",
      jar.path,
      "--gui.enabled=false",
      "--api_server.enabled=false",
      "-da",
      "-de",
      dsnPath,
      "-do",
      sesPath,
      "-drc",
      drcPath,
      "-mp",
      String(maxPasses),
      "-mt",
      String(threads),
      "-random_seed",
      "1",
    ],
    cwd: directory,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      TMPDIR: home,
      LC_ALL: "C",
      LANG: "C",
    },
    denyNetwork: true,
  });
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const onAbort = () => { cancelled = true; child.terminate(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (cancelled) child.terminate();
  const timer = setTimeout(() => { timedOut = true; child.terminate(); }, timeoutMs);
  let exitCode: number;
  try {
    [exitCode] = await Promise.all([
      child.exited,
      consumeBounded(child.stdout, FREEROUTING_LOG_BYTES_LIMIT, child.terminate),
      consumeBounded(child.stderr, FREEROUTING_LOG_BYTES_LIMIT, child.terminate),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  const java = { version: String(javaMajor), executableSha256: javaProbe.executableSha256! };
  const evidenceWithJava = { ...baseEvidence, java };
  const workspaceArtifacts = await captureWorkspaceArtifacts(directory);
  const capturedInput = workspaceArtifacts.find(({ kind }) => kind === "freerouting-input-dsn");
  if (capturedInput?.digest !== dsn.dsnSha256) {
    throw new Error("Freerouting input DSN changed after its authenticated write");
  }
  if (cancelled) throw new Error("Freerouting was cancelled");
  if (timedOut) return Object.freeze({ state: "failed", message: `Freerouting exceeded ${timeoutMs} ms`, evidence: Object.freeze(evidenceWithJava), directory, workspaceArtifacts });
  if (exitCode !== 0) return Object.freeze({ state: "failed", message: `Freerouting exited ${exitCode}; untrusted logs were not echoed`, evidence: Object.freeze(evidenceWithJava), directory, workspaceArtifacts });
  const sesBytes = await readBoundedRegularFile(sesPath, FREEROUTING_SES_BYTES_LIMIT);
  const drcExists = await lstat(drcPath).then(
    (stat) => stat.isFile() && !stat.isSymbolicLink(),
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  );
  const drcBytes = drcExists
    ? await readBoundedRegularFile(drcPath, FREEROUTING_DRC_BYTES_LIMIT)
    : undefined;
  const sesText = new TextDecoder("utf-8", { fatal: true }).decode(sesBytes);
  const parsedSession = parseDsnToDsnJson(sesText);
  if (!parsedSession.is_dsn_session) throw new Error("Freerouting output is not a Specctra session");
  if (drcBytes !== undefined) {
    const drcText = new TextDecoder("utf-8", { fatal: true }).decode(drcBytes);
    parseJsonWithoutDuplicateKeys(drcText, "Freerouting DRC output");
  }
  const dsnPcb = parseDsnToDsnJson(dsn.dsn);
  if (!dsnPcb.is_dsn_pcb) throw new Error("Authenticated Freerouting input no longer parses as a DSN PCB");
  const sessionForConversion = structuredClone(parsedSession) as DsnSession;
  const sessionLibrary = (sessionForConversion as unknown as {
    routes: { library_out?: { padstacks?: { name: string }[] } };
  }).routes.library_out;
  const converterViaPadstack = sessionLibrary?.padstacks?.find(({ name }) =>
    /^Via\[\d+-\d+\]_600:300_um$/u.test(name)
  );
  if (converterViaPadstack !== undefined) {
    // dsn-converter 0.0.x recognizes only this hard-coded two-layer name when
    // reconstructing session vias. The SES coordinates and actual adjacent
    // copper layers remain authoritative; this alias only enables conversion.
    converterViaPadstack.name = "Via[0-1]_600:300_um";
  }
  const convertedCandidate = restoreFreeroutingSessionLayers(convertDsnSessionToCircuitJson(
    dsnPcb as DsnPcb,
    sessionForConversion,
    [...options.circuitJson],
  ), parsedSession as DsnSession);
  const authoritativeSemanticTypes = new Set([
    "source_component",
    "source_port",
    "source_net",
    "source_trace",
    "pcb_port",
  ]);
  const candidateCircuitJson = [
    ...convertedCandidate.filter((element) => !authoritativeSemanticTypes.has(element.type)),
    ...options.circuitJson.filter((element) => authoritativeSemanticTypes.has(element.type)),
  ];
  const candidateCircuitSha256 = sha256(canonicalCircuitJson(candidateCircuitJson));
  const output = {
    sesSha256: sha256(sesBytes),
    ...(drcBytes === undefined ? {} : { drcSha256: sha256(drcBytes) }),
    candidateCircuitSha256,
  };
  return Object.freeze({
    state: "candidate",
    message: "Freerouting produced a bounded candidate; PCBoo checks and source promotion are still required",
    candidateCircuitJson: Object.freeze(candidateCircuitJson),
    evidence: Object.freeze({ ...evidenceWithJava, output }),
    directory: resolve(directory),
    workspaceArtifacts,
  });
}
