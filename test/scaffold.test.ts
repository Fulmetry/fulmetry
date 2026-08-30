import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCreateArguments } from "../packages/create-fulmetry/src/cli";
import { scaffoldFulmetryProject } from "../packages/create-fulmetry/src/scaffold";
import { runCli } from "../src/cli/runner";
import { loadFulmetryLock, SUPPORTED_TSCIRCUIT_VERSION } from "../src/project/lock";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("create-fulmetry scaffold", () => {
  test("keeps creator and framework release versions identical", async () => {
    const [framework, creator] = await Promise.all([
      Bun.file(join(import.meta.dir, "../package.json")).json() as Promise<{ version: string; packageManager: string; engines: { bun: string } }>,
      Bun.file(join(import.meta.dir, "../packages/create-fulmetry/package.json")).json() as Promise<{ version: string; engines: { bun: string } }>,
    ]);
    expect(creator.version).toBe(framework.version);
    expect(framework.packageManager).toBe("bun@1.3.14");
    expect(framework.engines.bun).toBe("1.3.14");
    expect(creator.engines.bun).toBe("1.3.14");
    expect(Bun.version).toBe("1.3.14");
  });

  test("parses one bounded non-interactive invocation", () => {
    expect(parseCreateArguments([])).toEqual({ directory: "fulmetry-project", install: true, skills: true });
    expect(parseCreateArguments(["my-board", "--no-install", "--no-skills"])).toEqual({
      directory: "my-board",
      install: false,
      skills: false,
    });
    expect(() => parseCreateArguments(["a", "b"])).toThrow("at most one");
    expect(() => parseCreateArguments(["--force"])).toThrow("Unknown option");
  });

  test("creates a multi-file project with exclusive publication and no generated output", async () => {
    const parent = await mkdtemp(join(tmpdir(), "create-fulmetry-"));
    roots.push(parent);
    const result = await scaffoldFulmetryProject({ cwd: parent, directory: "agent-board", install: false });
    expect(result.files).toContain("circuit/components/power-indicator.ts");
    expect(result.files).toContain("AGENTS.md");
    expect(result.files).toContain(".agents/skills/fulmetry-best-practices/SKILL.md");
    expect(result.files).toContain(".claude/skills/fulmetry-best-practices/SKILL.md");
    expect(result.files).toContain(".agents/skills/fulmetry-design/references/completion-and-preview.md");
    expect(result.files).toContain(".claude/skills/fulmetry-design/references/completion-and-preview.md");
    expect(result.files).toContain(".agents/skills/fulmetry-resolve-models/scripts/audit-cad-models.ts");
    expect(result.files).toContain(".claude/skills/fulmetry-resolve-models/scripts/audit-cad-models.ts");
    expect(await readFile(join(result.root, ".agents/skills/fulmetry-design/SKILL.md"), "utf8"))
      .toBe(await readFile(join(result.root, ".claude/skills/fulmetry-design/SKILL.md"), "utf8"));
    const designSkill = await readFile(join(result.root, ".agents/skills/fulmetry-design/SKILL.md"), "utf8");
    const completionGate = await readFile(
      join(result.root, ".agents/skills/fulmetry-design/references/completion-and-preview.md"),
      "utf8",
    );
    expect(designSkill).toContain("create a circuit` means completing both the logical circuit and its physical PCB representation");
    expect(designSkill).toContain("Only after the completion gate and `fulmetry-resolve-models` audit pass, start `bun run dev`");
    expect(completionGate).toContain("zero `pcb_missing_footprint_error` records");
    expect(completionGate).toContain("logical connectivity with zero PCB traces is incomplete");
    expect(completionGate).toContain("Leave the server running");
    expect(await readFile(join(result.root, ".claude/skills/fulmetry-design/references/completion-and-preview.md"), "utf8"))
      .toBe(completionGate);
    expect(await readFile(join(result.root, "AGENTS.md"), "utf8"))
      .toContain("Start bun run dev as the final handoff only after");
    expect(await readFile(join(result.root, "AGENTS.md"), "utf8"))
      .toContain("Before any final browser preview, load fulmetry-resolve-models");
    expect((await lstat(join(result.root, ".agents/skills/fulmetry-design"))).isDirectory()).toBeTrue();
    expect((await lstat(join(result.root, ".claude/skills/fulmetry-design"))).isDirectory()).toBeTrue();
    expect(await readFile(join(result.root, "bunfig.toml"), "utf8").then((text) => text.trim())).toBe(
      '[install]\nlinker = "hoisted"\nbackend = "copyfile"',
    );
    expect(await Bun.file(join(result.root, ".fulmetry")).exists()).toBeFalse();
    const generatedLock = await loadFulmetryLock(result.root);
    expect(generatedLock.tscircuit.version).toBe(SUPPORTED_TSCIRCUIT_VERSION);
    expect(generatedLock.sourcing).toEqual({
      schemaVersion: 1,
      policy: null,
      selections: {},
    });
    expect(JSON.parse(await readFile(join(result.root, "package.json"), "utf8"))).toMatchObject({
      name: "agent-board",
      private: true,
      packageManager: "bun@1.3.14",
      engines: { bun: "1.3.14" },
      scripts: { "export:gerbers": "fulmetry export gerbers" },
      dependencies: { fulmetry: "npm:fulmetry@0.2.0", tscircuit: SUPPORTED_TSCIRCUIT_VERSION },
      devDependencies: { "@types/bun": "1.3.14", "@types/node": "24.13.3" },
      overrides: { "@tscircuit/cli": "0.1.1858", "bun-match-svg": "0.0.15", "bun-types": "1.3.14" },
      trustedDependencies: [],
    });
    await expect(scaffoldFulmetryProject({ cwd: parent, directory: "agent-board", install: false })).rejects.toThrow("Refusing to overwrite");
  });

  test("can omit all agent skills without changing runtime dependencies", async () => {
    const parent = await mkdtemp(join(tmpdir(), "create-fulmetry-no-skills-"));
    roots.push(parent);
    const result = await scaffoldFulmetryProject({ cwd: parent, directory: "human-board", install: false, skills: false });
    expect(result.files.some((path) => path.startsWith(".agents/skills/"))).toBeFalse();
    expect(result.files.some((path) => path.startsWith(".claude/skills/"))).toBeFalse();
    expect(await Bun.file(join(result.root, ".agents")).exists()).toBeFalse();
    expect(await Bun.file(join(result.root, ".claude")).exists()).toBeFalse();
    expect(await readFile(join(result.root, "AGENTS.md"), "utf8")).not.toContain("Project-local Fulmetry skills");
    expect(await readFile(join(result.root, "README.md"), "utf8")).not.toContain("Project-local Agent Skills");
    expect(JSON.parse(await readFile(join(result.root, "package.json"), "utf8")).dependencies).toEqual({
      fulmetry: "npm:fulmetry@0.2.0",
      tscircuit: SUPPORTED_TSCIRCUIT_VERSION,
    });
  });

  test("the generated source builds and checks through the real Fulmetry command", async () => {
    const parent = await mkdtemp(join(tmpdir(), "create-fulmetry-build-"));
    roots.push(parent);
    const result = await scaffoldFulmetryProject({ cwd: parent, directory: "buildable", install: false });
    const nodeModules = join(result.root, "node_modules");
    await mkdir(nodeModules);
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(import.meta.dir, ".."), join(nodeModules, "fulmetry"), directoryLinkType);
    await symlink(join(import.meta.dir, "../node_modules/tscircuit"), join(nodeModules, "tscircuit"), directoryLinkType);
    const run = await runCli({ argv: ["build"], cwd: result.root, runId: "scaffold-build" });
    expect(run.exitCode, JSON.stringify(run.result?.diagnostics, null, 2)).toBe(0);
    const circuit = JSON.parse(await Bun.file(join(run.runDirectory!, "circuit.json")).text()) as Array<{ type: string }>;
    expect(circuit.filter(({ type }) => type === "pcb_board")).toHaveLength(1);
    const checked = await runCli({ argv: ["check"], cwd: result.root, runId: "scaffold-check" });
    expect(checked.result?.statuses.electrical.state).toBe("passed");
    expect(checked.result?.statuses.fabrication.state).toBe("incomplete");
    expect(checked.result?.diagnostics.map(({ id }) => String(id))).toEqual(["FAB_ARTIFACT_VERIFICATION_NOT_RUN_001"]);
    const exported = await runCli({
      argv: ["export", "gerbers", "--offline"],
      cwd: result.root,
      runId: "scaffold-gerber-draft",
    });
    expect(exported.exitCode).toBe(3);
    expect(exported.result?.statuses.fabrication.state).toBe("incomplete");
    expect(exported.result?.artifacts.some(({ kind }) => kind === "draft-artifact-manifest"))
      .toBeTrue();
  }, 120_000);

  test("the generated standard Bun test executes through the bounded Fulmetry command", async () => {
    const parent = await mkdtemp(join(tmpdir(), "create-fulmetry-test-"));
    roots.push(parent);
    const result = await scaffoldFulmetryProject({ cwd: parent, directory: "testable", install: false });
    const nodeModules = join(result.root, "node_modules");
    await mkdir(nodeModules);
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(import.meta.dir, ".."), join(nodeModules, "fulmetry"), directoryLinkType);
    await symlink(join(import.meta.dir, "../node_modules/tscircuit"), join(nodeModules, "tscircuit"), directoryLinkType);
    const tested = await runCli({ argv: ["test"], cwd: result.root, runId: "scaffold-test" });
    expect(tested.exitCode, JSON.stringify(tested.result?.diagnostics, null, 2)).toBe(0);
    expect(tested.result?.statuses.functional.state).toBe("passed");
    expect(tested.result?.artifacts.map(({ kind }) => kind).sort()).toEqual([
      "project-test-junit",
      "project-test-stderr",
      "project-test-stdout",
      "project-test-summary",
    ]);
  }, 120_000);

  test("preserves a destination created by a concurrent process", async () => {
    const parent = await mkdtemp(join(tmpdir(), "create-fulmetry-race-"));
    roots.push(parent);
    const target = join(parent, "raced");
    let reachedCommit!: () => void;
    let releaseCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve; });
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const pending = scaffoldFulmetryProject({
      cwd: parent,
      directory: "raced",
      install: false,
      beforeCommit: async () => {
        reachedCommit();
        await commitGate;
      },
    });
    await atCommit;
    await mkdir(target);
    await Bun.write(join(target, "owned-by-another-process.txt"), "preserve me\n");
    releaseCommit();
    let rejected = false;
    try {
      await pending;
    } catch (error) {
      rejected = true;
      expect((error as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
    expect(rejected).toBeTrue();
    expect(await Bun.file(join(target, "owned-by-another-process.txt")).text()).toBe("preserve me\n");
  }, 15_000);

  test("rejects a symlinked destination ancestor without writing outside cwd", async () => {
    const parent = await mkdtemp(join(tmpdir(), "create-fulmetry-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "create-fulmetry-outside-"));
    roots.push(parent, outside);
    await symlink(outside, join(parent, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(scaffoldFulmetryProject({ cwd: parent, directory: "escape/board", install: false })).rejects.toThrow("cannot traverse symlink");
    expect(await Bun.file(join(outside, "board")).exists()).toBeFalse();
  });
});
