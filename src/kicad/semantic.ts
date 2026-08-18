// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "circuit-json";
import { parseKicadPcb, parseKicadSch, type Footprint, type FootprintPad } from "kicadts";

const TOLERANCE_MM = 0.000_01;
const SEMANTIC_COLLECTION_LIMIT = 8_000;

interface Point { readonly x: number; readonly y: number }
interface ExpectedSegment extends Point {
  readonly endX: number;
  readonly endY: number;
  readonly width: number;
  readonly layer: string;
  readonly net: string;
}
interface ExpectedVia extends Point {
  readonly size: number;
  readonly drill: number;
  readonly fromLayer: string;
  readonly toLayer: string;
  readonly net: string;
}
interface ExpectedPad extends Point {
  readonly kind: "smd" | "plated" | "non-plated";
  readonly width: number;
  readonly height: number;
  readonly drillShape: "none" | "circle" | "oval";
  readonly drillWidth: number;
  readonly drillHeight: number;
  readonly copperLayers: readonly string[];
  readonly net: string;
}

export interface KicadSemanticReconciliationPassed {
  readonly schemaVersion: 1;
  readonly state: "passed";
  readonly toleranceMm: number;
  readonly layerCount: 2 | 4;
  readonly copperLayers: readonly string[];
  readonly board: Readonly<{
    widthMm: number;
    heightMm: number;
    sourceCenter: Point;
    kicadCenter: Point;
  }>;
  readonly counts: Readonly<{
    components: number;
    schematicSymbols: number;
    nets: number;
    traces: number;
    vias: number;
    platedHoles: number;
    nonPlatedHoles: number;
  }>;
  readonly componentReferences: readonly string[];
  readonly componentValues: readonly string[];
  readonly schematicLibraryIds: readonly string[];
  readonly footprintLibraryLinks: readonly string[];
  readonly netNames: readonly string[];
  readonly schematicNetNames: readonly string[];
  readonly traceLayers: readonly string[];
  readonly sha256: string;
}

export interface KicadSemanticReconciliationFailed {
  readonly schemaVersion: 1;
  readonly state: "failed";
  readonly toleranceMm: number;
  readonly message: string;
  readonly sha256: string;
}

export type KicadSemanticReconciliation =
  | KicadSemanticReconciliationPassed
  | KicadSemanticReconciliationFailed;

