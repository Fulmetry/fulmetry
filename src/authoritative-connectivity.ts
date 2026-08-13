// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import { lineSegmentDistance } from "./fabrication-geometry";

type SourcePort = Extract<AnyCircuitElement, { type: "source_port" }>;
type PcbTrace = Extract<AnyCircuitElement, { type: "pcb_trace" }>;
type Wire = Extract<PcbTrace["route"][number], { route_type: "wire" }>;

export interface AuthoritativeConnectivity {
  readonly connectivityFailures: readonly string[];
  readonly pinAuthorityFailures: readonly string[];
  readonly netIdentityFailures: readonly string[];
  readonly unsupported: readonly string[];
  readonly netForSourcePortId: (sourcePortId: string) => string | undefined;
  readonly netForSourceTraceId: (sourceTraceId: string) => string | undefined;
  readonly netForSourceNetId: (sourceNetId: string) => string | undefined;
  readonly netForPcbPortId: (pcbPortId: string) => string | undefined;
  readonly netForPcbTraceId: (pcbTraceId: string) => string | undefined;
  readonly netForRawConnectivityKey: (key: string) => string | undefined;
  readonly sourcePortIdsForSourceNet: (sourceNetId: string) => readonly string[];
}

class UnionFind {
  readonly #parents = new Map<string, string>();

  add(value: string): void {
    if (!this.#parents.has(value)) this.#parents.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.#parents.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.#parents.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.#parents.set(b, a);
  }
}

function portToken(id: string): string {
  return `port:${id}`;
}

function netToken(id: string): string {
  return `net:${id}`;
}

function traceSegments(trace: PcbTrace): Array<{ start: Wire; end: Wire }> {
  const segments: Array<{ start: Wire; end: Wire }> = [];
  for (let index = 1; index < trace.route.length; index += 1) {
    const start = trace.route[index - 1]!;
    const end = trace.route[index]!;
    if (start.route_type === "wire" && end.route_type === "wire" && start.layer === end.layer) {
      segments.push({ start, end });
    }
  }
  return segments;
}

function groupByString<T>(
  values: readonly T[],
  keyFor: (value: T) => string | undefined,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    if (key === undefined) continue;
    const members = grouped.get(key) ?? [];
    members.push(value);
    grouped.set(key, members);
  }
  return grouped;
}

/**
 * Derive electrical identities from declared endpoints and source-net
 * membership. `subcircuit_connectivity_map_key` is consistency evidence only:
 * it is never allowed to merge otherwise distinct authored connections.
 */
