#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectTscircuitCandidatePackage } from "../src/upgrade/engine-package";
import { inspectTscircuitDependencyLock } from "../src/upgrade/dependency-lock";
import {
  canonicalTscircuitRuntimeEvidenceJson,
  createTscircuitRuntimeEvidence,
} from "../src/upgrade/runtime-evidence";
import { TSCIRCUIT_RUNTIME_PLATFORM_NAMES } from "../src/upgrade/platforms";
import {
  fingerprintTscircuitRuntimeEvidenceImplementation,
  TSCIRCUIT_RUNTIME_EVIDENCE_IMPLEMENTATION_FILES,
} from "../src/upgrade/implementation-identity";
import { inspectPackedConsumer } from "../src/upgrade/packed-consumer";
import { PACKED_CONSUMER_CONTRACT_VERSION } from "../src/upgrade/packed-consumer";
import { capturePathAuthorityEpoch, requireUnchangedPathAuthorityEpoch } from "../src/upgrade/authority-epoch";
import { parseTscircuitCompatibilityAnchorText } from "../src/upgrade/refresh-guard";
import { readBoundedRegularFile } from "../src/internal/bounded-file";
import { parseJsonWithoutDuplicateKeys } from "../src/upgrade/jsonc";
import {
  canonicalTscircuitUpgradeReportJson,
  tscircuitUpgradeReportSha256,
  type TscircuitUpgradeReviewReport,
} from "../src/upstream-upgrade";

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} is required`);
  return resolve(process.cwd(), value);
}

function optionalValue(name: string): string | undefined {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new TypeError(`${name} may be specified only once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0]! + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} requires one value`);
  return value;
}

const repositoryRoot = argument("--repository-root");
const packedRoot = argument("--packed-consumer-root");
const output = argument("--output");
const platform = `${process.platform}-${process.arch}`;
if (!TSCIRCUIT_RUNTIME_PLATFORM_NAMES.includes(platform as never)) {
  throw new Error(`Unsupported runtime evidence platform ${platform}`);
}
if (Bun.version !== "1.3.14") throw new Error("Runtime evidence requires Bun 1.3.14");

const repositoryPackage = join(repositoryRoot, "node_modules", "tscircuit");
const repositoryLockPath = join(repositoryRoot, "bun.lock");
const packedManifestPath = join(packedRoot, "package.json");
const anchorPath = join(repositoryRoot, "compatibility", "tscircuit.json");
const packageManifestPath = join(repositoryRoot, "package.json");
for (const path of [repositoryLockPath, packedManifestPath]) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError(`${path} must be a regular non-symlink file`);
}
const authorityEpoch = await capturePathAuthorityEpoch([
  anchorPath,
  packageManifestPath,
  repositoryLockPath,
  ...TSCIRCUIT_RUNTIME_EVIDENCE_IMPLEMENTATION_FILES.map(
    (path) => join(repositoryRoot, ...path.split("/")),
  ),
]);

const anchorBytes = await readFile(anchorPath);
const anchor = parseTscircuitCompatibilityAnchorText(new TextDecoder("utf-8", { fatal: true }).decode(anchorBytes));
const reviewReportArgument = optionalValue("--review-report");
const explicitCandidateIntegrity = optionalValue("--candidate-integrity");
if ((reviewReportArgument === undefined) !== (explicitCandidateIntegrity === undefined)) {
  throw new TypeError("--review-report and --candidate-integrity must be supplied together for candidate qualification");
}
let reviewReport: TscircuitUpgradeReviewReport | undefined;
if (reviewReportArgument !== undefined) {
  const reviewPath = resolve(process.cwd(), reviewReportArgument);
  const reviewText = new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedRegularFile(reviewPath, 16 * 1024 * 1024),
  );
  reviewReport = parseJsonWithoutDuplicateKeys(reviewText, "Runtime qualification review report") as TscircuitUpgradeReviewReport;
  if (
    reviewReport.reportSha256 !== tscircuitUpgradeReportSha256(reviewReport) ||
    canonicalTscircuitUpgradeReportJson(reviewReport) !== reviewText
  ) throw new TypeError("Runtime qualification review report is non-canonical or has an invalid self-digest");
  if (reviewReport.baselineAnchorSha256 !== sha256(anchorBytes)) {
    throw new TypeError("Runtime qualification review report is not bound to the exact baseline anchor bytes");
  }
  if (reviewReport.bunVersion !== Bun.version) {
    throw new TypeError("Runtime qualification review report requires a different Bun version");
  }
  if (reviewReport.candidate.engine.integrity !== explicitCandidateIntegrity) {
    throw new TypeError("Explicit candidate integrity differs from the runtime qualification review report");
  }
}
const candidateIntegrity = explicitCandidateIntegrity ?? anchor.accepted.integrity;
const repository = await inspectTscircuitCandidatePackage({
  packageDirectory: repositoryPackage,
  integrity: candidateIntegrity,
  resolutionOrigin: repositoryRoot,
});
if (reviewReport === undefined) {
  if (
    repository.version !== anchor.accepted.version ||
    repository.integrity !== anchor.accepted.integrity ||
    repository.contentSha256 !== anchor.accepted.contentSha256
  ) throw new TypeError("Accepted-mode runtime qualification repository differs from the compatibility anchor");
} else if (
  repository.version !== reviewReport.candidate.engine.version ||
  repository.integrity !== reviewReport.candidate.engine.integrity ||
  repository.contentSha256 !== reviewReport.candidate.engine.contentSha256
) throw new TypeError("Candidate runtime qualification repository differs from the reviewed candidate identity");
const pcbooVersion = (JSON.parse(await readFile(packageManifestPath, "utf8")) as { version: string }).version;
const packed = await inspectPackedConsumer({
  root: packedRoot,
  repositoryRoot,
  expectedVersion: repository.version,
  expectedIntegrity: repository.integrity,
  expectedPcbooVersion: pcbooVersion,
});
if (reviewReport === undefined) {
  const acceptedClosures = anchor.runtimeClosures[platform];
  if (
    acceptedClosures === undefined ||
    repository.runtimeClosureSha256 !== acceptedClosures.repository ||
    packed.runtimeClosureSha256 !== acceptedClosures.packedConsumer
  ) throw new TypeError(`Accepted-mode runtime qualification differs from the compatibility anchor closures: ${JSON.stringify({
    expected: acceptedClosures ?? null,
    observed: {
      repository: repository.runtimeClosureSha256,
      packedConsumer: packed.runtimeClosureSha256,
    },
  })}`);
}

const repositoryLock = await inspectTscircuitDependencyLock({
  lockPath: repositoryLockPath,
  candidatePackageRoot: repository.realPackageRoot,
  expectedVersion: repository.version,
  expectedIntegrity: repository.integrity,
});
if (repositoryLock.installedClosureSha256 !== repository.runtimeClosureSha256) {
  throw new Error("Repository lock-root closure and inspected package closure disagree");
}

const evidence = createTscircuitRuntimeEvidence({
  candidate: {
    version: repository.version,
    integrity: repository.integrity,
    contentSha256: repository.contentSha256,
  },
  baselineAnchorSha256: sha256(anchorBytes),
  semanticReportSha256: reviewReport?.reportSha256 ?? null,
  bunVersion: Bun.version,
  platform: platform as typeof TSCIRCUIT_RUNTIME_PLATFORM_NAMES[number],
  implementationSha256: await fingerprintTscircuitRuntimeEvidenceImplementation(repositoryRoot),
  profiles: {
    repository: {
      closureSha256: repository.runtimeClosureSha256,
      lockSha256: repositoryLock.dependencyLockSha256,
    },
    packedConsumer: {
      closureSha256: packed.runtimeClosureSha256,
      lockSha256: packed.lockSha256,
      manifestSha256: packed.manifestSha256,
      packedPcbooContentSha256: packed.packedPcbooContentSha256,
      projectPcbooLockSha256: packed.projectPcbooLockSha256,
      singleEngineResolutionSha256: packed.singleEngineResolutionSha256,
      pcbooTarballSha256: packed.pcbooTarballSha256,
      pcbooTarballIntegrity: packed.pcbooTarballIntegrity,
      contractVersion: PACKED_CONSUMER_CONTRACT_VERSION,
    },
  },
});
await requireUnchangedPathAuthorityEpoch(authorityEpoch);
const [repositoryFinal, packedFinal, repositoryLockFinal] = await Promise.all([
  inspectTscircuitCandidatePackage({
    packageDirectory: repositoryPackage,
    integrity: repository.integrity,
    resolutionOrigin: repositoryRoot,
  }),
  inspectPackedConsumer({
    root: packedRoot,
    repositoryRoot,
    expectedVersion: repository.version,
    expectedIntegrity: repository.integrity,
    expectedPcbooVersion: pcbooVersion,
  }),
  inspectTscircuitDependencyLock({
    lockPath: repositoryLockPath,
    candidatePackageRoot: repository.realPackageRoot,
    expectedVersion: repository.version,
    expectedIntegrity: repository.integrity,
  }),
]);
if (
  JSON.stringify(repositoryFinal) !== JSON.stringify(repository) ||
  JSON.stringify(packedFinal) !== JSON.stringify(packed) ||
  JSON.stringify(repositoryLockFinal) !== JSON.stringify(repositoryLock)
) throw new Error("Runtime qualification authority changed before evidence publication");
await requireUnchangedPathAuthorityEpoch(authorityEpoch);
await writeFile(output, canonicalTscircuitRuntimeEvidenceJson(evidence), { flag: "wx" });
process.stdout.write(`${output} ${evidence.evidenceSha256}\n`);
