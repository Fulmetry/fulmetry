import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_GATE_NAMES, HEAVY_TEST_FILES, ciGateCommand } from "../scripts/run-ci-gate";
import {
  REGULAR_CI_GATE_NAMES,
  REGULAR_TEST_FILES_PER_SHARD_LIMIT,
  discoverRegularTestFiles,
  regularTestShardFiles,
} from "../scripts/regular-test-shards";
import {
  CLI_OVERALL_TIMEOUT_MS,
  CLI_PARTITION_TIMEOUT_MS,
  CLI_TESTS_PER_PARTITION_LIMIT,
  cliTestPartitionPattern,
  cliTestPartitions,
  extractCliTestTitles,
} from "../scripts/run-cli-test-partitions";
import {
  parseRepositoryTestJunit,
  requirePassingRepositoryTestReport,
} from "../scripts/repository-test-contract";
import { REPOSITORY_TEST_PROCESS_TIMEOUT_MS } from "../scripts/run-repository-test-gate";

const root = join(import.meta.dir, "..");

async function independentlyDiscoverRepositoryTests(repositoryRoot: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string, prefix: "test" | "tests", relative: string): Promise<void> => {
    for await (const entry of await opendir(directory)) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Independent inventory found symlink ${prefix}/${path}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), prefix, path);
      else if (entry.isFile() && /\.test\.tsx?$/u.test(entry.name)) files.push(`./${prefix}/${path}`);
      else if (!entry.isFile()) throw new Error(`Independent inventory found special entry ${prefix}/${path}`);
    }
  };
  await visit(join(repositoryRoot, "test"), "test", "");
  try {
    await visit(join(repositoryRoot, "tests"), "tests", "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Object.freeze(files.sort());
}

interface WorkflowStep {
  readonly env?: Record<string, string>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, string>;
}

describe("release workflow memory isolation", () => {
  test("applies the repository-test policy preload in authoritative gate runs", () => {
    if (process.env.PCBOO_REPOSITORY_TEST_POLICY_REQUIRED === "1") {
      expect(process.env.PCBOO_REPOSITORY_TEST_POLICY_ACTIVE).toBe("1");
    }
  });
  test("partitions every named gate into bounded fresh regular shards and isolated heavy workers", async () => {
    expect(CI_GATE_NAMES).toEqual([
      "typecheck",
      ...REGULAR_CI_GATE_NAMES,
      "cli-integration",
      "accept-tscircuit-upgrade",
      "artifact-manifest",
      "manufacturing-properties",
      "semantic-properties",
      "manufacturing-verify",
      "production-promotion",
      "scaffold",
      "server",
      "ngspice-live",
      "performance",
      "packed-e2e",
    ]);
    const regularFiles = await discoverRegularTestFiles(join(root, "test"));
    const regularShards = await Promise.all(REGULAR_CI_GATE_NAMES.map(async (gate) => ({
      gate,
      files: await regularTestShardFiles(gate, join(root, "test")),
      command: await ciGateCommand(gate),
    })));
    const shardedFiles = regularShards.flatMap(({ files }) => files);
    expect(shardedFiles.slice().sort()).toEqual([...regularFiles]);
    expect(new Set(shardedFiles).size).toBe(regularFiles.length);
    for (const { files, command } of regularShards) {
      expect(files.length).toBeGreaterThan(0);
      expect(files.length).toBeLessThanOrEqual(REGULAR_TEST_FILES_PER_SHARD_LIMIT);
      expect(command.at(-files.length - 1)).toContain("run-repository-test-gate.ts");
      for (const file of files) expect(command).toContain(file);
      expect(command.filter((argument) => /\.test\.tsx?$/u.test(argument))).toEqual([...files]);
    }
    const independentlyListedTests = await independentlyDiscoverRepositoryTests(root);
    const independentlyRegular = independentlyListedTests.filter((file) =>
      !file.startsWith("./test/") ||
      !HEAVY_TEST_FILES.includes(file.slice("./test/".length) as never)
    );
    expect(regularFiles).toEqual(independentlyRegular);
    expect(new Set(regularFiles).size).toBe(regularFiles.length);
    expect(regularFiles).not.toContain("./test/cli.test.ts");
    expect((await ciGateCommand("cli-integration")).at(-1)).toContain("run-cli-test-partitions.ts");
    if (process.platform !== "win32") {
      for (const { command } of regularShards) {
        expect(command.slice(0, 2)).toEqual([process.execPath, "--no-orphans"]);
      }
      expect((await ciGateCommand("typecheck"))[1]).toBe("--no-orphans");
      expect((await ciGateCommand("packed-e2e"))[1]).toBe("--no-orphans");
    }
    for (const [gate, file] of [
      ["accept-tscircuit-upgrade", "accept-tscircuit-upgrade.test.ts"],
      ["artifact-manifest", "artifact-manifest.test.ts"],
      ["manufacturing-properties", "manufacturing-properties.test.ts"],
      ["semantic-properties", "semantic-properties.test.ts"],
      ["manufacturing-verify", "manufacturing-verify.test.ts"],
      ["production-promotion", "production-promotion.test.ts"],
      ["scaffold", "scaffold.test.ts"],
      ["server", "server.test.ts"],
      ["ngspice-live", "ngspice-live.test.ts"],
    ] as const) {
      expect(regularFiles).not.toContain(`./test/${file}`);
      expect(await ciGateCommand(gate)).toContain(`./test/${file}`);
    }
    expect(await ciGateCommand("manufacturing-properties")).not.toContain(
      "./test/manufacturing-verify.test.ts",
    );
    expect(await ciGateCommand("manufacturing-verify")).not.toContain(
      "./test/manufacturing-properties.test.ts",
    );
    expect(await ciGateCommand("semantic-properties")).not.toContain(
      "./test/manufacturing-properties.test.ts",
    );
    expect(await ciGateCommand("semantic-properties")).not.toContain(
      "./test/manufacturing-verify.test.ts",
    );
  });

  test("assigns every uniquely named CLI integration case to exactly one fresh-process partition", async () => {
    const source = await readFile(join(root, "test", "cli.test.ts"), "utf8");
    const titles = extractCliTestTitles(source);
    const partitions = cliTestPartitions(titles);
    expect(partitions).toHaveLength(Math.ceil(titles.length / CLI_TESTS_PER_PARTITION_LIMIT));
    expect(partitions.flat().slice().sort()).toEqual([...titles].sort());
    expect(new Set(partitions.flat()).size).toBe(titles.length);
    expect(Math.max(...partitions.map(({ length }) => length))).toBeLessThanOrEqual(
      CLI_TESTS_PER_PARTITION_LIMIT,
    );
    expect(
      Math.max(...partitions.map(({ length }) => length)) -
        Math.min(...partitions.map(({ length }) => length)),
    ).toBeLessThanOrEqual(1);
    for (const partition of partitions) {
      const expression = new RegExp(cliTestPartitionPattern(partition), "u");
      expect(titles.filter((title) => expression.test(`PCBoo CLI ${title}`))).toEqual([...partition]);
    }
    expect(CLI_PARTITION_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(CLI_OVERALL_TIMEOUT_MS).toBeGreaterThan(CLI_PARTITION_TIMEOUT_MS);
    expect(REPOSITORY_TEST_PROCESS_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  test("rejects CLI declarations that could disappear from the syntax-aware inventory", () => {
    const accepted = `import { test } from 'bun:test';\ntest.skipIf(\n  process.platform === "win32"\n)(\n  'kept case',\n  () => {},\n);\n`;
    expect(extractCliTestTitles(accepted)).toEqual(["kept case"]);
    for (const declaration of [
      `test.only("focused", () => {});`,
      `test.skip("skipped", () => {});`,
      `test.todo("todo", () => {});`,
      `test["only"]("computed", () => {});`,
    ]) {
      expect(() => extractCliTestTitles(`import { test } from "bun:test";\n${declaration}\n`)).toThrow();
    }
    expect(() => extractCliTestTitles(
      `import { test as check } from "bun:test";\ncheck("alias", () => {});\n`,
    )).toThrow("aliased or alternate");
    expect(() => extractCliTestTitles(
      `import { it } from "bun:test";\nit("alternate", () => {});\n`,
    )).toThrow("aliased or alternate");
    expect(() => extractCliTestTitles(
      `import * as suite from "bun:test";\nsuite.test("namespace", () => {});\n`,
    )).toThrow("namespace-imported");
    expect(extractCliTestTitles(
      `import { test } from "bun:test";\nconst decoy = 'test("not real", () => {})';\n// test("comment", () => {});\ntest("real", () => {});\n`,
    )).toEqual(["real"]);
  });

  test("reconciles exact JUnit execution and fails empty or unexpected skipped files", () => {
    const junit = (body: string, tests: number, skipped: number) => new TextEncoder().encode(
      `<?xml version="1.0"?><testsuites tests="${tests}" failures="0" skipped="${skipped}" assertions="1">${body}</testsuites>`,
    );
    const executed = parseRepositoryTestJunit(junit(
      `<testcase name="runs" classname="suite" file="test/example.test.ts" assertions="1" />`, 1, 0,
    ));
    expect(() => requirePassingRepositoryTestReport(executed, ["./test/example.test.ts"]))
      .not.toThrow();
    expect(() => requirePassingRepositoryTestReport(
      parseRepositoryTestJunit(junit("", 0, 0)), ["./test/example.test.ts"],
    )).toThrow("zero tests");
    expect(() => requirePassingRepositoryTestReport(
      parseRepositoryTestJunit(junit(
        `<testcase name="hidden" classname="suite" file="test/example.test.ts"><skipped /></testcase>`, 1, 1,
      )), ["./test/example.test.ts"],
    )).toThrow("UNEXPECTED_SKIP");
    const duplicatedAllowedSkip = new TextEncoder().encode(
      `<?xml version="1.0"?><testsuites tests="2" failures="0" skipped="2" assertions="0">` +
      `<testcase name="a missing Windows target reports typed containment unavailability" classname="" file="test/contained-process.test.ts"><skipped /></testcase>` +
      `<testcase name="a missing Windows target reports typed containment unavailability" classname="" file="test/contained-process.test.ts"><skipped /></testcase>` +
      `</testsuites>`,
    );
    expect(() => requirePassingRepositoryTestReport(
      parseRepositoryTestJunit(duplicatedAllowedSkip), ["./test/contained-process.test.ts"],
    )).toThrow("UNEXPECTED_SKIP");
  });

  test("the authoritative preload rejects focused and skipped repository-test variants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcboo-repository-policy-"));
    try {
      for (const [name, declaration] of [
        ["only", `test.only("focused", () => {});`],
        ["skip", `test.skip("skipped", () => {});`],
        ["todo", `test.todo("todo");`],
        ["computed", `test["only"]("focused computed", () => {});`],
      ] as const) {
        const path = join(directory, `${name}.test.ts`);
        await writeFile(path, `import { test } from "bun:test";\n${declaration}\ntest("ordinary", () => {});\n`);
        const child = Bun.spawnSync({
          cmd: [
            process.execPath,
            "test",
            "--preload",
            join(root, "scripts", "repository-test-policy-preload.ts"),
            path,
          ],
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(child.exitCode, name).not.toBe(0);
        expect(new TextDecoder().decode(child.stderr), name).toContain(
          "PCBOO_REPOSITORY_TEST_POLICY_FORBIDDEN",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("discovers nested TSX tests in both conventional roots while excluding only exact heavy files", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "pcboo-regular-inventory-"));
    try {
      await mkdir(join(fixtureRoot, "test", "nested"), { recursive: true });
      await mkdir(join(fixtureRoot, "tests", "nested"), { recursive: true });
      await Promise.all([
        ...HEAVY_TEST_FILES.map((file) => writeFile(join(fixtureRoot, "test", file), "")),
        writeFile(join(fixtureRoot, "test", "nested", "critical.test.tsx"), ""),
        writeFile(join(fixtureRoot, "tests", "nested", "secondary.test.tsx"), ""),
      ]);
      expect(await discoverRegularTestFiles(join(fixtureRoot, "test"))).toEqual([
        "./test/nested/critical.test.tsx",
        "./tests/nested/secondary.test.tsx",
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("runs regular and memory-intensive qualification gates as separate measured processes", async () => {
    const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const requiredScripts = [
      "typecheck",
      "test:regular",
      "test:cli",
      "test:heavy:accept-tscircuit-upgrade",
      "test:heavy:artifact-manifest",
      "test:heavy:manufacturing-properties",
      "test:heavy:semantic-properties",
      "test:heavy:manufacturing-verify",
      "test:heavy:production-promotion",
      "test:heavy:scaffold",
      "test:heavy:server",
      "test:live:ngspice",
      "test:performance",
      "test:packed",
    ];
    for (const name of requiredScripts) {
      expect(metadata.scripts[name]).toContain("scripts/run-ci-gate.ts");
    }
    expect(metadata.scripts["test:cli"]).toBe("bun ./scripts/run-ci-gate.ts cli-integration");
    for (const gate of REGULAR_CI_GATE_NAMES) {
      expect(metadata.scripts["test:regular"]!.split(` ${gate}`).length - 1).toBe(1);
    }
    expect(metadata.scripts["test:regular"]).not.toContain(" run-regular-tests");
    expect(metadata.scripts.test).not.toBe("bun test");
    expect(metadata.scripts["performance:validate"]).toBe(
      "bun ./scripts/validate-performance-report.ts",
    );

    const workflowDirectory = await opendir(join(root, ".github/workflows"));
    const workflowEntries: string[] = [];
    for await (const entry of workflowDirectory) {
      expect(entry.isFile()).toBeTrue();
      workflowEntries.push(entry.name);
    }
    expect(workflowEntries.sort()).toEqual(["ci.yml"]);
    const workflowSource = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(new Bun.CryptoHasher("sha256").update(workflowSource).digest("hex")).toBe(
      "74e61cb4d3f153fd6c9c838fc01d25d76832f6df871acd6a7363f894a145c85d",
    );
    const workflow = Bun.YAML.parse(workflowSource) as {
      jobs: Record<string, {
        needs?: string | string[];
        "runs-on"?: string;
        "timeout-minutes"?: number;
        steps: WorkflowStep[];
      }>;
    };
    const qualificationRuns = workflow.jobs.test!.steps
      .map(({ run }) => run)
      .filter((run): run is string => run !== undefined);
    expect(qualificationRuns).toEqual([
      "bun install --frozen-lockfile",
      "bun run typecheck",
      "bun run test:regular",
      "bun run test:heavy:accept-tscircuit-upgrade",
      "bun run test:heavy:artifact-manifest",
      "bun run test:heavy:manufacturing-properties",
      "bun run test:heavy:semantic-properties",
      "bun run test:heavy:manufacturing-verify",
      "bun run test:heavy:production-promotion",
      "bun run test:heavy:scaffold",
      "bun run test:heavy:server",
      "bun run test:performance",
      "bun run performance:validate",
    ]);
    expect(qualificationRuns).not.toContain("bun test");
    const checkout = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
    const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
    const uploadArtifact = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
    const checkoutStep = (): WorkflowStep => ({ uses: checkout });
    const setupBunStep = (): WorkflowStep => ({ uses: setupBun, with: { "bun-version": "1.3.14" } });
    const expectedActionSteps: Readonly<Record<string, readonly WorkflowStep[]>> = Object.freeze({
      "unsupported-bun-boundary": Object.freeze([
        checkoutStep(), setupBunStep(), {
          uses: setupBun,
          with: { "bun-version": "1.3.13" },
        },
      ]),
      test: Object.freeze([
        checkoutStep(), setupBunStep(), {
          name: "Upload performance qualification",
          if: "${{ success() && steps.performance.outcome == 'success' && steps.performance_report.outcome == 'success' }}",
          uses: uploadArtifact,
          with: {
            name: "performance-${{ runner.os }}-${{ runner.arch }}",
            path: ".pcboo-ci/performance-*.json",
            "if-no-files-found": "error",
          },
        },
      ]),
      "cli-integration": Object.freeze([checkoutStep(), setupBunStep()]),
      "package-distribution": Object.freeze([checkoutStep(), setupBunStep()]),
      "runtime-evidence": Object.freeze([
        checkoutStep(), setupBunStep(), {
          name: "Upload exact runtime evidence",
          uses: uploadArtifact,
          with: {
            name: "tscircuit-runtime-darwin-arm64",
            path: ".pcboo-ci/tscircuit-runtime-darwin-arm64.json",
            "if-no-files-found": "error",
          },
        },
      ]),
      "ngspice-live": Object.freeze([
        checkoutStep(), setupBunStep(), {
          name: "Upload exact live qualification evidence",
          if: "success()",
          uses: uploadArtifact,
          with: {
            name: "ngspice-live-${{ runner.os }}-${{ runner.arch }}",
            path: ".pcboo-ci/ngspice-live-*",
            "if-no-files-found": "error",
          },
        },
      ]),
      "kicad-live": Object.freeze([
        checkoutStep(), setupBunStep(), {
          name: "Upload exact live KiCad evidence",
          if: "always()",
          uses: uploadArtifact,
          with: {
            name: "kicad-live-${{ runner.os }}-${{ runner.arch }}",
            path: ".pcboo-ci/kicad-live-darwin-arm64",
            "if-no-files-found": "error",
          },
        },
      ]),
    });
    expect(Object.keys(workflow.jobs).sort()).toEqual(Object.keys(expectedActionSteps).sort());
    for (const [name, expectedSteps] of Object.entries(expectedActionSteps)) {
      expect(workflow.jobs[name]!["runs-on"]).toBe("macos-15");
      expect(workflow.jobs[name]!.needs).toBeUndefined();
      const actionSteps = workflow.jobs[name]!.steps.filter(({ uses }) => uses !== undefined);
      expect(actionSteps).toEqual([...expectedSteps]);
    }
    expect(workflow.jobs.test!["timeout-minutes"]).toBeGreaterThanOrEqual(60);
    expect(workflow.jobs["unsupported-bun-boundary"]!.steps.map(({ run }) => run).filter(Boolean))
      .toContain("bun ./scripts/run-repository-test-gate.ts ./test/runtime-compatibility.test.ts");
    expect(workflow.jobs["cli-integration"]!.steps.map(({ run }) => run).filter(Boolean)).toEqual([
      "bun install --frozen-lockfile",
      "bun run test:cli",
    ]);
    expect(workflow.jobs["runtime-evidence-barrier"]).toBeUndefined();
    const performanceStep = workflow.jobs.test!.steps.find(({ id }) => id === "performance");
    const validationStep = workflow.jobs.test!.steps.find(({ id }) => id === "performance_report");
    expect(performanceStep?.run).toBe("bun run test:performance");
    expect(validationStep?.run).toBe("bun run performance:validate");
    const performanceUpload = workflow.jobs.test!.steps.find(({ name }) =>
      name === "Upload performance qualification"
    )!;
    expect(performanceUpload.uses).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(performanceUpload.with?.path).toBe(".pcboo-ci/performance-*.json");
    expect(performanceUpload.if).toContain("success()");
    expect(performanceUpload.if).toContain("steps.performance.outcome == 'success'");
    expect(performanceUpload.if).toContain("steps.performance_report.outcome == 'success'");
    const liveSteps = workflow.jobs["ngspice-live"]!.steps;
    expect(liveSteps.some(({ run }) => run?.includes("bun run test:live:ngspice"))).toBeTrue();
    expect(liveSteps.find(({ name }) => name === "Upload exact live qualification evidence")?.with?.path)
      .toBe(".pcboo-ci/ngspice-live-*");
    const kicadSteps = workflow.jobs["kicad-live"]!.steps;
    const installKicad = kicadSteps.find(({ name }) =>
      name === "Install exact official KiCad 10.0.5 distribution"
    );
    expect(installKicad?.env?.KICAD_DMG_SHA256).toBe(
      "9399e18609c6b94e708b375bb88455b94c55653ec427b81023d71ae42217d681",
    );
    expect(kicadSteps.some(({ run }) => run === "bun run test:live:kicad")).toBeTrue();
    expect(kicadSteps.find(({ name }) => name === "Upload exact live KiCad evidence")?.with?.path)
      .toBe(".pcboo-ci/kicad-live-darwin-arm64");

    const distributionRuns = workflow.jobs["package-distribution"]!.steps
      .map(({ run }) => run)
      .filter((run): run is string => run !== undefined);
    expect(distributionRuns[0]).toBe("bun install --frozen-lockfile");
    expect(distributionRuns.at(-1)).toBe("bun run test:packed");

  });
});
