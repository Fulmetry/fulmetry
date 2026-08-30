#!/usr/bin/env bun
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalCircuitJson } from "../src/circuit-json";
import { requireTscircuitIdentity } from "../src/engine-identity";
import { deriveManufacturingExpectation, manufacturingExpectationSha256 } from "../src/manufacturing/expectation";
import { emitDraftManufacturingDirectory, exportManufacturingFiles } from "../src/manufacturing/export";
import { verifyManufacturingDirectory } from "../src/manufacturing/verify";
import { evaluateProjectCircuitTwice } from "../src/project/evaluate";
import {
  CANONICAL_FIXTURE_NAMES,
  canonicalFixtureRoot,
  canonicalInputRecords,
  canonicalSemanticSha256,
  listRegularFiles,
  manifestFileRecord,
  manufacturingSetSha256,
  validateCanonicalExpectation,
  validateCanonicalManifest,
  type CanonicalExpectation,
  type CanonicalManifest,
} from "../test/fixtures/canonical";

const [version, integrity, contentSha256, baselineVersion] = process.argv.slice(2);
if (!version || !integrity || !contentSha256 || !baselineVersion) throw new TypeError("Acceptance fixture preparation requires old and new engine identity");
const fulmetryRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

for (const fixtureName of CANONICAL_FIXTURE_NAMES) {
  const root = canonicalFixtureRoot(fixtureName);
  const expectation = JSON.parse(await readFile(join(root, "expectation.json"), "utf8")) as CanonicalExpectation;
  const lock = JSON.parse(await readFile(join(root, "fulmetry.lock"), "utf8")) as {
    tscircuit: { version: string; integrity: string }; adapters: Record<string, string>;
  };
  if (lock.tscircuit.version !== baselineVersion) throw new Error(`${fixtureName} lock is not the reviewed baseline`);
  const identity = await requireTscircuitIdentity({
    projectRoot: root, fulmetryRoot, expectedVersion: version, expectedContentSha256: contentSha256,
  });
  if (identity.project?.version !== version || identity.project.contentSha256 !== contentSha256) {
    throw new Error(`${fixtureName} did not resolve the accepted candidate engine`);
  }
  const evaluated = await evaluateProjectCircuitTwice(root);
  const derived = deriveManufacturingExpectation({ boardName: expectation.boardName, circuitJson: evaluated.circuitJson });
  if (manufacturingExpectationSha256(derived) !== expectation.manufacturingExpectationSha256) {
    throw new Error(`${fixtureName} manufacturing expectation changed and requires a separately authored review`);
  }
  const files = await exportManufacturingFiles({ boardName: expectation.boardName, circuitJson: evaluated.circuitJson });
  if (JSON.stringify(files.map(({ path }) => path).sort()) !== JSON.stringify([...expectation.expectedFiles].sort())) {
    throw new Error(`${fixtureName} manufacturing path inventory changed`);
  }
  const manufacturingRoot = join(root, "manufacturing");
  await rm(manufacturingRoot, { recursive: true, force: true });
  await emitDraftManufacturingDirectory({ targetDirectory: manufacturingRoot, files });
  await writeFile(join(root, "circuit.json"), canonicalCircuitJson(evaluated.circuitJson));
  lock.tscircuit = { version, integrity };
  await writeFile(join(root, "fulmetry.lock"), `${JSON.stringify(lock, null, 2)}\n`);
  for (const value of Object.values(expectation.compatibility) as Array<{ engineVersion?: string }>) {
    if (value.engineVersion !== baselineVersion) throw new Error(`${fixtureName} compatibility metadata is not the reviewed baseline`);
    value.engineVersion = version;
  }
  await writeFile(join(root, "expectation.json"), `${JSON.stringify(expectation, null, 2)}\n`);
  const manufacturingRecords = await Promise.all(
    (await listRegularFiles(manufacturingRoot)).map((path) => manifestFileRecord(manufacturingRoot, path)),
  );
  const circuitRecord = await manifestFileRecord(root, "circuit.json");
  const inputRecords = await canonicalInputRecords(root);
  const manifest: CanonicalManifest = {
    schemaVersion: 1,
    fixtureName,
    tscircuit: { version, integrity, contentSha256 },
    adapters: lock.adapters,
    inputs: { fileCount: inputRecords.length, setSha256: manufacturingSetSha256(inputRecords), files: inputRecords },
    circuit: {
      path: "circuit.json", size: circuitRecord.size, sha256: circuitRecord.sha256,
      semanticSha256: canonicalSemanticSha256(evaluated.circuitJson),
    },
    manufacturing: {
      directory: "manufacturing", fileCount: manufacturingRecords.length,
      setSha256: manufacturingSetSha256(manufacturingRecords), files: manufacturingRecords,
    },
  };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateCanonicalExpectation({ name: fixtureName, root, expectation, circuitJson: evaluated.circuitJson });
  await validateCanonicalManifest({
    name: fixtureName, root, manifest, circuitJson: evaluated.circuitJson,
    expectedEngine: { version, contentSha256 },
  });
  const verification = await verifyManufacturingDirectory({
    root: manufacturingRoot,
    expectation: derived,
    circuitJson: evaluated.circuitJson,
  });
  if (!verification.passed || verification.findings.length !== 0) {
    throw new Error(`${fixtureName} independently verified manufacturing output did not pass`);
  }
}
