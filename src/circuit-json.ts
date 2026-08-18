// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import { any_circuit_element } from "circuit-json";
import { canonicalJsonStringify } from "./internal/canonical-json";
import { parseJsonWithoutDuplicateKeys } from "./upgrade/jsonc";

const UPSTREAM_COMPATIBILITY_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  source_project_metadata: new Set(["source_project_metadata_id"]),
  source_component: new Set(["wave_length", "symbol_display_value"]),
  pcb_board: new Set(["source_board_id"]),
  cad_component: new Set(["model_mtl_url"]),
  schematic_component: new Set(["rotation"]),
  pcb_trace: new Set(["connection_name", "connectsTo"]),
});

export function canonicalCircuitJson(circuitJson: readonly AnyCircuitElement[]): string {
  return `${canonicalJsonStringify(circuitJson, "Circuit JSON")}\n`;
}

function schemaCompatibleElement(element: Record<string, unknown>): Record<string, unknown> {
  const compatible = structuredClone(element);
  // The pinned circuit-json schema package trails the accepted tscircuit emitter for these fields.
  // Remove only the exact, type-checked incompatibilities from the validation copy.
  if (compatible.type === "pcb_component") {
    if (typeof compatible.display_offset_x === "number" && Number.isFinite(compatible.display_offset_x)) {
      delete compatible.display_offset_x;
    }
    if (typeof compatible.display_offset_y === "number" && Number.isFinite(compatible.display_offset_y)) {
      delete compatible.display_offset_y;
    }
  }
  if (
    (compatible.type === "pcb_hole" || compatible.type === "pcb_plated_hole") &&
    compatible.pcb_component_id === null
  ) delete compatible.pcb_component_id;
  if (
    compatible.type === "schematic_component" &&
    compatible.port_arrangement !== null &&
    typeof compatible.port_arrangement === "object" &&
    !Array.isArray(compatible.port_arrangement)
  ) {
    const arrangement = compatible.port_arrangement as Record<string, unknown>;
    for (const side of ["left_side", "right_side", "top_side", "bottom_side"]) {
      const value = arrangement[side];
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const pins = (value as Record<string, unknown>).pins;
      if (
        Array.isArray(pins) &&
        pins.every((pin) => typeof pin === "string" && /^pin[1-9]\d*$/.test(pin))
      ) {
        (value as Record<string, unknown>).pins = pins.map((pin) =>
          Number((pin as string).slice(3))
        );
      }
    }
  }
  return compatible;
}

function droppedSchemaPaths(input: unknown, output: unknown, prefix = ""): string[] {
  if (Array.isArray(input)) {
    if (!Array.isArray(output)) return [prefix || "$"];
    return input.flatMap((value, index) =>
      droppedSchemaPaths(value, output[index], `${prefix}[${index}]`)
    );
  }
  if (input === null || typeof input !== "object") return [];
  if (output === null || typeof output !== "object" || Array.isArray(output)) return [prefix || "$"];
  return Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
    if (!(key in (output as Record<string, unknown>))) return [`${prefix}${prefix ? "." : ""}${key}`];
    return droppedSchemaPaths(
      value,
      (output as Record<string, unknown>)[key],
      `${prefix}${prefix ? "." : ""}${key}`,
    );
  });
}

function validateCircuitElement(element: Record<string, unknown>, index: number): void {
  const validationInput = schemaCompatibleElement(element);
  const result = any_circuit_element.safeParse(validationInput);
  if (!result.success) {
    const first = result.error.issues[0];
    const location = first?.path.length ? ` at ${first.path.join(".")}` : "";
    throw new TypeError(
      `Circuit JSON element ${index} (${String(element.type)}) is incompatible with circuit-json@0.0.464${location}: ${first?.message ?? "schema rejected element"}`,
    );
  }
  const allowed = UPSTREAM_COMPATIBILITY_KEYS[String(element.type)] ?? new Set<string>();
  const dropped = droppedSchemaPaths(validationInput, result.data).filter((path) => !allowed.has(path));
  if (dropped.length > 0) {
    throw new TypeError(
      `Circuit JSON element ${index} (${String(element.type)}) contains schema-unknown field ${dropped[0]}`,
    );
  }
}

