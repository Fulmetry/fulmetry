import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateProjectCircuitTwice } from "../../src/project/evaluate";
import {
  deriveManufacturingExpectation,
  manufacturingExpectationSha256,
} from "../../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../../src/manufacturing/export";
import { verifyManufacturingDirectory } from "../../src/manufacturing/verify";
import {
  CANONICAL_FIXTURE_NAMES,
  canonicalFixtureRoot,
  canonicalInputRecords,
  canonicalSemanticSha256,
  manufacturingSetSha256,
  type CanonicalFixtureName,
} from "../fixtures/canonical";

const fixtureNameInput = process.argv[2];
if (!CANONICAL_FIXTURE_NAMES.includes(fixtureNameInput as CanonicalFixtureName)) {
  throw new TypeError(`Expected one fixed canonical fixture name, got ${JSON.stringify(fixtureNameInput)}`);
}
const fixtureName = fixtureNameInput as CanonicalFixtureName;
const fixtureRoot = canonicalFixtureRoot(fixtureName);
const expectation = await Bun.file(join(fixtureRoot, "expectation.json")).json() as { boardName?: unknown };
if (typeof expectation.boardName !== "string" || expectation.boardName.length === 0) {
  throw new TypeError(`${fixtureName} expectation has no boardName`);
}

const evaluated = await evaluateProjectCircuitTwice(fixtureRoot);
const manufacturingExpectation = deriveManufacturingExpectation({
  boardName: expectation.boardName,
  circuitJson: evaluated.circuitJson,
});
if (manufacturingExpectation.unsupported.length > 0) {
  throw new Error(
    `${fixtureName} candidate manufacturing expectation is unsupported: ${manufacturingExpectation.unsupported.join("; ")}`,
  );
}
const exported = await exportManufacturingFiles({
  boardName: expectation.boardName,
  circuitJson: evaluated.circuitJson,
});
const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
const records = exported.map((file) => ({
  path: file.path,
  size: new TextEncoder().encode(file.content).byteLength,
  sha256: sha256(file.content),
})).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const temporaryParent = await mkdtemp(join(tmpdir(), `pcboo-upgrade-${fixtureName}-`));
const temporaryRoot = join(temporaryParent, "manufacturing");
try {
  await emitDraftManufacturingDirectory({ targetDirectory: temporaryRoot, files: exported });
  const verification = await verifyManufacturingDirectory({
    root: temporaryRoot,
    expectation: manufacturingExpectation,
    circuitJson: evaluated.circuitJson,
  });
  if (!verification.passed || verification.findings.length > 0) {
    throw new Error(
      `${fixtureName} candidate manufacturing verification failed: ` +
        verification.findings.map((finding) => `${finding.code}: ${finding.message}`).join("; "),
    );
  }
} finally {
  await rm(temporaryParent, { recursive: true, force: true });
}

const inputRecords = await canonicalInputRecords(fixtureRoot);
process.stdout.write(`${JSON.stringify({
  name: fixtureName,
  inputs: {
    setSha256: manufacturingSetSha256(inputRecords),
    files: inputRecords,
  },
  semanticSha256: canonicalSemanticSha256(evaluated.circuitJson),
  manufacturing: {
    setSha256: manufacturingSetSha256(records),
    files: records,
  },
  verification: {
    passed: true,
    expectationSha256: manufacturingExpectationSha256(manufacturingExpectation),
  },
})}\n`);
