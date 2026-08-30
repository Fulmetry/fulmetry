import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AnyCircuitElement } from "tscircuit";
import { parseCanonicalCircuitJson } from "../../src/circuit-json";
import { deriveManufacturingExpectation, manufacturingExpectationSha256 } from "../../src/manufacturing/expectation";
import { requireTscircuitIdentity } from "../../src/engine-identity";

export const CANONICAL_FIXTURE_NAMES = ["led-2layer", "plated-hole-4layer"] as const;
export type CanonicalFixtureName = typeof CANONICAL_FIXTURE_NAMES[number];

export interface CanonicalExpectation {
  readonly schemaVersion: 1;
  readonly fixtureName: CanonicalFixtureName;
  readonly boardName: string;
  readonly manufacturingExpectationSha256: string;
  readonly expectedFiles: readonly string[];
  readonly board: { readonly layerCount: 2 | 4; readonly widthMm: number; readonly heightMm: number };
  readonly components: Readonly<Record<string, {
    readonly kind: string; readonly xMm: number; readonly yMm: number;
    readonly side: "top" | "bottom"; readonly widthMm: number; readonly heightMm: number;
    readonly smtPadCount: number; readonly platedHoleCount: number;
  }>>;
  readonly connectivity: readonly {
    readonly trace: string; readonly endpoints: readonly string[];
  }[];
  readonly platedHoleSpans: readonly {
    readonly component: string; readonly xMm: number; readonly yMm: number;
    readonly layers: readonly string[];
  }[];
  readonly vias: readonly {
    readonly xMm: number; readonly yMm: number; readonly fromLayer: string; readonly toLayer: string;
  }[];
  readonly features: {
    readonly copperLayers: readonly string[];
    readonly smtDesignators: readonly string[];
    readonly throughHoleDesignators: readonly string[];
    readonly bottomDesignators: readonly string[];
    readonly nonPlatedHoleCount: number;
  };
  readonly compatibility: {
    readonly batteryVoltageBackfill: {
      readonly implementation: string; readonly engineVersion: string;
      readonly component: string; readonly voltageV: number;
    };
    readonly routeIntent: {
      readonly implementation: string; readonly engineVersion: string;
      readonly requiredViaCount: number;
      readonly requiredTransitions: readonly {
        readonly trace: string; readonly fromLayer: string; readonly toLayer: string;
      }[];
    };
    readonly innerLayerRouting?: {
      readonly implementation: string; readonly engineVersion: string;
      readonly groundComponent: string; readonly groundNet: string;
      readonly groundLayers: readonly string[];
      readonly viaConnections: readonly {
        readonly net: string; readonly layer: string; readonly xMm: number; readonly yMm: number;
      }[];
    };
  };
}

export interface CanonicalManifest {
  readonly schemaVersion: 1;
  readonly fixtureName: CanonicalFixtureName;
  readonly tscircuit: { readonly version: string; readonly integrity: string; readonly contentSha256: string };
  readonly adapters: Readonly<Record<string, string>>;
  readonly inputs: {
    readonly fileCount: number; readonly setSha256: string;
    readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  };
  readonly circuit: { readonly path: "circuit.json"; readonly size: number; readonly sha256: string; readonly semanticSha256: string };
  readonly manufacturing: {
    readonly directory: "manufacturing"; readonly fileCount: number; readonly setSha256: string;
    readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  };
}

export const canonicalFixturesRoot = join(import.meta.dir, "canonical");
export const canonicalFixtureRoot = (name: CanonicalFixtureName): string =>
  join(canonicalFixturesRoot, name);

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

export async function loadCanonicalFixture(name: CanonicalFixtureName): Promise<{
  readonly root: string; readonly expectation: CanonicalExpectation;
  readonly manifest: CanonicalManifest; readonly circuitJson: AnyCircuitElement[];
  readonly canonicalJson: string;
}> {
  const root = canonicalFixtureRoot(name);
  const expectation = JSON.parse(await readFile(join(root, "expectation.json"), "utf8")) as unknown;
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as unknown;
  assertRecord(expectation, `${name} expectation`);
  assertRecord(manifest, `${name} manifest`);
  if (expectation.schemaVersion !== 1 || expectation.fixtureName !== name) {
    throw new TypeError(`${name} expectation has incompatible identity`);
  }
  if (manifest.schemaVersion !== 1 || manifest.fixtureName !== name) {
    throw new TypeError(`${name} manifest has incompatible identity`);
  }
  const canonicalJson = await readFile(join(root, "circuit.json"), "utf8");
  return {
    root,
    expectation: expectation as unknown as CanonicalExpectation,
    manifest: manifest as unknown as CanonicalManifest,
    circuitJson: parseCanonicalCircuitJson(canonicalJson),
    canonicalJson,
  };
}

