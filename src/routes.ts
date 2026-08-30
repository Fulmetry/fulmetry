// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import type {
  AnyCircuitElement,
  PcbTraceRoutePoint,
  PcbTraceRoutePointVia,
  PcbTraceRoutePointWire,
} from "circuit-json";
import { PcbTrace } from "tscircuit";
import { compareUtf16 } from "./internal/canonical-json";

export type PcbCopperLayer =
  | "top"
  | "inner1"
  | "inner2"
  | "inner3"
  | "inner4"
  | "inner5"
  | "inner6"
  | "inner7"
  | "inner8"
  | "bottom";

export interface SemanticPortSelector {
  readonly component: string;
  readonly port: string | number;
}

export interface SemanticPcbRouteDefinition {
  /** Stable authored identity; never a generated Circuit JSON id. */
  readonly name: string;
  /** Stable source-net name, for example USB_DP or GND. */
  readonly net: string;
  readonly from: SemanticPortSelector;
  readonly to: SemanticPortSelector;
  /** Absolute board coordinates. Endpoint coordinates are snapped to from/to. */
  readonly route: readonly PcbTraceRoutePoint[];
}

export interface ResolvedSemanticPcbRoute {
  readonly name: string;
  readonly sourceTraceId: string;
  readonly sourceNetId: string;
  readonly subcircuitId?: string;
  readonly connectsTo: readonly [string, string];
  readonly route: readonly PcbTraceRoutePoint[];
  readonly vias: readonly Readonly<{
    x: number;
    y: number;
    holeDiameter: number;
    outerDiameter: number;
    fromLayer: PcbCopperLayer;
    toLayer: PcbCopperLayer;
    layers: readonly PcbCopperLayer[];
  }>[];
}

