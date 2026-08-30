// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";

export const PERFORMANCE_FIXTURE_NAMES = ["small", "medium", "large"] as const;
export const PERFORMANCE_WORKLOAD_NAMES = [
  "cold-build",
  "incremental-rebuild",
  "inspection-query",
  "pcb-render",
  "check-drc",
  "detached-export",
] as const;
export const PERFORMANCE_ENVIRONMENT_NAMES = [
  "darwin-arm64",
] as const;

export type PerformanceFixtureName = typeof PERFORMANCE_FIXTURE_NAMES[number];
export type PerformanceWorkloadName = typeof PERFORMANCE_WORKLOAD_NAMES[number];

export interface PerformanceFixtureIdentity {
  readonly components: number;
  readonly pads: number;
  readonly traces: number;
  readonly layers: 2 | 4;
}

export interface PerformanceBudget {
  readonly maxElapsedMilliseconds: number;
  readonly maxPeakRssBytes: number;
}

export interface PerformanceBaseline {
  readonly schemaVersion: 1;
  readonly baselineVersion: string;
  readonly bunVersion: string;
  readonly workloads: readonly PerformanceWorkloadName[];
  readonly fixtures: Readonly<Record<PerformanceFixtureName, PerformanceFixtureIdentity>>;
  readonly environments: Readonly<Record<string, Readonly<Record<PerformanceFixtureName, PerformanceBudget>>>>;
}

export interface PerformanceMeasurement {
  readonly fixture: PerformanceFixtureName;
  readonly workload: PerformanceWorkloadName;
  readonly elapsedMilliseconds: number;
  readonly peakRssBytes: number;
  readonly swapCount: number;
  readonly exitCode: number;
}