const roundMm = (value: unknown): number => Math.round(Number(value) * 1_000_000) / 1_000_000;
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Validate every authored expectation field against compiled or on-disk evidence. */
export async function validateCanonicalExpectation(options: {
  readonly name: CanonicalFixtureName;
  readonly root: string;
  readonly expectation: CanonicalExpectation;
  readonly circuitJson: readonly AnyCircuitElement[];
}): Promise<void> {
  const { name, root, expectation, circuitJson } = options;
  const failures: string[] = [];
  const requireEqual = (label: string, actual: unknown, expected: unknown): void => {
    if (!sameJson(actual, expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  requireEqual("schemaVersion", expectation.schemaVersion, 1);
  requireEqual("fixtureName", expectation.fixtureName, name);

  const elements = circuitJson as unknown as readonly Record<string, unknown>[];
  const board = elements.find((element) => element.type === "pcb_board");
  requireEqual("board", board === undefined ? null : {
    layerCount: board.num_layers, widthMm: board.width, heightMm: board.height,
  }, expectation.board);

  const sourceById = new Map(elements.filter((element) => element.type === "source_component")
    .map((element) => [String(element.source_component_id), element]));
  const sourceNameById = new Map([...sourceById].map(([id, element]) => [id, String(element.name)]));
  const pcbComponents = elements.filter((element) => element.type === "pcb_component");
  const pcbNameById = new Map(pcbComponents.map((element) =>
    [String(element.pcb_component_id), sourceNameById.get(String(element.source_component_id))!]));
  const smtPads = elements.filter((element) => element.type === "pcb_smtpad");
  const platedHoles = elements.filter((element) => element.type === "pcb_plated_hole");
  const actualComponents = Object.fromEntries(pcbComponents.map((element) => {
    const sourceId = String(element.source_component_id);
    const source = sourceById.get(sourceId)!;
    const center = element.center as { x: number; y: number };
    return [String(source.name), {
      kind: source.ftype, xMm: roundMm(center.x), yMm: roundMm(center.y), side: element.layer,
      widthMm: roundMm(element.width), heightMm: roundMm(element.height),
      smtPadCount: smtPads.filter((pad) => pad.pcb_component_id === element.pcb_component_id).length,
      platedHoleCount: platedHoles.filter((hole) => hole.pcb_component_id === element.pcb_component_id).length,
    }];
  }).sort(([left], [right]) => String(left).localeCompare(String(right))));
  requireEqual("components", actualComponents, expectation.components);

  const portNames = new Map(elements.filter((element) => element.type === "source_port").map((element) =>
    [String(element.source_port_id), `${sourceNameById.get(String(element.source_component_id))}.${String(element.name)}`]));
  const netNames = new Map(elements.filter((element) => element.type === "source_net").map((element) =>
    [String(element.source_net_id), `net.${String(element.name)}`]));
  const actualConnectivity = elements.filter((element) => element.type === "source_trace").map((element) => ({
    trace: String(element.name),
    endpoints: [
      ...((element.connected_source_port_ids as string[] | undefined) ?? []).map((id) => portNames.get(id)!),
      ...((element.connected_source_net_ids as string[] | undefined) ?? []).map((id) => netNames.get(id)!),
    ].sort(),
  })).sort((left, right) => left.trace.localeCompare(right.trace));
  requireEqual("connectivity", actualConnectivity, expectation.connectivity);

  const actualHoleSpans = platedHoles.map((element) => ({
    component: pcbNameById.get(String(element.pcb_component_id)), xMm: roundMm(element.x),
    yMm: roundMm(element.y), layers: element.layers,
  }));
  requireEqual("platedHoleSpans", actualHoleSpans, expectation.platedHoleSpans);
  const vias = elements.filter((element) => element.type === "pcb_via");
  const actualVias = vias.map((element) => ({
    xMm: roundMm(element.x), yMm: roundMm(element.y),
    fromLayer: element.from_layer, toLayer: element.to_layer,
  }));
  requireEqual("vias", actualVias, expectation.vias);

  const copperSet = new Set(elements.filter((element) => element.type === "pcb_trace")
    .flatMap((element) => ((element.route as Record<string, unknown>[] | undefined) ?? [])
      .filter((point) => point.route_type === "wire").map((point) => String(point.layer))));
  const layerStack = board?.num_layers === 4 ? ["top", "inner1", "inner2", "bottom"] : ["top", "bottom"];
  requireEqual("features.copperLayers", layerStack.filter((layer) => copperSet.has(layer)), expectation.features.copperLayers);
  const componentNamesWith = (items: readonly Record<string, unknown>[]): string[] =>
    [...new Set(items.map((item) => pcbNameById.get(String(item.pcb_component_id))!))].sort();
  requireEqual("features.smtDesignators", componentNamesWith(smtPads), expectation.features.smtDesignators);
  requireEqual("features.throughHoleDesignators", componentNamesWith(platedHoles), expectation.features.throughHoleDesignators);
  requireEqual("features.bottomDesignators", pcbComponents.filter((element) => element.layer === "bottom")
    .map((element) => sourceNameById.get(String(element.source_component_id))!).sort(), expectation.features.bottomDesignators);
  requireEqual("features.nonPlatedHoleCount", elements.filter((element) => element.type === "pcb_hole").length,
    expectation.features.nonPlatedHoleCount);

  const lock = JSON.parse(await readFile(join(root, "fulmetry.lock"), "utf8")) as { tscircuit?: { version?: unknown } };
  const batteryPin = expectation.compatibility.batteryVoltageBackfill;
  requireEqual("compatibility.batteryVoltageBackfill.engineVersion", lock.tscircuit?.version, batteryPin.engineVersion);
  const battery = [...sourceById.values()].find((element) => element.name === batteryPin.component);
  requireEqual("compatibility.batteryVoltageBackfill.voltageV", battery?.voltage, batteryPin.voltageV);
  if (battery?.ftype !== "simple_power_source") failures.push("compatibility battery component is not a simple_power_source");
  if (batteryPin.implementation.startsWith("/") || batteryPin.implementation.split("/").includes("..")) {
    failures.push("compatibility battery implementation path is unsafe");
  } else {
    const implementation = await readFile(join(root, ...batteryPin.implementation.split("/")), "utf8").catch(() => "");
    if (!implementation.includes("applyBatterySourceCompatibility") ||
      !(await readFile(join(root, "circuit", "board.ts"), "utf8")).includes("applyBatterySourceCompatibility")) {
      failures.push("compatibility battery implementation is not wired into the fixture");
    }
  }

  const routePin = expectation.compatibility.routeIntent;
  requireEqual("compatibility.routeIntent.engineVersion", lock.tscircuit?.version, routePin.engineVersion);
  requireEqual("compatibility.routeIntent.requiredViaCount", vias.length, routePin.requiredViaCount);
  const pcbTraceById = new Map(elements.filter((element) => element.type === "pcb_trace")
    .map((element) => [String(element.pcb_trace_id), element]));
  const sourceTraceNameById = new Map(elements.filter((element) => element.type === "source_trace")
    .map((element) => [String(element.source_trace_id), String(element.name)]));
  const actualTransitions = vias.map((via) => ({
    trace: sourceTraceNameById.get(String(pcbTraceById.get(String(via.pcb_trace_id))?.source_trace_id)),
    fromLayer: via.from_layer, toLayer: via.to_layer,
  })).sort((left, right) => String(left.trace).localeCompare(String(right.trace)));
  requireEqual("compatibility.routeIntent.requiredTransitions", actualTransitions, routePin.requiredTransitions);
  if (routePin.implementation.startsWith("/") || routePin.implementation.split("/").includes("..")) {
    failures.push("compatibility route implementation path is unsafe");
  } else {
    const implementation = await readFile(join(root, ...routePin.implementation.split("/")), "utf8").catch(() => "");
    if (!implementation.includes("pcbPath") || !implementation.includes("source-component local coordinates")) {
      failures.push("compatibility route implementation does not declare its coordinate frame");
    }
  }

  const innerPin = expectation.compatibility.innerLayerRouting;
  if (board?.num_layers === 4 && innerPin === undefined) {
    failures.push("compatibility.innerLayerRouting is required for observed four-layer inner copper");
  }
  if (board?.num_layers !== 4 && innerPin !== undefined) {
    failures.push("compatibility.innerLayerRouting is forbidden without a four-layer board");
  }
  if (innerPin !== undefined) {
    requireEqual("compatibility.innerLayerRouting.engineVersion", lock.tscircuit?.version, innerPin.engineVersion);
    const sourceNetMatches = elements.filter((element) => element.type === "source_net" && element.name === innerPin.groundNet);
    if (sourceNetMatches.length !== 1) failures.push(`compatibility inner groundNet ${innerPin.groundNet} must resolve exactly once`);
    const sourceNet = sourceNetMatches[0];
    const groundSourceMatches = [...sourceById.values()].filter((element) => element.name === innerPin.groundComponent);
    if (groundSourceMatches.length !== 1) failures.push(`compatibility inner groundComponent ${innerPin.groundComponent} must resolve exactly once`);
    const groundPcbMatches = pcbComponents.filter((element) =>
      sourceNameById.get(String(element.source_component_id)) === innerPin.groundComponent);
    if (groundPcbMatches.length !== 1) failures.push(`compatibility inner groundComponent ${innerPin.groundComponent} must have exactly one PCB component`);
    const groundPcb = groundPcbMatches[0];
    const groundHoles = platedHoles.filter((element) => element.pcb_component_id === groundPcb?.pcb_component_id);
    if (groundHoles.length !== 2) failures.push(`compatibility inner groundComponent ${innerPin.groundComponent} must have exactly two plated holes`);
    const groundSourceTraceIds = new Set(elements.filter((element) => element.type === "source_trace" &&
      ((element.connected_source_net_ids as string[] | undefined) ?? []).includes(String(sourceNet?.source_net_id)))
      .map((element) => String(element.source_trace_id)));
    const isAuthoritativeGroundTrace = (element: Record<string, unknown>): boolean =>
      element.type === "pcb_trace" && groundSourceTraceIds.has(String(element.source_trace_id));
    const observedGroundLayers = layerStack.filter((layer) => layer.startsWith("inner") && elements
      .filter(isAuthoritativeGroundTrace)
      .some((element) => ((element.route as Record<string, unknown>[] | undefined) ?? []).some((point) => point.layer === layer)));
    requireEqual("compatibility.innerLayerRouting.groundLayers", innerPin.groundLayers, observedGroundLayers);
    if (innerPin.groundLayers.length === 0) failures.push("compatibility.innerLayerRouting.groundLayers must be non-empty");
    for (const layer of observedGroundLayers) {
      const wires = elements.filter(isAuthoritativeGroundTrace)
        .flatMap((element) => ((element.route as Record<string, unknown>[] | undefined) ?? []).filter((point) => point.layer === layer));
      for (const hole of groundHoles) {
        if (!wires.some((wire) => roundMm(wire.x) === roundMm(hole.x) && roundMm(wire.y) === roundMm(hole.y))) {
          failures.push(`inner GND ${layer} does not touch ${innerPin.groundComponent} hole at ${hole.x},${hole.y}`);
        }
      }
    }
    const groundVias = vias.filter((via) => {
      const owner = pcbTraceById.get(String(via.pcb_trace_id));
      return owner !== undefined && isAuthoritativeGroundTrace(owner);
    });
    const observedViaConnections = groundVias.flatMap((via) => observedGroundLayers.flatMap((layer) => {
      const joined = elements.filter(isAuthoritativeGroundTrace)
        .flatMap((element) => ((element.route as Record<string, unknown>[] | undefined) ?? []))
        .some((wire) => wire.route_type === "wire" && wire.layer === layer &&
          roundMm(wire.x) === roundMm(via.x) && roundMm(wire.y) === roundMm(via.y));
      return joined ? [{ net: innerPin.groundNet, layer, xMm: roundMm(via.x), yMm: roundMm(via.y) }] : [];
    }));
    requireEqual("compatibility.innerLayerRouting.viaConnections", innerPin.viaConnections, observedViaConnections);
    if (innerPin.viaConnections.length === 0) failures.push("compatibility.innerLayerRouting.viaConnections must be non-empty");
    if (innerPin.implementation.startsWith("/") || innerPin.implementation.split("/").includes("..")) {
      failures.push("compatibility inner implementation path is unsafe");
    } else {
      const implementation = await readFile(join(root, ...innerPin.implementation.split("/")), "utf8").catch(() => "");
      if (!implementation.includes("viaXsMm") ||
        !(await readFile(join(root, "circuit", "board.ts"), "utf8")).includes("applyInnerLayerCompatibilityShim")) {
        failures.push("compatibility inner-layer implementation is not wired into the fixture");
      }
    }
  }

  const derived = deriveManufacturingExpectation({ boardName: expectation.boardName, circuitJson: [...circuitJson] });
  requireEqual("manufacturingExpectationSha256", manufacturingExpectationSha256(derived), expectation.manufacturingExpectationSha256);
  const actualPaths = await listRegularFiles(join(root, "manufacturing"));
  requireEqual("expectedFiles", actualPaths, [...expectation.expectedFiles].sort());
  const metadata = JSON.parse(await readFile(join(root, "manufacturing", "fabrication", "metadata.json"), "utf8")) as { boardName?: unknown };
  requireEqual("boardName", metadata.boardName, expectation.boardName);
  if (failures.length > 0) throw new Error(`Canonical expectation mismatch:\n${failures.join("\n")}`);
}

function normalizedNumber(value: unknown): unknown {
  return typeof value === "number" && Object.is(value, -0) ? 0 : value;
}

/** Stable, generated-ID-free design meaning used in addition to exact-byte identity. */
export function canonicalSemanticProjection(circuitJson: readonly AnyCircuitElement[]): unknown {
  const elements = circuitJson as readonly Record<string, unknown>[];
  const sourceNames = new Map<string, string>();
  for (const element of elements) {
    if (element.type === "source_component" && typeof element.source_component_id === "string" && typeof element.name === "string") {
      sourceNames.set(element.source_component_id, element.name);
    }
  }
  const portNames = new Map<string, string>();
  for (const element of elements) {
    if (element.type !== "source_port" || typeof element.source_port_id !== "string" || typeof element.source_component_id !== "string") continue;
    portNames.set(element.source_port_id, `${sourceNames.get(element.source_component_id) ?? "?"}.${String(element.name)}`);
  }
  const netNames = new Map<string, string>();
  for (const element of elements) {
    if (element.type === "source_net" && typeof element.source_net_id === "string" && typeof element.name === "string") {
      netNames.set(element.source_net_id, `net.${element.name}`);
    }
  }
  const pcbNames = new Map<string, string>();
  for (const element of elements) {
    if (element.type === "pcb_component" && typeof element.pcb_component_id === "string" && typeof element.source_component_id === "string") {
      pcbNames.set(element.pcb_component_id, sourceNames.get(element.source_component_id) ?? "?");
    }
  }
  const board = elements.find((element) => element.type === "pcb_board");
  const components = elements.filter((element) => element.type === "pcb_component").map((element) => ({
    name: sourceNames.get(String(element.source_component_id)),
    kind: elements.find((candidate) => candidate.type === "source_component" && candidate.source_component_id === element.source_component_id)?.ftype,
    center: element.center, layer: element.layer, rotation: normalizedNumber(element.rotation),
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const connections = elements.filter((element) => element.type === "source_trace").map((element) => ({
    name: element.name,
    endpoints: [
      ...((element.connected_source_port_ids as string[] | undefined) ?? []).map((id) => portNames.get(id)),
      ...((element.connected_source_net_ids as string[] | undefined) ?? []).map((id) => netNames.get(id)),
    ].sort(),
    width: element.min_trace_thickness,
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const vias = elements.filter((element) => element.type === "pcb_via").map((element) => ({
    x: normalizedNumber(element.x), y: normalizedNumber(element.y),
    holeDiameter: element.hole_diameter, outerDiameter: element.outer_diameter,
    fromLayer: element.from_layer, toLayer: element.to_layer, layers: element.layers,
  })).sort((a, b) => Number(a.x) - Number(b.x) || Number(a.y) - Number(b.y));
  const platedHoles = elements.filter((element) => element.type === "pcb_plated_hole").map((element) => ({
    component: pcbNames.get(String(element.pcb_component_id)), x: normalizedNumber(element.x),
    y: normalizedNumber(element.y), layers: element.layers, holeDiameter: element.hole_diameter,
    outerDiameter: element.outer_diameter,
  })).sort((a, b) => String(a.component).localeCompare(String(b.component)) || Number(a.x) - Number(b.x));
  const copper = elements.filter((element) => element.type === "pcb_trace").flatMap((element) =>
    ((element.route as Record<string, unknown>[] | undefined) ?? []).filter((point) => point.route_type === "wire").map((point) => ({
      layer: point.layer, x: normalizedNumber(point.x), y: normalizedNumber(point.y), width: point.width,
    }))).sort((a, b) => String(a.layer).localeCompare(String(b.layer)) || Number(a.x) - Number(b.x) || Number(a.y) - Number(b.y));
  return { board: board === undefined ? null : { center: board.center, width: board.width, height: board.height, thickness: board.thickness, material: board.material, layerCount: board.num_layers }, components, connections, vias, platedHoles, copper };
}

export function canonicalSemanticSha256(circuitJson: readonly AnyCircuitElement[]): string {
  return sha256(JSON.stringify(canonicalSemanticProjection(circuitJson)));
}

export async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, relative);
      else if (entry.isFile() && (await stat(path)).isFile()) files.push(relative);
      else throw new Error(`Canonical fixture contains non-regular entry ${relative}`);
    }
  };
  await walk(root, "");
  return files.sort();
}

export async function manifestFileRecord(root: string, path: string): Promise<{ path: string; size: number; sha256: string }> {
  const bytes = new Uint8Array(await Bun.file(join(root, ...path.split("/"))).arrayBuffer());
  return { path, size: bytes.byteLength, sha256: sha256(bytes) };
}

export function manufacturingSetSha256(files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[]): string {
  return sha256([...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}\0${file.size}\0${file.sha256}\0`).join(""));
}

export async function canonicalInputRecords(root: string): Promise<readonly { path: string; size: number; sha256: string }[]> {
  const sourcePaths = (await listRegularFiles(join(root, "circuit"))).map((path) => `circuit/${path}`);
  const paths = ["expectation.json", "fulmetry.config.ts", "fulmetry.lock", ...sourcePaths].sort();
  return Promise.all(paths.map((path) => manifestFileRecord(root, path)));
}

/** Validate every manifest field against files, source inputs, locks, and engine identity. */
export async function validateCanonicalManifest(options: {
  readonly name: CanonicalFixtureName;
  readonly root: string;
  readonly manifest: CanonicalManifest;
  readonly circuitJson: readonly AnyCircuitElement[];
  readonly expectedEngine?: Readonly<{ version: string; contentSha256: string }>;
}): Promise<void> {
  const { name, root, manifest, circuitJson } = options;
  const failures: string[] = [];
  const requireEqual = (label: string, actual: unknown, expected: unknown): void => {
    if (!sameJson(actual, expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  requireEqual("schemaVersion", manifest.schemaVersion, 1);
  requireEqual("fixtureName", manifest.fixtureName, name);
  const lock = JSON.parse(await readFile(join(root, "fulmetry.lock"), "utf8")) as {
    tscircuit: { version: string; integrity: string }; adapters: Record<string, string>;
  };
  requireEqual("tscircuit.version", manifest.tscircuit.version, lock.tscircuit.version);
  requireEqual("tscircuit.integrity", manifest.tscircuit.integrity, lock.tscircuit.integrity);
  const identity = await requireTscircuitIdentity({
    projectRoot: root,
    ...(options.expectedEngine === undefined ? {} : {
      expectedVersion: options.expectedEngine.version,
      expectedContentSha256: options.expectedEngine.contentSha256,
    }),
  });
  requireEqual("tscircuit.contentSha256", manifest.tscircuit.contentSha256, identity.project?.contentSha256);
  requireEqual("adapters", manifest.adapters, lock.adapters);

  requireEqual("circuit.path", manifest.circuit.path, "circuit.json");
  requireEqual("circuit record", manifest.circuit, {
    ...(await manifestFileRecord(root, "circuit.json")),
    semanticSha256: canonicalSemanticSha256(circuitJson),
  });
  const inputs = await canonicalInputRecords(root);
  requireEqual("inputs.fileCount", manifest.inputs.fileCount, inputs.length);
  requireEqual("inputs.files", manifest.inputs.files, inputs);
  requireEqual("inputs.setSha256", manifest.inputs.setSha256, manufacturingSetSha256(inputs));

  requireEqual("manufacturing.directory", manifest.manufacturing.directory, "manufacturing");
  const manufacturingRoot = join(root, manifest.manufacturing.directory);
  const paths = await listRegularFiles(manufacturingRoot);
  const records = await Promise.all(paths.map((path) => manifestFileRecord(manufacturingRoot, path)));
  requireEqual("manufacturing.fileCount", manifest.manufacturing.fileCount, records.length);
  requireEqual("manufacturing.files", manifest.manufacturing.files, records);
  requireEqual("manufacturing.setSha256", manifest.manufacturing.setSha256, manufacturingSetSha256(records));
  if (failures.length > 0) throw new Error(`Canonical manifest mismatch:\n${failures.join("\n")}`);
}
