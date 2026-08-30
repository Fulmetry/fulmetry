import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AnyCircuitElement } from "tscircuit";
import { runCli } from "../src/cli/runner";
import {
  PROJECT_TEST_INPUT_FILE_LIMIT,
  PROJECT_TEST_INPUT_TOTAL_LIMIT,
} from "../src/project-tests";
import { PROJECT_INPUT_FILE_BYTES_LIMIT } from "../src/project/input-limits";
import { startDevCommand } from "../src/cli/dev";
import { completeInspectDiagnosticSelection } from "../src/cli/inspect-selection";
import { defineDiagnostic, diagnosticId } from "../src/diagnostics";
import { KICAD_ARTIFACT_FILE_BYTES_LIMIT } from "../src/kicad/exact-flat-files";
import { MANUFACTURING_ADAPTER_VERSIONS } from "../src/manufacturing/export";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import { assessCircuitFabrication } from "../src/fabrication";
import {
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
} from "../src/project/lock";
import { manufacturingFixture } from "./fixtures/manufacturing";

const temporaryRoots: string[] = [];
// This file intentionally composes many cold, full-closure-authenticated CLI
// scenarios. Product child deadlines remain independently configured per call.
setDefaultTimeout(120_000);
type SourcePortElement = Extract<AnyCircuitElement, { type: "source_port" }>;
type PcbPortElement = Extract<AnyCircuitElement, { type: "pcb_port" }>;

function simulationCircuitFixture(): unknown[] {
  return [
    { type: "source_component", source_component_id: "R1", name: "R1", ftype: "simple_resistor", resistance: 10_000 },
    { type: "source_component", source_component_id: "R2", name: "R2", ftype: "simple_resistor", resistance: 10_000 },
    ...["R1.1", "R1.2", "R2.1", "R2.2"].map((id) => ({ type: "source_port", source_port_id: id, source_component_id: id.slice(0, 2), name: `pin${id.at(-1)}`, pin_number: Number(id.at(-1)) })),
    { type: "source_net", source_net_id: "net-vin", name: "VIN", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-vout", name: "VOUT", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-gnd", name: "GND", member_source_group_ids: [] },
    { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["R1.1"], connected_source_net_ids: ["net-vin"] },
    { type: "source_trace", source_trace_id: "t2", connected_source_port_ids: ["R1.2", "R2.1"], connected_source_net_ids: ["net-vout"] },
    { type: "source_trace", source_trace_id: "t3", connected_source_port_ids: ["R2.2"], connected_source_net_ids: ["net-gnd"] },
  ];
}

function minimalBoardCircuitFixture(): unknown[] {
  return [
    {
      type: "source_group",
      source_group_id: "source_group_0",
      subcircuit_id: "subcircuit_source_group_0",
      is_subcircuit: true,
      was_automatically_named: true,
    },
    {
      type: "source_board",
      source_board_id: "source_board_0",
      source_group_id: "source_group_0",
    },
    {
      type: "pcb_board",
      pcb_board_id: "pcb_board_0",
      source_board_id: "source_board_0",
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      thickness: 1.4,
      num_layers: 2,
      material: "fr4",
    },
  ];
}

async function createProject(
  circuitJson: unknown[],
  name = "cli project ü",
): Promise<{ root: string; nested: string }> {
  const parent = await mkdtemp(join(tmpdir(), "fulmetry-cli-"));
  temporaryRoots.push(parent);
  const root = join(parent, name);
  const nested = join(root, "circuit", "nested");
  await mkdir(nested, { recursive: true });
  await mkdir(join(root, "node_modules"));
  await symlink(join(import.meta.dir, "../node_modules/tscircuit"), join(root, "node_modules/tscircuit"), process.platform === "win32" ? "junction" : "dir");
  await Bun.write(
    join(root, "circuit", "board.ts"),
    `export default ${JSON.stringify(circuitJson.length === 0 ? minimalBoardCircuitFixture() : circuitJson)};\n`,
  );
  await Bun.write(
    join(root, "fulmetry.config.ts"),
    `export default ${JSON.stringify({
      entry: "circuit/board.ts",
      profiles: [BASELINE_FABRICATION_PROFILE.name],
    })};\n`,
  );
  await Bun.write(
    join(root, "fulmetry.lock"),
    `${JSON.stringify({
      schemaVersion: 1,
      tscircuit: {
        version: SUPPORTED_TSCIRCUIT_VERSION,
        integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
      },
      adapters: MANUFACTURING_ADAPTER_VERSIONS,
      profiles: {
        [BASELINE_FABRICATION_PROFILE.name]: {
          version: BASELINE_FABRICATION_PROFILE.version,
          digest: BASELINE_FABRICATION_PROFILE.digest,
        },
      },
      assets: {},
    }, null, 2)}\n`,
  );
  return { root, nested };
}

async function replaceProjectEngine(root: string): Promise<void> {
  const engine = join(root, "node_modules/tscircuit");
  await rm(engine, { recursive: true, force: true });
  await mkdir(engine);
  await Bun.write(join(engine, "package.json"), `${JSON.stringify({
    name: "tscircuit",
    version: SUPPORTED_TSCIRCUIT_VERSION,
    main: "index.js",
  })}\n`);
  await Bun.write(join(engine, "index.js"), "export const replaced = true;\n");
}

