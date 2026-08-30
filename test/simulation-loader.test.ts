import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildInputSnapshot } from "../src/artifacts/inputs";
import { digestProjectInputs } from "../src/project/input-digest";
import { captureProjectTestInputAuthority } from "../src/project-tests";
import {
  discoverSimulationNames,
  authenticateSimulationDefinitionAuthority,
  loadSimulationDefinition,
  parseSimulationDefinition,
  SIMULATION_DEFINITION_LIMIT,
} from "../src/simulation";
import {
  PROJECT_INPUT_DEPTH_LIMIT,
  PROJECT_INPUT_ENTRY_LIMIT,
  PROJECT_INPUT_FILE_BYTES_LIMIT,
  PROJECT_INPUT_FILE_LIMIT,
  PROJECT_INPUT_TOTAL_BYTES_LIMIT,
} from "../src/project/input-limits";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("simulation filesystem authority", () => {
  async function createDigestProject(prefix: string): Promise<string> {
    const project = await temporaryRoot(prefix);
    await mkdir(join(project, "src"));
    await Bun.write(join(project, "src", "board.ts"), "export default []\n");
    await Bun.write(
      join(project, "fulmetry.config.ts"),
      "export default { entry: 'src/board.ts' }\n",
    );
    await Bun.write(join(project, "fulmetry.lock"), "{}\n");
    return project;
  }

  test("excludes only the exact nested output directory and authenticates its siblings", async () => {
    const project = await temporaryRoot("fulmetry-nested-output-project-");
    await mkdir(join(project, "src"));
    await mkdir(join(project, "simulations"));
    await mkdir(join(project, "models"));
    await mkdir(join(project, "generated", "fulmetry"), { recursive: true });
    await Bun.write(join(project, "src", "board.ts"), "export default []\n");
    await Bun.write(join(project, "fulmetry.config.ts"), "export default { entry: 'src/board.ts', outputDirectory: 'generated/fulmetry' }\n");
    await Bun.write(join(project, "fulmetry.lock"), "{}\n");
    await Bun.write(join(project, "generated", "authority.json"), "{\"revision\":1}\n");
    await Bun.write(join(project, "generated", "fulmetry", "derived.json"), "{\"ignored\":1}\n");

    const before = await digestProjectInputs({
      projectRoot: project,
      entry: "src/board.ts",
      outputDirectory: "generated/fulmetry",
      profiles: [],
    });
    expect(before.inputPaths).toContain("generated/authority.json");
    expect(before.inputPaths).not.toContain("generated/fulmetry/derived.json");

    await Bun.write(join(project, "generated", "authority.json"), "{\"revision\":2}\n");
    const afterSiblingChange = await digestProjectInputs({
      projectRoot: project,
      entry: "src/board.ts",
      outputDirectory: "generated/fulmetry",
      profiles: [],
    });
    expect(afterSiblingChange.projectDigest).not.toBe(before.projectDigest);

    await Bun.write(join(project, "generated", "fulmetry", "derived.json"), "{\"ignored\":2}\n");
    const afterOutputChange = await digestProjectInputs({
      projectRoot: project,
      entry: "src/board.ts",
      outputDirectory: "generated/fulmetry",
      profiles: [],
    });
    expect(afterOutputChange.projectDigest).toBe(afterSiblingChange.projectDigest);
  });

  test("rejects a top-level simulations directory symlink for discovery and loading", async () => {
    const project = await temporaryRoot("fulmetry-simulation-project-");
    const external = await temporaryRoot("fulmetry-simulation-external-");
    await Bun.write(join(external, "external.testbench.ts"), "export default {}\n");
    await symlink(external, join(project, "simulations"), process.platform === "win32" ? "junction" : "dir");

    await expect(discoverSimulationNames(project)).rejects.toThrow("non-symlinked");
    await expect(loadSimulationDefinition({ projectRoot: project, name: "external" }))
      .rejects.toThrow("non-symlinked");
  });

  test("rejects a top-level models directory symlink before digest traversal", async () => {
    const project = await temporaryRoot("fulmetry-model-project-");
    const external = await temporaryRoot("fulmetry-model-external-");
    await mkdir(join(project, "src"));
    await mkdir(join(project, "simulations"));
    await Bun.write(join(project, "src", "board.ts"), "export default []\n");
    await Bun.write(join(project, "fulmetry.config.ts"), "export default { entry: 'src/board.ts' }\n");
    await Bun.write(join(project, "fulmetry.lock"), "{}\n");
    await Bun.write(join(external, "outside.model"), ".model outside R\n");
    await symlink(external, join(project, "models"), process.platform === "win32" ? "junction" : "dir");

    await expect(digestProjectInputs({ projectRoot: project, entry: "src/board.ts", profiles: [] }))
      .rejects.toThrow("models input directory must be a regular non-symlinked");
  });

  test("binds loader authority to exact testbench semantics and snapshot bytes", async () => {
    const project = await createDigestProject("fulmetry-simulation-definition-authority-");
    await mkdir(join(project, "simulations"));
    const raw = {
      schemaVersion: 1,
      name: "bound",
      region: { componentIds: ["R1"], netIds: ["VOUT", "GND"] },
      models: [],
      stimuli: [{
        kind: "voltage", sourceId: "VIN", positiveNode: "VOUT", negativeNode: "GND",
        unit: "V", dcValue: 2.5, ac: null, transient: null,
      }],
      solver: { engine: "ngspice" },
      analysis: { kind: "operating-point" },
      assertions: [{
        expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } },
        sample: { kind: "last" }, unit: "V", expected: 2.5,
        absoluteTolerance: 0.001, relativeTolerance: 0,
      }],
      timeoutMs: 5_000,
    };
    const testbenchPath = join(project, "simulations/bound.testbench.ts");
    const helperPath = join(project, "simulations/bound-definition.ts");
    await Bun.write(helperPath, `export default ${JSON.stringify(raw)}\n`);
    await Bun.write(testbenchPath, 'import definition from "./bound-definition"; export default definition\n');
    const originalGet = WeakMap.prototype.get;
    const originalSet = WeakMap.prototype.set;
    let intercepted = false;
    let loaded: Awaited<ReturnType<typeof loadSimulationDefinition>>;
    try {
      WeakMap.prototype.get = (() => undefined) as typeof WeakMap.prototype.get;
      WeakMap.prototype.set = function(this: WeakMap<object, unknown>, key: object, value: unknown) {
        intercepted = true;
        return originalSet.call(this, key, value);
      } as typeof WeakMap.prototype.set;
      loaded = await loadSimulationDefinition({ projectRoot: project, name: "bound" });
    } finally {
      WeakMap.prototype.get = originalGet;
      WeakMap.prototype.set = originalSet;
    }
    expect(intercepted).toBeFalse();
    const snapshot = await createBuildInputSnapshot({
      projectRoot: project,
      inputs: [
        { path: "src/board.ts", role: "source" },
        { path: "fulmetry.config.ts", role: "config" },
        { path: "fulmetry.lock", role: "lockfile" },
        { path: "simulations/bound-definition.ts", role: "test" },
        { path: "simulations/bound.testbench.ts", role: "test" },
      ],
    });
    let authenticated;
    try {
      WeakMap.prototype.get = (() => undefined) as typeof WeakMap.prototype.get;
      authenticated = await authenticateSimulationDefinitionAuthority(loaded.authority, {
        projectRoot: project,
        definition: loaded.definition,
        inputSnapshot: snapshot,
      });
    } finally {
      WeakMap.prototype.get = originalGet;
    }
    expect(authenticated?.path).toBe("simulations/bound.testbench.ts");

    const substituted = structuredClone(raw);
    substituted.assertions[0]!.expected = 5;
    expect(await authenticateSimulationDefinitionAuthority(loaded.authority, {
      projectRoot: project,
      definition: parseSimulationDefinition(substituted),
      inputSnapshot: snapshot,
    })).toBeUndefined();

    await Bun.write(helperPath, `export default ${JSON.stringify(substituted)}\n`);
    const changedSnapshot = await createBuildInputSnapshot({
      projectRoot: project,
      inputs: snapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    expect(await authenticateSimulationDefinitionAuthority(loaded.authority, {
      projectRoot: project,
      definition: loaded.definition,
      inputSnapshot: changedSnapshot,
    })).toBeUndefined();

    const cleanHelper = `export default ${JSON.stringify(raw)}\n`;
    const changedHelper = `export default ${JSON.stringify(substituted)}\n`;
    await Bun.write(helperPath, cleanHelper);
    const originalSpawn = Bun.spawn;
    let evaluationCount = 0;
    try {
      Bun.spawn = ((...arguments_: Parameters<typeof Bun.spawn>) => {
        evaluationCount += 1;
        if (evaluationCount === 1) writeFileSync(helperPath, changedHelper);
        const child = originalSpawn(...arguments_);
        if (evaluationCount !== 2) return child;
        const exited = child.exited.then((code) => {
          writeFileSync(helperPath, cleanHelper);
          return code;
        });
        return new Proxy(child, {
          get(target, property) {
            return property === "exited" ? exited : Reflect.get(target, property, target);
          },
        });
      }) as typeof Bun.spawn;
      await expect(loadSimulationDefinition({ projectRoot: project, name: "bound" }))
        .rejects.toThrow("source graph changed while its authority was captured");
    } finally {
      Bun.spawn = originalSpawn;
      await Bun.write(helperPath, cleanHelper);
    }
    expect(evaluationCount).toBe(2);
  });

  test("rejects a nested directory swapped to a symlink during recursive digest traversal", async () => {
    const project = await temporaryRoot("fulmetry-nested-model-project-");
    const external = await temporaryRoot("fulmetry-nested-model-external-");
    await mkdir(join(project, "src"));
    await mkdir(join(project, "simulations"));
    await mkdir(join(project, "models"));
    await Bun.write(join(project, "src", "board.ts"), "export default []\n");
    await Bun.write(join(project, "fulmetry.config.ts"), "export default { entry: 'src/board.ts' }\n");
    await Bun.write(join(project, "fulmetry.lock"), "{}\n");
    await Bun.write(join(external, "outside.model"), ".model outside R\n");
    await symlink(external, join(project, "models", "nested"), process.platform === "win32" ? "junction" : "dir");

    await expect(digestProjectInputs({ projectRoot: project, entry: "src/board.ts", profiles: [] }))
      .rejects.toThrow("models/nested input entry must not be a symlink");
  });

  test("rejects a sparse authoritative file above the per-file input limit before reading it", async () => {
    const project = await createDigestProject("fulmetry-oversized-project-input-");
    const oversized = join(project, "oversized.bin");
    await Bun.write(oversized, "");
    await truncate(oversized, PROJECT_INPUT_FILE_BYTES_LIMIT + 1);

    await expect(digestProjectInputs({ projectRoot: project, entry: "src/board.ts", profiles: [] }))
      .rejects.toThrow(`${PROJECT_INPUT_FILE_BYTES_LIMIT}-byte per-file limit`);
  });

  test("rejects aggregate sparse authoritative inputs above the project byte limit", async () => {
    const project = await createDigestProject("fulmetry-aggregate-project-input-");
    const chunkSize = Math.floor(PROJECT_INPUT_TOTAL_BYTES_LIMIT / 9) + 1;
    for (let index = 0; index < 9; index += 1) {
      const path = join(project, `aggregate-${index}.bin`);
      await Bun.write(path, "");
      await truncate(path, chunkSize);
    }

    await expect(digestProjectInputs({ projectRoot: project, entry: "src/board.ts", profiles: [] }))
      .rejects.toThrow(`${PROJECT_INPUT_TOTAL_BYTES_LIMIT}-byte aggregate limit`);
  });

  test("rejects project input inventories above the explicit file-count limit", async () => {
    const project = await createDigestProject("fulmetry-file-count-project-input-");
    const fixtureRoot = join(project, "fixtures");
    await mkdir(fixtureRoot);
    const requiredProjectFiles = 3;
    const fixtureCount = PROJECT_INPUT_FILE_LIMIT - requiredProjectFiles + 1;
    for (let start = 0; start < fixtureCount; start += 250) {
      await Promise.all(Array.from(
        { length: Math.min(250, fixtureCount - start) },
        (_, offset) => Bun.write(join(fixtureRoot, `${start + offset}.txt`), ""),
      ));
    }

    await expect(digestProjectInputs({ projectRoot: project, entry: "src/board.ts", profiles: [] }))
      .rejects.toThrow(`more than ${PROJECT_INPUT_FILE_LIMIT} input files`);
  }, 30_000);

  test("rejects project input traversal above the explicit directory-depth limit", async () => {
    const project = await createDigestProject("fulmetry-depth-project-input-");
    let directory = project;
    for (let depth = 0; depth <= PROJECT_INPUT_DEPTH_LIMIT; depth += 1) {
      directory = join(directory, "d");
      await mkdir(directory);
    }
    await Bun.write(join(directory, "fixture.txt"), "deep\n");

    await expect(digestProjectInputs({ projectRoot: project, entry: "src/board.ts", profiles: [] }))
      .rejects.toThrow(`${PROJECT_INPUT_DEPTH_LIMIT}-directory depth limit`);
  });

  test("rejects a broad tree of empty directories at the shared traversal-entry limit", async () => {
    const project = await createDigestProject("fulmetry-entry-count-project-input-");
    const fixtureRoot = join(project, "empty-directories");
    await mkdir(fixtureRoot);
    const directoryCount = PROJECT_INPUT_ENTRY_LIMIT + 1;
    for (let start = 0; start < directoryCount; start += 250) {
      await Promise.all(Array.from(
        { length: Math.min(250, directoryCount - start) },
        (_, offset) => mkdir(join(fixtureRoot, `d-${start + offset}`)),
      ));
    }

    await expect(digestProjectInputs({ projectRoot: project, entry: "src/board.ts", profiles: [] }))
      .rejects.toThrow(`traversal exceeds ${PROJECT_INPUT_ENTRY_LIMIT} entries`);
    await expect(captureProjectTestInputAuthority({
      projectRoot: project,
      outputDirectory: ".fulmetry",
    })).rejects.toThrow(`Project test traversal exceeds ${PROJECT_INPUT_ENTRY_LIMIT} entries`);
  }, 30_000);

  test("caps the number of named simulation definitions before evaluating them", async () => {
    const project = await createDigestProject("fulmetry-simulation-count-project-input-");
    await mkdir(join(project, "simulations"));
    for (let index = 0; index <= SIMULATION_DEFINITION_LIMIT; index += 1) {
      await Bun.write(
        join(project, "simulations", `sim-${index}.testbench.ts`),
        `export default { name: 'sim-${index}', analysis: { type: 'op' }, models: [], assertions: [] };\n`,
      );
    }

    await expect(discoverSimulationNames(project))
      .rejects.toThrow(`more than ${SIMULATION_DEFINITION_LIMIT} simulation definitions`);
  });

  test("rejects subprocess-capable simulation definitions before executing them", async () => {
    const project = await createDigestProject("fulmetry-simulation-subprocess-");
    await mkdir(join(project, "simulations"));
    const marker = join(project, "definition-executed");
    await Bun.write(
      join(project, "simulations", "unsafe.testbench.ts"),
      `Bun.spawn([process.execPath, "--version"]); await Bun.write(${JSON.stringify(marker)}, "executed"); export default { name: "unsafe", region: { netIds: ["GND"] }, models: [], stimulus: { kind: "operating-point" }, analysis: { kind: "operating-point" }, assertions: [] };\n`,
    );

    await expect(loadSimulationDefinition({ projectRoot: project, name: "unsafe" }))
      .rejects.toThrow("forbids undeclared runtime I/O global Bun");
    expect(await Bun.file(marker).exists()).toBeFalse();
  });

  test("applies one aggregate deadline to simulation evaluation during input capture", async () => {
    const project = await createDigestProject("fulmetry-simulation-budget-project-input-");
    await mkdir(join(project, "simulations"));
    await Bun.write(
      join(project, "simulations", "hang.testbench.ts"),
      "while (true) {}\n",
    );

    await expect(digestProjectInputs({
      projectRoot: project,
      entry: "src/board.ts",
      profiles: [],
      simulationEvaluationTimeoutMs: 100,
    })).rejects.toThrow("100 ms aggregate limit");
  });
});
