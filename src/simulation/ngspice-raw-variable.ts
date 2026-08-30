// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

export interface NgspiceRawVariableDeclaration {
  readonly index: number;
  readonly name: string;
  readonly type: string;
  readonly grid: number | null;
}

/** Parses the bounded ngspice ASCII-raw variable grammar used by Fulmetry.
 * ngspice 46 adds `grid=3` to logarithmic frequency axes. No other trailing
 * metadata is admitted until it is explicitly understood and tested. */
export function parseNgspiceRawVariableDeclaration(
  line: string,
  malformedMessage: string,
): Readonly<NgspiceRawVariableDeclaration> {
  if (line.length > 1_024) throw new Error(malformedMessage);
  const match = /^\s*(\d+)\s+(\S+)\s+(\S+)(?:\s+grid=(\d+))?\s*$/u.exec(line);
  if (match === null) throw new Error(malformedMessage);
  const index = Number(match[1]);
  const grid = match[4] === undefined ? null : Number(match[4]);
  if (!Number.isSafeInteger(index) || index < 0 || (
    grid !== null && (!Number.isSafeInteger(grid) || grid < 0 || grid > 7)
  )) throw new Error(malformedMessage);
  return Object.freeze({ index, name: match[2]!, type: match[3]!, grid });
}

export function isNgspiceFrequencyAxisName(name: string): boolean {
  return name.toLowerCase() === "frequency";
}

export function isNgspiceDcSweepAxisName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "v-sweep" || normalized === "v(v-sweep)";
}

/** ngspice 46 writes subnormal noise in the imaginary component of its
 * conceptually-real frequency scale. Bind acceptance to floating-point scale. */
export function isSemanticallyRealFrequencySample(real: number, imaginary: number): boolean {
  return Number.isFinite(real) && Number.isFinite(imaginary) &&
    Math.abs(imaginary) <= Number.EPSILON * Math.max(1, Math.abs(real));
}
