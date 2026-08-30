import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "fulmetry-packed-e2e-"));
const emptyBunConfig = join(repositoryRoot, "src", "internal", "empty-bunfig.toml");

async function run(options: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly expectedExit?: number;
}): Promise<string> {
  const child = Bun.spawn([...options.command], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? "", TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const expectedExit = options.expectedExit ?? 0;
  if (exitCode !== expectedExit) {
    throw new Error(`${options.command.join(" ")} exited ${exitCode}, expected ${expectedExit}\n${stdout}\n${stderr}`);
  }
  return stdout;
}

function parseJsonOutput(stdout: string, command: string): Record<string, unknown> {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) throw new Error(`${command} did not emit JSON`);
  return JSON.parse(stdout.slice(jsonStart)) as Record<string, unknown>;
}

async function verifyDocumentedDevCommand(project: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "fulmetry", "dev", "--port", "0", "--json"], {
    cwd: project,
    env: { PATH: process.env.PATH ?? "", TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  // Packed command surfaces run serially in one cold harness and can leave the
  // machine under transient compiler/GC pressure before the dev process starts.
  const deadline = Date.now() + 60_000;
  try {
    let startup: Record<string, unknown> | undefined;
    while (startup === undefined && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fulmetry dev startup timed out")), remaining)),
      ]);
      if (next.done) throw new Error("fulmetry dev exited before emitting startup JSON");
      stdout += decoder.decode(next.value, { stream: true });
      try {
        startup = parseJsonOutput(stdout, "bun run fulmetry dev --port 0 --json");
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (startup === undefined || typeof startup.url !== "string") {
      throw new Error("fulmetry dev did not emit a bounded startup URL");
    }
    const response = await fetch(new URL("/api/project", startup.url));
    if (response.status !== 200) {
      throw new Error(`Documented dev server returned HTTP ${response.status} for /api/project`);
    }
    const projectResult = await response.json() as { schemaVersion?: unknown; project?: unknown };
    if (projectResult.schemaVersion !== 1 || projectResult.project === undefined) {
      throw new Error("Documented dev server returned an invalid project response");
    }
  } finally {
    reader.releaseLock();
    child.kill();
    const stopped = await Promise.race([
      child.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!stopped) {
      child.kill(9);
      await child.exited;
    }
  }
}

try {
  const packages = join(temporaryRoot, "packages");
  await mkdir(packages);
  const frameworkVersion = (JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { version: string }).version;
  const creatorVersion = (JSON.parse(await readFile(join(repositoryRoot, "packages/create-fulmetry/package.json"), "utf8")) as { version: string }).version;
  const fulmetryTarball = join(packages, `fulmetry-${frameworkVersion}.tgz`);
  const creatorTarball = join(packages, `create-fulmetry-${creatorVersion}.tgz`);
  const harnessFulmetryReference = `file:../packages/fulmetry-${frameworkVersion}.tgz`;
  const creatorTarballReference = `file:../packages/create-fulmetry-${creatorVersion}.tgz`;
  await run({ command: [process.execPath, "pm", "pack", "--filename", fulmetryTarball, "--quiet"], cwd: repositoryRoot });
  await run({ command: [process.execPath, "pm", "pack", "--destination", packages, "--quiet"], cwd: join(repositoryRoot, "packages/create-fulmetry") });

  const harness = join(temporaryRoot, "harness");
  await mkdir(harness);
  await writeFile(join(harness, "package.json"), `${JSON.stringify({
    name: "fulmetry-packed-e2e-harness",
    private: true,
    dependencies: {
      fulmetry: harnessFulmetryReference,
      "create-fulmetry": creatorTarballReference,
      tscircuit: "0.0.2261",
    },
  }, null, 2)}\n`);
  await run({ command: [
    process.execPath, `--config=${emptyBunConfig}`, "--no-env-file", "install", "--ignore-scripts",
    "--linker=hoisted", "--backend=copyfile",
  ], cwd: harness });
  await run({ command: [process.execPath, join(harness, "node_modules/create-fulmetry/src/cli.ts"), "board", "--no-install"], cwd: harness });

  const project = join(harness, "board");
  for (const skillPath of [
    ".agents/skills/fulmetry-best-practices/SKILL.md",
    ".agents/skills/fulmetry-design/SKILL.md",
    ".agents/skills/fulmetry-diagnose/SKILL.md",
    ".agents/skills/fulmetry-manufacturing/SKILL.md",
    ".agents/skills/fulmetry-resolve-models/SKILL.md",
    ".agents/skills/fulmetry-resolve-models/scripts/audit-cad-models.ts",
    ".agents/skills/fulmetry-verify/SKILL.md",
    ".agents/skills/fulmetry-design/references/completion-and-preview.md",
    ".claude/skills/fulmetry-best-practices/SKILL.md",
    ".claude/skills/fulmetry-resolve-models/SKILL.md",
    ".claude/skills/fulmetry-design/references/completion-and-preview.md",
  ]) {
    const skill = await lstat(join(project, ...skillPath.split("/")));
    if (!skill.isFile() || skill.isSymbolicLink()) {
      throw new Error(`Packed creator omitted a regular copied Agent Skill: ${skillPath}`);
    }
  }
  const projectPackage = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  projectPackage.dependencies.fulmetry = `file:../../packages/fulmetry-${frameworkVersion}.tgz`;
  await writeFile(join(project, "package.json"), `${JSON.stringify(projectPackage, null, 2)}\n`);
  await run({ command: [
    process.execPath, "--no-env-file", "install",
  ], cwd: project });
  if (process.env.FULMETRY_PACKED_CONSUMER_ROOT_OUTPUT !== undefined) {
    // Qualification retains the real generated Fulmetry project, not the outer
    // creator harness. It remains under the same authority root as its tarball.
    await writeFile(process.env.FULMETRY_PACKED_CONSUMER_ROOT_OUTPUT, `${project}\n`, { flag: "wx" });
  }
  if (process.env.FULMETRY_PACKED_PREPARE_ONLY === "1") {
    if (process.env.FULMETRY_PACKED_CONSUMER_ROOT_OUTPUT === undefined) {
      throw new Error("FULMETRY_PACKED_PREPARE_ONLY requires FULMETRY_PACKED_CONSUMER_ROOT_OUTPUT");
    }
    process.stdout.write("Prepared physically separate packed consumer for runtime qualification.\n");
    process.exit(0);
  }
  const help = await run({ command: [process.execPath, "run", "fulmetry", "help"], cwd: project });
  if (!help.includes("fulmetry verify manufacturing")) {
    throw new Error("Packed help omitted the documented manufacturing command");
  }
  await run({ command: [process.execPath, "run", "fulmetry", "build", "--json"], cwd: project });
  const check = await run({ command: [process.execPath, "run", "fulmetry", "check", "--json"], cwd: project, expectedExit: 3 });
  const report = parseJsonOutput(check, "bun run fulmetry check --json") as {
    statuses?: { electrical?: { state?: unknown }; fabrication?: { state?: unknown } };
    diagnostics?: Array<{ id?: unknown }>;
  };
  if (report.statuses?.electrical?.state !== "passed" || report.statuses.fabrication?.state !== "incomplete") {
    throw new Error("Packed project did not preserve independent electrical/fabrication status semantics");
  }
  if (JSON.stringify(report.diagnostics?.map(({ id }) => id)) !== JSON.stringify(["FAB_ARTIFACT_VERIFICATION_NOT_RUN_001"])) {
    throw new Error("Packed project emitted unexpected starter-project diagnostics");
  }
  const inspect = parseJsonOutput(await run({
    command: [process.execPath, "run", "fulmetry", "inspect", "--status", "fabrication", "--json"],
    cwd: project,
    expectedExit: 3,
  }), "bun run fulmetry inspect --status fabrication --json") as {
    requestedDimensions?: unknown;
    statuses?: { fabrication?: { state?: unknown } };
  };
  if (
    JSON.stringify(inspect.requestedDimensions) !== JSON.stringify(["fabrication"]) ||
    inspect.statuses?.fabrication?.state !== "incomplete"
  ) throw new Error("Packed inspect did not preserve its focused fabrication outcome");
  const projectTest = parseJsonOutput(await run({
    command: [process.execPath, "run", "fulmetry", "test", "--json"],
    cwd: project,
  }), "bun run fulmetry test --json") as {
    exitClassification?: unknown;
    statuses?: { functional?: { state?: unknown } };
  };
  if (
    projectTest.exitClassification !== "success" ||
    projectTest.statuses?.functional?.state !== "passed"
  ) throw new Error("Packed Fulmetry test command did not execute the generated project test");
  const kicad = parseJsonOutput(await run({
    command: [process.execPath, "run", "fulmetry", "export", "kicad", "--json"],
    cwd: project,
    expectedExit: 3,
  }), "bun run fulmetry export kicad --json") as { exitClassification?: unknown; artifacts?: Array<{ kind?: unknown }> };
  if (
    kicad.exitClassification !== "incomplete" ||
    !kicad.artifacts?.some(({ kind }) => kind === "kicad-handoff-report")
  ) throw new Error("Packed KiCad command did not emit an honest detached handoff report");
  const gerbers = parseJsonOutput(await run({
    command: [process.execPath, "run", "fulmetry", "export", "gerbers", "--offline", "--json"],
    cwd: project,
    expectedExit: 3,
  }), "bun run fulmetry export gerbers --offline --json") as {
    exitClassification?: unknown;
    project?: { networkPolicy?: unknown };
    artifacts?: Array<{ kind?: unknown }>;
  };
  if (
    gerbers.exitClassification !== "incomplete" ||
    gerbers.project?.networkPolicy !== "offline" ||
    !gerbers.artifacts?.some(({ kind }) => kind === "draft-artifact-manifest") ||
    gerbers.artifacts?.some(({ kind }) => String(kind).includes("verified"))
  ) throw new Error("Packed Gerber command did not preserve its offline draft-only boundary");
  const manufacturing = parseJsonOutput(await run({
    command: [process.execPath, "run", "fulmetry", "verify", "manufacturing", "--json"],
    cwd: project,
    expectedExit: 1,
  }), "bun run fulmetry verify manufacturing --json") as {
    exitClassification?: unknown;
    statuses?: {
      fabrication?: { state?: unknown };
      electrical?: { state?: unknown };
      standards?: { state?: unknown };
      sourcing?: { state?: unknown };
    };
    diagnostics?: Array<{ id?: unknown }>;
    artifacts?: Array<{ kind?: unknown }>;
  };
  if (
    manufacturing.exitClassification !== "failure" ||
    manufacturing.statuses?.fabrication?.state !== "failed" ||
    manufacturing.statuses?.electrical?.state !== "passed" ||
    manufacturing.statuses?.standards?.state !== "failed" ||
    manufacturing.statuses?.sourcing?.state !== "unchecked" ||
    !manufacturing.diagnostics?.some(({ id }) => id === "MFG_MANUFACTURING_UNSUPPORTED_001") ||
    !manufacturing.artifacts?.some(({ kind }) => kind === "draft-manufacturing") ||
    !manufacturing.artifacts?.some(({ kind }) => kind === "standards-evidence") ||
    !manufacturing.artifacts?.some(({ kind }) => kind === "sourcing-evidence") ||
    manufacturing.artifacts?.some(({ kind }) => String(kind).includes("verified"))
  ) throw new Error("Packed manufacturing command did not preserve the starter fixture's honest draft-only failure");
  await verifyDocumentedDevCommand(project);
  await run({ command: [process.execPath, "run", "test"], cwd: project });
  process.stdout.write("Packed creator, install, all documented command surfaces, and generated test passed.\n");
} finally {
  if (process.env.FULMETRY_PACKED_CONSUMER_ROOT_OUTPUT === undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
