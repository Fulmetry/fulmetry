// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import {
  DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT,
  DIAGNOSTIC_REFERENCE_LIMIT,
  DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT,
  defineDiagnostic,
  diagnosticId,
  type Diagnostic,
} from "./diagnostics";
import { assuranceStatus, type AssuranceStatus } from "./status";
import { lineSegmentDistance } from "./fabrication-geometry";
import { deriveAuthoritativeConnectivity } from "./authoritative-connectivity";

export interface ElectricalAssessment {
  readonly status: AssuranceStatus<"electrical">;
  readonly diagnostics: readonly Diagnostic[];
  readonly errorCount: number;
  readonly warningCount: number;
}

const ELECTRICAL_DIAGNOSTIC_CLASS_LIMIT = 64;
const ELECTRICAL_FINDING_MEMBER_LIMIT = 16;

function boundedReference(value: string, limit = DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT): string {
  if (value.length <= limit) return value;
  const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  const suffix = `…#sha256:${digest}`;
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function circuitEvidence(reference: string): string {
  return boundedReference(`circuit-json:${reference}`);
}

function boundedMemberList<T>(
  groups: readonly (readonly T[])[],
  describe: (value: T) => string,
): string {
  const retained: string[] = [];
  let count = 0;
  for (const group of groups) {
    for (const value of group) {
      count += 1;
      if (retained.length < ELECTRICAL_FINDING_MEMBER_LIMIT) {
        retained.push(boundedReference(describe(value), 256));
      }
    }
  }
  retained.sort();
  const omitted = count - retained.length;
  return `${retained.join(",")}${omitted > 0 ? `,…(+${omitted})` : ""}`;
}

function hasAtLeastTwoDistinctIds<T>(
  groups: readonly (readonly T[])[],
  idFor: (value: T) => string,
): boolean {
  let first: string | undefined;
  for (const group of groups) {
    for (const value of group) {
      const id = idFor(value);
      if (first === undefined) first = id;
      else if (id !== first) return true;
    }
  }
  return false;
}

class BoundedFindings {
  readonly #references: string[] = [];
  #occurrenceCount = 0;

  pushLazy(buildReference: () => string): number {
    this.#occurrenceCount += 1;
    if (this.#references.length < DIAGNOSTIC_REFERENCE_LIMIT) {
      this.#references.push(boundedReference(buildReference()));
    }
    return this.#occurrenceCount;
  }

  addAll(values: Iterable<string>): void {
    for (const value of values) {
      this.#occurrenceCount += 1;
      if (this.#references.length < DIAGNOSTIC_REFERENCE_LIMIT) {
        this.#references.push(boundedReference(value));
      }
    }
  }

  get length(): number {
    return this.#occurrenceCount;
  }

  get omittedReferenceCount(): number {
    return Math.max(0, this.#occurrenceCount - this.#references.length);
  }

  sortedReferences(): string[] {
    return [...this.#references].sort();
  }
}

function elementIdentity(element: AnyCircuitElement): string {
  const record = element as unknown as Record<string, unknown>;
  const primary = record[`${element.type}_id`];
  return typeof primary === "string" ? primary : element.type;
}

function parseProvidedVoltage(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([pnumµμkMGT]?)(?:V)?$/u,
  );
  if (match === null) return undefined;
  const multiplier = ({
    "": 1,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    µ: 1e-6,
    μ: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  } as const)[match[2] as "" | "p" | "n" | "u" | "µ" | "μ" | "m" | "k" | "M" | "G" | "T"];
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function materiallyDifferentVoltages(values: readonly number[]): boolean {
  if (values.length < 2) return false;
  let minimum = values[0]!;
  let maximum = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    minimum = Math.min(minimum, values[index]!);
    maximum = Math.max(maximum, values[index]!);
  }
  return maximum - minimum > Math.max(1e-12, Math.max(Math.abs(minimum), Math.abs(maximum)) * 1e-9);
}

function voltagesApproximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(
    1e-12,
    Math.max(Math.abs(left), Math.abs(right)) * 1e-9,
  );
}

function diagnosticForGroup(
  kind: "error" | "warning",
  type: string,
  elements: AnyCircuitElement[],
  count: number,
): Readonly<Diagnostic> {
  const stableType = type.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 96) || "EMITTED";
  const messages: string[] = [];
  let messageCharacters = 0;
  for (const element of elements) {
    const message = (element as unknown as { message?: unknown }).message;
    if (typeof message !== "string" || !message.trim()) continue;
    const bounded = boundedReference(message, 512);
    const addedCharacters = bounded.length + (messages.length === 0 ? 0 : 2);
    if (messageCharacters + addedCharacters > DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT - 256) break;
    messages.push(bounded);
    messageCharacters += addedCharacters;
  }
  return defineDiagnostic({
    id: diagnosticId(`ELECTRICAL_${stableType}_001`),
    severity: kind,
    dimension: "electrical",
    message: messages.length > 0
      ? `${messages.join("; ")}${count > elements.length ? `; ${count - elements.length} additional record(s) omitted` : ""}`
      : `tSCircuit emitted ${count} ${type} record(s)`,
    waiverPolicy: "forbidden",
    objects: elements.map((element) => boundedReference(elementIdentity(element))),
    ...(count > elements.length ? { omittedObjectCount: count - elements.length } : {}),
    sourceLocations: [],
    evidence: [`circuit-json:${type}:${elements.length}`],
    nextCommand: `pcboo inspect --status electrical --rule ELECTRICAL_${stableType}_001`,
  });
}