export function parseCanonicalCircuitJson(text: string): AnyCircuitElement[] {
  let value: unknown;
  try {
    value = parseJsonWithoutDuplicateKeys(text, "Circuit JSON evidence");
  } catch (error) {
    throw new TypeError(`Circuit JSON evidence is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value)) throw new TypeError("Circuit JSON evidence must be an array");
  const primaryIds = new Map<string, number>();
  for (const [index, element] of value.entries()) {
    if (
      element === null || typeof element !== "object" || Array.isArray(element) ||
      typeof (element as { type?: unknown }).type !== "string" ||
      !(element as { type: string }).type.trim()
    ) {
      throw new TypeError(`Circuit JSON element ${index} must be an object with a non-empty type`);
    }
    canonicalJsonStringify(element, `Circuit JSON element ${index}`);
    validateCircuitElement(element as Record<string, unknown>, index);
    const record = element as Record<string, unknown>;
    const primaryId = record[`${String(record.type)}_id`];
    if (typeof primaryId === "string") {
      const previous = primaryIds.get(primaryId);
      if (previous !== undefined) {
        throw new TypeError(`Circuit JSON primary id ${primaryId} is duplicated at elements ${previous} and ${index}`);
      }
      primaryIds.set(primaryId, index);
    }
  }
  const parsed = value as AnyCircuitElement[];
  if (canonicalCircuitJson(parsed) !== text) {
    throw new TypeError("Circuit JSON evidence is not in PCBoo canonical form");
  }
  return parsed;
}

const ROUTE_PROMOTION_ELEMENT_TYPES = new Set([
  "source_component",
  "source_port",
  "source_net",
  "source_trace",
  "pcb_port",
  "pcb_trace",
  "pcb_via",
]);

/**
 * Parses only the semantic and copper records trusted by route promotion.
 * Routers may reconstruct unrelated footprint geometry with colliding generated
 * IDs; that geometry is intentionally excluded and can never replace authored
 * components, pads, holes, or board mechanics.
 */
export function parseCanonicalRouteCandidateCircuitJson(text: string): AnyCircuitElement[] {
  let value: unknown;
  try {
    value = parseJsonWithoutDuplicateKeys(text, "Route candidate Circuit JSON");
  } catch (error) {
    throw new TypeError(`Route candidate Circuit JSON is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value)) throw new TypeError("Route candidate Circuit JSON must be an array");
  for (const [index, element] of value.entries()) {
    if (
      element === null || typeof element !== "object" || Array.isArray(element) ||
      typeof (element as { type?: unknown }).type !== "string" ||
      !(element as { type: string }).type.trim()
    ) throw new TypeError(`Route candidate Circuit JSON element ${index} must have a non-empty type`);
  }
  if (canonicalCircuitJson(value as AnyCircuitElement[]) !== text) {
    throw new TypeError("Route candidate Circuit JSON is not in PCBoo canonical form");
  }
  const routeElements = (value as AnyCircuitElement[]).filter((element) =>
    ROUTE_PROMOTION_ELEMENT_TYPES.has(element.type)
  );
  const byPrimaryId = new Map<string, Record<string, unknown>>();
  const normalized: AnyCircuitElement[] = [];
  for (const element of routeElements) {
    const record = element as AnyCircuitElement & Record<string, unknown>;
    const primaryId = record[`${record.type}_id`];
    if (typeof primaryId !== "string" || primaryId.length === 0) {
      throw new TypeError(`Route candidate ${record.type} is missing its primary id`);
    }
    const previous = byPrimaryId.get(primaryId);
    if (previous === undefined) {
      byPrimaryId.set(primaryId, record);
      normalized.push(element);
      continue;
    }
    if (canonicalJsonStringify(previous, "Route candidate element") === canonicalJsonStringify(record, "Route candidate element")) {
      continue;
    }
    if (record.type === "pcb_port" && previous.type === "pcb_port") {
      if (previous.source_port_id !== record.source_port_id) {
        throw new TypeError(`Route candidate PCB port ${primaryId} has conflicting source ports`);
      }
      continue;
    }
    if (record.type === "source_trace" && previous.type === "source_trace") {
      const previousNets = Array.isArray(previous.connected_source_net_ids)
        ? previous.connected_source_net_ids as unknown[]
        : [];
      const currentNets = Array.isArray(record.connected_source_net_ids)
        ? record.connected_source_net_ids as unknown[]
        : [];
      if (previousNets.length === 0 && currentNets.length > 0) {
        const index = normalized.indexOf(previous as AnyCircuitElement);
        if (index < 0) throw new Error("Route candidate normalization lost source-trace identity");
        normalized[index] = element;
        byPrimaryId.set(primaryId, record);
        continue;
      }
      if (
        currentNets.length === 0 ||
        canonicalJsonStringify(previousNets, "Source trace nets") ===
          canonicalJsonStringify(currentNets, "Source trace nets")
      ) continue;
      throw new TypeError(`Route candidate source trace ${primaryId} has conflicting nets`);
    }
    throw new TypeError(`Route candidate primary id ${primaryId} has conflicting records`);
  }
  return normalized;
}
