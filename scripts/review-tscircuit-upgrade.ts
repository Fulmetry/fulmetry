#!/usr/bin/env bun
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectTscircuitCandidatePackage } from "../src/upgrade/engine-package";
import { QUALIFIED_TSCIRCUIT_RUNTIME_CLOSURES } from "../src/engine-identity";
import { inspectTscircuitDependencyLock } from "../src/upgrade/dependency-lock";
import {
  requireSupportedUpgradeReviewBunVersion,
} from "../src/upgrade/runtime";
import { requireSupportedBunRuntime } from "../src/runtime";
import {
  parseTscircuitCompatibilityAnchorText,
  type TscircuitCompatibilityAnchor,
} from "../src/upgrade/refresh-guard";
import {
  canonicalTscircuitUpgradeReportJson,
  createTscircuitUpgradeReview,
  tscircuitUpgradeFileSetSha256,
  type TscircuitUpgradeFileRecord,
  type TscircuitUpgradeReviewReport,
  type TscircuitUpgradeSnapshot,
} from "../src/upstream-upgrade";
import {
  CANONICAL_FIXTURE_NAMES,
  loadCanonicalFixture,
  validateCanonicalManifest,
} from "../test/fixtures/canonical";
import { runBoundedAcceptanceChild } from "./bounded-acceptance-child";

const DEFAULT_TIMEOUT_MS = 120_000;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const MODULE_PROJECT_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const QUALIFICATION = Object.freeze({
  curatedExportIdentity: "passed",
  mixedImportSemanticEquivalence: "passed",
  deterministicDoubleEvaluation: "passed",
  circuitJsonSchemaValidation: "passed",
  independentManufacturingVerification: "passed",
} as const);

export interface ReviewTscircuitUpgradeOptions {
  readonly projectRoot: string;
  readonly candidatePackageDirectory: string;
  readonly candidateLockPath: string;
  readonly candidatePackedPackageDirectory?: string;
  readonly integrity: string;
  readonly output?: string;
  readonly timeoutMs?: number;
  /** @internal Adversarial test hook; the command line never supplies it. */
  readonly stagePrepared?: (stageRoot: string) => Promise<void>;
  /** @internal Adversarial test hook; runs after staged inputs are authenticated. */
  readonly afterStageInputCaptured?: (stageRoot: string) => Promise<void>;
  /** @internal Allows strict-anchor failure tests without modifying the repository. */
  readonly compatibilityAnchorPath?: string;
  /** @internal Requalifies and reconstructs evidence without publishing a second report. */
  readonly publishReport?: boolean;
}

export interface ReviewTscircuitUpgradeResult {
  readonly outputPath: string;
  readonly outputRelativePath: string;
  readonly report: Readonly<TscircuitUpgradeReviewReport>;
}