function nonEmpty(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

export function port(component: string, nameOrPin: string | number): SemanticPortSelector {
  nonEmpty(component, "Semantic port component");
  if (
    (typeof nameOrPin !== "string" || nameOrPin.trim() === "") &&
    (!Number.isSafeInteger(nameOrPin) || (nameOrPin as number) < 1)
  ) throw new TypeError("Semantic port must be a non-empty name or positive pin number");
  return Object.freeze({ component, port: nameOrPin });
}

function validateRoutePoint(point: PcbTraceRoutePoint, index: number): PcbTraceRoutePoint {
  if (point.route_type === "via") {
    if (
      typeof point.hole_diameter !== "number" || !Number.isFinite(point.hole_diameter) ||
      point.hole_diameter <= 0 || typeof point.outer_diameter !== "number" ||
      !Number.isFinite(point.outer_diameter) || point.outer_diameter <= point.hole_diameter
    ) {
      throw new TypeError(
        `Semantic route via ${index} requires finite hole_diameter and a larger outer_diameter`,
      );
    }
  }
  return structuredClone(point);
}

export function defineRoute(definition: SemanticPcbRouteDefinition): Readonly<SemanticPcbRouteDefinition> {
  const name = nonEmpty(definition.name, "Semantic route name");
  const net = nonEmpty(definition.net, `Semantic route ${name} net`);
  if (!Array.isArray(definition.route) || definition.route.length < 2) {
    throw new TypeError(`Semantic route ${name} requires at least two route points`);
  }
  if (
    definition.route[0]?.route_type !== "wire" ||
    definition.route[definition.route.length - 1]?.route_type !== "wire"
  ) throw new TypeError(`Semantic route ${name} must begin and end with wire points`);
  const route = definition.route.map(validateRoutePoint);
  return Object.freeze({
    name,
    net,
    from: port(definition.from.component, definition.from.port),
    to: port(definition.to.component, definition.to.port),
    route: Object.freeze(route),
  });
}

export function defineRoutes(
  definitions: readonly SemanticPcbRouteDefinition[],
): readonly Readonly<SemanticPcbRouteDefinition>[] {
  const routes = definitions.map(defineRoute);
  const names = new Set<string>();
  for (const route of routes) {
    if (names.has(route.name)) throw new TypeError(`Semantic route name is duplicated: ${route.name}`);
    names.add(route.name);
  }
  return Object.freeze(routes);
}

function recordsOfType<T extends AnyCircuitElement["type"]>(
  circuitJson: readonly AnyCircuitElement[],
  type: T,
): Extract<AnyCircuitElement, { type: T }>[] {
  return circuitJson.filter(
    (element): element is Extract<AnyCircuitElement, { type: T }> => element.type === type,
  );
}

function resolvePort(
  circuitJson: readonly AnyCircuitElement[],
  selector: SemanticPortSelector,
): Readonly<{ sourcePortId: string; pcbPortId: string; x: number; y: number; layers: readonly string[] }> {
  const components = recordsOfType(circuitJson, "source_component")
    .filter((component) => component.name === selector.component);
  if (components.length !== 1) {
    throw new Error(`Semantic component ${selector.component} resolved to ${components.length} components`);
  }
  const wanted = String(selector.port);
  const sourcePorts = recordsOfType(circuitJson, "source_port").filter((candidate) =>
    candidate.source_component_id === components[0]!.source_component_id &&
    (
      candidate.name === wanted || String(candidate.pin_number ?? "") === wanted ||
      candidate.port_hints?.includes(wanted)
    )
  );
  if (sourcePorts.length !== 1) {
    throw new Error(
      `Semantic port ${selector.component}.${wanted} resolved to ${sourcePorts.length} source ports`,
    );
  }
  const pcbPorts = recordsOfType(circuitJson, "pcb_port")
    .filter((candidate) => candidate.source_port_id === sourcePorts[0]!.source_port_id);
  if (pcbPorts.length !== 1) {
    throw new Error(
      `Semantic port ${selector.component}.${wanted} resolved to ${pcbPorts.length} PCB ports`,
    );
  }
  const pcbPort = pcbPorts[0]!;
  return Object.freeze({
    sourcePortId: sourcePorts[0]!.source_port_id,
    pcbPortId: pcbPort.pcb_port_id,
    x: pcbPort.x,
    y: pcbPort.y,
    layers: Object.freeze([...pcbPort.layers]),
  });
}

function copperStack(numLayers: number): readonly PcbCopperLayer[] {
  if (!Number.isSafeInteger(numLayers) || numLayers < 2 || numLayers > 10) {
    throw new Error(`Semantic routes require a 2-10 layer PCB; received ${numLayers}`);
  }
  return Object.freeze([
    "top",
    ...Array.from({ length: numLayers - 2 }, (_, index) => `inner${index + 1}` as PcbCopperLayer),
    "bottom",
  ]);
}

function viaSpan(
  stack: readonly PcbCopperLayer[],
  fromLayer: PcbCopperLayer,
  toLayer: PcbCopperLayer,
): readonly PcbCopperLayer[] {
  const from = stack.indexOf(fromLayer);
  const to = stack.indexOf(toLayer);
  if (from < 0 || to < 0 || from === to) {
    throw new Error(`Via span ${fromLayer} to ${toLayer} is invalid for ${stack.join("/")}`);
  }
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const span = stack.slice(low, high + 1);
  return Object.freeze(from <= to ? span : span.reverse());
}

function layerName(value: unknown, context: string): PcbCopperLayer {
  if (typeof value !== "string") throw new Error(`${context} layer must be a string`);
  if (!/^(?:top|bottom|inner[1-8])$/u.test(value)) throw new Error(`${context} layer ${value} is invalid`);
  return value as PcbCopperLayer;
}

function normalizeViaTransitions(
  route: readonly PcbTraceRoutePoint[],
  context: string,
): PcbTraceRoutePoint[] {
  const normalized: PcbTraceRoutePoint[] = [];
  for (let index = 0; index < route.length; index += 1) {
    const point = route[index]!;
    if (point.route_type !== "via") {
      normalized.push(point);
      continue;
    }
    const before = route[index - 1];
    const after = route[index + 1];
    if (before?.route_type !== "wire" || after?.route_type !== "wire") {
      throw new Error(`${context} via ${index} must be between two wire points`);
    }
    const beforeLayer = layerName(before.layer, `${context} via ${index} before`);
    const afterLayer = layerName(after.layer, `${context} via ${index} after`);
    const declaredFrom = layerName(point.from_layer, `${context} via ${index}`);
    const declaredTo = layerName(point.to_layer, `${context} via ${index}`);
    if (
      beforeLayer === afterLayer ||
      new Set([beforeLayer, afterLayer, declaredFrom, declaredTo]).size !== 2 ||
      ![declaredFrom, declaredTo].includes(beforeLayer) ||
      ![declaredFrom, declaredTo].includes(afterLayer)
    ) throw new Error(`${context} via ${index} layers do not match its adjacent wires`);
    if (before.x !== point.x || before.y !== point.y) {
      normalized.push(Object.freeze({
        route_type: "wire",
        x: point.x,
        y: point.y,
        layer: beforeLayer,
        width: before.width,
      }));
    }
    normalized.push(Object.freeze({ ...point, from_layer: beforeLayer, to_layer: afterLayer }));
    if (after.x !== point.x || after.y !== point.y) {
      normalized.push(Object.freeze({
        route_type: "wire",
        x: point.x,
        y: point.y,
        layer: afterLayer,
        width: after.width,
      }));
    }
  }
  return normalized;
}

function snapEndpoint(
  point: PcbTraceRoutePointWire,
  endpoint: ReturnType<typeof resolvePort>,
  field: "start_pcb_port_id" | "end_pcb_port_id",
  context: string,
): PcbTraceRoutePointWire {
  const layer = layerName(point.layer, context);
  if (!endpoint.layers.includes(layer)) {
    throw new Error(`${context} uses ${layer}, but its PCB port is on ${endpoint.layers.join("/")}`);
  }
  return Object.freeze({ ...point, x: endpoint.x, y: endpoint.y, [field]: endpoint.pcbPortId });
}

export function resolveSemanticPcbRoute(
  circuitJson: readonly AnyCircuitElement[],
  input: SemanticPcbRouteDefinition,
): Readonly<ResolvedSemanticPcbRoute> {
  const definition = defineRoute(input);
  const boards = recordsOfType(circuitJson, "pcb_board");
  if (boards.length !== 1) throw new Error(`Semantic routes require exactly one PCB board; found ${boards.length}`);
  const stack = copperStack(boards[0]!.num_layers);
  const from = resolvePort(circuitJson, definition.from);
  const to = resolvePort(circuitJson, definition.to);
  const nets = recordsOfType(circuitJson, "source_net").filter((net) => net.name === definition.net);
  if (nets.length !== 1) throw new Error(`Semantic net ${definition.net} resolved to ${nets.length} source nets`);
  const sourceNet = nets[0]!;
  const traceCandidates = recordsOfType(circuitJson, "source_trace")
    .filter((trace) => trace.connected_source_net_ids?.includes(sourceNet.source_net_id))
    .sort((left, right) =>
      Number(right.connected_source_port_ids?.includes(from.sourcePortId)) -
        Number(left.connected_source_port_ids?.includes(from.sourcePortId)) ||
      compareUtf16(left.display_name ?? "", right.display_name ?? "") ||
      compareUtf16(left.source_trace_id, right.source_trace_id)
    );
  if (traceCandidates.length === 0) {
    throw new Error(`Semantic net ${definition.net} has no source trace to bind authored copper`);
  }
  const route = definition.route.map((point) => structuredClone(point));
  route[0] = snapEndpoint(
    route[0] as PcbTraceRoutePointWire,
    from,
    "start_pcb_port_id",
    `${definition.name} start`,
  );
  route[route.length - 1] = snapEndpoint(
    route[route.length - 1] as PcbTraceRoutePointWire,
    to,
    "end_pcb_port_id",
    `${definition.name} end`,
  );
  const normalizedRoute = normalizeViaTransitions(route, definition.name);
  const vias = normalizedRoute.filter((point): point is PcbTraceRoutePointVia => point.route_type === "via")
    .map((via) => {
      const fromLayer = layerName(via.from_layer, `${definition.name} via`);
      const toLayer = layerName(via.to_layer, `${definition.name} via`);
      return Object.freeze({
        x: via.x,
        y: via.y,
        holeDiameter: via.hole_diameter!,
        outerDiameter: via.outer_diameter!,
        // A routing transition may use only part of the stack, but the initial
        // Fulmetry profile manufactures ordinary plated through-vias. Blind and
        // buried physical spans require a separate future profile.
        fromLayer: stack[0]!,
        toLayer: stack[stack.length - 1]!,
        layers: viaSpan(stack, stack[0]!, stack[stack.length - 1]!),
      });
    });
  return Object.freeze({
    name: definition.name,
    sourceTraceId: traceCandidates[0]!.source_trace_id,
    sourceNetId: sourceNet.source_net_id,
    ...(sourceNet.subcircuit_id === undefined ? {} : { subcircuitId: sourceNet.subcircuit_id }),
    connectsTo: Object.freeze([from.pcbPortId, to.pcbPortId] as const),
    route: Object.freeze(normalizedRoute),
    vias: Object.freeze(vias),
  });
}

/**
 * Board-level authored copper with stable component/port/net selectors.
 * Unlike upstream PcbTrace, this never emits pcb_component_id: null and it
 * emits explicit pcb_via records for every layer transition.
 */
export class SemanticPcbTrace extends PcbTrace {
  readonly semanticDefinition: Readonly<SemanticPcbRouteDefinition>;
  private waitingForLateFootprintPorts = false;

  constructor(definition: SemanticPcbRouteDefinition) {
    const normalized = defineRoute(definition);
    super({ route: [...normalized.route] });
    this.semanticDefinition = normalized;
  }

  /** Defers insertion until ports, placement, and board layout are finalized. */
  override doInitialPcbPrimitiveRender(): void {
    // Upstream PcbTrace inserts here, before stable semantic PCB ports exist.
  }

  private insertResolvedTrace(): void {
    const root = this.root;
    if (root === null || root.pcbDisabled) return;
    const resolved = resolveSemanticPcbRoute(
      root.db.toArray() as AnyCircuitElement[],
      this.semanticDefinition,
    );
    const inserted = root.db.pcb_trace.insert({
      route: [...resolved.route],
      source_trace_id: resolved.sourceTraceId,
      connection_name: resolved.sourceNetId,
      connectsTo: [...resolved.connectsTo],
      subcircuit_id: resolved.subcircuitId,
    } as unknown as Parameters<typeof root.db.pcb_trace.insert>[0]);
    this.pcb_trace_id = inserted.pcb_trace_id;
    for (const via of resolved.vias) {
      root.db.pcb_via.insert({
        pcb_trace_id: inserted.pcb_trace_id,
        x: via.x,
        y: via.y,
        hole_diameter: via.holeDiameter,
        outer_diameter: via.outerDiameter,
        layers: [...via.layers],
        from_layer: via.fromLayer,
        to_layer: via.toLayer,
        subcircuit_id: resolved.subcircuitId,
      });
    }
  }

  doInitialPcbTraceRender(): void {
    try {
      this.insertResolvedTrace();
    } catch (error) {
      // External/library footprints may finish after the first PcbPortRender
      // pass. Core marks those ports dirty for the next render cycle, while
      // PcbTraceRender occurs later in the current cycle. Defer exactly once;
      // a genuinely missing/ambiguous endpoint remains a hard failure.
      if (error instanceof Error && /resolved to 0 PCB ports$/u.test(error.message)) {
        this.waitingForLateFootprintPorts = true;
        this._markDirty("PcbTraceRender");
        this._queueAsyncEffect("resolve-semantic-route-ports", async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
        return;
      }
      throw error;
    }
  }

  updatePcbTraceRender(): void {
    if (!this.waitingForLateFootprintPorts || this.pcb_trace_id !== undefined) return;
    this.waitingForLateFootprintPorts = false;
    this.insertResolvedTrace();
  }
}
