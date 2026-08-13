// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { afterAll, describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, opendir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftArtifactManifest } from "../src/artifacts/manifest";
import { createBuildInputSnapshot } from "../src/artifacts/inputs";
import {
  publishVerifiedProductionBundle,
  verifyPublishedProductionBundle,
  type PromoteProductionBundleOptions,
} from "../src/artifacts/promotion";
import { canonicalCircuitJson } from "../src/circuit-json";
import { probeNgspice } from "../src/external-tools";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import {
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
} from "../src/project/lock";
import { loadSimulationDefinition } from "../src/simulation";
import { runQualifiedNgspice } from "../src/simulation/ngspice";
import { qualifyCapturedNgspice } from "../src/simulation/ngspice-qualification";
import { assuranceStatus, sourcingStatus, statusSet } from "../src/status";
import { liveFunctionalFixture } from "./fixtures/live-functional";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true })
)));

function digest(value: Uint8Array | string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

async function regularFileInventory(root: string, prefix = ""): Promise<readonly Readonly<{
  path: string;
  size: number;
  sha256: string;
}>[]> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("Live evidence tree exceeds eight directory levels");
    for await (const entry of await opendir(directory)) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Live evidence contains symlink ${path}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), path, depth + 1);
      else if (entry.isFile()) {
        const absolute = join(directory, entry.name);
        const before = await lstat(absolute);
        const bytes = await readFile(absolute);
        const after = await lstat(absolute);
        if (
          before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        ) throw new Error(`Live evidence changed while hashing ${path}`);
        files.push({ path: prefix === "" ? path : `${prefix}/${path}`, size: bytes.byteLength, sha256: digest(bytes) });
        if (files.length > 128) throw new Error("Live evidence exceeds 128 files");
      } else throw new Error(`Live evidence contains special entry ${path}`);
    }
  };
  await visit(root, "", 0);
  return Object.freeze(files
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => Object.freeze(entry)));
}

