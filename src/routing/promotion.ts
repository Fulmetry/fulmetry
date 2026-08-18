// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type {
  AnyCircuitElement,
  PcbTraceRoutePoint,
  PcbTraceRoutePointVia,
  PcbTraceRoutePointWire,
} from "circuit-json";
import { compareUtf16 } from "../internal/canonical-json";
import { defineRoute, type SemanticPcbRouteDefinition, type SemanticPortSelector } from "../routes";

export interface RoutePromotionOptions {
  /** Required when candidate vias omit fabrication dimensions. */
  readonly defaultViaHoleDiameter: number;
  /** Required when candidate vias omit fabrication dimensions. */
  readonly defaultViaOuterDiameter: number;
  /** Decimal places retained in authored coordinates and dimensions. */
  readonly precision?: number;
}

export interface PromotedRouteModule {
  readonly fileName: string;
  readonly exportName: string;
  readonly net: string;
  readonly routes: readonly Readonly<SemanticPcbRouteDefinition>[];
  readonly source: string;
}

export interface PromotedRouteSourceSet {
  readonly routes: readonly Readonly<SemanticPcbRouteDefinition>[];
  readonly modules: readonly PromotedRouteModule[];
  readonly indexSource: string;
}

type ElementRecord = AnyCircuitElement & Record<string, unknown>;

function finitePositive(value: number, context: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${context} must be positive and finite`);
  return value;
}

function records(circuitJson: readonly AnyCircuitElement[], type: string): ElementRecord[] {
  return circuitJson.filter((element) => element.type === type) as ElementRecord[];
}

function id(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} is missing`);
  return value;
}

