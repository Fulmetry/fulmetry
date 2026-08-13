// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { Diagnostic } from "../diagnostics";
import type { AnyCircuitElement } from "tscircuit";
import { deriveAuthoritativeConnectivity } from "../authoritative-connectivity";
import { lineSegmentDistance } from "../fabrication-geometry";
import { diagnosticObjectMatchesTarget } from "../diagnostic-object-selector";

export interface PointMm {
  readonly x: number;
  readonly y: number;
}

export interface BoundsMm {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export type TraceMeasurement =
  | Readonly<{
      readonly state: "invalid";
      readonly unit: "mm";
      readonly reason: string;
    }>
  | Readonly<{
      readonly state: "proven";
      readonly unit: "mm";
      readonly lengthMm: number;
      readonly viaCount: number;
      readonly transitions: readonly Readonly<{
        readonly viaId: string;
        readonly x: number;
        readonly y: number;
        readonly fromLayer: string;
        readonly toLayer: string;
      }>[];
    }>;

export interface InspectedCircuitElement {
  readonly id?: string;
  readonly type: string;
  readonly name?: string;
  readonly center?: PointMm;
  readonly bounds?: BoundsMm;
  readonly layers: readonly string[];
  readonly relatedObjectIds: readonly string[];
  readonly electricalObjectIds: readonly string[];
  readonly physicalObjectIds: readonly string[];
  readonly manufacturedPinMapping?: Readonly<{
    readonly state: "proven" | "invalid";
    readonly reason?: string;
  }>;
  readonly traceMeasurement?: TraceMeasurement;
  readonly sourceLocations: readonly string[];
  readonly violations: readonly string[];
  readonly distanceFromPointMm?: number;
  readonly element: Readonly<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function circuitElementId(element: Record<string, unknown>): string | undefined {
  const primary = element[`${String(element.type)}_id`];
  if (typeof primary === "string") return primary;
  for (const [key, value] of Object.entries(element)) {
    if (key.endsWith("_id") && typeof value === "string") return value;
  }
  return undefined;
}

function electricalIds(
  element: Record<string, unknown>,
  ownId: string | undefined,
  elements: readonly Record<string, unknown>[],
): readonly string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value !== ownId) ids.add(value);
  };
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) for (const item of value) add(item);
  };
  const unique = (id: unknown, type: string): Record<string, unknown> | undefined => {
    if (typeof id !== "string") return undefined;
    const matches = elements.filter((candidate) =>
      candidate.type === type && circuitElementId(candidate) === id
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  switch (element.type) {
    case "source_trace": {
      for (const id of Array.isArray(element.connected_source_port_ids) ? element.connected_source_port_ids : []) {
        if (unique(id, "source_port") !== undefined) add(id);
      }
      for (const id of Array.isArray(element.connected_source_net_ids) ? element.connected_source_net_ids : []) {
        if (unique(id, "source_net") !== undefined) add(id);
      }
      break;
    }
    case "pcb_via": {
      const trace = unique(element.pcb_trace_id, "pcb_trace");
      const viaPoint = point(element);
      const routeContainsVia = trace !== undefined && viaPoint !== undefined &&
        Array.isArray(trace.route) && trace.route.some((entry) => {
          const route = record(entry);
          return route?.route_type === "via" && route.x === viaPoint.x && route.y === viaPoint.y;
        });
      if (routeContainsVia) add(element.pcb_trace_id);
      break;
    }
    case "pcb_port":
      if (unique(element.source_port_id, "source_port") !== undefined) add(element.source_port_id);
      break;
    case "pcb_smtpad":
    case "pcb_plated_hole": {
      const port = unique(element.pcb_port_id, "pcb_port");
      const portPoint = port === undefined ? undefined : point(port) ?? point(port.center);
      const padLayers = elementLayers(element);
      const portLayers = port === undefined ? [] : elementLayers(port);
      const layerCompatible = padLayers.length === 0 || portLayers.length === 0 ||
        padLayers.some((layer) => portLayers.includes(layer));
      if (
        port !== undefined && portPoint !== undefined && layerCompatible &&
        pointInsideManufacturedPad(element, portPoint)
      ) add(element.pcb_port_id);
      break;
    }
  }
  return Object.freeze([...ids].sort());
}

function point(value: unknown): PointMm | undefined {
  const candidate = record(value);
  const x = finite(candidate?.x);
  const y = finite(candidate?.y);
  return x === undefined || y === undefined ? undefined : Object.freeze({ x, y });
}

function geometryPoints(element: Record<string, unknown>): readonly PointMm[] {
  const points: PointMm[] = [];
  const direct = point(element);
  if (direct !== undefined) points.push(direct);
  const center = point(element.center);
  if (center !== undefined) points.push(center);
  for (const key of ["route", "points", "outline", "polygon"] as const) {
    const values = element[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const candidate = point(value);
      if (candidate !== undefined) points.push(candidate);
    }
  }
  return Object.freeze(points);
}

export function circuitElementBounds(
  element: Record<string, unknown>,
): BoundsMm | undefined {
  const points = geometryPoints(element);
  if (points.length === 0) return undefined;
  const width = finite(element.width) ?? finite(element.outer_diameter) ??
    finite(element.diameter) ?? 0;
  const height = finite(element.height) ?? finite(element.outer_diameter) ??
    finite(element.diameter) ?? width;
  const rotationDegrees = finite(element.rotation) ?? finite(element.ccw_rotation) ??
    finite(element.pcb_rotation) ?? 0;
  const rotationRadians = rotationDegrees * Math.PI / 180;
  const route = Array.isArray(element.route) ? element.route : [];
  const routeHalfWidth = route.reduce((maximum, entry) => {
    const candidate = finite(record(entry)?.width) ?? 0;
    return Math.max(maximum, candidate / 2);
  }, 0);
  const rotatedHalfWidth = Math.abs(Math.cos(rotationRadians)) * width / 2 +
    Math.abs(Math.sin(rotationRadians)) * height / 2;
  const rotatedHalfHeight = Math.abs(Math.sin(rotationRadians)) * width / 2 +
    Math.abs(Math.cos(rotationRadians)) * height / 2;
  const halfWidth = Math.max(rotatedHalfWidth, routeHalfWidth);
  const halfHeight = Math.max(rotatedHalfHeight, routeHalfWidth);
  return Object.freeze({
    minX: Math.min(...points.map(({ x }) => x)) - halfWidth,
    minY: Math.min(...points.map(({ y }) => y)) - halfHeight,
    maxX: Math.max(...points.map(({ x }) => x)) + halfWidth,
    maxY: Math.max(...points.map(({ y }) => y)) + halfHeight,
  });
}

function boundsCenter(bounds: BoundsMm): PointMm {
  return Object.freeze({
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  });
}

function distanceToBounds(point: PointMm, bounds: BoundsMm): number {
  const dx = Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX);
  const dy = Math.max(bounds.minY - point.y, 0, point.y - bounds.maxY);
  return Math.hypot(dx, dy);
}

