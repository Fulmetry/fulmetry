import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProjectCircuitTwice } from "../src/project/evaluate";
import { canonicalCircuitJson } from "../src/circuit-json";
import { requireTscircuitIdentity } from "../src/engine-identity";
import { parsePcbooLock } from "../src/project/lock";
import { requireRuntimeEvidencePackageIdentity } from "../src/evidence-identity";
import { requireManufacturingPackageIdentity } from "../src/manufacturing/identity";
import {
  capturePathAuthorityEpoch,
  requireUnchangedPathAuthorityEpoch,
} from "../src/upgrade/authority-epoch";
import {
  parseTscircuitCompatibilityAnchorText,
  requireAcceptedEngineForCanonicalRefresh,
} from "../src/upgrade/refresh-guard";
import {
  deriveManufacturingExpectation,
  manufacturingExpectationSha256,
} from "../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import { verifyManufacturingDirectory } from "../src/manufacturing/verify";
import {
  directoryTreeSha256,
  replaceDirectoriesTransactionally,
} from "../src/upgrade/directory-transaction";
import {
  CANONICAL_FIXTURE_NAMES,
  canonicalInputRecords,
  canonicalFixtureRoot,
  canonicalFixturesRoot,
  canonicalSemanticSha256,
  listRegularFiles,
  manifestFileRecord,
  manufacturingSetSha256,
  validateCanonicalExpectation,
  validateCanonicalManifest,
  type CanonicalExpectation,
  type CanonicalManifest,
} from "../test/fixtures/canonical";

const ACCEPT_FLAG = "--accept-canonical-goldens";

export interface CanonicalRefreshMaintenanceOptions {
  readonly explicitAcceptance: boolean;
  /** @internal Adversarial publication-boundary test hook. */
  readonly afterBackup?: (index: number) => Promise<void>;
}

