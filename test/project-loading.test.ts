import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig } from "../src/project/config";
import { discoverProject } from "../src/project/discovery";
import { PROJECT_INPUT_FILE_BYTES_LIMIT } from "../src/project/input-limits";
import { digestProjectInputs } from "../src/project/input-digest";
import {
  loadPcbooLock,
  parsePcbooLock,
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
} from "../src/project/lock";

const roots: string[] = [];

function lock(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    tscircuit: {
      version: SUPPORTED_TSCIRCUIT_VERSION,
      integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
    },
    adapters: {
      gerber: "circuit-json-to-gerber@0.0.90",
      bom: "circuit-json-to-bom-csv@0.0.14",
      pickAndPlace: "circuit-json-to-pnp-csv@0.0.9",
      independentParser: "gerber-parser@4.2.7",
    },
    profiles: {},
    assets: {},
    ...overrides,
  }, null, 2) + "\n";
}

async function project(name = "agent project ü") {
  const parent = await mkdtemp(join(tmpdir(), "pcboo-project-"));
  roots.push(parent);
  const root = join(parent, name);
  await mkdir(join(root, "circuit", "nested", "deep"), { recursive: true });
  await Bun.write(join(root, "circuit/board.tsx"), "export default []\n");
  await Bun.write(
    join(root, "pcboo.config.ts"),
    "export default { entry: 'circuit/board.tsx', profiles: ['four-layer'] }\n",
  );
  await Bun.write(join(root, "pcboo.lock"), lock());
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("PCBoo project discovery and loading", () => {
  test("discovers a complete Unicode project from a descendant without executing config", async () => {
    const root = await project();
    await Bun.write(join(root, "pcboo.config.ts"), "throw new Error('must not execute')\n");
    const found = await discoverProject(join(root, "circuit/nested/deep"));
    const canonicalRoot = await realpath(root);
    expect(found.root).toBe(canonicalRoot);
    expect(found.configPath).toBe(join(canonicalRoot, "pcboo.config.ts"));
    expect(found.lockfilePath).toBe(join(canonicalRoot, "pcboo.lock"));
  });

  test("rejects an incomplete nearest project instead of searching past it", async () => {
    const root = await project();
    const nested = join(root, "circuit/nested");
    await Bun.write(join(nested, "pcboo.config.ts"), "export default {}\n");
    expect(discoverProject(join(nested, "deep"))).rejects.toThrow("Incomplete PCBoo project");
  });

  test("rejects a crash-interrupted scaffold even if config and lock files are visible", async () => {
    const root = await project("partial-scaffold");
    await Bun.write(join(root, ".pcboo-scaffold-incomplete"), "incomplete\n");
    await expect(discoverProject(root)).rejects.toThrow("Incomplete PCBoo scaffold");
  });

  test("loads a serializable deterministic typed configuration", async () => {
    const root = await project();
    expect(await loadProjectConfig(root)).toEqual({
      schemaVersion: 1,
      entry: "circuit/board.tsx",
      outputDirectory: ".pcboo",
      profiles: ["four-layer"],
    });

    await Bun.write(
      join(root, "pcboo.config.ts"),
      "export default { entry: 'circuit/board.tsx', profiles: ['four-layer'], boardRevision: 'Rev_A-1' }\n",
    );
    expect((await loadProjectConfig(root)).boardRevision).toBe("Rev_A-1");
  });

  test("rejects ambiguous or unsafe board revision identifiers", async () => {
    for (const [name, revision] of [
      ["empty", ""],
      ["leading-symbol", "=A"],
      ["space", "Revision A"],
      ["oversized", "A".repeat(65)],
    ] as const) {
      const root = await project(`revision-${name}`);
      await Bun.write(
        join(root, "pcboo.config.ts"),
        `export default { entry: 'circuit/board.tsx', boardRevision: ${JSON.stringify(revision)} }\n`,
      );
      await expect(loadProjectConfig(root)).rejects.toThrow(
        "boardRevision must be a conservative 1-64 character source-controlled identifier",
      );
    }
  });

  test("rejects nondeterministic, non-serializable, unknown, and escaping config", async () => {
    const nondeterministic = await project("random");
    await Bun.write(
      join(nondeterministic, "pcboo.config.ts"),
      "export default { entry: 'circuit/board.tsx', profiles: [String(Math.random())] }\n",
    );
    expect(loadProjectConfig(nondeterministic)).rejects.toThrow(
      "forbids ambient nondeterminism Math.random",
    );

    const nonSerializable = await project("date");
    await Bun.write(
      join(nonSerializable, "pcboo.config.ts"),
      "export default { entry: 'circuit/board.tsx', value: new Date(0) }\n",
    );
    expect(loadProjectConfig(nonSerializable)).rejects.toThrow(
      "forbids ambient nondeterminism global Date",
    );

    const escaping = await project("escape");
    await Bun.write(
      join(escaping, "pcboo.config.ts"),
      "export default { entry: '../outside.ts' }\n",
    );
    expect(loadProjectConfig(escaping)).rejects.toThrow("parent-relative");

    const environmentDriven = await project("environment");
    process.env.PCBOO_TEST_DESIGN_INPUT = "environment-dependent-output";
    try {
      await Bun.write(
        join(environmentDriven, "pcboo.config.ts"),
        "export default { entry: 'circuit/board.tsx', outputDirectory: process.env.PCBOO_TEST_DESIGN_INPUT ?? '.pcboo' }\n",
      );
      expect(loadProjectConfig(environmentDriven)).rejects.toThrow(
        "forbids undeclared runtime I/O global process",
      );
    } finally {
      delete process.env.PCBOO_TEST_DESIGN_INPUT;
    }

    const overlappingOutput = await project("overlapping-output");
    await Bun.write(
      join(overlappingOutput, "pcboo.config.ts"),
      "export default { entry: 'circuit/board.tsx', outputDirectory: 'circuit' }\n",
    );
    expect(loadProjectConfig(overlappingOutput)).rejects.toThrow("cannot contain the circuit entry");

    for (const outputDirectory of [".", "./.pcboo"]) {
      const ambiguous = await project(`ambiguous-output-${outputDirectory.length}`);
      await Bun.write(
        join(ambiguous, "pcboo.config.ts"),
        `export default { entry: 'circuit/board.tsx', outputDirectory: ${JSON.stringify(outputDirectory)} }\n`,
      );
      expect(loadProjectConfig(ambiguous)).rejects.toThrow("dot, empty, or parent-relative");
    }
  });

  test("rejects clock-driven config even when adjacent evaluations share one time bucket", async () => {
    const root = await project("clock-bucket");
    await Bun.write(
      join(root, "pcboo.config.ts"),
      "export default { entry: 'circuit/board.tsx', profiles: [String((Date.now() / 60000).toFixed(0))] }\n",
    );

    expect(loadProjectConfig(root)).rejects.toThrow(
      "forbids ambient nondeterminism global Date",
    );

    const runtimeLoader = await project("import-meta-runtime-loader");
    await Bun.write(
      join(runtimeLoader, "pcboo.config.ts"),
      `void import.meta.require("node:os"); export default { entry: "circuit/board.tsx" }\n`,
    );
    expect(loadProjectConfig(runtimeLoader)).rejects.toThrow(
      "forbids runtime import.meta access",
    );
  });

  test("binds canonical resolved profiles and board revision into config and project digests", async () => {
    const root = await project("resolved-config-authority");
    const base = {
      projectRoot: root,
      entry: "circuit/board.tsx",
      outputDirectory: ".pcboo",
    } as const;
    const first = await digestProjectInputs({ ...base, profiles: ["profile-a"] });
    const second = await digestProjectInputs({ ...base, profiles: ["profile-b"] });
    const reordered = await digestProjectInputs({
      ...base,
      profiles: ["profile-b", "profile-a"],
    });
    const canonical = await digestProjectInputs({
      ...base,
      profiles: ["profile-a", "profile-b"],
    });
    const revised = await digestProjectInputs({
      ...base,
      profiles: ["profile-a", "profile-b"],
      boardRevision: "B",
    });

    expect(first.configDigest).not.toBe(second.configDigest);
    expect(first.projectDigest).not.toBe(second.projectDigest);
    expect(reordered.configDigest).toBe(canonical.configDigest);
    expect(reordered.projectDigest).toBe(canonical.projectDigest);
    expect(revised.configDigest).not.toBe(canonical.configDigest);
    expect(revised.projectDigest).not.toBe(canonical.projectDigest);
  });

  test("rejects runtime I/O config before execution without echoing hostile source values", async () => {
    const root = await project("hostile-config");
    const secret = "pcboo-test-secret-do-not-echo";
    await Bun.write(
      join(root, "pcboo.config.ts"),
      `process.stderr.write(${JSON.stringify(secret)}); throw new Error(${JSON.stringify(secret)});\n`,
    );
    let message = "";
    try {
      await loadProjectConfig(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("forbids undeclared runtime I/O global process");
    expect(message).not.toContain(secret);

    const dynamic = await project("dynamic-secret-key");
    process.env.PCBOO_TEST_SECRET_KEY = secret;
    try {
      await Bun.write(
        join(dynamic, "pcboo.config.ts"),
        "export default { entry: 'circuit/board.tsx', [process.env.PCBOO_TEST_SECRET_KEY]: () => true };\n",
      );
      let dynamicMessage = "";
      try {
        await loadProjectConfig(dynamic);
      } catch (error) {
        dynamicMessage = error instanceof Error ? error.message : String(error);
      }
      expect(dynamicMessage).toContain("forbids undeclared runtime I/O global process");
      expect(dynamicMessage).not.toContain(secret);
    } finally {
      delete process.env.PCBOO_TEST_SECRET_KEY;
    }
  });

  test("bounds configuration time and output and propagates cancellation", async () => {
    const infinite = await project("infinite-config");
    await Bun.write(join(infinite, "pcboo.config.ts"), "while (true) {}\nexport default { entry: 'circuit/board.tsx' };\n");
    await expect(loadProjectConfig(infinite, { timeoutMs: 100 })).rejects.toThrow("exceeded 100 ms");

    const oversized = await project("oversized-config");
    await Bun.write(
      join(oversized, "pcboo.config.ts"),
      "export default { entry: 'circuit/board.tsx', profiles: ['x'.repeat(2048)] };\n",
    );
    await expect(loadProjectConfig(oversized, { outputLimit: 1024 })).rejects.toThrow("exceeded 1024 bytes");

    const cancelled = await project("cancelled-config");
    await Bun.write(join(cancelled, "pcboo.config.ts"), "while (true) {}\nexport default { entry: 'circuit/board.tsx' };\n");
    const controller = new AbortController();
    const pending = loadProjectConfig(cancelled, { timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 75);
    await expect(pending).rejects.toThrow("cancelled");

    const oversizedImport = await project("oversized-config-import");
    const helper = join(oversizedImport, "oversized-config-helper.ts");
    await Bun.write(helper, "");
    await truncate(helper, PROJECT_INPUT_FILE_BYTES_LIMIT + 1);
    await Bun.write(
      join(oversizedImport, "pcboo.config.ts"),
      "import './oversized-config-helper.ts'; export default { entry: 'circuit/board.tsx' };\n",
    );
    await expect(loadProjectConfig(oversizedImport)).rejects.toThrow(
      `${PROJECT_INPUT_FILE_BYTES_LIMIT}-byte per-file limit`,
    );
  });

  test("parses an exact versioned lock contract and rejects drift or extra fields", async () => {
    const root = await project();
    expect((await loadPcbooLock(root)).tscircuit.version).toBe(SUPPORTED_TSCIRCUIT_VERSION);
    expect(() => parsePcbooLock(lock({
      tscircuit: { version: "999.0.0", integrity: "sha512-drift" },
    }))).toThrow(`supports tscircuit ${SUPPORTED_TSCIRCUIT_VERSION}`);
    expect(() => parsePcbooLock(lock({
      tscircuit: { version: SUPPORTED_TSCIRCUIT_VERSION, integrity: "sha512-drift" },
    }))).toThrow("integrity does not match");
    expect(() => parsePcbooLock(lock({ inventedDesignIntent: true }))).toThrow(
      "fields must be exactly",
    );
    const allowedAsset = {
      source: "vendor/model.obj",
      version: "2026-08-10",
      digest: `sha256:${"a".repeat(64)}`,
      license: "CC-BY-4.0",
      attribution: "Example Author",
      licenseNotice: "vendor/model.LICENSE.txt",
      licenseNoticeDigest: `sha256:${"b".repeat(64)}`,
      redistribution: "allowed" as const,
    };
    expect(parsePcbooLock(lock({ assets: { enclosure: allowedAsset } })).assets.enclosure)
      .toEqual(allowedAsset);
    expect(() => parsePcbooLock(lock({
      assets: { enclosure: { ...allowedAsset, redistribution: "maybe" } },
    }))).toThrow("redistribution is invalid");
    expect(() => parsePcbooLock(lock({
      assets: { enclosure: { ...allowedAsset, licenseNoticeDigest: "sha256:BAD" } },
    }))).toThrow("licenseNoticeDigest must be a lowercase sha256 digest");
    const { redistribution: _redistribution, ...legacyAsset } = allowedAsset;
    expect(() => parsePcbooLock(lock({ assets: { enclosure: legacyAsset } })))
      .toThrow("fields must be exactly");
  });
});
