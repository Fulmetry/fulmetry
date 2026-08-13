// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";

export const QUANTITY_BASE_UNITS = Object.freeze({
  length: "mm",
  angle: "deg",
  resistance: "ohm",
  capacitance: "F",
  inductance: "H",
  voltage: "V",
  current: "A",
  frequency: "Hz",
  time: "ms",
} as const);

export const QUANTITY_ROUND_TRIP_RELATIVE_TOLERANCE = 1e-11;
export const QUANTITY_ROUND_TRIP_ABSOLUTE_TOLERANCE = 1e-24;

const UNIT_SCALE_TO_BASE = Object.freeze({
  length: Object.freeze({ mm: 1, cm: 10, m: 1_000, in: 25.4, mil: 0.0254 }),
  angle: Object.freeze({ deg: 1, rad: 180 / Math.PI }),
  resistance: Object.freeze({ ohm: 1, "Ω": 1, kohm: 1_000, "kΩ": 1_000, Mohm: 1_000_000, "MΩ": 1_000_000 }),
  capacitance: Object.freeze({ pF: 1e-12, nF: 1e-9, uF: 1e-6, "µF": 1e-6, mF: 1e-3, F: 1 }),
  inductance: Object.freeze({ nH: 1e-9, uH: 1e-6, "µH": 1e-6, mH: 1e-3, H: 1 }),
  voltage: Object.freeze({ uV: 1e-6, "µV": 1e-6, mV: 1e-3, V: 1, kV: 1_000 }),
  current: Object.freeze({ uA: 1e-6, "µA": 1e-6, mA: 1e-3, A: 1 }),
  frequency: Object.freeze({ Hz: 1, kHz: 1_000, MHz: 1_000_000, GHz: 1_000_000_000 }),
  time: Object.freeze({ ns: 1e-6, us: 1e-3, ms: 1, s: 1_000 }),
} as const);

export type UnitQuantity = keyof typeof UNIT_SCALE_TO_BASE;
export type QuantityUnit<Q extends UnitQuantity> = Q extends UnitQuantity
  ? keyof typeof UNIT_SCALE_TO_BASE[Q] & string
  : never;

const NUMBER_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function scaleFor<Q extends UnitQuantity>(quantity: Q, unit: string): number {
  const scales = UNIT_SCALE_TO_BASE[quantity] as Readonly<Record<string, number>>;
  const scale = scales[unit];
  if (scale === undefined) {
    throw new TypeError(
      `Unsupported ${quantity} unit ${JSON.stringify(unit)}; expected ${Object.keys(scales).join(", ")}`,
    );
  }
  return scale;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

/** Parse a strict PCBoo quantity string into its documented base unit. */
export function parseQuantity<Q extends UnitQuantity>(
  quantity: Q,
  input: number | string,
): number {
  if (typeof input === "number") return finite(input, `${quantity} value`);
  const units = Object.keys(UNIT_SCALE_TO_BASE[quantity]).sort((left, right) =>
    right.length - left.length || left.localeCompare(right)
  );
  const unit = units.find((candidate) => input.endsWith(candidate));
  if (unit === undefined) throw new TypeError(`${quantity} value has no supported unit`);
  const numericToken = input.slice(0, -unit.length);
  if (!NUMBER_TOKEN.test(numericToken)) {
    throw new TypeError(`${quantity} value must be one finite number followed by its unit`);
  }
  return finite(Number(numericToken) * scaleFor(quantity, unit), `${quantity} value`);
}

/** Format a base-unit value in another exact, parseable PCBoo representation. */
export function formatQuantity<Q extends UnitQuantity>(
  quantity: Q,
  baseValue: number,
  unit: QuantityUnit<Q>,
): string {
  const normalized = finite(baseValue, `${quantity} base value`);
  const represented = finite(normalized / scaleFor(quantity, unit), `${quantity} representation`);
  return `${String(represented)}${unit}`;
}

export function quantityValuesEqual(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const difference = Math.abs(left - right);
  return difference <= Math.max(
    QUANTITY_ROUND_TRIP_ABSOLUTE_TOLERANCE,
    Math.max(Math.abs(left), Math.abs(right)) * QUANTITY_ROUND_TRIP_RELATIVE_TOLERANCE,
  );
}

export function supportedQuantityUnits<Q extends UnitQuantity>(
  quantity: Q,
): readonly QuantityUnit<Q>[] {
  return Object.freeze(Object.keys(UNIT_SCALE_TO_BASE[quantity]).sort()) as readonly QuantityUnit<Q>[];
}

const SOURCE_COMPONENT_QUANTITY_FIELDS = Object.freeze({
  resistance: "resistance",
  capacitance: "capacitance",
  load_capacitance: "capacitance",
  inductance: "inductance",
  voltage: "voltage",
  max_voltage_rating: "voltage",
  peak_to_peak_voltage: "voltage",
  ac_magnitude: "voltage",
  current: "current",
  peak_to_peak_current: "current",
  frequency: "frequency",
  phase: "angle",
  ac_phase: "angle",
  pulse_delay: "time",
  rise_time: "time",
  fall_time: "time",
  pulse_width: "time",
  period: "time",
  max_trace_length: "length",
} satisfies Readonly<Record<string, UnitQuantity>>);

/**
 * Normalize the exact unit-bearing source-component fields that an accepted
 * tscircuit emitter may leave as authored strings. All other evidence is kept
 * byte-for-byte; this is not a generic JSON coercion pass.
 */
export function normalizeCircuitQuantityValues(
  circuitJson: readonly AnyCircuitElement[],
): AnyCircuitElement[] {
  return circuitJson.map((element) => {
    if (element.type !== "source_component") return structuredClone(element);
    const normalized = structuredClone(element) as AnyCircuitElement & Record<string, unknown>;
    for (const [field, quantity] of Object.entries(SOURCE_COMPONENT_QUANTITY_FIELDS)) {
      const value = normalized[field];
      if (typeof value === "string") normalized[field] = parseQuantity(quantity, value);
      else if (typeof value === "number") normalized[field] = finite(value, `${field} value`);
    }
    return normalized;
  });
}
