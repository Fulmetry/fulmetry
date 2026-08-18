// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import type { BaselineFabricationProfile } from "./profiles/baseline";
import type { AuthoritativeConnectivity } from "./authoritative-connectivity";

type Point = { x: number; y: number };
type Layer = string;

type CopperFeature =
  | { kind: "circle"; id: string; net: string; layer: Layer; x: number; y: number; radius: number }
  | { kind: "rect"; id: string; net: string; layer: Layer; x: number; y: number; halfWidth: number; halfHeight: number }
  | { kind: "segment"; id: string; net: string; layer: Layer; start: Point; end: Point; radius: number };
type AreaFeature = Exclude<CopperFeature, { kind: "segment" }>;

export interface FabricationGeometryAssessment {
  readonly copperClearance: readonly string[];
  readonly edgeClearance: readonly string[];
  readonly maskSliver: readonly string[];
  readonly componentPlacement: readonly string[];
  readonly componentOverlap: readonly string[];
  readonly courtyardOverlap: readonly string[];
  readonly courtyardEdge: readonly string[];
  readonly courtyardIntegrity: readonly string[];
  readonly pasteAperture: readonly string[];
  readonly pasteCompleteness: readonly string[];
  readonly padOwnerIntegrity: readonly string[];
  readonly geometryIdentity: readonly string[];
  readonly netIdentity: readonly string[];
  readonly keepoutViolations: readonly string[];
  readonly unsupported: readonly string[];
}

export interface BaselineGeometryWorkload {
  readonly copperFeatures: number;
  readonly maskFeatures: number;
  readonly componentBodies: number;
  readonly courtyards: number;
  readonly keepouts: number;
  readonly pairwiseFeatures: number;
}

const EPSILON_MM = 1e-9;
const PAIR_FINDING_RETAIN_LIMIT = 255;

class BoundedPairFindings {
  readonly #values = new Set<string>();
  #omitted = 0;

  add(value: string): void {
    if (this.#values.has(value)) return;
    if (this.#values.size < PAIR_FINDING_RETAIN_LIMIT) this.#values.add(value);
    else this.#omitted += 1;
  }

  toArray(category: string): readonly string[] {
    return Object.freeze([
      ...this.#values,
      ...(this.#omitted > 0
        ? [`${category}:additional-findings-omitted-at-least:${this.#omitted}`]
        : []),
    ].sort());
  }
}

function below(actual: number, required: number): boolean {
  return actual + EPSILON_MM < required;
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  ));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, point: Point): boolean {
  return Math.abs(orientation(a, b, point)) <= EPSILON_MM &&
    point.x >= Math.min(a.x, b.x) - EPSILON_MM &&
    point.x <= Math.max(a.x, b.x) + EPSILON_MM &&
    point.y >= Math.min(a.y, b.y) - EPSILON_MM &&
    point.y <= Math.max(a.y, b.y) + EPSILON_MM;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (((o1 > EPSILON_MM && o2 < -EPSILON_MM) || (o1 < -EPSILON_MM && o2 > EPSILON_MM)) &&
    ((o3 > EPSILON_MM && o4 < -EPSILON_MM) || (o3 < -EPSILON_MM && o4 > EPSILON_MM))) {
    return true;
  }
  return onSegment(a, b, c) || onSegment(a, b, d) ||
    onSegment(c, d, a) || onSegment(c, d, b);
}

export function lineSegmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function pointRectDistance(point: Point, rect: Extract<CopperFeature, { kind: "rect" }>): number {
  const dx = Math.max(Math.abs(point.x - rect.x) - rect.halfWidth, 0);
  const dy = Math.max(Math.abs(point.y - rect.y) - rect.halfHeight, 0);
  return Math.hypot(dx, dy);
}

function segmentRectDistance(
  segment: Extract<CopperFeature, { kind: "segment" }>,
  rect: Extract<CopperFeature, { kind: "rect" }>,
): number {
  if (pointRectDistance(segment.start, rect) === 0 || pointRectDistance(segment.end, rect) === 0) {
    return 0;
  }
  const corners: Point[] = [
    { x: rect.x - rect.halfWidth, y: rect.y - rect.halfHeight },
    { x: rect.x + rect.halfWidth, y: rect.y - rect.halfHeight },
    { x: rect.x + rect.halfWidth, y: rect.y + rect.halfHeight },
    { x: rect.x - rect.halfWidth, y: rect.y + rect.halfHeight },
  ];
  for (let index = 0; index < corners.length; index += 1) {
    if (segmentsIntersect(segment.start, segment.end, corners[index]!, corners[(index + 1) % 4]!)) {
      return 0;
    }
  }
  return Math.min(
    pointRectDistance(segment.start, rect),
    pointRectDistance(segment.end, rect),
    ...corners.map((corner) => pointSegmentDistance(corner, segment.start, segment.end)),
  );
}

function clearance(a: CopperFeature, b: CopperFeature): number {
  if (a.kind === "circle" && b.kind === "circle") {
    return Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
  }
  if (a.kind === "segment" && b.kind === "segment") {
    return lineSegmentDistance(a.start, a.end, b.start, b.end) - a.radius - b.radius;
  }
  if (a.kind === "circle" && b.kind === "segment") {
    return pointSegmentDistance(a, b.start, b.end) - a.radius - b.radius;
  }
  if (a.kind === "segment" && b.kind === "circle") return clearance(b, a);
  if (a.kind === "circle" && b.kind === "rect") {
    return pointRectDistance(a, b) - a.radius;
  }
  if (a.kind === "rect" && b.kind === "circle") return clearance(b, a);
  if (a.kind === "rect" && b.kind === "rect") {
    const dx = Math.max(Math.abs(a.x - b.x) - a.halfWidth - b.halfWidth, 0);
    const dy = Math.max(Math.abs(a.y - b.y) - a.halfHeight - b.halfHeight, 0);
    return Math.hypot(dx, dy);
  }
  if (a.kind === "segment" && b.kind === "rect") {
    return segmentRectDistance(a, b) - a.radius;
  }
  if (a.kind === "rect" && b.kind === "segment") return clearance(b, a);
  return Number.NEGATIVE_INFINITY;
}