export interface PerformanceBaselineAuthority {
  readonly baseline: Readonly<PerformanceBaseline>;
  readonly sha256: string;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields are incomplete or unknown`);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function parsePerformanceFixtureIdentity(
  value: unknown,
  label = "Performance fixture identity",
): Readonly<PerformanceFixtureIdentity> {
  const fixture = record(value, label);
  exactKeys(fixture, ["components", "pads", "traces", "layers"], label);
  const components = positiveInteger(fixture.components, `${label}.components`);
  const pads = positiveInteger(fixture.pads, `${label}.pads`);
  const layers = positiveInteger(fixture.layers, `${label}.layers`);
  if (![2, 4].includes(layers)) throw new Error(`${label}.layers must be 2 or 4`);
  if (!Number.isSafeInteger(fixture.traces) || Number(fixture.traces) < 0) {
    throw new Error(`${label}.traces must be a nonnegative integer`);
  }
  return Object.freeze({ components, pads, traces: Number(fixture.traces), layers: layers as 2 | 4 });
}

export function parsePerformanceBaseline(value: unknown): Readonly<PerformanceBaseline> {
  const root = record(value, "Performance baseline");
  exactKeys(root, ["schemaVersion", "baselineVersion", "bunVersion", "workloads", "fixtures", "environments"], "Performance baseline");
  if (root.schemaVersion !== 1 || typeof root.baselineVersion !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(root.baselineVersion)) {
    throw new Error("Performance baseline identity is invalid");
  }
  if (typeof root.bunVersion !== "string" || root.bunVersion.length === 0) throw new Error("Performance baseline Bun version is invalid");
  if (JSON.stringify(root.workloads) !== JSON.stringify(PERFORMANCE_WORKLOAD_NAMES)) throw new Error("Performance workload inventory is incomplete or reordered");
  const fixtures = record(root.fixtures, "Performance fixtures");
  exactKeys(fixtures, PERFORMANCE_FIXTURE_NAMES, "Performance fixtures");
  for (const name of PERFORMANCE_FIXTURE_NAMES) {
    const fixture = parsePerformanceFixtureIdentity(fixtures[name], `Performance fixture ${name}`);
    if (fixture.pads !== fixture.components || fixture.traces > Math.floor(fixture.components / 2)) {
      throw new Error(`Performance fixture ${name} cannot be constructed as deterministic routed pairs`);
    }
  }
  const environments = record(root.environments, "Performance environments");
  exactKeys(environments, PERFORMANCE_ENVIRONMENT_NAMES, "Performance environments");
  for (const [environment, fixtureBudgetsValue] of Object.entries(environments)) {
    const fixtureBudgets = record(fixtureBudgetsValue, `Performance environment ${environment}`);
    exactKeys(fixtureBudgets, PERFORMANCE_FIXTURE_NAMES, `Performance environment ${environment}`);
    for (const fixture of PERFORMANCE_FIXTURE_NAMES) {
      const budget = record(fixtureBudgets[fixture], `Performance budget ${environment}.${fixture}`);
      exactKeys(budget, ["maxElapsedMilliseconds", "maxPeakRssBytes"], `Performance budget ${environment}.${fixture}`);
      positiveInteger(budget.maxElapsedMilliseconds, `${environment}.${fixture}.maxElapsedMilliseconds`);
      positiveInteger(budget.maxPeakRssBytes, `${environment}.${fixture}.maxPeakRssBytes`);
    }
  }
  return deepFreeze(structuredClone(value) as PerformanceBaseline);
}

export async function loadPerformanceBaseline(path: string): Promise<Readonly<PerformanceBaseline>> {
  return (await loadPerformanceBaselineAuthority(path)).baseline;
}

export async function loadPerformanceBaselineAuthority(
  path: string,
): Promise<Readonly<PerformanceBaselineAuthority>> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 1024 * 1024) throw new Error("Performance baseline exceeds 1048576 bytes");
  const baseline = parsePerformanceBaseline(JSON.parse(bytes.toString("utf8")));
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return Object.freeze({ baseline, sha256 });
}

export function observePerformanceFixture(elements: unknown): Readonly<PerformanceFixtureIdentity> {
  if (!Array.isArray(elements)) throw new Error("Performance fixture output must be an array");
  const records = elements.filter(
    (element): element is Record<string, unknown> =>
      element !== null && typeof element === "object" && !Array.isArray(element),
  );
  if (records.length !== elements.length) throw new Error("Performance fixture output contains a non-object element");
  const boards = records.filter(({ type }) => type === "pcb_board");
  if (boards.length !== 1 || ![2, 4].includes(Number(boards[0]!.num_layers))) {
    throw new Error("Performance fixture output must contain one two- or four-layer board");
  }
  return Object.freeze({
    components: records.filter(({ type }) => type === "source_component").length,
    pads: records.filter(({ type }) => type === "pcb_smtpad" || type === "pcb_plated_hole").length,
    traces: records.filter(({ type }) => type === "pcb_trace").length,
    layers: Number(boards[0]!.num_layers) as 2 | 4,
  });
}

export function assertPerformanceFixtureIdentity(
  observed: Readonly<PerformanceFixtureIdentity>,
  expected: Readonly<PerformanceFixtureIdentity>,
  label: string,
): void {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`PERFORMANCE_FIXTURE_IDENTITY_MISMATCH: ${label}`);
  }
}

export function assertPerformanceMeasurements(options: {
  readonly baseline: Readonly<PerformanceBaseline>;
  readonly environment: string;
  readonly bunVersion: string;
  readonly measurements: readonly PerformanceMeasurement[];
}): void {
  if (options.bunVersion !== options.baseline.bunVersion) throw new Error(`PERFORMANCE_BASELINE_BUN_MISMATCH: expected ${options.baseline.bunVersion}, received ${options.bunVersion}`);
  const budgets = options.baseline.environments[options.environment];
  if (budgets === undefined) throw new Error(`PERFORMANCE_BASELINE_ENVIRONMENT_MISSING: ${options.environment}`);
  const expected = PERFORMANCE_FIXTURE_NAMES.flatMap((fixture) =>
    PERFORMANCE_WORKLOAD_NAMES.map((workload) => `${fixture}/${workload}`)
  );
  const actual = options.measurements.map(({ fixture, workload }) => `${fixture}/${workload}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("PERFORMANCE_MEASUREMENT_INVENTORY_INVALID");
  for (const measurement of options.measurements) {
    for (const [label, value] of [
      ["elapsedMilliseconds", measurement.elapsedMilliseconds],
      ["peakRssBytes", measurement.peakRssBytes],
      ["swapCount", measurement.swapCount],
      ["exitCode", measurement.exitCode],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`PERFORMANCE_MEASUREMENT_INVALID: ${measurement.fixture}/${measurement.workload} ${label}`);
      }
    }
    if (measurement.exitCode !== 0 || measurement.swapCount !== 0) throw new Error(`PERFORMANCE_WORKLOAD_FAILED: ${measurement.fixture}/${measurement.workload}`);
    const budget = budgets[measurement.fixture];
    if (measurement.elapsedMilliseconds > budget.maxElapsedMilliseconds) throw new Error(`PERFORMANCE_TIME_REGRESSION: ${measurement.fixture}/${measurement.workload} ${measurement.elapsedMilliseconds} > ${budget.maxElapsedMilliseconds}`);
    if (measurement.peakRssBytes > budget.maxPeakRssBytes) throw new Error(`PERFORMANCE_MEMORY_REGRESSION: ${measurement.fixture}/${measurement.workload} ${measurement.peakRssBytes} > ${budget.maxPeakRssBytes}`);
  }
}
