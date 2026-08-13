// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requireSupportedBunRuntime } from "../src/runtime";
import { superviseCiCommand } from "./run-ci-gate";
import {
  assertPerformanceMeasurements,
  assertPerformanceFixtureIdentity,
  loadPerformanceBaselineAuthority,
  parsePerformanceFixtureIdentity,
  PERFORMANCE_FIXTURE_NAMES,
  PERFORMANCE_WORKLOAD_NAMES,
  type PerformanceFixtureIdentity,
  type PerformanceFixtureName,
  type PerformanceMeasurement,
} from "./performance-baseline";

const repositoryRoot = join(import.meta.dir, "..");

export async function runPerformanceQualification(): Promise<string> {
  const outputPath = join(repositoryRoot, ".pcboo-ci", `performance-${process.platform}-${process.arch}.json`);
  const temporaryOutputPath = `${outputPath}.${process.pid}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  await rm(temporaryOutputPath, { force: true });
  requireSupportedBunRuntime();
  const baselinePath = join(repositoryRoot, "compatibility/performance.json");
  const baselineAuthority = await loadPerformanceBaselineAuthority(baselinePath);
  const baseline = baselineAuthority.baseline;
  const environment = `${process.platform}-${process.arch}`;
  const measurements: PerformanceMeasurement[] = [];
  const observedFixtures: Partial<Record<PerformanceFixtureName, Readonly<PerformanceFixtureIdentity>>> = {};
  const observationDirectory = await mkdtemp(join(tmpdir(), "pcboo-performance-observations-"));
  let cancelled = false;
  const cancellation = new AbortController();
  const cancel = () => {
    cancelled = true;
    cancellation.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    for (const fixture of PERFORMANCE_FIXTURE_NAMES) {
      for (const workload of PERFORMANCE_WORKLOAD_NAMES) {
        if (cancelled) throw new Error("PERFORMANCE_QUALIFICATION_CANCELLED");
        process.stdout.write(`PCBOO_PERFORMANCE_PROGRESS ${JSON.stringify({ state: "started", fixture, workload })}\n`);
        const observationPath = join(observationDirectory, `${fixture}.json`);
        const record = await superviseCiCommand(
          `performance-${fixture}-${workload}`,
          [
            process.execPath,
            join(import.meta.dir, "performance-workload.ts"),
            fixture,
            workload,
            baselineAuthority.sha256,
            ...(workload === "cold-build" ? [observationPath] : []),
          ],
          {
            signal: cancellation.signal,
            onStarted: () => process.stdout.write(`PCBOO_PERFORMANCE_PROGRESS ${JSON.stringify({ state: "running", fixture, workload })}\n`),
          },
        );
        if (cancelled) {
          process.stdout.write(`PCBOO_PERFORMANCE_PROGRESS ${JSON.stringify({ state: "cancelled", fixture, workload })}\n`);
          throw new Error("PERFORMANCE_QUALIFICATION_CANCELLED");
        }
        measurements.push(Object.freeze({
          fixture,
          workload,
          elapsedMilliseconds: record.elapsedMilliseconds,
          peakRssBytes: record.sampledProcessTreePeakRssBytes,
          swapCount: record.swapCount,
          exitCode: record.exitCode,
        }));
        process.stdout.write(`PCBOO_PERFORMANCE_PROGRESS ${JSON.stringify({ state: "completed", fixture, workload, elapsedMilliseconds: record.elapsedMilliseconds, peakRssBytes: record.sampledProcessTreePeakRssBytes })}\n`);
        if (record.exitCode !== 0) throw new Error(`PERFORMANCE_WORKLOAD_FAILED: ${fixture}/${workload}`);
        if (workload === "cold-build") {
          const observed = parsePerformanceFixtureIdentity(
            JSON.parse(await readFile(observationPath, "utf8")),
            `Observed ${fixture} fixture`,
          );
          assertPerformanceFixtureIdentity(observed, baseline.fixtures[fixture], `${fixture} qualification observation`);
          observedFixtures[fixture] = observed;
          await rm(observationPath, { force: true });
        }
      }
    }
    assertPerformanceMeasurements({ baseline, environment, bunVersion: Bun.version, measurements });
    for (const fixture of PERFORMANCE_FIXTURE_NAMES) {
      if (observedFixtures[fixture] === undefined) throw new Error(`PERFORMANCE_FIXTURE_OBSERVATION_MISSING: ${fixture}`);
    }
    const finalBaselineAuthority = await loadPerformanceBaselineAuthority(baselinePath);
    if (finalBaselineAuthority.sha256 !== baselineAuthority.sha256) throw new Error("PERFORMANCE_BASELINE_CHANGED");
    const report = Object.freeze({
      schemaVersion: 1,
      baselineVersion: baseline.baselineVersion,
      baselineSha256: baselineAuthority.sha256,
      bunVersion: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      environment,
      baselineFixtures: baseline.fixtures,
      observedFixtures,
      budgets: baseline.environments[environment],
      measurements: Object.freeze(measurements),
      passed: true,
    });
    await writeFile(temporaryOutputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryOutputPath, outputPath);
    process.stdout.write(`PCBOO_PERFORMANCE_REPORT ${outputPath}\n`);
    return outputPath;
  } finally {
    await rm(temporaryOutputPath, { force: true });
    await rm(observationDirectory, { recursive: true, force: true });
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  try {
    await runPerformanceQualification();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
