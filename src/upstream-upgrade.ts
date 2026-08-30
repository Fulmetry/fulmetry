// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
export const TSCIRCUIT_UPGRADE_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const TSCIRCUIT_UPGRADE_REPORT_SCHEMA_VERSION = 3 as const;
export const TSCIRCUIT_UPGRADE_ACCEPTANCE_SCHEMA_VERSION = 1 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
const FIXTURE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export const TSCIRCUIT_UPGRADE_QUALIFICATION_NAMES = Object.freeze([
  "curatedExportIdentity",
  "mixedImportSemanticEquivalence",
  "deterministicDoubleEvaluation",
  "circuitJsonSchemaValidation",
  "independentManufacturingVerification",
] as const);

export type TscircuitUpgradeQualificationName =
  typeof TSCIRCUIT_UPGRADE_QUALIFICATION_NAMES[number];

export type TscircuitUpgradeQualificationMap = Readonly<
  Record<TscircuitUpgradeQualificationName, "passed">
>;

export interface TscircuitUpgradeFileRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface TscircuitUpgradeFileSetSnapshot {
  readonly setSha256: string;
  readonly files: readonly TscircuitUpgradeFileRecord[];
}

export interface TscircuitUpgradeFixtureSnapshot {
  readonly name: string;
  readonly inputs: TscircuitUpgradeFileSetSnapshot;
  readonly semanticSha256: string;
  readonly manufacturing: TscircuitUpgradeFileSetSnapshot;
}

export interface TscircuitUpgradeEngineSnapshot {
  readonly version: string;
  readonly integrity: string;
  readonly contentSha256: string;
  readonly dependencyLockSha256: string;
  readonly runtimePlatform: string;
  readonly runtimeClosureSha256: string;
  readonly packedConsumerRuntimeClosureSha256: string;
}

export interface TscircuitUpgradeSnapshot {
  readonly schemaVersion: typeof TSCIRCUIT_UPGRADE_SNAPSHOT_SCHEMA_VERSION;
  readonly engine: TscircuitUpgradeEngineSnapshot;
  readonly qualification: TscircuitUpgradeQualificationMap;
  readonly fixtures: readonly TscircuitUpgradeFixtureSnapshot[];
}

export interface TscircuitUpgradeChangedFileRecord {
  readonly path: string;
  readonly baseline: Readonly<{ size: number; sha256: string }>;
  readonly candidate: Readonly<{ size: number; sha256: string }>;
}

export interface TscircuitUpgradeFileChanges {
  readonly added: readonly TscircuitUpgradeFileRecord[];
  readonly removed: readonly TscircuitUpgradeFileRecord[];
  readonly changed: readonly TscircuitUpgradeChangedFileRecord[];
}

export interface TscircuitUpgradeFileSetReview extends TscircuitUpgradeFileChanges {
  readonly baselineSetSha256: string | null;
  readonly candidateSetSha256: string | null;
  readonly changedSet: boolean;
}

export interface TscircuitUpgradeFixtureReview {
  readonly name: string;
  readonly status: "added" | "removed" | "changed" | "unchanged";
  readonly semantic: Readonly<{
    baselineSha256: string | null;
    candidateSha256: string | null;
    changed: boolean;
  }>;
  readonly inputs: TscircuitUpgradeFileSetReview;
  readonly manufacturing: TscircuitUpgradeFileSetReview;
}

export interface TscircuitUpgradeReviewSide {
  readonly engine: TscircuitUpgradeEngineSnapshot & Readonly<{ identitySha256: string }>;
  readonly qualification: TscircuitUpgradeQualificationMap;
  readonly snapshotSha256: string;
}

export interface TscircuitUpgradeReviewReport {
  readonly schemaVersion: typeof TSCIRCUIT_UPGRADE_REPORT_SCHEMA_VERSION;
  readonly bunVersion: string;
  readonly outcome: "no-change" | "changes-require-review";
  readonly expectedFixtureNames: readonly string[];
  readonly reviewImplementationSha256: string;
  readonly baselineAnchorSha256: string;
  readonly baseline: TscircuitUpgradeReviewSide;
  readonly candidate: TscircuitUpgradeReviewSide;
  readonly inputIdentitySha256: string;
  readonly fixtures: readonly TscircuitUpgradeFixtureReview[];
  readonly reportSha256: string;
}

