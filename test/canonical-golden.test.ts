import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED_TSCIRCUIT_CONTENT_SHA256, requireTscircuitIdentity } from "../src/engine-identity";
import { evaluateProjectCircuitTwice } from "../src/project/evaluate";
import { deriveManufacturingExpectation, manufacturingExpectationSha256 } from "../src/manufacturing/expectation";
import { emitDraftManufacturingDirectory, exportManufacturingFiles } from "../src/manufacturing/export";
import { verifyManufacturingDirectory } from "../src/manufacturing/verify";
import { assessCircuitElectrical } from "../src/electrical";
import { assessCircuitFabrication } from "../src/fabrication";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import { directoryTreeSha256 } from "../src/upgrade/directory-transaction";
import {
  CANONICAL_FIXTURE_NAMES,
  canonicalSemanticSha256,
  listRegularFiles,
  loadCanonicalFixture,
  manifestFileRecord,
  manufacturingSetSha256,
  validateCanonicalExpectation,
  validateCanonicalManifest,
} from "./fixtures/canonical";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createRefreshProject(): Promise<string> {
  const sourceRoot = join(import.meta.dir, "..");
  const parent = await mkdtemp(join(tmpdir(), "pcboo-refresh-authority-"));
  temporaryRoots.push(parent);
  const projectRoot = join(parent, "pcboo");
  await mkdir(projectRoot);
  await Promise.all([
    ...["src", "test/fixtures", "compatibility"].map((path) => cp(
      join(sourceRoot, ...path.split("/")),
      join(projectRoot, ...path.split("/")),
      { recursive: true, errorOnExist: true },
    )),
    ...["package.json", "bun.lock"].map((path) => cp(join(sourceRoot, path), join(projectRoot, path))),
  ]);
  await mkdir(join(projectRoot, "scripts"));
  await cp(
    join(sourceRoot, "scripts", "refresh-canonical-goldens.ts"),
    join(projectRoot, "scripts", "refresh-canonical-goldens.ts"),
  );
  await symlink(
    join(sourceRoot, "node_modules"),
    join(projectRoot, "node_modules"),
    process.platform === "win32" ? "junction" : undefined,
  );
  return projectRoot;
}