function pointInsideManufacturedPad(
  element: Record<string, unknown>,
  candidate: PointMm,
): boolean {
  const center = point(element) ?? point(element.center);
  if (center === undefined) return false;
  const rotationDegrees = finite(element.rotation) ?? finite(element.ccw_rotation) ??
    finite(element.pcb_rotation) ?? 0;
  const angle = rotationDegrees * Math.PI / 180;
  const dx = candidate.x - center.x;
  const dy = candidate.y - center.y;
  const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
  const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
  const epsilon = 1e-9;
  if (element.type === "pcb_smtpad" && element.shape === "rect") {
    const width = finite(element.width);
    const height = finite(element.height);
    return width !== undefined && height !== undefined && width > 0 && height > 0 &&
      Math.abs(localX) <= width / 2 + epsilon &&
      Math.abs(localY) <= height / 2 + epsilon;
  }
  if (element.type === "pcb_smtpad" && element.shape === "circle") {
    const radius = finite(element.radius);
    return radius !== undefined && radius > 0 && Math.hypot(localX, localY) <= radius + epsilon;
  }
  if (element.type === "pcb_plated_hole" && element.shape === "circle") {
    const outerDiameter = finite(element.outer_diameter);
    return outerDiameter !== undefined && outerDiameter > 0 &&
      Math.hypot(localX, localY) <= outerDiameter / 2 + epsilon;
  }
  return false;
}

interface PhysicalWire extends PointMm {
  readonly route_type: "wire";
  readonly layer: string;
  readonly width: number;
  readonly start_pcb_port_id?: string;
  readonly end_pcb_port_id?: string;
}

interface PhysicalVia extends PointMm {
  readonly route_type: "via";
  readonly from_layer: string;
  readonly to_layer: string;
}

interface ValidatedPhysicalTrace {
  readonly id: string;
  readonly net: string;
  readonly endpointPortIds: readonly [string, string];
  readonly viaIds: readonly string[];
  readonly transitions: readonly Readonly<{
    readonly viaId: string;
    readonly x: number;
    readonly y: number;
    readonly fromLayer: string;
    readonly toLayer: string;
    readonly viaLayers: readonly string[];
  }>[];
  readonly segments: readonly {
    readonly layer: string;
    readonly start: PhysicalWire;
    readonly end: PhysicalWire;
  }[];
}

