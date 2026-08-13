// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import { any_circuit_element } from "circuit-json";

const UPSTREAM_COMPATIBILITY_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  source_project_metadata: new Set(["source_project_metadata_id"]),
  source_component: new Set(["wave_length", "symbol_display_value"]),
  pcb_board: new Set(["source_board_id"]),
  cad_component: new Set(["model_mtl_url"]),
  schematic_component: new Set(["rotation"]),
  pcb_trace: new Set(["connection_name", "connectsTo"]),
});

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Circuit JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value !== "object") {
    throw new TypeError(`Circuit JSON contains non-JSON ${typeof value}`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalizeJson(item)]),
  );
}

export function canonicalCircuitJson(circuitJson: readonly AnyCircuitElement[]): string {
  return `${JSON.stringify(normalizeJson(circuitJson))}\n`;
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
    value = JSON.parse(text);
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
    normalizeJson(element);
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
