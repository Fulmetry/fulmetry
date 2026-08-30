#!/usr/bin/env bun
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reviewTscircuitUpgrade } from "./review-tscircuit-upgrade";
import { fingerprintEnginePackage } from "../src/engine-package-fingerprint";
import { inspectTscircuitCandidatePackage } from "../src/upgrade/engine-package";
import { inspectTscircuitDependencyLock } from "../src/upgrade/dependency-lock";
import { parseTscircuitCompatibilityAnchorText } from "../src/upgrade/refresh-guard";
import { runBoundedAcceptanceChild } from "./bounded-acceptance-child";
import { pathTreeSha256, replacePathsTransactionally, type PathReplacement } from "../src/upgrade/path-transaction";
import {
  canonicalTscircuitUpgradeReportJson,
  tscircuitUpgradeFileSetSha256,
  tscircuitUpgradeReportSha256,
  type TscircuitUpgradeReviewReport,
} from "../src/upstream-upgrade";
import { readBoundedRegularFile, revalidateCapturedRegularFile, type BoundedFileIdentity } from "../src/internal/bounded-file";
import { parseJsonWithoutDuplicateKeys } from "../src/upgrade/jsonc";
import {
  parseTscircuitRuntimeEvidenceText,
  type TscircuitRuntimeEvidence,
} from "../src/upgrade/runtime-evidence";
import { fingerprintTscircuitRuntimeEvidenceImplementation } from "../src/upgrade/implementation-identity";
import {
  inspectPackedConsumer,
  PACKED_CONSUMER_CONTRACT_VERSION,
  type PackedConsumerDescriptor,
} from "../src/upgrade/packed-consumer";
import { requireSupportedBunRuntime } from "../src/runtime";
import type { TscircuitCompatibilityAnchor } from "../src/upgrade/refresh-guard";
import {
  CANONICAL_FIXTURE_NAMES,
  canonicalInputRecords,
  listRegularFiles,
} from "../test/fixtures/canonical";

const MODULE_PROJECT_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SHA256 = /^[a-f0-9]{64}$/u;
const ACCEPTANCE_TYPESCRIPT_VERSION = "5.9.3";
const ACCEPTANCE_TYPESCRIPT_CONTENT_SHA256 = "1247d2a746ccfbc5d73c07f6d61c2e05197373d4668f258a0681e77298eccf27";
// This gate intentionally executes every non-recursive repository test against
// the staged engine. Keep it bounded, but leave headroom above the ordinary
// full-suite duration so suite growth cannot turn a clean candidate into a
// timeout-only rejection.
const CANDIDATE_REPOSITORY_GATE_TIMEOUT_MS = 900_000;

export interface AcceptTscircuitUpgradeOptions {
  readonly projectRoot: string;
  readonly candidatePackageDirectory: string;
  readonly candidateLockPath: string;
  readonly candidatePackedPackageDirectory: string;
  readonly integrity: string;
  readonly reportPath: string;
  readonly reviewedReportSha256: string;
  readonly runtimeEvidencePath: string;
  readonly runtimeEvidenceSha256: string;
  readonly explicitAcceptance: true;
  readonly timeoutMs?: number;
  /** @internal Failure injection after all staging and validation. */
  readonly afterPrepared?: (transactionRoot: string) => Promise<void>;
  /** @internal Failure injection during rollback-capable publication. */
  readonly afterPublicationBackup?: (index: number) => Promise<void>;
}

export interface AcceptTscircuitUpgradeResult {
  readonly reportSha256: string;
  readonly fromVersion: string;
  readonly acceptedVersion: string;
  readonly changedPaths: readonly string[];
  readonly nodeModulesUpdated: false;
}

export interface AcceptTscircuitUpgradeArguments {
  readonly candidatePackageDirectory: string;
  readonly candidateLockPath: string;
  readonly candidatePackedPackageDirectory: string;
  readonly integrity: string;
  readonly reportPath: string;
  readonly reviewedReportSha256: string;
  readonly runtimeEvidencePath: string;
  readonly runtimeEvidenceSha256: string;
  readonly explicitAcceptance: true;
}

const MAX_ACCEPTANCE_EVIDENCE_BYTES = 16 * 1024 * 1024;

interface CapturedAcceptanceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly identity: BoundedFileIdentity;
}

async function captureAcceptanceFile(path: string, label: string): Promise<CapturedAcceptanceFile> {
  if (!isAbsolute(path)) throw new TypeError(`${label} path must be explicit and absolute`);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new TypeError(`${label} must be a regular non-symlink file`);
  const bytes = await readBoundedRegularFile(path, MAX_ACCEPTANCE_EVIDENCE_BYTES);
  const after = await lstat(path);
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
  ) throw new Error(`${label} changed while being captured`);
  return Object.freeze({
    path,
    bytes,
    identity: Object.freeze({
      dev: after.dev, ino: after.ino, size: after.size,
      mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs,
    }),
  });
}

async function requireUnchangedAcceptanceFile(file: CapturedAcceptanceFile, label: string): Promise<void> {
  await revalidateCapturedRegularFile(file.path, file.identity);
  const current = await readBoundedRegularFile(file.path, MAX_ACCEPTANCE_EVIDENCE_BYTES);
  if (!Buffer.from(current).equals(Buffer.from(file.bytes))) throw new Error(`${label} bytes changed during acceptance`);
  await revalidateCapturedRegularFile(file.path, file.identity);
}

function utf8(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError(`${label} must be valid UTF-8`); }
}