interface PhysicalElectricalEvidence {
  readonly graph: ReadonlyMap<string, ReadonlySet<string>>;
  readonly traces: ReadonlyMap<string, ValidatedPhysicalTrace>;
}

interface QualifiedBoardAuthority {
  readonly thickness: number;
  readonly layers: readonly string[];
}

function qualifiedBoardAuthority(
  records: readonly Record<string, unknown>[],
): QualifiedBoardAuthority | undefined {
  const boards = records.filter((candidate) => candidate.type === "pcb_board");
  if (boards.length !== 1) return undefined;
  const board = boards[0]!;
  const thickness = finite(board.thickness);
  const numLayers = finite(board.num_layers);
  if (thickness === undefined || thickness <= 0 || (numLayers !== 2 && numLayers !== 4)) {
    return undefined;
  }
  return Object.freeze({
    thickness,
    layers: Object.freeze(numLayers === 2
      ? ["top", "bottom"]
      : ["top", "inner1", "inner2", "bottom"]),
  });
}

function transitionUsesQualifiedThroughVia(
  transition: ValidatedPhysicalTrace["transitions"][number],
  board: QualifiedBoardAuthority | undefined,
): boolean {
  if (board === undefined) return false;
  const outerSpan =
    (transition.fromLayer === "top" && transition.toLayer === "bottom") ||
    (transition.fromLayer === "bottom" && transition.toLayer === "top");
  return outerSpan && transition.viaLayers.length === board.layers.length &&
    board.layers.every((layer) => transition.viaLayers.includes(layer));
}