function optionalStrings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function rounded(value: unknown, precision: number, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${context} must be finite`);
  const scale = 10 ** precision;
  const result = Math.round(value * scale) / scale;
  return Object.is(result, -0) ? 0 : result;
}

function stableIdentifier(value: string, fallback: string): string {
  const normalized = value.normalize("NFKD").replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  const safe = normalized.length === 0 ? fallback : normalized;
  return /^[A-Za-z_]/u.test(safe) ? safe : `_${safe}`;
}

function fileStem(value: string): string {
  const stem = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return stem.length === 0 ? "unnamed-net" : stem;
}

function selectSemanticPort(
  pcbPortId: string,
  pcbPorts: ReadonlyMap<string, ElementRecord>,
  sourcePorts: ReadonlyMap<string, ElementRecord>,
  sourceComponents: ReadonlyMap<string, ElementRecord>,
): SemanticPortSelector {
  const pcbPort = pcbPorts.get(pcbPortId);
  if (pcbPort === undefined) throw new Error(`Candidate route endpoint ${pcbPortId} does not exist`);
  const sourcePort = sourcePorts.get(id(pcbPort.source_port_id, `${pcbPortId} source_port_id`));
  if (sourcePort === undefined) throw new Error(`Candidate route endpoint ${pcbPortId} has no source port`);
  const component = sourceComponents.get(id(sourcePort.source_component_id, `${pcbPortId} source_component_id`));
  if (component === undefined) throw new Error(`Candidate route endpoint ${pcbPortId} has no source component`);
  const componentName = id(component.name, `${pcbPortId} component name`);
  const portName = typeof sourcePort.name === "string" && sourcePort.name.length > 0
    ? sourcePort.name
    : sourcePort.pin_number;
  if (typeof portName !== "string" && typeof portName !== "number") {
    throw new Error(`Candidate route endpoint ${pcbPortId} has no stable port name or pin`);
  }
  return Object.freeze({ component: componentName, port: portName });
}

function endpointId(route: readonly ElementRecord[], end: "start" | "end", traceId: string): string {
  const point = end === "start" ? route[0] : route[route.length - 1];
  const key = end === "start" ? "start_pcb_port_id" : "end_pcb_port_id";
  if (point?.route_type !== "wire") throw new Error(`${traceId} ${end} point is not wire copper`);
  return id(point[key], `${traceId} ${key}`);
}

function endpointNode(point: ElementRecord, traceId: string, viaCoordinates: ReadonlySet<string>): string {
  if (point.route_type !== "wire" && point.route_type !== "via") {
    throw new Error(`${traceId} fragment endpoint is not routed copper`);
  }
  const x = rounded(point.x, 6, `${traceId} endpoint x`);
  const y = rounded(point.y, 6, `${traceId} endpoint y`);
  const coordinate = `${x}:${y}`;
  if (point.route_type === "via" || viaCoordinates.has(coordinate)) return `via:${coordinate}`;
  return `${id(point.layer, `${traceId} endpoint layer`)}:${x}:${y}`;
}

function reversedRoute(route: readonly ElementRecord[]): ElementRecord[] {
  return [...route].reverse().map((point) => {
    const copy = { ...point };
    delete copy.start_pcb_port_id;
    delete copy.end_pcb_port_id;
    if (copy.route_type === "via") {
      const from = copy.from_layer;
      copy.from_layer = copy.to_layer;
      copy.to_layer = from;
    }
    return copy as ElementRecord;
  });
}

function stitchCandidateTraceFragments(
  traces: readonly ElementRecord[],
  pcbPorts: ReadonlyMap<string, ElementRecord>,
  sourceTraces: ReadonlyMap<string, ElementRecord>,
  vias: readonly ElementRecord[],
): ElementRecord[] {
  const viaCoordinates = new Set(vias.map((via) =>
    `${rounded(via.x, 6, "Candidate via x")}:${rounded(via.y, 6, "Candidate via y")}`
  ));
  const groups = new Map<string, ElementRecord[]>();
  for (const trace of traces) {
    const sourceTraceId = id(trace.source_trace_id, `${String(trace.pcb_trace_id)} source_trace_id`);
    groups.set(sourceTraceId, [...(groups.get(sourceTraceId) ?? []), trace]);
  }
  const result: ElementRecord[] = [];
  for (const [sourceTraceId, group] of groups) {
    const allHaveEndpoints = group.every((trace) => {
      const route = Array.isArray(trace.route) ? trace.route as ElementRecord[] : [];
      return route[0]?.start_pcb_port_id !== undefined && route.at(-1)?.end_pcb_port_id !== undefined;
    });
    if (allHaveEndpoints) {
      result.push(...group);
      continue;
    }
    const sourceTrace = sourceTraces.get(sourceTraceId);
    if (sourceTrace === undefined) throw new Error(`Candidate fragments ${sourceTraceId} have no source trace`);
    const sourceNetIds = new Set(optionalStrings(sourceTrace.connected_source_net_ids));
    const allowedSourcePorts = new Set(
      [...sourceTraces.values()]
        .filter((candidate) => optionalStrings(candidate.connected_source_net_ids).some((netId) => sourceNetIds.has(netId)))
        .flatMap((candidate) => optionalStrings(candidate.connected_source_port_ids)),
    );
    const allowedPcbPorts = [...pcbPorts.values()].filter((port) =>
      allowedSourcePorts.has(String(port.source_port_id))
    );
    if (allowedPcbPorts.length < 2) {
      throw new Error(`Candidate fragments ${sourceTraceId} do not identify at least two endpoint ports`);
    }
    const edges = group.map((trace, index) => {
      if (!Array.isArray(trace.route) || trace.route.length < 2) {
        throw new Error(`${String(trace.pcb_trace_id)} has no stitchable route`);
      }
      const unsupported = (trace.route as ElementRecord[]).find((point) =>
        point.route_type !== "wire" && point.route_type !== "via"
      );
      if (unsupported !== undefined) {
        throw new Error(`${String(trace.pcb_trace_id)} contains unsupported routed copper`);
      }
      // dsn-converter inserts four-layer vias into whichever wire happens to
      // be encountered first. Rebuild transitions at authenticated SES via
      // coordinates while stitching, where both adjacent layers are known.
      const route = (trace.route as ElementRecord[]).filter((point) => point.route_type === "wire");
      if (route.length < 2) throw new Error(`${String(trace.pcb_trace_id)} has too little wire copper`);
      return Object.freeze({
        index,
        trace,
        route,
        start: endpointNode(route[0]!, String(trace.pcb_trace_id), viaCoordinates),
        end: endpointNode(route.at(-1)!, String(trace.pcb_trace_id), viaCoordinates),
      });
    });
    const incidents = new Map<string, number[]>();
    const nodePoints = new Map<string, ElementRecord>();
    const nodeLayers = new Map<string, Set<string>>();
    for (const edge of edges) {
      incidents.set(edge.start, [...(incidents.get(edge.start) ?? []), edge.index]);
      incidents.set(edge.end, [...(incidents.get(edge.end) ?? []), edge.index]);
      nodePoints.set(edge.start, edge.route[0]!);
      nodePoints.set(edge.end, edge.route.at(-1)!);
      for (const [node, point] of [[edge.start, edge.route[0]!], [edge.end, edge.route.at(-1)!]] as const) {
        const layers = nodeLayers.get(node) ?? new Set<string>();
        layers.add(id(point.layer, "Fragment endpoint layer"));
        nodeLayers.set(node, layers);
      }
    }
    const attachedPorts = allowedPcbPorts.flatMap((port) => {
      const supportedLayers = new Set(optionalStrings(port.layers));
      const candidates = [...nodePoints.entries()].filter(([node]) =>
        [...(nodeLayers.get(node) ?? [])].some((layer) => supportedLayers.has(layer))
      ).map(([node, point]) => ({
        node,
        distance: Math.hypot(Number(point.x) - Number(port.x), Number(point.y) - Number(port.y)),
      })).sort((left, right) => left.distance - right.distance || compareUtf16(left.node, right.node));
      const nearestDistance = candidates[0]?.distance;
      // Freerouting paths terminate at pad boundaries, not necessarily pad
      // centres. Larger distances indicate an actually unrouted pin and must
      // not be turned into authored copper by endpoint snapping. A plated
      // through-hole may terminate at the same coordinate on several copper
      // layers; keep every equally-near layer attachment so no valid branch
      // is discarded during semantic source promotion.
      return nearestDistance !== undefined && nearestDistance <= 2.5
        ? candidates.filter(({ distance }) => Math.abs(distance - nearestDistance) <= 1e-9)
          .map(({ node }) => Object.freeze({ node, port }))
        : [];
    }).sort((left, right) =>
      compareUtf16(id(left.port.pcb_port_id, "PCB port id"), id(right.port.pcb_port_id, "PCB port id"))
    );
    const remaining = new Set(edges.map(({ index }) => index));
    while (remaining.size > 0) {
      const seed = Math.min(...remaining);
      const componentEdges = new Set<number>();
      const componentNodes = new Set<string>();
      const queue = [edges[seed]!.start];
      while (queue.length > 0) {
        const node = queue.shift()!;
        if (componentNodes.has(node)) continue;
        componentNodes.add(node);
        for (const edgeIndex of incidents.get(node) ?? []) {
          componentEdges.add(edgeIndex);
          const edge = edges[edgeIndex]!;
          queue.push(edge.start === node ? edge.end : edge.start);
        }
      }
      for (const edgeIndex of componentEdges) remaining.delete(edgeIndex);
      const componentAttachments = attachedPorts.filter(({ node }) => componentNodes.has(node));
      if (componentAttachments.length < 2) continue;
      const rootAttachment = componentAttachments[0]!;
      const root = rootAttachment.node;
      for (const targetAttachment of componentAttachments.slice(1)) {
        const target = targetAttachment.node;
        const prior = new Map<string, Readonly<{ node: string; edge: number }>>();
        const search = [root];
        const visited = new Set([root]);
        while (search.length > 0 && !visited.has(target)) {
          const node = search.shift()!;
          for (const edgeIndex of incidents.get(node) ?? []) {
            if (!componentEdges.has(edgeIndex)) continue;
            const edge = edges[edgeIndex]!;
            const next = edge.start === node ? edge.end : edge.start;
            if (visited.has(next)) continue;
            visited.add(next);
            prior.set(next, Object.freeze({ node, edge: edgeIndex }));
            search.push(next);
          }
        }
        if (!visited.has(target)) throw new Error(`${sourceTraceId} fragment graph is disconnected`);
        const path: Readonly<{ from: string; to: string; edge: number }>[] = [];
        let cursor = target;
        while (cursor !== root) {
          const step = prior.get(cursor);
          if (step === undefined) throw new Error(`${sourceTraceId} fragment path is incomplete`);
          path.unshift(Object.freeze({ from: step.node, to: cursor, edge: step.edge }));
          cursor = step.node;
        }
        const route: ElementRecord[] = [];
        for (const step of path) {
          const edge = edges[step.edge]!;
          const oriented = edge.start === step.from
            ? edge.route.map((point) => ({ ...point }) as ElementRecord)
            : reversedRoute(edge.route);
          for (const point of oriented) {
            delete point.start_pcb_port_id;
            delete point.end_pcb_port_id;
          }
          if (route.length === 0) {
            route.push(...oriented);
          } else {
            const previous = route.at(-1)!;
            const next = oriented[0]!;
            const sameCoordinate = previous.route_type === "wire" && next.route_type === "wire" &&
              previous.x === next.x && previous.y === next.y;
            const duplicateWire = sameCoordinate && previous.layer === next.layer;
            if (sameCoordinate && !duplicateWire) {
              const coordinate = `${rounded(previous.x, 6, "Via join x")}:${rounded(previous.y, 6, "Via join y")}`;
              if (!viaCoordinates.has(coordinate)) {
                throw new Error(`${sourceTraceId} changes layers without an authenticated via`);
              }
              route.push({
                route_type: "via",
                x: previous.x,
                y: previous.y,
                from_layer: previous.layer,
                to_layer: next.layer,
              } as unknown as ElementRecord);
            }
            route.push(...(duplicateWire ? oriented.slice(1) : oriented));
          }
        }
        if (route.length === 0) {
          const point = nodePoints.get(root);
          if (point === undefined) throw new Error(`${sourceTraceId} coincident port node is missing`);
          route.push({ ...point }, { ...point });
        }
        route[0]!.start_pcb_port_id = id(rootAttachment.port.pcb_port_id, `${sourceTraceId} root port`);
        route.at(-1)!.end_pcb_port_id = id(targetAttachment.port.pcb_port_id, `${sourceTraceId} target port`);
        result.push({
          ...group[0],
          pcb_trace_id: `${String(group[0]!.pcb_trace_id)}_stitched_${result.length}`,
          route,
        } as ElementRecord);
      }
    }
  }
  return result;
}

function normalizeRoutePoint(
  point: ElementRecord,
  precision: number,
  options: RoutePromotionOptions,
): PcbTraceRoutePoint {
  const x = rounded(point.x, precision, "Route point x");
  const y = rounded(point.y, precision, "Route point y");
  if (point.route_type === "via") {
    const hole = typeof point.hole_diameter === "number"
      ? point.hole_diameter
      : options.defaultViaHoleDiameter;
    const outer = typeof point.outer_diameter === "number"
      ? point.outer_diameter
      : options.defaultViaOuterDiameter;
    finitePositive(hole, "Promoted via hole diameter");
    finitePositive(outer, "Promoted via outer diameter");
    if (outer <= hole) throw new Error("Promoted via outer diameter must exceed its hole diameter");
    return Object.freeze({
      route_type: "via",
      x,
      y,
      from_layer: id(point.from_layer, "Via from_layer") as PcbTraceRoutePointVia["from_layer"],
      to_layer: id(point.to_layer, "Via to_layer") as PcbTraceRoutePointVia["to_layer"],
      hole_diameter: rounded(hole, precision, "Via hole diameter"),
      outer_diameter: rounded(outer, precision, "Via outer diameter"),
    });
  }
  if (point.route_type !== "wire") throw new Error(`Unsupported candidate route point ${String(point.route_type)}`);
  return Object.freeze({
    route_type: "wire",
    x,
    y,
    layer: id(point.layer, "Wire layer") as PcbTraceRoutePointWire["layer"],
    width: rounded(point.width, precision, "Wire width"),
  });
}

function normalizePromotedViaDirections(
  route: readonly PcbTraceRoutePoint[],
  traceId: string,
): readonly PcbTraceRoutePoint[] {
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
      throw new Error(`${traceId} via ${index} must be between wire points`);
    }
    const adjacent = new Set([before.layer, after.layer]);
    const declared = new Set([point.from_layer, point.to_layer]);
    if (
      adjacent.size !== 2 || declared.size !== 2 ||
      [...adjacent].some((layer) => !declared.has(layer)) ||
      [...declared].some((layer) => !adjacent.has(layer))
    ) throw new Error(`${traceId} via ${index} layers do not match its adjacent wires`);
    if (before.x !== point.x || before.y !== point.y) {
      normalized.push(Object.freeze({
        route_type: "wire",
        x: point.x,
        y: point.y,
        layer: before.layer,
        width: before.width,
      }));
    }
    normalized.push(Object.freeze({ ...point, from_layer: before.layer, to_layer: after.layer }));
    if (after.x !== point.x || after.y !== point.y) {
      normalized.push(Object.freeze({
        route_type: "wire",
        x: point.x,
        y: point.y,
        layer: after.layer,
        width: after.width,
      }));
    }
  }
  return Object.freeze(normalized);
}

function sourceNetName(
  trace: ElementRecord,
  sourceTraces: ReadonlyMap<string, ElementRecord>,
  sourceNets: ReadonlyMap<string, ElementRecord>,
): string {
  const connectionName = trace.connection_name;
  if (typeof connectionName === "string") {
    const byId = sourceNets.get(connectionName);
    if (byId !== undefined) return id(byId.name, `${connectionName} net name`);
    const byName = [...sourceNets.values()].filter((net) => net.name === connectionName);
    if (byName.length === 1) return connectionName;
  }
  const sourceTrace = sourceTraces.get(id(trace.source_trace_id, `${String(trace.pcb_trace_id)} source_trace_id`));
  if (sourceTrace === undefined) throw new Error(`${String(trace.pcb_trace_id)} has no source trace`);
  const netIds = optionalStrings(sourceTrace.connected_source_net_ids);
  if (netIds.length !== 1) {
    throw new Error(`${String(trace.pcb_trace_id)} source trace must identify exactly one source net`);
  }
  const net = sourceNets.get(netIds[0]!);
  if (net === undefined) throw new Error(`${String(trace.pcb_trace_id)} source net ${netIds[0]} does not exist`);
  return id(net.name, `${netIds[0]} net name`);
}

function renderModule(
  exportName: string,
  routes: readonly Readonly<SemanticPcbRouteDefinition>[],
): string {
  const body = JSON.stringify(routes, null, 2);
  return `// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\n// Generated by pcboo route promote. Review this authored copper before production.\nimport { defineRoutes } from "pcboo";\n\nexport const ${exportName} = defineRoutes(${body});\n`;
}

