#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPerformanceFixtureIdentity,
  assertPerformanceMeasurements,
  loadPerformanceBaselineAuthority,
  parsePerformanceFixtureIdentity,
  PERFORMANCE_FIXTURE_NAMES,
  type PerformanceBaselineAuthority,
  type PerformanceMeasurement,
} from "./performance-baseline";

const repositoryRoot = join(import.meta.dir, "..");

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} fields are incomplete or unknown`);
  }
}

export function validatePerformanceReportValue(
  value: unknown,
  authority: Readonly<PerformanceBaselineAuthority>,
  runtime: Readonly<{ platform: NodeJS.Platform; architecture: string; bunVersion: string }>,
): void {
  const report = record(value, "Performance report");
  exactKeys(report, [
    "schemaVersion", "baselineVersion", "baselineSha256", "bunVersion", "platform",
    "architecture", "environment", "baselineFixtures", "observedFixtures", "budgets",
    "measurements", "passed",
  ], "Performance report");
  const expectedEnvironment = `${runtime.platform}-${runtime.architecture}`;
  if (
    report.schemaVersion !== 1 || report.passed !== true ||
    report.baselineVersion !== authority.baseline.baselineVersion ||
    report.baselineSha256 !== authority.sha256 || report.bunVersion !== runtime.bunVersion ||
    report.platform !== runtime.platform || report.architecture !== runtime.architecture ||
    report.environment !== expectedEnvironment
  ) throw new Error("PERFORMANCE_REPORT_IDENTITY_INVALID");
  if (
    JSON.stringify(report.baselineFixtures) !== JSON.stringify(authority.baseline.fixtures) ||
    JSON.stringify(report.budgets) !== JSON.stringify(authority.baseline.environments[expectedEnvironment])
  ) throw new Error("PERFORMANCE_REPORT_BASELINE_EVIDENCE_INVALID");
  const observedFixtures = record(report.observedFixtures, "Performance report observed fixtures");
  exactKeys(observedFixtures, PERFORMANCE_FIXTURE_NAMES, "Performance report observed fixtures");
  for (const fixture of PERFORMANCE_FIXTURE_NAMES) {
    assertPerformanceFixtureIdentity(
      parsePerformanceFixtureIdentity(observedFixtures[fixture], `Observed ${fixture} fixture`),
      authority.baseline.fixtures[fixture],
      `performance report ${fixture}`,
    );
  }
  if (!Array.isArray(report.measurements)) throw new Error("Performance report measurements must be an array");
  const measurements = report.measurements.map((value, index) => {
    const measurement = record(value, `Performance measurement ${index}`);
    exactKeys(measurement, [
      "fixture", "workload", "elapsedMilliseconds", "peakRssBytes", "swapCount", "exitCode",
    ], `Performance measurement ${index}`);
    return measurement as unknown as PerformanceMeasurement;
  });
  assertPerformanceMeasurements({
    baseline: authority.baseline,
    environment: expectedEnvironment,
    bunVersion: runtime.bunVersion,
    measurements,
  });
}

export async function validateCurrentPerformanceReport(): Promise<string> {
  const outputDirectory = join(repositoryRoot, ".pcboo-ci");
  const filename = `performance-${process.platform}-${process.arch}.json`;
  const inventory = (await readdir(outputDirectory)).sort();
  if (JSON.stringify(inventory) !== JSON.stringify([filename])) {
    throw new Error("PERFORMANCE_REPORT_INVENTORY_INVALID");
  }
  const path = join(outputDirectory, filename);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("PERFORMANCE_REPORT_FILE_INVALID");
  }
  const bytes = await readFile(path);
  const authority = await loadPerformanceBaselineAuthority(
    join(repositoryRoot, "compatibility/performance.json"),
  );
  validatePerformanceReportValue(JSON.parse(bytes.toString("utf8")), authority, {
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
  });
  process.stdout.write(`PCBOO_PERFORMANCE_REPORT_VALID ${path}\n`);
  return path;
}

if (import.meta.main) {
  try {
    await validateCurrentPerformanceReport();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