export function deriveAuthoritativeConnectivity(
  circuitJson: readonly AnyCircuitElement[],
): Readonly<AuthoritativeConnectivity> {
  const sourcePorts = circuitJson.filter((element) => element.type === "source_port");
  const sourceTraces = circuitJson.filter((element) => element.type === "source_trace");
  const sourceNets = circuitJson.filter((element) => element.type === "source_net");
  const internalConnections = circuitJson.filter(
    (element) => element.type === "source_component_internal_connection",
  );
  const pcbPorts = circuitJson.filter((element) => element.type === "pcb_port");
  const pcbTraces = circuitJson.filter((element) => element.type === "pcb_trace");
  const pcbComponents = circuitJson.filter((element) => element.type === "pcb_component");
  const pads = circuitJson.filter(
    (element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
  );
  const sourceComponents = circuitJson.filter((element) => element.type === "source_component");

  // Ownership relationships are queried throughout validation. Build them
  // once so large, ordinary multi-component boards do not degrade into a
  // component-by-port series of full Circuit JSON scans.
  const sourceComponentsById = groupByString(
    sourceComponents,
    (component) => component.source_component_id,
  );
  const pcbComponentsById = groupByString(
    pcbComponents,
    (component) => component.pcb_component_id,
  );
  const pcbComponentsBySourceComponentId = groupByString(
    pcbComponents,
    (component) => component.source_component_id,
  );
  const sourcePortsById = groupByString(sourcePorts, (port) => port.source_port_id);
  const sourcePortsBySourceComponentId = groupByString(
    sourcePorts,
    (port) => port.source_component_id,
  );
  const pcbPortsById = groupByString(pcbPorts, (port) => port.pcb_port_id);
  const pcbPortsBySourcePortId = groupByString(pcbPorts, (port) => port.source_port_id);
  const pcbPortsByPcbComponentId = groupByString(
    pcbPorts,
    (port) => port.pcb_component_id,
  );
  const padsByPcbPortId = groupByString(
    pads,
    (pad) => "pcb_port_id" in pad && typeof pad.pcb_port_id === "string"
      ? pad.pcb_port_id
      : undefined,
  );
  const padsByPcbComponentId = groupByString(
    pads,
    (pad) => typeof pad.pcb_component_id === "string" ? pad.pcb_component_id : undefined,
  );

  const connectivityFailures = new Set<string>();
  const pinAuthorityFailures = new Set<string>();
  const netIdentityFailures = new Set<string>();
  const unsupported = new Set<string>();
  const union = new UnionFind();
  const declarationCount = new Map<string, number>();
  for (const port of sourcePorts) union.add(portToken(port.source_port_id));
  for (const net of sourceNets) union.add(netToken(net.source_net_id));

  const declarePort = (sourcePortId: string): void => {
    declarationCount.set(sourcePortId, (declarationCount.get(sourcePortId) ?? 0) + 1);
  };
  for (const trace of sourceTraces) {
    const ports = [...new Set(trace.connected_source_port_ids)];
    const nets = [...new Set(trace.connected_source_net_ids)];
    if (
      ports.length !== trace.connected_source_port_ids.length ||
      nets.length !== trace.connected_source_net_ids.length
    ) connectivityFailures.add(`${trace.source_trace_id}:duplicate-logical-member`);
    if (nets.length > 1) {
      netIdentityFailures.add(
        `${trace.source_trace_id}:multiple-source-nets:${[...nets].sort().join(",")}`,
      );
    }
    for (const id of ports) declarePort(id);
    const tokens = [
      ...ports.map(portToken),
      ...nets.map(netToken),
    ];
    if (tokens.length === 0) {
      connectivityFailures.add(`${trace.source_trace_id}:empty-logical-group`);
      continue;
    }
    for (let index = 1; index < tokens.length; index += 1) {
      union.union(tokens[0]!, tokens[index]!);
    }
  }
  for (const connection of internalConnections) {
    unsupported.add(
      `${connection.source_component_internal_connection_id}:internal-connectivity-requires-component-qualified-physical-proof`,
    );
    const ports = [...new Set(connection.source_port_ids)];
    const declaredOwner = connection.source_component_id;
    const hasExactOwner = typeof declaredOwner === "string" && ports.every((id) => {
      const matches = sourcePortsById.get(id) ?? [];
      return matches.length === 1 && matches[0]!.source_component_id === declaredOwner;
    });
    if (!hasExactOwner) {
      connectivityFailures.add(
        `${connection.source_component_internal_connection_id}:internal-port-owner-mismatch`,
      );
      continue;
    }
    for (const id of ports) declarePort(id);
    for (let index = 1; index < ports.length; index += 1) {
      union.union(portToken(ports[0]!), portToken(ports[index]!));
    }
  }

  const portsByRoot = new Map<string, string[]>();
  const netsByRoot = new Map<string, string[]>();
  for (const port of sourcePorts) {
    const root = union.find(portToken(port.source_port_id));
    const values = portsByRoot.get(root) ?? [];
    values.push(port.source_port_id);
    portsByRoot.set(root, values);
  }
  for (const net of sourceNets) {
    const root = union.find(netToken(net.source_net_id));
    const values = netsByRoot.get(root) ?? [];
    values.push(net.source_net_id);
    netsByRoot.set(root, values);
  }
  const canonicalByRoot = new Map<string, string>();
  for (const root of new Set([...portsByRoot.keys(), ...netsByRoot.keys()])) {
    const portIds = [...(portsByRoot.get(root) ?? [])].sort();
    const netIds = [...(netsByRoot.get(root) ?? [])].sort();
    if (netIds.length > 1) {
      netIdentityFailures.add(
        `source-net-root:${netIds.join(",")}:contains-${netIds.length}-declared-nets`,
      );
    }
    canonicalByRoot.set(
      root,
      `logical:ports=${portIds.join(",")};nets=${netIds.join(",")}`,
    );
  }
  const canonicalForToken = (token: string): string | undefined =>
    canonicalByRoot.get(union.find(token));

  const sourceTraceNet = new Map<string, string>();
  for (const trace of sourceTraces) {
    const token = trace.connected_source_port_ids[0] === undefined
      ? trace.connected_source_net_ids[0] === undefined
        ? undefined
        : netToken(trace.connected_source_net_ids[0])
      : portToken(trace.connected_source_port_ids[0]);
    const identity = token === undefined ? undefined : canonicalForToken(token);
    if (identity !== undefined) sourceTraceNet.set(trace.source_trace_id, identity);
  }
  const sourceNetIdentity = new Map(
    sourceNets.flatMap((net) => {
      const identity = canonicalForToken(netToken(net.source_net_id));
      return identity === undefined ? [] : [[net.source_net_id, identity] as const];
    }),
  );
  const sourcePortIdentity = new Map(
    sourcePorts.flatMap((port) => {
      const identity = canonicalForToken(portToken(port.source_port_id));
      return identity === undefined ? [] : [[port.source_port_id, identity] as const];
    }),
  );

  const rawKeyIdentities = new Map<string, Set<string>>();
  const recordRawKey = (key: unknown, identity: string | undefined, source: string): void => {
    if (typeof key !== "string" || key.trim() === "" || identity === undefined) return;
    const identities = rawKeyIdentities.get(key) ?? new Set<string>();
    identities.add(identity);
    rawKeyIdentities.set(key, identities);
    if (identities.size > 1) netIdentityFailures.add(`${source}:connectivity-key-collision:${key}`);
  };
  for (const port of sourcePorts) {
    recordRawKey(
      port.subcircuit_connectivity_map_key,
      sourcePortIdentity.get(port.source_port_id),
      port.source_port_id,
    );
  }
  for (const trace of sourceTraces) {
    recordRawKey(
      trace.subcircuit_connectivity_map_key,
      sourceTraceNet.get(trace.source_trace_id),
      trace.source_trace_id,
    );
  }
  for (const net of sourceNets) {
    recordRawKey(
      net.subcircuit_connectivity_map_key,
      sourceNetIdentity.get(net.source_net_id),
      net.source_net_id,
    );
  }
  // Report every member of a collided key deterministically, including members
  // seen before the second identity exposed the collision.
  for (const [key, identities] of rawKeyIdentities) {
    if (identities.size <= 1) continue;
    netIdentityFailures.add(`connectivity-key:${key}:aliases-${identities.size}-logical-groups`);
  }

  const pcbPortSource = new Map<string, string>();
  for (const pcbPort of pcbPorts) {
    if (typeof pcbPort.source_port_id === "string") {
      pcbPortSource.set(pcbPort.pcb_port_id, pcbPort.source_port_id);
    }
  }
  const pcbTraceIdentity = new Map<string, string>();
  for (const trace of pcbTraces) {
    const reference = trace.source_trace_id;
    if (typeof reference !== "string") continue;
    const identity = sourceTraceNet.get(reference) ?? sourceNetIdentity.get(reference);
    if (identity !== undefined) pcbTraceIdentity.set(trace.pcb_trace_id, identity);
  }

  const padForPcbPort = (pcbPortId: string) => padsByPcbPortId.get(pcbPortId) ?? [];
  const addPinAuthorityFailure = (failure: string): void => {
    pinAuthorityFailures.add(failure);
    connectivityFailures.add(failure);
  };
  for (const sourcePort of sourcePorts) {
    const sourceOwners = sourcePort.source_component_id === undefined
      ? []
      : sourceComponentsById.get(sourcePort.source_component_id) ?? [];
    if (sourceOwners.length !== 1) {
      addPinAuthorityFailure(
        `${sourcePort.source_port_id}:source-component-count:${sourceOwners.length}`,
      );
    }
  }
  for (const pcbPort of pcbPorts) {
    const pcbOwners = pcbPort.pcb_component_id === undefined
      ? []
      : pcbComponentsById.get(pcbPort.pcb_component_id) ?? [];
    const sourceOwners = pcbPort.source_port_id === undefined
      ? []
      : sourcePortsById.get(pcbPort.source_port_id) ?? [];
    if (pcbOwners.length !== 1) {
      addPinAuthorityFailure(
        `${pcbPort.pcb_port_id}:pcb-component-count:${pcbOwners.length}`,
      );
    }
    if (sourceOwners.length !== 1) {
      addPinAuthorityFailure(
        `${pcbPort.pcb_port_id}:source-port-count:${sourceOwners.length}`,
      );
    }
    if (
      pcbOwners.length === 1 && sourceOwners.length === 1 &&
      sourceOwners[0]!.source_component_id !== pcbOwners[0]!.source_component_id
    ) {
      addPinAuthorityFailure(`${pcbPort.pcb_port_id}:source-component-owner-mismatch`);
    }
  }
  // Pin authority is deliberately bidirectional. A missing logical/source pin
  // must not erase the obligation created by a still-present physical pad.
  // Scope this to source-backed PCB components so vias, NPTH/mechanical holes,
  // and pinless mechanical components are not mistaken for electrical pins.
  for (const pcbComponent of pcbComponents) {
    const matchingSourceComponents = pcbComponent.source_component_id === undefined
      ? []
      : sourceComponentsById.get(pcbComponent.source_component_id) ?? [];
    if (matchingSourceComponents.length !== 1) continue;
    const sourceComponent = matchingSourceComponents[0]!;
    const componentSourcePorts = sourcePortsBySourceComponentId.get(
      sourceComponent.source_component_id,
    ) ?? [];
    const componentPcbPorts = pcbPortsByPcbComponentId.get(pcbComponent.pcb_component_id) ?? [];
    const componentPads = padsByPcbComponentId.get(pcbComponent.pcb_component_id) ?? [];

    for (const sourcePort of componentSourcePorts) {
      const matchingPcbPorts = pcbPortsBySourcePortId.get(sourcePort.source_port_id) ?? [];
      if (matchingPcbPorts.length !== 1) {
        addPinAuthorityFailure(
          `${sourcePort.source_port_id}:pcb-port-count:${matchingPcbPorts.length}`,
        );
        continue;
      }
      const pcbPort = matchingPcbPorts[0]!;
      if (pcbPort.pcb_component_id !== pcbComponent.pcb_component_id) {
        addPinAuthorityFailure(`${sourcePort.source_port_id}:pcb-component-owner-mismatch`);
        continue;
      }
      const ownedPads = padForPcbPort(pcbPort.pcb_port_id).filter(
        (pad) => pad.pcb_component_id === pcbComponent.pcb_component_id,
      );
      if (ownedPads.length === 0) {
        addPinAuthorityFailure(`${sourcePort.source_port_id}:manufactured-pad-count:0`);
      }
    }

    for (const pcbPort of componentPcbPorts) {
      const matchingSourcePorts = pcbPort.source_port_id === undefined
        ? []
        : sourcePortsById.get(pcbPort.source_port_id) ?? [];
      if (matchingSourcePorts.length !== 1) {
        addPinAuthorityFailure(
          `${pcbPort.pcb_port_id}:source-port-count:${matchingSourcePorts.length}`,
        );
      } else if (
        matchingSourcePorts[0]!.source_component_id !== sourceComponent.source_component_id
      ) {
        addPinAuthorityFailure(`${pcbPort.pcb_port_id}:source-component-owner-mismatch`);
      }
      const ownedPads = padForPcbPort(pcbPort.pcb_port_id).filter(
        (pad) => pad.pcb_component_id === pcbComponent.pcb_component_id,
      );
      if (ownedPads.length === 0) {
        addPinAuthorityFailure(`${pcbPort.pcb_port_id}:manufactured-pad-count:0`);
      }
    }

    for (const pad of componentPads) {
      const padId = pad.type === "pcb_smtpad"
        ? pad.pcb_smtpad_id
        : pad.pcb_plated_hole_id;
      const pcbPortId = "pcb_port_id" in pad ? pad.pcb_port_id : undefined;
      const matchingPcbPorts = typeof pcbPortId === "string"
        ? pcbPortsById.get(pcbPortId) ?? []
        : [];
      if (matchingPcbPorts.length !== 1) {
        addPinAuthorityFailure(`${padId}:pcb-port-count:${matchingPcbPorts.length}`);
      } else if (matchingPcbPorts[0]!.pcb_component_id !== pcbComponent.pcb_component_id) {
        addPinAuthorityFailure(`${padId}:pcb-component-owner-mismatch`);
      }
    }
  }
  const manufacturedPorts = new Map<string, string>();
  for (const sourcePort of sourcePorts) {
    const sourceComponentExists = sourcePort.source_component_id !== undefined &&
      (sourceComponentsById.get(sourcePort.source_component_id)?.length ?? 0) > 0;
    const pcbComponentIds = new Set(sourcePort.source_component_id === undefined
      ? []
      : (pcbComponentsBySourceComponentId.get(sourcePort.source_component_id) ?? [])
        .map((component) => component.pcb_component_id));
    if (!sourceComponentExists || pcbComponentIds.size === 0) continue;
    const matchingPcbPorts = (pcbPortsBySourcePortId.get(sourcePort.source_port_id) ?? []).filter(
      (port) =>
        (port.pcb_component_id === undefined || pcbComponentIds.has(port.pcb_component_id)),
    );
    const manufacturedMappings = matchingPcbPorts.filter(
      (port) => padForPcbPort(port.pcb_port_id).length > 0,
    );
    if (manufacturedMappings.length === 1) {
      manufacturedPorts.set(sourcePort.source_port_id, manufacturedMappings[0]!.pcb_port_id);
    }
  }

  for (const sourcePort of sourcePorts) {
    if (!manufacturedPorts.has(sourcePort.source_port_id)) continue;
    const count = declarationCount.get(sourcePort.source_port_id) ?? 0;
    if (sourcePort.do_not_connect === true) {
      if (count > 0) connectivityFailures.add(`${sourcePort.source_port_id}:do-not-connect-is-connected`);
    } else if (count === 0) {
      connectivityFailures.add(`${sourcePort.source_port_id}:manufactured-port-has-no-logical-group`);
    }
  }

  const endpointIntersectsPad = (point: Wire, pcbPortId: string): boolean => {
    const matchingPorts = pcbPortsById.get(pcbPortId) ?? [];
    if (matchingPorts.length !== 1 || !matchingPorts[0]!.layers.includes(point.layer as never)) {
      return false;
    }
    return padForPcbPort(pcbPortId).some((pad) => {
      if (pad.type === "pcb_smtpad") {
        if (pad.layer !== point.layer) return false;
        if (pad.shape === "rect") {
          return Math.abs(point.x - pad.x) <= pad.width / 2 + point.width / 2 &&
            Math.abs(point.y - pad.y) <= pad.height / 2 + point.width / 2;
        }
        return pad.shape === "circle" &&
          Math.hypot(point.x - pad.x, point.y - pad.y) <= pad.radius + point.width / 2;
      }
      return pad.shape === "circle" && pad.layers.includes(point.layer as never) &&
        Math.hypot(point.x - pad.x, point.y - pad.y) <= pad.outer_diameter / 2 + point.width / 2;
    });
  };

  const manufacturedByIdentity = new Map<string, string[]>();
  for (const [sourcePortId] of manufacturedPorts) {
    const port = sourcePortsById.get(sourcePortId)?.[0];
    if (port === undefined) continue;
    if (port.do_not_connect === true || (declarationCount.get(sourcePortId) ?? 0) === 0) continue;
    const identity = sourcePortIdentity.get(sourcePortId);
    if (identity === undefined) continue;
    const values = manufacturedByIdentity.get(identity) ?? [];
    values.push(sourcePortId);
    manufacturedByIdentity.set(identity, values);
  }
  const selectorByIdentity = new Map<string, string>();
  for (const [sourceTraceId, identity] of sourceTraceNet) {
    if (!selectorByIdentity.has(identity)) selectorByIdentity.set(identity, sourceTraceId);
  }
  for (const [sourceNetId, identity] of sourceNetIdentity) {
    if (!selectorByIdentity.has(identity)) selectorByIdentity.set(identity, sourceNetId);
  }
  const selectorForIdentity = (identity: string, fallbackPortId: string): string =>
    selectorByIdentity.get(identity) ?? fallbackPortId;
  const pcbTracesByIdentity = new Map<string, typeof pcbTraces>();
  for (const trace of pcbTraces) {
    const identity = pcbTraceIdentity.get(trace.pcb_trace_id);
    if (identity === undefined) continue;
    const traces = pcbTracesByIdentity.get(identity) ?? [];
    traces.push(trace);
    pcbTracesByIdentity.set(identity, traces);
  }
  for (const [identity, requiredSourcePorts] of manufacturedByIdentity) {
    if (requiredSourcePorts.length < 2) continue;
    const groupSelector = selectorForIdentity(identity, requiredSourcePorts[0]!);
    const routed = pcbTracesByIdentity.get(identity) ?? [];
    if (routed.length === 0) {
      connectivityFailures.add(`${groupSelector}:no-physical-copper`);
      continue;
    }
    const covered = new Set<string>();
    const portSets = routed.map((trace) => {
      const result = new Set<string>();
      const first = trace.route[0];
      const last = trace.route.at(-1);
      for (const [point, pcbPortId] of [
        [first, first?.route_type === "wire" ? first.start_pcb_port_id : undefined],
        [last, last?.route_type === "wire" ? last.end_pcb_port_id : undefined],
      ] as const) {
        if (point?.route_type !== "wire" || pcbPortId === undefined || !endpointIntersectsPad(point, pcbPortId)) continue;
        const sourcePortId = pcbPortSource.get(pcbPortId);
        if (sourcePortId !== undefined && sourcePortIdentity.get(sourcePortId) === identity) {
          covered.add(sourcePortId);
          result.add(pcbPortId);
        }
      }
      return result;
    });
    const routedSegments = routed.map((trace) => traceSegments(trace));
    for (const sourcePortId of requiredSourcePorts) {
      if (!covered.has(sourcePortId)) connectivityFailures.add(`${sourcePortId}:unrouted-port`);
    }
    const parents = routed.map((_, index) => index);
    const find = (value: number): number => {
      while (parents[value] !== value) {
        parents[value] = parents[parents[value]!]!;
        value = parents[value]!;
      }
      return value;
    };
    const join = (left: number, right: number): void => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parents[b] = a;
    };
    for (let left = 0; left < routed.length; left += 1) {
      for (let right = left + 1; right < routed.length; right += 1) {
        let sharesPort = false;
        for (const id of portSets[left]!) {
          if (portSets[right]!.has(id)) {
            sharesPort = true;
            break;
          }
        }
        const sharesCopper = routedSegments[left]!.some((a) =>
          routedSegments[right]!.some((b) =>
            a.start.layer === b.start.layer &&
            lineSegmentDistance(a.start, a.end, b.start, b.end) <=
              Math.max(a.start.width, a.end.width) / 2 +
                Math.max(b.start.width, b.end.width) / 2 + 1e-9
          )
        );
        if (sharesPort || sharesCopper) join(left, right);
      }
    }
    if (new Set(routed.map((_, index) => find(index))).size !== 1) {
      connectivityFailures.add(`${groupSelector}:disconnected-physical-copper`);
    }
  }

  const uniqueRawKey = (key: string): string | undefined => {
    const identities = rawKeyIdentities.get(key);
    return identities?.size === 1 ? [...identities][0] : undefined;
  };
  const sourcePortIdsByIdentity = new Map<string, string[]>();
  for (const [sourcePortId, identity] of sourcePortIdentity) {
    const ids = sourcePortIdsByIdentity.get(identity) ?? [];
    ids.push(sourcePortId);
    sourcePortIdsByIdentity.set(identity, ids);
  }
  for (const ids of sourcePortIdsByIdentity.values()) ids.sort();
  const sourcePortIdsForSourceNet = (sourceNetId: string): readonly string[] => {
    const identity = sourceNetIdentity.get(sourceNetId);
    if (identity === undefined) return Object.freeze([]);
    return Object.freeze([...(sourcePortIdsByIdentity.get(identity) ?? [])]);
  };
  return Object.freeze({
    connectivityFailures: Object.freeze([...connectivityFailures].sort()),
    pinAuthorityFailures: Object.freeze([...pinAuthorityFailures].sort()),
    netIdentityFailures: Object.freeze([...netIdentityFailures].sort()),
    unsupported: Object.freeze([...unsupported].sort()),
    netForSourcePortId: (id: string) => sourcePortIdentity.get(id),
    netForSourceTraceId: (id: string) => sourceTraceNet.get(id),
    netForSourceNetId: (id: string) => sourceNetIdentity.get(id),
    netForPcbPortId: (id: string) => {
      const sourcePortId = pcbPortSource.get(id);
      return sourcePortId === undefined ? undefined : sourcePortIdentity.get(sourcePortId);
    },
    netForPcbTraceId: (id: string) => pcbTraceIdentity.get(id),
    netForRawConnectivityKey: uniqueRawKey,
    sourcePortIdsForSourceNet,
  });
}
