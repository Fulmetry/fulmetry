import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_TSCIRCUIT_VERSION,
  inspectTscircuitIdentity,
  fingerprintTscircuitPackage,
  requireTscircuitIdentity,
} from "../src/engine-identity";
import { fingerprintInstalledPackageClosure } from "../src/engine-package-fingerprint";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-engine-"));
  temporaryRoots.push(root);
  return root;
}

async function fakeEngine(root: string, version: string): Promise<string> {
  const engine = join(root, "tscircuit");
  await mkdir(engine, { recursive: true });
  await Bun.write(
    join(engine, "package.json"),
    JSON.stringify({ name: "tscircuit", version, type: "module", main: "index.js" }),
  );
  await Bun.write(join(engine, "index.js"), "export class Circuit {}\n");
  return engine;
}

async function consumer(root: string, engine: string): Promise<string> {
  const consumerRoot = join(root, crypto.randomUUID());
  await mkdir(join(consumerRoot, "node_modules"), { recursive: true });
  await symlink(engine, join(consumerRoot, "node_modules", "tscircuit"));
  return consumerRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("tscircuit engine identity", () => {
  test("accepts one physical package at the exact compatibility version", async () => {
    const root = await temporaryRoot();
    const engine = await fakeEngine(root, EXPECTED_TSCIRCUIT_VERSION);
    const projectRoot = await consumer(root, engine);
    const pcbooRoot = await consumer(root, engine);
    const expectedContentSha256 = await fingerprintTscircuitPackage(engine);

    const expectedRuntimeClosureSha256 = await fingerprintInstalledPackageClosure(engine, {
      entryPath: Bun.resolveSync("tscircuit", projectRoot),
      resolutionOrigin: projectRoot,
    });
    const report = await inspectTscircuitIdentity({
      projectRoot,
      pcbooRoot,
      expectedContentSha256,
      expectedRuntimeClosureSha256: [expectedRuntimeClosureSha256],
    });

    expect(report.compatible).toBeTrue();
    expect(report.project?.packageRoot).toBe(report.pcboo?.packageRoot);
    expect(report.project?.version).toBe(EXPECTED_TSCIRCUIT_VERSION);
    expect(report.issues).toEqual([]);
  });

  test("rejects a nested runtime override without changing the package-content pin", async () => {
    const root = await temporaryRoot();
    const engine = await fakeEngine(root, EXPECTED_TSCIRCUIT_VERSION);
    await Bun.write(join(engine, "package.json"), JSON.stringify({
      name: "tscircuit",
      version: EXPECTED_TSCIRCUIT_VERSION,
      type: "module",
      main: "index.js",
      dependencies: { dependency: "1.0.0" },
    }));
    await Bun.write(join(engine, "index.js"), 'import value from "dependency"; export default value;\n');
    const dependency = join(engine, "node_modules", "dependency");
    await mkdir(dependency, { recursive: true });
    await Bun.write(join(dependency, "package.json"), JSON.stringify({
      name: "dependency", version: "1.0.0", type: "module", main: "index.js",
    }));
    await Bun.write(join(dependency, "index.js"), 'export default "accepted";\n');
    const expectedContentSha256 = await fingerprintTscircuitPackage(engine);
    const projectRoot = await consumer(root, engine);
    const pcbooRoot = await consumer(root, engine);
    const expectedRuntimeClosureSha256 = await fingerprintInstalledPackageClosure(engine, {
      entryPath: Bun.resolveSync("tscircuit", projectRoot),
      resolutionOrigin: projectRoot,
    });

    await Bun.write(join(dependency, "index.js"), 'export default "tampered";\n');
    expect(await fingerprintTscircuitPackage(engine)).toBe(expectedContentSha256);
    const report = await inspectTscircuitIdentity({
      projectRoot,
      pcbooRoot,
      expectedContentSha256,
      expectedRuntimeClosureSha256: [expectedRuntimeClosureSha256],
    });
    expect(report.compatible).toBeFalse();
    expect(report.issues.filter(({ code }) => code === "TSCIRCUIT_RUNTIME_CLOSURE_UNQUALIFIED"))
      .toHaveLength(2);
  });

  test("fails closed when versions match but physical engines differ", async () => {
    const root = await temporaryRoot();
    const projectEngine = await fakeEngine(join(root, "project-engine"), EXPECTED_TSCIRCUIT_VERSION);
    const pcbooEngine = await fakeEngine(join(root, "pcboo-engine"), EXPECTED_TSCIRCUIT_VERSION);
    const projectRoot = await consumer(root, projectEngine);
    const pcbooRoot = await consumer(root, pcbooEngine);

    const report = await inspectTscircuitIdentity({
      projectRoot,
      pcbooRoot,
      expectedContentSha256: await fingerprintTscircuitPackage(projectEngine),
    });

    expect(report.compatible).toBeFalse();
    expect(report.issues.map((issue) => issue.code)).toContain(
      "TSCIRCUIT_DUPLICATE_ENGINE",
    );
  });

  test("fails closed on version drift", async () => {
    const root = await temporaryRoot();
    const engine = await fakeEngine(root, "0.0.2260");
    const projectRoot = await consumer(root, engine);
    const pcbooRoot = await consumer(root, engine);
    const expectedContentSha256 = await fingerprintTscircuitPackage(engine);

    const report = await inspectTscircuitIdentity({ projectRoot, pcbooRoot, expectedContentSha256 });

    expect(report.compatible).toBeFalse();
    expect(report.issues.filter((issue) => issue.code === "TSCIRCUIT_VERSION_MISMATCH"))
      .toHaveLength(2);
    expect(requireTscircuitIdentity({ projectRoot, pcbooRoot, expectedContentSha256 })).rejects.toThrow(
      "TSCIRCUIT_VERSION_MISMATCH",
    );
  });

  test("reports an unavailable project engine instead of installing one", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "empty-project");
    await mkdir(projectRoot);
    const engine = await fakeEngine(root, EXPECTED_TSCIRCUIT_VERSION);
    const pcbooRoot = await consumer(root, engine);

    const report = await inspectTscircuitIdentity({
      projectRoot,
      pcbooRoot,
      expectedContentSha256: await fingerprintTscircuitPackage(engine),
    });

    expect(report.compatible).toBeFalse();
    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "TSCIRCUIT_UNAVAILABLE",
        scope: "project",
      }),
    ]);
  });

  test("rejects a shared package whose version is right but implementation bytes are not", async () => {
    const root = await temporaryRoot();
    const engine = await fakeEngine(root, EXPECTED_TSCIRCUIT_VERSION);
    await Bun.write(join(engine, "index.js"), "throw new Error('tampered engine')\n");
    const projectRoot = await consumer(root, engine);
    const pcbooRoot = await consumer(root, engine);
    const report = await inspectTscircuitIdentity({ projectRoot, pcbooRoot });
    expect(report.compatible).toBeFalse();
    expect(report.issues.map(({ code }) => code)).toContain("TSCIRCUIT_CONTENT_MISMATCH");
  });
});