/**
 * Fail closed over tscircuit's emitted electrical evidence. A warning means
 * electrical verification is incomplete, never silently passed.
 */
export function assessCircuitElectrical(
  circuitJson: readonly AnyCircuitElement[],
): Readonly<ElectricalAssessment> {
  const grouped = new Map<string, { count: number; elements: AnyCircuitElement[] }>();
  let emittedOverflowRecordCount = 0;
  let emittedOverflowHasError = false;
  for (const element of circuitJson) {
    const type = (element as { type?: unknown }).type;
    if (typeof type !== "string") {
      emittedOverflowRecordCount += 1;
      emittedOverflowHasError = true;
      continue;
    }
    if (!type.endsWith("_error") && !type.endsWith("_warning")) {
      continue;
    }
    let group = grouped.get(type);
    if (
      type.length > 128 ||
      (group === undefined && grouped.size >= ELECTRICAL_DIAGNOSTIC_CLASS_LIMIT)
    ) {
      emittedOverflowRecordCount += 1;
      if (type.endsWith("_error")) emittedOverflowHasError = true;
      continue;
    }
    group ??= { count: 0, elements: [] };
    group.count += 1;
    if (group.elements.length < DIAGNOSTIC_REFERENCE_LIMIT) group.elements.push(element);
    grouped.set(type, group);
  }
  const diagnostics: Readonly<Diagnostic>[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, group]) =>
      diagnosticForGroup(
        type.endsWith("_error") ? "error" : "warning",
        type,
        group.elements,
        group.count,
      )
    );
  if (emittedOverflowRecordCount > 0) {
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("ELECTRICAL_EMITTED_CLASS_OVERFLOW_001"),
      severity: emittedOverflowHasError ? "error" : "warning",
      dimension: "electrical",
      message: `${emittedOverflowRecordCount} malformed or excess emitted diagnostic record(s) were collapsed into this bounded class`,
      waiverPolicy: "forbidden",
      objects: [`circuit-json:emitted-diagnostic-overflow:${emittedOverflowRecordCount}`],
      sourceLocations: [],
      evidence: [`circuit-json:emitted-diagnostic-overflow:${emittedOverflowRecordCount}`],
      nextCommand: "pcboo inspect --status electrical --rule ELECTRICAL_EMITTED_CLASS_OVERFLOW_001",
    }));
  }
  const connectivityFailures = new BoundedFindings();
  const authoritativeConnectivity = deriveAuthoritativeConnectivity(circuitJson);
  connectivityFailures.addAll(authoritativeConnectivity.connectivityFailures);
  connectivityFailures.addAll(authoritativeConnectivity.netIdentityFailures);
  const unsupportedConnectivity = new BoundedFindings();
  unsupportedConnectivity.addAll(authoritativeConnectivity.unsupported);
  const sourceTraces = circuitJson.filter((element) => element.type === "source_trace");
  const sourceNets = circuitJson.filter((element) => element.type === "source_net");
  const sourcePorts = circuitJson.filter((element) => element.type === "source_port");
  const sourcePortsById = new Map<string, typeof sourcePorts>();
  for (const port of sourcePorts) {
    const matches = sourcePortsById.get(port.source_port_id) ?? [];
    matches.push(port);
    sourcePortsById.set(port.source_port_id, matches);
  }
  const connectedSourcePortIds = new Set<string>();
  const internalConnectionPortGroups: string[][] = [];
  const internalConnectionIndexesByPortId = new Map<string, number[]>();
  for (const trace of sourceTraces) {
    const portIds = [...new Set(trace.connected_source_port_ids)];
    if (portIds.length > 1 || trace.connected_source_net_ids.length > 0) {
      for (const id of portIds) connectedSourcePortIds.add(id);
    }
  }
  for (const connection of circuitJson.filter(
    (element) => element.type === "source_component_internal_connection",
  )) {
    const portIds = [...new Set(connection.source_port_ids)];
    const declaredOwner = connection.source_component_id;
    if (
      typeof declaredOwner !== "string" ||
      !portIds.every((id) => {
        const matches = sourcePortsById.get(id) ?? [];
        return matches.length === 1 && matches[0]!.source_component_id === declaredOwner;
      })
    ) continue;
    const connectionIndex = internalConnectionPortGroups.length;
    internalConnectionPortGroups.push(portIds);
    for (const id of portIds) {
      const indexes = internalConnectionIndexesByPortId.get(id) ?? [];
      indexes.push(connectionIndex);
      internalConnectionIndexesByPortId.set(id, indexes);
    }
  }
  const externallyConnectedQueue = [...connectedSourcePortIds];
  const visitedInternalConnectionIndexes = new Set<number>();
  for (let index = 0; index < externallyConnectedQueue.length; index += 1) {
    const id = externallyConnectedQueue[index]!;
    for (const connectionIndex of internalConnectionIndexesByPortId.get(id) ?? []) {
      if (visitedInternalConnectionIndexes.has(connectionIndex)) continue;
      visitedInternalConnectionIndexes.add(connectionIndex);
      for (const peerId of internalConnectionPortGroups[connectionIndex]!) {
        if (!connectedSourcePortIds.has(peerId)) {
          connectedSourcePortIds.add(peerId);
          externallyConnectedQueue.push(peerId);
        }
      }
    }
  }
  const pcbPorts = circuitJson.filter((element) => element.type === "pcb_port");
  const smtPads = circuitJson.filter((element) => element.type === "pcb_smtpad");
  const platedPads = circuitJson.filter((element) => element.type === "pcb_plated_hole");
  const physicalVias = circuitJson.filter((element) => element.type === "pcb_via");
  const pcbTraces = circuitJson.filter((element) => element.type === "pcb_trace");
  const portsByElectricalNet = new Map<string, typeof sourcePorts>();
  for (const port of sourcePorts) {
    const net = authoritativeConnectivity.netForSourcePortId(port.source_port_id);
    if (net === undefined) continue;
    const ports = portsByElectricalNet.get(net) ?? [];
    ports.push(port);
    portsByElectricalNet.set(net, ports);
  }
  const driverConflicts = new BoundedFindings();
  const unsupportedDriverMetadata = new BoundedFindings();
  const pinObligationFailures = new BoundedFindings();
  const unsupportedPinMetadata = new BoundedFindings();
  for (const [net, ports] of portsByElectricalNet) {
    const netReference = boundedReference(net, 512);
    const pushPull = ports.filter(({ is_using_push_pull }) => is_using_push_pull === true);
    const openDrain = ports.filter(({ is_using_open_drain }) => is_using_open_drain === true);
    const parsedVoltageByPortId = new Map<string, number>();
    const voltageProviders = ports.flatMap((port) => {
      if (port.provides_voltage === undefined) return [];
      const voltage = parseProvidedVoltage(port.provides_voltage);
      if (voltage === undefined) {
        unsupportedDriverMetadata.pushLazy(() => `${netReference}:${port.source_port_id}:provides-voltage`);
        return [];
      }
      parsedVoltageByPortId.set(port.source_port_id, voltage);
      return [{ id: port.source_port_id, voltage }];
    });
    const powerProviders = ports.filter((port) => {
      const voltage = parsedVoltageByPortId.get(port.source_port_id);
      if (voltage !== undefined) return Math.abs(voltage) > 1e-12;
      return port.provides_power === true;
    });
    const distinctPowerProviderOwners = new Set(
      powerProviders.map(({ source_component_id }) => source_component_id),
    );
    if (
      distinctPowerProviderOwners.size > 1 &&
      powerProviders.some(({ source_port_id }) => !parsedVoltageByPortId.has(source_port_id))
    ) {
      unsupportedDriverMetadata.pushLazy(() =>
        `${netReference}:multiple-power-providers-without-comparable-voltage:` +
        boundedMemberList([powerProviders], ({ source_port_id }) => source_port_id),
      );
    }
    const groundProviders = ports.filter((port) =>
      port.provides_ground === true ||
      (parsedVoltageByPortId.has(port.source_port_id) &&
        Math.abs(parsedVoltageByPortId.get(port.source_port_id)!) <= 1e-12)
    );
    const voltageProviderIndex = [...voltageProviders].sort(
      (left, right) => left.voltage - right.voltage || left.id.localeCompare(right.id),
    );
    const hasMatchingVoltageProvider = (required: number, requesterId: string): boolean => {
      const window = Math.max(1e-12, Math.abs(required) * 1.000000002e-9);
      const lower = required - window;
      let low = 0;
      let high = voltageProviderIndex.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (voltageProviderIndex[middle]!.voltage < lower) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < voltageProviderIndex.length; index += 1) {
        const provider = voltageProviderIndex[index]!;
        if (provider.voltage > required + window) return false;
        if (
          provider.id !== requesterId &&
          voltagesApproximatelyEqual(provider.voltage, required)
        ) return true;
      }
      return false;
    };
    const powerProviderIds = new Set(powerProviders.map(({ source_port_id }) => source_port_id));
    const groundProviderIds = new Set(groundProviders.map(({ source_port_id }) => source_port_id));
    const hasDistinctProvider = (ids: ReadonlySet<string>, requesterId: string): boolean =>
      ids.size > (ids.has(requesterId) ? 1 : 0);
    for (const port of ports) {
      const id = port.source_port_id;
      const connected = connectedSourcePortIds.has(id);
      if (port.must_be_connected === true && !connected) {
        pinObligationFailures.pushLazy(() => `${id}:must-be-connected`);
      }
      if (port.do_not_connect === true && connected) {
        pinObligationFailures.pushLazy(() => `${id}:do-not-connect-is-connected`);
      }
      if (port.requires_ground === true && !hasDistinctProvider(groundProviderIds, id)) {
        pinObligationFailures.pushLazy(() => `${id}:requires-ground:${netReference}`);
      }
      if (port.requires_power === true && !hasDistinctProvider(powerProviderIds, id)) {
        pinObligationFailures.pushLazy(() => `${id}:requires-power:${netReference}`);
      }
      if (port.requires_voltage !== undefined) {
        const requiredVoltage = parseProvidedVoltage(port.requires_voltage);
        if (requiredVoltage === undefined) {
          unsupportedPinMetadata.pushLazy(() => `${id}:requires-voltage`);
        } else {
          const matchedVoltage = hasMatchingVoltageProvider(requiredVoltage, id);
          const matchedGround = Math.abs(requiredVoltage) <= 1e-12 &&
            hasDistinctProvider(groundProviderIds, id);
          if (!matchedVoltage && !matchedGround) {
            pinObligationFailures.pushLazy(() => `${id}:requires-voltage:${requiredVoltage}V:${netReference}`);
          }
        }
      }
    }
    if (pushPull.length > 1) {
      driverConflicts.pushLazy(() =>
        `${netReference}:push-pull:${boundedMemberList([pushPull], ({ source_port_id }) => source_port_id)}`,
      );
    }
    if (pushPull.length > 0 && openDrain.length > 0) {
      driverConflicts.pushLazy(() =>
        `${netReference}:mixed-push-pull-open-drain:` +
        boundedMemberList([pushPull, openDrain], ({ source_port_id }) => source_port_id),
      );
    }
    if (
      pushPull.length > 0 && powerProviders.length + groundProviders.length > 0 &&
      hasAtLeastTwoDistinctIds(
        [pushPull, powerProviders, groundProviders],
        ({ source_port_id }) => source_port_id,
      )
    ) {
      driverConflicts.pushLazy(() =>
        `${netReference}:push-pull-fixed-provider:` +
        boundedMemberList(
          [pushPull, powerProviders, groundProviders],
          ({ source_port_id }) => source_port_id,
        ),
      );
    }
    if (
      openDrain.length > 0 && powerProviders.length > 0 &&
      hasAtLeastTwoDistinctIds(
        [openDrain, powerProviders],
        ({ source_port_id }) => source_port_id,
      )
    ) {
      driverConflicts.pushLazy(() =>
        `${netReference}:open-drain-power-provider:` +
        boundedMemberList(
          [openDrain, powerProviders],
          ({ source_port_id }) => source_port_id,
        ),
      );
    }
    if (powerProviders.length > 0 && groundProviders.length > 0) {
      driverConflicts.pushLazy(() =>
        `${netReference}:power-ground:` +
        boundedMemberList(
          [powerProviders, groundProviders],
          ({ source_port_id }) => source_port_id,
        ),
      );
    }
    if (materiallyDifferentVoltages(voltageProviders.map(({ voltage }) => voltage))) {
      driverConflicts.pushLazy(() =>
        `${netReference}:provided-voltage:${boundedMemberList(
          [voltageProviders],
          ({ id, voltage }) => `${id}=${voltage}V`,
        )}`,
      );
    }
  }
  // Obligations must fail closed even when the port never reached an
  // authoritative net. Otherwise deleting the only connection could also
  // delete the evidence that makes must_be_connected/requires_* enforceable.
  for (const port of sourcePorts) {
    if (authoritativeConnectivity.netForSourcePortId(port.source_port_id) !== undefined) continue;
    const id = port.source_port_id;
    const connected = connectedSourcePortIds.has(id);
    if (port.must_be_connected === true && !connected) {
      pinObligationFailures.pushLazy(() => `${id}:must-be-connected:unresolved-net`);
    }
    if (port.do_not_connect === true && connected) {
      pinObligationFailures.pushLazy(() => `${id}:do-not-connect-is-connected:unresolved-net`);
    }
    if (port.requires_ground === true) {
      pinObligationFailures.pushLazy(() => `${id}:requires-ground:unresolved-net`);
    }
    if (port.requires_power === true) {
      pinObligationFailures.pushLazy(() => `${id}:requires-power:unresolved-net`);
    }
    if (port.requires_voltage !== undefined) {
      const requiredVoltage = parseProvidedVoltage(port.requires_voltage);
      if (requiredVoltage === undefined) {
        unsupportedPinMetadata.pushLazy(() => `${id}:requires-voltage`);
      } else {
        pinObligationFailures.pushLazy(() => `${id}:requires-voltage:${requiredVoltage}V:unresolved-net`);
      }
    }
  }
  if (driverConflicts.length > 0) {
    const conflicts = driverConflicts.sortedReferences();
    const omitted = driverConflicts.omittedReferenceCount;
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("ELECTRICAL_DRIVER_CONFLICT_001"),
      severity: "error",
      dimension: "electrical",
      message: "Authoritative logical nets contain conflicting active drivers or power-provider voltages",
      waiverPolicy: "forbidden",
      objects: conflicts,
      sourceLocations: [],
      evidence: conflicts.map(circuitEvidence),
      ...(omitted === 0 ? {} : {
        omittedObjectCount: omitted,
        omittedEvidenceCount: omitted,
      }),
      nextCommand: "pcboo inspect --status electrical --rule ELECTRICAL_DRIVER_CONFLICT_001",
    }));
  }
  if (unsupportedDriverMetadata.length > 0) {
    const unsupported = unsupportedDriverMetadata.sortedReferences();
    const omitted = unsupportedDriverMetadata.omittedReferenceCount;
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("ELECTRICAL_DRIVER_METADATA_UNSUPPORTED_001"),
      severity: "warning",
      dimension: "electrical",
      message: "Power-provider compatibility cannot be determined conservatively from declared voltage metadata",
      waiverPolicy: "forbidden",
      objects: unsupported,
      sourceLocations: [],
      evidence: unsupported.map(circuitEvidence),
      ...(omitted === 0 ? {} : {
        omittedObjectCount: omitted,
        omittedEvidenceCount: omitted,
      }),
      nextCommand: "pcboo inspect --status electrical --rule ELECTRICAL_DRIVER_METADATA_UNSUPPORTED_001",
    }));
  }
  if (pinObligationFailures.length > 0) {
    const failures = pinObligationFailures.sortedReferences();
    const omitted = pinObligationFailures.omittedReferenceCount;
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("ELECTRICAL_PIN_OBLIGATION_001"),
      severity: "error",
      dimension: "electrical",
      message: "One or more source-port connection, power, ground, or voltage obligations are unsatisfied",
      waiverPolicy: "forbidden",
      objects: failures,
      sourceLocations: [],
      evidence: failures.map(circuitEvidence),
      ...(omitted === 0 ? {} : {
        omittedObjectCount: omitted,
        omittedEvidenceCount: omitted,
      }),
      nextCommand: "pcboo inspect --status electrical --rule ELECTRICAL_PIN_OBLIGATION_001",
    }));
  }
  if (unsupportedPinMetadata.length > 0) {
    const unsupported = unsupportedPinMetadata.sortedReferences();
    const omitted = unsupportedPinMetadata.omittedReferenceCount;
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("ELECTRICAL_PIN_METADATA_UNSUPPORTED_001"),
      severity: "warning",
      dimension: "electrical",
      message: "One or more required pin voltages cannot be interpreted conservatively",
      waiverPolicy: "forbidden",
      objects: unsupported,
      sourceLocations: [],
      evidence: unsupported.map(circuitEvidence),
      ...(omitted === 0 ? {} : {
        omittedObjectCount: omitted,
        omittedEvidenceCount: omitted,
      }),
      nextCommand: "pcboo inspect --status electrical --rule ELECTRICAL_PIN_METADATA_UNSUPPORTED_001",
    }));
  }
  const sourceTraceById = new Map<string, typeof sourceTraces>();
  const sourceNetCountById = new Map<string, number>();
  for (const net of sourceNets) {
    sourceNetCountById.set(
      net.source_net_id,
      (sourceNetCountById.get(net.source_net_id) ?? 0) + 1,
    );
  }
  for (const trace of sourceTraces) {
    const values = sourceTraceById.get(trace.source_trace_id) ?? [];
    values.push(trace);
    sourceTraceById.set(trace.source_trace_id, values);
    for (const sourcePortId of trace.connected_source_port_ids) {
      if ((sourcePortsById.get(sourcePortId)?.length ?? 0) !== 1) {
        connectivityFailures.pushLazy(() => `${trace.source_trace_id}:source-port:${sourcePortId}`);
      }
    }
    for (const sourceNetId of trace.connected_source_net_ids) {
      if (sourceNetCountById.get(sourceNetId) !== 1) {
        connectivityFailures.pushLazy(() => `${trace.source_trace_id}:source-net:${sourceNetId}`);
      }
    }
  }

  const endpointIntersectsPad = (
    point: { x: number; y: number; width: number; layer: string },
    pcbPortId: string,
  ): boolean => {
    const ports = pcbPorts.filter((port) => port.pcb_port_id === pcbPortId);
    if (ports.length !== 1 || !ports[0]!.layers.includes(point.layer as never)) return false;
    const pads = [
      ...smtPads.filter((pad) => pad.pcb_port_id === pcbPortId),
      ...platedPads.filter((pad) => "pcb_port_id" in pad && pad.pcb_port_id === pcbPortId),
    ];
    if (pads.length === 0) return false;
    return pads.some((pad) => {
      if (pad.type === "pcb_smtpad") {
        if (pad.layer !== point.layer) return false;
        if (pad.shape === "rect") {
          return Math.abs(point.x - pad.x) <= pad.width / 2 + point.width / 2 &&
            Math.abs(point.y - pad.y) <= pad.height / 2 + point.width / 2;
        }
        if (pad.shape === "circle") {
          return Math.hypot(point.x - pad.x, point.y - pad.y) <= pad.radius + point.width / 2;
        }
        return false;
      }
      if (!pad.layers.includes(point.layer as never) || pad.shape !== "circle") return false;
      return Math.hypot(point.x - pad.x, point.y - pad.y) <=
        pad.outer_diameter / 2 + point.width / 2;
    });
  };

  for (const sourceTrace of sourceTraces) {
    if (sourceTrace.connected_source_net_ids.length > 0) continue;
    const matches = pcbTraces.filter((trace) => trace.source_trace_id === sourceTrace.source_trace_id);
    if (matches.length !== 1) {
      connectivityFailures.pushLazy(() => `${sourceTrace.source_trace_id}:pcb-trace-count:${matches.length}`);
    }
  }
  for (const trace of pcbTraces) {
    if (pcbTraces.filter((candidate) => candidate.pcb_trace_id === trace.pcb_trace_id).length !== 1) {
      connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:duplicate-pcb-trace-id`);
    }
  }
  const sourceNetById = (sourceNetId: string) => {
    const matches = sourceNets.filter((net) => net.source_net_id === sourceNetId);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const traceConnectivityKey = (trace: (typeof pcbTraces)[number]): string | undefined => {
    return authoritativeConnectivity.netForPcbTraceId(trace.pcb_trace_id);
  };
  for (const via of physicalVias) {
    const traceId = via.pcb_trace_id;
    const owners = typeof traceId === "string"
      ? pcbTraces.filter((trace) => trace.pcb_trace_id === traceId)
      : [];
    if (typeof traceId === "string" && owners.length !== 1) {
      connectivityFailures.pushLazy(() => `${via.pcb_via_id}:pcb-trace:${String(traceId)}`);
    }
    if (owners.length === 1) {
      const routedMatches = owners[0]!.route.filter((point) =>
        point.route_type === "via" && point.x === via.x && point.y === via.y &&
        [via.from_layer, via.to_layer].includes(point.from_layer) &&
        [via.from_layer, via.to_layer].includes(point.to_layer)
      );
      if (routedMatches.length !== 1) {
        connectivityFailures.pushLazy(() => `${via.pcb_via_id}:owner-route-membership`);
      }
    }
    const viaSourceNet = typeof via.source_net_id === "string"
      ? sourceNetById(via.source_net_id)
      : undefined;
    if (typeof via.source_net_id === "string" && viaSourceNet === undefined) {
      connectivityFailures.pushLazy(() => `${via.pcb_via_id}:source-net:${via.source_net_id}`);
    }
    const ownerKey = owners.length === 1 ? traceConnectivityKey(owners[0]!) : undefined;
    const sourceNetKey = viaSourceNet === undefined
      ? undefined
      : authoritativeConnectivity.netForSourceNetId(viaSourceNet.source_net_id);
    const declaredKey = via.subcircuit_connectivity_map_key === undefined
      ? undefined
      : authoritativeConnectivity.netForRawConnectivityKey(
        via.subcircuit_connectivity_map_key,
      );
    if (ownerKey !== undefined && sourceNetKey !== undefined && ownerKey !== sourceNetKey) {
      connectivityFailures.pushLazy(() => `${via.pcb_via_id}:owner-source-net-identity`);
    }
    const authoritativeKey = ownerKey ?? sourceNetKey;
    if (
      authoritativeKey !== undefined && declaredKey !== undefined &&
      authoritativeKey !== declaredKey
    ) connectivityFailures.pushLazy(() => `${via.pcb_via_id}:connectivity-map-key`);
    if (authoritativeKey === undefined && declaredKey === undefined) {
      connectivityFailures.pushLazy(() => `${via.pcb_via_id}:unresolved-net-identity`);
    }
  }

  type PcbTrace = (typeof pcbTraces)[number];
  type Wire = Extract<PcbTrace["route"][number], { route_type: "wire" }>;
  const traceSegments = (trace: PcbTrace) => {
    const segments: Array<{ start: Wire; end: Wire }> = [];
    for (let index = 1; index < trace.route.length; index += 1) {
      const start = trace.route[index - 1]!;
      const end = trace.route[index]!;
      if (start.route_type === "wire" && end.route_type === "wire" && start.layer === end.layer) {
        segments.push({ start, end });
      }
    }
    return segments;
  };
  const endpointSourcePort = (point: Wire, pcbPortId: string | undefined): string | undefined => {
    if (pcbPortId === undefined || !endpointIntersectsPad(point, pcbPortId)) return undefined;
    const matches = pcbPorts.filter((port) => port.pcb_port_id === pcbPortId);
    return matches.length === 1 ? matches[0]!.source_port_id : undefined;
  };
  const validateRouteTransitions = (trace: PcbTrace): void => {
    if (trace.route[0]?.route_type !== "wire" || trace.route.at(-1)?.route_type !== "wire") {
      connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:route-endpoints`);
    }
    for (let index = 1; index < trace.route.length; index += 1) {
      const previous = trace.route[index - 1]!;
      const current = trace.route[index]!;
      if (
        previous.route_type === "wire" && current.route_type === "wire" &&
        previous.layer !== current.layer
      ) connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:layer-jump:${index}`);
    }
    for (let index = 0; index < trace.route.length; index += 1) {
      const point = trace.route[index]!;
      if (point.route_type !== "wire") continue;
      if (point.start_pcb_port_id !== undefined && index !== 0) {
        connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:interior-start-port:${index}`);
      }
      if (point.end_pcb_port_id !== undefined && index !== trace.route.length - 1) {
        connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:interior-end-port:${index}`);
      }
    }
    for (let index = 0; index < trace.route.length; index += 1) {
      const point = trace.route[index]!;
      if (point.route_type !== "via") continue;
      const before = trace.route[index - 1];
      const after = trace.route[index + 1];
      const matchingVias = physicalVias.filter((via) =>
        via.pcb_trace_id === trace.pcb_trace_id && via.x === point.x && via.y === point.y &&
        new Set([via.from_layer, via.to_layer]).size === 2 &&
        [via.from_layer, via.to_layer].includes(point.from_layer) &&
        [via.from_layer, via.to_layer].includes(point.to_layer) &&
        via.layers.includes(point.from_layer) && via.layers.includes(point.to_layer)
      );
      if (
        before?.route_type !== "wire" || after?.route_type !== "wire" ||
        before.x !== point.x || before.y !== point.y ||
        after.x !== point.x || after.y !== point.y ||
        before.layer !== point.from_layer || after.layer !== point.to_layer ||
        matchingVias.length !== 1
      ) connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:via:${index}`);
    }
    for (let index = 0; index < trace.route.length; index += 1) {
      const point = trace.route[index]!;
      if (point.route_type !== "through_pad") continue;
      const before = trace.route[index - 1];
      const after = trace.route[index + 1];
      const plated = point.pcb_plated_hole_id === undefined
        ? []
        : platedPads.filter((pad) => pad.pcb_plated_hole_id === point.pcb_plated_hole_id);
      const validPad = plated.length === 1 && point.pcb_smtpad_id === undefined &&
        plated[0]!.shape === "circle" &&
        plated[0]!.layers.includes(point.start_layer as never) &&
        plated[0]!.layers.includes(point.end_layer as never) &&
        Math.hypot(point.start.x - plated[0]!.x, point.start.y - plated[0]!.y) <= plated[0]!.outer_diameter / 2 &&
        Math.hypot(point.end.x - plated[0]!.x, point.end.y - plated[0]!.y) <= plated[0]!.outer_diameter / 2;
      const beforeConnected = before?.route_type === "wire" &&
        before.layer === point.start_layer && before.x === point.start.x && before.y === point.start.y;
      const afterConnected = after?.route_type === "wire" &&
        after.layer === point.end_layer && after.x === point.end.x && after.y === point.end.y;
      if (!validPad || !beforeConnected || !afterConnected || point.start_layer === point.end_layer) {
        connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:through-pad:${index}`);
      }
    }
  };
  for (const trace of pcbTraces) validateRouteTransitions(trace);

  const pcbTraceNet = (trace: PcbTrace): string | undefined => {
    const sourceReference = trace.source_trace_id;
    if (typeof sourceReference !== "string") return undefined;
    const logical = sourceTraceById.get(sourceReference);
    if (logical?.length === 1) {
      return logical[0]!.connected_source_net_ids.length === 1
        ? logical[0]!.connected_source_net_ids[0]
        : undefined;
    }
    return sourceNets.filter((net) => net.source_net_id === sourceReference).length === 1
      ? sourceReference
      : undefined;
  };

  for (const trace of pcbTraces) {
    const sourceTraceId = trace.source_trace_id;
    const logical = typeof sourceTraceId === "string"
      ? sourceTraceById.get(sourceTraceId)
      : undefined;
    if (logical?.length !== 1) {
      if (
        typeof sourceTraceId === "string" &&
        sourceNets.filter((net) => net.source_net_id === sourceTraceId).length === 1
      ) {
        continue;
      }
      connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:source-reference:${trace.source_trace_id}`);
      continue;
    }
    if (logical[0]!.connected_source_net_ids.length > 0) {
      if (logical[0]!.connected_source_net_ids.length !== 1) {
        connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:source-net-count:${logical[0]!.connected_source_net_ids.length}`);
      }
      continue;
    }
    const first = trace.route[0];
    const last = trace.route.at(-1);
    if (
      first?.route_type !== "wire" || last?.route_type !== "wire" ||
      !first.start_pcb_port_id || !last.end_pcb_port_id ||
      !endpointIntersectsPad(first, first.start_pcb_port_id) ||
      !endpointIntersectsPad(last, last.end_pcb_port_id)
    ) {
      connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:physical-endpoints`);
      continue;
    }
    const endpointSourcePorts = [first.start_pcb_port_id, last.end_pcb_port_id].map(
      (pcbPortId) => pcbPorts.find((port) => port.pcb_port_id === pcbPortId)?.source_port_id,
    );
    const declaredSourcePorts = [...new Set(logical[0]!.connected_source_port_ids)].sort();
    const manufacturedSourcePorts = endpointSourcePorts.every((id) => typeof id === "string")
      ? [...new Set(endpointSourcePorts as string[])].sort()
      : [];
    if (
      declaredSourcePorts.length !== logical[0]!.connected_source_port_ids.length ||
      declaredSourcePorts.length !== manufacturedSourcePorts.length ||
      declaredSourcePorts.some((id, index) => id !== manufacturedSourcePorts[index])
    ) {
      connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:logical-endpoints`);
    }
  }

  for (const sourceNet of sourceNets) {
    const logicalTraces = sourceTraces.filter((trace) =>
      trace.connected_source_net_ids.includes(sourceNet.source_net_id)
    );
    const requiredPorts = new Set([
      ...logicalTraces.flatMap((trace) => trace.connected_source_port_ids),
      ...authoritativeConnectivity.sourcePortIdsForSourceNet(sourceNet.source_net_id),
    ]);
    const routed = pcbTraces.filter((trace) => pcbTraceNet(trace) === sourceNet.source_net_id);
    if (requiredPorts.size === 0 && routed.length === 0) continue;
    if (routed.length === 0) {
      connectivityFailures.pushLazy(() => `${sourceNet.source_net_id}:pcb-trace-count:0`);
      continue;
    }
    const manufacturedPorts = new Set<string>();
    for (const trace of routed) {
      const first = trace.route[0];
      const last = trace.route.at(-1);
      if (first?.route_type !== "wire" || last?.route_type !== "wire") continue;
      const startId = endpointSourcePort(first, first.start_pcb_port_id);
      const endId = endpointSourcePort(last, last.end_pcb_port_id);
      if (first.start_pcb_port_id !== undefined && startId === undefined) {
        connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:net-start-pad`);
      }
      if (last.end_pcb_port_id !== undefined && endId === undefined) {
        connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:net-end-pad`);
      }
      if (startId !== undefined) manufacturedPorts.add(startId);
      if (endId !== undefined) manufacturedPorts.add(endId);
    }
    const required = [...requiredPorts].sort();
    const manufactured = [...manufacturedPorts].sort();
    if (
      required.length !== manufactured.length ||
      required.some((id, index) => id !== manufactured[index])
    ) connectivityFailures.pushLazy(() => `${sourceNet.source_net_id}:logical-endpoints`);

    const parents = routed.map((_, index) => index);
    const find = (value: number): number => {
      while (parents[value] !== value) {
        parents[value] = parents[parents[value]!]!;
        value = parents[value]!;
      }
      return value;
    };
    const union = (left: number, right: number): void => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parents[b] = a;
    };
    for (let left = 0; left < routed.length; left += 1) {
      for (let right = left + 1; right < routed.length; right += 1) {
        const a = routed[left]!;
        const b = routed[right]!;
        const validatedPorts = (candidate: PcbTrace): Set<string> => {
          const result = new Set<string>();
          const first = candidate.route[0];
          const last = candidate.route.at(-1);
          if (
            first?.route_type === "wire" && first.start_pcb_port_id !== undefined &&
            endpointIntersectsPad(first, first.start_pcb_port_id)
          ) result.add(first.start_pcb_port_id);
          if (
            last?.route_type === "wire" && last.end_pcb_port_id !== undefined &&
            endpointIntersectsPad(last, last.end_pcb_port_id)
          ) result.add(last.end_pcb_port_id);
          return result;
        };
        const aPorts = validatedPorts(a);
        const sharesPort = [...validatedPorts(b)].some((id) => aPorts.has(id));
        const sharesCopper = traceSegments(a).some((aSegment) =>
          traceSegments(b).some((bSegment) =>
            aSegment.start.layer === bSegment.start.layer &&
            lineSegmentDistance(aSegment.start, aSegment.end, bSegment.start, bSegment.end) <=
              Math.max(aSegment.start.width, aSegment.end.width) / 2 +
                Math.max(bSegment.start.width, bSegment.end.width) / 2 + 1e-9
          )
        );
        if (sharesPort || sharesCopper) union(left, right);
      }
    }
    if (new Set(routed.map((_, index) => find(index))).size !== 1) {
      connectivityFailures.pushLazy(() => `${sourceNet.source_net_id}:disconnected-copper-graph`);
    }
    for (const trace of routed) {
      const allOtherSegments = routed.filter((candidate) => candidate !== trace)
        .flatMap(traceSegments);
      const firstPoint = trace.route[0];
      const lastPoint = trace.route.at(-1);
      for (const [label, point, portId] of [
        ["start", firstPoint, firstPoint?.route_type === "wire" ? firstPoint.start_pcb_port_id : undefined],
        ["end", lastPoint, lastPoint?.route_type === "wire" ? lastPoint.end_pcb_port_id : undefined],
      ] as const) {
        if (point?.route_type !== "wire" || portId !== undefined) continue;
        const joined = allOtherSegments.some((segment) =>
          segment.start.layer === point.layer &&
          lineSegmentDistance(point, point, segment.start, segment.end) <=
            point.width / 2 + Math.max(segment.start.width, segment.end.width) / 2 + 1e-9
        );
        if (!joined) connectivityFailures.pushLazy(() => `${trace.pcb_trace_id}:dangling-${label}`);
      }
    }
  }
  if (connectivityFailures.length > 0) {
    const uniqueFailures = connectivityFailures.sortedReferences();
    const omitted = connectivityFailures.omittedReferenceCount;
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("ELECTRICAL_CONNECTIVITY_001"),
      severity: "error",
      dimension: "electrical",
      message: "Circuit JSON has unresolved logical traces, disconnected manufactured endpoints, or incomplete via transitions",
      waiverPolicy: "forbidden",
      objects: uniqueFailures,
      sourceLocations: [],
      evidence: uniqueFailures.map(circuitEvidence),
      ...(omitted === 0 ? {} : {
        omittedObjectCount: omitted,
        omittedEvidenceCount: omitted,
      }),
      nextCommand: "pcboo inspect --status electrical --rule ELECTRICAL_CONNECTIVITY_001",
    }));
  }
  if (unsupportedConnectivity.length > 0) {
    const unsupported = unsupportedConnectivity.sortedReferences();
    const omitted = unsupportedConnectivity.omittedReferenceCount;
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("ELECTRICAL_CONNECTIVITY_UNSUPPORTED_001"),
      severity: "warning",
      dimension: "electrical",
      message: "One or more logical connectivity constructs lack qualified physical proof",
      waiverPolicy: "forbidden",
      objects: unsupported,
      sourceLocations: [],
      evidence: unsupported.map(circuitEvidence),
      ...(omitted === 0 ? {} : {
        omittedObjectCount: omitted,
        omittedEvidenceCount: omitted,
      }),
      nextCommand: "pcboo inspect --status electrical --rule ELECTRICAL_CONNECTIVITY_UNSUPPORTED_001",
    }));
  }
  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
  const state = errorCount > 0 ? "failed" : warningCount > 0 ? "incomplete" : "passed";
  return Object.freeze({
    status: assuranceStatus("electrical", state, {
      diagnosticIds: diagnostics.map(({ id }) => id),
      summary: errorCount > 0
        ? `${errorCount} electrical error class(es)`
        : warningCount > 0
          ? `${warningCount} unresolved electrical warning class(es)`
          : "No tscircuit electrical errors or warnings",
    }),
    diagnostics: Object.freeze(diagnostics),
    errorCount,
    warningCount,
  });
}