export interface TscircuitUpgradeAcceptanceBinding {
  readonly schemaVersion: typeof TSCIRCUIT_UPGRADE_ACCEPTANCE_SCHEMA_VERSION;
  readonly reportSha256: string;
  readonly baselineSnapshotSha256: string;
  readonly candidateSnapshotSha256: string;
  readonly baselineEngineIdentitySha256: string;
  readonly candidateEngineIdentitySha256: string;
  readonly inputIdentitySha256: string;
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} fields must be exactly ${expected.join(", ")}`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertCanonicalSha512Sri(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical sha512 SRI value`);
  }
  const match = SRI_PATTERN.exec(value);
  if (match === null || match[1]!.length % 4 !== 0) {
    throw new TypeError(`${label} must be a canonical sha512 SRI value`);
  }
  const decoded = Buffer.from(match[1]!, "base64");
  if (decoded.byteLength !== 64 || decoded.toString("base64") !== match[1]) {
    throw new TypeError(`${label} must contain exactly one canonical 64-byte sha512 digest`);
  }
}

function parseQualification(
  value: unknown,
  label: string,
): TscircuitUpgradeQualificationMap {
  assertRecord(value, label);
  assertExactKeys(value, TSCIRCUIT_UPGRADE_QUALIFICATION_NAMES, label);
  const qualification = Object.fromEntries(TSCIRCUIT_UPGRADE_QUALIFICATION_NAMES.map((name) => {
    if (value[name] !== "passed") {
      throw new TypeError(`${label}.${name} must be literal passed`);
    }
    return [name, "passed"];
  })) as Record<TscircuitUpgradeQualificationName, "passed">;
  return Object.freeze(qualification);
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Upgrade review evidence contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") {
    throw new TypeError(`Upgrade review evidence contains non-JSON ${typeof value}`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function assertSafeRelativePath(path: unknown, label: string): asserts path is string {
  if (
    typeof path !== "string" || path.length === 0 || path.includes("\\") || ASCII_CONTROL_PATTERN.test(path) ||
    path.startsWith("/") || /^[A-Za-z]:/u.test(path)
  ) {
    throw new TypeError(`${label} must be a canonical relative path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`${label} must not traverse or contain empty path segments`);
  }
}

function parseFileRecord(value: unknown, label: string): Readonly<TscircuitUpgradeFileRecord> {
  assertRecord(value, label);
  assertExactKeys(value, ["path", "sha256", "size"], label);
  assertSafeRelativePath(value.path, `${label}.path`);
  assertSha256(value.sha256, `${label}.sha256`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new TypeError(`${label}.size must be a non-negative safe integer`);
  }
  return Object.freeze({ path: value.path, size: value.size as number, sha256: value.sha256 });
}

export function tscircuitUpgradeFileSetSha256(
  files: readonly TscircuitUpgradeFileRecord[],
): string {
  return sha256(
    [...files]
      .sort((left, right) => compareText(left.path, right.path))
      .map((file) => `${file.path}\0${file.size}\0${file.sha256}\0`)
      .join(""),
  );
}

function parseFileSet(value: unknown, label: string): Readonly<TscircuitUpgradeFileSetSnapshot> {
  assertRecord(value, label);
  assertExactKeys(value, ["files", "setSha256"], label);
  assertSha256(value.setSha256, `${label}.setSha256`);
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new TypeError(`${label}.files must be a non-empty array`);
  }
  const files = value.files.map((file, index) => parseFileRecord(file, `${label}.files[${index}]`))
    .sort((left, right) => compareText(left.path, right.path));
  const duplicate = files.find((file, index) => index > 0 && files[index - 1]?.path === file.path);
  if (duplicate !== undefined) throw new TypeError(`${label} contains duplicate path ${duplicate.path}`);
  const actualSetSha256 = tscircuitUpgradeFileSetSha256(files);
  if (actualSetSha256 !== value.setSha256) {
    throw new TypeError(`${label}.setSha256 does not match its file records`);
  }
  return Object.freeze({ setSha256: value.setSha256, files: Object.freeze(files) });
}

function parseEngine(value: unknown, label: string): Readonly<TscircuitUpgradeEngineSnapshot> {
  assertRecord(value, label);
  assertExactKeys(value, [
    "contentSha256", "dependencyLockSha256", "integrity", "packedConsumerRuntimeClosureSha256",
    "runtimeClosureSha256", "runtimePlatform", "version",
  ], label);
  if (
    typeof value.version !== "string" || value.version.length > 128 ||
    ASCII_CONTROL_PATTERN.test(value.version) || !VERSION_PATTERN.test(value.version)
  ) {
    throw new TypeError(`${label}.version must be an exact semantic version`);
  }
  assertCanonicalSha512Sri(value.integrity, `${label}.integrity`);
  assertSha256(value.contentSha256, `${label}.contentSha256`);
  assertSha256(value.dependencyLockSha256, `${label}.dependencyLockSha256`);
  assertSha256(value.runtimeClosureSha256, `${label}.runtimeClosureSha256`);
  assertSha256(value.packedConsumerRuntimeClosureSha256, `${label}.packedConsumerRuntimeClosureSha256`);
  if (
    typeof value.runtimePlatform !== "string" ||
    !/^[a-z0-9]+-[a-z0-9_]+$/u.test(value.runtimePlatform)
  ) throw new TypeError(`${label}.runtimePlatform must be a canonical platform-architecture identifier`);
  return Object.freeze({
    version: value.version,
    integrity: value.integrity,
    contentSha256: value.contentSha256,
    dependencyLockSha256: value.dependencyLockSha256,
    runtimePlatform: value.runtimePlatform,
    runtimeClosureSha256: value.runtimeClosureSha256,
    packedConsumerRuntimeClosureSha256: value.packedConsumerRuntimeClosureSha256,
  });
}

function parseFixture(value: unknown, label: string): Readonly<TscircuitUpgradeFixtureSnapshot> {
  assertRecord(value, label);
  assertExactKeys(value, ["inputs", "manufacturing", "name", "semanticSha256"], label);
  if (
    typeof value.name !== "string" || !FIXTURE_NAME_PATTERN.test(value.name) ||
    value.name === "." || value.name === ".."
  ) {
    throw new TypeError(`${label}.name must be a safe fixture identifier`);
  }
  assertSha256(value.semanticSha256, `${label}.semanticSha256`);
  return Object.freeze({
    name: value.name,
    inputs: parseFileSet(value.inputs, `${label}.inputs`),
    semanticSha256: value.semanticSha256,
    manufacturing: parseFileSet(value.manufacturing, `${label}.manufacturing`),
  });
}

export function parseTscircuitUpgradeSnapshot(
  value: unknown,
  label = "tscircuit upgrade snapshot",
): Readonly<TscircuitUpgradeSnapshot> {
  assertRecord(value, label);
  assertExactKeys(value, ["engine", "fixtures", "qualification", "schemaVersion"], label);
  if (value.schemaVersion !== TSCIRCUIT_UPGRADE_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(`${label}.schemaVersion must be ${TSCIRCUIT_UPGRADE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.fixtures) || value.fixtures.length === 0) {
    throw new TypeError(`${label}.fixtures must be a non-empty array`);
  }
  const fixtures = value.fixtures.map((fixture, index) => parseFixture(fixture, `${label}.fixtures[${index}]`))
    .sort((left, right) => compareText(left.name, right.name));
  const duplicate = fixtures.find((fixture, index) => index > 0 && fixtures[index - 1]?.name === fixture.name);
  if (duplicate !== undefined) throw new TypeError(`${label} contains duplicate fixture ${duplicate.name}`);
  return Object.freeze({
    schemaVersion: TSCIRCUIT_UPGRADE_SNAPSHOT_SCHEMA_VERSION,
    engine: parseEngine(value.engine, `${label}.engine`),
    qualification: parseQualification(value.qualification, `${label}.qualification`),
    fixtures: Object.freeze(fixtures),
  });
}

function engineIdentitySha256(engine: TscircuitUpgradeEngineSnapshot): string {
  return sha256(canonicalJson(engine));
}

function snapshotSha256(snapshot: TscircuitUpgradeSnapshot): string {
  return sha256(canonicalJson(snapshot));
}

function fileChanges(
  baseline: readonly TscircuitUpgradeFileRecord[],
  candidate: readonly TscircuitUpgradeFileRecord[],
): Readonly<TscircuitUpgradeFileChanges> {
  const baselineByPath = new Map(baseline.map((file) => [file.path, file]));
  const candidateByPath = new Map(candidate.map((file) => [file.path, file]));
  const added = candidate.filter((file) => !baselineByPath.has(file.path));
  const removed = baseline.filter((file) => !candidateByPath.has(file.path));
  const changed = baseline.flatMap((file): TscircuitUpgradeChangedFileRecord[] => {
    const replacement = candidateByPath.get(file.path);
    if (replacement === undefined || (replacement.size === file.size && replacement.sha256 === file.sha256)) return [];
    return [{
      path: file.path,
      baseline: Object.freeze({ size: file.size, sha256: file.sha256 }),
      candidate: Object.freeze({ size: replacement.size, sha256: replacement.sha256 }),
    }];
  });
  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
  });
}

function fileSetReview(
  baseline: TscircuitUpgradeFileSetSnapshot | undefined,
  candidate: TscircuitUpgradeFileSetSnapshot | undefined,
): Readonly<TscircuitUpgradeFileSetReview> {
  return Object.freeze({
    baselineSetSha256: baseline?.setSha256 ?? null,
    candidateSetSha256: candidate?.setSha256 ?? null,
    changedSet: baseline?.setSha256 !== candidate?.setSha256,
    ...fileChanges(baseline?.files ?? [], candidate?.files ?? []),
  });
}

function fixtureReview(
  name: string,
  baseline: TscircuitUpgradeFixtureSnapshot | undefined,
  candidate: TscircuitUpgradeFixtureSnapshot | undefined,
): Readonly<TscircuitUpgradeFixtureReview> {
  const semantic = Object.freeze({
    baselineSha256: baseline?.semanticSha256 ?? null,
    candidateSha256: candidate?.semanticSha256 ?? null,
    changed: baseline?.semanticSha256 !== candidate?.semanticSha256,
  });
  const inputs = fileSetReview(baseline?.inputs, candidate?.inputs);
  const manufacturing = fileSetReview(baseline?.manufacturing, candidate?.manufacturing);
  const status = baseline === undefined
    ? "added"
    : candidate === undefined
    ? "removed"
    : semantic.changed || inputs.changedSet || manufacturing.changedSet
    ? "changed"
    : "unchanged";
  return Object.freeze({ name, status, semantic, inputs, manufacturing });
}

function reportPayload(report: Record<string, unknown>): Record<string, unknown> {
  const { reportSha256: _excluded, ...payload } = report;
  return payload;
}

export function tscircuitUpgradeReportSha256(report: unknown): string {
  assertRecord(report, "tscircuit upgrade report");
  return sha256(canonicalJson(reportPayload(report)));
}

export function canonicalTscircuitUpgradeReportJson(report: TscircuitUpgradeReviewReport): string {
  return `${canonicalJson(report)}\n`;
}

function parseExpectedFixtureNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("expectedFixtureNames must be an explicit non-empty array");
  }
  const names = value.map((name, index) => {
    if (
      typeof name !== "string" || !FIXTURE_NAME_PATTERN.test(name) ||
      name === "." || name === ".."
    ) {
      throw new TypeError(`expectedFixtureNames[${index}] must be a safe fixture identifier`);
    }
    return name;
  }).sort(compareText);
  const duplicate = names.find((name, index) => index > 0 && names[index - 1] === name);
  if (duplicate !== undefined) {
    throw new TypeError(`expectedFixtureNames contains duplicate fixture ${duplicate}`);
  }
  return Object.freeze(names);
}

