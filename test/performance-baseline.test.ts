import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertPerformanceFixtureIdentity,
  assertPerformanceMeasurements,
  loadPerformanceBaseline,
  loadPerformanceBaselineAuthority,
  observePerformanceFixture,
  parsePerformanceBaseline,
  parsePerformanceFixtureIdentity,
  PERFORMANCE_ENVIRONMENT_NAMES,
  PERFORMANCE_FIXTURE_NAMES,
  PERFORMANCE_WORKLOAD_NAMES,
  type PerformanceMeasurement,
} from "../scripts/performance-baseline";
import { validatePerformanceReportValue } from "../scripts/validate-performance-report";
import {
  assertPerformanceDetachedExport,
  createPerformanceFixture,
  type PerformanceCliRun,
} from "../scripts/performance-workload";
import { runCli } from "../src/cli/runner";

const baselinePath = join(import.meta.dir, "../compatibility/performance.json");

describe("versioned product performance qualification", () => {
  test("binds every declared fixture/workload to exact Bun and platform budgets", async () => {
    const baseline = await loadPerformanceBaseline(baselinePath);
    expect(baseline.bunVersion).toBe("1.3.14");
    expect(Object.keys(baseline.fixtures)).toEqual([...PERFORMANCE_FIXTURE_NAMES]);
    expect(baseline.workloads).toEqual(PERFORMANCE_WORKLOAD_NAMES);
    expect(baseline.fixtures).toEqual({
      small: { components: 5, pads: 5, traces: 2, layers: 2 },
      medium: { components: 50, pads: 50, traces: 25, layers: 4 },
      large: { components: 250, pads: 250, traces: 125, layers: 4 },
    });
    expect(Object.keys(baseline.environments)).toEqual([...PERFORMANCE_ENVIRONMENT_NAMES]);
  });

  test("rejects deliberate elapsed-time, RSS, swap, failure, and inventory regressions", async () => {
    const baseline = await loadPerformanceBaseline(baselinePath);
    const environment = "darwin-arm64";
    const measurements: PerformanceMeasurement[] = PERFORMANCE_FIXTURE_NAMES.flatMap((fixture) =>
      PERFORMANCE_WORKLOAD_NAMES.map((workload) => ({
        fixture, workload, elapsedMilliseconds: 1, peakRssBytes: 1, swapCount: 0, exitCode: 0,
      }))
    );
    expect(() => assertPerformanceMeasurements({ baseline, environment, bunVersion: baseline.bunVersion, measurements })).not.toThrow();

    for (const [mutation, code] of [
      [(entry: PerformanceMeasurement) => ({ ...entry, elapsedMilliseconds: baseline.environments[environment]!.small.maxElapsedMilliseconds + 1 }), "PERFORMANCE_TIME_REGRESSION"],
      [(entry: PerformanceMeasurement) => ({ ...entry, peakRssBytes: baseline.environments[environment]!.small.maxPeakRssBytes + 1 }), "PERFORMANCE_MEMORY_REGRESSION"],
      [(entry: PerformanceMeasurement) => ({ ...entry, swapCount: 1 }), "PERFORMANCE_WORKLOAD_FAILED"],
      [(entry: PerformanceMeasurement) => ({ ...entry, exitCode: 1 }), "PERFORMANCE_WORKLOAD_FAILED"],
    ] as const) {
      const attacked = [...measurements];
      attacked[0] = mutation(attacked[0]!);
      expect(() => assertPerformanceMeasurements({ baseline, environment, bunVersion: baseline.bunVersion, measurements: attacked })).toThrow(code);
    }
    expect(() => assertPerformanceMeasurements({ baseline, environment, bunVersion: baseline.bunVersion, measurements: measurements.slice(1) })).toThrow("PERFORMANCE_MEASUREMENT_INVENTORY_INVALID");
    expect(() => assertPerformanceMeasurements({ baseline, environment, bunVersion: "9.9.9", measurements })).toThrow("PERFORMANCE_BASELINE_BUN_MISMATCH");
    expect(() => assertPerformanceMeasurements({ baseline, environment: "unknown-x64", bunVersion: baseline.bunVersion, measurements })).toThrow("PERFORMANCE_BASELINE_ENVIRONMENT_MISSING");
    for (const invalid of [Number.NaN, -1, 1.5]) {
      const attacked = [...measurements];
      attacked[0] = { ...attacked[0]!, peakRssBytes: invalid };
      expect(() => assertPerformanceMeasurements({ baseline, environment, bunVersion: baseline.bunVersion, measurements: attacked })).toThrow("PERFORMANCE_MEASUREMENT_INVALID");
    }
  });

  test("rejects unknown, omitted, and malformed baseline authority", async () => {
    const baseline = structuredClone(await loadPerformanceBaseline(baselinePath)) as Record<string, any>;
    for (const attacked of [
      { ...baseline, surprise: true },
      { ...baseline, fixtures: { ...baseline.fixtures, surprise: baseline.fixtures.small } },
      { ...baseline, fixtures: { ...baseline.fixtures, small: { ...baseline.fixtures.small, surprise: 1 } } },
      { ...baseline, environments: { ...baseline.environments, surprise: baseline.environments["darwin-arm64"] } },
      { ...baseline, environments: { ...baseline.environments, "darwin-arm64": { ...baseline.environments["darwin-arm64"], surprise: baseline.environments["darwin-arm64"].small } } },
      { ...baseline, environments: { ...baseline.environments, "darwin-arm64": { ...baseline.environments["darwin-arm64"], small: { ...baseline.environments["darwin-arm64"].small, surprise: 1 } } } },
    ]) {
      expect(() => parsePerformanceBaseline(attacked)).toThrow(/incomplete or unknown/u);
    }
    const missing = structuredClone(baseline);
    delete missing.environments["darwin-arm64"];
    expect(() => parsePerformanceBaseline(missing)).toThrow(/incomplete or unknown/u);
    const unroutable = structuredClone(baseline);
    unroutable.fixtures.small.traces = 3;
    expect(() => parsePerformanceBaseline(unroutable)).toThrow(/deterministic routed pairs/u);
  });

  test("derives fixture identity from generated Circuit JSON and binds child work to exact baseline bytes", async () => {
    const authority = await loadPerformanceBaselineAuthority(baselinePath);
    expect(authority.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const observed = observePerformanceFixture([
      { type: "source_component" },
      { type: "source_component" },
      { type: "pcb_smtpad" },
      { type: "pcb_smtpad" },
      { type: "pcb_trace" },
      { type: "pcb_board", num_layers: 4 },
    ]);
    expect(observed).toEqual({ components: 2, pads: 2, traces: 1, layers: 4 });
    expect(() => assertPerformanceFixtureIdentity(observed, { ...observed, traces: 0 }, "deliberate mismatch")).toThrow("PERFORMANCE_FIXTURE_IDENTITY_MISMATCH");
    expect(() => parsePerformanceFixtureIdentity({ ...observed, unknown: true })).toThrow(/incomplete or unknown/u);

    const child = Bun.spawn([
      process.execPath,
      "--no-orphans",
      join(import.meta.dir, "../scripts/performance-workload.ts"),
      "small",
      "cold-build",
      "0".repeat(64),
      join(import.meta.dir, "../.pcboo-ci/should-not-exist.json"),
    ], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("PERFORMANCE_BASELINE_CHANGED");
    expect(await Bun.file(join(import.meta.dir, "../.pcboo-ci/should-not-exist.json")).exists()).toBeFalse();
  });

  test("validates the exact uploadable report schema and rejects stale or partial evidence", async () => {
    const authority = await loadPerformanceBaselineAuthority(baselinePath);
    const environment = `${process.platform}-${process.arch}`;
    const measurements = PERFORMANCE_FIXTURE_NAMES.flatMap((fixture) =>
      PERFORMANCE_WORKLOAD_NAMES.map((workload) => ({
        fixture, workload, elapsedMilliseconds: 1, peakRssBytes: 1, swapCount: 0, exitCode: 0,
      }))
    );
    const report = {
      schemaVersion: 1,
      baselineVersion: authority.baseline.baselineVersion,
      baselineSha256: authority.sha256,
      bunVersion: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      environment,
      baselineFixtures: authority.baseline.fixtures,
      observedFixtures: authority.baseline.fixtures,
      budgets: authority.baseline.environments[environment],
      measurements,
      passed: true,
    };
    const runtime = { platform: process.platform, architecture: process.arch, bunVersion: Bun.version };
    expect(() => validatePerformanceReportValue(report, authority, runtime)).not.toThrow();
    for (const attacked of [
      { ...report, passed: false },
      { ...report, baselineSha256: "0".repeat(64) },
      { ...report, measurements: measurements.slice(1) },
      { ...report, observedFixtures: { ...report.observedFixtures, small: { ...report.observedFixtures.small, traces: 0 } } },
      { ...report, unknown: true },
    ]) expect(() => validatePerformanceReportValue(attacked, authority, runtime)).toThrow();
  });

  test("rejects the wrong KiCad incomplete condition and incomplete artifact membership", async () => {
    const baseline = await loadPerformanceBaseline(baselinePath);
    const prepared = await createPerformanceFixture("small", baseline.fixtures.small);
    try {
      const run = await runCli({
        argv: ["export", "kicad", "--json"],
        cwd: prepared.root,
        runId: "performance-kicad-validator-test",
        externalToolPaths: { kicadCli: null },
      });
      await expect(assertPerformanceDetachedExport(run, prepared.root, baseline.fixtures.small))
        .resolves.toBeUndefined();
      const result = run.result!;
      const wrongDiagnostic = {
        ...run,
        result: {
          ...result,
          diagnostics: [{ ...result.diagnostics[0]!, id: "KICAD_HANDOFF_UNQUALIFIED_001" }],
        },
      } as unknown as PerformanceCliRun;
      await expect(assertPerformanceDetachedExport(wrongDiagnostic, prepared.root, baseline.fixtures.small))
        .rejects.toThrow(/incomplete handoff boundary/u);
      const missingFile = {
        ...run,
        result: {
          ...result,
          artifacts: result.artifacts.filter(({ path }) => !path.endsWith(".kicad_pcb")),
        },
      } as unknown as PerformanceCliRun;
      await expect(assertPerformanceDetachedExport(missingFile, prepared.root, baseline.fixtures.small))
        .rejects.toThrow(/omitted or added handoff artifacts/u);
    } finally {
      await rm(prepared.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("signal cancellation removes stale validity and terminates the active workload", async () => {
    if (process.platform === "win32") return;
    const reportPath = join(import.meta.dir, `../.pcboo-ci/performance-${process.platform}-${process.arch}.json`);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, "stale-passed-report\n");
    const child = Bun.spawn([
      process.execPath,
      "--no-orphans",
      join(import.meta.dir, "../scripts/performance-qualification.ts"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    try {
      const readFirstProgress = async (): Promise<void> => {
        while (!stdout.includes('"state":"running"')) {
          const next = await reader.read();
          if (next.value !== undefined) stdout += decoder.decode(next.value, { stream: true });
          if (next.done) break;
        }
      };
      await Promise.race([
        readFirstProgress(),
        Bun.sleep(15_000).then(() => { throw new Error("performance progress timeout"); }),
      ]);
      expect(stdout).toContain('"state":"running"');
      child.kill("SIGTERM");
      expect(await child.exited).not.toBe(0);
      while (true) {
        const next = await reader.read();
        if (next.value !== undefined) stdout += decoder.decode(next.value, { stream: true });
        if (next.done) break;
      }
      expect(stdout).toContain('"state":"cancelled"');
      expect(await Bun.file(reportPath).exists()).toBeFalse();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
      await rm(reportPath, { force: true });
    }
  });
});