function edgeClearance(
  feature: CopperFeature,
  board: { left: number; right: number; bottom: number; top: number },
): number {
  if (feature.kind === "circle") {
    return Math.min(
      feature.x - board.left,
      board.right - feature.x,
      feature.y - board.bottom,
      board.top - feature.y,
    ) - feature.radius;
  }
  if (feature.kind === "rect") {
    return Math.min(
      feature.x - feature.halfWidth - board.left,
      board.right - feature.x - feature.halfWidth,
      feature.y - feature.halfHeight - board.bottom,
      board.top - feature.y - feature.halfHeight,
    );
  }
  return Math.min(
    feature.start.x - feature.radius - board.left,
    board.right - feature.start.x - feature.radius,
    feature.start.y - feature.radius - board.bottom,
    board.top - feature.start.y - feature.radius,
    feature.end.x - feature.radius - board.left,
    board.right - feature.end.x - feature.radius,
    feature.end.y - feature.radius - board.bottom,
    board.top - feature.end.y - feature.radius,
  );
}

function containsFeature(container: AreaFeature, child: AreaFeature): boolean {
  if (container.kind === "circle" && child.kind === "circle") {
    return Math.hypot(container.x - child.x, container.y - child.y) + child.radius <=
      container.radius + EPSILON_MM;
  }
  if (container.kind === "rect" && child.kind === "rect") {
    return Math.abs(container.x - child.x) + child.halfWidth <=
        container.halfWidth + EPSILON_MM &&
      Math.abs(container.y - child.y) + child.halfHeight <=
        container.halfHeight + EPSILON_MM;
  }
  if (container.kind === "rect" && child.kind === "circle") {
    return Math.abs(container.x - child.x) + child.radius <=
        container.halfWidth + EPSILON_MM &&
      Math.abs(container.y - child.y) + child.radius <=
        container.halfHeight + EPSILON_MM;
  }
  if (container.kind === "circle" && child.kind === "rect") {
    return Math.hypot(
      Math.abs(container.x - child.x) + child.halfWidth,
      Math.abs(container.y - child.y) + child.halfHeight,
    ) <= container.radius + EPSILON_MM;
  }
  return false;
}

function idOf(element: AnyCircuitElement): string {
  const record = element as unknown as Record<string, unknown>;
  const primary = record[`${element.type}_id`];
  return typeof primary === "string" ? primary : element.type;
}

/** Exact allocation/work count for the geometry features emitted below. */
export function baselineGeometryWorkload(
  circuitJson: readonly AnyCircuitElement[],
): BaselineGeometryWorkload {
  const board = circuitJson.find((element) => element.type === "pcb_board");
  const boardLayerCount = board?.type === "pcb_board" && board.num_layers === 4 ? 4 : 2;
  const emittedCourtyardsByOwner = new Map<string, number>();
  let copperFeatures = 0;
  let maskFeatures = 0;
  let componentBodies = 0;
  let courtyards = 0;
  let keepouts = 0;
  for (const element of circuitJson) {
    if (element.type === "pcb_courtyard_rect") {
      const rotation = ((element.ccw_rotation ?? 0) % 360 + 360) % 360;
      if (rotation % 90 === 0) {
        courtyards += 1;
        emittedCourtyardsByOwner.set(
          element.pcb_component_id,
          (emittedCourtyardsByOwner.get(element.pcb_component_id) ?? 0) + 1,
        );
      }
    } else if (element.type === "pcb_keepout") {
      const record = element as unknown as Record<string, unknown>;
      const layers = Array.isArray(record.layers)
        ? record.layers
        : typeof record.layer === "string" ? [record.layer] : [];
      if (record.shape === "rect" && layers.length > 0) keepouts += 1;
    } else if (element.type === "pcb_component") {
      if (
        Number.isFinite(element.width) && Number.isFinite(element.height) &&
        element.width > 0 && element.height > 0 && element.do_not_place !== true
      ) componentBodies += 1;
    } else if (element.type === "pcb_smtpad") {
      if (element.shape === "circle" || element.shape === "rect") {
        copperFeatures += 1;
        if (!element.is_covered_with_solder_mask) maskFeatures += 1;
      }
    } else if (element.type === "pcb_plated_hole") {
      if (
        element.shape === "circle" || element.shape === "pill_hole_with_rect_pad" ||
        element.shape === "rotated_pill_hole_with_rect_pad"
      ) {
        copperFeatures += element.layers.length;
        if (!element.is_covered_with_solder_mask) {
          maskFeatures += element.layers.filter((layer) =>
            layer === "top" || layer === "bottom"
          ).length;
        }
      }
    } else if (element.type === "pcb_via") {
      copperFeatures += element.layers.length;
      if (element.is_tented === false) maskFeatures += 2;
    } else if (element.type === "pcb_hole") {
      if (element.hole_shape === "circle") {
        copperFeatures += boardLayerCount;
        maskFeatures += 2;
      }
    } else if (element.type === "pcb_trace") {
      for (let index = 1; index < element.route.length; index += 1) {
        const previous = element.route[index - 1]!;
        const current = element.route[index]!;
        if (
          previous.route_type === "wire" && current.route_type === "wire" &&
          previous.layer === current.layer
        ) copperFeatures += 1;
        else if (current.route_type === "through_pad") copperFeatures += 2;
      }
    }
  }
  for (const element of circuitJson) {
    if (
      element.type === "pcb_component" &&
      (emittedCourtyardsByOwner.get(element.pcb_component_id) ?? 0) === 0 &&
      Number.isFinite(element.width) && Number.isFinite(element.height) &&
      element.width > 0 && element.height > 0
    ) {
      courtyards += 1;
      emittedCourtyardsByOwner.set(element.pcb_component_id, 1);
    }
  }
  return Object.freeze({
    copperFeatures,
    maskFeatures,
    componentBodies,
    courtyards,
    keepouts,
    pairwiseFeatures: Math.max(copperFeatures, maskFeatures, componentBodies, courtyards, keepouts),
  });
}