function requireExactFixtureInventory(
  snapshot: TscircuitUpgradeSnapshot,
  expectedFixtureNames: readonly string[],
  label: string,
): void {
  const actual = snapshot.fixtures.map(({ name }) => name);
  if (canonicalJson(actual) === canonicalJson(expectedFixtureNames)) return;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expectedFixtureNames);
  const missing = expectedFixtureNames.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));
  throw new TypeError(
    `${label} fixture inventory does not match expectedFixtureNames` +
    `${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}` +
    `${extra.length === 0 ? "" : `; extra: ${extra.join(", ")}`}`,
  );
}

export function createTscircuitUpgradeReview(
  baselineInput: unknown,
  candidateInput: unknown,
  options: Readonly<{
    expectedFixtureNames: readonly string[];
    reviewImplementationSha256: string;
    baselineAnchorSha256: string;
    bunVersion: string;
  }>,
): Readonly<TscircuitUpgradeReviewReport> {
  const expectedFixtureNames = parseExpectedFixtureNames(options?.expectedFixtureNames);
  assertSha256(options?.reviewImplementationSha256, "reviewImplementationSha256");
  assertSha256(options?.baselineAnchorSha256, "baselineAnchorSha256");
  if (
    typeof options?.bunVersion !== "string" || options.bunVersion.length > 128 ||
    ASCII_CONTROL_PATTERN.test(options.bunVersion) || !VERSION_PATTERN.test(options.bunVersion)
  ) throw new TypeError("bunVersion must be an exact semantic version");
  const baseline = parseTscircuitUpgradeSnapshot(baselineInput, "baseline snapshot");
  const candidate = parseTscircuitUpgradeSnapshot(candidateInput, "candidate snapshot");
  requireExactFixtureInventory(baseline, expectedFixtureNames, "baseline snapshot");
  requireExactFixtureInventory(candidate, expectedFixtureNames, "candidate snapshot");
  const baselineByName = new Map(baseline.fixtures.map((fixture) => [fixture.name, fixture]));
  const candidateByName = new Map(candidate.fixtures.map((fixture) => [fixture.name, fixture]));
  const fixtures = Object.freeze(expectedFixtureNames.map((name) =>
    fixtureReview(name, baselineByName.get(name), candidateByName.get(name))
  ));
  const inputIdentitySha256 = sha256(canonicalJson(fixtures.map((fixture) => ({
    name: fixture.name,
    baselineSetSha256: fixture.inputs.baselineSetSha256,
    candidateSetSha256: fixture.inputs.candidateSetSha256,
  }))));
  const side = (snapshot: TscircuitUpgradeSnapshot): TscircuitUpgradeReviewSide => Object.freeze({
    engine: Object.freeze({ ...snapshot.engine, identitySha256: engineIdentitySha256(snapshot.engine) }),
    qualification: snapshot.qualification,
    snapshotSha256: snapshotSha256(snapshot),
  });
  const baselineSide = side(baseline);
  const candidateSide = side(candidate);
  const outcome =
    baselineSide.engine.identitySha256 !== candidateSide.engine.identitySha256 ||
      baselineSide.snapshotSha256 !== candidateSide.snapshotSha256 ||
      fixtures.some(({ status }) => status !== "unchanged")
      ? "changes-require-review"
      : "no-change";
  const payload = Object.freeze({
    schemaVersion: TSCIRCUIT_UPGRADE_REPORT_SCHEMA_VERSION,
    bunVersion: options.bunVersion,
    outcome,
    expectedFixtureNames,
    reviewImplementationSha256: options.reviewImplementationSha256,
    baselineAnchorSha256: options.baselineAnchorSha256,
    baseline: baselineSide,
    candidate: candidateSide,
    inputIdentitySha256,
    fixtures,
  });
  return Object.freeze({ ...payload, reportSha256: sha256(canonicalJson(payload)) });
}