function uniqueElement(
  records: readonly Record<string, unknown>[],
  type: string,
  id: unknown,
): Record<string, unknown> | undefined {
  if (typeof id !== "string") return undefined;
  const matches = records.filter((candidate) =>
    candidate.type === type && circuitElementId(candidate) === id
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function addPhysicalEdge(
  graph: Map<string, Set<string>>,
  left: string,
  right: string,
): void {
  if (left === right) return;
  const leftEdges = graph.get(left) ?? new Set<string>();
  const rightEdges = graph.get(right) ?? new Set<string>();
  leftEdges.add(right);
  rightEdges.add(left);
  graph.set(left, leftEdges);
  graph.set(right, rightEdges);
}

function physicalWire(value: unknown): PhysicalWire | undefined {
  const route = record(value);
  const x = finite(route?.x);
  const y = finite(route?.y);
  const width = finite(route?.width);
  if (
    route?.route_type !== "wire" || x === undefined || y === undefined ||
    width === undefined || width <= 0 || typeof route.layer !== "string"
  ) return undefined;
  return Object.freeze({
    route_type: "wire" as const,
    x,
    y,
    width,
    layer: route.layer,
    ...(typeof route.start_pcb_port_id === "string"
      ? { start_pcb_port_id: route.start_pcb_port_id }
      : {}),
    ...(typeof route.end_pcb_port_id === "string"
      ? { end_pcb_port_id: route.end_pcb_port_id }
      : {}),
  });
}

function physicalVia(value: unknown): PhysicalVia | undefined {
  const route = record(value);
  const x = finite(route?.x);
  const y = finite(route?.y);
  if (
    route?.route_type !== "via" || x === undefined || y === undefined ||
    typeof route.from_layer !== "string" || typeof route.to_layer !== "string" ||
    route.from_layer === route.to_layer
  ) return undefined;
  return Object.freeze({
    route_type: "via" as const,
    x,
    y,
    from_layer: route.from_layer,
    to_layer: route.to_layer,
  });
}

function exactPhysicalPortPadMapping(
  records: readonly Record<string, unknown>[],
  pcbPortId: string,
  globallyUniqueIds: ReadonlySet<string>,
  board: QualifiedBoardAuthority,
): Readonly<{
  port: Record<string, unknown>;
  pad: Record<string, unknown>;
}> | undefined {
  const port = uniqueElement(records, "pcb_port", pcbPortId);
  if (port === undefined || !globallyUniqueIds.has(pcbPortId)) return undefined;
  const pads = records.filter((candidate) =>
    (candidate.type === "pcb_smtpad" || candidate.type === "pcb_plated_hole") &&
    candidate.pcb_port_id === pcbPortId
  );
  const pad = pads.length === 1 ? pads[0] : undefined;
  const padId = pad === undefined ? undefined : circuitElementId(pad);
  if (pad === undefined || padId === undefined || !globallyUniqueIds.has(padId)) return undefined;
  const portLayers = Array.isArray(port.layers) &&
      port.layers.every((layer) => typeof layer === "string")
    ? port.layers as string[]
    : undefined;
  if (portLayers === undefined || new Set(portLayers).size !== portLayers.length) return undefined;
  if (pad.type === "pcb_smtpad") {
    if (
      (pad.layer !== "top" && pad.layer !== "bottom") ||
      !board.layers.includes(pad.layer) ||
      portLayers.length !== 1 || portLayers[0] !== pad.layer
    ) return undefined;
  } else {
    const holeDiameter = finite(pad.hole_diameter);
    const outerDiameter = finite(pad.outer_diameter);
    const padLayers = Array.isArray(pad.layers) &&
        pad.layers.every((layer) => typeof layer === "string")
      ? pad.layers as string[]
      : undefined;
    if (
      pad.shape !== "circle" || holeDiameter === undefined || holeDiameter <= 0 ||
      outerDiameter === undefined || outerDiameter <= holeDiameter ||
      padLayers === undefined || new Set(padLayers).size !== padLayers.length ||
      padLayers.length !== board.layers.length || portLayers.length !== board.layers.length ||
      !board.layers.every((layer) => padLayers.includes(layer) && portLayers.includes(layer))
    ) return undefined;
  }
  if (
    typeof port.pcb_component_id !== "string" ||
    pad.pcb_component_id !== port.pcb_component_id
  ) return undefined;
  const pcbComponent = uniqueElement(records, "pcb_component", port.pcb_component_id);
  if (
    pcbComponent === undefined || !globallyUniqueIds.has(port.pcb_component_id) ||
    typeof pcbComponent.source_component_id !== "string" ||
    typeof port.source_port_id !== "string"
  ) return undefined;
  const sourcePort = uniqueElement(records, "source_port", port.source_port_id);
  const sourceComponent = uniqueElement(
    records,
    "source_component",
    pcbComponent.source_component_id,
  );
  if (
    sourcePort === undefined || sourceComponent === undefined ||
    !globallyUniqueIds.has(port.source_port_id) ||
    !globallyUniqueIds.has(pcbComponent.source_component_id) ||
    sourcePort.source_component_id !== pcbComponent.source_component_id
  ) return undefined;
  return Object.freeze({ port, pad });
}

function endpointTouchesManufacturedPad(
  records: readonly Record<string, unknown>[],
  pcbPortId: string,
  wire: PhysicalWire,
  globallyUniqueIds: ReadonlySet<string>,
  board: QualifiedBoardAuthority,
): boolean {
  const mapping = exactPhysicalPortPadMapping(
    records,
    pcbPortId,
    globallyUniqueIds,
    board,
  );
  return board.layers.includes(wire.layer) && mapping !== undefined &&
    elementLayers(mapping.port).includes(wire.layer) &&
    elementLayers(mapping.pad).includes(wire.layer) &&
    pointInsideManufacturedPad(mapping.pad, wire);
}

function validatePhysicalTrace(
  trace: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  authority: ReturnType<typeof deriveAuthoritativeConnectivity>,
  globallyUniqueIds: ReadonlySet<string>,
  board: QualifiedBoardAuthority | undefined,
): ValidatedPhysicalTrace | undefined {
  const id = circuitElementId(trace);
  const net = id === undefined ? undefined : authority.netForPcbTraceId(id);
  if (
    board === undefined || id === undefined || !globallyUniqueIds.has(id) || net === undefined ||
    !Array.isArray(trace.route) || trace.route.length < 2
  ) {
    return undefined;
  }
  const parsed = trace.route.map((entry) => physicalWire(entry) ?? physicalVia(entry));
  if (parsed.some((entry) => entry === undefined)) return undefined;
  const route = parsed as Array<PhysicalWire | PhysicalVia>;
  if (route.some((entry) => entry.route_type === "wire"
    ? !board.layers.includes(entry.layer)
    : !board.layers.includes(entry.from_layer) || !board.layers.includes(entry.to_layer)
  )) return undefined;
  const first = route[0];
  const last = route.at(-1);
  if (first?.route_type !== "wire" || last?.route_type !== "wire") return undefined;
  if (
    typeof first.start_pcb_port_id !== "string" || typeof last.end_pcb_port_id !== "string" ||
    route.some((entry, index) =>
      entry.route_type === "wire" &&
      ((index !== 0 && entry.start_pcb_port_id !== undefined) ||
        (index !== route.length - 1 && entry.end_pcb_port_id !== undefined))
    )
  ) return undefined;
  for (const pcbPortId of [first.start_pcb_port_id, last.end_pcb_port_id]) {
    if (authority.netForPcbPortId(pcbPortId) !== net) return undefined;
  }
  if (
    !endpointTouchesManufacturedPad(records, first.start_pcb_port_id, first, globallyUniqueIds, board) ||
    !endpointTouchesManufacturedPad(records, last.end_pcb_port_id, last, globallyUniqueIds, board)
  ) return undefined;

  const viaIds: string[] = [];
  const transitions: Array<{
    viaId: string;
    x: number;
    y: number;
    fromLayer: string;
    toLayer: string;
    viaLayers: readonly string[];
  }> = [];
  const segments: Array<{ layer: string; start: PhysicalWire; end: PhysicalWire }> = [];
  for (let index = 0; index < route.length; index += 1) {
    const entry = route[index]!;
    const previous = route[index - 1];
    const next = route[index + 1];
    if (entry.route_type === "wire") {
      if (next?.route_type === "wire") {
        if (entry.layer !== next.layer) return undefined;
        segments.push(Object.freeze({ layer: entry.layer, start: entry, end: next }));
      }
      continue;
    }
    if (
      previous?.route_type !== "wire" || next?.route_type !== "wire" ||
      previous.x !== entry.x || previous.y !== entry.y ||
      next.x !== entry.x || next.y !== entry.y ||
      previous.layer !== entry.from_layer || next.layer !== entry.to_layer
    ) return undefined;
    const matchingVias = records.filter((candidate) =>
      candidate.type === "pcb_via" && candidate.pcb_trace_id === id &&
      finite(candidate.x) === entry.x && finite(candidate.y) === entry.y &&
      candidate.from_layer === entry.from_layer && candidate.to_layer === entry.to_layer &&
      (finite(candidate.hole_diameter) ?? 0) > 0 &&
      (finite(candidate.outer_diameter) ?? 0) > (finite(candidate.hole_diameter) ?? 0) &&
      Array.isArray(candidate.layers) &&
      candidate.layers.every((layer) => typeof layer === "string") &&
      elementLayers(candidate).includes(entry.from_layer) &&
      elementLayers(candidate).includes(entry.to_layer) &&
      (typeof candidate.source_net_id !== "string" ||
        authority.netForSourceNetId(candidate.source_net_id) === net) &&
      (typeof candidate.subcircuit_connectivity_map_key !== "string" ||
        authority.netForRawConnectivityKey(candidate.subcircuit_connectivity_map_key) === net)
    );
    const viaId = matchingVias.length === 1 ? circuitElementId(matchingVias[0]!) : undefined;
    if (
      viaId === undefined || !globallyUniqueIds.has(viaId) || viaIds.includes(viaId)
    ) return undefined;
    viaIds.push(viaId);
    transitions.push(Object.freeze({
      viaId,
      x: entry.x,
      y: entry.y,
      fromLayer: entry.from_layer,
      toLayer: entry.to_layer,
      viaLayers: Object.freeze([...(matchingVias[0]!.layers as string[])]),
    }));
  }
  const ownedViaRecords = records.filter((candidate) =>
    candidate.type === "pcb_via" && candidate.pcb_trace_id === id
  );
  const ownedViaIds = ownedViaRecords.map((candidate) => circuitElementId(candidate));
  if (
    ownedViaIds.length !== viaIds.length ||
    ownedViaIds.some((viaId) => viaId === undefined || !globallyUniqueIds.has(viaId)) ||
    viaIds.some((viaId) => !ownedViaIds.includes(viaId))
  ) return undefined;
  if (segments.length === 0 && viaIds.length === 0) return undefined;
  return Object.freeze({
    id,
    net,
    endpointPortIds: Object.freeze([
      first.start_pcb_port_id,
      last.end_pcb_port_id,
    ] as const),
    viaIds: Object.freeze(viaIds),
    transitions: Object.freeze(transitions),
    segments: Object.freeze(segments),
  });
}

function physicalElectricalGraph(
  records: readonly Record<string, unknown>[],
): PhysicalElectricalEvidence {
  const graph = new Map<string, Set<string>>();
  const idCounts = new Map<string, number>();
  for (const candidate of records) {
    const id = circuitElementId(candidate);
    if (id !== undefined) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  const globallyUniqueIds = new Set(
    [...idCounts].flatMap(([id, count]) => count === 1 ? [id] : []),
  );
  const authority = deriveAuthoritativeConnectivity(
    records as unknown as readonly AnyCircuitElement[],
  );
  const board = qualifiedBoardAuthority(records);
  for (const pad of records.filter((element) =>
    element.type === "pcb_smtpad" || element.type === "pcb_plated_hole"
  )) {
    const padId = circuitElementId(pad);
    const mapping = typeof pad.pcb_port_id === "string" && board !== undefined
      ? exactPhysicalPortPadMapping(records, pad.pcb_port_id, globallyUniqueIds, board)
      : undefined;
    const port = mapping?.port;
    const portId = port === undefined ? undefined : circuitElementId(port);
    const portPoint = port === undefined ? undefined : point(port) ?? point(port.center);
    if (
      padId !== undefined && port !== undefined && portId !== undefined && portPoint !== undefined &&
      mapping?.pad === pad &&
      elementLayers(pad).some((layer) => elementLayers(port).includes(layer)) &&
      pointInsideManufacturedPad(pad, portPoint)
    ) addPhysicalEdge(graph, padId, portId);
  }
  const traces = records.filter((element) => element.type === "pcb_trace")
    .flatMap((trace) => {
      const validated = validatePhysicalTrace(
        trace,
        records,
        authority,
        globallyUniqueIds,
        board,
      );
      return validated === undefined ? [] : [validated];
    });
  const physicallyQualifiedTraces = traces.filter((trace) =>
    trace.transitions.every((transition) => transitionUsesQualifiedThroughVia(transition, board))
  );
  for (const trace of physicallyQualifiedTraces) {
    for (const portId of trace.endpointPortIds) addPhysicalEdge(graph, trace.id, portId);
    for (const viaId of trace.viaIds) addPhysicalEdge(graph, trace.id, viaId);
  }
  for (let left = 0; left < physicallyQualifiedTraces.length; left += 1) {
    for (let right = left + 1; right < physicallyQualifiedTraces.length; right += 1) {
      const a = physicallyQualifiedTraces[left]!;
      const b = physicallyQualifiedTraces[right]!;
      if (a.net !== b.net) continue;
      const sharesPort = a.endpointPortIds.some((id) => b.endpointPortIds.includes(id));
      const sharesCopper = a.segments.some((first) => b.segments.some((second) =>
        first.layer === second.layer &&
        lineSegmentDistance(first.start, first.end, second.start, second.end) <=
          first.start.width / 2 + second.start.width / 2 + 1e-9
      ));
      if (sharesPort || sharesCopper) addPhysicalEdge(graph, a.id, b.id);
    }
  }
  return Object.freeze({
    graph,
    traces: new Map(traces.map((trace) => [trace.id, trace] as const)),
  });
}

function traceMeasurement(
  element: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  physicalEvidence: PhysicalElectricalEvidence,
): InspectedCircuitElement["traceMeasurement"] {
  if (element.type !== "pcb_trace") return undefined;
  const board = qualifiedBoardAuthority(records);
  if (board === undefined) {
    return Object.freeze({
      state: "invalid" as const,
      unit: "mm" as const,
      reason: "trace length requires one positive-thickness PCB board with a supported 2- or 4-layer stack",
    });
  }
  const id = circuitElementId(element);
  const trace = id === undefined ? undefined : physicalEvidence.traces.get(id);
  if (trace === undefined) {
    return Object.freeze({
      state: "invalid" as const,
      unit: "mm" as const,
      reason: "route lacks exact same-net endpoint, segment, or manufactured-via proof",
    });
  }
  if (!trace.transitions.every((transition) => transitionUsesQualifiedThroughVia(transition, board))) {
    return Object.freeze({
      state: "invalid" as const,
      unit: "mm" as const,
      reason: "trace length requires every transition to use a qualified full-stack through via",
    });
  }
  const planarLengthMm = trace.segments.reduce((total, segment) =>
    total + Math.hypot(
      segment.end.x - segment.start.x,
      segment.end.y - segment.start.y,
    ), 0);
  return Object.freeze({
    state: "proven" as const,
    unit: "mm" as const,
    lengthMm: planarLengthMm + trace.transitions.length * board.thickness,
    viaCount: trace.transitions.length,
    transitions: Object.freeze(trace.transitions.map(({ viaLayers: _viaLayers, ...transition }) =>
      Object.freeze(transition)
    )),
  });
}

export function boundsGap(a: BoundsMm, b: BoundsMm): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
}

function elementLayers(element: Record<string, unknown>): readonly string[] {
  const layers = new Set<string>();
  for (const key of ["layer", "from_layer", "to_layer"] as const) {
    if (typeof element[key] === "string") layers.add(element[key]);
  }
  if (Array.isArray(element.layers)) {
    for (const layer of element.layers) if (typeof layer === "string") layers.add(layer);
  }
  if (Array.isArray(element.route)) {
    for (const entry of element.route) {
      const route = record(entry);
      for (const key of ["layer", "from_layer", "to_layer"] as const) {
        if (typeof route?.[key] === "string") layers.add(route[key]);
      }
    }
  }
  return Object.freeze([...layers].sort());
}

function relationIds(element: Record<string, unknown>, ownId: string | undefined): readonly string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value !== ownId) ids.add(value);
  };
  for (const [key, value] of Object.entries(element)) {
    if (key === "subcircuit_id" || key === "pcb_group_id" || key === "source_group_id") continue;
    if (key.endsWith("_id")) add(value);
    if (
      key.endsWith("_ids") || key === "connectsTo" || key === "connected_source_port_ids" ||
      key === "connected_source_net_ids"
    ) {
      if (Array.isArray(value)) for (const item of value) add(item);
    }
  }
  if (Array.isArray(element.route)) {
    for (const entry of element.route) {
      const route = record(entry);
      if (route === undefined) continue;
      for (const [key, value] of Object.entries(route)) if (key.endsWith("_id")) add(value);
    }
  }
  return Object.freeze([...ids].sort());
}