export function assessBaselineGeometry(
  circuitJson: readonly AnyCircuitElement[],
  profile: BaselineFabricationProfile,
  authoritativeConnectivity?: AuthoritativeConnectivity,
): FabricationGeometryAssessment {
  const copper: CopperFeature[] = [];
  const mask: CopperFeature[] = [];
  const paste = new Map<string, AreaFeature>();
  const courtyards: Extract<CopperFeature, { kind: "rect" }>[] = [];
  const keepouts: Extract<CopperFeature, { kind: "rect" }>[] = [];
  const unsupported = new Set<string>();
  const netIdentity = new Set<string>();
  const geometryIdentity = new Set<string>();
  const primaryIdentities = new Map<string, string[]>();
  for (const element of circuitJson) {
    if (!element.type.startsWith("pcb_")) continue;
    const record = element as unknown as Record<string, unknown>;
    const primary = record[`${element.type}_id`];
    if (typeof primary !== "string" || primary.trim() === "") {
      geometryIdentity.add(`${element.type}:missing-primary-id`);
      continue;
    }
    const types = primaryIdentities.get(primary) ?? [];
    types.push(element.type);
    primaryIdentities.set(primary, types);
  }
  for (const [identity, types] of primaryIdentities) {
    if (types.length > 1) {
      geometryIdentity.add(`${identity}:count:${types.length}:types:${types.sort().join(",")}`);
    }
  }
  const boards = circuitJson.filter((element) => element.type === "pcb_board");
  if (boards.length !== 1) unsupported.add(`pcb-board-count:${boards.length}`);
  const boardElement = boards[0];
  if (boardElement?.type === "pcb_board") {
    const boardRecord = boardElement as unknown as Record<string, unknown>;
    if (
      boardRecord.outline !== undefined ||
      (boardRecord.shape !== undefined && boardRecord.shape !== "rect")
    ) unsupported.add(`${boardElement.pcb_board_id}:custom-board-outline`);
  }
  const center = boardElement?.type === "pcb_board" ? boardElement.center : { x: 0, y: 0 };
  const width = boardElement?.type === "pcb_board" ? (boardElement.width ?? 0) : 0;
  const height = boardElement?.type === "pcb_board" ? (boardElement.height ?? 0) : 0;
  const board = {
    left: center.x - width / 2,
    right: center.x + width / 2,
    bottom: center.y - height / 2,
    top: center.y + height / 2,
  };
  const boardLayers = boardElement?.type === "pcb_board" && boardElement.num_layers === 4
    ? ["top", "inner1", "inner2", "bottom"]
    : ["top", "bottom"];

  const pcbTraces = circuitJson.filter((element) => element.type === "pcb_trace");
  const pcbTracesById = new Map<string, typeof pcbTraces>();
  for (const trace of pcbTraces) {
    const traces = pcbTracesById.get(trace.pcb_trace_id) ?? [];
    traces.push(trace);
    pcbTracesById.set(trace.pcb_trace_id, traces);
  }
  const padNet = (pcbPortId: string): string => {
    return authoritativeConnectivity?.netForPcbPortId(pcbPortId) ??
      `unresolved-port:${pcbPortId}`;
  };
  const traceNet = (trace: (typeof pcbTraces)[number]): string => {
    return authoritativeConnectivity?.netForPcbTraceId(trace.pcb_trace_id) ??
      `unresolved-copper:${trace.pcb_trace_id}`;
  };

  for (const element of circuitJson) {
    const id = idOf(element);
    if (element.type === "pcb_keepout") {
      const record = element as unknown as Record<string, unknown>;
      const keepoutCenter = record.center as { x?: unknown; y?: unknown } | undefined;
      const keepoutLayers = Array.isArray(record.layers)
        ? record.layers
        : typeof record.layer === "string" ? [record.layer] : [];
      if (
        record.shape !== "rect" || keepoutCenter === undefined ||
        typeof keepoutCenter.x !== "number" || !Number.isFinite(keepoutCenter.x) ||
        typeof keepoutCenter.y !== "number" || !Number.isFinite(keepoutCenter.y) ||
        typeof record.width !== "number" || !Number.isFinite(record.width) || record.width <= 0 ||
        typeof record.height !== "number" || !Number.isFinite(record.height) || record.height <= 0 ||
        keepoutLayers.length === 0 || !keepoutLayers.every((layer) => typeof layer === "string") ||
        new Set(keepoutLayers).size !== keepoutLayers.length ||
        keepoutLayers.some((layer) => !boardLayers.includes(layer as string))
      ) {
        unsupported.add(`${id}:keepout-geometry-or-layers`);
        continue;
      }
      for (const layer of keepoutLayers as string[]) {
        const keepout = {
          kind: "rect" as const,
          id,
          net: `keepout:${id}`,
          layer,
          x: keepoutCenter.x,
          y: keepoutCenter.y,
          halfWidth: record.width / 2,
          halfHeight: record.height / 2,
        };
        if (edgeClearance(keepout, board) < -EPSILON_MM) {
          unsupported.add(`${id}:keepout-outside-board`);
        } else {
          keepouts.push(keepout);
        }
      }
    } else if (element.type.includes("keepout")) {
      unsupported.add(`${id}:${element.type}`);
    } else if (element.type === "pcb_courtyard_rect") {
      const rotation = ((element.ccw_rotation ?? 0) % 360 + 360) % 360;
      if (rotation % 90 !== 0) {
        unsupported.add(`${id}:courtyard-rotation:${rotation}`);
      } else {
        const swapsAxes = rotation === 90 || rotation === 270;
        courtyards.push({
          kind: "rect",
          id,
          net: element.pcb_component_id,
          layer: element.layer,
          x: element.center.x,
          y: element.center.y,
          halfWidth: (swapsAxes ? element.height : element.width) / 2,
          halfHeight: (swapsAxes ? element.width : element.height) / 2,
        });
      }
    } else if (element.type.includes("courtyard")) {
      unsupported.add(`${id}:${element.type}`);
    } else if (element.type === "pcb_smtpad") {
      const net = typeof element.pcb_port_id === "string"
        ? padNet(element.pcb_port_id)
        : `unresolved-pad:${id}`;
      let feature: CopperFeature | undefined;
      if (element.shape === "rect") {
        feature = { kind: "rect", id, net, layer: element.layer, x: element.x, y: element.y, halfWidth: element.width / 2, halfHeight: element.height / 2 };
      } else if (element.shape === "circle") {
        feature = { kind: "circle", id, net, layer: element.layer, x: element.x, y: element.y, radius: element.radius };
      } else unsupported.add(`${id}:pad-shape`);
      if (feature !== undefined) {
        copper.push(feature);
        if (!element.is_covered_with_solder_mask) {
          const margin = element.soldermask_margin ?? 0;
          if (feature.kind === "rect") {
            const sideMargins = element as typeof element & {
              soldermask_margin_left?: number;
              soldermask_margin_right?: number;
              soldermask_margin_top?: number;
              soldermask_margin_bottom?: number;
            };
            const left = sideMargins.soldermask_margin_left ?? margin;
            const right = sideMargins.soldermask_margin_right ?? margin;
            const top = sideMargins.soldermask_margin_top ?? margin;
            const bottom = sideMargins.soldermask_margin_bottom ?? margin;
            mask.push({
              ...feature,
              x: feature.x + (right - left) / 2,
              y: feature.y + (top - bottom) / 2,
              halfWidth: feature.halfWidth + (left + right) / 2,
              halfHeight: feature.halfHeight + (top + bottom) / 2,
            });
          } else if (feature.kind === "circle") {
            mask.push({ ...feature, radius: feature.radius + margin });
          }
        }
      }
    } else if (element.type === "pcb_plated_hole") {
      const isRectSlot = element.shape === "pill_hole_with_rect_pad" ||
        element.shape === "rotated_pill_hole_with_rect_pad";
      if (element.shape !== "circle" && !isRectSlot) {
        unsupported.add(`${id}:plated-hole-shape`);
        continue;
      }
      const portNet = typeof element.pcb_port_id === "string"
        ? padNet(element.pcb_port_id)
        : undefined;
      const declaredNet = (element as unknown as { subcircuit_connectivity_map_key?: string })
        .subcircuit_connectivity_map_key;
      const declaredIdentity = declaredNet === undefined
        ? undefined
        : authoritativeConnectivity?.netForRawConnectivityKey(declaredNet);
      if (portNet !== undefined && declaredNet !== undefined && declaredIdentity !== portNet) {
        netIdentity.add(`${id}:connectivity-map-key`);
      }
      const net = portNet ?? declaredIdentity ?? `unresolved-copper:${id}`;
      const slotPadWidth = isRectSlot && element.shape === "rotated_pill_hole_with_rect_pad"
        ? element.rect_pad_height
        : isRectSlot ? element.rect_pad_width : 0;
      const slotPadHeight = isRectSlot && element.shape === "rotated_pill_hole_with_rect_pad"
        ? element.rect_pad_width
        : isRectSlot ? element.rect_pad_height : 0;
      for (const layer of element.layers) {
        const feature: CopperFeature = isRectSlot
          ? {
              kind: "rect",
              id,
              net,
              layer,
              x: element.x,
              y: element.y,
              halfWidth: slotPadWidth / 2,
              halfHeight: slotPadHeight / 2,
            }
          : { kind: "circle", id, net, layer, x: element.x, y: element.y, radius: element.outer_diameter / 2 };
        copper.push(feature);
        if (!element.is_covered_with_solder_mask && (layer === "top" || layer === "bottom")) {
          const margin = element.soldermask_margin ?? 0;
          mask.push(feature.kind === "circle"
            ? { ...feature, radius: feature.radius + margin }
            : { ...feature, halfWidth: feature.halfWidth + margin, halfHeight: feature.halfHeight + margin });
        }
      }
    } else if (element.type === "pcb_via") {
      const owner = typeof element.pcb_trace_id === "string"
        ? pcbTracesById.get(element.pcb_trace_id)
        : undefined;
      const sourceNetIdentity = typeof element.source_net_id === "string"
        ? authoritativeConnectivity?.netForSourceNetId(element.source_net_id)
        : undefined;
      const authoritativeNet = owner?.length === 1
        ? traceNet(owner[0]!)
        : sourceNetIdentity;
      const declaredIdentity = element.subcircuit_connectivity_map_key === undefined
        ? undefined
        : authoritativeConnectivity?.netForRawConnectivityKey(
          element.subcircuit_connectivity_map_key,
        );
      if (
        authoritativeNet !== undefined &&
        element.subcircuit_connectivity_map_key !== undefined &&
        declaredIdentity !== authoritativeNet
      ) netIdentity.add(`${id}:connectivity-map-key`);
      if (element.source_net_id !== undefined && sourceNetIdentity === undefined) {
        netIdentity.add(`${id}:source-net:${element.source_net_id}`);
      }
      const net = authoritativeNet ?? declaredIdentity ??
        element.source_net_id ?? `unresolved-copper:${id}`;
      for (const layer of element.layers) {
        copper.push({ kind: "circle", id, net, layer, x: element.x, y: element.y, radius: element.outer_diameter / 2 });
      }
      if (element.is_tented === false) {
        for (const layer of ["top", "bottom"]) {
          mask.push({ kind: "circle", id, net, layer, x: element.x, y: element.y, radius: element.outer_diameter / 2 });
        }
      }
    } else if (element.type === "pcb_hole") {
      if (element.hole_shape !== "circle") {
        unsupported.add(`${id}:hole-shape`);
        continue;
      }
      for (const layer of boardLayers) {
        copper.push({ kind: "circle", id, net: `mechanical-hole:${id}`, layer, x: element.x, y: element.y, radius: element.hole_diameter / 2 });
        if (layer === "top" || layer === "bottom") {
          mask.push({
            kind: "circle",
            id,
            net: `mask-hole:${id}`,
            layer,
            x: element.x,
            y: element.y,
            radius: element.hole_diameter / 2 + (element.soldermask_margin ?? 0),
          });
        }
      }
    } else if (element.type === "pcb_trace") {
      const net = traceNet(element);
      for (let index = 1; index < element.route.length; index += 1) {
        const previous = element.route[index - 1]!;
        const current = element.route[index]!;
        if (previous.route_type === "wire" && current.route_type === "wire" && previous.layer === current.layer) {
          copper.push({
            kind: "segment",
            id: `${id}:segment:${index - 1}`,
            net,
            layer: current.layer,
            start: { x: previous.x, y: previous.y },
            end: { x: current.x, y: current.y },
            radius: Math.max(previous.width, current.width) / 2,
          });
        } else if (current.route_type === "through_pad") {
          copper.push({
            kind: "segment",
            id: `${id}:through-pad:${index}`,
            net,
            layer: "top",
            start: current.start,
            end: current.end,
            radius: current.width / 2,
          });
          copper.push({
            kind: "segment",
            id: `${id}:through-pad:${index}`,
            net,
            layer: "bottom",
            start: current.start,
            end: current.end,
            radius: current.width / 2,
          });
        }
      }
    } else if (element.type === "pcb_solder_paste") {
      if (element.layer !== "top" && element.layer !== "bottom") {
        unsupported.add(`${id}:paste-layer:${element.layer}`);
      } else if (element.shape === "circle") {
        const feature: CopperFeature = {
          kind: "circle",
          id,
          net: `paste:${id}`,
          layer: element.layer,
          x: element.x,
          y: element.y,
          radius: element.radius,
        };
        paste.set(id, feature);
        if (edgeClearance(feature, board) < -EPSILON_MM) unsupported.add(`${id}:paste-outside-board`);
      } else if (element.shape === "rect") {
        const feature: CopperFeature = {
          kind: "rect",
          id,
          net: `paste:${id}`,
          layer: element.layer,
          x: element.x,
          y: element.y,
          halfWidth: element.width / 2,
          halfHeight: element.height / 2,
        };
        paste.set(id, feature);
        if (edgeClearance(feature, board) < -EPSILON_MM) unsupported.add(`${id}:paste-outside-board`);
      } else unsupported.add(`${id}:paste-shape`);
    } else if (
      element.type === "pcb_board" || element.type === "pcb_component" ||
      element.type === "pcb_port" || element.type === "pcb_silkscreen_path" ||
      element.type === "pcb_silkscreen_text" || element.type.endsWith("_warning") ||
      element.type.endsWith("_error")
    ) {
      // These records are checked elsewhere in this profile, by the electrical
      // assessor, or by exact artifact reconciliation.
    } else if (element.type.startsWith("pcb_")) {
      unsupported.add(`${id}:${element.type}`);
    }
  }

  const components = circuitJson.filter((element) => element.type === "pcb_component");
  const componentsById = new Map<string, typeof components>();
  for (const component of components) {
    const owners = componentsById.get(component.pcb_component_id) ?? [];
    owners.push(component);
    componentsById.set(component.pcb_component_id, owners);
  }
  const courtyardsByOwner = new Map<string, typeof courtyards>();
  for (const courtyard of courtyards) {
    const owned = courtyardsByOwner.get(courtyard.net) ?? [];
    owned.push(courtyard);
    courtyardsByOwner.set(courtyard.net, owned);
  }
  for (const component of components) {
    const emitted = courtyardsByOwner.get(component.pcb_component_id) ?? [];
    if (emitted.length > 1) {
      unsupported.add(`${component.pcb_component_id}:multiple-courtyards:${emitted.length}`);
      continue;
    }
    if (emitted.length === 0) {
      if (
        !Number.isFinite(component.width) || !Number.isFinite(component.height) ||
        component.width <= 0 || component.height <= 0
      ) {
        unsupported.add(`${component.pcb_component_id}:courtyard-fallback-bounds`);
        continue;
      }
      courtyards.push({
        kind: "rect",
        id: `${component.pcb_component_id}:component-bounds`,
        net: component.pcb_component_id,
        layer: component.layer,
        x: component.center.x,
        y: component.center.y,
        halfWidth: component.width / 2,
        halfHeight: component.height / 2,
      });
      courtyardsByOwner.set(component.pcb_component_id, [courtyards.at(-1)!]);
    }
  }

  if (copper.length > 20_000) unsupported.add(`copper-feature-count:${copper.length}`);
  const copperClearance = new BoundedPairFindings();
  if (copper.length <= 20_000) {
    for (let left = 0; left < copper.length; left += 1) {
      for (let right = left + 1; right < copper.length; right += 1) {
        const a = copper[left]!;
        const b = copper[right]!;
        if (a.layer !== b.layer || a.net === b.net) continue;
        const actual = clearance(a, b);
        if (below(actual, profile.minimumCopperClearanceMm)) {
          copperClearance.add(`${a.layer}:${a.id}:${b.id}:${actual.toFixed(6)}mm`);
        }
      }
    }
  }

  const edgeViolations = new Set<string>();
  for (const feature of copper) {
    const actual = edgeClearance(feature, board);
    if (below(actual, profile.minimumCopperEdgeClearanceMm)) {
      edgeViolations.add(`${feature.layer}:${feature.id}:${actual.toFixed(6)}mm`);
    }
  }

  const keepoutViolations = new BoundedPairFindings();
  for (const keepout of keepouts) {
    for (const feature of copper) {
      if (keepout.layer !== feature.layer) continue;
      const actual = clearance(keepout, feature);
      if (actual <= EPSILON_MM) {
        keepoutViolations.add(`${keepout.layer}:${keepout.id}:${feature.id}:${actual.toFixed(6)}mm`);
      }
    }
  }

  const maskSliver = new BoundedPairFindings();
  for (const feature of mask) {
    if (
      (feature.kind === "circle" && feature.radius <= 0) ||
      (feature.kind === "rect" && (feature.halfWidth <= 0 || feature.halfHeight <= 0))
    ) maskSliver.add(`${feature.layer}:${feature.id}:non-positive-mask-opening`);
  }
  for (let left = 0; left < mask.length; left += 1) {
    for (let right = left + 1; right < mask.length; right += 1) {
      const a = mask[left]!;
      const b = mask[right]!;
      if (a.layer !== b.layer || a.id === b.id) continue;
      const actual = clearance(a, b);
      if (below(actual, profile.minimumMaskSliverMm)) {
        maskSliver.add(`${a.layer}:${a.id}:${b.id}:${actual.toFixed(6)}mm`);
      }
    }
  }

  const componentPlacement = new Set<string>();
  for (const component of components) {
    if (
      !Number.isFinite(component.width) || !Number.isFinite(component.height) ||
      component.width <= 0 || component.height <= 0
    ) {
      componentPlacement.add(`${component.pcb_component_id}:invalid-bounds`);
      continue;
    }
    const clearanceToEdge = Math.min(
      component.center.x - component.width / 2 - board.left,
      board.right - component.center.x - component.width / 2,
      component.center.y - component.height / 2 - board.bottom,
      board.top - component.center.y - component.height / 2,
    );
    if (!component.is_allowed_to_be_off_board && below(clearanceToEdge, 0)) {
      componentPlacement.add(`${component.pcb_component_id}:${clearanceToEdge.toFixed(6)}mm`);
    }
  }

  const courtyardOverlap = new BoundedPairFindings();
  for (let left = 0; left < courtyards.length; left += 1) {
    for (let right = left + 1; right < courtyards.length; right += 1) {
      const a = courtyards[left]!;
      const b = courtyards[right]!;
      if (a.layer !== b.layer) continue;
      if (
        Math.abs(a.x - b.x) + EPSILON_MM < a.halfWidth + b.halfWidth &&
        Math.abs(a.y - b.y) + EPSILON_MM < a.halfHeight + b.halfHeight
      ) courtyardOverlap.add(`${a.layer}:${a.id}:${b.id}`);
    }
  }

  const componentOverlap = new BoundedPairFindings();
  const componentBodies = components.flatMap((component) =>
    Number.isFinite(component.width) && Number.isFinite(component.height) &&
      component.width > 0 && component.height > 0 &&
      component.do_not_place !== true
      ? [{
          kind: "rect" as const,
          id: component.pcb_component_id,
          net: component.pcb_component_id,
          layer: component.layer,
          x: component.center.x,
          y: component.center.y,
          halfWidth: component.width / 2,
          halfHeight: component.height / 2,
        }]
      : []
  );
  for (let left = 0; left < componentBodies.length; left += 1) {
    for (let right = left + 1; right < componentBodies.length; right += 1) {
      const a = componentBodies[left]!;
      const b = componentBodies[right]!;
      if (a.layer !== b.layer) continue;
      if (
        Math.abs(a.x - b.x) + EPSILON_MM < a.halfWidth + b.halfWidth &&
        Math.abs(a.y - b.y) + EPSILON_MM < a.halfHeight + b.halfHeight
      ) componentOverlap.add(`${a.layer}:${a.id}:${b.id}`);
    }
  }

  const courtyardEdge = new Set<string>();
  for (const courtyard of courtyards) {
    const owner = componentsById.get(courtyard.net);
    if (owner?.length === 1 && owner[0]!.is_allowed_to_be_off_board === true) continue;
    const actual = edgeClearance(courtyard, board);
    if (below(actual, 0)) courtyardEdge.add(`${courtyard.layer}:${courtyard.id}:${actual.toFixed(6)}mm`);
  }

  const courtyardIntegrity = new Set<string>();
  const courtyardsById = new Map<string, typeof courtyards>();
  for (const courtyard of courtyards) {
    const sameId = courtyardsById.get(courtyard.id) ?? [];
    sameId.push(courtyard);
    courtyardsById.set(courtyard.id, sameId);
  }
  for (const declared of circuitJson.filter((element) => element.type === "pcb_courtyard_rect")) {
    const owners = componentsById.get(declared.pcb_component_id) ?? [];
    const geometry = courtyardsById.get(declared.pcb_courtyard_rect_id)?.[0];
    if (owners.length !== 1) {
      courtyardIntegrity.add(`${declared.pcb_courtyard_rect_id}:owner-count:${owners.length}`);
      continue;
    }
    const owner = owners[0]!;
    if (owner.layer !== declared.layer) {
      courtyardIntegrity.add(`${declared.pcb_courtyard_rect_id}:owner-side:${owner.layer}:${declared.layer}`);
    }
    if (
      geometry !== undefined && owner.width > 0 && owner.height > 0 &&
      !containsFeature(geometry, {
        kind: "rect",
        id: owner.pcb_component_id,
        net: owner.pcb_component_id,
        layer: owner.layer,
        x: owner.center.x,
        y: owner.center.y,
        halfWidth: owner.width / 2,
        halfHeight: owner.height / 2,
      })
    ) courtyardIntegrity.add(`${declared.pcb_courtyard_rect_id}:does-not-contain-owner`);
  }

  const pasteAperture = new Set<string>();
  const smtPads = circuitJson.filter((element) => element.type === "pcb_smtpad");
  const platedHoles = circuitJson.filter((element) => element.type === "pcb_plated_hole");
  const nonPlatedHoles = circuitJson.filter((element) => element.type === "pcb_hole");
  const smtPadsById = new Map<string, typeof smtPads>();
  for (const pad of smtPads) {
    const values = smtPadsById.get(pad.pcb_smtpad_id) ?? [];
    values.push(pad);
    smtPadsById.set(pad.pcb_smtpad_id, values);
  }
  const parentFeature = (
    parent: (typeof smtPads)[number] | (typeof platedHoles)[number],
    layer: string,
  ): AreaFeature | undefined => {
    const parentId = idOf(parent);
    const net = `paste-parent:${parentId}`;
    if (parent.type === "pcb_smtpad") {
      if (parent.layer !== layer) return undefined;
      if (parent.shape === "circle") {
        return { kind: "circle", id: parentId, net, layer, x: parent.x, y: parent.y, radius: parent.radius };
      }
      if (parent.shape === "rect") {
        return {
          kind: "rect",
          id: parentId,
          net,
          layer,
          x: parent.x,
          y: parent.y,
          halfWidth: parent.width / 2,
          halfHeight: parent.height / 2,
        };
      }
      return undefined;
    }
    if (!parent.layers.includes(layer as never)) return undefined;
    if (parent.shape === "circle") {
      return {
        kind: "circle", id: parentId, net, layer,
        x: parent.x, y: parent.y, radius: parent.outer_diameter / 2,
      };
    }
    if (
      parent.shape === "pill_hole_with_rect_pad" ||
      parent.shape === "rotated_pill_hole_with_rect_pad"
    ) {
      const rotated = parent.shape === "rotated_pill_hole_with_rect_pad";
      return {
        kind: "rect", id: parentId, net, layer, x: parent.x, y: parent.y,
        halfWidth: (rotated ? parent.rect_pad_height : parent.rect_pad_width) / 2,
        halfHeight: (rotated ? parent.rect_pad_width : parent.rect_pad_height) / 2,
      };
    }
    return undefined;
  };
  type PasteParent = (typeof smtPads)[number] | (typeof platedHoles)[number];
  const pasteParentsByLocation = new Map<string, PasteParent[]>();
  const pasteLocationKey = (layer: string, x: number, y: number): string =>
    `${layer}:${Math.floor(x / EPSILON_MM)}:${Math.floor(y / EPSILON_MM)}`;
  const indexPasteParent = (parent: PasteParent, layer: string): void => {
    const feature = parentFeature(parent, layer);
    if (feature === undefined) return;
    const key = pasteLocationKey(layer, feature.x, feature.y);
    const values = pasteParentsByLocation.get(key) ?? [];
    values.push(parent);
    pasteParentsByLocation.set(key, values);
  };
  for (const parent of smtPads) indexPasteParent(parent, parent.layer);
  for (const parent of platedHoles) {
    for (const layer of parent.layers) indexPasteParent(parent, layer);
  }
  const nearbyPasteParents = (feature: AreaFeature): PasteParent[] => {
    const xBucket = Math.floor(feature.x / EPSILON_MM);
    const yBucket = Math.floor(feature.y / EPSILON_MM);
    const values: PasteParent[] = [];
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        values.push(...(pasteParentsByLocation.get(
          `${feature.layer}:${xBucket + xOffset}:${yBucket + yOffset}`,
        ) ?? []));
      }
    }
    return values;
  };
  for (const aperture of circuitJson.filter((element) => element.type === "pcb_solder_paste")) {
    const apertureId = aperture.pcb_solder_paste_id;
    const feature = paste.get(apertureId);
    if (feature === undefined) continue;
    const possibleParents = aperture.pcb_smtpad_id === undefined
      ? nearbyPasteParents(feature)
      : (smtPadsById.get(aperture.pcb_smtpad_id) ?? []);
    const matches = possibleParents.filter((parent) => {
      const candidate = parentFeature(parent, aperture.layer);
      if (candidate === undefined || !containsFeature(candidate, feature)) return false;
      if (
        Math.abs(candidate.x - feature.x) > EPSILON_MM ||
        Math.abs(candidate.y - feature.y) > EPSILON_MM
      ) return false;
      if (
        parent.pcb_component_id !== null && parent.pcb_component_id !== undefined &&
        (componentsById.get(parent.pcb_component_id)?.length ?? 0) !== 1
      ) return false;
      return aperture.pcb_component_id === null || aperture.pcb_component_id === undefined ||
        parent.pcb_component_id === aperture.pcb_component_id;
    });
    if (matches.length !== 1) {
      pasteAperture.add(`${apertureId}:parent-count:${matches.length}`);
    }
  }
  const pasteCompleteness = new Set<string>();
  const pasteApertures = circuitJson.filter((element) => element.type === "pcb_solder_paste");
  const pasteCountsByPadId = new Map<string, number>();
  for (const aperture of pasteApertures) {
    if (aperture.pcb_smtpad_id === undefined) continue;
    pasteCountsByPadId.set(
      aperture.pcb_smtpad_id,
      (pasteCountsByPadId.get(aperture.pcb_smtpad_id) ?? 0) + 1,
    );
  }
  for (const pad of smtPads) {
    if (pad.shape !== "circle" && pad.shape !== "rect") continue;
    if (pad.pcb_component_id === null || pad.pcb_component_id === undefined) continue;
    const owners = componentsById.get(pad.pcb_component_id) ?? [];
    if (owners.length !== 1) {
      pasteCompleteness.add(`${pad.pcb_smtpad_id}:owner-count:${owners.length}`);
      continue;
    }
    if (owners[0]!.do_not_place === true) continue;
    const count = pasteCountsByPadId.get(pad.pcb_smtpad_id) ?? 0;
    if (count !== 1) pasteCompleteness.add(`${pad.pcb_smtpad_id}:paste-count:${count}`);
  }
  const padOwnerIntegrity = new Set<string>();
  const pcbPorts = circuitJson.filter((element) => element.type === "pcb_port");
  const pcbPortsById = new Map<string, typeof pcbPorts>();
  for (const port of pcbPorts) {
    const values = pcbPortsById.get(port.pcb_port_id) ?? [];
    values.push(port);
    pcbPortsById.set(port.pcb_port_id, values);
  }
  for (const pad of smtPads) {
    if (pad.pcb_component_id === null || pad.pcb_component_id === undefined) {
      padOwnerIntegrity.add(`${pad.pcb_smtpad_id}:owner-missing`);
      continue;
    }
    const owners = componentsById.get(pad.pcb_component_id) ?? [];
    if (owners.length !== 1) {
      padOwnerIntegrity.add(`${pad.pcb_smtpad_id}:owner-count:${owners.length}`);
      continue;
    }
    const owner = owners[0]!;
    if (pad.layer !== owner.layer) {
      padOwnerIntegrity.add(`${pad.pcb_smtpad_id}:owner-side:${owner.layer}:${pad.layer}`);
    }
    const ownerCourtyards = courtyardsByOwner.get(owner.pcb_component_id) ?? [];
    const padGeometry = parentFeature(pad, pad.layer);
    if (
      ownerCourtyards.length !== 1 || padGeometry === undefined ||
      !containsFeature(ownerCourtyards[0]!, padGeometry)
    ) padOwnerIntegrity.add(`${pad.pcb_smtpad_id}:outside-owner-courtyard`);
    if (
      pad.port_hints?.includes("pcboo:mechanical") !== true &&
      pad.pcb_port_id !== undefined
    ) {
      const ports = pcbPortsById.get(pad.pcb_port_id) ?? [];
      if (
        ports.length !== 1 || ports[0]!.pcb_component_id !== owner.pcb_component_id ||
        ports[0]!.layers.length !== 1 || ports[0]!.layers[0] !== pad.layer
      ) padOwnerIntegrity.add(`${pad.pcb_smtpad_id}:pcb-port-side-or-owner`);
    }
  }
  for (const hole of platedHoles) {
    if (hole.pcb_component_id === null || hole.pcb_component_id === undefined) {
      padOwnerIntegrity.add(`${hole.pcb_plated_hole_id}:owner-missing`);
      continue;
    }
    const owners = componentsById.get(hole.pcb_component_id) ?? [];
    if (owners.length !== 1) {
      padOwnerIntegrity.add(`${hole.pcb_plated_hole_id}:owner-count:${owners.length}`);
      continue;
    }
    const owner = owners[0]!;
    const ownerCourtyards = courtyardsByOwner.get(owner.pcb_component_id) ?? [];
    const holeGeometry = parentFeature(hole, owner.layer);
    if (
      ownerCourtyards.length !== 1 || holeGeometry === undefined ||
      !containsFeature(ownerCourtyards[0]!, holeGeometry)
    ) padOwnerIntegrity.add(`${hole.pcb_plated_hole_id}:outside-owner-courtyard`);
    if (hole.port_hints?.includes("pcboo:mechanical") !== true) {
      if (hole.pcb_port_id === undefined) {
        padOwnerIntegrity.add(`${hole.pcb_plated_hole_id}:missing-pcb-port`);
        continue;
      }
      const ports = pcbPortsById.get(hole.pcb_port_id) ?? [];
      const holeLayers = new Set<string>(hole.layers);
      const portLayers = ports.length === 1 ? new Set<string>(ports[0]!.layers) : new Set<string>();
      if (
        ports.length !== 1 || ports[0]!.pcb_component_id !== owner.pcb_component_id ||
        holeLayers.size !== hole.layers.length || portLayers.size !== ports[0]!.layers.length ||
        holeLayers.size !== portLayers.size ||
        [...holeLayers].some((layer) => !portLayers.has(layer))
      ) padOwnerIntegrity.add(`${hole.pcb_plated_hole_id}:pcb-port-layers-or-owner`);
    }
  }
  for (const hole of nonPlatedHoles) {
    if (hole.pcb_component_id === null || hole.pcb_component_id === undefined) continue;
    const owners = componentsById.get(hole.pcb_component_id) ?? [];
    if (owners.length !== 1) {
      padOwnerIntegrity.add(`${hole.pcb_hole_id}:owner-count:${owners.length}`);
      continue;
    }
    const owner = owners[0]!;
    const ownerCourtyards = courtyardsByOwner.get(owner.pcb_component_id) ?? [];
    const holeGeometry: AreaFeature | undefined = hole.hole_shape === "circle"
      ? {
        kind: "circle",
        id: hole.pcb_hole_id,
        net: `mechanical-hole:${hole.pcb_hole_id}`,
        layer: owner.layer,
        x: hole.x,
        y: hole.y,
        radius: hole.hole_diameter / 2,
      }
      : undefined;
    if (
      ownerCourtyards.length !== 1 || holeGeometry === undefined ||
      !containsFeature(ownerCourtyards[0]!, holeGeometry)
    ) padOwnerIntegrity.add(`${hole.pcb_hole_id}:outside-owner-courtyard`);
  }

  return Object.freeze({
    copperClearance: copperClearance.toArray("copper-clearance"),
    edgeClearance: Object.freeze([...edgeViolations].sort()),
    maskSliver: maskSliver.toArray("mask-sliver"),
    componentPlacement: Object.freeze([...componentPlacement].sort()),
    componentOverlap: componentOverlap.toArray("component-overlap"),
    courtyardOverlap: courtyardOverlap.toArray("courtyard-overlap"),
    courtyardEdge: Object.freeze([...courtyardEdge].sort()),
    courtyardIntegrity: Object.freeze([...courtyardIntegrity].sort()),
    pasteAperture: Object.freeze([...pasteAperture].sort()),
    pasteCompleteness: Object.freeze([...pasteCompleteness].sort()),
    padOwnerIntegrity: Object.freeze([...padOwnerIntegrity].sort()),
    geometryIdentity: Object.freeze([...geometryIdentity].sort()),
    netIdentity: Object.freeze([...netIdentity].sort()),
    keepoutViolations: keepoutViolations.toArray("keepout"),
    unsupported: Object.freeze([...unsupported].sort()),
  });
}