export interface ReviewTscircuitUpgradeArguments {
  readonly candidatePackageDirectory: string;
  readonly candidateLockPath: string;
  readonly candidatePackedPackageDirectory?: string;
  readonly integrity: string;
  readonly output?: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseReviewTscircuitUpgradeArguments(argv: readonly string[]): ReviewTscircuitUpgradeArguments {
  if (argv[0] !== "review") {
    throw new TypeError(
      "Usage: bun run upgrade:tscircuit review --candidate-package <explicit dir> --candidate-lock <explicit bun.lock> --integrity <canonical npm SRI> [--candidate-packed-package <clean consumer node_modules/tscircuit>] [--output <.fulmetry/upgrade-reviews/...json>]",
    );
  }
  let candidatePackageDirectory: string | undefined;
  let candidateLockPath: string | undefined;
  let candidatePackedPackageDirectory: string | undefined;
  let integrity: string | undefined;
  let output: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (!["--candidate-package", "--candidate-lock", "--candidate-packed-package", "--integrity", "--output"].includes(option)) {
      throw new TypeError(`Unknown tscircuit upgrade review option ${option}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`${option} requires one value`);
    index += 1;
    if (option === "--candidate-package") {
      if (candidatePackageDirectory !== undefined) throw new TypeError("--candidate-package may be specified only once");
      candidatePackageDirectory = value;
    } else if (option === "--candidate-lock") {
      if (candidateLockPath !== undefined) throw new TypeError("--candidate-lock may be specified only once");
      candidateLockPath = value;
    } else if (option === "--candidate-packed-package") {
      if (candidatePackedPackageDirectory !== undefined) throw new TypeError("--candidate-packed-package may be specified only once");
      candidatePackedPackageDirectory = value;
    } else if (option === "--integrity") {
      if (integrity !== undefined) throw new TypeError("--integrity may be specified only once");
      integrity = value;
    } else {
      if (output !== undefined) throw new TypeError("--output may be specified only once");
      output = value;
    }
  }
  if (candidatePackageDirectory === undefined) throw new TypeError("--candidate-package is required and no package will be installed");
  if (candidateLockPath === undefined) throw new TypeError("--candidate-lock is required");
  if (integrity === undefined) throw new TypeError("--integrity is required");
  return Object.freeze({
    candidatePackageDirectory,
    candidateLockPath,
    ...(candidatePackedPackageDirectory === undefined ? {} : { candidatePackedPackageDirectory }),
    integrity,
    ...(output === undefined ? {} : { output }),
  });
}

async function runChild(options: Readonly<{
  argv: readonly string[];
  cwd: string;
  label: string;
  timeoutMs: number;
}>): Promise<string> {
  return runBoundedAcceptanceChild(options);
}

async function copyFixtureSource(projectRoot: string, stageRoot: string): Promise<void> {
  const sourceFixtures = join(projectRoot, "test", "fixtures");
  const stagedFixtures = join(stageRoot, "test", "fixtures");
  await mkdir(stagedFixtures, { recursive: true });
  await cp(join(sourceFixtures, "canonical.ts"), join(stagedFixtures, "canonical.ts"));
  for (const name of CANONICAL_FIXTURE_NAMES) {
    const source = join(sourceFixtures, "canonical", name);
    const target = join(stagedFixtures, "canonical", name);
    await mkdir(target, { recursive: true });
    await cp(join(source, "circuit"), join(target, "circuit"), { recursive: true, errorOnExist: true });
    for (const file of ["expectation.json", "fulmetry.config.ts", "fulmetry.lock"]) {
      await cp(join(source, file), join(target, file));
    }
  }
}

async function stageNodeModules(
  sourceModules: string,
  stageRoot: string,
  candidatePackageRoot: string,
  integrity: string,
): Promise<string> {
  const targetModules = join(stageRoot, "node_modules");
  await mkdir(targetModules, { recursive: true });
  const entries = await readdir(sourceModules, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === "tscircuit") continue;
    await symlink(
      join(sourceModules, entry.name),
      join(targetModules, entry.name),
      process.platform === "win32" ? (entry.isDirectory() ? "junction" : "file") : undefined,
    );
  }
  const stagedCandidate = join(targetModules, "tscircuit");
  await symlink(
    candidatePackageRoot,
    stagedCandidate,
    process.platform === "win32" ? "junction" : undefined,
  );
  const stagedDescriptor = await inspectTscircuitCandidatePackage({
    packageDirectory: stagedCandidate,
    integrity,
    resolutionOrigin: stageRoot,
  });
  return stagedDescriptor.realPackageRoot;
}

async function createStage(
  projectRoot: string,
  sourceModules: string,
  candidatePackageRoot: string,
  integrity: string,
): Promise<string> {
  const stageRoot = await mkdtemp(join(tmpdir(), "fulmetry-tscircuit-review-"));
  try {
    await mkdir(join(stageRoot, "test", "helpers"), { recursive: true });
    await Promise.all([
      cp(join(projectRoot, "src"), join(stageRoot, "src"), { recursive: true, errorOnExist: true }),
      cp(join(projectRoot, "package.json"), join(stageRoot, "package.json")),
      cp(join(projectRoot, "test", "authoring-identity.test.ts"), join(stageRoot, "test", "authoring-identity.test.ts")),
      cp(
        join(projectRoot, "test", "helpers", "upgrade-engine-identity-process.ts"),
        join(stageRoot, "test", "helpers", "upgrade-engine-identity-process.ts"),
      ),
      cp(
        join(projectRoot, "test", "helpers", "upgrade-canonical-pipeline-process.ts"),
        join(stageRoot, "test", "helpers", "upgrade-canonical-pipeline-process.ts"),
      ),
    ]);
    await copyFixtureSource(projectRoot, stageRoot);
    await stageNodeModules(sourceModules, stageRoot, candidatePackageRoot, integrity);
    return stageRoot;
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

interface AuthenticatedBaselineEvidence {
  readonly engine: Readonly<{ version: string; integrity: string; contentSha256: string }>;
  readonly fixtures: TscircuitUpgradeSnapshot["fixtures"];
}

async function authenticatedBaselineEvidence(): Promise<Readonly<AuthenticatedBaselineEvidence>> {
  const fixtures = [];
  let engine: { version: string; integrity: string; contentSha256: string } | undefined;
  for (const name of CANONICAL_FIXTURE_NAMES) {
    const fixture = await loadCanonicalFixture(name);
    await validateCanonicalManifest({
      name,
      root: fixture.root,
      manifest: fixture.manifest,
      circuitJson: fixture.circuitJson,
    });
    const fixtureEngine = fixture.manifest.tscircuit;
    if (engine === undefined) engine = { ...fixtureEngine };
    else if (JSON.stringify(engine) !== JSON.stringify(fixtureEngine)) {
      throw new Error("Canonical baseline fixtures disagree on the accepted tscircuit identity");
    }
    fixtures.push({
      name,
      inputs: {
        setSha256: tscircuitUpgradeFileSetSha256(fixture.manifest.inputs.files),
        files: fixture.manifest.inputs.files,
      },
      semanticSha256: fixture.manifest.circuit.semanticSha256,
      manufacturing: {
        setSha256: tscircuitUpgradeFileSetSha256(fixture.manifest.manufacturing.files),
        files: fixture.manifest.manufacturing.files,
      },
    });
  }
  if (engine === undefined || fixtures.length !== CANONICAL_FIXTURE_NAMES.length) {
    throw new Error("Canonical baseline inventory is incomplete");
  }
  return Object.freeze({ engine, fixtures: Object.freeze(fixtures) });
}

interface CandidatePipelineOutput {
  readonly name: string;
  readonly inputs: { readonly setSha256: string; readonly files: readonly TscircuitUpgradeFileRecord[] };
  readonly semanticSha256: string;
  readonly manufacturing: { readonly setSha256: string; readonly files: readonly TscircuitUpgradeFileRecord[] };
  readonly verification: { readonly passed: true; readonly expectationSha256: string };
}

function parsePipelineOutput(text: string, expectedName: string): CandidatePipelineOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${expectedName} candidate pipeline wrote non-JSON output`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${expectedName} candidate pipeline output must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.name !== expectedName) throw new Error(`${expectedName} candidate pipeline returned the wrong fixture identity`);
  if (
    record.verification === null || typeof record.verification !== "object" ||
    (record.verification as { passed?: unknown }).passed !== true
  ) throw new Error(`${expectedName} candidate pipeline lacks successful manufacturing verification`);
  return value as CandidatePipelineOutput;
}

async function candidateSnapshot(options: Readonly<{
  stageRoot: string;
  stagedCandidateRoot: string;
  version: string;
  integrity: string;
  contentSha256: string;
  runtimeClosureSha256: string;
  packedConsumerRuntimeClosureSha256: string;
  dependencyLockSha256: string;
  timeoutMs: number;
  afterStageInputCaptured?: (stageRoot: string) => Promise<void>;
}>): Promise<Readonly<TscircuitUpgradeSnapshot>> {
  const initialStageIdentity = await stagedInputIdentitySha256(options.stageRoot);
  await options.afterStageInputCaptured?.(options.stageRoot);
  const requireUnchangedStage = async (): Promise<void> => {
    if (await stagedInputIdentitySha256(options.stageRoot) !== initialStageIdentity) {
      throw new Error("Staged source, test, fixture, or package inputs changed during qualification");
    }
  };
  await runChild({
    argv: [
      process.execPath,
      join(options.stageRoot, "test", "helpers", "upgrade-engine-identity-process.ts"),
      options.stagedCandidateRoot,
      options.version,
      options.contentSha256,
      options.runtimeClosureSha256,
    ],
    cwd: options.stageRoot,
    label: "Candidate physical engine identity check",
    timeoutMs: options.timeoutMs,
  });
  await requireUnchangedStage();
  await runChild({
    argv: [process.execPath, "test", join("test", "authoring-identity.test.ts")],
    cwd: options.stageRoot,
    label: "Complete candidate authoring identity test",
    timeoutMs: options.timeoutMs,
  });
  await requireUnchangedStage();

  const fixtures = [];
  for (const name of CANONICAL_FIXTURE_NAMES) {
    const run = () => runChild({
      argv: [
        process.execPath,
        join(options.stageRoot, "test", "helpers", "upgrade-canonical-pipeline-process.ts"),
        name,
      ],
      cwd: options.stageRoot,
      label: `${name} candidate canonical pipeline`,
      timeoutMs: options.timeoutMs,
    });
    const firstText = await run();
    await requireUnchangedStage();
    const secondText = await run();
    await requireUnchangedStage();
    if (firstText !== secondText) {
      throw new Error(`${name} candidate pipeline is nondeterministic across fresh parent processes`);
    }
    const result = parsePipelineOutput(firstText, name);
    fixtures.push({
      name,
      inputs: {
        files: result.inputs.files,
        setSha256: tscircuitUpgradeFileSetSha256(result.inputs.files),
      },
      semanticSha256: result.semanticSha256,
      manufacturing: {
        files: result.manufacturing.files,
        setSha256: tscircuitUpgradeFileSetSha256(result.manufacturing.files),
      },
    });
  }
  if (fixtures.length !== CANONICAL_FIXTURE_NAMES.length) {
    throw new Error("Candidate canonical fixture inventory is incomplete");
  }
  return {
    schemaVersion: 2,
    engine: {
      version: options.version,
      integrity: options.integrity,
      contentSha256: options.contentSha256,
      dependencyLockSha256: options.dependencyLockSha256,
      runtimePlatform: `${process.platform}-${process.arch}`,
      runtimeClosureSha256: options.runtimeClosureSha256,
      packedConsumerRuntimeClosureSha256: options.packedConsumerRuntimeClosureSha256,
    },
    qualification: QUALIFICATION,
    fixtures,
  } as Readonly<TscircuitUpgradeSnapshot>;
}

function validateOutputRelativePath(value: string): string {
  if (
    value.includes("\\") || ASCII_CONTROL_PATTERN.test(value) || isAbsolute(value) || /^[A-Za-z]:/u.test(value) ||
    !value.startsWith(".fulmetry/upgrade-reviews/") || !value.endsWith(".json") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new TypeError("Upgrade review output must be a safe project-relative .fulmetry/upgrade-reviews/*.json path");
  return value;
}

function outputRelativePath(output: string | undefined, report: TscircuitUpgradeReviewReport): string {
  return validateOutputRelativePath(output ??
    `.fulmetry/upgrade-reviews/tscircuit-${report.candidate.engine.version}-${report.reportSha256}.json`);
}

async function requireAbsentOutput(projectRoot: string, relativePath: string): Promise<void> {
  try {
    await lstat(resolve(projectRoot, ...relativePath.split("/")));
    throw new TypeError("Upgrade review output already exists and is immutable");
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists and is immutable")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function rejectSymlinkAncestors(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Upgrade review output traverses symlink ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Upgrade review output traverses")) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function atomicWriteReport(projectRoot: string, relativePath: string, contents: string): Promise<string> {
  await rejectSymlinkAncestors(projectRoot, relativePath);
  const target = resolve(projectRoot, ...relativePath.split("/"));
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`)) {
    throw new TypeError("Upgrade review output escapes the project root");
  }
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  if (!((await realpath(parent)) === projectRoot || (await realpath(parent)).startsWith(`${projectRoot}${sep}`))) {
    throw new TypeError("Upgrade review output parent escapes the project root");
  }
  try {
    await lstat(target);
    throw new TypeError("Upgrade review output already exists and is immutable");
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists and is immutable")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(parent, `.${basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

async function reviewInputIdentitySha256(projectRoot: string): Promise<string> {
  const roots = [
    "package.json",
    "bun.lock",
    "compatibility/tscircuit.json",
    "src",
    "scripts/review-tscircuit-upgrade.ts",
    "test/authoring-identity.test.ts",
    "test/helpers/upgrade-engine-identity-process.ts",
    "test/helpers/upgrade-canonical-pipeline-process.ts",
    "test/fixtures/canonical.ts",
    "test/fixtures/canonical",
  ];
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Upgrade review input contains a symlink: ${path}`);
    if (stat.isFile()) {
      files.push(path);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Upgrade review input contains a special entry: ${path}`);
    const entries = await readdir(path);
    entries.sort(compareText);
    for (const entry of entries) await walk(join(path, entry));
  };
  for (const root of roots) await walk(join(projectRoot, ...root.split("/")));
  files.sort(compareText);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of files) {
    hasher.update(relative(projectRoot, path).replaceAll("\\", "/"));
    hasher.update("\0");
    hasher.update(await readFile(path));
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

async function selectedInputIdentitySha256(
  root: string,
  roots: readonly string[],
  excludeNodeModules = false,
): Promise<string> {
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Authenticated input contains a symlink: ${path}`);
    if (stat.isFile()) {
      files.push(path);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Authenticated input contains a special entry: ${path}`);
    const entries = await readdir(path);
    entries.sort(compareText);
    for (const entry of entries) {
      if (excludeNodeModules && entry === "node_modules") continue;
      await walk(join(path, entry));
    }
  };
  for (const path of roots) await walk(join(root, ...path.split("/")));
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of files.sort(compareText)) {
    hasher.update(relative(root, path).replaceAll("\\", "/"));
    hasher.update("\0");
    hasher.update(await readFile(path));
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

export const UPGRADE_REVIEW_IMPLEMENTATION_INPUTS = Object.freeze([
  "package.json",
  "scripts/bounded-acceptance-child.ts",
  "scripts/review-tscircuit-upgrade.ts",
  "src",
  "test/authoring-identity.test.ts",
  "test/helpers/upgrade-engine-identity-process.ts",
  "test/helpers/upgrade-canonical-pipeline-process.ts",
  "test/fixtures/canonical.ts",
  "test/fixtures/canonical",
] as const);

async function reviewImplementationSha256(projectRoot: string): Promise<string> {
  return selectedInputIdentitySha256(projectRoot, UPGRADE_REVIEW_IMPLEMENTATION_INPUTS);
}

async function stagedInputIdentitySha256(stageRoot: string): Promise<string> {
  return selectedInputIdentitySha256(stageRoot, ["package.json", "src", "test"], true);
}

async function readCompatibilityAnchor(path: string): Promise<Readonly<{
  anchor: TscircuitCompatibilityAnchor;
  sha256: string;
}>> {
  const bytes = await readFile(path);
  return Object.freeze({
    anchor: parseTscircuitCompatibilityAnchorText(new TextDecoder().decode(bytes)),
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  });
}

function pathIsInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export async function reviewTscircuitUpgrade(
  options: ReviewTscircuitUpgradeOptions,
): Promise<Readonly<ReviewTscircuitUpgradeResult>> {
  requireSupportedBunRuntime();
  const bunVersion = requireSupportedUpgradeReviewBunVersion(Bun.version);
  const projectRoot = await realpath(options.projectRoot);
  if (projectRoot !== await realpath(MODULE_PROJECT_ROOT)) {
    throw new TypeError("Tscircuit upgrade review projectRoot must be this Fulmetry source repository");
  }
  if (typeof options.candidateLockPath !== "string" || options.candidateLockPath.length === 0) {
    throw new TypeError("candidateLockPath is required");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new TypeError("Tscircuit upgrade review timeout must be an integer from 1000 through 300000 ms");
  }
  const before = await inspectTscircuitCandidatePackage({
    packageDirectory: options.candidatePackageDirectory,
    integrity: options.integrity,
    resolutionOrigin: dirname(dirname(options.candidatePackageDirectory)),
  });
  let packedCandidate: Awaited<ReturnType<typeof inspectTscircuitCandidatePackage>> | undefined;
  if (options.candidatePackedPackageDirectory !== undefined) {
    packedCandidate = await inspectTscircuitCandidatePackage({
      packageDirectory: options.candidatePackedPackageDirectory,
      integrity: options.integrity,
      resolutionOrigin: dirname(dirname(options.candidatePackedPackageDirectory)),
    });
    if (
      packedCandidate.version !== before.version || packedCandidate.integrity !== before.integrity ||
      packedCandidate.contentSha256 !== before.contentSha256
    ) throw new Error("Clean packed-consumer tscircuit package does not match the candidate package identity");
    const repositoryNodeModulesRoot = await realpath(dirname(before.realPackageRoot));
    const packedNodeModulesRoot = await realpath(dirname(packedCandidate.realPackageRoot));
    if (
      packedCandidate.realPackageRoot === before.realPackageRoot ||
      packedNodeModulesRoot === repositoryNodeModulesRoot
    ) {
      throw new TypeError(
        "Clean packed-consumer profile must be a physically distinct installed package and node_modules root",
      );
    }
  }
  const candidateLockBefore = await inspectTscircuitDependencyLock({
    lockPath: options.candidateLockPath,
    candidatePackageRoot: before.realPackageRoot,
    expectedVersion: before.version,
    expectedIntegrity: before.integrity,
  });
  if (candidateLockBefore.installedClosureSha256 !== before.runtimeClosureSha256) {
    throw new Error("Candidate dependency lock install tree does not match the authenticated candidate closure");
  }
  if (options.publishReport !== false && options.output !== undefined) {
    const requestedOutput = validateOutputRelativePath(options.output);
    const requestedTarget = resolve(projectRoot, ...requestedOutput.split("/"));
    if (pathIsInside(before.realPackageRoot, requestedTarget)) {
      throw new TypeError("Upgrade review output must not be inside the candidate tscircuit package");
    }
    await requireAbsentOutput(projectRoot, requestedOutput);
  }
  const initialReviewInputIdentity = await reviewInputIdentitySha256(projectRoot);
  const initialReviewImplementationSha256 = await reviewImplementationSha256(projectRoot);
  const compatibilityPath = options.compatibilityAnchorPath ?? join(projectRoot, "compatibility", "tscircuit.json");
  const compatibility = await readCompatibilityAnchor(compatibilityPath);
  const baselineEvidence = await authenticatedBaselineEvidence();
  if (JSON.stringify(baselineEvidence.engine) !== JSON.stringify(compatibility.anchor.accepted)) {
    throw new Error("Authenticated canonical baseline engine does not match compatibility/tscircuit.json accepted anchor");
  }
  const acceptedBefore = await inspectTscircuitCandidatePackage({
    packageDirectory: join(projectRoot, "node_modules", "tscircuit"),
    integrity: baselineEvidence.engine.integrity,
    resolutionOrigin: projectRoot,
  });
  if (
    acceptedBefore.version !== baselineEvidence.engine.version ||
    acceptedBefore.integrity !== baselineEvidence.engine.integrity ||
    acceptedBefore.contentSha256 !== baselineEvidence.engine.contentSha256
  ) throw new Error("Installed accepted tscircuit package does not match the authenticated canonical baseline");
  const acceptedLockBefore = await inspectTscircuitDependencyLock({
    lockPath: join(projectRoot, "bun.lock"),
    candidatePackageRoot: acceptedBefore.realPackageRoot,
    expectedVersion: acceptedBefore.version,
    expectedIntegrity: acceptedBefore.integrity,
  });
  if (acceptedLockBefore.installedClosureSha256 !== acceptedBefore.runtimeClosureSha256) {
    throw new Error("Accepted dependency lock install tree does not match the authenticated engine closure");
  }
  const runtimePlatform = `${process.platform}-${process.arch}`;
  const qualifiedBaselineClosures = QUALIFIED_TSCIRCUIT_RUNTIME_CLOSURES[runtimePlatform] as readonly string[] | undefined;
  if (qualifiedBaselineClosures === undefined || !qualifiedBaselineClosures.includes(acceptedBefore.runtimeClosureSha256)) {
    throw new Error(`Installed accepted tscircuit runtime closure is not qualified on ${runtimePlatform}`);
  }
  if (compatibility.anchor.runtimeClosures[runtimePlatform]?.repository !== acceptedBefore.runtimeClosureSha256) {
    throw new Error(`Compatibility anchor repository closure does not match installed tscircuit on ${runtimePlatform}`);
  }
  const baselineEngine: TscircuitUpgradeSnapshot["engine"] = Object.freeze({
    ...baselineEvidence.engine,
    dependencyLockSha256: acceptedLockBefore.dependencyLockSha256,
    runtimePlatform,
    runtimeClosureSha256: acceptedBefore.runtimeClosureSha256,
    packedConsumerRuntimeClosureSha256: compatibility.anchor.runtimeClosures[runtimePlatform]!.packedConsumer,
  });

  const baselineStageRoot = await createStage(
    projectRoot,
    acceptedLockBefore.nodeModulesRoot,
    acceptedBefore.realPackageRoot,
    acceptedBefore.integrity,
  );
  let baselineQualification: TscircuitUpgradeSnapshot["qualification"] | undefined;
  try {
    const stagedAccepted = await inspectTscircuitCandidatePackage({
      packageDirectory: join(baselineStageRoot, "node_modules", "tscircuit"),
      integrity: acceptedBefore.integrity,
      resolutionOrigin: baselineStageRoot,
    });
    const executedBaseline = await candidateSnapshot({
      stageRoot: baselineStageRoot,
      stagedCandidateRoot: stagedAccepted.realPackageRoot,
      version: acceptedBefore.version,
      integrity: acceptedBefore.integrity,
      contentSha256: acceptedBefore.contentSha256,
      runtimeClosureSha256: stagedAccepted.runtimeClosureSha256,
      packedConsumerRuntimeClosureSha256: baselineEngine.packedConsumerRuntimeClosureSha256,
      dependencyLockSha256: acceptedLockBefore.dependencyLockSha256,
      timeoutMs,
    });
    const baseline: TscircuitUpgradeSnapshot = {
      schemaVersion: 2,
      engine: baselineEngine,
      qualification: executedBaseline.qualification,
      fixtures: baselineEvidence.fixtures,
    };
    const baselineCheck = createTscircuitUpgradeReview(baseline, executedBaseline, {
      expectedFixtureNames: CANONICAL_FIXTURE_NAMES,
      reviewImplementationSha256: initialReviewImplementationSha256,
      baselineAnchorSha256: compatibility.sha256,
      bunVersion,
    });
    if (baselineCheck.outcome !== "no-change") {
      throw new Error("Executed accepted tscircuit baseline does not reproduce authenticated canonical evidence");
    }
    baselineQualification = executedBaseline.qualification;
  } finally {
    await rm(baselineStageRoot, { recursive: true, force: true });
  }
  const acceptedAfter = await inspectTscircuitCandidatePackage({
    packageDirectory: join(projectRoot, "node_modules", "tscircuit"),
    integrity: baselineEvidence.engine.integrity,
    resolutionOrigin: projectRoot,
  });
  if (
    acceptedAfter.realPackageRoot !== acceptedBefore.realPackageRoot ||
    acceptedAfter.entryPath !== acceptedBefore.entryPath ||
    acceptedAfter.version !== acceptedBefore.version ||
    acceptedAfter.integrity !== acceptedBefore.integrity ||
    acceptedAfter.contentSha256 !== acceptedBefore.contentSha256
    || acceptedAfter.runtimeClosureSha256 !== acceptedBefore.runtimeClosureSha256
  ) throw new Error("Accepted baseline tscircuit package changed during qualification");
  if (baselineQualification === undefined) {
    throw new Error("Accepted baseline qualification did not complete");
  }
  if (before.version !== acceptedBefore.version && packedCandidate === undefined) {
    throw new TypeError("--candidate-packed-package is required for a real tscircuit version upgrade");
  }
  const candidatePackedClosure = packedCandidate?.runtimeClosureSha256 ??
    compatibility.anchor.runtimeClosures[runtimePlatform]!.packedConsumer;

  const stageRoot = await createStage(
    projectRoot,
    candidateLockBefore.nodeModulesRoot,
    before.realPackageRoot,
    before.integrity,
  );
  try {
    await options.stagePrepared?.(stageRoot);
    const stagedCandidate = await inspectTscircuitCandidatePackage({
      packageDirectory: join(stageRoot, "node_modules", "tscircuit"),
      integrity: before.integrity,
      resolutionOrigin: stageRoot,
    });
    if (
      stagedCandidate.version !== before.version ||
      stagedCandidate.contentSha256 !== before.contentSha256 ||
      stagedCandidate.integrity !== before.integrity
      || stagedCandidate.runtimeClosureSha256 !== before.runtimeClosureSha256
    ) throw new Error("Staged tscircuit candidate does not match the inspected package bytes");
    const candidate = await candidateSnapshot({
      stageRoot,
      stagedCandidateRoot: stagedCandidate.realPackageRoot,
      version: before.version,
      integrity: before.integrity,
      contentSha256: before.contentSha256,
      runtimeClosureSha256: stagedCandidate.runtimeClosureSha256,
      packedConsumerRuntimeClosureSha256: candidatePackedClosure,
      dependencyLockSha256: candidateLockBefore.dependencyLockSha256,
      timeoutMs,
      ...(options.afterStageInputCaptured === undefined
        ? {} : { afterStageInputCaptured: options.afterStageInputCaptured }),
    });
    const baseline: TscircuitUpgradeSnapshot = {
      schemaVersion: 2,
      engine: baselineEngine,
      qualification: baselineQualification,
      fixtures: baselineEvidence.fixtures,
    };
    const report = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: CANONICAL_FIXTURE_NAMES,
      reviewImplementationSha256: initialReviewImplementationSha256,
      baselineAnchorSha256: compatibility.sha256,
      bunVersion,
    });
    const after = await inspectTscircuitCandidatePackage({
      packageDirectory: options.candidatePackageDirectory,
      integrity: options.integrity,
      resolutionOrigin: dirname(dirname(options.candidatePackageDirectory)),
    });
    if (
      after.realPackageRoot !== before.realPackageRoot || after.entryPath !== before.entryPath ||
      after.version !== before.version || after.integrity !== before.integrity ||
      after.contentSha256 !== before.contentSha256
      || after.runtimeClosureSha256 !== before.runtimeClosureSha256
    ) throw new Error("Candidate tscircuit package changed during upgrade review");
    if (packedCandidate !== undefined) {
      const packedAfter = await inspectTscircuitCandidatePackage({
        packageDirectory: options.candidatePackedPackageDirectory!,
        integrity: options.integrity,
        resolutionOrigin: dirname(dirname(options.candidatePackedPackageDirectory!)),
      });
      if (
        packedAfter.realPackageRoot !== packedCandidate.realPackageRoot ||
        packedAfter.version !== packedCandidate.version || packedAfter.integrity !== packedCandidate.integrity ||
        packedAfter.contentSha256 !== packedCandidate.contentSha256 ||
        packedAfter.runtimeClosureSha256 !== packedCandidate.runtimeClosureSha256
      ) throw new Error("Clean packed-consumer tscircuit package changed during upgrade review");
    }
    const candidateLockAfter = await inspectTscircuitDependencyLock({
      lockPath: options.candidateLockPath,
      candidatePackageRoot: after.realPackageRoot,
      expectedVersion: after.version,
      expectedIntegrity: after.integrity,
    });
    if (
      candidateLockAfter.lockPath !== candidateLockBefore.lockPath ||
      candidateLockAfter.candidatePackageRoot !== candidateLockBefore.candidatePackageRoot ||
      candidateLockAfter.dependencyLockSha256 !== candidateLockBefore.dependencyLockSha256
      || candidateLockAfter.installedClosureSha256 !== candidateLockBefore.installedClosureSha256
    ) throw new Error("Candidate dependency lock changed during upgrade review");
    const acceptedFinal = await inspectTscircuitCandidatePackage({
      packageDirectory: join(projectRoot, "node_modules", "tscircuit"),
      integrity: baselineEvidence.engine.integrity,
      resolutionOrigin: projectRoot,
    });
    if (
      acceptedFinal.realPackageRoot !== acceptedBefore.realPackageRoot ||
      acceptedFinal.entryPath !== acceptedBefore.entryPath ||
      acceptedFinal.version !== acceptedBefore.version ||
      acceptedFinal.integrity !== acceptedBefore.integrity ||
      acceptedFinal.contentSha256 !== acceptedBefore.contentSha256
      || acceptedFinal.runtimeClosureSha256 !== acceptedBefore.runtimeClosureSha256
    ) throw new Error("Accepted baseline tscircuit package changed during upgrade review");
    if (await reviewInputIdentitySha256(projectRoot) !== initialReviewInputIdentity) {
      throw new Error("Fulmetry source or canonical review inputs changed during upgrade review");
    }
    if (await reviewImplementationSha256(projectRoot) !== initialReviewImplementationSha256) {
      throw new Error("Upgrade review implementation changed during upgrade review");
    }
    if ((await readCompatibilityAnchor(compatibilityPath)).sha256 !== compatibility.sha256) {
      throw new Error("Tscircuit compatibility anchor changed during upgrade review");
    }
    if (options.publishReport === false) {
      return Object.freeze({ outputPath: "", outputRelativePath: "", report });
    }
    const outputRelative = outputRelativePath(options.output, report);
    const prospectiveOutput = resolve(projectRoot, ...outputRelative.split("/"));
    if (pathIsInside(before.realPackageRoot, prospectiveOutput)) {
      throw new TypeError("Upgrade review output must not be inside the candidate tscircuit package");
    }
    const outputPath = await atomicWriteReport(
      projectRoot,
      outputRelative,
      canonicalTscircuitUpgradeReportJson(report),
    );
    return Object.freeze({ outputPath, outputRelativePath: outputRelative, report });
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const parsed = parseReviewTscircuitUpgradeArguments(process.argv.slice(2));
    const result = await reviewTscircuitUpgrade({
      projectRoot: MODULE_PROJECT_ROOT,
      candidatePackageDirectory: resolve(process.cwd(), parsed.candidatePackageDirectory),
      candidateLockPath: resolve(process.cwd(), parsed.candidateLockPath),
      ...(parsed.candidatePackedPackageDirectory === undefined ? {} : {
        candidatePackedPackageDirectory: resolve(process.cwd(), parsed.candidatePackedPackageDirectory),
      }),
      integrity: parsed.integrity,
      ...(parsed.output === undefined ? {} : { output: parsed.output }),
    });
    process.stdout.write(
      `Tscircuit upgrade review written to ${result.outputRelativePath}\n` +
        `Outcome: ${result.report.outcome}\n` +
        `Report SHA-256: ${result.report.reportSha256}\n` +
        "No lockfile, golden, or package pin was accepted or changed.\n",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