function reverseNonInterchangeableD1PinMap(
  circuitJson: Awaited<ReturnType<typeof manufacturingFixture>>,
): void {
  const source = circuitJson.find(
    (element) => element.type === "source_component" && element.name === "D1",
  );
  if (source?.type !== "source_component" || source.are_pins_interchangeable !== false) {
    throw new Error("Non-interchangeable D1 fixture missing");
  }
  const sourcePorts = circuitJson.filter(
    (element): element is SourcePortElement => element.type === "source_port" &&
      element.source_component_id === source.source_component_id,
  ).sort((left, right) => Number(left.pin_number) - Number(right.pin_number));
  if (sourcePorts.length !== 2) throw new Error("D1 pin fixture missing");
  const [pin1, pin2] = sourcePorts;
  const pin1Key = pin1!.subcircuit_connectivity_map_key;
  const pin2Key = pin2!.subcircuit_connectivity_map_key;

  for (const trace of circuitJson.filter((element) => element.type === "source_trace")) {
    trace.connected_source_port_ids = trace.connected_source_port_ids.map((sourcePortId) =>
      sourcePortId === pin1!.source_port_id
        ? pin2!.source_port_id
        : sourcePortId === pin2!.source_port_id
          ? pin1!.source_port_id
          : sourcePortId
    );
  }
  pin1!.subcircuit_connectivity_map_key = pin2Key;
  pin2!.subcircuit_connectivity_map_key = pin1Key;

  const component = circuitJson.find(
    (element) => element.type === "pcb_component" &&
      element.source_component_id === source.source_component_id,
  );
  if (component?.type !== "pcb_component") throw new Error("D1 PCB fixture missing");
  const pcbPorts = circuitJson.filter(
    (element): element is PcbPortElement => element.type === "pcb_port" &&
      element.pcb_component_id === component.pcb_component_id,
  );
  const pad1Port = pcbPorts.find((port) => port.source_port_id === pin1!.source_port_id);
  const pad2Port = pcbPorts.find((port) => port.source_port_id === pin2!.source_port_id);
  if (pad1Port === undefined || pad2Port === undefined) throw new Error("D1 pad map missing");
  pad1Port.source_port_id = pin2!.source_port_id;
  pad2Port.source_port_id = pin1!.source_port_id;
  pin1!.pin_number = 2;
  pin2!.pin_number = 1;
  pin1!.name = "pin2";
  pin2!.name = "pin1";
  pin1!.port_hints = (pin1!.port_hints ?? []).map((hint) => ({
    pin1: "pin2", "1": "2", anode: "cathode", pos: "neg", left: "right",
  })[hint] ?? hint);
  pin2!.port_hints = (pin2!.port_hints ?? []).map((hint) => ({
    pin2: "pin1", "2": "1", cathode: "anode", neg: "pos", right: "left",
  })[hint] ?? hint);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Fulmetry CLI", () => {
  test("shows bounded help without requiring a project", async () => {
    const run = await runCli({ argv: ["help"], cwd: tmpdir() });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("fulmetry verify manufacturing");
    expect(run.stdout).toContain("fulmetry export gerbers");
    expect(run.stdout.length).toBeLessThan(2_000);
    expect(run.result).toBeUndefined();
  });

  test("runs through the Bun executable boundary", async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/cli/bin.ts"), "help"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Bun-first circuit projects");
  });

  test("fails closed before a command reads an oversized authoritative project input", async () => {
    const project = await createProject([], "oversized ordinary command input");
    const oversized = join(project.root, "oversized.bin");
    await Bun.write(oversized, "");
    await truncate(oversized, PROJECT_INPUT_FILE_BYTES_LIMIT + 1);

    const run = await runCli({
      argv: ["check"],
      cwd: project.root,
      runId: "oversized-project-input",
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.artifacts).toEqual([]);
    expect(run.stderr).toContain(`${PROJECT_INPUT_FILE_BYTES_LIMIT}-byte per-file limit`);
  }, 120_000);

  test("starts the fixed loopback inspection server through the dev command", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const sourcePath = join(project.root, "circuit/board.ts");
    const before = await readFile(sourcePath);
    const started = await startDevCommand({ argv: ["--port", "0", "--json"], cwd: project.root });
    try {
      const startup = JSON.parse(started.stdout);
      expect(startup).toMatchObject({
        schemaVersion: "1",
        command: "fulmetry dev",
        protocol: "http",
        hostname: "127.0.0.1",
        warnings: [],
      });
      expect((await fetch(new URL("/api/project", started.server.url))).status).toBe(200);
      expect(Buffer.compare(before, await readFile(sourcePath))).toBe(0);
    } finally {
      await started.server.stop();
    }
  }, 120_000);

  test("dev requires explicit valid network arguments and surfaces exposure warnings", async () => {
    const project = await createProject(await manufacturingFixture(2));
    await expect(startDevCommand({ argv: ["--host"], cwd: project.root })).rejects.toThrow(
      "--host requires",
    );
    await expect(startDevCommand({ argv: ["--port", "70000"], cwd: project.root })).rejects.toThrow(
      "--port requires",
    );
    const started = await startDevCommand({ argv: ["--host", "0.0.0.0"], cwd: project.root });
    try {
      expect(started.stdout).toContain("SERVER_NETWORK_EXPOSURE");
      expect(started.server.warnings).toHaveLength(1);
    } finally {
      await started.server.stop();
    }
  }, 120_000);

  test("the executable returns structured diagnostics for invalid dev JSON arguments", async () => {
    for (const args of [["--port", "70000", "--json"], ["--host", "--json"]]) {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../src/cli/bin.ts"), "dev", ...args],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("CLI_ARGUMENT_INVALID_001");
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({
        schemaVersion: "1",
        command: "fulmetry dev",
        exitClassification: "failure",
        diagnostics: [{ id: "CLI_ARGUMENT_INVALID_001", nextCommand: "fulmetry help" }],
      });
    }
  });

  test("reports unsupported commands honestly and does not create project output", async () => {
    const run = await runCli({ argv: ["export", "altium"] });

    expect(run.exitCode).toBe(4);
    expect(run.result?.exitClassification).toBe("unsupported");
    expect(run.stdout).toContain("UNSUPPORTED");
    expect(run.result?.statuses.functional.state).toBe("not-run");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toEqual([
      "CLI_COMMAND_UNSUPPORTED_001",
    ]);

    const json = await runCli({ argv: ["export", "altium", "--json"] });
    expect(JSON.parse(json.stdout).diagnostics).toEqual([
      expect.objectContaining({
        id: "CLI_COMMAND_UNSUPPORTED_001",
        nextCommand: "fulmetry help",
      }),
    ]);
  });

  test("returns actionable invalid-argument evidence in structured JSON", async () => {
    const run = await runCli({ argv: ["build", "extra", "--json"] });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("CLI_ARGUMENT_INVALID_001");
    const result = JSON.parse(run.stdout);
    expect(result.exitClassification).toBe("failure");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        id: "CLI_ARGUMENT_INVALID_001",
        message: "build accepts no positional arguments",
        nextCommand: "fulmetry help",
      }),
    ]);
  });

  test("returns versioned JSON instead of silently ignoring --json for help", async () => {
    for (const argv of [["help", "--json"], ["--json"]]) {
      const run = await runCli({ argv });
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toMatchObject({
        schemaVersion: "1",
        command: "fulmetry help",
        runId: "help",
        exitClassification: "success",
        requestedDimensions: [],
      });
    }
  });

  test("runs standard Bun project tests and publishes reconciled functional evidence", async () => {
    const project = await createProject([]);
    await mkdir(join(project.root, "tests"));
    await Bun.write(
      join(project.root, "tests", "functional.test.ts"),
      `import { expect, test } from "bun:test";\ntest("functional evidence", () => expect(2 + 2).toBe(4));\n`,
    );
    const sourceBefore = await readFile(join(project.root, "tests", "functional.test.ts"));
    const run = await runCli({ argv: ["test", "--json"], cwd: project.root, runId: "test-pass" });

    expect(run.exitCode).toBe(0);
    expect(run.result?.command).toBe("fulmetry test");
    expect(run.result?.requestedDimensions).toEqual(["functional"]);
    expect(run.result?.statuses.functional.state).toBe("passed");
    expect(run.result?.statuses.fabrication.state).toBe("not-run");
    expect(run.result?.diagnostics).toEqual([]);
    expect(run.result?.artifacts.map(({ kind }) => kind).sort()).toEqual([
      "project-test-junit",
      "project-test-stderr",
      "project-test-stdout",
      "project-test-summary",
    ]);
    expect(run.result?.artifacts.every(({ digest }) => /^[a-f0-9]{64}$/u.test(digest ?? ""))).toBeTrue();
    const summaryReference = run.result?.artifacts.find(({ kind }) => kind === "project-test-summary");
    const summary = JSON.parse(await Bun.file(join(project.root, summaryReference!.path)).text());
    expect(summary).toMatchObject({
      schemaVersion: 1,
      runner: { name: "bun", version: Bun.version },
      outcome: "passed",
      reason: "passed",
      testFiles: ["tests/functional.test.ts"],
      counts: { total: 1, executed: 1, passed: 1, failed: 0, skipped: 0 },
      execution: { exitCode: 0, timedOut: false, cancelled: false },
    });
    expect(summary.counts.assertions).toBeGreaterThan(0);
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
    expect(Buffer.compare(sourceBefore, await readFile(join(project.root, "tests", "functional.test.ts")))).toBe(0);
  }, 120_000);

  test("rejects replacement of the captured JUnit bytes after result assessment", async () => {
    const project = await createProject([]);
    await mkdir(join(project.root, "tests"));
    await Bun.write(
      join(project.root, "tests", "functional.test.ts"),
      `import { test } from "bun:test";\ntest("passes before publication attack", () => {});\n`,
    );
    const run = await runCli({
      argv: ["test"], cwd: project.root, runId: "test-junit-race",
      testHooks: {
        afterReportPublication: async ({ runDirectory }) => {
          await Bun.write(join(runDirectory, "project-tests", "captured-junit.xml"), "forged\n");
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toContain("Run evidence no longer matches");
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
  }, 120_000);

  test("never passes absent project tests", async () => {
    const noTests = await createProject([], "no project tests");
    const absent = await runCli({ argv: ["test"], cwd: noTests.root, runId: "test-absent" });
    expect(absent.exitCode).toBe(3);
    expect(absent.result?.statuses.functional.state).toBe("incomplete");
    expect(absent.result?.diagnostics.map(({ id }) => String(id))).toEqual(["TEST_NO_TEST_FILES_001"]);
  }, 120_000);

  test("never passes statically focused project tests", async () => {
    const focused = await createProject([], "focused project tests");
    await mkdir(join(focused.root, "tests"));
    await Bun.write(
      join(focused.root, "tests", "focus-helper.ts"),
      `import { expect, test as check } from "bun:test";\nconst key = "on" + "ly";\n(Reflect.get(check, key) as typeof check)("helper focus", () => expect(true).toBeTrue());\n`,
    );
    await Bun.write(
      join(focused.root, "tests", "focused.test.ts"),
      `import * as bunTest from "bun:test";\nimport "./focus-helper";\nbunTest.test.only("focused", () => bunTest.expect(true).toBeTrue());\nbunTest.describe["only"]("also focused", () => { bunTest.test("omitted", () => bunTest.expect(false).toBeTrue()); });\n`,
    );
    const focusedRun = await runCli({ argv: ["test"], cwd: focused.root, runId: "test-focused" });
    expect(focusedRun.exitCode).toBe(3);
    expect(focusedRun.result?.statuses.functional.state).toBe("incomplete");
    expect(focusedRun.result?.diagnostics.map(({ id }) => String(id))).toEqual([
      "TEST_FOCUSED_DECLARATION_001",
    ]);
    const focusedSummary = focusedRun.result?.artifacts.find(({ kind }) => kind === "project-test-summary");
    expect(JSON.parse(await Bun.file(join(focused.root, focusedSummary!.path)).text()).focusedDeclarations).toHaveLength(3);
  }, 120_000);

  test("never passes runtime-focused project tests", async () => {
    const runtimeFocused = await createProject([], "runtime focused project tests");
    await mkdir(join(runtimeFocused.root, "tests"));
    await Bun.write(
      join(runtimeFocused.root, "tests", "runtime-focus.test.ts"),
      `import { expect, test } from "bun:test";\nconst key = () => "only";\n(test as any)[key()]("runtime focus", () => expect(true).toBeTrue());\ntest("required failure", () => expect(false).toBeTrue());\n`,
    );
    const runtimeFocusedRun = await runCli({ argv: ["test"], cwd: runtimeFocused.root, runId: "test-runtime-focused" });
    expect(runtimeFocusedRun.exitCode).toBe(3);
    expect(runtimeFocusedRun.result?.statuses.functional.state).toBe("incomplete");
    expect(runtimeFocusedRun.result?.diagnostics.map(({ id }) => String(id))).toEqual([
      "TEST_FOCUSED_DECLARATION_001",
    ]);
    const runtimeSummary = runtimeFocusedRun.result?.artifacts.find(({ kind }) => kind === "project-test-summary");
    expect(JSON.parse(await Bun.file(join(runtimeFocused.root, runtimeSummary!.path)).text()).execution).toMatchObject({
      focusSentinelsExpected: 0,
      focusSentinelsObserved: 0,
    });
  }, 120_000);

  test("never passes skipped project tests", async () => {
    const project = await createProject([], "skip project tests");
    await mkdir(join(project.root, "tests"));
    await Bun.write(
      join(project.root, "tests", "skip.test.ts"),
      `import { test } from "bun:test";\ntest.skip("required behavior", () => {});\n`,
    );
    const run = await runCli({ argv: ["test"], cwd: project.root, runId: "test-skip" });
    expect(run.exitCode).not.toBe(0);
    expect(run.result?.statuses.functional.state).toBe("incomplete");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toEqual(["TEST_SKIPPED_001"]);
  }, 120_000);

  test("never passes failed project tests", async () => {
    const project = await createProject([], "fail project tests");
    await mkdir(join(project.root, "tests"));
    await Bun.write(
      join(project.root, "tests", "fail.test.ts"),
      `import { expect, test } from "bun:test";\ntest("required behavior", () => expect(1).toBe(2));\n`,
    );
    const run = await runCli({ argv: ["test"], cwd: project.root, runId: "test-fail" });
    expect(run.exitCode).not.toBe(0);
    expect(run.result?.statuses.functional.state).toBe("failed");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toEqual(["TEST_FAILED_001"]);
  }, 120_000);

  test.skipIf(process.platform === "win32")("bounds project test output, timeout, and cancellation", async () => {
    const noisy = await createProject([], "noisy project tests");
    await mkdir(join(noisy.root, "tests"));
    await Bun.write(
      join(noisy.root, "tests", "noisy.test.ts"),
      `import { test } from "bun:test";\ntest("bounded output", () => console.log("x".repeat(8192)));\n`,
    );
    const outputRun = await runCli({
      argv: ["test"], cwd: noisy.root, runId: "test-output-limit",
      projectTestOptions: { outputLimit: 1024 },
    });
    expect(outputRun.exitCode).toBe(1);
    expect(outputRun.result?.statuses.functional.state).toBe("failed");
    expect(outputRun.result?.diagnostics.map(({ id }) => String(id))).toEqual(["TEST_OUTPUT_LIMIT_001"]);
    const stdout = outputRun.result?.artifacts.find(({ kind }) => kind === "project-test-stdout");
    expect((await Bun.file(join(noisy.root, stdout!.path)).arrayBuffer()).byteLength).toBeLessThanOrEqual(1024);

    const hanging = await createProject([], "hanging project tests");
    await mkdir(join(hanging.root, "tests"));
    await Bun.write(
      join(hanging.root, "tests", "hang.test.ts"),
      `import { test } from "bun:test";\ntest("bounded execution", async () => { await new Promise(() => {}); });\n`,
    );
    const timeoutRun = await runCli({
      argv: ["test"], cwd: hanging.root, runId: "test-timeout",
      projectTestOptions: { timeoutMs: 100 },
    });
    expect(timeoutRun.exitCode).toBe(1);
    expect(timeoutRun.result?.statuses.functional.state).toBe("failed");
    expect(timeoutRun.result?.diagnostics.map(({ id }) => String(id))).toEqual(["TEST_TIMEOUT_001"]);
    const cancelled = await createProject([], "cancelled project tests");
    await mkdir(join(cancelled.root, "tests"));
    await Bun.write(
      join(cancelled.root, "tests", "cancel.test.ts"),
      `import { test } from "bun:test";\ntest("cancellable execution", async () => await new Promise(() => {}));\n`,
    );
    const controller = new AbortController();
    const pending = runCli({
      argv: ["test"], cwd: cancelled.root, runId: "test-cancelled",
      signal: controller.signal,
      projectTestOptions: { timeoutMs: 5_000 },
    });
    setTimeout(() => controller.abort(), 100);
    const cancelledRun = await pending;
    expect(cancelledRun.exitCode).toBe(130);
    expect(cancelledRun.result?.exitClassification).toBe("cancelled");
    expect(cancelledRun.result?.statuses.functional.state).toBe("incomplete");
    expect(cancelledRun.result?.diagnostics.map(({ id }) => String(id))).toEqual(["TEST_CANCELLED_001"]);
  }, 120_000);

  test("refuses to publish a passing test result after test-source mutation or an escaping local import", async () => {
    const mutated = await createProject([], "mutated project tests");
    await mkdir(join(mutated.root, "tests"));
    const mutableTest = join(mutated.root, "tests", "mutable.test.ts");
    await Bun.write(
      mutableTest,
      `import { test } from "bun:test";\ntest("mutates its own authority", async () => { await Bun.write(import.meta.path, "// replaced\\n"); });\n`,
    );
    const mutationRun = await runCli({ argv: ["test"], cwd: mutated.root, runId: "test-source-mutation" });
    expect(mutationRun.exitCode).toBe(1);
    expect(mutationRun.result?.exitClassification).toBe("failure");
    expect(mutationRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(mutationRun.stderr).toContain("Project code or test inputs changed");

    const packageMutation = await createProject([], "package mutation project tests");
    await mkdir(join(packageMutation.root, "tests"));
    await Bun.write(join(packageMutation.root, "package.json"), `{"name":"before","private":true}\n`);
    await Bun.write(
      join(packageMutation.root, "tests", "package-mutation.test.ts"),
      `import { test } from "bun:test";\ntest("must not mutate unimported project metadata", async () => { await Bun.write("package.json", '{"name":"after","private":true}\\n'); });\n`,
    );
    const packageMutationRun = await runCli({ argv: ["test"], cwd: packageMutation.root, runId: "test-package-mutation" });
    expect(packageMutationRun.exitCode).toBe(1);
    expect(packageMutationRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(packageMutationRun.stderr).toContain("Project code or test inputs changed");

    const fixtureMutation = await createProject([], "text fixture mutation project tests");
    await mkdir(join(fixtureMutation.root, "tests"));
    await Bun.write(join(fixtureMutation.root, "tests", "expected-output.txt"), "before\n");
    await Bun.write(
      join(fixtureMutation.root, "tests", "fixture-mutation.test.ts"),
      `import { test } from "bun:test";\ntest("must bind arbitrary test fixtures", async () => { await Bun.write("tests/expected-output.txt", "after\\n"); });\n`,
    );
    const fixtureMutationRun = await runCli({
      argv: ["test"], cwd: fixtureMutation.root, runId: "test-fixture-mutation",
    });
    expect(fixtureMutationRun.exitCode).toBe(1);
    expect(fixtureMutationRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(fixtureMutationRun.stderr).toContain("Project code or test inputs changed");

    const escaped = await createProject([], "escaping project tests");
    await mkdir(join(escaped.root, "tests"));
    const outsideModule = join(escaped.root, "..", "outside-test-helper.ts");
    await Bun.write(outsideModule, `export const value = 1;\n`);
    await Bun.write(
      join(escaped.root, "tests", "escape.test.ts"),
      `import { test, expect } from "bun:test";\nimport { value } from "../../outside-test-helper";\ntest("escape", () => expect(value).toBe(1));\n`,
    );
    const escapeRun = await runCli({ argv: ["test"], cwd: escaped.root, runId: "test-import-escape" });
    expect(escapeRun.exitCode).toBe(1);
    expect(escapeRun.result?.exitClassification).toBe("failure");
    expect(escapeRun.stderr).toContain("resolves outside the project root");
  }, 120_000);

  test("bounds individual and aggregate project-test code inputs before execution", async () => {
    const oversized = await createProject([], "oversized project test input");
    await mkdir(join(oversized.root, "tests"));
    await Bun.write(
      join(oversized.root, "tests", "bounded.test.ts"),
      `import { test } from "bun:test";\ntest("must never execute", () => {});\n`,
    );
    const oversizedPath = join(oversized.root, "oversized.json");
    await Bun.write(oversizedPath, "");
    await truncate(oversizedPath, PROJECT_TEST_INPUT_FILE_LIMIT + 1);
    const oversizedRun = await runCli({
      argv: ["test"], cwd: oversized.root, runId: "test-input-file-limit",
    });
    expect(oversizedRun.exitCode).toBe(1);
    expect(oversizedRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(oversizedRun.stderr).toContain("per-file limit");

    const aggregate = await createProject([], "aggregate project test input");
    await mkdir(join(aggregate.root, "tests"));
    await Bun.write(
      join(aggregate.root, "tests", "bounded.test.ts"),
      `import { test } from "bun:test";\ntest("must never execute", () => {});\n`,
    );
    const chunkSize = Math.floor(PROJECT_TEST_INPUT_TOTAL_LIMIT / 9) + 1;
    for (let index = 0; index < 9; index += 1) {
      const aggregatePath = join(aggregate.root, `aggregate-${index}.json`);
      await Bun.write(aggregatePath, "");
      await truncate(aggregatePath, chunkSize);
    }
    const aggregateRun = await runCli({
      argv: ["test"], cwd: aggregate.root, runId: "test-input-total-limit",
    });
    expect(aggregateRun.exitCode).toBe(1);
    expect(aggregateRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(aggregateRun.stderr).toContain("aggregate limit");
  }, 120_000);

  test("does not count expected-failure Bun modifiers as functional passage", async () => {
    for (const modifier of ["failing", "failingIf"] as const) {
      const project = await createProject([], `expected failure ${modifier}`);
      await mkdir(join(project.root, "tests"));
      await Bun.write(
        join(project.root, "tests", `${modifier}.test.ts`),
        modifier === "failing"
          ? `import { expect, test } from "bun:test";\ntest.failing("known broken behavior", () => expect(1).toBe(2));\n`
          : `import { expect, test } from "bun:test";\ntest.failingIf(true)("known broken behavior", () => expect(1).toBe(2));\n`,
      );
      const run = await runCli({
        argv: ["test", "--json"], cwd: project.root, runId: `expected-failure-${modifier}`,
      });
      expect(run.exitCode, modifier).toBe(3);
      expect(run.result?.statuses.functional.state, modifier).toBe("incomplete");
      expect(run.result?.diagnostics.map(({ id }) => String(id)), modifier).toEqual([
        "TEST_EXPECTED_FAILURE_DECLARATION_001",
      ]);
    }
  }, 120_000);

  test("binds imported dependency bytes used by project tests", async () => {
    const project = await createProject([], "project test dependency mutation");
    const dependency = join(project.root, "node_modules/local-helper");
    await mkdir(dependency);
    await Bun.write(
      join(dependency, "package.json"),
      `{"name":"local-helper","type":"module","exports":"./index.js"}\n`,
    );
    await Bun.write(join(dependency, "index.js"), "export const value = 42;\n");
    await mkdir(join(project.root, "tests"));
    await Bun.write(
      join(project.root, "tests", "dependency.test.ts"),
      `import { expect, test } from "bun:test";\nimport { value } from "local-helper";\ntest("dependency is evidence", async () => { expect(value).toBe(42); await Bun.write("node_modules/local-helper/index.js", "export const value = 0;\\n"); });\n`,
    );
    const run = await runCli({
      argv: ["test", "--json"], cwd: project.root, runId: "test-dependency-mutation",
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toContain("Project code or test inputs changed");
  }, 120_000);

  test("rejects runtime module-loader escape hatches in authoritative project tests", async () => {
    for (const loader of ["import-meta-require", "create-require"] as const) {
      const project = await createProject([], `runtime loader ${loader}`);
      const outside = join(project.root, "..", `${loader}-outside.cjs`);
      await Bun.write(outside, "module.exports = { value: 42 };\n");
      await mkdir(join(project.root, "tests"));
      await Bun.write(
        join(project.root, "tests", `${loader}.test.ts`),
        loader === "import-meta-require"
          ? `import { expect, test } from "bun:test";\nconst { value } = import.meta.require(${JSON.stringify(outside)});\ntest("outside loader", () => expect(value).toBe(42));\n`
          : `import { createRequire } from "node:module";\nimport { expect, test } from "bun:test";\nconst load = createRequire(import.meta.url);\nconst { value } = load(${JSON.stringify(outside)});\ntest("outside loader", () => expect(value).toBe(42));\n`,
      );
      const run = await runCli({
        argv: ["test", "--json"], cwd: project.root, runId: `runtime-loader-${loader}`,
      });
      expect(run.exitCode, loader).toBe(1);
      expect(run.result?.artifacts.map(({ kind }) => kind), loader).toEqual(["command-error"]);
      expect(run.stderr, loader).toContain("forbids runtime module loaders");
    }
  }, 120_000);

  test("fails when the mandatory focus probe cannot initialize the test module", async () => {
    const project = await createProject([], "focus probe initialization failure");
    await mkdir(join(project.root, "tests"));
    const marker = join(project.root, "..", "focus-probe-initialized.txt");
    await Bun.write(
      join(project.root, "tests", "initialization.test.ts"),
      `import { existsSync, writeFileSync } from "node:fs";\nimport { test } from "bun:test";\nconst marker = ${JSON.stringify(marker)};\nif (existsSync(marker)) throw new Error("second initialization failed");\nwriteFileSync(marker, "initialized\\n");\ntest("first initialization", () => {});\n`,
    );
    const run = await runCli({
      argv: ["test", "--json"], cwd: project.root, runId: "focus-probe-init-failure",
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.statuses.functional.state).toBe("failed");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toEqual([
      "TEST_RUNNER_EXIT_001",
    ]);
  }, 120_000);

  test("detects same-inode test input rewrite and restoration", async () => {
    const project = await createProject([], "transient project test mutation");
    await mkdir(join(project.root, "tests"));
    await Bun.write(
      join(project.root, "tests", "transient.test.ts"),
      `import { readFileSync } from "node:fs";\nimport { test } from "bun:test";\nconst original = readFileSync(import.meta.path);\ntest("transient mutation", async () => { await Bun.write(import.meta.path, "// transient\\n"); await Bun.sleep(10); await Bun.write(import.meta.path, original); });\n`,
    );
    const run = await runCli({
      argv: ["test", "--json"], cwd: project.root, runId: "transient-input-mutation",
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toContain("Project code or test inputs changed");
  }, 120_000);

  test("exports a detached, explicitly unqualified KiCad handoff without overwriting an earlier handoff", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const first = await runCli({
      argv: ["export", "kicad", "--json"],
      cwd: project.root,
      runId: "kicad-001",
      externalToolPaths: { kicadCli: null },
    });
    expect(first.exitCode).toBe(3);
    expect(first.result?.command).toBe("fulmetry export kicad");
    expect(first.result?.exitClassification).toBe("incomplete");
    expect(first.result?.statuses.fabrication.state).toBe("not-run");
    const handoffReport = first.result?.artifacts.find(({ kind }) => kind === "kicad-handoff-report");
    expect(handoffReport).toBeDefined();
    expect(handoffReport?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.result?.artifacts.filter(({ kind }) => kind === "kicad-handoff")
      .every(({ digest }) => /^sha256:[a-f0-9]{64}$/.test(digest ?? ""))).toBeTrue();
    const report = JSON.parse(await Bun.file(join(project.root, handoffReport!.path)).text());
    expect(report).toMatchObject({
      lifecycle: "detached-downstream-handoff",
      offlineParse: { schematic: "passed", pcb: "passed", projectJson: "passed" },
      liveKiCadValidation: { state: "unavailable", supportedMajors: [10] },
    });
    const pcb = first.result?.artifacts.find(({ path }) => path.endsWith(".kicad_pcb"));
    expect(pcb).toBeDefined();
    await Bun.write(join(project.root, pcb!.path), "human downstream edit\n");
    const second = await runCli({
      argv: ["export", "kicad"],
      cwd: project.root,
      runId: "kicad-002",
      externalToolPaths: { kicadCli: null },
    });
    expect(second.exitCode).toBe(3);
    expect(await Bun.file(join(project.root, pcb!.path)).text()).toBe("human downstream edit\n");
    expect(second.result?.artifacts.every(({ path }) => path.includes("kicad-002"))).toBeTrue();
  }, 120_000);

  test("exports only a hash-bound draft Gerber set in a fresh offline run", async () => {
    const project = await createProject(await manufacturingFixture(4));
    await Bun.write(
      join(project.root, "fulmetry.config.ts"),
      `export default ${JSON.stringify({
        entry: "circuit/board.ts",
        profiles: [BASELINE_FABRICATION_PROFILE.name],
        boardRevision: "A",
      })};\n`,
    );
    await mkdir(join(project.root, "vendor"));
    await mkdir(join(project.root, "waivers"));
    await mkdir(join(project.root, "tests"));
    await Bun.write(
      join(project.root, "waivers", "fabrication.json"),
      '{"schemaVersion":1,"waivers":[]}\n',
    );
    await Bun.write(
      join(project.root, "tests", "draft-authority.test.ts"),
      'import { test } from "bun:test"; test("draft authority", () => {});\n',
    );
    const authoredCircuit = await Bun.file(join(project.root, "circuit/board.ts")).text();
    await Bun.write(join(project.root, "vendor/third-party-footprint.ts"), authoredCircuit);
    await Bun.write(
      join(project.root, "circuit/board.ts"),
      'import circuit from "../vendor/third-party-footprint";\nexport default circuit;\n',
    );
    const run = await runCli({
      argv: ["export", "gerbers", "--offline", "--json"],
      cwd: project.root,
      runId: "gerber-draft-001",
    });

    expect(run.exitCode).toBe(3);
    expect(run.result?.command).toBe("fulmetry export gerbers");
    expect(run.result?.exitClassification).toBe("incomplete");
    expect(run.result?.requestedDimensions).toEqual(["fabrication"]);
    expect(run.result?.statuses).toMatchObject({
      fabrication: { state: "incomplete" },
      electrical: { state: "not-run" },
      functional: { state: "not-run" },
      standards: { state: "not-run" },
      sourcing: { state: "unchecked" },
    });
    expect(run.result?.project?.networkPolicy).toBe("offline");
    expect(run.result?.diagnostics).toContainEqual(expect.objectContaining({
      id: "FAB_DRAFT_EXPORT_UNVERIFIED_001",
      severity: "warning",
      waiverPolicy: "forbidden",
      nextCommand: "fulmetry verify manufacturing",
    }));
    expect(run.result?.artifacts.some(({ path }) => path.endsWith("board-In1_Cu.gbr")))
      .toBeTrue();
    expect(run.result?.artifacts.some(({ path }) => path.endsWith("board-In2_Cu.gbr")))
      .toBeTrue();
    expect(run.result?.artifacts.some(({ kind }) => kind === "draft-input-snapshot"))
      .toBeTrue();
    expect(run.result?.artifacts.some(({ kind }) => kind === "draft-artifact-manifest"))
      .toBeTrue();
    expect(run.result?.artifacts.some(({ kind, path }) =>
      /verified|production|archive|\.zip$/iu.test(`${kind}:${path}`)
    )).toBeFalse();
    expect(run.result?.artifacts.every(({ digest }) => /^[a-f0-9]{64}$/u.test(digest ?? "")))
      .toBeTrue();
    for (const artifact of run.result?.artifacts ?? []) {
      const bytes = await Bun.file(join(project.root, artifact.path)).bytes();
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(artifact.digest!);
    }

    const inputSnapshotReference = run.result?.artifacts.find(
      ({ kind }) => kind === "draft-input-snapshot",
    );
    const inputSnapshot = JSON.parse(
      await Bun.file(join(project.root, inputSnapshotReference!.path)).text(),
    ) as { inputs: Array<{ path: string; role: string; sha256: string; size: number }> };
    expect(inputSnapshot.inputs).toContainEqual({
      path: "vendor/third-party-footprint.ts",
      role: "vendored",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      size: expect.any(Number),
    });
    expect(inputSnapshot.inputs).toContainEqual({
      path: "waivers/fabrication.json",
      role: "waiver",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      size: expect.any(Number),
    });
    expect(inputSnapshot.inputs).toContainEqual({
      path: "tests/draft-authority.test.ts",
      role: "test",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      size: expect.any(Number),
    });

    const manifestReference = run.result?.artifacts.find(
      ({ kind }) => kind === "draft-artifact-manifest",
    );
    expect(manifestReference).toBeDefined();
    const manifest = JSON.parse(
      await Bun.file(join(project.root, manifestReference!.path)).text(),
    ) as {
      lifecycle: string;
      boardRevision?: string;
      provenance: {
        inputDigests: Record<string, string>;
        tools: Record<string, Record<string, string>>;
        adapters: Record<string, Record<string, string>>;
        validation: Record<string, string>;
        knownLimitations: string[];
        verificationResults: Record<string, string>;
      };
      artifacts: Array<{ kind: string; path: string; sha256: string; size: number }>;
    };
    expect(manifest.lifecycle).toBe("draft");
    expect(manifest.boardRevision).toBe("A");
    expect(manifest.provenance.inputDigests).toMatchObject({
      project: run.result!.project!.projectDigest,
      source: run.result!.project!.sourceDigest,
      config: run.result!.project!.configDigest,
      lockfile: run.result!.project!.lockDigest,
    });
    expect(manifest.provenance.tools.tscircuit).toMatchObject({
      package: "tscircuit",
      version: SUPPORTED_TSCIRCUIT_VERSION,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(manifest.provenance.adapters.gerber).toMatchObject({
      package: "circuit-json-to-gerber",
      version: "0.0.90",
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(manifest.provenance.validation).toMatchObject({
      fabrication: "incomplete",
      electrical: "not-run",
      functional: "not-run",
      standards: "not-run",
      sourcing: "unchecked",
      boardRevision: "declared:A",
    });
    expect(manifest.provenance.knownLimitations).toContain(
      "Manufacturing verification has not run",
    );
    expect(manifest.provenance.knownLimitations).not.toContain(
      "No board revision was declared for this draft",
    );
    expect(manifest.provenance.verificationResults.manufacturing).toBe("not-run");
    expect(manifest.artifacts.every(({ kind }) => kind.length > 0)).toBeTrue();
    const runPathMarker = `.fulmetry/runs/${run.result!.runId}/`;
    const expectedManifestPaths = (run.result?.artifacts ?? [])
      .filter(({ kind }) => kind !== "draft-artifact-manifest")
      .map(({ path }) => {
        const offset = path.indexOf(runPathMarker);
        if (offset < 0) throw new Error(`Artifact path is outside the command run: ${path}`);
        return path.slice(offset + runPathMarker.length);
      })
      .sort();
    expect(manifest.artifacts.map(({ path }) => path).sort()).toEqual(expectedManifestPaths);
    for (const artifact of manifest.artifacts) {
      const bytes = await Bun.file(join(run.runDirectory!, artifact.path)).bytes();
      expect(bytes.byteLength).toBe(artifact.size);
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);

    const manifestBefore = await Bun.file(join(project.root, manifestReference!.path)).bytes();
    const repeated = await runCli({
      argv: ["export", "gerbers", "--json"],
      cwd: project.root,
      runId: "gerber-draft-001",
    });
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain("EEXIST");
    expect(Buffer.compare(
      Buffer.from(manifestBefore),
      Buffer.from(await Bun.file(join(project.root, manifestReference!.path)).bytes()),
    )).toBe(0);

    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "../src/cli/bin.ts"),
      "export",
      "gerbers",
      "--offline",
      "--json",
      "--run-id",
      "gerber-process-boundary",
    ], { cwd: project.root, stdout: "pipe", stderr: "pipe" });
    const [processStdout, processStderr, processExit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(processExit).toBe(3);
    expect(processStderr).toBe("");
    expect(JSON.parse(processStdout)).toMatchObject({
      schemaVersion: "1",
      command: "fulmetry export gerbers",
      runId: "gerber-process-boundary",
      exitClassification: "incomplete",
      project: { networkPolicy: "offline" },
    });
  }, 120_000);

  test("rejects ambient-runtime circuit inputs and binds every regular project file", async () => {
    const runtimeProject = await createProject(
      await manufacturingFixture(2),
      "ambient runtime input",
    );
    await Bun.write(
      join(runtimeProject.root, "board-data.json"),
      `${JSON.stringify(await manufacturingFixture(2))}\n`,
    );
    await Bun.write(
      join(runtimeProject.root, "circuit", "board.ts"),
      `const runtime = globalThis["Bun"]; export default await runtime.file(new URL("../board-data.json", import.meta.url)).json();\n`,
    );
    for (const [argv, runId] of [
      [["verify", "manufacturing", "--json"], "runtime-input-verify"],
      [["export", "gerbers", "--json"], "runtime-input-export"],
    ] as const) {
      const run = await runCli({ argv, cwd: runtimeProject.root, runId });
      expect(run.exitCode).toBe(1);
      expect(run.result?.exitClassification).toBe("failure");
      expect(run.stderr).toContain("runtime I/O global globalThis");
    }

    const boundProject = await createProject(
      await manufacturingFixture(2),
      "all regular files bound",
    );
    const auxiliaryPath = join(boundProject.root, "board-data.json");
    await Bun.write(auxiliaryPath, "{\"revision\":1}\n");
    const run = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: boundProject.root,
      runId: "auxiliary-input-race",
      testHooks: {
        beforeFinalReportPublication: async () => {
          await Bun.write(auxiliaryPath, "{\"revision\":2}\n");
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.stderr).toContain("Project inputs changed during command finalization");
  }, 120_000);

  test("fails closed when draft Gerber bytes or project inputs change before publication", async () => {
    const artifactProject = await createProject(await manufacturingFixture(2), "gerber artifact race");
    const artifactRun = await runCli({
      argv: ["export", "gerbers", "--json"],
      cwd: artifactProject.root,
      runId: "gerber-artifact-race",
      testHooks: {
        beforeFinalReportPublication: async () => {
          await Bun.write(
            join(artifactProject.root, ".fulmetry/runs/gerber-artifact-race/manufacturing-draft/gerbers/board-F_Cu.gbr"),
            "mutated after manifest capture\n",
          );
        },
      },
    });
    expect(artifactRun.exitCode).toBe(1);
    expect(artifactRun.result?.exitClassification).toBe("failure");
    expect(artifactRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(artifactRun.stderr).toMatch(/manifest|authority|evidence/iu);

    const sourceProject = await createProject(await manufacturingFixture(2), "gerber source race");
    const sourcePath = join(sourceProject.root, "circuit/board.ts");
    const sourceRun = await runCli({
      argv: ["export", "gerbers", "--json"],
      cwd: sourceProject.root,
      runId: "gerber-source-race",
      testHooks: {
        beforeFinalReportPublication: async () => {
          await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}// stale export\n`);
        },
      },
    });
    expect(sourceRun.exitCode).toBe(1);
    expect(sourceRun.result?.exitClassification).toBe("failure");
    expect(sourceRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(sourceRun.stderr).toContain("Project inputs changed during command finalization");
  }, 120_000);

  test("cancels a draft Gerber export without publishing manufacturing artifact references", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const controller = new AbortController();
    controller.abort();
    const run = await runCli({
      argv: ["export", "gerbers", "--json"],
      cwd: project.root,
      runId: "gerber-cancelled",
      signal: controller.signal,
    });

    expect(run.exitCode).toBe(130);
    expect(run.result?.exitClassification).toBe("cancelled");
    expect(run.result?.statuses.fabrication.state).toBe("not-run");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.result?.artifacts.some(({ kind }) => kind === "draft-manufacturing")).toBeFalse();

    const lateProject = await createProject(await manufacturingFixture(2), "late gerber cancellation");
    const lateController = new AbortController();
    const lateRun = await runCli({
      argv: ["export", "gerbers", "--json"],
      cwd: lateProject.root,
      runId: "gerber-cancelled-at-publication",
      signal: lateController.signal,
      testHooks: {
        beforeFinalReportPublication: () => lateController.abort(),
      },
    });
    expect(lateRun.exitCode).toBe(130);
    expect(lateRun.result?.exitClassification).toBe("cancelled");
    expect(lateRun.result?.statuses.fabrication.state).toBe("not-run");
    expect(lateRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(lateRun.result?.artifacts.some(({ kind }) => kind === "draft-manufacturing"))
      .toBeFalse();
    expect(
      await Bun.file(join(
        lateRun.runDirectory!,
        "draft-artifact-manifest.json",
      )).exists(),
    ).toBeFalse();
  }, 120_000);

  test.skipIf(process.platform === "win32")("keeps a fake KiCad 10 candidate unqualified without running design commands", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const executable = join(project.root, "fake-kicad-cli");
    await Bun.write(executable, `#!${process.execPath}\nif(process.argv.includes('version'))console.log('10.0.5');else process.exit(91)\n`);
    await chmod(executable, 0o700);
    const run = await runCli({
      argv: ["export", "kicad", "--json"], cwd: project.root, runId: "kicad-candidate",
      externalToolPaths: { kicadCli: executable },
    });
    expect(run.exitCode).toBe(3);
    expect(run.result?.exitClassification).toBe("incomplete");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toContain("KICAD_HANDOFF_UNQUALIFIED_001");
    expect(run.result?.artifacts.filter(({ kind }) => kind === "kicad-live-input")).toHaveLength(3);
    const handoffReport = run.result?.artifacts.find(({ kind }) => kind === "kicad-handoff-report");
    const report = JSON.parse(await Bun.file(join(project.root, handoffReport!.path)).text());
    expect(report.liveKiCadValidation).toMatchObject({
      state: "unqualified", supportedMajors: [10],
      evidence: {
        tool: { version: "10.0.5" },
        execution: { state: "not-run-unqualified-identity", commands: [], outputs: [] },
      },
    });
    expect(report.liveKiCadValidation.evidence.source.authoredSourceDigest).toBe(run.result?.project?.sourceDigest);
    expect(report.mapping.some(({ disposition }: { disposition: string }) => disposition === "exact")).toBeTrue();
  }, 120_000);

  test("rejects a source mutation at the final KiCad report-publication boundary", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const sourcePath = join(project.root, "circuit/board.ts");
    const run = await runCli({
      argv: ["export", "kicad", "--json"],
      cwd: project.root,
      runId: "kicad-source-race",
      externalToolPaths: { kicadCli: null },
      kicadTestHooks: {
        beforeFinalReportPublication: async () => {
          await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}// late source mutation\n`);
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.stderr).toContain("Project inputs changed during command finalization");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
  }, 120_000);

  test("does not classify ordinary failure prose containing cancelled as cancellation", async () => {
    const project = await createProject(await manufacturingFixture(2), "ordinary-cancelled-prose");
    const run = await runCli({
      argv: ["export", "kicad", "--json"],
      cwd: project.root,
      runId: "ordinary-cancelled-prose",
      externalToolPaths: { kicadCli: null },
      kicadTestHooks: {
        beforeLiveInputWrite: () => {
          throw new Error("validation failed: cancelled flag was false");
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toContain("cancelled flag was false");
  }, 120_000);

  test("preserves a downstream file created concurrently at the final KiCad commit boundary", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const humanBytes = "human downstream edit\n";
    let injected = false;
    const run = await runCli({
      argv: ["export", "kicad", "--json"],
      cwd: project.root,
      runId: "kicad-exclusive-commit-race",
      externalToolPaths: { kicadCli: null },
      kicadTestHooks: {
        beforeHandoffFileCommit: async ({ path, relativePath }) => {
          if (relativePath !== "board.kicad_pcb") return;
          await writeFile(path, humanBytes, { flag: "wx" });
          injected = true;
        },
      },
    });
    const finalPath = join(
      project.root,
      ".fulmetry/runs/kicad-exclusive-commit-race/kicad-handoff/board.kicad_pcb",
    );
    expect(injected).toBeTrue();
    expect(await Bun.file(finalPath).text()).toBe(humanBytes);
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.result?.artifacts.some(({ kind }) => kind === "kicad-handoff")).toBeFalse();
    expect(run.stderr).toMatch(/exist/i);
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
  }, 120_000);

  test("rejects a late mutation of isolated KiCad input instead of returning stale artifact references", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const inputPath = join(project.root, ".fulmetry/runs/kicad-input-race/kicad-live-validation/input/board.kicad_pcb");
    const run = await runCli({
      argv: ["export", "kicad", "--json"],
      cwd: project.root,
      runId: "kicad-input-race",
      externalToolPaths: { kicadCli: null },
      kicadTestHooks: {
        beforeFinalReportPublication: async () => {
          await chmod(inputPath, 0o600);
          await Bun.write(inputPath, "late mutation\n");
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.stderr).toContain("no longer match authenticated evidence");
    expect(run.result?.artifacts.some(({ kind }) => kind === "kicad-live-input")).toBeFalse();
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
  }, 120_000);

  test("rejects mutated, extra, or symlinked final KiCad handoff publications without stale references", async () => {
    const attacks = [
      "board-bytes",
      "report-bytes",
      "extra-file",
      "oversized-board",
      ...(process.platform === "win32" ? [] : ["symlink"]),
    ] as const;
    for (const attack of attacks) {
      const project = await createProject(await manufacturingFixture(2), `kicad-publication-${attack}`);
      const handoffDirectory = join(project.root, `.fulmetry/runs/${attack}/kicad-handoff`);
      const run = await runCli({
        argv: ["export", "kicad", "--json"],
        cwd: project.root,
        runId: attack,
        externalToolPaths: { kicadCli: null },
        kicadTestHooks: {
          beforeFinalReportPublication: async () => {
            if (attack === "board-bytes") {
              const path = join(handoffDirectory, "board.kicad_pcb");
              await Bun.write(path, "late board mutation\n");
            } else if (attack === "report-bytes") {
              await Bun.write(join(handoffDirectory, "handoff-report.json"), "{}\n");
            } else if (attack === "extra-file") {
              await Bun.write(join(handoffDirectory, "extra.kicad_sch"), "extra\n");
            } else if (attack === "oversized-board") {
              await truncate(join(handoffDirectory, "board.kicad_pcb"), KICAD_ARTIFACT_FILE_BYTES_LIMIT + 1);
            } else {
              await symlink("board.kicad_sch", join(handoffDirectory, "linked.kicad_sch"));
            }
          },
        },
      });
      expect(run.exitCode, attack).toBe(1);
      expect(run.result?.exitClassification, attack).toBe("failure");
      expect(run.result?.artifacts.map(({ kind }) => kind), attack).toEqual(["command-error"]);
      expect(run.result?.artifacts.some(({ kind }) => kind === "kicad-handoff"), attack).toBeFalse();
      expect(run.stderr, attack).toMatch(
        /(?:publication (?:bytes|artifact set|contains non-regular|.*exceeds)|evidence artifact .* exceeds|run evidence contains symlink)/i,
      );
      expect(JSON.parse(await Bun.file(run.reportPath!).text()), attack).toEqual(run.result);
    }
  }, 120_000);

  test("rejects stale build, check, inspect, and manufacturing evidence at the shared finalization boundary", async () => {
    const commands = [
      { argv: ["build"], runId: "fresh-build" },
      { argv: ["check"], runId: "fresh-check" },
      { argv: ["inspect", "R1"], runId: "fresh-inspect" },
      { argv: ["verify", "manufacturing"], runId: "fresh-manufacturing" },
    ] as const;
    for (const command of commands) {
      const project = await createProject(await manufacturingFixture(2), command.runId);
      const sourcePath = join(project.root, "circuit/board.ts");
      const run = await runCli({
        argv: command.argv,
        cwd: project.root,
        runId: command.runId,
        testHooks: {
          beforeFinalReportPublication: async () => {
            await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}// late mutation\n`);
          },
        },
      });
      expect(run.exitCode, command.runId).toBe(1);
      expect(run.result?.exitClassification, command.runId).toBe("failure");
      expect(run.result?.artifacts.map(({ kind }) => kind), command.runId).toEqual(["command-error"]);
      expect(run.stderr, command.runId).toContain("Project inputs changed during command finalization");
      expect(JSON.parse(await Bun.file(run.reportPath!).text()), command.runId).toEqual(run.result);
    }
  }, 120_000);

  test("rejects configuration changes between run preparation and evidence input capture", async () => {
    const project = await createProject(await manufacturingFixture(2), "prepared-config-authority");
    const configPath = join(project.root, "fulmetry.config.ts");
    const run = await runCli({
      argv: ["build"], cwd: project.root, runId: "prepared-config-authority",
      testHooks: {
        beforeEvidenceInputCapture: async () => {
          await Bun.write(configPath, "export default { entry: 'circuit/board.ts', profiles: [] };\n");
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toContain("configuration or lock changed after run preparation");
  }, 120_000);

  test("rejects reflective runtime recovery in config before command preparation", async () => {
    const project = await createProject(
      await manufacturingFixture(2),
      "reflective-config-runtime",
    );
    await Bun.write(
      join(project.root, "fulmetry.config.ts"),
      `const F=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>{}),"constructor").value;void F;export default {entry:"circuit/board.ts",profiles:[${JSON.stringify(BASELINE_FABRICATION_PROFILE.name)}]}\n`,
    );
    const run = await runCli({
      argv: ["build"],
      cwd: project.root,
      runId: "reflective-config-runtime",
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.reportPath).toBeUndefined();
    expect(run.stderr).toContain("constructor/evaluator access");
  }, 120_000);

  test("revalidates project engine identity before capture and throughout evidence publication", async () => {
    const stages = ["before-capture", "before-report", "after-report"] as const;
    for (const stage of stages) {
      const project = await createProject(await manufacturingFixture(2), `engine-${stage}`);
      const mutate = async () => replaceProjectEngine(project.root);
      const run = await runCli({
        argv: ["build"], cwd: project.root, runId: `engine-${stage}`,
        testHooks: stage === "before-capture"
          ? { beforeEvidenceInputCapture: mutate }
          : stage === "before-report"
            ? { beforeFinalReportPublication: mutate }
            : { afterReportPublication: mutate },
      });
      expect(run.exitCode, stage).toBe(1);
      expect(run.result?.exitClassification, stage).toBe("failure");
      expect(run.result?.artifacts.map(({ kind }) => kind), stage).toEqual(["command-error"]);
      expect(run.result?.artifacts[0]?.digest, stage).toMatch(/^[a-f0-9]{64}$/u);
      expect(run.stderr, stage).toContain("Project tscircuit engine changed after run preparation");
      expect(JSON.parse(await Bun.file(run.reportPath!).text()), stage).toEqual(run.result);
    }
  }, 120_000);

  test("rejects artifact and contextual-report replacement without stale references", async () => {
    const artifactProject = await createProject(await manufacturingFixture(2), "artifact-authority");
    const artifactRun = await runCli({
      argv: ["build"], cwd: artifactProject.root, runId: "artifact-authority",
      testHooks: {
        beforeFinalReportPublication: async ({ runDirectory }) => {
          await Bun.write(join(runDirectory, "circuit.json"), "[]\n");
        },
      },
    });
    expect(artifactRun.exitCode).toBe(1);
    expect(artifactRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(artifactRun.stderr).toContain("Run evidence no longer matches");

    for (const attack of ["bytes", ...(process.platform === "win32" ? [] : ["symlink"])] as const) {
      const reportProject = await createProject(await manufacturingFixture(2), `report-authority-${attack}`);
      const reportRun = await runCli({
        argv: ["build"], cwd: reportProject.root, runId: `report-authority-${attack}`,
        testHooks: {
          afterReportPublication: async ({ reportPath }) => {
            if (attack === "bytes") await Bun.write(reportPath, "{}\n");
            else {
              await rm(reportPath);
              await symlink("circuit.json", reportPath);
            }
          },
        },
      });
      expect(reportRun.exitCode, attack).toBe(1);
      expect(reportRun.result?.artifacts.map(({ kind }) => kind), attack).toEqual(["command-error"]);
      expect(reportRun.stderr, attack).toMatch(/Published report (bytes do not match|must be a regular)/u);
      expect(JSON.parse(await Bun.file(reportRun.reportPath!).text()), attack).toEqual(reportRun.result);
    }
  }, 120_000);

  test("rejects authored evidence replacement before its initial authority capture", async () => {
    const project = await createProject(await manufacturingFixture(4), "standards evidence race");
    const run = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: project.root,
      runId: "standards-evidence-race",
      testHooks: {
        beforeEvidenceAuthorityCapture: async ({ runDirectory }) => {
          await Bun.write(join(runDirectory, "standards/pre-compliance.json"), "{}\n");
        },
      },
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.statuses.standards.state).toBe("not-run");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toContain("declares a stale digest");
  }, 120_000);

  test("never returns a stale command-error reference when failure publication is attacked", async () => {
    const attacks = ["bytes", ...(process.platform === "win32" ? [] : ["symlink"])] as const;
    for (const attack of attacks) {
      const project = await createProject(await manufacturingFixture(2), `failure-${attack}`);
      const sourcePath = join(project.root, "circuit/board.ts");
      const run = await runCli({
        argv: ["build"], cwd: project.root, runId: `failure-${attack}`,
        testHooks: {
          beforeFinalReportPublication: async () => {
            await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}// force stale evidence\n`);
          },
          beforeFailureReportPublication: async ({ errorPath }) => {
            if (attack === "bytes") await Bun.write(errorPath, "replaced failure bytes\n");
            else {
              await rm(errorPath);
              await symlink("circuit.json", errorPath);
            }
          },
        },
      });
      expect(run.exitCode, attack).toBe(1);
      expect(run.result?.exitClassification, attack).toBe("failure");
      expect(run.result?.artifacts, attack).toEqual([]);
      expect(JSON.parse(await Bun.file(run.reportPath!).text()), attack).toEqual(run.result);
    }
  }, 120_000);

  test("does not follow a replaced failure run directory", async () => {
    if (process.platform === "win32") return;
    const project = await createProject(await manufacturingFixture(2), "failure-root-replacement");
    const sourcePath = join(project.root, "circuit/board.ts");
    const attackerDirectory = join(project.root, "attacker-output");
    await mkdir(attackerDirectory);
    const run = await runCli({
      argv: ["build"], cwd: project.root, runId: "failure-root-replacement",
      testHooks: {
        beforeFinalReportPublication: async () => {
          await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}// force failure\n`);
        },
        beforeFailureReportPublication: async ({ runDirectory }) => {
          await rm(runDirectory, { recursive: true });
          await symlink(attackerDirectory, runDirectory);
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.artifacts).toEqual([]);
    expect(run.reportPath).toBeUndefined();
    expect(await Bun.file(join(attackerDirectory, "report.json")).exists()).toBeFalse();
  }, 120_000);

  test("returns structured failure when a final hook makes configuration unparsable", async () => {
    const project = await createProject(await manufacturingFixture(2), "malformed-final-config");
    const run = await runCli({
      argv: ["build"], cwd: project.root, runId: "malformed-final-config",
      testHooks: {
        beforeFinalReportPublication: async () => {
          await Bun.write(join(project.root, "fulmetry.config.ts"), "export default { entry: ;\n");
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.result?.artifacts[0]?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(run.result?.project?.projectDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
  }, 120_000);

  test("binds invalid named simulation outcomes to testbench freshness", async () => {
    const project = await createProject([], "simulation-freshness");
    await mkdir(join(project.root, "simulations"));
    const testbenchPath = join(project.root, "simulations/broken.testbench.ts");
    await Bun.write(testbenchPath, "export default { schemaVersion: 999 }\n");
    const executable = join(project.root, "fixture-ngspice");
    await Bun.write(executable, `#!${process.execPath}\nconsole.log('ngspice-44')\n`);
    await chmod(executable, 0o700);
    const run = await runCli({
      argv: ["simulate", "broken"], cwd: project.root, runId: "simulation-freshness",
      externalToolPaths: { ngspice: executable },
      testHooks: {
        beforeFinalReportPublication: async () => {
          await Bun.write(testbenchPath, "export default { schemaVersion: 998 }\n");
        },
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toContain("Project inputs changed during command finalization");
  }, 120_000);

  test("never probes broken KiCad during build or manufacturing verification", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const marker = join(project.root, "kicad-was-invoked");
    const executable = join(project.root, "hostile-kicad-cli");
    await Bun.write(executable, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},'invoked');process.exit(9)\n`);
    await chmod(executable, 0o700);
    const externalToolPaths = { kicadCli: executable };
    const built = await runCli({ argv: ["build"], cwd: project.root, runId: "build-no-kicad", externalToolPaths });
    const manufactured = await runCli({ argv: ["verify", "manufacturing"], cwd: project.root, runId: "manufacturing-no-kicad", externalToolPaths });
    expect(built.result?.diagnostics.some(({ id }) => String(id).startsWith("KICAD_"))).toBeFalse();
    expect(manufactured.result?.diagnostics.some(({ id }) => String(id).startsWith("KICAD_"))).toBeFalse();
    expect(await Bun.file(marker).exists()).toBeFalse();
  }, 120_000);

  test("reports missing ngspice as unavailable functional evidence, never a pass", async () => {
    const project = await createProject([]);
    const run = await runCli({
      argv: ["simulate", "power"],
      cwd: project.root,
      externalToolPaths: { ngspice: null },
    });
    expect(run.exitCode).toBe(2);
    expect(run.result?.exitClassification).toBe("unavailable");
    expect(run.result?.requestedDimensions).toEqual(["functional"]);
    expect(run.result?.statuses.functional.state).toBe("unavailable");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toContain(
      "SIM_NGSPICE_UNAVAILABLE_001",
    );
    expect(await Bun.file(run.reportPath!).exists()).toBeTrue();
  });

  test("rejects a configuration epoch change during a slow ngspice probe", async () => {
    const project = await createProject([], "slow-probe-authority");
    const marker = join(project.root, "probe-started");
    const executable = join(project.root, "slow-ngspice");
    await Bun.write(executable, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},'started');await Bun.sleep(500);console.log('ngspice-44')\n`);
    await chmod(executable, 0o700);
    const pending = runCli({
      argv: ["simulate", "missing"], cwd: project.root, runId: "slow-probe-authority",
      externalToolPaths: { ngspice: executable },
    });
    for (let attempt = 0; attempt < 3_000 && !await Bun.file(marker).exists(); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(await Bun.file(marker).exists()).toBeTrue();
    await Bun.write(join(project.root, "circuit/other.ts"), "export default [];\n");
    await Bun.write(join(project.root, "fulmetry.config.ts"), "export default { entry: 'circuit/other.ts', profiles: [] };\n");
    const run = await pending;
    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.result?.artifacts[0]?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(run.stderr).toContain("Resolved project configuration changed after run preparation");
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
  }, 120_000);

  test("keeps malformed or missing-model simulations separate from unrelated build authority", async () => {
    const project = await createProject([]);
    await mkdir(join(project.root, "simulations"));
    await Bun.write(join(project.root, "simulations/broken.testbench.ts"), "export default { schemaVersion: 999, models: [{ path: 'missing.model' }] }\n");
    const built = await runCli({ argv: ["build", "--json"], cwd: project.root, runId: "build-with-broken-simulation" });
    expect(built.exitCode).toBe(0);
    expect(built.result?.exitClassification).toBe("success");
    expect(built.result?.statuses.functional.state).toBe("not-run");
  });

  test("runs the named testbench boundary but keeps an unqualified executable incomplete", async () => {
    const project = await createProject(simulationCircuitFixture());
    await mkdir(join(project.root, "simulations"));
    await mkdir(join(project.root, "models"));
    const model = ".model fixture R\n";
    await Bun.write(join(project.root, "models/resistors.model"), model);
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(model).digest("hex")}`;
    await Bun.write(join(project.root, "simulations/divider.testbench.ts"), `export default ${JSON.stringify({
      schemaVersion: 1, name: "divider",
      region: { componentIds: ["R1", "R2"], netIds: ["VIN", "VOUT", "GND"] },
      models: [{ id: "resistors", device: { kind: "primitive", name: "resistor" }, bindings: [
        { componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
        { componentId: "R2", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
      ], path: "models/resistors.model", source: "CLI fixture", digest, license: "CC0-1.0", redistribution: "allowed" }],
      stimuli: [{ kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND", unit: "V", dcValue: 5, ac: null, transient: null }],
      solver: { engine: "ngspice" }, analysis: { kind: "operating-point" },
      assertions: [{ expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 2.5, absoluteTolerance: 0.001, relativeTolerance: 0 }],
      timeoutMs: 1_000,
    })};\n`);
    const executable = join(project.root, "fixture-ngspice");
    const raw = ["Title: fixture", "Plotname: Operating Point", "Flags: real", "No. Variables: 1", "No. Points: 1", "Variables:", "0 v(vout) voltage", "Values:", "0 2.5", ""].join("\n");
    await Bun.write(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('ngspice-44');process.exit(0)}const i=process.argv.indexOf('-r');await Bun.write(process.argv[i+1],${JSON.stringify(raw)});\n`);
    await chmod(executable, 0o700);
    const run = await runCli({ argv: ["simulate", "divider", "--json"], cwd: project.root, runId: "simulation-boundary", externalToolPaths: { ngspice: executable } });
    expect(run.exitCode).toBe(3);
    expect(run.result?.statuses).toMatchObject({
      fabrication: { state: "not-run" }, electrical: { state: "not-run" },
      functional: { state: "incomplete" }, standards: { state: "not-run" }, sourcing: { state: "unchecked" },
    });
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toEqual(["SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001"]);
    expect(run.result?.artifacts.map(({ kind }) => kind)).toContain("simulation-evidence");
    expect(run.result?.statuses.functional.state).not.toBe("passed");
  }, 120_000);

  test("classifies a cancelled project evaluation and terminates its child process", async () => {
    const project = await createProject([]);
    await Bun.write(
      join(project.root, "circuit/board.ts"),
      "while (true) {}\nexport default []\n",
    );
    const controller = new AbortController();
    const pending = runCli({
      argv: ["build"],
      cwd: project.root,
      runId: "cancelled-build",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const run = await pending;
    expect(run.exitCode).toBe(130);
    expect(run.result?.exitClassification).toBe("cancelled");
    expect(run.result?.statuses.electrical.state).toBe("not-run");
    expect(await Bun.file(run.reportPath!).exists()).toBeTrue();
  }, 120_000);

  test("rejects malformed and traversal-like run identifiers before discovery", async () => {
    const run = await runCli({
      argv: ["build", "--run-id", "../escape"],
      cwd: tmpdir(),
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("run id must be");
    expect(run.result?.exitClassification).toBe("failure");
  });

  test("refuses to report a locked engine identity when the project engine is absent", async () => {
    const project = await createProject([]);
    await rm(join(project.root, "node_modules/tscircuit"), { recursive: true, force: true });
    const run = await runCli({ argv: ["build"], cwd: project.root, runId: "missing-engine" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("TSCIRCUIT_UNAVAILABLE");
    expect(run.result?.project).toBeUndefined();
  });

  test("refuses a symlinked runs directory instead of writing outside the project", async () => {
    const project = await createProject([]);
    const outside = await mkdtemp(join(tmpdir(), "fulmetry-cli-outside-"));
    temporaryRoots.push(outside);
    await mkdir(join(project.root, ".fulmetry"));
    await symlink(outside, join(project.root, ".fulmetry", "runs"));

    const run = await runCli({
      argv: ["build"],
      cwd: project.root,
      runId: "symlink-attack",
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("contains a symlink");
    expect(await Bun.file(join(outside, "symlink-attack", "report.json")).exists()).toBeFalse();
  });

  test("refuses output that overlaps a transitive configuration dependency", async () => {
    const project = await createProject([]);
    await mkdir(join(project.root, "config"));
    await Bun.write(
      join(project.root, "config/profile.ts"),
      `export const profiles = [${JSON.stringify(BASELINE_FABRICATION_PROFILE.name)}];\n`,
    );
    await Bun.write(
      join(project.root, "fulmetry.config.ts"),
      "import { profiles } from './config/profile'; export default { entry: 'circuit/board.ts', outputDirectory: 'config', profiles };\n",
    );

    const run = await runCli({ argv: ["build"], cwd: project.root, runId: "overlap" });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("overlaps project source, configuration, or lock inputs");
    expect(await Bun.file(join(project.root, "config/runs")).exists()).toBeFalse();
  });

  test("refuses an output directory that would hide an authored failing test", async () => {
    const project = await createProject([]);
    await mkdir(join(project.root, "tests/runs"), { recursive: true });
    await Bun.write(
      join(project.root, "pass.test.ts"),
      `import { expect, test } from "bun:test"; test("visible pass", () => expect(true).toBeTrue());\n`,
    );
    const hiddenTestPath = join(project.root, "tests/runs/fail.test.ts");
    const hiddenTestBytes =
      `import { expect, test } from "bun:test"; test("must not be hidden", () => expect(true).toBeFalse());\n`;
    await Bun.write(hiddenTestPath, hiddenTestBytes);
    await Bun.write(
      join(project.root, "tests/.fulmetry-output-root.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "fulmetry-generated-output-root",
        outputDirectory: "tests",
        nonce: "00000000-0000-4000-8000-000000000000",
      })}\n`,
    );
    await Bun.write(
      join(project.root, "fulmetry.config.ts"),
      `export default ${JSON.stringify({
        entry: "circuit/board.ts",
        outputDirectory: "tests",
        profiles: [BASELINE_FABRICATION_PROFILE.name],
      })};\n`,
    );

    const run = await runCli({
      argv: ["test"],
      cwd: project.root,
      runId: "hidden-authored-test",
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("missing project-bound Fulmetry ownership authority");
    expect(await Bun.file(join(project.root, "tests/runs/hidden-authored-test")).exists()).toBeFalse();
    expect(await Bun.file(hiddenTestPath).text()).toBe(hiddenTestBytes);
  });

  test("allows the specified Fulmetry-owned immutable cache in the default output root", async () => {
    const project = await createProject([]);
    const cacheMarker = join(project.root, ".fulmetry/cache/immutable-asset.txt");
    await mkdir(dirname(cacheMarker), { recursive: true });
    await Bun.write(cacheMarker, "pinned cache fixture\n");

    const run = await runCli({
      argv: ["build"],
      cwd: project.root,
      runId: "default-cache-control",
    });

    expect(run.exitCode).toBe(0);
    expect(run.result?.exitClassification).toBe("success");
    expect(await Bun.file(cacheMarker).text()).toBe("pinned cache fixture\n");
    expect(await Bun.file(join(
      project.root,
      ".fulmetry/runs/default-cache-control/report.json",
    )).exists()).toBeTrue();
  });

  test("creates an exact ownership marker for a fresh custom output root", async () => {
    const project = await createProject([]);
    await Bun.write(
      join(project.root, "fulmetry.config.ts"),
      `export default ${JSON.stringify({
        entry: "circuit/board.ts",
        outputDirectory: "generated/fulmetry",
        profiles: [BASELINE_FABRICATION_PROFILE.name],
      })};\n`,
    );

    const run = await runCli({
      argv: ["build"],
      cwd: project.root,
      runId: "custom-output-marker",
    });

    expect(run.exitCode).toBe(0);
    const authorityBytes = await Bun.file(join(
      project.root,
      ".fulmetry-output-ownership.json",
    )).text();
    const markerBytes = await Bun.file(join(
      project.root,
      "generated/fulmetry/.fulmetry-output-root.json",
    )).text();
    expect(markerBytes).toBe(authorityBytes);
    expect(JSON.parse(authorityBytes)).toMatchObject({
      schemaVersion: 1,
      kind: "fulmetry-generated-output-root",
      outputDirectory: "generated/fulmetry",
    });
    expect(JSON.parse(authorityBytes).nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await Bun.file(join(
      project.root,
      "generated/fulmetry/runs/custom-output-marker/report.json",
    )).exists()).toBeTrue();
  });

  test("discovers from a descendant, writes one fresh run, and leaves source unchanged", async () => {
    const project = await createProject([]);
    const sourcePath = join(project.root, "circuit", "board.ts");
    const configPath = join(project.root, "fulmetry.config.ts");
    const lockPath = join(project.root, "fulmetry.lock");
    const before = await Promise.all(
      [sourcePath, configPath, lockPath].map((path) => readFile(path, "utf8")),
    );

    const run = await runCli({
      argv: ["build"],
      cwd: project.nested,
      runId: "build-001",
    });

    expect(run.exitCode).toBe(0);
    expect(run.result?.schemaVersion).toBe("1");
    expect(run.result?.exitClassification).toBe("success");
    expect(run.result?.project).toMatchObject({
      entry: "circuit/board.ts",
      tscircuit: { version: SUPPORTED_TSCIRCUIT_VERSION },
    });
    expect(run.result?.project?.projectDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(run.result?.project)).not.toContain(project.root);
    expect(run.runDirectory).toBe(
      join(await realpath(project.root), ".fulmetry", "runs", "build-001"),
    );
    expect(
      (JSON.parse(await Bun.file(join(run.runDirectory!, "circuit.json")).text()) as Array<{ type: string }>)
        .map(({ type }) => type),
    ).toEqual(["source_group", "source_board", "pcb_board"]);
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
    expect(
      await Promise.all(
        [sourcePath, configPath, lockPath].map((path) => readFile(path, "utf8")),
      ),
    ).toEqual(before);

    const repeated = await runCli({
      argv: ["build"],
      cwd: project.root,
      runId: "build-001",
    });
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain("exist");
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
  });

  test("rejects a composed two-board project before publishing normalized Circuit JSON", async () => {
    const project = await createProject(minimalBoardCircuitFixture(), "two-board-build");
    const assemblies = join(project.root, "circuit", "assemblies");
    await mkdir(assemblies, { recursive: true });
    const assembly = (name: string) => `export const ${name} = ${JSON.stringify([
      {
        type: "source_group",
        source_group_id: `assembly_${name}`,
        subcircuit_id: `subcircuit_${name}`,
        is_subcircuit: true,
        name,
      },
      {
        type: "source_board",
        source_board_id: `source_board_${name}`,
        source_group_id: `assembly_${name}`,
      },
      {
        type: "pcb_board",
        pcb_board_id: `pcb_board_${name}`,
        source_board_id: `source_board_${name}`,
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        thickness: 1.4,
        num_layers: 2,
        material: "fr4",
      },
    ])} as const;\n`;
    await Bun.write(join(assemblies, "control.ts"), assembly("control"));
    await Bun.write(join(assemblies, "power.ts"), assembly("power"));
    await Bun.write(
      join(project.root, "circuit", "board.ts"),
      'import { control } from "./assemblies/control";\nimport { power } from "./assemblies/power";\nexport default [...control, ...power];\n',
    );

    const run = await runCli({
      argv: ["build", "--offline", "--json"],
      cwd: project.root,
      runId: "two-board-build",
    });
    expect(run.exitCode).toBe(4);
    expect(run.result?.exitClassification).toBe("unsupported");
    expect(run.result?.statuses.fabrication.state).toBe("incomplete");
    expect(run.result?.diagnostics.map(({ id }) => String(id)))
      .toEqual(["PROJECT_BOARD_CARDINALITY_UNSUPPORTED_001"]);
    expect(run.result?.diagnostics[0]?.sourceLocations.some((location) =>
      location.startsWith("circuit/assemblies/")
    )).toBeTrue();
    expect(run.result?.artifacts).toEqual([]);
    expect(await Bun.file(join(run.runDirectory!, "circuit.json")).exists()).toBeFalse();
    expect(JSON.parse(run.stdout)).toEqual(run.result);
  });

  test("requires one linked root assembly even when PCB-board count is not duplicated", async () => {
    const cases = [
      {
        name: "missing-board",
        circuitJson: [{ type: "source_project_metadata", name: "missing board fixture" }],
      },
      {
        name: "detached-root-assembly",
        circuitJson: [
          ...minimalBoardCircuitFixture(),
          {
            type: "source_group",
            source_group_id: "detached_root",
            subcircuit_id: "subcircuit_detached_root",
            is_subcircuit: true,
            name: "detached",
          },
        ],
      },
      {
        name: "orphan-parent-assembly",
        circuitJson: [
          ...minimalBoardCircuitFixture(),
          {
            type: "source_group",
            source_group_id: "orphan_assembly",
            subcircuit_id: "subcircuit_orphan_assembly",
            parent_source_group_id: "missing_parent",
            parent_subcircuit_id: "missing_parent_subcircuit",
            is_subcircuit: true,
            name: "orphan",
          },
        ],
      },
      {
        name: "cyclic-child-assemblies",
        circuitJson: [
          ...minimalBoardCircuitFixture(),
          {
            type: "source_group",
            source_group_id: "child_a",
            subcircuit_id: "subcircuit_child_a",
            parent_source_group_id: "child_b",
            parent_subcircuit_id: "subcircuit_child_b",
            name: "child-a",
          },
          {
            type: "source_group",
            source_group_id: "child_b",
            subcircuit_id: "subcircuit_child_b",
            parent_source_group_id: "child_a",
            parent_subcircuit_id: "subcircuit_child_a",
            name: "child-b",
          },
        ],
      },
    ];
    for (const fixture of cases) {
      const project = await createProject(fixture.circuitJson, fixture.name);
      const run = await runCli({
        argv: ["build", "--offline", "--json"],
        cwd: project.root,
        runId: fixture.name,
      });
      expect(run.exitCode, fixture.name).toBe(4);
      expect(run.result?.exitClassification, fixture.name).toBe("unsupported");
      expect(run.result?.diagnostics.map(({ id }) => String(id)), fixture.name)
        .toEqual(["PROJECT_BOARD_CARDINALITY_UNSUPPORTED_001"]);
      expect(run.result?.artifacts, fixture.name).toEqual([]);
      expect(await Bun.file(join(run.runDirectory!, "circuit.json")).exists(), fixture.name)
        .toBeFalse();
    }

    const nested = await createProject([
      ...minimalBoardCircuitFixture(),
      {
        type: "source_group",
        source_group_id: "child_group",
        subcircuit_id: "subcircuit_child_group",
        parent_source_group_id: "source_group_0",
        parent_subcircuit_id: "subcircuit_source_group_0",
        name: "child",
      },
    ], "nested-child-assembly");
    const nestedRun = await runCli({
      argv: ["build", "--json"],
      cwd: nested.root,
      runId: "nested-child-assembly",
    });
    expect(nestedRun.exitCode).toBe(0);
    expect(nestedRun.result?.exitClassification).toBe("success");
    expect(nestedRun.result?.artifacts.map(({ kind }) => kind)).toEqual(["circuit-json"]);
  }, 120_000);

  test("returns full versioned JSON while preserving independent failed statuses", async () => {
    const attacked = structuredClone(await manufacturingFixture(2));
    const traceIndex = attacked.findIndex((element) => element.type === "pcb_trace");
    if (traceIndex < 0) throw new Error("Fixture has no routed trace to attack");
    attacked.splice(traceIndex, 1);
    const project = await createProject(attacked);

    const run = await runCli({
      argv: ["check", "--json"],
      cwd: project.root,
      runId: "check-failure",
    });
    const stdoutResult = JSON.parse(run.stdout);
    const reportResult = JSON.parse(await Bun.file(run.reportPath!).text());

    expect(run.exitCode).not.toBe(0);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.statuses.electrical.state).toBe("failed");
    expect(run.result?.statuses.functional.state).toBe("not-run");
    expect(run.result?.statuses.sourcing.state).toBe("unchecked");
    const connectivity = run.result?.diagnostics.find(({ id }) => String(id) === "ELECTRICAL_CONNECTIVITY_001");
    expect(connectivity?.sourceLocations.length).toBeGreaterThan(0);
    expect(connectivity?.sourceLocations.every((location) => location.startsWith("circuit/board.ts:"))).toBeTrue();
    expect(stdoutResult).toEqual(reportResult);
    expect(reportResult).toEqual(run.result);
  });

  test("source-only check remains incomplete until manufacturing artifacts are verified", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const run = await runCli({ argv: ["check"], cwd: project.root, runId: "source-check" });
    expect(run.exitCode).toBe(3);
    expect(run.result?.statuses.electrical.state).toBe("passed");
    expect(run.result?.statuses.fabrication.state).toBe("incomplete");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toContain(
      "FAB_ARTIFACT_VERIFICATION_NOT_RUN_001",
    );
  });

  test("focuses inspect output by status and rule without mutating evidence", async () => {
    const attacked = structuredClone(await manufacturingFixture(2));
    const traceIndex = attacked.findIndex((element) => element.type === "pcb_trace");
    if (traceIndex < 0) throw new Error("Fixture has no routed trace to attack");
    attacked.splice(traceIndex, 1);
    const project = await createProject(attacked);

    const run = await runCli({
      argv: [
        "inspect",
        "--status",
        "electrical",
        "--rule",
        "ELECTRICAL_CONNECTIVITY_001",
      ],
      cwd: project.root,
      runId: "inspect-rule",
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.requestedDimensions).toEqual(["electrical"]);
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toEqual([
      "ELECTRICAL_CONNECTIVITY_001",
    ]);
    expect(run.stdout).toContain("Inspect:");
    expect(run.stdout.length).toBeLessThanOrEqual(8_001);
  });

  test("focuses internal-detail diagnostics on their exact circuit object", async () => {
    const attacked = structuredClone(await manufacturingFixture(2));
    const sourceTrace = attacked.find((element) =>
      element.type === "source_trace" && element.source_trace_id === "source_trace_2"
    );
    if (sourceTrace?.type !== "source_trace") throw new Error("Fixture source trace missing");
    sourceTrace.max_length = 0.01;
    const project = await createProject(attacked);
    const run = await runCli({
      argv: ["inspect", "source_trace_2", "--status", "fabrication"],
      cwd: project.root,
      runId: "inspect-internal-detail",
    });
    const route = run.result?.diagnostics.find(({ id }) =>
      String(id) === "FAB_ROUTE_CONSTRAINT_001"
    );
    expect(run.exitCode).toBe(1);
    expect(route?.objects.some((object) => object.startsWith("source_trace_2:"))).toBeTrue();
    expect(route?.sourceLocations.length).toBeGreaterThan(0);
  });

  test("preserves an unchecked sourcing inspection as an incomplete focused result", async () => {
    const project = await createProject([]);
    for (const [format, json] of [["text", false], ["json", true]] as const) {
      const run = await runCli({
        argv: ["inspect", "--status", "sourcing", ...(json ? ["--json"] : [])],
        cwd: project.root,
        runId: `inspect-sourcing-${format}`,
      });
      expect(run.exitCode, format).toBe(3);
      expect(run.result?.exitClassification, format).toBe("incomplete");
      expect(run.result?.requestedDimensions, format).toEqual(["sourcing"]);
      expect(run.result?.statuses.sourcing.state, format).toBe("unchecked");
      expect(run.result?.artifacts.some(({ kind }) => kind === "command-error"), format).toBeFalse();
      expect(run.result?.artifacts.some(({ kind }) => kind === "sourcing-evidence"), format).toBeTrue();
      expect(run.result?.sourcingEvidence, format).toMatchObject({
        mode: "recorded-offline",
        claim: "not-checked-no-policy",
        selections: [],
      });
      if (json) expect(JSON.parse(run.stdout), format).toEqual(run.result);
      else {
        expect(run.stdout, format).toContain("sourcing: unchecked");
        expect(run.stdout, format).toContain("Read .fulmetry/runs/");
      }
    }
  });

  test("inspect rejects unknown targets and writes a focused artifact for known objects", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const missing = await runCli({
      argv: ["inspect", "does-not-exist"],
      cwd: project.root,
      runId: "inspect-missing",
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.result?.diagnostics.map(({ id }) => String(id))).toContain(
      "INSPECT_TARGET_NOT_FOUND_001",
    );

    const known = await runCli({
      argv: ["inspect", "R1"],
      cwd: project.root,
      runId: "inspect-known",
    });
    const focused = known.result?.artifacts.find(({ kind }) => kind === "inspection");
    expect(focused).toBeDefined();
    const payload = JSON.parse(await Bun.file(join(project.root, focused!.path)).text());
    expect(payload.target).toBe("R1");
    expect(payload.objects.length).toBeGreaterThan(0);
  });

  test("inspect rejects absent focused targets and rules despite unrelated waiver evidence", () => {
    const waiver = defineDiagnostic({
      id: diagnosticId("STANDARDS_REVIEW_WAIVER_001"),
      severity: "warning",
      dimension: "standards",
      message: "An unrelated standards review is waived",
      waiverPolicy: "allowed",
      disposition: "waived",
      objects: ["standards-profile"],
      sourceLocations: [],
      resolution: {
        scope: "standards-profile",
        justification: "Scoped fixture evidence for inspect selection",
      },
    });

    const selection = completeInspectDiagnosticSelection(
      [waiver],
      [],
      { target: "does-not-exist", status: "electrical" },
      false,
    );

    expect(selection.forcedFailure).toBeTrue();
    expect(selection.diagnostics.map(({ id }) => String(id))).toEqual([
      "STANDARDS_REVIEW_WAIVER_001",
      "INSPECT_TARGET_NOT_FOUND_001",
    ]);
    expect(selection.diagnostics[0]?.disposition).toBe("waived");

    const ruleSelection = completeInspectDiagnosticSelection(
      [waiver],
      [],
      { rule: "ELECTRICAL_CONNECTIVITY_001", status: "electrical" },
      false,
    );
    expect(ruleSelection.forcedFailure).toBeTrue();
    expect(ruleSelection.diagnostics.map(({ id }) => String(id))).toEqual([
      "STANDARDS_REVIEW_WAIVER_001",
      "INSPECT_RULE_NOT_ACTIVE_001",
    ]);
  });

  test("exports only draft artifacts and independently verifies manufacturing output", async () => {
    const project = await createProject(await manufacturingFixture(2));
    const run = await runCli({
      argv: ["verify", "manufacturing"],
      cwd: project.root,
      runId: "manufacturing-001",
    });

    expect(run.exitCode).toBe(0);
    expect(run.result?.exitClassification).toBe("success");
    expect(run.result?.statuses.fabrication.state).toBe("passed");
    expect(run.result?.statuses.electrical.state).toBe("passed");
    expect(run.result?.statuses.standards).toMatchObject({
      dimension: "standards",
      state: "passed",
      summary: expect.stringContaining("not certification"),
    });
    expect(run.result?.statuses.sourcing.state).toBe("unchecked");
    expect(run.result?.requestedDimensions).toEqual([
      "fabrication",
      "electrical",
      "standards",
    ]);
    const standardsArtifact = run.result?.artifacts.find(
      ({ kind }) => kind === "standards-evidence",
    );
    expect(standardsArtifact).toBeDefined();
    const standardsEvidence = JSON.parse(
      await Bun.file(join(project.root, standardsArtifact!.path)).text(),
    );
    expect(standardsEvidence).toMatchObject({
      kind: "pre-compliance-evidence",
      claim: "checked-against-profile",
      certification: "not-certification",
      outcome: "profile-passed",
      evidence: {
        independentParser: "gerber-parser@4.2.7",
        independentlyParsedManufacturingArtifacts: "passed",
      },
    });
    expect(standardsEvidence.evidence.boundedArtifactSet.length).toBeGreaterThan(10);
    const verificationArtifact = run.result?.artifacts.find(
      ({ kind }) => kind === "manufacturing-verification",
    );
    expect(verificationArtifact).toBeDefined();
    const verificationEvidence = JSON.parse(
      await Bun.file(join(project.root, verificationArtifact!.path)).text(),
    );
    expect(verificationEvidence).toMatchObject({
      schemaVersion: 1,
      lifecycle: "independent-manufacturing-verification",
      parser: "gerber-parser@4.2.7",
      adapters: MANUFACTURING_ADAPTER_VERSIONS,
      authenticatedPackages: {
        gerber: {
          package: "circuit-json-to-gerber",
          version: "0.0.90",
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        independentParser: {
          package: "gerber-parser",
          version: "4.2.7",
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
      passed: true,
      expectation: { boardName: "board", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      project: {
        projectDigest: run.result?.project?.projectDigest,
        sourceDigest: run.result?.project?.sourceDigest,
        configDigest: run.result?.project?.configDigest,
        lockDigest: run.result?.project?.lockDigest,
      },
    });
    expect(verificationEvidence.artifacts.length).toBeGreaterThan(10);
    expect(verificationEvidence.findings).toEqual([]);
    expect(
      run.result?.artifacts.some(({ kind }) => kind === "draft-manufacturing"),
    ).toBeTrue();
    expect(
      run.result?.artifacts.some(({ kind }) => kind.includes("verified")),
    ).toBeFalse();
    expect(run.result?.artifacts.every(({ digest }) => /^[a-f0-9]{64}$/u.test(digest ?? "")))
      .toBeTrue();
    for (const artifact of run.result?.artifacts ?? []) {
      const bytes = await Bun.file(join(project.root, artifact.path)).bytes();
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(artifact.digest).toBe(digest);
    }
    expect(await Bun.file(run.reportPath!).exists()).toBeTrue();
  });

  test("returns warning-only only after exact source-controlled waivers and independent artifact verification", async () => {
    const circuit = structuredClone(await manufacturingFixture(2));
    for (const sourceTrace of circuit.filter((element) => element.type === "source_trace")) {
      sourceTrace.min_trace_thickness = 0.1;
    }
    for (const trace of circuit.filter((element) => element.type === "pcb_trace")) {
      for (const point of trace.route) {
        if (point.route_type === "wire") point.width = 0.149;
      }
    }
    const sourceAssessment = assessCircuitFabrication(circuit, BASELINE_FABRICATION_PROFILE);
    const minimum = sourceAssessment.diagnostics.find(
      ({ id }) => id === "FAB_PROFILE_MINIMUM_001",
    );
    expect(minimum).toMatchObject({ severity: "error", waiverPolicy: "allowed" });
    expect(minimum?.objects.length).toBeGreaterThan(0);

    const project = await createProject(circuit, "manufacturing scoped waiver");
    await mkdir(join(project.root, "waivers"));
    await Bun.write(join(project.root, "waivers/fabrication.json"), `${JSON.stringify({
      schemaVersion: 1,
      waivers: minimum!.objects.map((scope) => ({
        diagnosticId: "FAB_PROFILE_MINIMUM_001",
        dimension: "fabrication",
        scope,
        justification: "The selected fabricator explicitly reviewed this exact trace occurrence.",
      })),
    }, null, 2)}\n`);

    const sourceOnly = await runCli({
      argv: ["check", "--json"],
      cwd: project.root,
      runId: "waived-source-only",
    });
    expect(sourceOnly.exitCode).toBe(3);
    expect(sourceOnly.result?.exitClassification).toBe("incomplete");
    expect(sourceOnly.result?.statuses.fabrication.state).toBe("incomplete");
    expect(sourceOnly.result?.diagnostics).toContainEqual(expect.objectContaining({
      id: "FAB_ARTIFACT_VERIFICATION_NOT_RUN_001",
      disposition: "active",
    }));

    const verified = await runCli({
      argv: ["verify", "manufacturing"],
      cwd: project.root,
      runId: "waived-manufacturing-verified",
    });
    expect(
      verified.exitCode,
      `${verified.stderr}\n${JSON.stringify(verified.result, null, 2)}`,
    ).toBe(0);
    expect(verified.result?.exitClassification).toBe("warning-only");
    expect(verified.stdout).toContain("WARNING-ONLY fulmetry verify manufacturing");
    expect(verified.result?.statuses.fabrication.state).toBe("passed-with-waivers");
    expect(verified.result?.statuses.electrical.state).toBe("passed");
    expect(verified.result?.statuses.standards.state).toBe("passed-with-waivers");
    const waivedDiagnostics = verified.result?.diagnostics.filter(
      ({ id }) => id === "FAB_PROFILE_MINIMUM_001",
    ) ?? [];
    expect(waivedDiagnostics.length).toBeGreaterThan(0);
    expect(waivedDiagnostics.every(({ disposition, resolution, sourceLocations }) =>
      disposition === "waived" && resolution?.scope !== undefined &&
      resolution.justification.length > 0 && sourceLocations.length > 0
    )).toBeTrue();
    const standardsReference = verified.result?.artifacts.find(
      ({ kind }) => kind === "standards-evidence",
    );
    const standardsEvidence = JSON.parse(
      await Bun.file(join(project.root, standardsReference!.path)).text(),
    );
    expect(standardsEvidence).toMatchObject({
      outcome: "profile-passed-with-waivers",
      profile: {
        source: BASELINE_FABRICATION_PROFILE.source,
      },
      evidence: {
        sourceProfileRules: "passed-with-waivers",
        independentlyParsedManufacturingArtifacts: "passed",
      },
    });
    expect(JSON.parse(await Bun.file(verified.reportPath!).text())).toEqual(verified.result);
  }, 120_000);

  test("replays independent manufacturing verification against post-check artifact bytes", async () => {
    const project = await createProject(await manufacturingFixture(4), "manufacturing post-check race");
    const run = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: project.root,
      runId: "manufacturing-post-check-race",
      manufacturingTestHooks: {
        afterVerification: async ({ manufacturingDirectory }) => {
          await Bun.write(join(manufacturingDirectory, "gerbers/board-F_Cu.gbr"), "");
        },
      },
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.statuses.fabrication.state).toBe("not-run");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    expect(run.stderr).toMatch(
      /Manufacturing artifacts no longer match the independently verified bytes|declares a stale digest/u,
    );
    expect(JSON.parse(await Bun.file(run.reportPath!).text())).toEqual(run.result);
  }, 120_000);

  test("rejects a second authored source board even when only one PCB board was emitted", async () => {
    const circuit = structuredClone(await manufacturingFixture(2));
    const sourceBoard = circuit.find((element) => element.type === "source_board");
    if (sourceBoard?.type !== "source_board") throw new Error("Fixture source board missing");
    circuit.push({ ...sourceBoard, source_board_id: "source_board_duplicate" });
    const project = await createProject(circuit, "duplicate authored source board");
    const run = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: project.root,
      runId: "duplicate-source-board",
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.statuses.fabrication.state).toBe("failed");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toContain(
      "FAB_BOARD_STRUCTURE_001",
    );
    const verificationReference = run.result?.artifacts.find(
      ({ kind }) => kind === "manufacturing-verification",
    );
    const verification = JSON.parse(
      await Bun.file(join(project.root, verificationReference!.path)).text(),
    );
    expect(verification.passed).toBeFalse();
    expect(verification.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_UNSUPPORTED",
      message: expect.stringContaining("exactly one authored source board"),
    }));
  }, 120_000);

  test("fails manufacturing when a coherent emitter error reverses non-interchangeable pins", async () => {
    const attacked = structuredClone(await manufacturingFixture(2));
    reverseNonInterchangeableD1PinMap(attacked);
    const project = await createProject(attacked, "reversed non-interchangeable pin map");

    const run = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: project.root,
      runId: "reversed-pin-map",
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.exitClassification).toBe("failure");
    expect(run.result?.statuses).toMatchObject({
      fabrication: { state: "failed" },
      electrical: { state: "passed" },
      standards: { state: "failed" },
    });
    const pinMapDiagnostics = run.result?.diagnostics.filter(
      ({ id }) => String(id) === "MFG_MANUFACTURING_UNSUPPORTED_001",
    ) ?? [];
    expect(pinMapDiagnostics).toHaveLength(2);
    expect(pinMapDiagnostics.map(({ message }) => message)).toEqual([
      expect.stringContaining("schematic port identity for source_port_2 contradicts source pin 2"),
      expect.stringContaining("schematic port identity for source_port_3 contradicts source pin 1"),
    ]);
    expect(JSON.parse(run.stdout)).toEqual(run.result);
  });

  test("removes standalone passing evidence when manufacturing verification is cancelled late", async () => {
    const project = await createProject(await manufacturingFixture(2), "late manufacturing cancel");
    const controller = new AbortController();
    const run = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: project.root,
      runId: "manufacturing-late-cancel",
      signal: controller.signal,
      testHooks: {
        beforeFinalReportPublication: () => controller.abort(),
      },
    });

    expect(run.exitCode).toBe(130);
    expect(run.result?.exitClassification).toBe("cancelled");
    expect(run.result?.artifacts.map(({ kind }) => kind)).toEqual(["command-error"]);
    for (const path of [
      "manufacturing-verification.json",
      "standards/pre-compliance.json",
      "sourcing/recorded-evidence.json",
    ]) {
      expect(await Bun.file(join(run.runDirectory!, ...path.split("/"))).exists()).toBeFalse();
    }
    expect(
      await Bun.file(join(run.runDirectory!, "manufacturing-draft", "gerbers", "board-F_Cu.gbr"))
        .exists(),
    ).toBeTrue();
  }, 120_000);

  test("keeps compiler-generated temporary component names development-only", async () => {
    const circuitJson = structuredClone(await manufacturingFixture(2));
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "D1",
    );
    if (source?.type !== "source_component") throw new Error("D1 source fixture missing");
    source.name = "unnamed_led1";
    const project = await createProject(circuitJson, "temporary component identity");

    const check = await runCli({
      argv: ["check", "--json"],
      cwd: project.root,
      runId: "temporary-name-check",
    });
    expect(check.exitCode).toBe(3);
    expect(check.result?.statuses.fabrication.state).toBe("incomplete");
    expect(check.result?.diagnostics).toContainEqual(expect.objectContaining({
      id: "FAB_TEMPORARY_COMPONENT_NAME_001",
      severity: "warning",
    }));

    const verify = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: project.root,
      runId: "temporary-name-verify",
    });
    expect(verify.exitCode).toBe(1);
    expect(verify.result?.statuses.fabrication.state).toBe("failed");
    expect(verify.result?.diagnostics).toContainEqual(expect.objectContaining({
      id: "MFG_MANUFACTURING_UNSUPPORTED_001",
      message: expect.stringContaining("must be replaced by an explicit stable"),
    }));
  }, 120_000);

  test("fails manufacturing when a PCB port contradicts its owning pad center", async () => {
    const circuitJson = structuredClone(await manufacturingFixture(2));
    const pad = circuitJson.find(
      (element) => element.type === "pcb_smtpad" && element.pcb_port_id !== undefined,
    );
    if (pad?.type !== "pcb_smtpad" || pad.pcb_port_id === undefined || !("x" in pad)) {
      throw new Error("SMT pad fixture missing");
    }
    const port = circuitJson.find(
      (element) => element.type === "pcb_port" && element.pcb_port_id === pad.pcb_port_id,
    );
    if (port?.type !== "pcb_port") throw new Error("Owning PCB port fixture missing");
    port.x += 5;
    const project = await createProject(circuitJson, "displaced PCB port");

    const run = await runCli({
      argv: ["verify", "manufacturing", "--offline", "--json"],
      cwd: project.root,
      runId: "displaced-pcb-port",
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.statuses).toMatchObject({
      fabrication: { state: "failed" },
      electrical: { state: "passed" },
      standards: { state: "failed" },
    });
    expect(run.result?.diagnostics).toContainEqual(expect.objectContaining({
      id: "MFG_MANUFACTURING_UNSUPPORTED_001",
      message: expect.stringContaining("does not coincide with every mapped manufactured pad center"),
      objects: [port.pcb_component_id ?? pad.pcb_component_id, port.pcb_port_id],
      sourceLocations: ["circuit/board.ts:1:1"],
      evidence: [
        "provenance:ambiguous-authored-name",
        "provenance:instance-path:group:@source_group_0/component:R1/record:pcb_component_0",
      ],
      measurement: {
        actual: expect.stringContaining(`${port.x}mm`),
        required: expect.stringContaining(`${pad.x}mm`),
      },
    }));
  });

  test("keeps a profile-based standards pass independent from electrical failure", async () => {
    const attacked = structuredClone(await manufacturingFixture(2));
    const port = attacked.find((element) => element.type === "source_port");
    if (port?.type !== "source_port") throw new Error("Fixture has no source port to attack");
    if (typeof port.source_component_id !== "string") {
      throw new Error("Fixture source port has no component owner");
    }
    attacked.push({
      type: "source_pin_must_be_connected_error",
      source_pin_must_be_connected_error_id: "source_pin_must_be_connected_error_test",
      error_type: "source_pin_must_be_connected_error",
      source_component_id: port.source_component_id,
      source_port_id: port.source_port_id,
      message: "An independently reported required pin is not connected",
    });
    const project = await createProject(attacked);

    const run = await runCli({
      argv: ["verify", "manufacturing", "--json"],
      cwd: project.root,
      runId: "independent-standards-status",
    });

    expect(run.exitCode).toBe(1);
    expect(run.result?.statuses).toMatchObject({
      fabrication: { state: "passed" },
      electrical: { state: "failed" },
      standards: { state: "passed" },
      sourcing: { state: "unchecked" },
    });
    expect(run.result?.artifacts.some(({ kind }) => kind === "standards-evidence"))
      .toBeTrue();
  });
});
