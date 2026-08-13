import { evaluateProjectCircuitTwice } from "../../src/project/evaluate";
import { exportManufacturingFiles } from "../../src/manufacturing/export";
import {
  CANONICAL_FIXTURE_NAMES,
  canonicalFixtureRoot,
  canonicalSemanticSha256,
  manufacturingSetSha256,
  type CanonicalFixtureName,
} from "../fixtures/canonical";

const name = process.argv[2];
if (!CANONICAL_FIXTURE_NAMES.includes(name as CanonicalFixtureName)) {
  throw new Error(`Expected canonical fixture name, got ${JSON.stringify(name)}`);
}
const fixtureName = name as CanonicalFixtureName;
const root = canonicalFixtureRoot(fixtureName);
const expectation = await Bun.file(`${root}/expectation.json`).json() as { boardName: string };
const evaluated = await evaluateProjectCircuitTwice(root);
const files = await exportManufacturingFiles({ boardName: expectation.boardName, circuitJson: evaluated.circuitJson });
const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const records = files.map((file) => ({
  path: file.path,
  size: new TextEncoder().encode(file.content).byteLength,
  sha256: sha256(file.content),
})).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
process.stdout.write(JSON.stringify({
  circuit: {
    path: "circuit.json",
    size: new TextEncoder().encode(evaluated.canonicalJson).byteLength,
    sha256: sha256(evaluated.canonicalJson),
    semanticSha256: canonicalSemanticSha256(evaluated.circuitJson),
  },
  manufacturing: {
    directory: "manufacturing",
    fileCount: records.length,
    setSha256: manufacturingSetSha256(records),
    files: records,
  },
}));