export async function refreshCanonicalGoldens(
  options: CanonicalRefreshMaintenanceOptions,
): Promise<void> {
if (!options.explicitAcceptance) {
  throw new Error(`Refusing to refresh canonical goldens without explicit ${ACCEPT_FLAG}`);
}

const pcbooRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const compatibilityAnchorPath = join(pcbooRoot, "compatibility", "tscircuit.json");
const compatibilityAnchor = parseTscircuitCompatibilityAnchorText(await readFile(compatibilityAnchorPath, "utf8"));
const authorityEpoch = await capturePathAuthorityEpoch([
  join(pcbooRoot, "package.json"),
  join(pcbooRoot, "bun.lock"),
  compatibilityAnchorPath,
  join(pcbooRoot, "src"),
  fileURLToPath(import.meta.url),
  join(pcbooRoot, "test", "fixtures", "canonical.ts"),
]);
await Promise.all([
  requireRuntimeEvidencePackageIdentity(),
  requireManufacturingPackageIdentity(),
]);

const transactionRoot = await mkdtemp(join(dirname(canonicalFixturesRoot), ".pcboo-canonical-refresh-"));
const stagedRoot = join(transactionRoot, "staged");
await mkdir(stagedRoot);
const prepared: Array<{
  fixtureName: typeof CANONICAL_FIXTURE_NAMES[number];
  targetDirectory: string;
  stagedDirectory: string;
  expectedTargetSha256: string;
  expectedStagedSha256: string;
  manufacturingFileCount: number;
}> = [];
let publicationStarted = false;

const requireCurrentMaintenanceAuthority = async (): Promise<void> => {
  await requireUnchangedPathAuthorityEpoch(authorityEpoch);
  await Promise.all([
    requireRuntimeEvidencePackageIdentity(),
    requireManufacturingPackageIdentity(),
  ]);
  const currentAnchor = parseTscircuitCompatibilityAnchorText(
    await readFile(compatibilityAnchorPath, "utf8"),
  );
  for (const fixture of prepared) {
    const lock = parsePcbooLock(await readFile(join(fixture.targetDirectory, "pcboo.lock"), "utf8"));
    const identity = await requireTscircuitIdentity({
      projectRoot: fixture.targetDirectory,
      pcbooRoot,
    });
    requireAcceptedEngineForCanonicalRefresh({
      fixtureName: fixture.fixtureName,
      anchored: currentAnchor.accepted,
      requested: {
        version: lock.tscircuit.version,
        integrity: lock.tscircuit.integrity,
        contentSha256: identity.project!.contentSha256,
      },
    });
  }
  // Source authority is independent from package and fixture identity. Check
  // it on both sides of those asynchronous reads so an ordinary concurrent
  // save cannot straddle validation unnoticed.
  await requireUnchangedPathAuthorityEpoch(authorityEpoch);
};

try {
  // Prepare and independently validate every fixture before replacing any checked-in byte.
  for (const fixtureName of CANONICAL_FIXTURE_NAMES) {
    const targetRoot = canonicalFixtureRoot(fixtureName);
    const expectedTargetSha256 = await directoryTreeSha256(targetRoot);
    const root = join(stagedRoot, fixtureName);
    await cp(targetRoot, root, { recursive: true, errorOnExist: true });
    if (await directoryTreeSha256(root) !== expectedTargetSha256) {
      throw new Error(`${fixtureName} changed while its source tree was staged`);
    }
    const expectation = JSON.parse(
      await readFile(join(root, "expectation.json"), "utf8"),
    ) as CanonicalExpectation;
    const lock = JSON.parse(await readFile(join(root, "pcboo.lock"), "utf8")) as {
      tscircuit: { version: string; integrity: string };
      adapters: Record<string, string>;
    };
    const identity = await requireTscircuitIdentity({ projectRoot: root, pcbooRoot });
    requireAcceptedEngineForCanonicalRefresh({
      fixtureName,
      anchored: compatibilityAnchor.accepted,
      requested: {
        version: lock.tscircuit.version,
        integrity: lock.tscircuit.integrity,
        contentSha256: identity.project!.contentSha256,
      },
    });
    const evaluated = await evaluateProjectCircuitTwice(root);
    const derivedExpectation = deriveManufacturingExpectation({
      boardName: expectation.boardName,
      circuitJson: evaluated.circuitJson,
    });
    const expectationSha256 = manufacturingExpectationSha256(derivedExpectation);
    if (expectationSha256 !== expectation.manufacturingExpectationSha256) {
      throw new Error(
        `${fixtureName} authored expectation digest is ${expectation.manufacturingExpectationSha256}, ` +
        `but the compiled design derives ${expectationSha256}; review expectation.json before acceptance`,
      );
    }
    const files = await exportManufacturingFiles({
      boardName: expectation.boardName,
      circuitJson: evaluated.circuitJson,
    });
    const actualPaths = files.map((file) => file.path).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify([...expectation.expectedFiles].sort())) {
      throw new Error(`${fixtureName} export paths differ from authored expectedFiles`);
    }

    const manufacturingRoot = join(root, "manufacturing");
    await rm(manufacturingRoot, { recursive: true, force: true });
    await emitDraftManufacturingDirectory({ targetDirectory: manufacturingRoot, files });
    await writeFile(join(root, "circuit.json"), canonicalCircuitJson(evaluated.circuitJson));

    const manufacturingPaths = await listRegularFiles(manufacturingRoot);
    const manufacturingRecords = await Promise.all(
      manufacturingPaths.map((path) => manifestFileRecord(manufacturingRoot, path)),
    );
    const circuitRecord = await manifestFileRecord(root, "circuit.json");
    const inputRecords = await canonicalInputRecords(root);
    const manifest: CanonicalManifest = {
      schemaVersion: 1,
      fixtureName,
      tscircuit: {
        version: lock.tscircuit.version,
        integrity: lock.tscircuit.integrity,
        contentSha256: identity.project!.contentSha256,
      },
      adapters: lock.adapters,
      inputs: {
        fileCount: inputRecords.length,
        setSha256: manufacturingSetSha256(inputRecords),
        files: inputRecords,
      },
      circuit: {
        path: "circuit.json",
        size: circuitRecord.size,
        sha256: circuitRecord.sha256,
        semanticSha256: canonicalSemanticSha256(evaluated.circuitJson),
      },
      manufacturing: {
        directory: "manufacturing",
        fileCount: manufacturingRecords.length,
        setSha256: manufacturingSetSha256(manufacturingRecords),
        files: manufacturingRecords,
      },
    };
    await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await validateCanonicalExpectation({
      name: fixtureName,
      root,
      expectation,
      circuitJson: evaluated.circuitJson,
    });
    await validateCanonicalManifest({
      name: fixtureName,
      root,
      manifest,
      circuitJson: evaluated.circuitJson,
    });
    const manufacturingVerification = await verifyManufacturingDirectory({
      root: manufacturingRoot,
      expectation: derivedExpectation,
      circuitJson: evaluated.circuitJson,
    });
    if (!manufacturingVerification.passed || manufacturingVerification.findings.length !== 0) {
      throw new Error(`${fixtureName} independently generated manufacturing verification did not pass`);
    }
    prepared.push({
      fixtureName,
      targetDirectory: targetRoot,
      stagedDirectory: root,
      expectedTargetSha256,
      expectedStagedSha256: await directoryTreeSha256(root),
      manufacturingFileCount: manufacturingRecords.length,
    });
  }

  await requireCurrentMaintenanceAuthority();
  for (const fixture of prepared) {
    if (await directoryTreeSha256(fixture.targetDirectory) !== fixture.expectedTargetSha256) {
      throw new Error(`${fixture.fixtureName} changed during canonical refresh preparation`);
    }
  }
  publicationStarted = true;
  await replaceDirectoriesTransactionally({
    transactionDirectory: transactionRoot,
    replacements: prepared,
    ...(options.afterBackup === undefined ? {} : { afterBackup: options.afterBackup }),
    beforeCommit: requireCurrentMaintenanceAuthority,
  });
  for (const fixture of prepared) {
    process.stdout.write(
      `refreshed ${fixture.fixtureName}: ${fixture.manufacturingFileCount} manufacturing files\n`,
    );
  }
} finally {
  // The publication helper owns cleanup after it starts. If rollback is ever
  // incomplete, it deliberately retains backups at transactionRoot.
  if (!publicationStarted) await rm(transactionRoot, { recursive: true, force: true });
}
}

if (import.meta.main) {
  await refreshCanonicalGoldens({
    explicitAcceptance: process.argv.slice(2).includes(ACCEPT_FLAG),
  });
}