function diagnosticMetadata(
  diagnostics: readonly Diagnostic[],
  identifiers: readonly string[],
): { sourceLocations: readonly string[]; violations: readonly string[] } {
  const relevant = diagnostics.filter(({ objects }) =>
    objects.some((object) => identifiers.some((identifier) =>
      diagnosticObjectMatchesTarget(object, identifier)
    ))
  );
  return {
    sourceLocations: Object.freeze([...new Set(relevant.flatMap(({ sourceLocations }) => sourceLocations))].sort()),
    violations: Object.freeze([...new Set(relevant.map(({ id }) => id))].sort()),
  };
}

export function inspectableElements(
  circuitJson: readonly unknown[],
  diagnostics: readonly Diagnostic[],
  queryPoint?: PointMm,
): readonly InspectedCircuitElement[] {
  const inspected: InspectedCircuitElement[] = [];
  const records = circuitJson.flatMap((value) => {
    const candidate = record(value);
    return candidate === undefined ? [] : [candidate];
  });
  const physicalEvidence = physicalElectricalGraph(records);
  const physicalConnections = physicalEvidence.graph;
  const recordById = new Map(records.flatMap((element) => {
    const id = circuitElementId(element);
    return id === undefined ? [] : [[id, element] as const];
  }));
  for (const element of records) {
    if (typeof element.type !== "string") continue;
    const id = circuitElementId(element);
    const name = typeof element.name === "string"
      ? element.name
      : typeof element.display_name === "string" ? element.display_name : undefined;
    const bounds = circuitElementBounds(element);
    const metadata = diagnosticMetadata(
      diagnostics,
      [id, name].filter((item): item is string => item !== undefined),
    );
    const physicalObjectIds = Object.freeze(
      id === undefined ? [] : [...(physicalConnections.get(id) ?? [])].sort(),
    );
    const manufacturedPinMapping = element.type === "pcb_port"
      ? physicalObjectIds.some((neighborId) => {
          const neighbor = recordById.get(neighborId);
          return neighbor?.type === "pcb_smtpad" || neighbor?.type === "pcb_plated_hole";
        })
        ? Object.freeze({ state: "proven" as const })
        : Object.freeze({
            state: "invalid" as const,
            reason: "no unique ownership-consistent manufactured pad mapping at compatible geometry and layer",
          })
      : element.type === "pcb_smtpad" || element.type === "pcb_plated_hole"
        ? physicalObjectIds.some((neighborId) => recordById.get(neighborId)?.type === "pcb_port")
          ? Object.freeze({ state: "proven" as const })
          : Object.freeze({
              state: "invalid" as const,
              reason: "no unique ownership-consistent PCB port mapping at compatible geometry and layer",
            })
        : undefined;
    const measuredTrace = traceMeasurement(element, records, physicalEvidence);
    inspected.push(Object.freeze({
      ...(id === undefined ? {} : { id }),
      type: element.type,
      ...(name === undefined ? {} : { name }),
      ...(bounds === undefined ? {} : { bounds, center: boundsCenter(bounds) }),
      layers: elementLayers(element),
      relatedObjectIds: relationIds(element, id),
      electricalObjectIds: electricalIds(element, id, records),
      physicalObjectIds,
      ...(manufacturedPinMapping === undefined ? {} : { manufacturedPinMapping }),
      ...(measuredTrace === undefined ? {} : { traceMeasurement: measuredTrace }),
      ...metadata,
      ...(queryPoint === undefined || bounds === undefined
        ? {}
        : { distanceFromPointMm: distanceToBounds(queryPoint, bounds) }),
      element: Object.freeze({ ...element }),
    }));
  }
  return Object.freeze(inspected);
}