export function createTscircuitUpgradeAcceptanceBinding(
  report: TscircuitUpgradeReviewReport,
  options: Readonly<{ reviewedReportSha256: string }>,
): Readonly<TscircuitUpgradeAcceptanceBinding> {
  if (tscircuitUpgradeReportSha256(report) !== report.reportSha256) {
    throw new TypeError("Cannot accept a tscircuit upgrade report with an invalid digest");
  }
  assertSha256(options?.reviewedReportSha256, "reviewedReportSha256");
  if (options.reviewedReportSha256 !== report.reportSha256) {
    throw new TypeError("reviewedReportSha256 does not match the exact tscircuit upgrade report");
  }
  return Object.freeze({
    schemaVersion: TSCIRCUIT_UPGRADE_ACCEPTANCE_SCHEMA_VERSION,
    reportSha256: report.reportSha256,
    baselineSnapshotSha256: report.baseline.snapshotSha256,
    candidateSnapshotSha256: report.candidate.snapshotSha256,
    baselineEngineIdentitySha256: report.baseline.engine.identitySha256,
    candidateEngineIdentitySha256: report.candidate.engine.identitySha256,
    inputIdentitySha256: report.inputIdentitySha256,
  });
}

function parseAcceptanceBinding(value: unknown): Readonly<TscircuitUpgradeAcceptanceBinding> {
  assertRecord(value, "tscircuit upgrade acceptance binding");
  assertExactKeys(value, [
    "baselineEngineIdentitySha256",
    "baselineSnapshotSha256",
    "candidateEngineIdentitySha256",
    "candidateSnapshotSha256",
    "inputIdentitySha256",
    "reportSha256",
    "schemaVersion",
  ], "tscircuit upgrade acceptance binding");
  if (value.schemaVersion !== TSCIRCUIT_UPGRADE_ACCEPTANCE_SCHEMA_VERSION) {
    throw new TypeError(`tscircuit upgrade acceptance binding.schemaVersion must be ${TSCIRCUIT_UPGRADE_ACCEPTANCE_SCHEMA_VERSION}`);
  }
  for (const field of [
    "reportSha256", "baselineSnapshotSha256", "candidateSnapshotSha256",
    "baselineEngineIdentitySha256", "candidateEngineIdentitySha256", "inputIdentitySha256",
  ] as const) assertSha256(value[field], `tscircuit upgrade acceptance binding.${field}`);
  const reportSha256 = value.reportSha256 as string;
  const baselineSnapshotSha256 = value.baselineSnapshotSha256 as string;
  const candidateSnapshotSha256 = value.candidateSnapshotSha256 as string;
  const baselineEngineIdentitySha256 = value.baselineEngineIdentitySha256 as string;
  const candidateEngineIdentitySha256 = value.candidateEngineIdentitySha256 as string;
  const inputIdentitySha256 = value.inputIdentitySha256 as string;
  return Object.freeze({
    schemaVersion: TSCIRCUIT_UPGRADE_ACCEPTANCE_SCHEMA_VERSION,
    reportSha256,
    baselineSnapshotSha256,
    candidateSnapshotSha256,
    baselineEngineIdentitySha256,
    candidateEngineIdentitySha256,
    inputIdentitySha256,
  });
}