describe("required live ngspice compatibility", () => {
  test("qualifies real ngspice and verifies a required-functional production bundle", async () => {
    expect(process.env.PCBOO_LIVE_NGSPICE_REQUIRED).toBe("1");
    const executable = process.env.PCBOO_NGSPICE_PATH ?? Bun.which("ngspice");
    expect(executable, "Required live ngspice executable is absent").not.toBeNull();
    if (executable === null) throw new Error("Required live ngspice executable is absent");
    const tool = await probeNgspice({ executable });
    expect(tool.state, tool.reason).toBe("detected");

    const qualificationRoot = await mkdtemp(join(tmpdir(), "pcboo-live-ngspice-"));
    roots.push(qualificationRoot);
    const qualificationDirectory = join(qualificationRoot, "qualification");
    const qualification = await qualifyCapturedNgspice({
      executable: tool.executable!,
      directory: qualificationDirectory,
      tool,
      retainCaseArtifacts: true,
    });
    expect(qualification.evidence.cases, JSON.stringify(qualification.evidence.cases, null, 2)).toHaveLength(4);
    expect(qualification.evidence.cases.every(({ status }) => status === "passed"),
      JSON.stringify(qualification.evidence.cases, null, 2)).toBeTrue();
    expect(qualification.evidence.qualified).toBeTrue();

    const projectRoot = join(qualificationRoot, "project");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, "simulations"));
    await mkdir(join(projectRoot, "node_modules"));
    await symlink(
      await realpath(join(import.meta.dir, "..", "node_modules", "tscircuit")),
      join(projectRoot, "node_modules", "tscircuit"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const circuitJson = await liveFunctionalFixture();
    const circuitBytes = canonicalCircuitJson(circuitJson);
    const model = "* PCBoo-authored live-ngspice resistor fixture\n";
    const modelPath = "simulations/resistors.model";
    await Bun.write(join(projectRoot, "src/board.ts"), `export default ${circuitBytes.trim()}\n`);
    await Bun.write(
      join(projectRoot, "pcboo.config.ts"),
      `export default { entry: "src/board.ts", profiles: [${JSON.stringify(BASELINE_FABRICATION_PROFILE.name)}], boardRevision: "live-A" }\n`,
    );
    await Bun.write(join(projectRoot, "pcboo.lock"), `${JSON.stringify({
      schemaVersion: 1,
      tscircuit: { version: SUPPORTED_TSCIRCUIT_VERSION, integrity: SUPPORTED_TSCIRCUIT_INTEGRITY },
      adapters: {
        gerber: "circuit-json-to-gerber@0.0.90",
        bom: "circuit-json-to-bom-csv@0.0.14",
        pickAndPlace: "circuit-json-to-pnp-csv@0.0.9",
        independentParser: "gerber-parser@4.2.7",
      },
      profiles: {
        [BASELINE_FABRICATION_PROFILE.name]: {
          version: BASELINE_FABRICATION_PROFILE.version,
          digest: BASELINE_FABRICATION_PROFILE.digest,
        },
      },
      assets: {},
    }, null, 2)}\n`);
    await Bun.write(join(projectRoot, modelPath), model);
    const definition = {
      schemaVersion: 1,
      name: "divider",
      region: {
        componentIds: ["source_component_1", "source_component_2"],
        netIds: ["VIN", "VOUT", "GND"],
      },
      models: [{
        id: "resistors", device: { kind: "primitive", name: "resistor" },
        bindings: [
          { componentId: "source_component_1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
          { componentId: "source_component_2", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
        ],
        path: modelPath, source: "PCBoo live analytical fixture",
        digest: digest(model), license: "CC0-1.0", redistribution: "allowed",
      }],
      stimuli: [{
        kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND",
        unit: "V", dcValue: 5, ac: null, transient: null,
      }],
      solver: { engine: "ngspice" }, analysis: { kind: "operating-point" },
      assertions: [{
        expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } },
        sample: { kind: "last" }, unit: "V", expected: 2.5,
        absoluteTolerance: 0.001, relativeTolerance: 0,
      }],
      timeoutMs: 5_000,
    };
    const testbenchPath = "simulations/divider.testbench.ts";
    await Bun.write(join(projectRoot, testbenchPath), `export default ${JSON.stringify(definition)}\n`);
    const loaded = await loadSimulationDefinition({ projectRoot, name: "divider" });
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot,
      inputs: [
        { path: "src/board.ts", role: "source" },
        { path: "pcboo.config.ts", role: "config" },
        { path: "pcboo.lock", role: "lockfile" },
        { path: modelPath, role: "test" },
        { path: testbenchPath, role: "test" },
      ],
    });
    // Generated solver evidence belongs under PCBoo's project-contained output
    // authority, which the immutable project-input inventory excludes.
    const outputRoot = join(projectRoot, ".pcboo");
    const runDirectory = join(outputRoot, "runs", "live-ngspice");
    await mkdir(runDirectory, { recursive: true });
    const run = await runQualifiedNgspice({
      projectRoot,
      outputRoot,
      runDirectory,
      definition: loaded.definition,
      definitionAuthority: loaded.authority,
      circuitJson,
      executable: tool.executable!,
      inputSnapshot,
    });
    expect(run.assessment.status.state, JSON.stringify(run.assessment.diagnostics, null, 2)).toBe("passed");
    expect(run.promotionAuthority).toBeDefined();
    expect(run.evidence?.qualificationSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const files = await exportManufacturingFiles({ boardName: "live-divider", circuitJson });
    const artifactRoot = join(qualificationRoot, "manufacturing-draft");
    await emitDraftManufacturingDirectory({ targetDirectory: artifactRoot, files });
    await mkdir(join(artifactRoot, "evidence"));
    await Bun.write(join(artifactRoot, "evidence/circuit.json"), circuitBytes);
    const artifactKinds = Object.freeze(Object.fromEntries([
      ...files.map(({ path, kind }) => [path, kind] as const),
      ["evidence/circuit.json", "compiled-circuit"] as const,
    ]));
    const draftManifest = await createDraftArtifactManifest({
      root: artifactRoot,
      boardRevision: "live-A",
      artifactPaths: [...files.map(({ path }) => path), "evidence/circuit.json"],
      artifactKinds,
    });
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "passed"),
      electrical: assuranceStatus("electrical", "passed"),
      functional: assuranceStatus("functional", "passed"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });
    const promotion: PromoteProductionBundleOptions = {
      projectRoot,
      artifactRoot,
      draftManifest,
      inputSnapshot,
      manufacturingExpectation: deriveManufacturingExpectation({ boardName: "live-divider", circuitJson }),
      statuses,
      additionallyRequiredDimensions: ["functional"],
      functionalSimulationAuthority: run.promotionAuthority!,
    };
    const destinationDirectory = join(qualificationRoot, "verified-functional-bundle");
    const published = await publishVerifiedProductionBundle({ ...promotion, destinationDirectory });
    const verified = await verifyPublishedProductionBundle(published.root, {
      expectedManifestSha256: published.manifestSha256,
    });
    expect(verified.integrityValid, JSON.stringify(verified.findings, null, 2)).toBeTrue();
    expect(verified.findings).toEqual([]);
    const persistedManifest = JSON.parse(await Bun.file(published.manifestPath).text());
    expect(persistedManifest.statuses.functional.state).toBe("passed");
    expect(persistedManifest.functionalEvidence.definitionDigest).toBe(run.evidence?.definitionDigest);
    expect(persistedManifest.functionalEvidence.inputSnapshotDigest).toBe(inputSnapshot.digest);

    const reportDirectory = join(
      import.meta.dir,
      "..",
      ".pcboo-ci",
      `ngspice-live-${process.platform}-${process.arch}`,
    );
    await rm(reportDirectory, { recursive: true, force: true });
    await mkdir(reportDirectory, { recursive: true });
    await cp(qualificationDirectory, join(reportDirectory, "qualification-cases"), { recursive: true });
    await cp(join(runDirectory, "simulation"), join(reportDirectory, "simulation"), { recursive: true });
    await cp(published.root, join(reportDirectory, "verified-functional-bundle"), { recursive: true });
    const inventory = await regularFileInventory(reportDirectory);
    const evidence = Object.freeze({
      schemaVersion: 1,
      requirements: ["F: analytical live ngspice", "H: explicitly required functional release gate"],
      invocation: "bun run test:live:ngspice",
      fixture: "live-functional-divider@1",
      host: { platform: process.platform, architecture: process.arch, bunVersion: Bun.version },
      tool,
      qualification: qualification.evidence,
      simulation: run.evidence,
      publication: {
        manifestSha256: published.manifestSha256,
        artifactCount: published.artifactCount,
        verification: verified,
      },
      supportingArtifacts: inventory,
    });
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    await Bun.write(join(reportDirectory, "evidence.json"), evidenceBytes);
    await Bun.write(join(reportDirectory, "evidence.sha256"), `${digest(evidenceBytes)}  evidence.json\n`);
  }, 120_000);
});