function graphPath(
  elements: readonly InspectedCircuitElement[],
  from: string,
  to: string,
  edges: (element: InspectedCircuitElement) => readonly string[],
): readonly string[] | undefined {
  const byId = new Map(elements.flatMap((element) => element.id === undefined ? [] : [[element.id, element] as const]));
  if (!byId.has(from) || !byId.has(to)) return undefined;
  const reverse = new Map<string, Set<string>>();
  for (const element of elements) {
    if (element.id === undefined) continue;
    for (const related of edges(element)) {
      const values = reverse.get(related) ?? new Set<string>();
      values.add(element.id);
      reverse.set(related, values);
    }
  }
  const queue: Array<readonly [string, readonly string[]]> = [[from, [from]]];
  const visited = new Set<string>([from]);
  while (queue.length > 0) {
    const [current, path] = queue.shift()!;
    if (current === to) return Object.freeze([...path]);
    const currentElement = byId.get(current);
    const direct = currentElement === undefined ? [] : edges(currentElement);
    const neighbors = new Set([...direct, ...(reverse.get(current) ?? [])]);
    for (const neighbor of [...neighbors].sort()) {
      if (!byId.has(neighbor) || visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push([neighbor, [...path, neighbor]]);
    }
  }
  return undefined;
}

export function logicalConnectivityPath(
  elements: readonly InspectedCircuitElement[],
  from: string,
  to: string,
): readonly string[] | undefined {
  return graphPath(elements, from, to, ({ electricalObjectIds }) => electricalObjectIds);
}

export function physicalConnectivityPath(
  elements: readonly InspectedCircuitElement[],
  from: string,
  to: string,
): readonly string[] | undefined {
  return graphPath(elements, from, to, ({ physicalObjectIds }) => physicalObjectIds);
}

function reachableIds(
  elements: readonly InspectedCircuitElement[],
  from: string,
  edges: (element: InspectedCircuitElement) => readonly string[],
): ReadonlySet<string> {
  const byId = new Map(elements.flatMap((element) =>
    element.id === undefined ? [] : [[element.id, element] as const]
  ));
  if (!byId.has(from)) return new Set();
  const reverse = new Map<string, Set<string>>();
  for (const element of elements) {
    if (element.id === undefined) continue;
    for (const neighbor of edges(element)) {
      const inbound = reverse.get(neighbor) ?? new Set<string>();
      inbound.add(element.id);
      reverse.set(neighbor, inbound);
    }
  }
  const visited = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const direct = edges(byId.get(current)!);
    for (const neighbor of [...direct, ...(reverse.get(current) ?? [])]) {
      if (!byId.has(neighbor) || visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  return visited;
}

/**
 * Return manufactured pad/hole endpoints in the queried logical connection
 * that are not all joined by validated physical copper. A split route marks
 * every endpoint in the split logical group, rather than blessing one island.
 */
export function unconnectedManufacturedEndpointIds(
  elements: readonly InspectedCircuitElement[],
  from: string,
  to: string,
): readonly string[] {
  if (logicalConnectivityPath(elements, from, to) === undefined) return Object.freeze([]);
  const logicalGroup = reachableIds(
    elements,
    from,
    ({ electricalObjectIds }) => electricalObjectIds,
  );
  const manufacturedEndpointIds = elements.flatMap((element) =>
    element.id !== undefined && logicalGroup.has(element.id) &&
      (element.type === "pcb_smtpad" || element.type === "pcb_plated_hole")
      ? [element.id]
      : []
  ).sort();
  if (manufacturedEndpointIds.length < 2) return Object.freeze([]);
  const physicallyConnected = reachableIds(
    elements,
    manufacturedEndpointIds[0]!,
    ({ physicalObjectIds }) => physicalObjectIds,
  );
  return manufacturedEndpointIds.every((id) => physicallyConnected.has(id))
    ? Object.freeze([])
    : Object.freeze(manufacturedEndpointIds);
}

export function relationPath(
  elements: readonly InspectedCircuitElement[],
  from: string,
  to: string,
): readonly string[] | undefined {
  return graphPath(elements, from, to, ({ relatedObjectIds }) => relatedObjectIds);
}

export function intersects(a: BoundsMm, b: BoundsMm): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