/**
 * Verifies a separately reviewed digest against pure comparison evidence.
 * The mutation boundary remains responsible for recapturing package, source,
 * lock, and artifact bytes immediately before it writes any accepted update.
 */
export function requireAcceptedTscircuitUpgrade(options: Readonly<{
  baseline: unknown;
  candidate: unknown;
  report: unknown;
  binding?: unknown;
  reviewedReportSha256?: unknown;
  expectedFixtureNames: readonly string[];
  reviewImplementationSha256: string;
  baselineAnchorSha256: string;
  bunVersion: string;
}>): Readonly<TscircuitUpgradeReviewReport> {
  if (options.binding === undefined) {
    throw new TypeError("A tscircuit upgrade acceptance binding is required");
  }
  if (options.reviewedReportSha256 === undefined) {
    throw new TypeError("An explicit reviewedReportSha256 is required at the acceptance boundary");
  }
  assertSha256(options.reviewedReportSha256, "reviewedReportSha256");
  assertRecord(options.report, "tscircuit upgrade report");
  assertSha256(options.report.reportSha256, "tscircuit upgrade report.reportSha256");
  if (tscircuitUpgradeReportSha256(options.report) !== options.report.reportSha256) {
    throw new TypeError("Tscircuit upgrade report digest does not match its contents");
  }
  if (options.reviewedReportSha256 !== options.report.reportSha256) {
    throw new TypeError("reviewedReportSha256 does not match the exact tscircuit upgrade report");
  }
  const expectedReport = createTscircuitUpgradeReview(options.baseline, options.candidate, {
    expectedFixtureNames: options.expectedFixtureNames,
    reviewImplementationSha256: options.reviewImplementationSha256,
    baselineAnchorSha256: options.baselineAnchorSha256,
    bunVersion: options.bunVersion,
  });
  if (canonicalJson(options.report) !== canonicalJson(expectedReport)) {
    throw new TypeError("Tscircuit upgrade report does not match the exact baseline and candidate snapshots");
  }
  const binding = parseAcceptanceBinding(options.binding);
  const expectedBinding = createTscircuitUpgradeAcceptanceBinding(expectedReport, {
    reviewedReportSha256: options.reviewedReportSha256,
  });
  if (canonicalJson(binding) !== canonicalJson(expectedBinding)) {
    throw new TypeError("Tscircuit upgrade acceptance binding is stale or does not match the exact report and identities");
  }
  return expectedReport;
}