/**
 * Converts router-owned Circuit JSON into reviewable, stable authored copper.
 * Generated IDs and endpoint coordinates are deliberately not authoritative.
 */
export function promoteCandidateRoutes(
  circuitJson: readonly AnyCircuitElement[],
  options: RoutePromotionOptions,
): readonly Readonly<SemanticPcbRouteDefinition>[] {
  finitePositive(options.defaultViaHoleDiameter, "Default via hole diameter");
  finitePositive(options.defaultViaOuterDiameter, "Default via outer diameter");
  if (options.defaultViaOuterDiameter <= options.defaultViaHoleDiameter) {
    throw new TypeError("Default via outer diameter must exceed the hole diameter");
  }
  const precision = options.precision ?? 6;
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 9) {
    throw new TypeError("Route promotion precision must be an integer from 0 to 9");
  }
  const index = (items: readonly ElementRecord[], key: string, context: string): ReadonlyMap<string, ElementRecord> => {
    const result = new Map<string, ElementRecord>();
    for (const item of items) {
      const itemId = id(item[key], `${context} id`);
      if (result.has(itemId)) throw new Error(`Duplicate ${context} id ${itemId}`);
      result.set(itemId, item);
    }
    return result;
  };
  const pcbPorts = index(records(circuitJson, "pcb_port"), "pcb_port_id", "PCB port");
  const sourcePorts = index(records(circuitJson, "source_port"), "source_port_id", "source port");
  const sourceComponents = index(records(circuitJson, "source_component"), "source_component_id", "source component");
  const sourceTraces = index(records(circuitJson, "source_trace"), "source_trace_id", "source trace");
  const sourceNets = index(records(circuitJson, "source_net"), "source_net_id", "source net");
  const occurrences = new Map<string, number>();
  const traces = stitchCandidateTraceFragments(
    records(circuitJson, "pcb_trace"),
    pcbPorts,
    sourceTraces,
    records(circuitJson, "pcb_via"),
  );
  return Object.freeze(traces.map((trace) => {
    const traceId = id(trace.pcb_trace_id, "PCB trace id");
    if (!Array.isArray(trace.route) || trace.route.length < 2) throw new Error(`${traceId} has no promotable route`);
    const rawRoute = trace.route as ElementRecord[];
    const from = selectSemanticPort(endpointId(rawRoute, "start", traceId), pcbPorts, sourcePorts, sourceComponents);
    const to = selectSemanticPort(endpointId(rawRoute, "end", traceId), pcbPorts, sourcePorts, sourceComponents);
    const net = sourceNetName(trace, sourceTraces, sourceNets);
    const base = `${stableIdentifier(net, "NET")}__${stableIdentifier(from.component, "FROM")}_${stableIdentifier(String(from.port), "PORT")}__${stableIdentifier(to.component, "TO")}_${stableIdentifier(String(to.port), "PORT")}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    const normalizedRoute = rawRoute.map((point) => normalizeRoutePoint(point, precision, options));
    return defineRoute({
      name: `${base}__${occurrence}`,
      net,
      from,
      to,
      route: normalizePromotedViaDirections(normalizedRoute, traceId),
    });
  }));
}

export function renderPromotedRouteSourceSet(
  circuitJson: readonly AnyCircuitElement[],
  options: RoutePromotionOptions,
): Readonly<PromotedRouteSourceSet> {
  const routes = promoteCandidateRoutes(circuitJson, options);
  const byNet = new Map<string, Readonly<SemanticPcbRouteDefinition>[]>();
  for (const route of routes) byNet.set(route.net, [...(byNet.get(route.net) ?? []), route]);
  const usedFiles = new Set<string>();
  const usedExports = new Set<string>();
  const modules = [...byNet.entries()].sort(([left], [right]) => compareUtf16(left, right)).map(([net, netRoutes], index) => {
    const baseStem = fileStem(net);
    let stem = baseStem;
    let suffix = 2;
    while (usedFiles.has(`${stem}.ts`)) stem = `${baseStem}-${suffix++}`;
    usedFiles.add(`${stem}.ts`);
    const exportBase = `${stableIdentifier(net, `Net${index + 1}`)}Routes`;
    let exportName = exportBase;
    let exportSuffix = 2;
    while (usedExports.has(exportName)) exportName = `${exportBase}${exportSuffix++}`;
    usedExports.add(exportName);
    const sorted = [...netRoutes].sort((left, right) => compareUtf16(left.name, right.name));
    return Object.freeze({
      fileName: `${stem}.ts`,
      exportName,
      net,
      routes: Object.freeze(sorted),
      source: renderModule(exportName, sorted),
    });
  });
  const imports = modules.map((module) => `import { ${module.exportName} } from "./${module.fileName.replace(/\.ts$/u, "")}";`).join("\n");
  const spreads = modules.map((module) => `  ...${module.exportName},`).join("\n");
  const indexSource = `// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\n// Generated by pcboo route promote. Review this authored copper before production.\n${imports}\n\nexport const authoredPcbRoutes = [\n${spreads}\n] as const;\n`;
  return Object.freeze({ routes, modules: Object.freeze(modules), indexSource });
}