function fail(message: string): never {
  throw new TypeError(`KICAD_SEMANTIC_RECONCILIATION_FAILED: ${message}`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is not finite`);
  return value;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= TOLERANCE_MM;
}

function layerName(value: string): string {
  if (value === "top") return "F.Cu";
  if (value === "bottom") return "B.Cu";
  const inner = /^inner(\d+)$/u.exec(value);
  if (inner !== null) return `In${inner[1]}.Cu`;
  fail(`unsupported Circuit JSON copper layer ${value}`);
}

function bounded<T>(items: readonly T[], label: string): readonly T[] {
  if (items.length > SEMANTIC_COLLECTION_LIMIT) fail(`${label} exceeds ${SEMANTIC_COLLECTION_LIMIT} entries`);
  return items;
}

function property(footprint: Footprint, key: string): string | undefined {
  const matches = footprint.properties.filter((candidate) => candidate.key === key);
  if (matches.length > 1) fail(`footprint has duplicate ${key} properties`);
  return matches[0]?.value;
}

function padCenter(footprint: Footprint, pad: FootprintPad): Point {
  const origin = footprint.position;
  const local = pad.at;
  if (origin === undefined || local === undefined) fail("footprint or pad is missing a position");
  const angle = (("angle" in origin ? origin.angle : undefined) ?? 0) * Math.PI / 180;
  return Object.freeze({
    x: origin.x + Math.cos(angle) * local.x + Math.sin(angle) * local.y,
    y: origin.y - Math.sin(angle) * local.x + Math.cos(angle) * local.y,
  });
}

function samePoint(actual: Point, expected: Point): boolean {
  return close(actual.x, expected.x) && close(actual.y, expected.y);
}

function consumeMultiset<A, E>(
  actual: readonly A[],
  expected: readonly E[],
  matches: (actual: A, expected: E) => boolean,
  label: string,
): void {
  if (actual.length !== expected.length) fail(`${label} count ${actual.length} does not equal source count ${expected.length}`);
  const remaining = [...actual];
  for (const wanted of expected) {
    const index = remaining.findIndex((candidate) => matches(candidate, wanted));
    if (index < 0) fail(`${label} does not preserve a source object: ${JSON.stringify(wanted)}`);
    remaining.splice(index, 1);
  }
  if (remaining.length !== 0) fail(`${label} contains unexpected objects`);
}

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) fail("semantic summary contains a non-finite number");
      return Object.is(input, -0) ? 0 : input;
    }
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input !== "object") fail("semantic summary contains a non-JSON value");
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]));
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function valueCandidates(element: Record<string, unknown>): readonly string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(element)) {
    if ((key === "value" || key.startsWith("display_")) && typeof value === "string" && value !== "") values.push(value);
  }
  return sortedUnique(values);
}

function expectedComponentValues(
  source: Record<string, unknown>,
  schematicComponent: Record<string, unknown> | undefined,
  footprinter: string,
): Readonly<{ schematic: string; footprint: string }> {
  if (
    ((footprinter === "" &&
      (source.ftype === "simple_chip" || source.ftype === "simple_switch")) ||
      source.ftype === "simple_led") &&
    typeof source.manufacturer_part_number === "string" &&
    source.manufacturer_part_number !== ""
  ) return Object.freeze({ schematic: source.manufacturer_part_number, footprint: source.manufacturer_part_number });
  if (
    footprinter === "" && source.ftype === "simple_connector" &&
    typeof source.manufacturer_part_number === "string" && source.manufacturer_part_number !== ""
  ) return Object.freeze({ schematic: source.manufacturer_part_number, footprint: String(source.name) });
  if (typeof schematicComponent?.symbol_display_value === "string") {
    return Object.freeze({
      schematic: schematicComponent.symbol_display_value,
      footprint: schematicComponent.symbol_display_value,
    });
  }
  const candidates = valueCandidates(source);
  if (candidates.length === 1) return Object.freeze({ schematic: candidates[0]!, footprint: candidates[0]! });
  if (
    source.ftype === "simple_led" && typeof source.manufacturer_part_number === "string" &&
    source.manufacturer_part_number !== ""
  ) return Object.freeze({ schematic: source.manufacturer_part_number, footprint: source.manufacturer_part_number });
  if (source.ftype === "simple_led") return Object.freeze({ schematic: "", footprint: "LED" });
  if (source.ftype === "simple_diode") return Object.freeze({ schematic: "D", footprint: "D" });
  if (source.ftype === "simple_pin_header") {
    const reference = String(source.name);
    return Object.freeze({ schematic: reference, footprint: reference });
  }
  if (
    (source.ftype === "simple_connector" || source.ftype === "simple_chip" ||
      source.ftype === "simple_switch") &&
    typeof source.manufacturer_part_number === "string" &&
    source.manufacturer_part_number !== ""
  ) {
    return Object.freeze({
      schematic: source.manufacturer_part_number,
      footprint: source.ftype === "simple_connector"
        ? String(source.name)
        : source.manufacturer_part_number,
    });
  }
  fail(`component ${String(source.name)} lacks one authoritative KiCad value`);
}

function expectedFootprintLibraryId(source: Record<string, unknown>, footprinter: string): string {
  const partNumber = source.manufacturer_part_number;
  if (typeof partNumber === "string" && /^[\x21-\x7e]{1,160}$/u.test(partNumber)) {
    return `tscircuit:${partNumber}`;
  }
  if (footprinter === "") {
    fail(`component ${String(source.name)} lacks an authoritative footprint or manufacturer part identity`);
  }
  if (source.ftype === "simple_resistor") return `tscircuit:resistor_${footprinter}`;
  if (source.ftype === "simple_led") return `tscircuit:led_${footprinter}`;
  if (source.ftype === "simple_pin_header") return `tscircuit:pin_header_${footprinter}`;
  return `tscircuit:${footprinter}`;
}

function expectedSchematicLibraryId(
  source: Record<string, unknown>,
  schematicComponent: Record<string, unknown> | undefined,
): string {
  if (typeof schematicComponent?.symbol_name === "string" && schematicComponent.symbol_name !== "") {
    return `Device:${schematicComponent.symbol_name}`;
  }
  const partNumber = source.manufacturer_part_number;
  if (typeof partNumber === "string" && /^[\x21-\x7e]{1,160}$/u.test(partNumber)) {
    if (source.ftype === "simple_connector") return `Device:J_${partNumber}`;
    if (source.ftype === "simple_chip") return `Device:U_${partNumber}`;
  }
  if (source.ftype === "simple_pin_header" && Number.isSafeInteger(source.pin_count) && Number(source.pin_count) > 0) {
    return `Connector_Generic:Conn_01x${String(source.pin_count)}`;
  }
  fail(`component ${String(source.name)} has no qualified KiCad schematic symbol identity mapping`);
}

/**
 * Independently parses the emitted KiCad board and schematic and reconciles
 * their physical/electrical meaning with the exact Circuit JSON input.
 */
export function reconcileKicadHandoffSemantics(
  circuitJson: readonly AnyCircuitElement[],
  files: readonly { readonly path: string; readonly content: string }[],
): Readonly<KicadSemanticReconciliationPassed> {
  bounded(circuitJson, "Circuit JSON");
  const pcbFiles = files.filter(({ path }) => path.endsWith(".kicad_pcb"));
  const schFiles = files.filter(({ path }) => path.endsWith(".kicad_sch"));
  if (pcbFiles.length !== 1 || schFiles.length !== 1) fail("handoff must contain exactly one board and schematic");
  const pcb = parseKicadPcb(pcbFiles[0]!.content);
  const schematic = parseKicadSch(schFiles[0]!.content);

  const boards = circuitJson.filter((element) => element.type === "pcb_board") as Array<AnyCircuitElement & Record<string, unknown>>;
  if (boards.length !== 1) fail("source must contain exactly one PCB board");
  const board = boards[0]!;
  const layerCount = board.num_layers;
  if (layerCount !== 2 && layerCount !== 4) fail(`unsupported layer count ${String(layerCount)}`);
  const sourceCenterValue = board.center as { x?: unknown; y?: unknown } | undefined;
  if (sourceCenterValue === undefined) fail("source board center is missing");
  const sourceCenter = Object.freeze({
    x: finite(sourceCenterValue.x, "board center x"),
    y: finite(sourceCenterValue.y, "board center y"),
  });
  const width = finite(board.width, "board width");
  const height = finite(board.height, "board height");
  const expectedCopperLayers = Object.freeze(layerCount === 2
    ? ["F.Cu", "B.Cu"]
    : ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
  const actualCopperLayers = pcb.layers?.definitions
    .filter(({ name }) => name?.endsWith(".Cu"))
    .map(({ name }) => name!);
  if (JSON.stringify(actualCopperLayers) !== JSON.stringify(expectedCopperLayers)) {
    fail(`copper layer order ${JSON.stringify(actualCopperLayers)} does not equal ${JSON.stringify(expectedCopperLayers)}`);
  }

  const edgeLines = pcb.graphicLines.filter(({ layer }) => layer?.names.length === 1 && layer.names[0] === "Edge.Cuts");
  if (edgeLines.length !== 4 || edgeLines.some(({ startPoint, endPoint }) => startPoint === undefined || endPoint === undefined)) {
    fail("rectangular source board did not produce exactly four Edge.Cuts lines");
  }
  const edgePoints = edgeLines.flatMap(({ startPoint, endPoint }) => [startPoint!, endPoint!]);
  if (edgeLines.some(({ startPoint, endPoint }) =>
    !close(startPoint!.x, endPoint!.x) && !close(startPoint!.y, endPoint!.y))) {
    fail("rectangular Edge.Cuts contains a diagonal edge");
  }
  const endpointKey = ({ x, y }: Point) => `${Math.round(x / TOLERANCE_MM)}:${Math.round(y / TOLERANCE_MM)}`;
  const endpointDegrees = new Map<string, number>();
  const undirectedEdges = new Set<string>();
  for (const { startPoint, endPoint } of edgeLines) {
    const start = endpointKey(startPoint!);
    const end = endpointKey(endPoint!);
    if (start === end) fail("rectangular Edge.Cuts contains a zero-length edge");
    endpointDegrees.set(start, (endpointDegrees.get(start) ?? 0) + 1);
    endpointDegrees.set(end, (endpointDegrees.get(end) ?? 0) + 1);
    const edge = [start, end].sort().join("|");
    if (undirectedEdges.has(edge)) fail("rectangular Edge.Cuts contains a duplicate edge");
    undirectedEdges.add(edge);
  }
  if (endpointDegrees.size !== 4 || [...endpointDegrees.values()].some((degree) => degree !== 2)) {
    fail("rectangular Edge.Cuts is not one closed four-corner loop");
  }
  const minX = Math.min(...edgePoints.map(({ x }) => x));
  const maxX = Math.max(...edgePoints.map(({ x }) => x));
  const minY = Math.min(...edgePoints.map(({ y }) => y));
  const maxY = Math.max(...edgePoints.map(({ y }) => y));
  if (!close(maxX - minX, width) || !close(maxY - minY, height)) fail("KiCad outline dimensions differ from the source board");
  const kicadCenter = Object.freeze({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  const toKicad = (point: Point): Point => Object.freeze({
    x: kicadCenter.x + (point.x - sourceCenter.x),
    y: kicadCenter.y - (point.y - sourceCenter.y),
  });

  const sourceComponents = circuitJson.filter((element) => element.type === "source_component") as Array<AnyCircuitElement & Record<string, unknown>>;
  const pcbComponents = circuitJson.filter((element) => element.type === "pcb_component") as Array<AnyCircuitElement & Record<string, unknown>>;
  const schematicComponents = circuitJson.filter((element) => element.type === "schematic_component") as Array<AnyCircuitElement & Record<string, unknown>>;
  const cadComponents = circuitJson.filter((element) => element.type === "cad_component") as Array<AnyCircuitElement & Record<string, unknown>>;
  if (sourceComponents.length !== pcbComponents.length) fail("source and PCB component counts differ");
  const sourceById = new Map(sourceComponents.map((component) => [String(component.source_component_id), component]));
  const expectedReferences = sourceComponents.map((component) => String(component.name)).sort();
  if (expectedReferences.some((reference) => reference === "" || reference === "undefined")) fail("source component reference is missing");

  const physicalFootprints = pcb.footprints.filter((footprint) => property(footprint, "Reference") !== undefined);
  const footprintReferences = physicalFootprints.map((footprint) => property(footprint, "Reference")!).sort();
  if (JSON.stringify(footprintReferences) !== JSON.stringify(expectedReferences)) fail("KiCad footprint references differ from source components");
  const schematicByReference = new Map<string, typeof schematic.symbols[number]>();
  for (const symbol of schematic.symbols) {
    const referenceProperties = symbol.properties.filter(({ key }) => key === "Reference");
    if (referenceProperties.length !== 1) continue;
    const reference = referenceProperties[0]!.value;
    if (!expectedReferences.includes(reference)) continue;
    if (schematicByReference.has(reference)) fail(`schematic reference ${reference} is duplicated`);
    schematicByReference.set(reference, symbol);
  }
  if (schematicByReference.size !== sourceComponents.length) fail("schematic symbols do not cover every source component exactly once");

  const actualValues: string[] = [];
  const schematicLibraryIds: string[] = [];
  const footprintLibraryLinks: string[] = [];
  for (const pcbComponent of pcbComponents) {
    const source = sourceById.get(String(pcbComponent.source_component_id));
    if (source === undefined) fail("PCB component references a missing source component");
    const reference = String(source.name);
    const matches = physicalFootprints.filter((footprint) => property(footprint, "Reference") === reference);
    if (matches.length !== 1) fail(`component ${reference} does not have exactly one KiCad footprint`);
    const footprint = matches[0]!;
    const cadComponent = cadComponents.find((component) => component.source_component_id === source.source_component_id);
    const expectedFootprinter = String(cadComponent?.footprinter_string ?? "");
    if (footprint.libraryLink !== expectedFootprintLibraryId(source, expectedFootprinter)) {
      fail(`component ${reference} footprint library identity differs from source`);
    }
    footprintLibraryLinks.push(footprint.libraryLink);
    const sourcePosition = pcbComponent.center as { x?: unknown; y?: unknown } | undefined;
    if (sourcePosition === undefined || footprint.position === undefined ||
      !samePoint(footprint.position, toKicad({
        x: finite(sourcePosition.x, `${reference} x`),
        y: finite(sourcePosition.y, `${reference} y`),
      }))) fail(`component ${reference} position differs from source`);
    const footprintAngle = "angle" in footprint.position ? footprint.position.angle ?? 0 : 0;
    if (!close(footprintAngle, finite(pcbComponent.rotation, `${reference} rotation`))) {
      fail(`component ${reference} rotation differs from source`);
    }
    const expectedSide = String(pcbComponent.layer);
    const padCopper = sortedUnique(footprint.fpPads.flatMap((pad) => pad.layers?.layers.filter((layer) => layer.endsWith(".Cu") || layer === "*.Cu") ?? []));
    if (expectedSide === "top" && padCopper.some((layer) => layer === "B.Cu") && !padCopper.includes("*.Cu")) fail(`component ${reference} moved from top to bottom`);
    if (expectedSide === "bottom" && (!padCopper.includes("B.Cu") || padCopper.includes("F.Cu"))) fail(`component ${reference} moved from bottom to top`);
    const symbol = schematicByReference.get(reference)!;
    const schematicComponent = schematicComponents.find((component) => component.source_component_id === source.source_component_id);
    if (symbol.libraryId !== expectedSchematicLibraryId(source, schematicComponent)) {
      fail(`component ${reference} schematic symbol identity differs from source`);
    }
    schematicLibraryIds.push(symbol.libraryId);
    const symbolValues = symbol.properties.filter(({ key }) => key === "Value").map(({ value }) => value);
    const footprintValues = footprint.properties.filter(({ key }) => key === "Value").map(({ value }) => value);
    const expectedValues = expectedComponentValues(source, schematicComponent, expectedFootprinter);
    if (symbolValues.length !== 1 || footprintValues.length !== 1 ||
      symbolValues[0] !== expectedValues.schematic || footprintValues[0] !== expectedValues.footprint) {
      fail(`component ${reference} value was not preserved in schematic and footprint`);
    }
    actualValues.push(...sortedUnique([...symbolValues, ...footprintValues].filter((value) => value !== "")));
  }

  const sourceNets = circuitJson.filter((element) => element.type === "source_net") as Array<AnyCircuitElement & Record<string, unknown>>;
  const sourceTraces = circuitJson.filter((element) => element.type === "source_trace") as Array<AnyCircuitElement & Record<string, unknown>>;
  const sourcePorts = circuitJson.filter((element) => element.type === "source_port") as Array<AnyCircuitElement & Record<string, unknown>>;
  const pcbPorts = circuitJson.filter((element) => element.type === "pcb_port") as Array<AnyCircuitElement & Record<string, unknown>>;
  const netNameByConnectivity = new Map<string, string>();
  for (const sourceNet of sourceNets) {
    const key = String(sourceNet.subcircuit_connectivity_map_key ?? "");
    const name = String(sourceNet.name ?? "");
    if (key === "" || name === "") fail("source net lacks connectivity identity or name");
    netNameByConnectivity.set(key, name);
  }
  for (const sourceTrace of sourceTraces) {
    const key = String(sourceTrace.subcircuit_connectivity_map_key ?? "");
    if (key === "" || netNameByConnectivity.has(key)) continue;
    const name = String(sourceTrace.display_name ?? sourceTrace.name ?? "");
    if (name === "") fail("source trace lacks a net name");
    netNameByConnectivity.set(key, name);
  }
  const sourceTraceById = new Map(sourceTraces.map((trace) => [String(trace.source_trace_id), trace]));
  const sourceNetById = new Map(sourceNets.map((net) => [String(net.source_net_id), net]));
  const sourcePortById = new Map(sourcePorts.map((port) => [String(port.source_port_id), port]));
  const padNetName = (pcbPortId: unknown): string => {
    const pcbPort = pcbPorts.find((port) => port.pcb_port_id === pcbPortId);
    const sourcePort = pcbPort === undefined ? undefined : sourcePortById.get(String(pcbPort.source_port_id));
    return sourcePort === undefined
      ? ""
      : netNameByConnectivity.get(String(sourcePort.subcircuit_connectivity_map_key ?? "")) ?? "";
  };
  const traceNetName = (trace: Record<string, unknown>): string => {
    const sourceIdentity = String(trace.source_trace_id ?? "");
    const sourceTrace = sourceTraceById.get(sourceIdentity);
    const directNet = sourceNetById.get(sourceIdentity);
    const key = String(sourceTrace?.subcircuit_connectivity_map_key ?? directNet?.subcircuit_connectivity_map_key ?? "");
    const name = netNameByConnectivity.get(key);
    if (name === undefined) fail(`PCB trace ${String(trace.pcb_trace_id)} lacks authoritative net provenance`);
    return name;
  };
  const expectedNetNames = sortedUnique([...netNameByConnectivity.values()]);
  const actualNets = pcb.nets.filter(({ id }) => id !== 0);
  const actualNetNames = actualNets.map(({ name }) => name).sort();
  if (JSON.stringify(actualNetNames) !== JSON.stringify([...expectedNetNames])) fail("KiCad net names differ from source connectivity");
  const expectedSchematicNetNames = sortedUnique([
    ...sourceNets.map((net) => String(net.name ?? "")).filter(Boolean),
    ...sourceTraces
      .filter((trace) => !Array.isArray(trace.connected_source_net_ids) || trace.connected_source_net_ids.length === 0)
      .map((trace) => String(trace.name ?? ""))
      .filter(Boolean),
  ]);
  const actualSchematicNetNames = sortedUnique([
    ...schematic.globalLabels.map(({ value }) => value),
    ...schematic.symbols.flatMap((symbol) => {
      const reference = symbol.properties.find(({ key }) => key === "Reference")?.value;
      const value = symbol.properties.find(({ key }) => key === "Value")?.value;
      return reference !== undefined && reference === value ? [reference] : [];
    }),
  ]);
  for (const name of expectedSchematicNetNames) {
    if (!actualSchematicNetNames.includes(name)) fail(`KiCad schematic omitted authored net label ${name}`);
  }
  const actualNetNameById = new Map(pcb.nets.map(({ id, name }) => [id, name]));

  let schematicTranslation: Point | undefined;
  for (const schematicComponent of schematicComponents) {
    const source = sourceById.get(String(schematicComponent.source_component_id));
    const reference = String(source?.name ?? "");
    const symbol = schematicByReference.get(reference);
    const center = schematicComponent.center as { x?: unknown; y?: unknown } | undefined;
    if (source === undefined || symbol?.at === undefined || center === undefined) {
      fail(`component ${reference || "<unknown>"} lacks schematic coordinate authority`);
    }
    const candidate = Object.freeze({
      x: symbol.at.x - finite(center.x, `${reference} schematic x`) * 15,
      y: symbol.at.y + finite(center.y, `${reference} schematic y`) * 15,
    });
    if (schematicTranslation === undefined) schematicTranslation = candidate;
    else if (!samePoint(candidate, schematicTranslation)) fail("KiCad schematic components do not share the source coordinate transform");
  }
  if (schematicTranslation === undefined) fail("source contains no schematic coordinate authority");
  const toKicadSchematic = (point: Point): Point => Object.freeze({
    x: schematicTranslation!.x + point.x * 15,
    y: schematicTranslation!.y - point.y * 15,
  });

  const expectedSchematicWireSegments = (circuitJson.filter((element) => element.type === "schematic_trace") as Array<AnyCircuitElement & Record<string, unknown>>)
    .flatMap((trace) => {
      const edges = trace.edges;
      if (!Array.isArray(edges)) fail("schematic trace edges are missing");
      return edges.map((edgeValue) => {
        if (typeof edgeValue !== "object" || edgeValue === null || Array.isArray(edgeValue)) fail("schematic trace edge is invalid");
        const edge = edgeValue as Record<string, unknown>;
        const from = edge.from as Record<string, unknown> | undefined;
        const to = edge.to as Record<string, unknown> | undefined;
        if (from === undefined || to === undefined) fail("schematic trace edge endpoint is missing");
        const start = toKicadSchematic({
          x: finite(from.x, "schematic edge x"),
          y: finite(from.y, "schematic edge y"),
        });
        const end = toKicadSchematic({
          x: finite(to.x, "schematic edge x"),
          y: finite(to.y, "schematic edge y"),
        });
        return Object.freeze({
          ...start,
          endX: end.x,
          endY: end.y,
        });
      });
    });
  const actualSchematicWireSegments = schematic.wires.flatMap((wire) => {
    const points = wire.points?.points;
    if (points === undefined || points.length !== 2 || points.some((point) => !("x" in point) || !("y" in point))) {
      fail("KiCad schematic wire is not one straight segment");
    }
    const start = points[0]!;
    const end = points[1]!;
    if (!("x" in start) || !("y" in start) || !("x" in end) || !("y" in end)) {
      fail("KiCad schematic wire contains an arc point");
    }
    return [{ x: start.x, y: start.y, endX: end.x, endY: end.y }];
  });
  consumeMultiset(actualSchematicWireSegments, expectedSchematicWireSegments, (actual, expected) => {
    const forward = samePoint(actual, expected) && close(actual.endX, expected.endX) && close(actual.endY, expected.endY);
    const reverse = close(actual.x, expected.endX) && close(actual.y, expected.endY) && close(actual.endX, expected.x) && close(actual.endY, expected.y);
    return forward || reverse;
  }, "KiCad schematic wires");

  const expectedSegments: ExpectedSegment[] = [];
  const pcbTraces = circuitJson.filter((element) => element.type === "pcb_trace") as Array<AnyCircuitElement & Record<string, unknown>>;
  for (const trace of pcbTraces) {
    const net = traceNetName(trace);
    const route = trace.route;
    if (!Array.isArray(route)) fail(`PCB trace ${String(trace.pcb_trace_id)} route is missing`);
    let previous: Record<string, unknown> | undefined;
    for (const pointValue of route) {
      if (typeof pointValue !== "object" || pointValue === null || Array.isArray(pointValue)) fail("PCB trace route point is invalid");
      const point = pointValue as Record<string, unknown>;
      if (point.route_type !== "wire") { previous = undefined; continue; }
      if (previous !== undefined && previous.layer === point.layer) {
        const startSource = { x: finite(previous.x, "trace x"), y: finite(previous.y, "trace y") };
        const endSource = { x: finite(point.x, "trace x"), y: finite(point.y, "trace y") };
        if (!samePoint(startSource, endSource)) {
          const start = toKicad(startSource);
          const end = toKicad(endSource);
          expectedSegments.push(Object.freeze({
            ...start,
            endX: end.x,
            endY: end.y,
            width: finite(point.width ?? previous.width, "trace width"),
            layer: layerName(String(point.layer)),
            net,
          }));
        }
      }
      previous = point;
    }
  }
  bounded(expectedSegments, "expected KiCad trace segments");
  const actualSegments = pcb.segments.map((segment) => {
    if (segment.startPoint === undefined || segment.endPoint === undefined || segment.width === undefined || segment.layer?.names.length !== 1 || segment.net?.id === undefined) {
      fail("KiCad segment is missing geometry, layer, width, or net identity");
    }
    return Object.freeze({
      x: segment.startPoint.x,
      y: segment.startPoint.y,
      endX: segment.endPoint.x,
      endY: segment.endPoint.y,
      width: segment.width,
      layer: segment.layer.names[0]!,
      net: actualNetNameById.get(segment.net.id) ?? "",
    });
  });
  consumeMultiset(actualSegments, expectedSegments, (actual, expected) => {
    const forward = samePoint(actual, expected) && close(actual.endX, expected.endX) && close(actual.endY, expected.endY);
    const reverse = close(actual.x, expected.endX) && close(actual.y, expected.endY) && close(actual.endX, expected.x) && close(actual.endY, expected.y);
    return (forward || reverse) && close(actual.width, expected.width) && actual.layer === expected.layer && actual.net === expected.net;
  }, "KiCad trace segments");

  const expectedVias: ExpectedVia[] = (circuitJson.filter((element) => element.type === "pcb_via") as Array<AnyCircuitElement & Record<string, unknown>>).map((via) => {
    const owner = pcbTraces.find((trace) => trace.pcb_trace_id === via.pcb_trace_id);
    if (owner === undefined) fail(`via ${String(via.pcb_via_id)} lacks an owning PCB trace`);
    const point = toKicad({ x: finite(via.x, "via x"), y: finite(via.y, "via y") });
    return Object.freeze({
      ...point,
      size: finite(via.outer_diameter, "via size"),
      drill: finite(via.hole_diameter, "via drill"),
      fromLayer: layerName(String(via.from_layer)),
      toLayer: layerName(String(via.to_layer)),
      net: traceNetName(owner),
    });
  });
  const actualVias = pcb.vias.map((via) => {
    if (via.at === undefined || via.size === undefined || via.drill === undefined || via.layers?.names.length !== 2 || via.net?.id === undefined) {
      fail("KiCad via is missing geometry, drill, layer span, or net identity");
    }
    return Object.freeze({
      x: via.at.x,
      y: via.at.y,
      size: via.size,
      drill: via.drill,
      fromLayer: via.layers.names[0]!,
      toLayer: via.layers.names[1]!,
      net: actualNetNameById.get(via.net.id) ?? "",
    });
  });
  consumeMultiset(actualVias, expectedVias, (actual, expected) => samePoint(actual, expected) &&
    close(actual.size, expected.size) && close(actual.drill, expected.drill) &&
    actual.fromLayer === expected.fromLayer && actual.toLayer === expected.toLayer && actual.net === expected.net,
  "KiCad vias");

  const allPads = pcb.footprints.flatMap((footprint) => footprint.fpPads.map((pad) => ({ footprint, pad })));
  const expectedPads: ExpectedPad[] = [];
  for (const element of circuitJson as readonly (AnyCircuitElement & Record<string, unknown>)[]) {
    if (element.type !== "pcb_smtpad" && element.type !== "pcb_plated_hole" && element.type !== "pcb_hole") continue;
    const point = toKicad({ x: finite(element.x, `${element.type} x`), y: finite(element.y, `${element.type} y`) });
    if (element.type === "pcb_smtpad") {
      const net = padNetName(element.pcb_port_id);
      const width = element.shape === "circle"
        ? finite(element.radius, "SMT pad radius") * 2
        : finite(element.width, "SMT pad width");
      const height = element.shape === "circle"
        ? width
        : finite(element.height, "SMT pad height");
      expectedPads.push(Object.freeze({ ...point, kind: "smd", width, height, drillShape: "none", drillWidth: 0, drillHeight: 0, copperLayers: Object.freeze([layerName(String(element.layer))]), net }));
    } else if (element.type === "pcb_plated_hole") {
      const net = padNetName(element.pcb_port_id);
      const declaredLayers = Array.isArray(element.layers) ? element.layers.map(String).map(layerName) : [];
      if (declaredLayers.length !== expectedCopperLayers.length ||
        sortedUnique(declaredLayers).join("\0") !== sortedUnique(expectedCopperLayers).join("\0")) {
        fail("baseline plated holes must explicitly span every copper layer");
      }
      if (element.shape === "circle") {
        const drill = finite(element.hole_diameter, "plated drill");
        const diameter = finite(element.outer_diameter, "plated pad width");
        expectedPads.push(Object.freeze({ ...point, kind: "plated", width: diameter, height: diameter, drillShape: "circle", drillWidth: drill, drillHeight: drill, copperLayers: expectedCopperLayers, net }));
      } else if (
        element.shape === "pill_hole_with_rect_pad" ||
        element.shape === "rotated_pill_hole_with_rect_pad"
      ) {
        expectedPads.push(Object.freeze({
          ...point,
          kind: "plated",
          width: finite(element.rect_pad_width, "plated slot pad width"),
          height: finite(element.rect_pad_height, "plated slot pad height"),
          drillShape: "oval",
          drillWidth: finite(element.hole_width, "plated slot drill width"),
          drillHeight: finite(element.hole_height, "plated slot drill height"),
          copperLayers: expectedCopperLayers,
          net,
        }));
      } else fail(`unsupported KiCad plated-hole shape ${String(element.shape)}`);
    } else {
      const drill = finite(element.hole_diameter, "hole drill");
      expectedPads.push(Object.freeze({ ...point, kind: "non-plated", width: drill, height: drill, drillShape: "circle", drillWidth: drill, drillHeight: drill, copperLayers: Object.freeze([]), net: "" }));
    }
  }
  const actualPads: ExpectedPad[] = allPads.map(({ footprint, pad }) => {
    if (pad.size === undefined || pad.layers === undefined) fail("KiCad pad is missing size or layers");
    const center = padCenter(footprint, pad);
    const layers = pad.layers.layers;
    const kind = pad.padType === "smd" ? "smd" : pad.padType === "thru_hole" ? "plated" : pad.padType === "np_thru_hole" ? "non-plated" : fail(`unsupported KiCad pad type ${pad.padType}`);
    const copperLayers = kind === "non-plated"
      ? Object.freeze([])
      : kind === "plated" && layers.includes("*.Cu")
        ? expectedCopperLayers
        : sortedUnique(layers.filter((layer) => layer.endsWith(".Cu")));
    return Object.freeze({
      ...center,
      kind,
      width: pad.size.width,
      height: pad.size.height,
      drillShape: pad.drill === undefined ? "none" : pad.drill.oval ? "oval" : "circle",
      drillWidth: pad.drill?.diameter ?? 0,
      drillHeight: pad.drill?.width ?? pad.drill?.diameter ?? 0,
      copperLayers,
      net: pad.net?.id === undefined ? "" : actualNetNameById.get(pad.net.id) ?? "",
    });
  });
  consumeMultiset(actualPads, expectedPads, (actual, expected) => samePoint(actual, expected) && actual.kind === expected.kind &&
    close(actual.width, expected.width) && close(actual.height, expected.height) &&
    actual.drillShape === expected.drillShape && close(actual.drillWidth, expected.drillWidth) &&
    close(actual.drillHeight, expected.drillHeight) &&
    JSON.stringify(actual.copperLayers) === JSON.stringify(expected.copperLayers) && actual.net === expected.net,
  "KiCad pads and holes");

  const body = Object.freeze({
    schemaVersion: 1 as const,
    state: "passed" as const,
    toleranceMm: TOLERANCE_MM,
    layerCount,
    copperLayers: expectedCopperLayers,
    board: Object.freeze({ widthMm: width, heightMm: height, sourceCenter, kicadCenter }),
    counts: Object.freeze({
      components: sourceComponents.length,
      schematicSymbols: schematicByReference.size,
      nets: expectedNetNames.length,
      traces: expectedSegments.length,
      vias: expectedVias.length,
      platedHoles: expectedPads.filter(({ kind }) => kind === "plated").length,
      nonPlatedHoles: expectedPads.filter(({ kind }) => kind === "non-plated").length,
    }),
    componentReferences: Object.freeze(expectedReferences),
    componentValues: sortedUnique(actualValues),
    schematicLibraryIds: sortedUnique(schematicLibraryIds),
    footprintLibraryLinks: sortedUnique(footprintLibraryLinks),
    netNames: expectedNetNames,
    schematicNetNames: expectedSchematicNetNames,
    traceLayers: sortedUnique(expectedSegments.map(({ layer }) => layer)),
  });
  return Object.freeze({ ...body, sha256: sha256(canonical(body)) });
}

/** Converts a controlled reconciliation rejection into deterministic report evidence. */
export function failedKicadSemanticReconciliation(error: unknown): Readonly<KicadSemanticReconciliationFailed> {
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw.startsWith("KICAD_SEMANTIC_RECONCILIATION_FAILED: ")) throw error;
  const message = raw.slice("KICAD_SEMANTIC_RECONCILIATION_FAILED: ".length);
  if (message.length === 0 || message.length > 4_096) throw new TypeError("KiCad semantic failure message is invalid");
  const body = Object.freeze({
    schemaVersion: 1 as const,
    state: "failed" as const,
    toleranceMm: TOLERANCE_MM,
    message,
  });
  return Object.freeze({ ...body, sha256: sha256(canonical(body)) });
}