function exactReplace(text: string, before: string, after: string, expectedCount: number, label: string): string {
  const count = text.split(before).length - 1;
  if (count !== expectedCount) throw new Error(`${label} expected ${expectedCount} accepted-identity occurrence(s), found ${count}`);
  return text.replaceAll(before, after);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface RuntimeEvidenceAcceptanceExpectation {
  readonly reportSha256: string;
  readonly baselineAnchorSha256: string;
  readonly bunVersion: string;
  readonly runtimePlatform: string;
  readonly candidate: Readonly<{ version: string; integrity: string; contentSha256: string }>;
  readonly repositoryClosureSha256: string;
  readonly packedConsumerClosureSha256: string;
  readonly repositoryLockSha256: string;
  readonly packedConsumer: Pick<PackedConsumerDescriptor,
    "lockSha256" | "manifestSha256" | "packedFulmetryContentSha256" |
    "projectFulmetryLockSha256" | "singleEngineResolutionSha256" |
    "fulmetryTarballSha256" | "fulmetryTarballIntegrity">;
}

export function requireRuntimeEvidenceForAcceptance(
  evidence: Readonly<TscircuitRuntimeEvidence>,
  expected: Readonly<RuntimeEvidenceAcceptanceExpectation>,
): void {
  if (
    evidence.semanticReportSha256 !== expected.reportSha256 ||
    evidence.baselineAnchorSha256 !== expected.baselineAnchorSha256 ||
    evidence.bunVersion !== expected.bunVersion ||
    evidence.platform !== expected.runtimePlatform ||
    canonical(evidence.candidate) !== canonical(expected.candidate)
  ) throw new Error("Runtime evidence does not share the exact review, baseline, Bun, platform, and candidate identity");
  if (
    evidence.profiles.repository.closureSha256 !== expected.repositoryClosureSha256 ||
    evidence.profiles.packedConsumer.closureSha256 !== expected.packedConsumerClosureSha256 ||
    evidence.profiles.repository.lockSha256 !== expected.repositoryLockSha256
  ) throw new Error("Runtime evidence differs from the freshly inspected candidate profiles");
  const packed = evidence.profiles.packedConsumer;
  if (
    packed.contractVersion !== PACKED_CONSUMER_CONTRACT_VERSION ||
    packed.lockSha256 !== expected.packedConsumer.lockSha256 ||
    packed.manifestSha256 !== expected.packedConsumer.manifestSha256 ||
    packed.packedFulmetryContentSha256 !== expected.packedConsumer.packedFulmetryContentSha256 ||
    packed.projectFulmetryLockSha256 !== expected.packedConsumer.projectFulmetryLockSha256 ||
    packed.singleEngineResolutionSha256 !== expected.packedConsumer.singleEngineResolutionSha256 ||
    packed.fulmetryTarballSha256 !== expected.packedConsumer.fulmetryTarballSha256 ||
    packed.fulmetryTarballIntegrity !== expected.packedConsumer.fulmetryTarballIntegrity
  ) throw new Error("Runtime evidence differs from the freshly authenticated packed consumer");
}

export function createAcceptedTscircuitAnchor(options: Readonly<{
  previousVersion: string;
  reportSha256: string;
  evidence: Readonly<TscircuitRuntimeEvidence>;
}>): Readonly<TscircuitCompatibilityAnchor> {
  if (options.evidence.semanticReportSha256 !== options.reportSha256) {
    throw new Error("Accepted anchor report digest must match runtime evidence semantic review");
  }
  return parseTscircuitCompatibilityAnchorText(`${JSON.stringify({
    schemaVersion: 3,
    accepted: options.evidence.candidate,
    runtimeClosures: {
      [options.evidence.platform]: {
        repository: options.evidence.profiles.repository.closureSha256,
        packedConsumer: options.evidence.profiles.packedConsumer.closureSha256,
      },
    },
    acceptedUpgradeReview: {
      fromVersion: options.previousVersion,
      reportSha256: options.reportSha256,
      runtimeEvidenceSha256: options.evidence.evidenceSha256,
    },
  })}\n`);
}

function requireNarrowLockChange(current: any, candidate: any): void {
  const normalized = structuredClone(candidate);
  normalized.workspaces[""].devDependencies.tscircuit = current.workspaces[""].devDependencies.tscircuit;
  normalized.workspaces[""].peerDependencies.tscircuit = current.workspaces[""].peerDependencies.tscircuit;
  normalized.packages.tscircuit = current.packages.tscircuit;
  if (canonical(normalized) !== canonical(current)) {
    throw new Error("Candidate bun.lock changes data outside the exact root tscircuit pins and direct tscircuit tuple");
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function bytesFileRecord(path: string, bytes: Uint8Array): {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
} {
  return Object.freeze({
    path,
    size: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  });
}

/** Derives the only canonical-input rewrites acceptance preparation may publish. */
export async function expectedAcceptedFixtureInputRecords(options: Readonly<{
  fixtureRoot: string;
  baseline: Readonly<{ version: string; integrity: string }>;
  candidate: Readonly<{ version: string; integrity: string }>;
}>): Promise<readonly Readonly<{ path: string; size: number; sha256: string }>[]> {
  const current = await canonicalInputRecords(options.fixtureRoot);
  const expectedBytes = new Map<string, Uint8Array>();
  for (const { path } of current) {
    expectedBytes.set(path, new Uint8Array(await Bun.file(
      join(options.fixtureRoot, ...path.split("/")),
    ).arrayBuffer()));
  }

  const lockPath = "fulmetry.lock";
  const lock = JSON.parse(new TextDecoder().decode(expectedBytes.get(lockPath)!)) as {
    tscircuit?: { version?: unknown; integrity?: unknown };
  };
  if (
    lock.tscircuit?.version !== options.baseline.version ||
    lock.tscircuit.integrity !== options.baseline.integrity
  ) {
    throw new Error("Canonical fixture lock is not the reviewed baseline identity");
  }
  lock.tscircuit = {
    version: options.candidate.version,
    integrity: options.candidate.integrity,
  };
  expectedBytes.set(lockPath, new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`));

  const expectationPath = "expectation.json";
  const expectation = JSON.parse(new TextDecoder().decode(expectedBytes.get(expectationPath)!)) as {
    compatibility?: Record<string, { engineVersion?: unknown }>;
  };
  const compatibility = expectation.compatibility;
  if (
    compatibility === undefined || Object.values(compatibility).length === 0 ||
    Object.values(compatibility).some(({ engineVersion }) => engineVersion !== options.baseline.version)
  ) {
    throw new Error("Canonical fixture compatibility metadata is not the reviewed baseline identity");
  }
  for (const value of Object.values(compatibility)) value.engineVersion = options.candidate.version;
  expectedBytes.set(
    expectationPath,
    new TextEncoder().encode(`${JSON.stringify(expectation, null, 2)}\n`),
  );

  return Object.freeze([...expectedBytes]
    .map(([path, bytes]) => bytesFileRecord(path, bytes))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** @internal Rejects every prepared canonical-input mutation outside the derived transition. */
export async function assertPreparedFixtureInputRecords(options: Readonly<{
  fixtureRoot: string;
  expected: readonly Readonly<{ path: string; size: number; sha256: string }>[];
}>): Promise<readonly Readonly<{ path: string; size: number; sha256: string }>[]> {
  const actual = await canonicalInputRecords(options.fixtureRoot);
  if (JSON.stringify(actual) !== JSON.stringify(options.expected)) {
    throw new Error("Prepared canonical fixture inputs differ from the acceptance-owned transition");
  }
  return actual;
}

/** @internal Captures the only staged trees whose bytes may later be published. */
export async function captureAcceptanceTargetSha256(
  root: string,
  paths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  return new Map(await Promise.all(paths.map(async (path) => [
    path,
    await pathTreeSha256(join(root, ...path.split("/"))),
  ] as const)));
}

/** @internal Executes candidate-controlled work without allowing it to rewrite publishable targets. */
export async function runWithAcceptanceTargetsProtected<T>(options: Readonly<{
  root: string;
  expected: ReadonlyMap<string, string>;
  label: string;
  operation: () => Promise<T>;
}>): Promise<T> {
  const result = await options.operation();
  for (const [path, expected] of options.expected) {
    if (await pathTreeSha256(join(options.root, ...path.split("/"))) !== expected) {
      throw new Error(`${options.label} changed publishable staged target ${path}`);
    }
  }
  return result;
}

/** @internal Complete staged-repository identity with explicit non-authority exclusions. */
export async function acceptanceStageSha256(
  root: string,
  excludedPaths: readonly string[],
): Promise<string> {
  const excluded = new Set(excludedPaths);
  const isExcluded = (path: string): boolean => [...excluded].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  const hasher = new Bun.CryptoHasher("sha256");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isExcluded(relativePath)) continue;
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Acceptance stage contains unapproved symlink ${relativePath}`);
      if (metadata.isDirectory()) {
        hasher.update(`D\0${relativePath}\0`);
        await walk(path, relativePath);
      } else if (metadata.isFile()) {
        hasher.update(`F\0${relativePath}\0`);
        hasher.update(await readFile(path));
        hasher.update("\0");
      } else {
        throw new Error(`Acceptance stage contains special entry ${relativePath}`);
      }
    }
  };
  await walk(root, "");
  return hasher.digest("hex");
}

/** @internal Runs candidate code against the exact staged gate tree, apart from declared outputs. */
export async function runWithAcceptanceStageProtected<T>(options: Readonly<{
  root: string;
  expectedSha256: string;
  excludedPaths: readonly string[];
  label: string;
  operation: () => Promise<T>;
}>): Promise<T> {
  const result = await options.operation();
  if (await acceptanceStageSha256(options.root, options.excludedPaths) !== options.expectedSha256) {
    throw new Error(`${options.label} changed staged repository gate inputs`);
  }
  return result;
}

export async function runBoundedChild(
  argv: readonly string[],
  cwd: string,
  label: string,
  timeoutMs: number,
): Promise<void> {
  await runBoundedAcceptanceChild({ argv, cwd, label, timeoutMs });
}

async function runPreparation(
  runtimeRoot: string,
  engine: TscircuitUpgradeReviewReport["candidate"]["engine"],
  baselineVersion: string,
  timeoutMs: number,
): Promise<void> {
  await runBoundedChild([
    process.execPath,
    join(runtimeRoot, "scripts", "prepare-tscircuit-acceptance-fixtures.ts"),
    engine.version,
    engine.integrity,
    engine.contentSha256,
    baselineVersion,
  ], runtimeRoot, "Candidate golden preparation", timeoutMs);
}

/** @internal Discovers the exact staged repository test inventory used by acceptance. */
export async function candidateRepositoryTests(runtimeRoot: string): Promise<readonly string[]> {
  const tests: string[] = [];
  let sawRecursiveAcceptanceTest = false;
  const walk = async (directory: string, required: boolean): Promise<void> => {
    try {
      const rootMetadata = await lstat(join(runtimeRoot, directory));
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new Error(`Candidate gate ${directory} root must be a non-symlink directory`);
      }
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of await readdir(join(runtimeRoot, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Candidate gate encountered symlink test entry ${relative}`);
      if (entry.isDirectory()) await walk(relative, true);
      else if (entry.isFile() && /\.test\.tsx?$/u.test(entry.name)) {
        if (relative === "test/accept-tscircuit-upgrade.test.ts") sawRecursiveAcceptanceTest = true;
        else tests.push(relative);
      }
      else if (!entry.isFile()) throw new Error(`Candidate gate encountered non-regular test entry ${relative}`);
    }
  };
  await walk("test", true);
  await walk("tests", false);
  tests.sort();
  if (!sawRecursiveAcceptanceTest || tests.length === 0) {
    throw new Error("Candidate repository gate has an incomplete test inventory");
  }
  return Object.freeze(tests);
}

/** @internal Resolves only Fulmetry's reviewed compiler package, never the candidate dependency tree. */
export async function requireTrustedAcceptanceTypeScript(projectRoot: string): Promise<Readonly<{
  root: string;
  compilerPath: string;
  version: string;
  contentSha256: string;
}>> {
  const root = await realpath(join(projectRoot, "node_modules", "typescript"));
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (metadata.name !== "typescript" || metadata.version !== ACCEPTANCE_TYPESCRIPT_VERSION) {
    throw new Error(`Acceptance compiler must be reviewed TypeScript ${ACCEPTANCE_TYPESCRIPT_VERSION}`);
  }
  const contentSha256 = await fingerprintEnginePackage(root);
  if (contentSha256 !== ACCEPTANCE_TYPESCRIPT_CONTENT_SHA256) {
    throw new Error("Acceptance compiler content does not match Fulmetry's reviewed TypeScript package");
  }
  const requestedCompilerPath = join(root, "bin", "tsc");
  const compilerStat = await lstat(requestedCompilerPath);
  if (!compilerStat.isFile() || compilerStat.isSymbolicLink()) {
    throw new Error("Acceptance TypeScript compiler is not a regular file");
  }
  const compilerPath = await realpath(requestedCompilerPath);
  if (compilerPath !== root && !compilerPath.startsWith(`${root}${sep}`)) {
    throw new Error("Acceptance TypeScript compiler resolves outside its reviewed package");
  }
  return Object.freeze({
    root,
    compilerPath,
    version: ACCEPTANCE_TYPESCRIPT_VERSION,
    contentSha256,
  });
}

/** @internal Proves the candidate itself owns Fulmetry's required public type aliases. */
export async function requireCandidateAuthoringTypeReexports(
  candidatePackageRoot: string,
  trustedTypeScript: Awaited<ReturnType<typeof requireTrustedAcceptanceTypeScript>>,
): Promise<void> {
  const packageRoot = await realpath(candidatePackageRoot);
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    types?: unknown;
    typings?: unknown;
    typesVersions?: unknown;
    exports?: unknown;
  };
  if (
    metadata.name !== "tscircuit" || typeof metadata.types !== "string" ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(metadata.types)
  ) throw new Error("Candidate tscircuit package has no safe declaration entry");
  const packageExports = metadata.exports;
  const rootExport = packageExports !== null && typeof packageExports === "object" && !Array.isArray(packageExports)
    ? (packageExports as Record<string, unknown>)["."]
    : undefined;
  const rootExportRecord = rootExport !== null && typeof rootExport === "object" && !Array.isArray(rootExport)
    ? rootExport as Record<string, unknown>
    : undefined;
  if (
    metadata.typings !== undefined || metadata.typesVersions !== undefined || rootExportRecord === undefined ||
    JSON.stringify(Object.keys(rootExportRecord)) !== JSON.stringify(["types", "default"]) ||
    rootExportRecord.types !== `./${metadata.types}` || typeof rootExportRecord.default !== "string"
  ) {
    throw new Error("Candidate tscircuit package declaration authorities disagree or are conditional");
  }
  const declarationPath = await realpath(join(packageRoot, ...metadata.types.split("/")));
  if (declarationPath !== packageRoot && !declarationPath.startsWith(`${packageRoot}${sep}`)) {
    throw new Error("Candidate tscircuit declaration entry resolves outside its package");
  }
  const declaration = await readFile(declarationPath, "utf8");
  const imported = await import(pathToFileURL(join(trustedTypeScript.root, "lib", "typescript.js")).href);
  const ts = (imported.default ?? imported) as any;
  const source = ts.createSourceFile(declarationPath, declaration, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const required = new Set(["AnyCircuitElement", "CircuitJson"]);
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "circuit-json" ||
      statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)
    ) continue;
    for (const element of statement.exportClause.elements) {
      const exported = element.name.text;
      const importedName = element.propertyName?.text ?? exported;
      if (exported === importedName) required.delete(exported);
    }
  }
  if (required.size > 0) {
    throw new Error(`Candidate tscircuit declaration entry lacks required public type re-exports: ${[...required].sort().join(", ")}`);
  }
}

async function runCandidateRepositoryGates(
  runtimeRoot: string,
  trustedTypeScript: Awaited<ReturnType<typeof requireTrustedAcceptanceTypeScript>>,
): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")) as {
    dependencies?: { typescript?: unknown };
  };
  const expectedTypeScriptVersion = packageJson.dependencies?.typescript;
  if (expectedTypeScriptVersion !== trustedTypeScript.version) {
    throw new Error("Candidate repository TypeScript dependency does not match Fulmetry's reviewed compiler");
  }
  if (await fingerprintEnginePackage(trustedTypeScript.root) !== trustedTypeScript.contentSha256) {
    throw new Error("Fulmetry's reviewed acceptance compiler changed immediately before typechecking");
  }
  await runBoundedChild(
    [process.execPath, trustedTypeScript.compilerPath, "--noEmit"],
    runtimeRoot,
    "Candidate repository typecheck",
    CANDIDATE_REPOSITORY_GATE_TIMEOUT_MS,
  );
  const tests = await candidateRepositoryTests(runtimeRoot);
  for (const path of tests) {
    await runBoundedChild(
      [
        process.execPath,
        ...(process.platform === "win32" ? [] : ["--no-orphans"]),
        "test",
        "--max-concurrency=1",
        path,
      ],
      runtimeRoot,
      `Candidate repository test ${path}`,
      CANDIDATE_REPOSITORY_GATE_TIMEOUT_MS,
    );
  }
}

export async function acceptTscircuitUpgrade(options: AcceptTscircuitUpgradeOptions): Promise<Readonly<AcceptTscircuitUpgradeResult>> {
  requireSupportedBunRuntime();
  if (options.explicitAcceptance !== true) throw new TypeError("Explicit tscircuit upgrade acceptance is required");
  if (!SHA256.test(options.reviewedReportSha256)) throw new TypeError("reviewedReportSha256 must be lowercase SHA-256");
  if (!SHA256.test(options.runtimeEvidenceSha256)) {
    throw new TypeError("runtimeEvidenceSha256 must be lowercase SHA-256");
  }
  const projectRoot = await realpath(options.projectRoot);
  if (projectRoot !== await realpath(MODULE_PROJECT_ROOT)) throw new TypeError("Acceptance projectRoot must be this Fulmetry source repository");
  const initialTrustedTypeScript = await requireTrustedAcceptanceTypeScript(projectRoot);
  const [reportFile, runtimeEvidenceFile] = await Promise.all([
    captureAcceptanceFile(options.reportPath, "Reviewed report"),
    captureAcceptanceFile(options.runtimeEvidencePath, "Runtime evidence"),
  ]);
  const reportBytes = reportFile.bytes;
  let supplied: TscircuitUpgradeReviewReport;
  try {
    supplied = parseJsonWithoutDuplicateKeys(utf8(reportBytes, "Reviewed report"), "Reviewed report") as TscircuitUpgradeReviewReport;
  } catch (error) {
    throw new TypeError(`Reviewed report must be strict JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (supplied.reportSha256 !== options.reviewedReportSha256) throw new Error("Explicit reviewed report digest does not match report bytes");
  if (
    tscircuitUpgradeReportSha256(supplied) !== options.reviewedReportSha256 ||
    canonicalTscircuitUpgradeReportJson(supplied) !== utf8(reportBytes, "Reviewed report")
  ) throw new Error("Reviewed report bytes are non-canonical or its self-digest is invalid");
  if (supplied.outcome === "no-change" || supplied.candidate.engine.version === supplied.baseline.engine.version) {
    throw new Error("Refusing to accept a no-change or current-engine review");
  }
  const fresh = (await reviewTscircuitUpgrade({
    projectRoot,
    candidatePackageDirectory: options.candidatePackageDirectory,
    candidateLockPath: options.candidateLockPath,
    candidatePackedPackageDirectory: options.candidatePackedPackageDirectory,
    integrity: options.integrity,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    publishReport: false,
  })).report;
  const canonicalFresh = canonicalTscircuitUpgradeReportJson(fresh);
  if (utf8(reportBytes, "Reviewed report") !== canonicalFresh || fresh.reportSha256 !== options.reviewedReportSha256) {
    throw new Error("Reviewed report bytes are stale, non-canonical, tampered, or do not match fresh qualification");
  }

  const candidate = await inspectTscircuitCandidatePackage({
    packageDirectory: options.candidatePackageDirectory,
    integrity: options.integrity,
    resolutionOrigin: dirname(dirname(options.candidatePackageDirectory)),
  });
  const packedCandidate = await inspectTscircuitCandidatePackage({
    packageDirectory: options.candidatePackedPackageDirectory,
    integrity: options.integrity,
    resolutionOrigin: dirname(dirname(options.candidatePackedPackageDirectory)),
  });
  if (
    packedCandidate.realPackageRoot === candidate.realPackageRoot ||
    await realpath(dirname(packedCandidate.realPackageRoot)) === await realpath(dirname(candidate.realPackageRoot))
  ) {
    throw new TypeError(
      "Clean packed-consumer profile must be a physically distinct installed package and node_modules root",
    );
  }
  if (
    packedCandidate.version !== candidate.version || packedCandidate.integrity !== candidate.integrity ||
    packedCandidate.contentSha256 !== candidate.contentSha256 ||
    packedCandidate.runtimeClosureSha256 !== fresh.candidate.engine.packedConsumerRuntimeClosureSha256
  ) throw new Error("Clean packed-consumer candidate changed after fresh reviewed qualification");
  const candidatePackedConsumerRoot = dirname(dirname(options.candidatePackedPackageDirectory));
  const projectPackageVersion = (JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { version: string }).version;
  const packedConsumer = await inspectPackedConsumer({
    root: candidatePackedConsumerRoot,
    repositoryRoot: projectRoot,
    expectedVersion: candidate.version,
    expectedIntegrity: candidate.integrity,
    expectedFulmetryVersion: projectPackageVersion,
    independentTscircuitRoots: [candidate.realPackageRoot],
  });
  if (
    packedConsumer.tscircuitPackageRoot !== packedCandidate.realPackageRoot ||
    packedConsumer.runtimeClosureSha256 !== packedCandidate.runtimeClosureSha256
  ) throw new Error("Candidate packed tscircuit is not owned by the authenticated packed consumer");
  await requireCandidateAuthoringTypeReexports(candidate.realPackageRoot, initialTrustedTypeScript);
  const candidateMetadata = JSON.parse(await readFile(join(candidate.realPackageRoot, "package.json"), "utf8")) as {
    license?: unknown;
  };
  if (candidateMetadata.license !== "MIT") {
    throw new Error("Automatic acceptance requires the candidate tscircuit package to retain its declared MIT license");
  }
  const candidateLicense = await readFile(join(candidate.realPackageRoot, "LICENSE"), "utf8").catch(() => "");
  if (!candidateLicense.includes("MIT License") || !candidateLicense.includes("Permission is hereby granted")) {
    throw new Error("Automatic acceptance requires reviewable MIT license text in the candidate package");
  }
  const candidateLock = await inspectTscircuitDependencyLock({
    lockPath: options.candidateLockPath,
    candidatePackageRoot: candidate.realPackageRoot,
    expectedVersion: candidate.version,
    expectedIntegrity: candidate.integrity,
  });
  if (
    candidateLock.dependencyLockSha256 !== fresh.candidate.engine.dependencyLockSha256 ||
    candidateLock.installedClosureSha256 !== candidate.runtimeClosureSha256
  ) {
    throw new Error("Candidate bun.lock changed after fresh reviewed qualification");
  }
  if (
    fresh.candidate.engine.runtimePlatform !== `${process.platform}-${process.arch}` ||
    candidate.runtimeClosureSha256 !== fresh.candidate.engine.runtimeClosureSha256
  ) throw new Error("Candidate runtime closure changed after fresh reviewed qualification");
  const currentLockText = await readFile(join(projectRoot, "bun.lock"), "utf8");
  const candidateLockText = await readFile(candidateLock.lockPath, "utf8");
  const currentLock = Bun.JSONC.parse(currentLockText);
  const nextLock = Bun.JSONC.parse(candidateLockText);
  requireNarrowLockChange(currentLock, nextLock);

  const anchorPath = join(projectRoot, "compatibility", "tscircuit.json");
  const anchorBytes = await readFile(anchorPath);
  const anchor = parseTscircuitCompatibilityAnchorText(utf8(anchorBytes, "Compatibility anchor"));
  if (canonical(anchor.accepted) !== canonical({
    version: fresh.baseline.engine.version,
    integrity: fresh.baseline.engine.integrity,
    contentSha256: fresh.baseline.engine.contentSha256,
  })) throw new Error("Compatibility anchor changed after review qualification");
  const runtimeEvidence = parseTscircuitRuntimeEvidenceText(
    utf8(runtimeEvidenceFile.bytes, "Runtime evidence"),
  );
  if (runtimeEvidence.evidenceSha256 !== options.runtimeEvidenceSha256) {
    throw new Error("Explicit runtime evidence digest does not match its canonical bytes");
  }
  const anchorSha256 = new Bun.CryptoHasher("sha256").update(anchorBytes).digest("hex");
  if (runtimeEvidence.baselineAnchorSha256 !== fresh.baselineAnchorSha256) {
    throw new Error("Runtime evidence baseline differs from the fresh semantic review");
  }
  requireRuntimeEvidenceForAcceptance(runtimeEvidence, {
    reportSha256: fresh.reportSha256,
    baselineAnchorSha256: anchorSha256,
    bunVersion: fresh.bunVersion,
    runtimePlatform: fresh.candidate.engine.runtimePlatform,
    candidate: {
      version: fresh.candidate.engine.version,
      integrity: fresh.candidate.engine.integrity,
      contentSha256: fresh.candidate.engine.contentSha256,
    },
    repositoryClosureSha256: fresh.candidate.engine.runtimeClosureSha256,
    packedConsumerClosureSha256: fresh.candidate.engine.packedConsumerRuntimeClosureSha256,
    repositoryLockSha256: fresh.candidate.engine.dependencyLockSha256,
    packedConsumer,
  });

  const sourceFiles = [
    "package.json",
    "bun.lock",
    "compatibility/tscircuit.json",
    "src/engine-identity.ts",
    "src/project/lock.ts",
    "src/licenses.ts",
    "packages/create-fulmetry/src/scaffold.ts",
    "scripts/packed-e2e.ts",
    "THIRD_PARTY_NOTICES.md",
  ] as const;
  for (const name of CANONICAL_FIXTURE_NAMES) {
    const generatedOutput = join(projectRoot, "test", "fixtures", "canonical", name, ".fulmetry");
    try {
      await lstat(generatedOutput);
      throw new Error(
        `Canonical fixture ${name} contains generated .fulmetry output; remove it before accepting an engine upgrade`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith(`Canonical fixture ${name} contains generated .fulmetry output`)
      ) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const targetPaths = [
    ...sourceFiles,
    ...CANONICAL_FIXTURE_NAMES.map((name) => `test/fixtures/canonical/${name}`),
  ];
  const expectedTargetSha256 = new Map<string, string>();
  for (const path of targetPaths) {
    expectedTargetSha256.set(path, await pathTreeSha256(join(projectRoot, ...path.split("/"))));
  }
  const optionalRepositoryGateInputs: string[] = [];
  try {
    const testsRoot = await lstat(join(projectRoot, "tests"));
    if (testsRoot.isSymbolicLink() || !testsRoot.isDirectory()) {
      throw new Error("Optional repository tests root must be a non-symlink directory");
    }
    optionalRepositoryGateInputs.push("tests");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const repositoryGateInputs = [
    ".github", "src", "scripts", "test", ...optionalRepositoryGateInputs, "packages", "compatibility",
    "package.json", "bun.lock", "tsconfig.json", "README.md", "PRODUCT_REQUIREMENTS.md",
    "LICENSE", "THIRD_PARTY_NOTICES.md",
  ] as const;
  const expectedGateInputSha256 = new Map<string, string>();
  for (const path of repositoryGateInputs) {
    expectedGateInputSha256.set(path, await pathTreeSha256(join(projectRoot, ...path.split("/"))));
  }

  const transactionRoot = await mkdtemp(join(dirname(projectRoot), ".fulmetry-tscircuit-accept-"));
  const runtimeRoot = join(transactionRoot, "runtime");
  let publicationStarted = false;
  try {
    await mkdir(runtimeRoot);
    await Promise.all(repositoryGateInputs.map((path) => cp(
      join(projectRoot, ...path.split("/")),
      join(runtimeRoot, ...path.split("/")),
      { recursive: true, errorOnExist: true },
    )));
    for (const path of repositoryGateInputs) {
      if (await pathTreeSha256(join(runtimeRoot, ...path.split("/"))) !== expectedGateInputSha256.get(path)) {
        throw new Error(`Repository gate input ${path} changed while it was staged`);
      }
    }
    await symlink(candidateLock.nodeModulesRoot, join(runtimeRoot, "node_modules"), process.platform === "win32" ? "junction" : undefined);
    await writeFile(join(runtimeRoot, "bun.lock"), candidateLockText);

    const old = fresh.baseline.engine;
    const next = fresh.candidate.engine;
    const patchText = async (path: string, replacements: readonly [string, string, number][]): Promise<void> => {
      const target = join(runtimeRoot, ...path.split("/"));
      let text = await readFile(target, "utf8");
      for (const [before, after, count] of replacements) text = exactReplace(text, before, after, count, path);
      await writeFile(target, text);
    };
    const packageJson = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
    packageJson.devDependencies.tscircuit = next.version;
    packageJson.peerDependencies.tscircuit = next.version;
    await writeJson(join(runtimeRoot, "package.json"), packageJson);
    await patchText("src/engine-identity.ts", [
      [`"${old.version}"`, `"${next.version}"`, 1],
      [`"${old.contentSha256}"`, `"${next.contentSha256}"`, 1],
    ]);
    await patchText("src/project/lock.ts", [[`"${old.version}"`, `"${next.version}"`, 1], [`"${old.integrity}"`, `"${next.integrity}"`, 1]]);
    await patchText("src/licenses.ts", [
      [`version: "${old.version}"`, `version: "${next.version}"`, 1],
      [`contentSha256: "${old.contentSha256}"`, `contentSha256: "${next.contentSha256}"`, 1],
    ]);
    await patchText("packages/create-fulmetry/src/scaffold.ts", [[`"${old.version}"`, `"${next.version}"`, 2], [`"${old.integrity}"`, `"${next.integrity}"`, 1]]);
    await patchText("scripts/packed-e2e.ts", [[`"${old.version}"`, `"${next.version}"`, 1]]);
    await patchText("THIRD_PARTY_NOTICES.md", [
      [`| tscircuit | ${old.version} |`, `| tscircuit | ${next.version} |`, 1],
      [`Reviewed package content sha256:${old.contentSha256}`, `Reviewed package content sha256:${next.contentSha256}`, 1],
    ]);
    await writeJson(
      join(runtimeRoot, "compatibility", "tscircuit.json"),
      createAcceptedTscircuitAnchor({
        previousVersion: old.version,
        reportSha256: fresh.reportSha256,
        evidence: runtimeEvidence,
      }),
    );
    const stagedRuntimeEvidenceImplementationSha256 =
      await fingerprintTscircuitRuntimeEvidenceImplementation(runtimeRoot);
    if (runtimeEvidence.implementationSha256 !== stagedRuntimeEvidenceImplementationSha256) {
      throw new Error("Runtime evidence was produced by a different candidate-prepared implementation");
    }
    const expectedSourceTargetSha256 = await captureAcceptanceTargetSha256(runtimeRoot, sourceFiles);
    const expectedPreparedFixtureInputs = new Map<string, readonly Readonly<{
      readonly path: string;
      readonly size: number;
      readonly sha256: string;
    }>[]>();
    for (const fixture of fresh.fixtures) {
      const fixtureRoot = join(runtimeRoot, "test", "fixtures", "canonical", fixture.name);
      const reviewedInputs = await canonicalInputRecords(fixtureRoot);
      if (tscircuitUpgradeFileSetSha256(reviewedInputs) !== fixture.inputs.candidateSetSha256) {
        throw new Error(`${fixture.name} staged canonical inputs do not match the reviewed candidate input authority`);
      }
      expectedPreparedFixtureInputs.set(fixture.name, await expectedAcceptedFixtureInputRecords({
        fixtureRoot,
        baseline: old,
        candidate: next,
      }));
    }
    const preparationExclusions = ["node_modules", "test/fixtures/canonical"] as const;
    const expectedPreparationStageSha256 = await acceptanceStageSha256(runtimeRoot, preparationExclusions);
    await runWithAcceptanceStageProtected({
      root: runtimeRoot,
      expectedSha256: expectedPreparationStageSha256,
      excludedPaths: preparationExclusions,
      label: "Candidate golden preparation",
      operation: () => runPreparation(runtimeRoot, next, old.version, options.timeoutMs ?? 120_000),
    });
    for (const fixture of fresh.fixtures) {
      const fixtureRoot = join(runtimeRoot, "test", "fixtures", "canonical", fixture.name);
      const manifest = JSON.parse(await readFile(
        join(fixtureRoot, "manifest.json"),
        "utf8",
      ));
      const expectedInputRecords = expectedPreparedFixtureInputs.get(fixture.name);
      if (expectedInputRecords === undefined) {
        throw new Error(`${fixture.name} lacks an accepted canonical-input expectation`);
      }
      const inputRecords = await assertPreparedFixtureInputRecords({
        fixtureRoot,
        expected: expectedInputRecords,
      });
      const completeFixturePaths = await listRegularFiles(fixtureRoot);
      const expectedFixturePaths = [
        ...manifest.inputs.files.map(({ path }: { path: string }) => path),
        "circuit.json",
        "manifest.json",
        ...manifest.manufacturing.files.map(({ path }: { path: string }) => `manufacturing/${path}`),
      ].sort();
      const completeFixturePathSet = new Set(completeFixturePaths);
      const expectedFixturePathSet = new Set(expectedFixturePaths);
      const addedFixturePaths = completeFixturePaths.filter((path) => !expectedFixturePathSet.has(path));
      const missingFixturePaths = expectedFixturePaths.filter((path) => !completeFixturePathSet.has(path));
      const expectedInputSetSha256 = tscircuitUpgradeFileSetSha256(expectedInputRecords);
      const mismatches = [
        ...(manifest.inputs.fileCount === expectedInputRecords.length ? [] : ["input-file-count"]),
        ...(JSON.stringify(manifest.inputs.files) === JSON.stringify(expectedInputRecords) ? [] : ["input-records"]),
        ...(manifest.inputs.setSha256 === expectedInputSetSha256 ? [] : ["input-set-digest"]),
        ...(JSON.stringify(completeFixturePaths) === JSON.stringify(expectedFixturePaths) ? [] : ["fixture-path-inventory"]),
        ...(manifest.circuit.semanticSha256 === fixture.semantic.candidateSha256 ? [] : ["semantic-digest"]),
        ...(tscircuitUpgradeFileSetSha256(manifest.manufacturing.files) === fixture.manufacturing.candidateSetSha256
          ? []
          : ["manufacturing-set-digest"]),
      ];
      if (mismatches.length > 0) throw new Error(
        `${fixture.name} staged canonical evidence differs from the reviewed candidate artifacts: ` +
        `mismatches=${mismatches.join(",")}; ` +
        `fixture-paths added=${addedFixturePaths.join(",")} missing=${missingFixturePaths.join(",")}; ` +
        `accepted-inputs ${tscircuitUpgradeFileSetSha256(inputRecords)}/${expectedInputSetSha256}, ` +
        `reviewed-base-inputs ${fixture.inputs.candidateSetSha256}, ` +
        `semantic ${manifest.circuit.semanticSha256}/${fixture.semantic.candidateSha256}, ` +
        `manufacturing ${tscircuitUpgradeFileSetSha256(manifest.manufacturing.files)}/${fixture.manufacturing.candidateSetSha256}; ` +
        `reviewed added=${fixture.manufacturing.added.map(({ path }) => path).join(",")}, ` +
        `removed=${fixture.manufacturing.removed.map(({ path }) => path).join(",")}, ` +
        `changed=${fixture.manufacturing.changed.map(({ path }) => path).join(",")}`,
      );
    }
    const fixturePaths = CANONICAL_FIXTURE_NAMES.map((name) => `test/fixtures/canonical/${name}`);
    const expectedFixtureTargetSha256 = await captureAcceptanceTargetSha256(runtimeRoot, fixturePaths);
    const expectedPublishableTargetSha256 = new Map([
      ...expectedSourceTargetSha256,
      ...expectedFixtureTargetSha256,
    ]);
    // Candidate gates may create ordinary root output such as upgrade-review
    // directories. That declared generated namespace is not repository input;
    // nested fixture output remains covered and forbidden.
    const gateExclusions = ["node_modules", ".fulmetry"] as const;
    const expectedGateStageSha256 = await acceptanceStageSha256(runtimeRoot, gateExclusions);
    const trustedTypeScript = await requireTrustedAcceptanceTypeScript(projectRoot);
    if (
      trustedTypeScript.root !== initialTrustedTypeScript.root ||
      trustedTypeScript.compilerPath !== initialTrustedTypeScript.compilerPath ||
      trustedTypeScript.contentSha256 !== initialTrustedTypeScript.contentSha256
    ) throw new Error("Fulmetry's reviewed acceptance compiler changed during candidate qualification");
    await runWithAcceptanceStageProtected({
      root: runtimeRoot,
      expectedSha256: expectedGateStageSha256,
      excludedPaths: gateExclusions,
      label: "Candidate repository gates",
      operation: () => runCandidateRepositoryGates(runtimeRoot, trustedTypeScript),
    });

    const replacements: PathReplacement[] = [];
    for (const path of sourceFiles) {
      replacements.push({
        targetPath: join(projectRoot, ...path.split("/")),
        stagedPath: join(runtimeRoot, ...path.split("/")),
        expectedTargetSha256: expectedTargetSha256.get(path)!,
        expectedStagedSha256: expectedPublishableTargetSha256.get(path)!,
      });
    }
    for (const name of CANONICAL_FIXTURE_NAMES) {
      replacements.push({
        targetPath: join(projectRoot, "test", "fixtures", "canonical", name),
        stagedPath: join(runtimeRoot, "test", "fixtures", "canonical", name),
        expectedTargetSha256: expectedTargetSha256.get(`test/fixtures/canonical/${name}`)!,
        expectedStagedSha256: expectedPublishableTargetSha256.get(`test/fixtures/canonical/${name}`)!,
      });
    }
    await options.afterPrepared?.(transactionRoot);
    await runWithAcceptanceStageProtected({
      root: runtimeRoot,
      expectedSha256: expectedGateStageSha256,
      excludedPaths: gateExclusions,
      label: "Acceptance final staging",
      operation: async () => undefined,
    });
    const finalReview = (await reviewTscircuitUpgrade({
      projectRoot,
      candidatePackageDirectory: options.candidatePackageDirectory,
      candidateLockPath: options.candidateLockPath,
      candidatePackedPackageDirectory: options.candidatePackedPackageDirectory,
      integrity: options.integrity,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      publishReport: false,
    })).report;
    if (canonicalTscircuitUpgradeReportJson(finalReview) !== canonicalFresh) {
      throw new Error("Review authority or qualification changed during acceptance preparation");
    }
    for (const path of repositoryGateInputs) {
      if (await pathTreeSha256(join(projectRoot, ...path.split("/"))) !== expectedGateInputSha256.get(path)) {
        throw new Error(`Repository gate input ${path} changed during acceptance qualification`);
      }
    }
    await Promise.all([
      requireUnchangedAcceptanceFile(reportFile, "Reviewed report"),
      requireUnchangedAcceptanceFile(runtimeEvidenceFile, "Runtime evidence"),
    ]);
    const finalRuntimeEvidence = parseTscircuitRuntimeEvidenceText(
      utf8(runtimeEvidenceFile.bytes, "Runtime evidence"),
    );
    if (
      canonical(finalRuntimeEvidence) !== canonical(runtimeEvidence) ||
      await fingerprintTscircuitRuntimeEvidenceImplementation(runtimeRoot) !==
        runtimeEvidence.implementationSha256
    ) throw new Error("Runtime evidence authority changed during acceptance preparation");
    const candidateFinal = await inspectTscircuitCandidatePackage({
      packageDirectory: options.candidatePackageDirectory,
      integrity: options.integrity,
      resolutionOrigin: dirname(dirname(options.candidatePackageDirectory)),
    });
    if (
      candidateFinal.contentSha256 !== next.contentSha256 || candidateFinal.version !== next.version ||
      candidateFinal.runtimeClosureSha256 !== next.runtimeClosureSha256
    ) {
      throw new Error("Candidate changed after acceptance preparation");
    }
    const packedCandidateFinal = await inspectTscircuitCandidatePackage({
      packageDirectory: options.candidatePackedPackageDirectory,
      integrity: options.integrity,
      resolutionOrigin: dirname(dirname(options.candidatePackedPackageDirectory)),
    });
    if (
      packedCandidateFinal.realPackageRoot !== packedCandidate.realPackageRoot ||
      packedCandidateFinal.version !== next.version || packedCandidateFinal.contentSha256 !== next.contentSha256 ||
      packedCandidateFinal.runtimeClosureSha256 !== next.packedConsumerRuntimeClosureSha256
    ) throw new Error("Clean packed-consumer candidate changed after acceptance preparation");
    const packedConsumerFinal = await inspectPackedConsumer({
      root: candidatePackedConsumerRoot,
      repositoryRoot: projectRoot,
      expectedVersion: candidate.version,
      expectedIntegrity: candidate.integrity,
      expectedFulmetryVersion: projectPackageVersion,
      independentTscircuitRoots: [candidate.realPackageRoot],
    });
    if (canonical(packedConsumerFinal) !== canonical(packedConsumer)) {
      throw new Error("Authenticated packed consumer changed after acceptance preparation");
    }
    const finalLock = await inspectTscircuitDependencyLock({
      lockPath: options.candidateLockPath,
      candidatePackageRoot: candidateFinal.realPackageRoot,
      expectedVersion: next.version,
      expectedIntegrity: next.integrity,
    });
    if (
      finalLock.dependencyLockSha256 !== fresh.candidate.engine.dependencyLockSha256 ||
      finalLock.installedClosureSha256 !== candidateFinal.runtimeClosureSha256
    ) {
      throw new Error("Candidate bun.lock changed before acceptance publication");
    }
    publicationStarted = true;
    await replacePathsTransactionally({
      transactionDirectory: transactionRoot,
      replacements,
      ...(options.afterPublicationBackup === undefined ? {} : { afterBackup: options.afterPublicationBackup }),
    });
    return Object.freeze({
      reportSha256: fresh.reportSha256,
      fromVersion: old.version,
      acceptedVersion: next.version,
      changedPaths: Object.freeze([...sourceFiles, ...CANONICAL_FIXTURE_NAMES.map((name) => `test/fixtures/canonical/${name}`)]),
      nodeModulesUpdated: false,
    });
  } finally {
    if (!publicationStarted) await rm(transactionRoot, { recursive: true, force: true });
  }
}

export function parseAcceptTscircuitUpgradeArguments(argv: readonly string[]): AcceptTscircuitUpgradeArguments {
  if (argv[0] !== "accept") throw new TypeError("Usage: bun run accept:tscircuit accept [required explicit options] --accept-reviewed-upgrade");
  const values = new Map<string, string>();
  let accepted = false;
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--accept-reviewed-upgrade") {
      if (accepted) throw new TypeError("--accept-reviewed-upgrade may be specified only once");
      accepted = true;
      continue;
    }
    if (!["--candidate-package", "--candidate-lock", "--candidate-packed-package", "--integrity", "--report", "--reviewed-report-sha256", "--runtime-evidence", "--runtime-evidence-sha256"].includes(key)) throw new TypeError(`Unknown acceptance option ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`${key} requires exactly one value`);
    if (values.has(key)) throw new TypeError(`${key} requires exactly one value`);
    values.set(key, value);
  }
  if (!accepted) throw new TypeError("--accept-reviewed-upgrade is required");
  const get = (key: string): string => { const value = values.get(key); if (!value) throw new TypeError(`${key} is required`); return value; };
  return {
    candidatePackageDirectory: resolve(process.cwd(), get("--candidate-package")),
    candidateLockPath: resolve(process.cwd(), get("--candidate-lock")),
    candidatePackedPackageDirectory: resolve(process.cwd(), get("--candidate-packed-package")),
    integrity: get("--integrity"),
    reportPath: resolve(process.cwd(), get("--report")),
    reviewedReportSha256: get("--reviewed-report-sha256"),
    runtimeEvidencePath: resolve(process.cwd(), get("--runtime-evidence")),
    runtimeEvidenceSha256: get("--runtime-evidence-sha256"),
    explicitAcceptance: true,
  };
}

if (import.meta.main) {
  try {
    const result = await acceptTscircuitUpgrade({
      projectRoot: MODULE_PROJECT_ROOT,
      ...parseAcceptTscircuitUpgradeArguments(process.argv.slice(2)),
    });
    process.stdout.write(`Accepted tscircuit ${result.acceptedVersion} from reviewed report ${result.reportSha256}.\n` +
      "node_modules was not installed or changed; run `bun install --frozen-lockfile` before ordinary commands.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