describe("canonical compile-to-manufacturing goldens", () => {
  for (const fixtureName of CANONICAL_FIXTURE_NAMES) {
    test(`${fixtureName} preserves authored meaning and exact deterministic bytes`, async () => {
      const fixture = await loadCanonicalFixture(fixtureName);
      const lock = await Bun.file(join(fixture.root, "pcboo.lock")).json() as {
        tscircuit: { version: string; integrity: string };
      };
      const identity = await requireTscircuitIdentity({ projectRoot: fixture.root });
      expect(identity.project?.version).toBe(fixture.manifest.tscircuit.version);
      expect(fixture.manifest.tscircuit.version).toBe(lock.tscircuit.version);
      expect(fixture.manifest.tscircuit.integrity).toBe(lock.tscircuit.integrity);
      expect(identity.project?.contentSha256).toBe(EXPECTED_TSCIRCUIT_CONTENT_SHA256);
      expect(identity.project?.contentSha256).toBe(fixture.manifest.tscircuit.contentSha256);
      await validateCanonicalManifest({
        name: fixtureName, root: fixture.root,
        manifest: fixture.manifest, circuitJson: fixture.circuitJson,
      });

      const evaluated = await evaluateProjectCircuitTwice(fixture.root);
      expect(evaluated.canonicalJson).toBe(fixture.canonicalJson);
      expect(canonicalSemanticSha256(evaluated.circuitJson)).toBe(fixture.manifest.circuit.semanticSha256);
      const circuitRecord = await manifestFileRecord(fixture.root, "circuit.json");
      expect(circuitRecord).toEqual({
        path: fixture.manifest.circuit.path,
        size: fixture.manifest.circuit.size,
        sha256: fixture.manifest.circuit.sha256,
      });

      const expectation = deriveManufacturingExpectation({
        boardName: fixture.expectation.boardName,
        circuitJson: fixture.circuitJson,
      });
      expect(manufacturingExpectationSha256(expectation)).toBe(
        fixture.expectation.manufacturingExpectationSha256,
      );
      expect(expectation.unsupported).toEqual([]);

      const checkedInRoot = join(fixture.root, "manufacturing");
      expect(fixture.manifest.manufacturing.directory).toBe("manufacturing");
      const checkedInPaths = await listRegularFiles(checkedInRoot);
      expect(checkedInPaths).toEqual([...fixture.expectation.expectedFiles].sort());
      expect(checkedInPaths).toHaveLength(fixture.expectation.board.layerCount === 2 ? 14 : 16);
      expect(fixture.manifest.manufacturing.fileCount).toBe(checkedInPaths.length);
      const checkedInRecords = await Promise.all(
        checkedInPaths.map((path) => manifestFileRecord(checkedInRoot, path)),
      );
      expect(JSON.stringify(checkedInRecords)).toBe(JSON.stringify(fixture.manifest.manufacturing.files));
      expect(manufacturingSetSha256(checkedInRecords)).toBe(fixture.manifest.manufacturing.setSha256);

      const temporaryRoot = await mkdtemp(join(tmpdir(), `pcboo-${fixtureName}-`));
      temporaryRoots.push(temporaryRoot);
      const emittedRoot = join(temporaryRoot, "manufacturing");
      const files = await exportManufacturingFiles({
        boardName: fixture.expectation.boardName,
        circuitJson: evaluated.circuitJson,
      });
      await emitDraftManufacturingDirectory({ targetDirectory: emittedRoot, files });
      const emittedPaths = await listRegularFiles(emittedRoot);
      expect(emittedPaths).toEqual(checkedInPaths);
      const emittedRecords = await Promise.all(
        emittedPaths.map((path) => manifestFileRecord(emittedRoot, path)),
      );
      expect(emittedRecords).toEqual(checkedInRecords);
      for (const path of checkedInPaths) {
        expect(await Bun.file(join(emittedRoot, ...path.split("/"))).arrayBuffer()).toEqual(
          await Bun.file(join(checkedInRoot, ...path.split("/"))).arrayBuffer(),
        );
      }

      const [checkedInVerification, emittedVerification] = await Promise.all([
        verifyManufacturingDirectory({
          root: checkedInRoot,
          expectation,
          circuitJson: fixture.circuitJson,
        }),
        verifyManufacturingDirectory({
          root: emittedRoot,
          expectation,
          circuitJson: fixture.circuitJson,
        }),
      ]);
      expect(checkedInVerification.findings).toEqual([]);
      expect(emittedVerification.findings).toEqual([]);
      expect(checkedInVerification.passed).toBeTrue();
      expect(emittedVerification.passed).toBeTrue();
      await validateCanonicalExpectation({
        name: fixtureName,
        root: fixture.root,
        expectation: fixture.expectation,
        circuitJson: fixture.circuitJson,
      });
      expect(fixture.circuitJson.filter((element) =>
        element.type.includes("error") || element.type.includes("warning"))).toEqual([]);
      const electrical = assessCircuitElectrical(fixture.circuitJson);
      expect(electrical.status.state).toBe("passed");
      expect(electrical.diagnostics).toEqual([]);
      const fabrication = assessCircuitFabrication(fixture.circuitJson, BASELINE_FABRICATION_PROFILE);
      expect(fabrication.status.state).toBe("passed");
      expect(fabrication.diagnostics).toEqual([]);
    }, 60_000);
  }

  for (const fixtureName of CANONICAL_FIXTURE_NAMES) {
    test(`${fixtureName} full pipeline agrees across independent parent processes`, async () => {
      const run = async (undeclaredSentinel: string): Promise<unknown> => {
        const ambient: Record<string, string | undefined> = {
          ...process.env, PCBOO_UNDECLARED_SENTINEL: undeclaredSentinel,
        };
        const env: Record<string, string> = {
          PCBOO_VERIFIED_BUILD: "1", BUN_CONFIG_NO_NETWORK: "1", NO_PROXY: "*", no_proxy: "*",
        };
        for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]) {
          if (ambient[key] !== undefined) env[key] = ambient[key]!;
        }
        expect(env.PCBOO_UNDECLARED_SENTINEL).toBeUndefined();
        const child = Bun.spawn([
          process.execPath,
          join(import.meta.dir, "helpers", "canonical-pipeline-process.ts"),
          fixtureName,
        ], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(`canonical pipeline child failed: ${stderr}`);
        return JSON.parse(stdout);
      };
      const [first, second] = await Promise.all([run("first-parent"), run("second-parent")]);
      expect(second).toEqual(first);
      const fixture = await loadCanonicalFixture(fixtureName);
      expect(first).toEqual({
        circuit: fixture.manifest.circuit,
        manufacturing: fixture.manifest.manufacturing,
      });
    }, 60_000);
  }

  test("refresh requires an explicit acceptance flag and does not mutate goldens otherwise", async () => {
    const before = await Promise.all(CANONICAL_FIXTURE_NAMES.map((name) =>
      Bun.file(join(import.meta.dir, "fixtures", "canonical", name, "manifest.json")).text()
    ));
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "..", "scripts", "refresh-canonical-goldens.ts"),
    ], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--accept-canonical-goldens");
    const after = await Promise.all(CANONICAL_FIXTURE_NAMES.map((name) =>
      Bun.file(join(import.meta.dir, "fixtures", "canonical", name, "manifest.json")).text()
    ));
    expect(after).toEqual(before);
  });

  test("refresh rejects an authority change during staging without publishing fixtures", async () => {
    const projectRoot = await createRefreshProject();
    const before = await Promise.all(CANONICAL_FIXTURE_NAMES.map((name) =>
      directoryTreeSha256(join(projectRoot, "test", "fixtures", "canonical", name))
    ));
    const child = Bun.spawn([
      process.execPath,
      join(projectRoot, "scripts", "refresh-canonical-goldens.ts"),
      "--accept-canonical-goldens",
    ], {
      cwd: projectRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
    let staged = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const entries = await readdir(join(projectRoot, "test", "fixtures"));
      const transaction = entries.find((entry) => entry.startsWith(".pcboo-canonical-refresh-"));
      if (
        transaction !== undefined &&
        await Bun.file(join(projectRoot, "test", "fixtures", transaction, "staged", "led-2layer", "manifest.json")).exists()
      ) {
        staged = true;
        break;
      }
      if (await Promise.race([child.exited.then(() => true), Bun.sleep(10).then(() => false)])) break;
    }
    if (!staged) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ }
      throw new Error("Refresh authority test could not observe the staged publication boundary");
    }
    const anchorPath = join(projectRoot, "compatibility", "tscircuit.json");
    const anchor = JSON.parse(await readFile(anchorPath, "utf8"));
    anchor.accepted.contentSha256 = "b".repeat(64);
    await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`);
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Maintenance authority changed during preparation");
    const after = await Promise.all(CANONICAL_FIXTURE_NAMES.map((name) =>
      directoryTreeSha256(join(projectRoot, "test", "fixtures", "canonical", name))
    ));
    expect(after).toEqual(before);
  }, 60_000);

  test("refresh rolls back publication when authority changes after the first backup", async () => {
    const projectRoot = await createRefreshProject();
    const before = await Promise.all(CANONICAL_FIXTURE_NAMES.map((name) =>
      directoryTreeSha256(join(projectRoot, "test", "fixtures", "canonical", name))
    ));
    const driverPath = join(projectRoot, "refresh-authority-driver.ts");
    const anchorPath = join(projectRoot, "compatibility", "tscircuit.json");
    await writeFile(driverPath, `
import { readFile, writeFile } from "node:fs/promises";
import { refreshCanonicalGoldens } from "./scripts/refresh-canonical-goldens.ts";

await refreshCanonicalGoldens({
  explicitAcceptance: true,
  afterBackup: async (index) => {
    if (index !== 0) return;
    const path = ${JSON.stringify(anchorPath)};
    const anchor = JSON.parse(await readFile(path, "utf8"));
    anchor.accepted.contentSha256 = "c".repeat(64);
    await writeFile(path, JSON.stringify(anchor, null, 2) + "\\n");
  },
});
`);
    const child = Bun.spawn([process.execPath, driverPath], {
      cwd: projectRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Maintenance authority changed during preparation");
    const after = await Promise.all(CANONICAL_FIXTURE_NAMES.map((name) =>
      directoryTreeSha256(join(projectRoot, "test", "fixtures", "canonical", name))
    ));
    expect(after).toEqual(before);
    expect((await readdir(join(projectRoot, "test", "fixtures"))).some(
      (entry) => entry.startsWith(".pcboo-canonical-refresh-"),
    )).toBeFalse();
  }, 60_000);

  test("authored expectation mutations are rejected by independent observations", async () => {
    const fixture = await loadCanonicalFixture("led-2layer");
    const validate = (expectation: typeof fixture.expectation) => validateCanonicalExpectation({
      name: "led-2layer", root: fixture.root, expectation, circuitJson: fixture.circuitJson,
    });

    const badHoleCount = structuredClone(fixture.expectation);
    (badHoleCount.features as { nonPlatedHoleCount: number }).nonPlatedHoleCount = 999;
    await expect(validate(badHoleCount)).rejects.toThrow("features.nonPlatedHoleCount");

    const badComponentGeometry = structuredClone(fixture.expectation);
    (badComponentGeometry.components.D1 as { widthMm: number }).widthMm = 999;
    await expect(validate(badComponentGeometry)).rejects.toThrow("components");

    const badFileSet = structuredClone(fixture.expectation);
    (badFileSet.expectedFiles as string[]).pop();
    await expect(validate(badFileSet)).rejects.toThrow("expectedFiles");

    const badCompatibilityPin = structuredClone(fixture.expectation);
    (badCompatibilityPin.compatibility.batteryVoltageBackfill as { voltageV: number }).voltageV = 12;
    await expect(validate(badCompatibilityPin)).rejects.toThrow("batteryVoltageBackfill.voltageV");

    const fourLayer = await loadCanonicalFixture("plated-hole-4layer");
    const disconnectedVia = structuredClone(fourLayer.expectation);
    const inner = disconnectedVia.compatibility.innerLayerRouting!;
    (inner.viaConnections[0] as { layer: string }).layer = "bottom";
    await expect(validateCanonicalExpectation({
      name: "plated-hole-4layer", root: fourLayer.root,
      expectation: disconnectedVia, circuitJson: fourLayer.circuitJson,
    })).rejects.toThrow("viaConnections");

    const deletedInnerEvidence = structuredClone(fourLayer.expectation);
    delete (deletedInnerEvidence.compatibility as { innerLayerRouting?: unknown }).innerLayerRouting;
    await expect(validateCanonicalExpectation({
      name: "plated-hole-4layer", root: fourLayer.root,
      expectation: deletedInnerEvidence, circuitJson: fourLayer.circuitJson,
    })).rejects.toThrow("innerLayerRouting is required");

    const emptyGroundLayers = structuredClone(fourLayer.expectation);
    (emptyGroundLayers.compatibility.innerLayerRouting!.groundLayers as string[]).splice(0);
    await expect(validateCanonicalExpectation({
      name: "plated-hole-4layer", root: fourLayer.root,
      expectation: emptyGroundLayers, circuitJson: fourLayer.circuitJson,
    })).rejects.toThrow("groundLayers");

    const emptyViaConnections = structuredClone(fourLayer.expectation);
    (emptyViaConnections.compatibility.innerLayerRouting!.viaConnections as unknown[]).splice(0);
    await expect(validateCanonicalExpectation({
      name: "plated-hole-4layer", root: fourLayer.root,
      expectation: emptyViaConnections, circuitJson: fourLayer.circuitJson,
    })).rejects.toThrow("viaConnections");

    const missingGroundComponent = structuredClone(fourLayer.expectation);
    (missingGroundComponent.compatibility.innerLayerRouting as { groundComponent: string }).groundComponent = "MISSING";
    await expect(validateCanonicalExpectation({
      name: "plated-hole-4layer", root: fourLayer.root,
      expectation: missingGroundComponent, circuitJson: fourLayer.circuitJson,
    })).rejects.toThrow("groundComponent MISSING");

    const missingGroundNet = structuredClone(fourLayer.expectation);
    (missingGroundNet.compatibility.innerLayerRouting as { groundNet: string }).groundNet = "MISSING";
    await expect(validateCanonicalExpectation({
      name: "plated-hole-4layer", root: fourLayer.root,
      expectation: missingGroundNet, circuitJson: fourLayer.circuitJson,
    })).rejects.toThrow("groundNet MISSING");
  });

  test("a canonical manufacturing file-count mutation is rejected", async () => {
    const fixture = await loadCanonicalFixture("led-2layer");
    const validate = (manifest: typeof fixture.manifest) => validateCanonicalManifest({
      name: "led-2layer", root: fixture.root, manifest, circuitJson: fixture.circuitJson,
    });

    const badCount = structuredClone(fixture.manifest);
    (badCount.manufacturing as { fileCount: number }).fileCount = 999;
    await expect(validate(badCount)).rejects.toThrow("manufacturing.fileCount");
  }, 30_000);

  test("a canonical manufacturing-directory mutation is rejected", async () => {
    const fixture = await loadCanonicalFixture("led-2layer");
    const validate = (manifest: typeof fixture.manifest) => validateCanonicalManifest({
      name: "led-2layer", root: fixture.root, manifest, circuitJson: fixture.circuitJson,
    });
    const badDirectory = structuredClone(fixture.manifest);
    (badDirectory.manufacturing as { directory: string }).directory = "elsewhere";
    await expect(validate(badDirectory)).rejects.toThrow();
  }, 30_000);

  test("a canonical input-set digest mutation is rejected", async () => {
    const fixture = await loadCanonicalFixture("led-2layer");
    const validate = (manifest: typeof fixture.manifest) => validateCanonicalManifest({
      name: "led-2layer", root: fixture.root, manifest, circuitJson: fixture.circuitJson,
    });
    const badInputDigest = structuredClone(fixture.manifest);
    (badInputDigest.inputs as { setSha256: string }).setSha256 = "0".repeat(64);
    await expect(validate(badInputDigest)).rejects.toThrow("inputs.setSha256");
  }, 30_000);

  test("a canonical input-file digest mutation is rejected", async () => {
    const fixture = await loadCanonicalFixture("led-2layer");
    const validate = (manifest: typeof fixture.manifest) => validateCanonicalManifest({
      name: "led-2layer", root: fixture.root, manifest, circuitJson: fixture.circuitJson,
    });
    const badInputRecord = structuredClone(fixture.manifest);
    (badInputRecord.inputs.files[0] as { sha256: string }).sha256 = "f".repeat(64);
    await expect(validate(badInputRecord)).rejects.toThrow("inputs.files");
  }, 30_000);

  test("a canonical adapter identity mutation is rejected", async () => {
    const fixture = await loadCanonicalFixture("led-2layer");
    const validate = (manifest: typeof fixture.manifest) => validateCanonicalManifest({
      name: "led-2layer", root: fixture.root, manifest, circuitJson: fixture.circuitJson,
    });
    const badAdapter = structuredClone(fixture.manifest);
    (badAdapter.adapters as Record<string, string>).gerber = "tampered@0.0.0";
    await expect(validate(badAdapter)).rejects.toThrow("adapters");
  }, 30_000);

  test("a canonical authored source-input mutation is rejected", async () => {
    const fixture = await loadCanonicalFixture("led-2layer");
    const copiedParent = await mkdtemp(join(fixture.root, "..", ".input-tamper-"));
    temporaryRoots.push(copiedParent);
    const copiedRoot = join(copiedParent, "led-2layer");
    await cp(fixture.root, copiedRoot, { recursive: true });
    const routingPath = join(copiedRoot, "circuit", "routing.ts");
    await writeFile(routingPath, `${await Bun.file(routingPath).text()}\n// tampered source input\n`);
    await expect(validateCanonicalManifest({
      name: "led-2layer", root: copiedRoot,
      manifest: fixture.manifest, circuitJson: fixture.circuitJson,
    })).rejects.toThrow("inputs.files");
  }, 30_000);
});
