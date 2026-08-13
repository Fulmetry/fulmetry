// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { defineDiagnostic, diagnosticId, type Diagnostic } from "../diagnostics";
import { requireSupportedBunRuntime } from "../runtime";
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { parseCanonicalCircuitJson } from "../circuit-json";
import { readBoundedRegularFile } from "../internal/bounded-file";
import { assessCircuitElectrical } from "../electrical";
import { assessCircuitFabrication } from "../fabrication";
import { evaluateProjectCircuitTwice } from "../project/evaluate";
import { loadProjectConfig, type PcbooConfig } from "../project/config";
import { parsePcbooLock, type PcbooLock } from "../project/lock";
import { requireTscircuitIdentity } from "../engine-identity";
import {
  requireRuntimeEvidencePackageIdentity,
  RUNTIME_EVIDENCE_PACKAGE_PINS,
  type RuntimeEvidencePackageIdentity,
} from "../evidence-identity";
import { discoverProjectSourceGraph } from "../project/source-graph";
import { digestProjectInputs } from "../project/input-digest";
import {
  deriveCircuitEntityHierarchy,
  deriveEntityProvenance,
  enrichDiagnosticProvenance,
  ENTITY_PROVENANCE_LIMIT,
  ENTITY_PROVENANCE_PATH_DEPTH_LIMIT,
  type VerifiedEntityProvenance,
} from "../project/provenance";
import {
  BASELINE_FABRICATION_PROFILE,
  resolveFabricationProfile,
  type ActiveFabricationProfile,
} from "../profiles/baseline";
import {
  MANUFACTURING_ADAPTER_VERSIONS,
} from "../manufacturing/export";
import {
  deriveManufacturingExpectation,
  manufacturingExpectationSha256,
  type ManufacturingExpectation,
} from "../manufacturing/expectation";
import { verifyManufacturingDirectory } from "../manufacturing/verify";
import {
  requireManufacturingPackageIdentity,
  type ManufacturingPackageIdentity,
  MANUFACTURING_PACKAGE_PINS,
} from "../manufacturing/identity";
import {
  assuranceStatus,
  isAssurancePassing,
  STATUS_DIMENSIONS,
  statusSet,
  type AssuranceStatus,
  type StatusDimension,
  type StatusSet,
} from "../status";
import {
  assessBaselinePreCompliance,
  type PreComplianceEvidence,
} from "../standards";
import {
  assessRecordedSourcing,
  type RecordedSourcingEvidence,
} from "../sourcing";
import { sourcingStatus } from "../status";
import {
  authenticateFunctionalSimulationAuthority,
  type IssuedFunctionalSimulationAuthority,
} from "../simulation/ngspice";
import type { SimulationResultEvidence } from "../simulation/result";
import { requirePcbooVersion } from "../version";
import { isValidWaiverDate, loadDeclaredWaivers } from "../waivers";
import {
  BUILD_INPUT_ROLES,
  BUILD_INPUT_SNAPSHOT_SCHEMA_VERSION,
  refreshBuildInputSnapshot,
  type BuildInputSnapshot,
} from "./inputs";
import {
  ARTIFACT_MANIFEST_ENTRY_LIMIT,
  ARTIFACT_MANIFEST_FILE_BYTES_LIMIT,
  ARTIFACT_MANIFEST_KIND_LENGTH_LIMIT,
  ARTIFACT_MANIFEST_PATH_DEPTH_LIMIT,
  ARTIFACT_MANIFEST_PATH_LENGTH_LIMIT,
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT,
  verifyArtifactManifest,
  type ArtifactEntry,
  type ArtifactManifest,
} from "./manifest";

export const VERIFIED_BUNDLE_SCHEMA_VERSION = 2 as const;
export const VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT = 4 * 1024 * 1024;
const BOARD_REVISION_DIAGNOSTIC_ID = "FAB_BOARD_REVISION_SILKSCREEN_001";
const ASSET_NOTICES_FILENAME = "THIRD_PARTY_NOTICES.md";
const ASSET_LICENSE_NOTICE_BYTES_LIMIT = 256 * 1024;
const VERIFIED_ASSET_NOTICE_COUNT_LIMIT = 128;
const VERIFIED_ASSET_NOTICE_TOTAL_BYTES_LIMIT = VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT;

export type ProductionReadinessFindingCode =
  | "DRAFT_MANIFEST_REQUIRED"
  | "BOARD_REVISION_REQUIRED"
  | "BOARD_REVISION_MISMATCH"
  | "FABRICATION_PROFILE_REQUIRED"
  | "FABRICATION_PROFILE_INVALID"
  | "TSCIRCUIT_IDENTITY_INVALID"
  | "MANUFACTURING_TOOL_IDENTITY_INVALID"
  | "RUNTIME_EVIDENCE_IDENTITY_INVALID"
  | "EXTERNAL_TOOL_EVIDENCE_INVALID"
  | "BUILD_INPUT_STALE"
  | "BUILD_INPUT_INCOMPLETE"
  | "ARTIFACT_INTEGRITY_FAILED"
  | "MANUFACTURING_VERIFICATION_FAILED"
  | "MANUFACTURING_EXPECTATION_MISMATCH"
  | "ELECTRICAL_EVIDENCE_MISMATCH"
  | "CIRCUIT_JSON_EVIDENCE_INVALID"
  | "FABRICATION_EVIDENCE_MISMATCH"
  | "STANDARDS_EVIDENCE_MISMATCH"
  | "SOURCING_EVIDENCE_MISMATCH"
  | "SOURCE_CIRCUIT_MISMATCH"
  | "SOURCE_EVALUATION_FAILED"
  | "REQUIRED_DIMENSION_EVIDENCE_UNAVAILABLE"
  | "UNVERIFIED_STATUS_CLAIM"
  | "REQUIRED_STATUS_NOT_PASSING"
  | "STATUS_DIAGNOSTIC_MISSING"
  | "WAIVER_EVIDENCE_INVALID"
  | "WAIVER_EXPIRED"
  | "DIAGNOSTIC_PROVENANCE_INCOMPLETE"
  | "ENTITY_PROVENANCE_INCOMPLETE"
  | "ACTIVE_REQUIRED_ERROR"
  | "ASSET_LICENSE_EVIDENCE_INVALID"
  | "ASSET_REDISTRIBUTION_PROHIBITED";

export interface VerifiedAssetNotice {
  readonly name: string;
  readonly source: string;
  readonly version: string;
  readonly digest: string;
  readonly license: string;
  readonly attribution: string;
  readonly licenseNotice: string;
  readonly licenseNoticeDigest: string;
  readonly licenseNoticeText: string;
  readonly redistribution: "allowed";
}

export interface ProductionReadinessFinding {
  readonly code: ProductionReadinessFindingCode;
  readonly message: string;
}

export interface ProductionReadiness {
  readonly eligible: boolean;
  readonly findings: readonly ProductionReadinessFinding[];
}

export interface BundleWaiver {
  readonly diagnosticId: string;
  readonly dimension: StatusDimension;
  readonly scope: string;
  readonly justification: string;
  readonly expiresAt?: string;
}

export interface FunctionalSimulationManifestEvidence {
  readonly schemaVersion: 1;
  readonly resultSchemaVersion: 2;
  readonly resultSha256: string;
  readonly inputSnapshotDigest: string;
  readonly definitionDigest: string;
  readonly circuitDigest: string;
  readonly netlistDigest: string;
  readonly qualificationSha256: string;
  readonly modelDigests: Readonly<Record<string, string>>;
  readonly adapter: Readonly<{ name: "pcboo-ngspice"; version: string }>;
  readonly tool: Readonly<{ name: "ngspice"; version: string; executableSha256: string }>;
  readonly execution: Readonly<{
    stdoutSha256: string;
    stderrSha256: string;
    rawOutputSha256: string;
  }>;
}

export interface VerifiedBundleManifest {
  readonly schemaVersion: typeof VERIFIED_BUNDLE_SCHEMA_VERSION;
  readonly lifecycle: "verified";
  readonly boardRevision: string;
  /** UTC date on which waiver expiry was evaluated by the promotion host. */
  readonly evaluationDate: string;
  /** Informational host timestamp; excluded from build-input and semantic digests. */
  readonly generatedAt: string;
  readonly sourceControl: {
    readonly state: "not-assessed";
    readonly reason: string;
  };
  readonly toolVersions: {
    readonly pcboo: string;
    readonly bun: string;
  };
  readonly inputSnapshot: BuildInputSnapshot;
  readonly artifacts: readonly ArtifactEntry[];
  readonly statuses: StatusSet;
  readonly diagnostics: readonly Diagnostic[];
  /** Independently derived hierarchy and nearest honest source for manufactured entities. */
  readonly entityProvenance: readonly VerifiedEntityProvenance[];
  readonly requiredDimensions: readonly StatusDimension[];
  readonly waivers: readonly BundleWaiver[];
  readonly adapterVersions: typeof MANUFACTURING_ADAPTER_VERSIONS;
  readonly externalToolVersions: Readonly<Record<string, string>>;
  readonly manufacturingVerification: {
    readonly parser: "gerber-parser@4.2.7";
  };
  readonly standardsEvidence?: PreComplianceEvidence;
  readonly sourcingEvidence?: RecordedSourcingEvidence;
  readonly functionalEvidence?: FunctionalSimulationManifestEvidence;
  /** Exact source/license records for every asset admitted to this redistributable bundle. */
  readonly assetNotices: readonly VerifiedAssetNotice[];
  /** Present only when third-party assets are incorporated into the bundle. */
  readonly assetNoticeArtifact?: ArtifactEntry;
  readonly activeProfiles: readonly ActiveFabricationProfile[];
  readonly capabilities: {
    readonly boardCount: 1;
    readonly layerCount: 2 | 4;
    readonly viaTechnology: "through-via";
    readonly fabricationRules: readonly string[];
    readonly manufacturingArtifacts: readonly string[];
    readonly independentParser: "gerber-parser@4.2.7";
  };
  readonly knownGaps: readonly string[];
  readonly tscircuit: {
    readonly version: string;
    readonly integrity: string;
    readonly contentSha256: string;
    readonly runtimeClosureSha256: string;
  };
  readonly manufacturingPackages: Readonly<
    Record<keyof typeof MANUFACTURING_PACKAGE_PINS, ManufacturingPackageIdentity>
  >;
  readonly runtimeEvidencePackages: Readonly<
    Record<keyof typeof RUNTIME_EVIDENCE_PACKAGE_PINS, RuntimeEvidencePackageIdentity>
  >;
  /** PCBoo does not currently create or imply cryptographic signatures. */
  readonly cryptographicSignature: "absent";
}

export interface PromoteProductionBundleOptions {
  readonly artifactRoot: string;
  readonly projectRoot: string;
  readonly draftManifest: ArtifactManifest;
  readonly inputSnapshot: BuildInputSnapshot;
  readonly manufacturingExpectation: ManufacturingExpectation;
  readonly statuses: StatusSet;
  readonly diagnostics?: readonly Diagnostic[];
  readonly additionallyRequiredDimensions?: readonly StatusDimension[];
  readonly externalToolVersions?: Readonly<Record<string, string>>;
  /** Same-process authority issued by a qualified simulation bound to this build epoch. */
  readonly functionalSimulationAuthority?: Readonly<IssuedFunctionalSimulationAuthority>;
  readonly signal?: AbortSignal;
}

export interface PublishVerifiedProductionBundleOptions extends PromoteProductionBundleOptions {
  readonly destinationDirectory: string;
  /** @internal Deterministic race/staleness test hook; ordinary callers must not use it. */
  readonly beforeCommit?: () => Promise<void>;
  /** @internal Runs after artifacts move but before the validity boundary commits. */
  readonly beforeValidityCommit?: () => Promise<void>;
  /** @internal Deterministic external-writer race hook after synchronous hashing. */
  readonly afterSynchronousRecordedFiles?: () => void;
  /** @internal Failure-injection hook before authenticated staging cleanup. */
  readonly beforeStagingCleanup?: () => Promise<void>;
}

export interface PublishedVerifiedProductionBundle {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly artifactCount: number;
}

export type PublishedBundleIntegrityFindingCode =
  | "MANIFEST_INVALID"
  | "MANIFEST_DIGEST_MISMATCH"
  | "ARTIFACT_TYPE_INVALID"
  | "ASSET_NOTICE_LINK_INVALID"
  | "ENTITY_PROVENANCE_INVALID"
  | "FUNCTIONAL_EVIDENCE_INVALID"
  | "ARTIFACT_INTEGRITY_FAILED"
  | "BUNDLE_INVENTORY_MISMATCH";

export interface PublishedBundleIntegrityFinding {
  readonly code: PublishedBundleIntegrityFindingCode;
  readonly message: string;
  readonly path?: string;
}

export interface PublishedBundleVerification {
  readonly integrityValid: boolean;
  readonly manifestSha256?: string;
  readonly artifactCount: number;
  readonly findings: readonly PublishedBundleIntegrityFinding[];
}

export interface VerifyPublishedProductionBundleOptions {
  /** The out-of-band digest returned by publication; this is the manifest trust authority. */
  readonly expectedManifestSha256: string;
  /** @internal Deterministic filesystem-race hook for verification tests. */
  readonly afterArtifactIntegrity?: () => void | Promise<void>;
}

interface CapturedPromoteProductionBundleOptions extends PromoteProductionBundleOptions {}

function throwIfPromotionCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Production bundle promotion was cancelled");
}

function boundedFailureDetails(
  values: readonly string[],
  separator: string,
  inspectCommand: string,
  itemLimit = 16,
  characterLimit = 8_192,
): string {
  const retained: string[] = [];
  let characters = 0;
  let index = 0;
  for (; index < values.length && retained.length < itemLimit; index += 1) {
    const value = values[index]!.slice(0, 1_024);
    const added = value.length + (retained.length === 0 ? 0 : separator.length);
    if (characters + added > characterLimit) break;
    retained.push(value);
    characters += added;
  }
  const omitted = values.length - index;
  return `${retained.join(separator)}${omitted > 0
    ? `${retained.length > 0 ? separator : ""}…(+${omitted} omitted; ${inspectCommand})`
    : ""}`;
}

interface Evaluation extends ProductionReadiness {
  readonly evaluationDate: string;
  readonly evaluationTimestamp: string;
  readonly currentSnapshot: BuildInputSnapshot;
  readonly statuses: StatusSet;
  readonly diagnostics: readonly Diagnostic[];
  readonly entityProvenance: readonly VerifiedEntityProvenance[];
  readonly requiredDimensions: readonly StatusDimension[];
  readonly waivers: readonly BundleWaiver[];
  readonly activeProfiles: readonly ActiveFabricationProfile[];
  readonly standardsEvidence?: PreComplianceEvidence;
  readonly sourcingEvidence?: RecordedSourcingEvidence;
  readonly functionalEvidence?: FunctionalSimulationManifestEvidence;
  readonly assetNotices: readonly VerifiedAssetNotice[];
  readonly boardRevision?: string;
  readonly artifacts: readonly ArtifactEntry[];
  readonly layerCount?: 2 | 4;
  readonly tscircuit?: {
    readonly version: string;
    readonly integrity: string;
    readonly contentSha256: string;
    readonly runtimeClosureSha256: string;
  };
  readonly manufacturingPackages?: Readonly<
    Record<keyof typeof MANUFACTURING_PACKAGE_PINS, ManufacturingPackageIdentity>
  >;
  readonly runtimeEvidencePackages?: Readonly<
    Record<keyof typeof RUNTIME_EVIDENCE_PACKAGE_PINS, RuntimeEvidencePackageIdentity>
  >;
}

function isQualifiedRedistributableAssetLicense(license: string): boolean {
  return license === "MIT";
}

const CANONICAL_MIT_PERMISSION_BODY = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
].join(" ");

function collapseNoticeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function assetNoticeSatisfiesLicense(
  license: string,
  text: string,
  attribution: string,
): boolean {
  if (license !== "MIT") return false;
  const permissionIndex = text.indexOf("Permission is hereby granted, free of charge");
  if (permissionIndex < 1) return false;
  const copyrightBlock = text.slice(0, permissionIndex).trim();
  const prefixLines = copyrightBlock.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const copyrightLines = prefixLines[0]?.trim() === "MIT License" ? prefixLines.slice(1) : prefixLines;
  if (
    copyrightLines.length === 0 ||
    !copyrightLines.some((line) => line.includes(attribution)) ||
    copyrightLines.some((line) => !/^Copyright (?:\(c\)|©) .+/iu.test(line.trim()))
  ) return false;
  return collapseNoticeWhitespace(text.slice(permissionIndex)) === CANONICAL_MIT_PERMISSION_BODY;
}

function strictDataUriSha256(value: string): string | undefined {
  const match = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (match === null || match[2]!.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.toString("base64") !== match[2]) return undefined;
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function renderAssetNotices(notices: readonly VerifiedAssetNotice[]): string {
  const lines = [
    "# Third-Party Asset Notices",
    "",
    "This file covers third-party assets represented in this PCBoo production bundle.",
    "It does not apply PCBoo's MIT license to circuit source or manufacturing output.",
    "",
  ];
  for (const asset of notices) {
    lines.push(
      `## ${asset.name}`,
      "",
      `- Source: ${JSON.stringify(asset.source)}`,
      `- Version: ${JSON.stringify(asset.version)}`,
      `- SHA-256: ${JSON.stringify(asset.digest)}`,
      `- License: ${JSON.stringify(asset.license)}`,
      `- Attribution: ${JSON.stringify(asset.attribution)}`,
      `- License/notice file: ${JSON.stringify(asset.licenseNotice)}`,
      `- License/notice SHA-256: ${JSON.stringify(asset.licenseNoticeDigest)}`,
      `- Redistribution: ${asset.redistribution}`,
      "",
      "### Bound license and notice text",
      "",
    );
    lines.push(`    ${asset.licenseNoticeText.replaceAll("\n", "\n    ")}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function assetNoticeEntry(notices: readonly VerifiedAssetNotice[]): ArtifactEntry | undefined {
  if (notices.length === 0) return undefined;
  const content = renderAssetNotices(notices);
  return Object.freeze({
    kind: "third-party-notices",
    path: ASSET_NOTICES_FILENAME,
    size: new TextEncoder().encode(content).byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
  });
}

async function assetRightsEvidence(
  lock: PcbooLock,
  circuitJson: ReturnType<typeof parseCanonicalCircuitJson> | undefined,
  inputSnapshot: BuildInputSnapshot,
  projectRoot: string,
): Promise<Readonly<{ notices: readonly VerifiedAssetNotice[]; findings: readonly ProductionReadinessFinding[] }>> {
  const findings: ProductionReadinessFinding[] = [];
  const notices: VerifiedAssetNotice[] = [];
  const allowed: VerifiedAssetNotice[] = [];
  for (const input of inputSnapshot.inputs) {
    const normalized = input.path.replaceAll("\\", "/");
    if (
      (normalized.startsWith("vendor/") || normalized.startsWith("models/")) &&
      input.role !== "vendored"
    ) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `${normalized} must be classified as a vendored build input before its license and redistribution authority can be verified`,
      });
    }
  }
  const vendoredInputs = new Map(
    inputSnapshot.inputs
      .filter(({ role }) => role === "vendored")
      .map((input) => [input.path.replaceAll("\\", "/"), input] as const),
  );
  for (const [name, asset] of Object.entries(lock.assets).sort(([left], [right]) => left.localeCompare(right))) {
    if (asset.redistribution !== "allowed") {
      findings.push({
        code: "ASSET_REDISTRIBUTION_PROHIBITED",
        message: `Locked asset ${name} has ${asset.redistribution} redistribution rights and cannot enter a verified bundle`,
      });
      continue;
    }
    if (!isQualifiedRedistributableAssetLicense(asset.license)) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Locked asset ${name} uses license ${asset.license}, which PCBoo has not qualified for redistribution`,
      });
      continue;
    }
    const normalized = asset.source.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) ||
      normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Locked asset ${name} must resolve to a contained project-relative vendored file`,
      });
      continue;
    }
    const input = vendoredInputs.get(normalized);
    if (input === undefined || `sha256:${input.sha256}` !== asset.digest) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Locked vendored asset ${name} is not bound to a same-digest vendored build input at ${normalized}`,
      });
      continue;
    }
    const normalizedNotice = asset.licenseNotice.replaceAll("\\", "/");
    if (
      normalizedNotice.startsWith("/") || /^[A-Za-z]:/u.test(normalizedNotice) ||
      normalizedNotice.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Locked asset ${name} must use a contained project-relative license/notice file`,
      });
      continue;
    }
    const noticeInput = vendoredInputs.get(normalizedNotice);
    if (
      noticeInput === undefined ||
      `sha256:${noticeInput.sha256}` !== asset.licenseNoticeDigest ||
      noticeInput.size > ASSET_LICENSE_NOTICE_BYTES_LIMIT
    ) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Locked asset ${name} is not bound to a same-digest bounded vendored license/notice file at ${normalizedNotice}`,
      });
      continue;
    }
    let licenseNoticeText: string;
    try {
      const noticePath = join(projectRoot, ...normalizedNotice.split("/"));
      const before = await lstat(noticePath);
      if (before.isSymbolicLink() || !before.isFile() || before.size !== noticeInput.size) {
        throw new Error("license/notice input is not the captured regular file");
      }
      const bytes = await readFile(noticePath);
      const after = await lstat(noticePath);
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        after.isSymbolicLink() || !after.isFile()
      ) throw new Error("license/notice input changed while it was read");
      const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
      if (digest !== asset.licenseNoticeDigest) throw new Error("license/notice digest changed");
      licenseNoticeText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!licenseNoticeText.trim() || licenseNoticeText.includes("\0")) {
        throw new Error("license/notice text is empty or contains NUL");
      }
    } catch (error) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Locked asset ${name} license/notice evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!assetNoticeSatisfiesLicense(asset.license, licenseNoticeText, asset.attribution)) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Locked asset ${name} license/notice text does not satisfy PCBoo's ${asset.license} notice requirements`,
      });
      continue;
    }
    const notice = Object.freeze({
      ...asset,
      licenseNotice: normalizedNotice,
      licenseNoticeText,
      name,
      redistribution: "allowed" as const,
    });
    notices.push(notice);
    allowed.push(notice);
  }

  if (notices.length > VERIFIED_ASSET_NOTICE_COUNT_LIMIT) {
    findings.push({
      code: "ASSET_LICENSE_EVIDENCE_INVALID",
      message: `Verified bundles support at most ${VERIFIED_ASSET_NOTICE_COUNT_LIMIT} incorporated asset notices`,
    });
  }

  const qualifiedVendoredPaths = new Set<string>();
  for (const asset of allowed) {
    qualifiedVendoredPaths.add(asset.source.replaceAll("\\", "/"));
    qualifiedVendoredPaths.add(asset.licenseNotice.replaceAll("\\", "/"));
  }
  for (const input of vendoredInputs.values()) {
    const normalized = input.path.replaceAll("\\", "/");
    if (!qualifiedVendoredPaths.has(normalized)) {
      findings.push({
        code: "ASSET_LICENSE_EVIDENCE_INVALID",
        message: `Vendored build input ${normalized} is not covered by a fully qualified locked asset or its bound license/notice`,
      });
    }
  }

  if (circuitJson !== undefined) {
    const references: Array<{ owner: string; value: string }> = [];
    for (const element of circuitJson) {
      if (element.type !== "cad_component") continue;
      const record = element as unknown as Record<string, unknown>;
      const owner = String(record.cad_component_id ?? "cad_component");
      if (record.model_jscad !== undefined && record.model_jscad !== null) {
        findings.push({
          code: "ASSET_LICENSE_EVIDENCE_INVALID",
          message: `${owner}.model_jscad is an embedded CAD asset without a qualified locked provenance format`,
        });
      }
      for (const [field, value] of Object.entries(record)) {
        if (field.startsWith("model_") && field.endsWith("_url") && typeof value === "string") {
          references.push({ owner: `${owner}.${field}`, value });
        }
      }
      const modelAsset = record.model_asset;
      if (modelAsset !== null && typeof modelAsset === "object" && !Array.isArray(modelAsset)) {
        const assetRecord = modelAsset as Record<string, unknown>;
        for (const field of ["project_relative_path", "url"] as const) {
          if (typeof assetRecord[field] === "string") references.push({ owner: `${owner}.model_asset.${field}`, value: assetRecord[field] });
        }
      }
    }
    for (const reference of references) {
      const dataDigest = reference.value.startsWith("data:")
        ? strictDataUriSha256(reference.value)
        : undefined;
      const matches = allowed.filter((asset) =>
        dataDigest === undefined ? asset.source === reference.value : asset.digest === dataDigest
      );
      if (matches.length !== 1 || (reference.value.startsWith("data:") && dataDigest === undefined)) {
        findings.push({
          code: "ASSET_LICENSE_EVIDENCE_INVALID",
          message: `${reference.owner} is not bound to exactly one allowed, digest-matched locked asset`,
        });
      }
    }
  }
  return Object.freeze({ notices: Object.freeze(notices), findings: Object.freeze(findings) });
}

const SHA256_HEX = /^[a-f0-9]{64}$/u;

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${name} contains unknown field ${unexpected[0]}`);
}

function assertPlainAuthority(value: unknown, name: string, active = new WeakSet<object>()): void {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${name} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${name} contains non-data ${typeof value}`);
  if (active.has(value)) throw new TypeError(`${name} contains a cyclic value`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new TypeError(`${name} contains a non-plain object`);
  }
  active.add(value);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertPlainAuthority(item, `${name}.${key}`, active);
  }
  active.delete(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function validateCapturedManifest(manifest: ArtifactManifest): void {
  const record = manifest as unknown as Record<string, unknown>;
  assertExactKeys(record, ["schemaVersion", "lifecycle", "boardRevision", "provenance", "artifacts"], "draftManifest");
  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) throw new TypeError("draftManifest schemaVersion is invalid");
  if (manifest.lifecycle !== "draft" && manifest.lifecycle !== "verified") throw new TypeError("draftManifest lifecycle is invalid");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new TypeError("draftManifest artifacts must be non-empty");
  const paths = new Set<string>();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const artifactRecord = artifact as unknown as Record<string, unknown>;
    assertExactKeys(artifactRecord, ["kind", "path", "sha256", "size"], `draftManifest.artifacts[${index}]`);
    if (typeof artifact.path !== "string" || !artifact.path || typeof artifact.sha256 !== "string" || !SHA256_HEX.test(artifact.sha256)) {
      throw new TypeError(`draftManifest.artifacts[${index}] has invalid path or digest`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new TypeError(`draftManifest.artifacts[${index}] has invalid size`);
    if (artifact.kind !== undefined && (typeof artifact.kind !== "string" || artifact.kind.trim() === "")) throw new TypeError(`draftManifest.artifacts[${index}] has invalid kind`);
    const normalized = artifact.path.replaceAll("\\", "/");
    if (paths.has(normalized)) throw new TypeError(`draftManifest duplicates artifact ${normalized}`);
    paths.add(normalized);
  }
  if (manifest.boardRevision !== undefined && typeof manifest.boardRevision !== "string") throw new TypeError("draftManifest boardRevision is invalid");
  if (manifest.provenance !== undefined) assertPlainAuthority(manifest.provenance, "draftManifest.provenance");
}

function validateCapturedInputSnapshot(snapshot: BuildInputSnapshot): void {
  const record = snapshot as unknown as Record<string, unknown>;
  assertExactKeys(record, ["schemaVersion", "digest", "inputs"], "inputSnapshot");
  if (snapshot.schemaVersion !== BUILD_INPUT_SNAPSHOT_SCHEMA_VERSION || !SHA256_HEX.test(snapshot.digest) || !Array.isArray(snapshot.inputs)) {
    throw new TypeError("inputSnapshot schema, digest, or inputs are invalid");
  }
  for (const [index, input] of snapshot.inputs.entries()) {
    const inputRecord = input as unknown as Record<string, unknown>;
    assertExactKeys(inputRecord, ["path", "role", "sha256", "size"], `inputSnapshot.inputs[${index}]`);
    if (
      typeof input.path !== "string" || !input.path || !BUILD_INPUT_ROLES.includes(input.role) ||
      !SHA256_HEX.test(input.sha256) || !Number.isSafeInteger(input.size) || input.size < 0
    ) throw new TypeError(`inputSnapshot.inputs[${index}] is invalid`);
  }
}

function capturePromotionOptions(options: PromoteProductionBundleOptions): Readonly<CapturedPromoteProductionBundleOptions> {
  // Read every caller-controlled top-level field exactly once. In particular,
  // optional accessors must not be able to return one value for the presence
  // check and another value for the captured authority.
  const artifactRoot = options.artifactRoot;
  const projectRoot = options.projectRoot;
  const draftManifest = options.draftManifest;
  const inputSnapshot = options.inputSnapshot;
  const manufacturingExpectation = options.manufacturingExpectation;
  const suppliedStatuses = options.statuses;
  const suppliedDiagnostics = options.diagnostics;
  const suppliedRequiredDimensions = options.additionallyRequiredDimensions;
  const suppliedExternalToolVersions = options.externalToolVersions;
  const functionalSimulationAuthority = options.functionalSimulationAuthority;
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  throwIfPromotionCancelled(signal);
  let clone: PromoteProductionBundleOptions;
  try {
    clone = structuredClone({
      artifactRoot,
      projectRoot,
      draftManifest,
      inputSnapshot,
      manufacturingExpectation,
      statuses: suppliedStatuses,
      ...(suppliedDiagnostics === undefined ? {} : { diagnostics: suppliedDiagnostics }),
      ...(suppliedRequiredDimensions === undefined ? {} : { additionallyRequiredDimensions: suppliedRequiredDimensions }),
      ...(suppliedExternalToolVersions === undefined ? {} : { externalToolVersions: suppliedExternalToolVersions }),
    });
  } catch (error) {
    throw new TypeError(`Promotion authority must be structured-cloneable plain data: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainAuthority(clone, "promotion authority");
  if (typeof clone.artifactRoot !== "string" || !clone.artifactRoot.trim() || clone.artifactRoot.includes("\0")) throw new TypeError("artifactRoot is invalid");
  if (typeof clone.projectRoot !== "string" || !clone.projectRoot.trim() || clone.projectRoot.includes("\0")) throw new TypeError("projectRoot is invalid");
  validateCapturedManifest(clone.draftManifest);
  validateCapturedInputSnapshot(clone.inputSnapshot);
  if (typeof clone.manufacturingExpectation !== "object" || clone.manufacturingExpectation === null) throw new TypeError("manufacturingExpectation is invalid");
  if (typeof clone.manufacturingExpectation.boardName !== "string" || !clone.manufacturingExpectation.boardName.trim() ||
    (clone.manufacturingExpectation.layerCount !== 2 && clone.manufacturingExpectation.layerCount !== 4)) {
    throw new TypeError("manufacturingExpectation board identity is invalid");
  }
  // Canonicalization rejects non-finite or non-JSON expectation evidence synchronously.
  manufacturingExpectationSha256(clone.manufacturingExpectation);
  const statuses = statusSet(clone.statuses);
  const diagnostics = Object.freeze((clone.diagnostics ?? []).map((diagnostic) => defineDiagnostic(diagnostic)));
  const additionallyRequiredDimensions = clone.additionallyRequiredDimensions === undefined
    ? undefined
    : Object.freeze([...clone.additionallyRequiredDimensions]);
  if (additionallyRequiredDimensions?.some((dimension) => !STATUS_DIMENSIONS.includes(dimension)) === true) {
    throw new TypeError("Production policy contains an unknown status dimension");
  }
  const externalToolVersions = clone.externalToolVersions === undefined
    ? undefined
    : Object.freeze({ ...clone.externalToolVersions });
  if (externalToolVersions !== undefined && Object.values(externalToolVersions).some((value) => typeof value !== "string" || !value.trim())) {
    throw new TypeError("External tool version evidence must contain non-empty strings");
  }
  const capturedData = deepFreeze({
    ...clone,
    statuses,
    ...(clone.diagnostics === undefined ? {} : { diagnostics }),
    ...(additionallyRequiredDimensions === undefined ? {} : { additionallyRequiredDimensions }),
    ...(externalToolVersions === undefined ? {} : { externalToolVersions }),
  });
  return Object.freeze({
    ...capturedData,
    ...(signal === undefined ? {} : { signal }),
    ...(functionalSimulationAuthority === undefined ? {} : { functionalSimulationAuthority }),
  }) as Readonly<CapturedPromoteProductionBundleOptions>;
}

function statusPasses(statuses: StatusSet, dimension: StatusDimension): boolean {
  if (dimension === "sourcing") {
    return statuses.sourcing.state === "available";
  }
  return isAssurancePassing(statuses[dimension]);
}

function assuranceMatchesEvidence(
  supplied: AssuranceStatus,
  assessed: AssuranceStatus,
): boolean {
  if (assessed.state === "passed") {
    return supplied.state === "passed" || supplied.state === "passed-with-waivers";
  }
  return supplied.state === assessed.state &&
    assessed.diagnosticIds.every((id) => supplied.diagnosticIds.includes(id));
}

function functionalManifestEvidence(
  evidence: Readonly<SimulationResultEvidence>,
  inputSnapshotDigest: string,
): Readonly<FunctionalSimulationManifestEvidence> {
  const resultSha256 = `sha256:${new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(evidence)).digest("hex")}`;
  return Object.freeze({
    schemaVersion: 1 as const,
    resultSchemaVersion: 2 as const,
    resultSha256,
    inputSnapshotDigest,
    definitionDigest: evidence.definitionDigest,
    circuitDigest: evidence.circuitDigest,
    netlistDigest: evidence.netlistDigest,
    qualificationSha256: evidence.qualificationSha256,
    modelDigests: Object.freeze({ ...evidence.modelDigests }),
    adapter: Object.freeze({ name: evidence.adapter.name, version: evidence.adapter.version }),
    tool: Object.freeze({ ...evidence.tool }),
    execution: Object.freeze({
      stdoutSha256: evidence.execution.stdoutSha256,
      stderrSha256: evidence.execution.stderrSha256,
      rawOutputSha256: evidence.execution.rawOutputSha256,
    }),
  });
}

function artifactSetsMatch(
  left: readonly ArtifactEntry[],
  right: readonly ArtifactEntry[],
): boolean {
  const normalize = (artifacts: readonly ArtifactEntry[]) => artifacts
    .map(({ kind, path, sha256, size }) => `${kind ?? ""}\0${path}\0${sha256}\0${size}`)
    .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function verifiedProductionArtifactKind(path: string): string {
  if (path === "evidence/circuit.json") return "compiled-circuit";
  if (path.startsWith("gerbers/") && path.endsWith(".gbr")) return "gerber";
  if (path.startsWith("drills/") && path.endsWith(".drl")) return "drill";
  if (path === "assembly/bom.csv") return "bom";
  if (path === "assembly/positions.csv") return "pick-and-place";
  if (path === "fabrication/metadata.json") return "metadata";
  throw new TypeError(`No verified production artifact type is defined for ${path}`);
}

function typedVerifiedArtifacts(
  artifacts: readonly { readonly path: string; readonly sha256: string; readonly size: number }[],
): readonly ArtifactEntry[] {
  return Object.freeze(artifacts.map(({ path, sha256, size }) => Object.freeze({
    kind: verifiedProductionArtifactKind(path),
    path,
    sha256,
    size,
  })));
}

function waiverKey(waiver: BundleWaiver): string {
  return JSON.stringify({
    diagnosticId: waiver.diagnosticId,
    dimension: waiver.dimension,
    scope: waiver.scope,
    justification: waiver.justification,
    expiresAt: waiver.expiresAt ?? null,
  });
}

export function boardRevisionSilkscreenDiagnostic(
  circuitJson: readonly { readonly type: string; readonly text?: unknown; readonly layer?: unknown }[],
  boardRevision: string,
): Readonly<Diagnostic> | undefined {
  const escaped = boardRevision.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const revisionPattern = new RegExp(
    `(?:^|[^A-Za-z0-9])rev(?:ision)?[ .:_-]+${escaped}(?![A-Za-z0-9._-])`,
    "i",
  );
  const present = circuitJson.some((element) =>
    element.type === "pcb_silkscreen_text" &&
    (element.layer === "top" || element.layer === "bottom") &&
    typeof element.text === "string" && revisionPattern.test(element.text)
  );
  if (present) return undefined;
  return defineDiagnostic({
    id: diagnosticId(BOARD_REVISION_DIAGNOSTIC_ID),
    severity: "warning",
    dimension: "fabrication",
    message: `Board revision ${boardRevision} is not present in top or bottom silkscreen text`,
    waiverPolicy: "forbidden",
    objects: ["pcb_board_0"],
    sourceLocations: [],
    evidence: [`board-revision:${boardRevision}`, "provenance:synthetic-generated"],
    nextCommand: "pcboo inspect --rule FAB_BOARD_REVISION_SILKSCREEN_001",
  });
}

async function evaluate(options: PromoteProductionBundleOptions): Promise<Evaluation> {
  throwIfPromotionCancelled(options.signal);
  const findings: ProductionReadinessFinding[] = [];
  const evaluationInstant = new Date();
  const evaluationDate = evaluationInstant.toISOString().slice(0, 10);
  const evaluationTimestamp = evaluationInstant.toISOString();
  const activeProfiles: ActiveFabricationProfile[] = [];
  let tscircuit: Evaluation["tscircuit"];
  let projectEntry: string | undefined;
  let projectOutputDirectory: string | undefined;
  let projectProfiles: readonly string[] = [];
  let projectConfig: Readonly<PcbooConfig> | undefined;
  let designBoardRevision: string | undefined;
  let manufacturingPackages: Evaluation["manufacturingPackages"];
  let runtimeEvidencePackages: Evaluation["runtimeEvidencePackages"];
  let standardsEvidence: Evaluation["standardsEvidence"];
  let sourcingEvidence: Evaluation["sourcingEvidence"];
  let functionalEvidence: Evaluation["functionalEvidence"];
  let assetNotices: readonly VerifiedAssetNotice[] = Object.freeze([]);
  let entityProvenance: readonly VerifiedEntityProvenance[] = Object.freeze([]);
  let projectLock: PcbooLock | undefined;
  let verifiedLayerCount: 2 | 4 | undefined;
  let independentlyTypedArtifacts: readonly ArtifactEntry[] | undefined;
  if (options.draftManifest.lifecycle !== "draft") {
    findings.push({
      code: "DRAFT_MANIFEST_REQUIRED",
      message: "Production promotion only accepts a draft artifact manifest",
    });
  }
  if (!options.draftManifest.boardRevision?.trim()) {
    findings.push({
      code: "BOARD_REVISION_REQUIRED",
      message: "A stable board revision is required for production promotion",
    });
  }
  try {
    const lockInput = options.inputSnapshot.inputs.filter(({ role, path }) =>
      role === "lockfile" && path.replaceAll("\\", "/") === "pcboo.lock"
    );
    if (lockInput.length !== 1) {
      throw new Error("Build input snapshot must contain exactly one pcboo.lock lockfile entry");
    }
    const lockPath = join(options.projectRoot, "pcboo.lock");
    const lockStat = await lstat(lockPath);
    throwIfPromotionCancelled(options.signal);
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
      throw new Error("pcboo.lock must be a regular file, not a symlink");
    }
    const lockBytes = await readFile(lockPath);
    throwIfPromotionCancelled(options.signal);
    const lockSha256 = new Bun.CryptoHasher("sha256").update(lockBytes).digest("hex");
    if (lockBytes.byteLength !== lockInput[0]!.size || lockSha256 !== lockInput[0]!.sha256) {
      throw new Error("pcboo.lock bytes do not match the snapped lockfile evidence");
    }
    const [config, lock] = await Promise.all([
      loadProjectConfig(
        options.projectRoot,
        options.signal === undefined ? {} : { signal: options.signal },
      ),
      Promise.resolve(parsePcbooLock(lockBytes.toString("utf8"))),
    ]);
    throwIfPromotionCancelled(options.signal);
    const engineIdentity = await requireTscircuitIdentity({
      projectRoot: options.projectRoot,
      expectedVersion: lock.tscircuit.version,
    });
    throwIfPromotionCancelled(options.signal);
    projectEntry = config.entry;
    projectOutputDirectory = config.outputDirectory;
    projectProfiles = config.profiles;
    projectConfig = config;
    designBoardRevision = config.boardRevision;
    projectLock = lock;
    tscircuit = Object.freeze({
      ...lock.tscircuit,
      contentSha256: engineIdentity.project!.contentSha256,
      runtimeClosureSha256: engineIdentity.project!.runtimeClosureSha256,
    });
    if (
      config.boardRevision === undefined &&
      !findings.some(({ code }) => code === "BOARD_REVISION_REQUIRED")
    ) {
      findings.push({
        code: "BOARD_REVISION_REQUIRED",
        message: "pcboo.config.ts must declare a source-controlled boardRevision for production promotion",
      });
    } else if (
      options.draftManifest.boardRevision?.trim() &&
      options.draftManifest.boardRevision !== config.boardRevision
    ) {
      findings.push({
        code: "BOARD_REVISION_MISMATCH",
        message: "Draft manifest board revision does not match authenticated pcboo.config.ts design metadata",
      });
    }
    if (config.profiles.length !== 1) {
      findings.push({
        code: "FABRICATION_PROFILE_REQUIRED",
        message: "Production promotion requires exactly one active fabrication profile",
      });
    } else {
      const name = config.profiles[0]!;
      const resolved = lock.profiles[name];
      if (resolved === undefined) {
        findings.push({
          code: "FABRICATION_PROFILE_INVALID",
          message: `Active profile ${name} is not resolved in pcboo.lock`,
        });
      } else {
        const profile = { name, version: resolved.version, digest: resolved.digest };
        resolveFabricationProfile(profile);
        activeProfiles.push(Object.freeze(profile));
      }
    }
  } catch (error) {
    throwIfPromotionCancelled(options.signal);
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      code: message.includes("snapped lockfile") || message.includes("lockfile entry")
        ? "BUILD_INPUT_STALE"
        : message.includes("TSCIRCUIT_") || message.toLowerCase().includes("tscircuit")
          ? "TSCIRCUIT_IDENTITY_INVALID"
          : "FABRICATION_PROFILE_INVALID",
      message,
    });
  }
  try {
    manufacturingPackages = await requireManufacturingPackageIdentity();
  } catch (error) {
    throwIfPromotionCancelled(options.signal);
    findings.push({
      code: "MANUFACTURING_TOOL_IDENTITY_INVALID",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  throwIfPromotionCancelled(options.signal);
  try {
    runtimeEvidencePackages = await requireRuntimeEvidencePackageIdentity();
  } catch (error) {
    throwIfPromotionCancelled(options.signal);
    findings.push({
      code: "RUNTIME_EVIDENCE_IDENTITY_INVALID",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  throwIfPromotionCancelled(options.signal);
  if (Object.keys(options.externalToolVersions ?? {}).length > 0) {
    findings.push({
      code: "EXTERNAL_TOOL_EVIDENCE_INVALID",
      message: "Caller-supplied external tool versions are not verified evidence; invoke a supported tool adapter instead",
    });
  }

  const suppliedStatuses = statusSet(options.statuses);
  // Caller-authored prose and timestamps are not verification evidence. Keep
  // only state and diagnostic identity until a PCBoo assessment below derives
  // a status summary or observation timestamp from authenticated evidence.
  let statuses = statusSet({
    fabrication: assuranceStatus("fabrication", suppliedStatuses.fabrication.state, {
      diagnosticIds: suppliedStatuses.fabrication.diagnosticIds,
    }),
    electrical: assuranceStatus("electrical", suppliedStatuses.electrical.state, {
      diagnosticIds: suppliedStatuses.electrical.diagnosticIds,
    }),
    functional: assuranceStatus("functional", suppliedStatuses.functional.state, {
      diagnosticIds: suppliedStatuses.functional.diagnosticIds,
    }),
    standards: assuranceStatus("standards", suppliedStatuses.standards.state, {
      diagnosticIds: suppliedStatuses.standards.diagnosticIds,
    }),
    sourcing: sourcingStatus(suppliedStatuses.sourcing.state, {
      diagnosticIds: suppliedStatuses.sourcing.diagnosticIds,
    }),
  });
  // This ID belongs exclusively to evidence generated below from the bound
  // Circuit JSON. A caller cannot suppress or replace that evidence by
  // pre-populating the same stable identifier.
  const diagnostics: Diagnostic[] = (options.diagnostics ?? [])
    .filter(({ id }) => String(id) !== BOARD_REVISION_DIAGNOSTIC_ID)
    .map((diagnostic) => defineDiagnostic(diagnostic));
  const requested = options.additionallyRequiredDimensions ?? [];
  if (requested.some((dimension) => !STATUS_DIMENSIONS.includes(dimension))) {
    throw new TypeError("Production policy contains an unknown status dimension");
  }
  const requiredDimensions = Object.freeze([
    ...new Set<StatusDimension>(["fabrication", "electrical", ...requested]),
  ]);
  for (const dimension of requested) {
    if (
      dimension !== "fabrication" && dimension !== "electrical" &&
      dimension !== "functional" && dimension !== "standards" && dimension !== "sourcing"
    ) {
      findings.push({
        code: "REQUIRED_DIMENSION_EVIDENCE_UNAVAILABLE",
        message: `Required ${dimension} promotion is unavailable until PCBoo has a pinned, independently verified evidence adapter for that dimension`,
      });
    }
  }

  let currentSnapshot = await refreshBuildInputSnapshot(
    options.projectRoot,
    options.inputSnapshot,
  );
  throwIfPromotionCancelled(options.signal);
  if (currentSnapshot.digest !== options.inputSnapshot.digest) {
    findings.push({
      code: "BUILD_INPUT_STALE",
      message: "Source, config, profile, waiver, test, vendored, or lockfile bytes changed after the build snapshot",
    });
  }
  for (const input of options.inputSnapshot.inputs) {
    const normalized = input.path.replaceAll("\\", "/");
    if (normalized.startsWith("waivers/") && input.role !== "waiver") {
      findings.push({
        code: "WAIVER_EVIDENCE_INVALID",
        message: `${normalized} must be classified as a waiver build input`,
      });
    }
  }
  if (projectEntry !== undefined) {
    try {
      const [sourceGraph, configGraph, completeAuthority] = await Promise.all([
        discoverProjectSourceGraph(options.projectRoot, projectEntry),
        discoverProjectSourceGraph(options.projectRoot, "pcboo.config.ts"),
        digestProjectInputs({
          projectRoot: options.projectRoot,
          entry: projectEntry,
          outputDirectory: projectOutputDirectory ?? ".pcboo",
          profiles: projectProfiles,
          ...(designBoardRevision === undefined
            ? {}
            : { boardRevision: designBoardRevision }),
        }),
      ]);
      throwIfPromotionCancelled(options.signal);
      const manifestedInputs = new Set(
        options.inputSnapshot.inputs.map(({ path }) => path.replaceAll("\\", "/")),
      );
      const missingAuthority = completeAuthority.inputPaths.filter((path) =>
        !manifestedInputs.has(path)
      );
      const manifestedSources = new Set(
        options.inputSnapshot.inputs
          .filter(({ role }) => role === "source" || role === "vendored")
          .map(({ path }) => path.replaceAll("\\", "/")),
      );
      const missing = sourceGraph.filter((path) => !manifestedSources.has(path));
      const manifestedConfigDependencies = new Set(
        options.inputSnapshot.inputs
          .filter(({ role }) => role === "config-dependency" || role === "vendored")
          .map(({ path }) => path.replaceAll("\\", "/")),
      );
      const missingConfig = configGraph.filter((path) =>
        path !== "pcboo.config.ts" && !manifestedConfigDependencies.has(path)
      );
      const sourceGraphSet = new Set(sourceGraph);
      const configGraphSet = new Set(configGraph);
      const misclassifiedTests = options.inputSnapshot.inputs.filter(({ path, role }) => {
        const normalized = path.replaceAll("\\", "/");
        const isTestAuthority =
          normalized === "simulations" || normalized.startsWith("simulations/") ||
          /\.test\.tsx?$/u.test(normalized);
        return isTestAuthority && !sourceGraphSet.has(normalized) &&
          !configGraphSet.has(normalized) && role !== "test";
      });
      if (missing.length > 0) findings.push({
        code: "BUILD_INPUT_INCOMPLETE",
        message: `Build input snapshot omits imported project source: ${boundedFailureDetails(missing, ", ", "pcboo inspect --status fabrication")}`,
      });
      if (missingConfig.length > 0) findings.push({
        code: "BUILD_INPUT_INCOMPLETE",
        message: `Build input snapshot omits imported config dependency: ${boundedFailureDetails(missingConfig, ", ", "pcboo inspect --status fabrication")}`,
      });
      if (misclassifiedTests.length > 0) findings.push({
        code: "BUILD_INPUT_INCOMPLETE",
        message: `Build input snapshot misclassifies test authority: ${boundedFailureDetails(
          misclassifiedTests.map(({ path }) => path),
          ", ",
          "pcboo inspect --status functional",
        )}`,
      });
      if (missingAuthority.length > 0) findings.push({
        code: "BUILD_INPUT_INCOMPLETE",
        message: `Build input snapshot omits regular project authority: ${boundedFailureDetails(missingAuthority, ", ", "pcboo inspect --status fabrication")}`,
      });
    } catch (error) {
      throwIfPromotionCancelled(options.signal);
      findings.push({
        code: "BUILD_INPUT_INCOMPLETE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throwIfPromotionCancelled(options.signal);

  const artifactIntegrity = await verifyArtifactManifest(
    options.artifactRoot,
    options.draftManifest,
  );
  throwIfPromotionCancelled(options.signal);
  if (!artifactIntegrity.integrityValid) {
    findings.push({
      code: "ARTIFACT_INTEGRITY_FAILED",
      message: boundedFailureDetails(
        artifactIntegrity.findings.map((finding) => finding.message),
        "; ",
        "pcboo inspect --status fabrication",
      ),
    });
  }

  const circuitJsonPath = "evidence/circuit.json";
  let boundCircuitJson: ReturnType<typeof parseCanonicalCircuitJson> | undefined;
  let boundCircuitDigest: string | undefined;
  if (!options.draftManifest.artifacts.some(({ path }) => path === circuitJsonPath)) {
    findings.push({
      code: "CIRCUIT_JSON_EVIDENCE_INVALID",
      message: `${circuitJsonPath} must be included in the draft artifact manifest`,
    });
  } else {
    try {
      const circuitBytes = await readFile(join(options.artifactRoot, "evidence", "circuit.json"));
      boundCircuitJson = parseCanonicalCircuitJson(circuitBytes.toString("utf8"));
      boundCircuitDigest = `sha256:${new Bun.CryptoHasher("sha256").update(circuitBytes).digest("hex")}`;
    } catch (error) {
      throwIfPromotionCancelled(options.signal);
      findings.push({
        code: "CIRCUIT_JSON_EVIDENCE_INVALID",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throwIfPromotionCancelled(options.signal);
  }
  const suppliedFunctionalPass = statuses.functional.state === "passed" ||
    statuses.functional.state === "passed-with-waivers";
  const authenticatedFunctionalEvidence = boundCircuitDigest === undefined
    ? undefined
    : authenticateFunctionalSimulationAuthority(options.functionalSimulationAuthority, {
        circuitDigest: boundCircuitDigest,
        inputSnapshot: currentSnapshot,
      });
  if (suppliedFunctionalPass) {
    if (
      statuses.functional.state !== "passed" ||
      authenticatedFunctionalEvidence === undefined
    ) {
      findings.push({
        code: "UNVERIFIED_STATUS_CLAIM",
        message: "functional passing requires same-process qualified simulation authority bound to the current Circuit JSON and build-input snapshot",
      });
    } else {
      statuses = statusSet({
        ...statuses,
        functional: assuranceStatus("functional", "passed", {
          summary: "Qualified simulation evidence is bound to the current production inputs",
        }),
      });
      functionalEvidence = functionalManifestEvidence(
        authenticatedFunctionalEvidence,
        currentSnapshot.digest,
      );
    }
  }
  if (
    requested.includes("functional") &&
    suppliedFunctionalPass && authenticatedFunctionalEvidence === undefined
  ) {
    findings.push({
      code: "REQUIRED_DIMENSION_EVIDENCE_UNAVAILABLE",
      message: "Required functional promotion lacks current internally issued simulation evidence",
    });
  }
  if (boundCircuitJson !== undefined) {
    if (designBoardRevision !== undefined) {
      const revisionDiagnostic = boardRevisionSilkscreenDiagnostic(
        boundCircuitJson,
        designBoardRevision,
      );
      if (revisionDiagnostic !== undefined) diagnostics.push(revisionDiagnostic);
    }
    try {
      const evaluated = await evaluateProjectCircuitTwice(
        options.projectRoot,
        {
          ...(projectConfig === undefined ? {} : { expectedConfig: projectConfig }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      throwIfPromotionCancelled(options.signal);
      const persisted = await readFile(
        join(options.artifactRoot, "evidence", "circuit.json"),
        "utf8",
      );
      throwIfPromotionCancelled(options.signal);
      if (evaluated.canonicalJson !== persisted) {
        findings.push({
          code: "SOURCE_CIRCUIT_MISMATCH",
          message: "Manifested Circuit JSON was not produced by the current snapped project source",
        });
      }
    } catch (error) {
      throwIfPromotionCancelled(options.signal);
      findings.push({
        code: "SOURCE_EVALUATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const derivedManufacturingExpectation = deriveManufacturingExpectation({
      boardName: options.manufacturingExpectation.boardName,
      circuitJson: boundCircuitJson,
    });
    if (
      JSON.stringify(derivedManufacturingExpectation) !==
        JSON.stringify(options.manufacturingExpectation)
    ) {
      findings.push({
        code: "MANUFACTURING_EXPECTATION_MISMATCH",
        message: "Manufacturing expectations do not match the manifested Circuit JSON evidence",
      });
    } else {
      verifiedLayerCount = derivedManufacturingExpectation.layerCount;
    }
    const manufacturing = await verifyManufacturingDirectory({
      root: options.artifactRoot,
      expectation: derivedManufacturingExpectation,
      circuitJson: boundCircuitJson,
      allowedAdditionalPaths: [circuitJsonPath],
    });
    throwIfPromotionCancelled(options.signal);
    independentlyTypedArtifacts = typedVerifiedArtifacts(manufacturing.artifacts);
    if (!artifactSetsMatch(independentlyTypedArtifacts, options.draftManifest.artifacts)) {
      findings.push({
        code: "ARTIFACT_INTEGRITY_FAILED",
        message: "Draft artifact manifest does not exactly cover and type the independently bounded manufacturing and Circuit JSON artifact set",
      });
    }
    if (!manufacturing.passed) {
      findings.push({
        code: "MANUFACTURING_VERIFICATION_FAILED",
        message: boundedFailureDetails(
          manufacturing.findings.map((finding) => `${finding.code}: ${finding.message}`),
          "; ",
          "pcboo verify manufacturing --json",
        ),
      });
    }

    const electrical = assessCircuitElectrical(boundCircuitJson);
    throwIfPromotionCancelled(options.signal);
    if (!assuranceMatchesEvidence(statuses.electrical, electrical.status)) {
      findings.push({
        code: "ELECTRICAL_EVIDENCE_MISMATCH",
        message: `Electrical status ${statuses.electrical.state} does not match manifested Circuit JSON evidence ${electrical.status.state}`,
      });
    } else if (
      statuses.electrical.state === "passed" && electrical.status.state === "passed"
    ) {
      statuses = statusSet({ ...statuses, electrical: electrical.status });
    }
    const fabrication = assessCircuitFabrication(boundCircuitJson, activeProfiles[0]);
    throwIfPromotionCancelled(options.signal);
    if (!assuranceMatchesEvidence(statuses.fabrication, fabrication.status)) {
      findings.push({
        code: "FABRICATION_EVIDENCE_MISMATCH",
        message: `Fabrication status ${statuses.fabrication.state} does not match manifested Circuit JSON evidence ${fabrication.status.state}`,
      });
    } else if (
      statuses.fabrication.state === "passed" && fabrication.status.state === "passed"
    ) {
      statuses = statusSet({ ...statuses, fabrication: fabrication.status });
    }
    const standardsEvidenceRequested =
      statuses.standards.state === "passed" ||
      statuses.standards.state === "passed-with-waivers" ||
      requiredDimensions.includes("standards");
    if (activeProfiles[0] !== undefined && standardsEvidenceRequested) {
      const standards = assessBaselinePreCompliance({
        circuitJson: boundCircuitJson,
        activeProfile: activeProfiles[0],
        manufacturingVerification: manufacturing,
      });
      throwIfPromotionCancelled(options.signal);
      standardsEvidence = standards.evidence;
      const standardsMismatch =
        (statuses.standards.state === "passed" ||
          statuses.standards.state === "passed-with-waivers") &&
        (statuses.standards.state !== standards.status.state ||
          JSON.stringify([...statuses.standards.diagnosticIds].sort()) !==
            JSON.stringify([...standards.status.diagnosticIds].sort()) ||
          diagnostics.some(({ dimension }) => dimension === "standards"));
      if (standardsMismatch) {
        findings.push({
          code: "STANDARDS_EVIDENCE_MISMATCH",
          message: `Standards status ${statuses.standards.state} does not exactly match independently re-derived locked-profile pre-compliance evidence ${standards.status.state}`,
        });
      } else if (statuses.standards.state === "passed") {
        statuses = statusSet({ ...statuses, standards: standards.status });
      }
    } else if (standardsEvidenceRequested && (
      statuses.standards.state === "passed" ||
      statuses.standards.state === "passed-with-waivers"
    )) {
      findings.push({
        code: "STANDARDS_EVIDENCE_MISMATCH",
        message: "A standards pass cannot be re-derived without the exact locked baseline profile",
      });
    }

    const sourcingEvidenceRequested =
      requiredDimensions.includes("sourcing") || suppliedStatuses.sourcing.state !== "unchecked";
    if (sourcingEvidenceRequested && projectLock !== undefined) {
      const sourcing = assessRecordedSourcing({
        circuitJson: boundCircuitJson,
        lock: projectLock,
        now: new Date(),
        requirePolicy: true,
      });
      throwIfPromotionCancelled(options.signal);
      sourcingEvidence = sourcing.evidence;
      const callerClaimed = suppliedStatuses.sourcing.state !== "unchecked";
      const callerDiagnostics = diagnostics.filter(({ dimension }) => dimension === "sourcing");
      if (
        callerDiagnostics.length > 0 || suppliedStatuses.sourcing.diagnosticIds.length > 0 ||
        (callerClaimed && suppliedStatuses.sourcing.state !== sourcing.status.state)
      ) {
        findings.push({
          code: "SOURCING_EVIDENCE_MISMATCH",
          message: `Sourcing status ${suppliedStatuses.sourcing.state} does not exactly match independently re-derived recorded evidence ${sourcing.status.state}`,
        });
      }
      for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
        if (diagnostics[index]!.dimension === "sourcing") diagnostics.splice(index, 1);
      }
      statuses = statusSet({ ...statuses, sourcing: sourcing.status });
      diagnostics.push(...sourcing.diagnostics);
    } else if (sourcingEvidenceRequested) {
      findings.push({
        code: "SOURCING_EVIDENCE_MISMATCH",
        message: "Sourcing evidence cannot be re-derived without the snapped pcboo.lock",
      });
    }
  }

  if (projectLock !== undefined) {
    const assetEvidence = await assetRightsEvidence(
      projectLock,
      boundCircuitJson,
      options.inputSnapshot,
      options.projectRoot,
    );
    throwIfPromotionCancelled(options.signal);
    assetNotices = assetEvidence.notices;
    findings.push(...assetEvidence.findings);
    if (
      assetNotices.length > 0 &&
      options.draftManifest.artifacts.some(({ path }) => path === ASSET_NOTICES_FILENAME)
    ) {
      findings.push({
        code: "ARTIFACT_INTEGRITY_FAILED",
        message: `${ASSET_NOTICES_FILENAME} is reserved for PCBoo's generated asset notice`,
      });
    }
  }

  if (boundCircuitJson !== undefined && projectEntry !== undefined) {
    try {
      entityProvenance = await deriveEntityProvenance({
        projectRoot: options.projectRoot,
        entry: projectEntry,
        circuitJson: boundCircuitJson,
      });
      throwIfPromotionCancelled(options.signal);
    } catch (error) {
      throwIfPromotionCancelled(options.signal);
      findings.push({
        code: "ENTITY_PROVENANCE_INCOMPLETE",
        message: `Manufactured-entity hierarchy could not be derived: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  } else {
    findings.push({
      code: "ENTITY_PROVENANCE_INCOMPLETE",
      message: "Manufactured-entity hierarchy requires manifested Circuit JSON and the authenticated project entry",
    });
  }

  // Required-dimension provenance is evidence, not a caller assertion. Strip
  // every supplied location and reserved provenance marker, then derive the
  // persisted values from the snapped authored source graph and the manifested
  // Circuit JSON. Optional dimensions retain their caller-provided context
  // because they cannot contribute to a passing production claim.
  const callerRequiredDiagnostics = diagnostics.filter((diagnostic) =>
    requiredDimensions.includes(diagnostic.dimension) &&
    String(diagnostic.id) !== BOARD_REVISION_DIAGNOSTIC_ID
  );
  if (callerRequiredDiagnostics.length > 0) {
    if (boundCircuitJson === undefined || projectEntry === undefined) {
      for (const diagnostic of callerRequiredDiagnostics) {
        const index = diagnostics.indexOf(diagnostic);
        diagnostics[index] = defineDiagnostic({
          ...diagnostic,
          sourceLocations: [],
          evidence: (diagnostic.evidence ?? []).filter(
            (item) => !item.startsWith("provenance:"),
          ),
        });
      }
    } else {
      try {
        const cleared = callerRequiredDiagnostics.map((diagnostic) => defineDiagnostic({
          ...diagnostic,
          sourceLocations: [],
          evidence: (diagnostic.evidence ?? []).filter(
            (item) => !item.startsWith("provenance:"),
          ),
        }));
        const derived = await enrichDiagnosticProvenance({
          projectRoot: options.projectRoot,
          entry: projectEntry,
          circuitJson: boundCircuitJson,
          diagnostics: cleared,
        });
        throwIfPromotionCancelled(options.signal);
        for (let offset = 0; offset < callerRequiredDiagnostics.length; offset += 1) {
          const index = diagnostics.indexOf(callerRequiredDiagnostics[offset]!);
          diagnostics[index] = derived[offset]!;
        }
      } catch (error) {
        throwIfPromotionCancelled(options.signal);
        findings.push({
          code: "DIAGNOSTIC_PROVENANCE_INCOMPLETE",
          message: `Required-dimension provenance could not be derived: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  const byId = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const occurrences = byId.get(diagnostic.id) ?? [];
    occurrences.push(diagnostic);
    byId.set(diagnostic.id, occurrences);
  }
  for (const dimension of STATUS_DIMENSIONS) {
    for (const id of statuses[dimension].diagnosticIds) {
      const occurrences = byId.get(id) ?? [];
      if (
        occurrences.length === 0 ||
        occurrences.some((diagnostic) => diagnostic.dimension !== dimension)
      ) {
        findings.push({
          code: "STATUS_DIAGNOSTIC_MISSING",
          message: `${dimension} references diagnostic ${id} without matching evidence in that dimension`,
        });
      }
    }
  }

  const waivers: BundleWaiver[] = [];
  for (const dimension of requiredDimensions) {
    if (!statusPasses(statuses, dimension)) {
      findings.push({
        code: "REQUIRED_STATUS_NOT_PASSING",
        message: `Required ${dimension} status is ${statuses[dimension].state}`,
      });
    }
    if (dimension === "sourcing") continue;
    const status = statuses[dimension];
    if (status.state === "passed-with-waivers") {
      for (const id of status.diagnosticIds) {
        const occurrences = byId.get(id) ?? [];
        if (occurrences.length === 0) {
          findings.push({
            code: "WAIVER_EVIDENCE_INVALID",
            message: `${dimension} waiver ${id} lacks allowed, scoped, written waiver evidence`,
          });
          continue;
        }
        for (const diagnostic of occurrences) {
          if (
            diagnostic.dimension !== dimension ||
            diagnostic.disposition !== "waived" ||
            diagnostic.waiverPolicy !== "allowed" ||
            diagnostic.resolution === undefined
          ) {
            findings.push({
              code: "WAIVER_EVIDENCE_INVALID",
              message: `${dimension} waiver ${id} occurrence lacks allowed, scoped, written waiver evidence`,
            });
            continue;
          }
          if (diagnostic.resolution.expiresAt !== undefined) {
            if (
              !isValidWaiverDate(diagnostic.resolution.expiresAt) ||
              diagnostic.resolution.expiresAt < evaluationDate
            ) {
              findings.push({
                code: "WAIVER_EXPIRED",
                message: `Waiver ${id} scope ${diagnostic.resolution.scope} is expired or has no valid deterministic evaluation date`,
              });
              continue;
            }
          }
          waivers.push({
            diagnosticId: diagnostic.id,
            dimension,
            scope: diagnostic.resolution.scope,
            justification: diagnostic.resolution.justification,
            ...(diagnostic.resolution.expiresAt === undefined
              ? {}
              : { expiresAt: diagnostic.resolution.expiresAt }),
          });
        }
      }
    }
  }
  for (const diagnostic of diagnostics) {
    if (
      !requiredDimensions.includes(diagnostic.dimension) ||
      diagnostic.disposition === "active"
    ) continue;
    if (diagnostic.disposition !== "waived") {
      findings.push({
        code: "WAIVER_EVIDENCE_INVALID",
        message: `Required ${diagnostic.dimension} diagnostic ${diagnostic.id} is suppressed; production requires an explicit scoped waiver`,
      });
      continue;
    }
    const status = statuses[diagnostic.dimension];
    if (
      diagnostic.dimension === "sourcing" ||
      status.state !== "passed-with-waivers" ||
      !status.diagnosticIds.includes(diagnostic.id)
    ) {
      findings.push({
        code: "WAIVER_EVIDENCE_INVALID",
        message: `Required ${diagnostic.dimension} waiver ${diagnostic.id} is omitted from passed-with-waivers status evidence`,
      });
    }
  }
  try {
    const declaredWaivers = await loadDeclaredWaivers(options.projectRoot, options.inputSnapshot);
    throwIfPromotionCancelled(options.signal);
    const declaredKeys = declaredWaivers.map(waiverKey).sort();
    const effectiveKeys = waivers.map(waiverKey).sort();
    if (JSON.stringify(declaredKeys) !== JSON.stringify(effectiveKeys)) {
      findings.push({
        code: "WAIVER_EVIDENCE_INVALID",
        message: "Source-controlled waiver declarations do not exactly match every effective waiver occurrence",
      });
    }
  } catch (error) {
    throwIfPromotionCancelled(options.signal);
    findings.push({
      code: "WAIVER_EVIDENCE_INVALID",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  for (const diagnostic of diagnostics) {
    const evidence = diagnostic.evidence ?? [];
    const trustedInternalSynthetic =
      String(diagnostic.id) === BOARD_REVISION_DIAGNOSTIC_ID &&
      evidence.includes("provenance:synthetic-generated");
    const independentlyDerivedAuthoredLocation =
      diagnostic.sourceLocations.length > 0 &&
      evidence.includes("provenance:nearest-authored-name");
    if (
      requiredDimensions.includes(diagnostic.dimension) &&
      !independentlyDerivedAuthoredLocation &&
      !trustedInternalSynthetic
    ) {
      findings.push({
        code: "DIAGNOSTIC_PROVENANCE_INCOMPLETE",
        message: `Required-dimension diagnostic ${diagnostic.id} does not resolve through manifested Circuit JSON to an honest authored source location`,
      });
    }
    if (
      diagnostic.severity === "error" &&
      diagnostic.disposition === "active" &&
      requiredDimensions.includes(diagnostic.dimension)
    ) {
      findings.push({
        code: "ACTIVE_REQUIRED_ERROR",
        message: `Active ${diagnostic.dimension} error ${diagnostic.id} blocks production promotion`,
      });
    }
  }

  // Close the common mutation window: both inputs and artifacts must remain
  // unchanged after the independent parser finishes.
  const [finalInputs, finalIntegrity] = await Promise.all([
    refreshBuildInputSnapshot(options.projectRoot, options.inputSnapshot),
    verifyArtifactManifest(options.artifactRoot, options.draftManifest),
  ]);
  throwIfPromotionCancelled(options.signal);
  currentSnapshot = finalInputs;
  if (finalInputs.digest !== options.inputSnapshot.digest &&
    !findings.some(({ code }) => code === "BUILD_INPUT_STALE")) {
    findings.push({ code: "BUILD_INPUT_STALE", message: "Build inputs changed during verification" });
  }
  if (!finalIntegrity.integrityValid &&
    !findings.some(({ code }) => code === "ARTIFACT_INTEGRITY_FAILED")) {
    findings.push({ code: "ARTIFACT_INTEGRITY_FAILED", message: "Artifacts changed during verification" });
  }

  return {
    eligible: findings.length === 0,
    findings: Object.freeze(findings.map((finding) => Object.freeze({ ...finding }))),
    currentSnapshot,
    evaluationDate,
    evaluationTimestamp,
    statuses,
    diagnostics: Object.freeze(diagnostics),
    entityProvenance,
    requiredDimensions,
    waivers: Object.freeze(waivers.map((waiver) => Object.freeze({ ...waiver }))),
    activeProfiles: Object.freeze(activeProfiles),
    ...(designBoardRevision === undefined
      ? {}
      : { boardRevision: designBoardRevision }),
    artifacts: independentlyTypedArtifacts ?? Object.freeze(
      options.draftManifest.artifacts.map((artifact) => Object.freeze({ ...artifact })),
    ),
    ...(verifiedLayerCount === undefined ? {} : { layerCount: verifiedLayerCount }),
    ...(tscircuit === undefined ? {} : { tscircuit }),
    ...(manufacturingPackages === undefined ? {} : { manufacturingPackages }),
    ...(runtimeEvidencePackages === undefined ? {} : { runtimeEvidencePackages }),
    ...(standardsEvidence === undefined ? {} : { standardsEvidence }),
    ...(sourcingEvidence === undefined ? {} : { sourcingEvidence }),
    ...(functionalEvidence === undefined ? {} : { functionalEvidence }),
    assetNotices,
  };
}

export async function assessProductionReadiness(
  options: PromoteProductionBundleOptions,
): Promise<Readonly<ProductionReadiness>> {
  requireSupportedBunRuntime();
  const captured = capturePromotionOptions(options);
  const result = await evaluate(captured);
  return Object.freeze({ eligible: result.eligible, findings: result.findings });
}

async function promoteCapturedProductionBundle(
  options: Readonly<CapturedPromoteProductionBundleOptions>,
): Promise<Readonly<VerifiedBundleManifest>> {
  const result = await evaluate(options);
  throwIfPromotionCancelled(options.signal);
  if (!result.eligible) {
    throw new Error(
      boundedFailureDetails(
        result.findings.map((finding) => `${finding.code}: ${finding.message}`),
        "\n",
        "pcboo inspect --status fabrication --json",
        32,
      ),
    );
  }
  if (result.tscircuit === undefined) {
    throw new Error("TSCIRCUIT_IDENTITY_INVALID: resolved engine identity is missing");
  }
  if (result.manufacturingPackages === undefined) {
    throw new Error("MANUFACTURING_TOOL_IDENTITY_INVALID: resolved package identities are missing");
  }
  if (result.runtimeEvidencePackages === undefined) {
    throw new Error("RUNTIME_EVIDENCE_IDENTITY_INVALID: resolved package identities are missing");
  }
  if (result.boardRevision === undefined || result.layerCount === undefined) {
    throw new Error("MANUFACTURING_EXPECTATION_MISMATCH: verified manifest authority is incomplete");
  }

  const externalToolVersions = Object.freeze({});
  const pcbooVersion = await requirePcbooVersion();
  throwIfPromotionCancelled(options.signal);
  const noticeArtifact = assetNoticeEntry(result.assetNotices);

  return Object.freeze({
    schemaVersion: VERIFIED_BUNDLE_SCHEMA_VERSION,
    lifecycle: "verified" as const,
    boardRevision: result.boardRevision,
    evaluationDate: result.evaluationDate,
    generatedAt: result.evaluationTimestamp,
    sourceControl: Object.freeze({
      state: "not-assessed" as const,
      reason: "Promotion binds complete project input bytes; Git revision and dirty-tree state were not invoked",
    }),
    toolVersions: Object.freeze({ pcboo: pcbooVersion, bun: Bun.version }),
    inputSnapshot: result.currentSnapshot,
    artifacts: result.artifacts,
    statuses: result.statuses,
    diagnostics: result.diagnostics,
    entityProvenance: result.entityProvenance,
    requiredDimensions: result.requiredDimensions,
    waivers: result.waivers,
    adapterVersions: MANUFACTURING_ADAPTER_VERSIONS,
    externalToolVersions: Object.freeze(externalToolVersions),
    manufacturingVerification: Object.freeze({
      parser: "gerber-parser@4.2.7" as const,
    }),
    ...(result.standardsEvidence === undefined
      ? {}
      : { standardsEvidence: result.standardsEvidence }),
    ...(result.sourcingEvidence === undefined
      ? {}
      : { sourcingEvidence: result.sourcingEvidence }),
    ...(result.functionalEvidence === undefined
      ? {}
      : { functionalEvidence: result.functionalEvidence }),
    assetNotices: result.assetNotices,
    ...(noticeArtifact === undefined ? {} : { assetNoticeArtifact: noticeArtifact }),
    activeProfiles: result.activeProfiles,
    capabilities: Object.freeze({
      boardCount: 1 as const,
      layerCount: result.layerCount,
      viaTechnology: "through-via" as const,
      fabricationRules: BASELINE_FABRICATION_PROFILE.supportedRules,
      manufacturingArtifacts: Object.freeze([
        "gerber",
        "excellon",
        "bom-csv",
        "pick-and-place-csv",
        "fabrication-metadata-json",
      ]),
      independentParser: "gerber-parser@4.2.7" as const,
    }),
    knownGaps: BASELINE_FABRICATION_PROFILE.knownGaps,
    tscircuit: result.tscircuit,
    manufacturingPackages: result.manufacturingPackages,
    runtimeEvidencePackages: result.runtimeEvidencePackages,
    cryptographicSignature: "absent" as const,
  });
}

export async function promoteProductionBundle(
  options: PromoteProductionBundleOptions,
): Promise<Readonly<VerifiedBundleManifest>> {
  requireSupportedBunRuntime();
  const captured = capturePromotionOptions(options);
  return await promoteCapturedProductionBundle(captured);
}

export const INCOMPLETE_VERIFIED_BUNDLE_MARKER = ".pcboo-bundle-incomplete" as const;
export const VERIFIED_BUNDLE_MANIFEST_FILENAME = "pcboo.verified-manifest.json" as const;

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  const parsed = parse(path);
  let current = parsed.root;
  for (const segment of path.slice(parsed.root.length).split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Verified bundle destination cannot traverse symlink ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Verified bundle destination")) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function requirePublicationParentAuthority(
  requestedParent: string,
  expectedRealParent: string,
): Promise<void> {
  try {
    await rejectSymlinkAncestors(requestedParent);
    const stat = await lstat(requestedParent);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(requestedParent) !== expectedRealParent) {
      throw new Error("identity mismatch");
    }
  } catch (error) {
    throw new Error("Verified bundle destination authority changed during publication");
  }
}

function safeArtifactSegments(path: string): readonly string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || isAbsolute(path) || segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`Verified bundle artifact path is unsafe: ${path}`);
  }
  return segments;
}

function expectedPlainTree(expectedFilePaths: readonly string[]): Readonly<{
  files: ReadonlySet<string>;
  directories: ReadonlySet<string>;
}> {
  const expectedFiles = new Set(expectedFilePaths.map((path) => path.replaceAll("\\", "/")));
  const expectedDirectories = new Set<string>();
  for (const path of expectedFiles) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      expectedDirectories.add(segments.slice(0, length).join("/"));
    }
  }
  return Object.freeze({ files: expectedFiles, directories: expectedDirectories });
}

async function requireExactPlainTree(root: string, expectedFilePaths: readonly string[]): Promise<void> {
  const expected = expectedPlainTree(expectedFilePaths);
  const unseenFiles = new Set(expected.files);
  const unseenDirectories = new Set(expected.directories);
  let entryCount = 0;
  const entryLimit = expected.files.size + expected.directories.size;
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const before = await lstat(directory);
    if (
      before.isSymbolicLink() || !before.isDirectory() ||
      await realpath(directory) !== resolve(directory)
    ) throw new Error("Verified bundle exact inventory contains a replaced or symlinked directory");
    for await (const entry of await opendir(directory)) {
      entryCount += 1;
      if (entryCount > entryLimit) {
        throw new Error("Verified bundle directory does not match its exact inventory");
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Verified bundle exact inventory contains symlink ${path}`);
      }
      if (stat.isFile()) {
        if (!expected.files.has(path)) {
          throw new Error("Verified bundle directory does not match its exact inventory");
        }
        unseenFiles.delete(path);
      } else if (stat.isDirectory()) {
        if (!expected.directories.has(path)) {
          throw new Error("Verified bundle directory does not match its exact inventory");
        }
        unseenDirectories.delete(path);
        await walk(absolute, path);
      } else {
        throw new Error(`Verified bundle exact inventory contains special entry ${path}`);
      }
    }
    const after = await lstat(directory);
    if (
      after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev ||
      before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || await realpath(directory) !== resolve(directory)
    ) throw new Error("Verified bundle exact inventory changed while it was inspected");
  };
  await walk(root);
  if (unseenFiles.size !== 0 || unseenDirectories.size !== 0) {
    throw new Error("Verified bundle directory does not match its exact inventory");
  }
}

function requirePublicationParentAuthoritySync(
  requestedParent: string,
  expectedRealParent: string,
): void {
  try {
    const parsed = parse(requestedParent);
    let current = parsed.root;
    for (const segment of requestedParent.slice(parsed.root.length).split(/[\\/]/).filter(Boolean)) {
      current = resolve(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new Error("symlink ancestor");
    }
    const stat = lstatSync(requestedParent);
    if (!stat.isDirectory() || realpathSync(requestedParent) !== expectedRealParent) {
      throw new Error("identity mismatch");
    }
  } catch {
    throw new Error("Verified bundle destination authority changed at the validity commit");
  }
}

function requireExactPlainTreeSync(root: string, expectedFilePaths: readonly string[]): void {
  const expected = expectedPlainTree(expectedFilePaths);
  const unseenFiles = new Set(expected.files);
  const unseenDirectories = new Set(expected.directories);
  let entryCount = 0;
  const entryLimit = expected.files.size + expected.directories.size;
  const walk = (directory: string, prefix = ""): void => {
    const before = lstatSync(directory);
    if (
      before.isSymbolicLink() || !before.isDirectory() ||
      realpathSync(directory) !== resolve(directory)
    ) throw new Error("Verified bundle exact inventory contains a replaced or symlinked directory at commit");
    const handle = opendirSync(directory);
    try {
      while (true) {
        const entry = handle.readSync();
        if (entry === null) break;
        entryCount += 1;
        if (entryCount > entryLimit) {
          throw new Error("Verified bundle directory does not match its exact inventory at commit");
        }
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = join(directory, entry.name);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`Verified bundle exact inventory contains symlink ${path}`);
        if (stat.isFile()) {
          if (!expected.files.has(path)) {
            throw new Error("Verified bundle directory does not match its exact inventory at commit");
          }
          unseenFiles.delete(path);
        } else if (stat.isDirectory()) {
          if (!expected.directories.has(path)) {
            throw new Error("Verified bundle directory does not match its exact inventory at commit");
          }
          unseenDirectories.delete(path);
          walk(absolute, path);
        } else throw new Error(`Verified bundle exact inventory contains special entry ${path}`);
      }
    } finally {
      handle.closeSync();
    }
    const after = lstatSync(directory);
    if (
      after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev ||
      before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || realpathSync(directory) !== resolve(directory)
    ) throw new Error("Verified bundle exact inventory changed during the synchronous validity commit");
  };
  walk(root);
  if (unseenFiles.size !== 0 || unseenDirectories.size !== 0) {
    throw new Error("Verified bundle directory does not match its exact inventory at commit");
  }
}

function requireRecordedFilesSync(
  root: string,
  artifacts: readonly ArtifactEntry[],
  context: string,
  fileBytesLimit = ARTIFACT_MANIFEST_FILE_BYTES_LIMIT,
  totalBytesLimit = ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT,
): CapturedFileIdentity[] {
  const realRoot = realpathSync(root);
  const identities: CapturedFileIdentity[] = [];
  let totalBytes = 0;
  for (const artifact of artifacts) {
    const candidate = resolve(realRoot, ...safeArtifactSegments(artifact.path));
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${context} contains a non-regular artifact at ${artifact.path}`);
    }
    const actual = realpathSync(candidate);
    if (!pathInside(realRoot, actual)) throw new Error(`${context} artifact escapes at ${artifact.path}`);
    const handle = openSync(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(handle);
      if (!before.isFile() || before.size > fileBytesLimit) {
        throw new Error(`${context} exceeds its synchronous file limit at ${artifact.path}`);
      }
      totalBytes += before.size;
      if (totalBytes > totalBytesLimit) {
        throw new Error(`${context} exceeds its synchronous aggregate limit`);
      }
      const hasher = new Bun.CryptoHasher("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      while (true) {
        const bytesRead = readSync(handle, buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > fileBytesLimit || totalBytes - before.size + size > totalBytesLimit) {
          throw new Error(`${context} exceeds its synchronous byte limit at ${artifact.path}`);
        }
        hasher.update(buffer.subarray(0, bytesRead));
      }
      const after = fstatSync(handle);
      const current = lstatSync(actual);
      const digest = hasher.digest("hex");
      if (
        size !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || !current.isFile() ||
        current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs ||
        realpathSync(candidate) !== actual || size !== artifact.size || digest !== artifact.sha256
      ) throw new Error(`${context} changed at the synchronous validity commit: ${artifact.path}`);
      identities.push(capturedFileIdentity(actual, after));
    } finally {
      closeSync(handle);
    }
  }
  return identities;
}

function requireBuildInputsSync(
  projectRoot: string,
  snapshot: BuildInputSnapshot,
): CapturedFileIdentity[] {
  const realRoot = realpathSync(resolve(projectRoot));
  const identities: CapturedFileIdentity[] = [];
  for (const input of snapshot.inputs) {
    const candidate = resolve(realRoot, ...input.path.replaceAll("\\", "/").split("/"));
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Build input changed at the synchronous validity commit: ${input.path}`);
    }
    const actual = realpathSync(candidate);
    if (!pathInside(realRoot, actual)) {
      throw new Error(`Build input escaped at the synchronous validity commit: ${input.path}`);
    }
    const bytes = readFileSync(actual);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== input.size || digest !== input.sha256) {
      throw new Error(`Build input changed at the synchronous validity commit: ${input.path}`);
    }
    identities.push(capturedFileIdentity(actual, stat));
  }
  return identities;
}

interface CapturedFileIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function capturedFileIdentity(
  path: string,
  stat: Stats,
): CapturedFileIdentity {
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function requireCapturedFileIdentitiesSync(
  identities: readonly CapturedFileIdentity[],
): void {
  for (const identity of identities) {
    const stat = lstatSync(identity.path);
    if (
      stat.isSymbolicLink() || !stat.isFile() || stat.dev !== identity.device ||
      stat.ino !== identity.inode || stat.size !== identity.size ||
      stat.mtimeMs !== identity.mtimeMs || stat.ctimeMs !== identity.ctimeMs ||
      realpathSync(identity.path) !== identity.path
    ) throw new Error("ARTIFACT_INTEGRITY_FAILED: recorded file identity changed before validity commit");
  }
}

interface OwnedPathIdentity {
  readonly device: number;
  readonly inode: number;
}

async function captureOwnedPathIdentity(path: string): Promise<OwnedPathIdentity> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Owned publication path has unsupported identity: ${path}`);
  }
  return { device: stat.dev, inode: stat.ino };
}

async function requireOwnedDirectoryIdentity(
  path: string,
  identity: OwnedPathIdentity,
  context: string,
): Promise<void> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.device ||
    stat.ino !== identity.inode || await realpath(path) !== resolve(path)
  ) throw new Error(`${context} directory identity changed`);
}

function requireOwnedDirectoryIdentitySync(
  path: string,
  identity: OwnedPathIdentity,
  context: string,
): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.device ||
    stat.ino !== identity.inode || realpathSync(path) !== resolve(path)
  ) throw new Error(`${context} directory identity changed at the synchronous validity commit`);
}

async function removeOwnedPath(
  path: string,
  identity: OwnedPathIdentity,
  requestedParent: string,
  publicationParent: string,
): Promise<boolean> {
  try {
    await requirePublicationParentAuthority(requestedParent, publicationParent);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.dev !== identity.device || stat.ino !== identity.inode) return false;
    if (stat.isDirectory()) await rmdir(path);
    else await rm(path, { force: true });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

const VERIFIED_BUNDLE_REQUIRED_KEYS = Object.freeze([
  "schemaVersion",
  "lifecycle",
  "boardRevision",
  "evaluationDate",
  "generatedAt",
  "sourceControl",
  "toolVersions",
  "inputSnapshot",
  "artifacts",
  "statuses",
  "diagnostics",
  "entityProvenance",
  "requiredDimensions",
  "waivers",
  "adapterVersions",
  "externalToolVersions",
  "manufacturingVerification",
  "assetNotices",
  "activeProfiles",
  "capabilities",
  "knownGaps",
  "tscircuit",
  "manufacturingPackages",
  "runtimeEvidencePackages",
  "cryptographicSignature",
] as const);

const VERIFIED_BUNDLE_OPTIONAL_KEYS = Object.freeze([
  "standardsEvidence",
  "sourcingEvidence",
  "functionalEvidence",
  "assetNoticeArtifact",
] as const);

function persistedArtifactEntry(
  value: unknown,
  index: number,
): Readonly<ArtifactEntry> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`artifacts[${index}] must be an object`);
  }
  const artifact = value as Record<string, unknown>;
  assertExactKeys(artifact, ["kind", "path", "sha256", "size"], `artifacts[${index}]`);
  if (
    typeof artifact.kind !== "string" || typeof artifact.path !== "string" ||
    typeof artifact.sha256 !== "string" || !SHA256_HEX.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) || (artifact.size as number) < 0
  ) throw new TypeError(`artifacts[${index}] has invalid required fields`);
  const normalizedPath = artifact.path.replaceAll("\\", "/");
  if (
    normalizedPath.length > ARTIFACT_MANIFEST_PATH_LENGTH_LIMIT ||
    normalizedPath.split("/").length > ARTIFACT_MANIFEST_PATH_DEPTH_LIMIT
  ) throw new TypeError(`artifacts[${index}] path exceeds the verified artifact boundary`);
  if (artifact.kind.length > ARTIFACT_MANIFEST_KIND_LENGTH_LIMIT) {
    throw new TypeError(`artifacts[${index}] kind exceeds the verified artifact boundary`);
  }
  if ((artifact.size as number) > ARTIFACT_MANIFEST_FILE_BYTES_LIMIT) {
    throw new TypeError(`artifacts[${index}] size exceeds the verified artifact boundary`);
  }
  safeArtifactSegments(artifact.path);
  const expectedKind = verifiedProductionArtifactKind(artifact.path);
  if (artifact.kind !== expectedKind) {
    throw new TypeError(
      `artifacts[${index}] type is ${JSON.stringify(artifact.kind)}; expected ${JSON.stringify(expectedKind)} for ${artifact.path}`,
    );
  }
  return Object.freeze({
    kind: artifact.kind,
    path: artifact.path,
    sha256: artifact.sha256,
    size: artifact.size as number,
  });
}

function persistedAssetNotices(value: unknown): readonly VerifiedAssetNotice[] {
  if (!Array.isArray(value)) throw new TypeError("assetNotices must be an array");
  if (value.length > VERIFIED_ASSET_NOTICE_COUNT_LIMIT) {
    throw new TypeError(
      `assetNotices exceeds ${VERIFIED_ASSET_NOTICE_COUNT_LIMIT} entries`,
    );
  }
  let totalNoticeTextBytes = 0;
  for (const [index, item] of value.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`assetNotices[${index}] must be an object`);
    }
    const licenseNoticeText = (item as Record<string, unknown>).licenseNoticeText;
    if (typeof licenseNoticeText !== "string") {
      throw new TypeError(`assetNotices[${index}].licenseNoticeText must be a string`);
    }
    const bytes = Buffer.byteLength(licenseNoticeText, "utf8");
    if (bytes > ASSET_LICENSE_NOTICE_BYTES_LIMIT) {
      throw new TypeError(
        `assetNotices[${index}].licenseNoticeText exceeds ${ASSET_LICENSE_NOTICE_BYTES_LIMIT} UTF-8 bytes`,
      );
    }
    totalNoticeTextBytes += bytes;
    if (totalNoticeTextBytes > VERIFIED_ASSET_NOTICE_TOTAL_BYTES_LIMIT) {
      throw new TypeError(
        `assetNotices license text exceeds ${VERIFIED_ASSET_NOTICE_TOTAL_BYTES_LIMIT} aggregate UTF-8 bytes`,
      );
    }
  }
  return Object.freeze(value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`assetNotices[${index}] must be an object`);
    }
    const notice = item as Record<string, unknown>;
    const keys = [
      "name",
      "source",
      "version",
      "digest",
      "license",
      "attribution",
      "licenseNotice",
      "licenseNoticeDigest",
      "licenseNoticeText",
      "redistribution",
    ] as const;
    assertExactKeys(notice, keys, `assetNotices[${index}]`);
    for (const key of keys) {
      if (typeof notice[key] !== "string" || !(notice[key] as string).trim()) {
        throw new TypeError(`assetNotices[${index}].${key} must be a non-empty string`);
      }
    }
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(notice.digest as string) ||
      !/^sha256:[a-f0-9]{64}$/u.test(notice.licenseNoticeDigest as string) ||
      notice.license !== "MIT" || notice.redistribution !== "allowed" ||
      `sha256:${new Bun.CryptoHasher("sha256").update(notice.licenseNoticeText as string).digest("hex")}` !==
        notice.licenseNoticeDigest ||
      !assetNoticeSatisfiesLicense(
        notice.license as string,
        notice.licenseNoticeText as string,
        notice.attribution as string,
      )
    ) throw new TypeError(`assetNotices[${index}] has invalid license or digest evidence`);
    return Object.freeze(notice as unknown as VerifiedAssetNotice);
  }));
}

function persistedEntityProvenance(value: unknown): readonly VerifiedEntityProvenance[] {
  if (!Array.isArray(value) || value.length > ENTITY_PROVENANCE_LIMIT) {
    throw new TypeError(`entityProvenance must contain at most ${ENTITY_PROVENANCE_LIMIT} records`);
  }
  const ids = new Set<string>();
  const kinds = new Set(["component", "pad", "net", "trace", "via"]);
  const origins = new Set(["authored", "generated", "ambiguous-authored-location"]);
  return Object.freeze(value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`entityProvenance[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    assertExactKeys(
      record,
      ["kind", "elementId", "instancePath", "sourceLocations", "origin"],
      `entityProvenance[${index}]`,
    );
    if (
      typeof record.kind !== "string" || !kinds.has(record.kind) ||
      typeof record.elementId !== "string" || !record.elementId ||
      record.elementId.length > ARTIFACT_MANIFEST_PATH_LENGTH_LIMIT || ids.has(record.elementId) ||
      typeof record.origin !== "string" || !origins.has(record.origin) ||
      !Array.isArray(record.instancePath) || record.instancePath.length < 2 ||
      record.instancePath.length > ENTITY_PROVENANCE_PATH_DEPTH_LIMIT + 1 ||
      !Array.isArray(record.sourceLocations) || record.sourceLocations.length > 256
    ) throw new TypeError(`entityProvenance[${index}] has invalid identity, kind, origin, or cardinality`);
    const validText = (entry: unknown) => typeof entry === "string" && entry.length > 0 &&
      entry.length <= ARTIFACT_MANIFEST_PATH_LENGTH_LIMIT && !/[\0\r\n]/u.test(entry);
    if (!record.instancePath.every(validText) || !record.sourceLocations.every(validText)) {
      throw new TypeError(`entityProvenance[${index}] contains an invalid path or location`);
    }
    if (
      (record.origin === "authored") !== (record.sourceLocations.length > 0) ||
      (record.origin !== "authored" && record.sourceLocations.length !== 0)
    ) throw new TypeError(`entityProvenance[${index}] origin contradicts its source locations`);
    ids.add(record.elementId);
    return Object.freeze({
      kind: record.kind as VerifiedEntityProvenance["kind"],
      elementId: record.elementId,
      instancePath: Object.freeze([...(record.instancePath as string[])]),
      sourceLocations: Object.freeze([...(record.sourceLocations as string[])]),
      origin: record.origin as VerifiedEntityProvenance["origin"],
    });
  }));
}

function persistedFunctionalEvidence(
  value: unknown,
): Readonly<FunctionalSimulationManifestEvidence> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("functionalEvidence must be an object");
  }
  const evidence = value as Record<string, unknown>;
  assertExactKeys(evidence, [
    "schemaVersion", "resultSchemaVersion", "resultSha256", "inputSnapshotDigest",
    "definitionDigest", "circuitDigest", "netlistDigest", "qualificationSha256",
    "modelDigests", "adapter", "tool", "execution",
  ], "functionalEvidence");
  const prefixedDigest = (candidate: unknown, label: string): string => {
    if (typeof candidate !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(candidate)) {
      throw new TypeError(`${label} must be a SHA-256 digest`);
    }
    return candidate;
  };
  if (
    evidence.schemaVersion !== 1 || evidence.resultSchemaVersion !== 2 ||
    typeof evidence.inputSnapshotDigest !== "string" ||
    !SHA256_HEX.test(evidence.inputSnapshotDigest)
  ) throw new TypeError("functionalEvidence has an unsupported schema or input digest");
  const modelRecord = evidence.modelDigests;
  if (
    modelRecord === null || typeof modelRecord !== "object" || Array.isArray(modelRecord) ||
    Object.keys(modelRecord).length > 256
  ) throw new TypeError("functionalEvidence.modelDigests is invalid");
  const modelDigests = Object.freeze(Object.fromEntries(
    Object.entries(modelRecord as Record<string, unknown>).map(([id, digest]) => {
      if (!id || id.length > 4_096 || /[\0\r\n]/u.test(id)) {
        throw new TypeError("functionalEvidence contains an invalid model identity");
      }
      return [id, prefixedDigest(digest, `functionalEvidence.modelDigests.${id}`)];
    }),
  ));
  const adapter = evidence.adapter as Record<string, unknown> | null;
  const tool = evidence.tool as Record<string, unknown> | null;
  const execution = evidence.execution as Record<string, unknown> | null;
  if (adapter === null || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TypeError("functionalEvidence.adapter is invalid");
  }
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    throw new TypeError("functionalEvidence.tool is invalid");
  }
  if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
    throw new TypeError("functionalEvidence.execution is invalid");
  }
  assertExactKeys(adapter, ["name", "version"], "functionalEvidence.adapter");
  assertExactKeys(tool, ["name", "version", "executableSha256"], "functionalEvidence.tool");
  assertExactKeys(execution, ["stdoutSha256", "stderrSha256", "rawOutputSha256"], "functionalEvidence.execution");
  if (
    adapter.name !== "pcboo-ngspice" || typeof adapter.version !== "string" || !adapter.version ||
    tool.name !== "ngspice" || typeof tool.version !== "string" || !tool.version ||
    typeof tool.executableSha256 !== "string" || !SHA256_HEX.test(tool.executableSha256)
  ) throw new TypeError("functionalEvidence adapter or tool identity is invalid");
  return Object.freeze({
    schemaVersion: 1 as const,
    resultSchemaVersion: 2 as const,
    resultSha256: prefixedDigest(evidence.resultSha256, "functionalEvidence.resultSha256"),
    inputSnapshotDigest: evidence.inputSnapshotDigest,
    definitionDigest: prefixedDigest(evidence.definitionDigest, "functionalEvidence.definitionDigest"),
    circuitDigest: prefixedDigest(evidence.circuitDigest, "functionalEvidence.circuitDigest"),
    netlistDigest: prefixedDigest(evidence.netlistDigest, "functionalEvidence.netlistDigest"),
    qualificationSha256: prefixedDigest(evidence.qualificationSha256, "functionalEvidence.qualificationSha256"),
    modelDigests,
    adapter: Object.freeze({ name: "pcboo-ngspice" as const, version: adapter.version }),
    tool: Object.freeze({
      name: "ngspice" as const,
      version: tool.version,
      executableSha256: tool.executableSha256,
    }),
    execution: Object.freeze({
      stdoutSha256: prefixedDigest(execution.stdoutSha256, "functionalEvidence.execution.stdoutSha256"),
      stderrSha256: prefixedDigest(execution.stderrSha256, "functionalEvidence.execution.stderrSha256"),
      rawOutputSha256: prefixedDigest(execution.rawOutputSha256, "functionalEvidence.execution.rawOutputSha256"),
    }),
  });
}

function parsePersistedVerifiedBundleManifest(
  bytes: Uint8Array,
): Readonly<VerifiedBundleManifest> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(`verified bundle manifest is not valid UTF-8 JSON: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("verified bundle manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    [...VERIFIED_BUNDLE_REQUIRED_KEYS, ...VERIFIED_BUNDLE_OPTIONAL_KEYS],
    "verified bundle manifest",
  );
  for (const key of VERIFIED_BUNDLE_REQUIRED_KEYS) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`verified bundle manifest is missing ${key}`);
    }
  }
  if (
    record.schemaVersion !== VERIFIED_BUNDLE_SCHEMA_VERSION || record.lifecycle !== "verified" ||
    typeof record.boardRevision !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.boardRevision) ||
    record.cryptographicSignature !== "absent" || !Array.isArray(record.artifacts)
  ) throw new TypeError("verified bundle manifest has an invalid schema, lifecycle, revision, or signature claim");

  const canonicalBytes = `${JSON.stringify(value, null, 2)}\n`;
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalBytes))) {
    throw new TypeError("verified bundle manifest bytes are not the canonical published encoding");
  }

  if (
    record.artifacts.length === 0 ||
    record.artifacts.length > ARTIFACT_MANIFEST_ENTRY_LIMIT
  ) throw new TypeError("verified bundle manifest has an invalid artifact count");
  const artifacts = Object.freeze(record.artifacts.map(persistedArtifactEntry));
  const paths = new Set<string>();
  let aggregateArtifactBytes = 0;
  for (const artifact of artifacts) {
    const normalized = artifact.path.replaceAll("\\", "/");
    if (paths.has(normalized)) throw new TypeError(`verified bundle manifest duplicates ${normalized}`);
    if (
      normalized === VERIFIED_BUNDLE_MANIFEST_FILENAME ||
      normalized === INCOMPLETE_VERIFIED_BUNDLE_MARKER || normalized === ASSET_NOTICES_FILENAME
    ) throw new TypeError(`verified bundle manifest uses reserved artifact path ${normalized}`);
    paths.add(normalized);
    aggregateArtifactBytes += artifact.size;
    if (aggregateArtifactBytes > ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT) {
      throw new TypeError("verified bundle manifest exceeds the aggregate artifact byte boundary");
    }
  }

  const assetNotices = persistedAssetNotices(record.assetNotices);
  const entityProvenance = persistedEntityProvenance(record.entityProvenance);
  const functionalEvidence = persistedFunctionalEvidence(record.functionalEvidence);
  const persistedStatuses = statusSet(record.statuses as StatusSet);
  if (
    (persistedStatuses.functional.state === "passed") !== (functionalEvidence !== undefined) ||
    persistedStatuses.functional.state === "passed-with-waivers"
  ) {
    throw new TypeError("functional status and internally bound simulation evidence disagree");
  }
  if (
    functionalEvidence !== undefined &&
    functionalEvidence.inputSnapshotDigest !== (record.inputSnapshot as BuildInputSnapshot).digest
  ) throw new TypeError("functional evidence is stale for the persisted input snapshot");
  const expectedNoticeArtifact = assetNoticeEntry(assetNotices);
  if (
    artifacts.length + (expectedNoticeArtifact === undefined ? 0 : 1) >
      ARTIFACT_MANIFEST_ENTRY_LIMIT ||
    aggregateArtifactBytes + (expectedNoticeArtifact?.size ?? 0) >
      ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT
  ) throw new TypeError("verified bundle manifest exceeds the complete publication boundary");
  if (expectedNoticeArtifact === undefined) {
    if (record.assetNoticeArtifact !== undefined) {
      throw new TypeError("assetNoticeArtifact is present without asset notices");
    }
  } else {
    const candidate = record.assetNoticeArtifact;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("assetNoticeArtifact is missing for incorporated third-party assets");
    }
    const artifact = candidate as Record<string, unknown>;
    assertExactKeys(artifact, ["kind", "path", "sha256", "size"], "assetNoticeArtifact");
    if (
      artifact.kind !== expectedNoticeArtifact.kind || artifact.path !== expectedNoticeArtifact.path ||
      artifact.sha256 !== expectedNoticeArtifact.sha256 || artifact.size !== expectedNoticeArtifact.size
    ) throw new TypeError("assetNoticeArtifact is not linked to the rendered third-party notices");
  }

  return Object.freeze({
    ...(value as VerifiedBundleManifest),
    artifacts,
    assetNotices,
    entityProvenance,
    statuses: persistedStatuses,
    ...(functionalEvidence === undefined ? {} : { functionalEvidence }),
    ...(expectedNoticeArtifact === undefined ? {} : { assetNoticeArtifact: expectedNoticeArtifact }),
  });
}

/**
 * Revalidates a completed publication from its persisted manifest, including
 * its generated notice, semantic artifact kinds, and exact directory tree.
 * The required out-of-band manifest digest authenticates which publication
 * manifest the caller intended to trust.
 */
export async function verifyPublishedProductionBundle(
  root: string,
  options: VerifyPublishedProductionBundleOptions,
): Promise<Readonly<PublishedBundleVerification>> {
  requireSupportedBunRuntime();
  const expectedManifestSha256 = options.expectedManifestSha256;
  const afterArtifactIntegrity = options.afterArtifactIntegrity;
  if (!SHA256_HEX.test(expectedManifestSha256)) {
    throw new TypeError("expectedManifestSha256 must be a lowercase SHA-256 digest");
  }
  if (afterArtifactIntegrity !== undefined && typeof afterArtifactIntegrity !== "function") {
    throw new TypeError("afterArtifactIntegrity must be a function");
  }

  const findings: PublishedBundleIntegrityFinding[] = [];
  const bundleRoot = resolve(root);
  const manifestPath = join(bundleRoot, VERIFIED_BUNDLE_MANIFEST_FILENAME);
  let manifestBytes: Uint8Array;
  let manifestSha256: string;
  let manifest: Readonly<VerifiedBundleManifest>;
  try {
    manifestBytes = await readBoundedRegularFile(
      manifestPath,
      VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT,
    );
    manifestSha256 = new Bun.CryptoHasher("sha256").update(manifestBytes).digest("hex");
    manifest = parsePersistedVerifiedBundleManifest(manifestBytes);
  } catch (error) {
    findings.push({
      code: "MANIFEST_INVALID",
      path: VERIFIED_BUNDLE_MANIFEST_FILENAME,
      message: error instanceof Error ? error.message : String(error),
    });
    return Object.freeze({
      integrityValid: false,
      artifactCount: 0,
      findings: Object.freeze(findings),
    });
  }

  if (manifestSha256 !== expectedManifestSha256) {
    findings.push({
      code: "MANIFEST_DIGEST_MISMATCH",
      path: VERIFIED_BUNDLE_MANIFEST_FILENAME,
      message: "Persisted verified-bundle manifest does not match the expected publication digest",
    });
  }

  const publicationArtifacts = Object.freeze([
    ...manifest.artifacts,
    ...(manifest.assetNoticeArtifact === undefined ? [] : [manifest.assetNoticeArtifact]),
  ]);
  const expectedPaths = [
    ...publicationArtifacts.map(({ path }) => path),
    VERIFIED_BUNDLE_MANIFEST_FILENAME,
  ];
  try {
    await requireExactPlainTree(bundleRoot, expectedPaths);
  } catch (error) {
    findings.push({
      code: "BUNDLE_INVENTORY_MISMATCH",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const artifactIntegrity = await verifyArtifactManifest(bundleRoot, {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    lifecycle: "verified",
    boardRevision: manifest.boardRevision,
    artifacts: [...publicationArtifacts],
  });
  for (const finding of artifactIntegrity.findings) {
    findings.push({
      code: "ARTIFACT_INTEGRITY_FAILED",
      ...(finding.path === undefined ? {} : { path: finding.path }),
      message: `${finding.code}: ${finding.message}`,
    });
  }
  let verifiedCircuitDigest: string | undefined;
  try {
    const circuitArtifacts = manifest.artifacts.filter(({ path, kind }) =>
      path === "evidence/circuit.json" && kind === "compiled-circuit"
    );
    if (circuitArtifacts.length !== 1) {
      throw new Error("Verified bundle must contain exactly one typed evidence/circuit.json artifact");
    }
    const circuitBytes = await readBoundedRegularFile(
      join(bundleRoot, "evidence", "circuit.json"),
      ARTIFACT_MANIFEST_FILE_BYTES_LIMIT,
    );
    verifiedCircuitDigest = `sha256:${new Bun.CryptoHasher("sha256").update(circuitBytes).digest("hex")}`;
    const circuitJson = parseCanonicalCircuitJson(
      new TextDecoder("utf-8", { fatal: true }).decode(circuitBytes),
    );
    const expectedHierarchy = deriveCircuitEntityHierarchy(circuitJson)
      .map(({ kind, elementId, instancePath }) =>
        JSON.stringify({ kind, elementId, instancePath })
      )
      .sort();
    const persistedHierarchy = manifest.entityProvenance
      .map(({ kind, elementId, instancePath }) =>
        JSON.stringify({ kind, elementId, instancePath })
      )
      .sort();
    if (JSON.stringify(expectedHierarchy) !== JSON.stringify(persistedHierarchy)) {
      throw new Error(
        "Persisted entity provenance does not exactly match the independently derived Circuit JSON hierarchy",
      );
    }
  } catch (error) {
    findings.push({
      code: "ENTITY_PROVENANCE_INVALID",
      path: "evidence/circuit.json",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    manifest.functionalEvidence !== undefined &&
    verifiedCircuitDigest !== manifest.functionalEvidence.circuitDigest
  ) {
    findings.push({
      code: "FUNCTIONAL_EVIDENCE_INVALID",
      path: "evidence/circuit.json",
      message: "Persisted functional simulation evidence is not bound to the verified Circuit JSON bytes",
    });
  }
  await afterArtifactIntegrity?.();

  try {
    const finalManifestBytes = await readBoundedRegularFile(
      manifestPath,
      VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT,
    );
    const finalDigest = new Bun.CryptoHasher("sha256").update(finalManifestBytes).digest("hex");
    if (finalDigest !== manifestSha256 || !Buffer.from(finalManifestBytes).equals(Buffer.from(manifestBytes))) {
      throw new Error("Persisted verified-bundle manifest changed while the bundle was verified");
    }
    await requireExactPlainTree(bundleRoot, expectedPaths);
  } catch (error) {
    findings.push({
      code: "BUNDLE_INVENTORY_MISMATCH",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // Establish one final synchronous validity point. No event-loop yield occurs
  // between this complete hash/inventory pass and the returned verdict.
  try {
    requireExactPlainTreeSync(bundleRoot, expectedPaths);
    const finalIdentities = [
      ...requireRecordedFilesSync(
        bundleRoot,
        publicationArtifacts,
        "Persisted verified bundle",
      ),
      ...requireRecordedFilesSync(
        bundleRoot,
        [{
          kind: "verified-bundle-manifest",
          path: VERIFIED_BUNDLE_MANIFEST_FILENAME,
          sha256: manifestSha256,
          size: manifestBytes.byteLength,
        }],
        "Persisted verified bundle manifest",
        VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT,
        VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT,
      ),
    ];
    requireExactPlainTreeSync(bundleRoot, expectedPaths);
    requireCapturedFileIdentitiesSync(finalIdentities);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      code: message.includes("directory does not match") || message.includes("exact inventory")
        ? "BUNDLE_INVENTORY_MISMATCH"
        : "ARTIFACT_INTEGRITY_FAILED",
      message,
    });
  }

  return Object.freeze({
    integrityValid: findings.length === 0,
    manifestSha256,
    artifactCount: publicationArtifacts.length,
    findings: Object.freeze(findings),
  });
}

export async function publishVerifiedProductionBundle(
  options: PublishVerifiedProductionBundleOptions,
): Promise<Readonly<PublishedVerifiedProductionBundle>> {
  requireSupportedBunRuntime();
  // Executable test control is not evidence; every data authority is captured
  // synchronously and is never reread from the caller after an await.
  const destinationDirectory = options.destinationDirectory;
  const beforeCommit = options.beforeCommit;
  const beforeValidityCommit = options.beforeValidityCommit;
  const beforeStagingCleanup = options.beforeStagingCleanup;
  const afterSynchronousRecordedFiles = options.afterSynchronousRecordedFiles;
  if (typeof destinationDirectory !== "string" || !destinationDirectory.trim() || destinationDirectory.includes("\0")) {
    throw new TypeError("destinationDirectory is invalid");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") throw new TypeError("beforeCommit must be a function");
  if (beforeValidityCommit !== undefined && typeof beforeValidityCommit !== "function") {
    throw new TypeError("beforeValidityCommit must be a function");
  }
  if (beforeStagingCleanup !== undefined && typeof beforeStagingCleanup !== "function") {
    throw new TypeError("beforeStagingCleanup must be a function");
  }
  if (
    afterSynchronousRecordedFiles !== undefined &&
    typeof afterSynchronousRecordedFiles !== "function"
  ) throw new TypeError("afterSynchronousRecordedFiles must be a function");
  const captured = capturePromotionOptions(options);
  const manifest = await promoteCapturedProductionBundle(captured);
  throwIfPromotionCancelled(captured.signal);
  const publicationArtifacts = Object.freeze([
    ...manifest.artifacts,
    ...(manifest.assetNoticeArtifact === undefined ? [] : [manifest.assetNoticeArtifact]),
  ]);
  const requestedTarget = resolve(destinationDirectory);
  const requestedParent = dirname(requestedTarget);
  const artifactRoot = await realpath(resolve(captured.artifactRoot));
  await rejectSymlinkAncestors(requestedParent);
  await mkdir(requestedParent, { recursive: true });
  await rejectSymlinkAncestors(requestedParent);
  const publicationParent = await realpath(requestedParent);
  const target = join(publicationParent, basename(requestedTarget));
  if (pathInside(artifactRoot, target)) {
    throw new Error("Verified bundle destination cannot be inside the draft artifact root");
  }
  const staging = join(publicationParent, `.${basename(target)}.pcboo-${crypto.randomUUID()}.tmp`);
  let ownsTarget = false;
  let stagingIdentity: OwnedPathIdentity | undefined;
  let targetIdentity: OwnedPathIdentity | undefined;
  let validityTokenIdentity: OwnedPathIdentity | undefined;
  try {
    throwIfPromotionCancelled(captured.signal);
    await mkdir(staging);
    stagingIdentity = await captureOwnedPathIdentity(staging);
    const artifactPaths: string[] = [];
    const artifactTopLevelEntries = new Set<string>();
    for (const artifact of manifest.artifacts) {
      throwIfPromotionCancelled(captured.signal);
      const segments = safeArtifactSegments(artifact.path);
      if (
        segments[0] === VERIFIED_BUNDLE_MANIFEST_FILENAME ||
        segments[0] === INCOMPLETE_VERIFIED_BUNDLE_MARKER
      ) throw new Error(`Verified bundle artifact path is reserved: ${artifact.path}`);
      artifactPaths.push(segments.join("/"));
      artifactTopLevelEntries.add(segments[0]!);
      const source = join(artifactRoot, ...segments);
      const destination = join(staging, ...segments);
      await mkdir(dirname(destination), { recursive: true });
      const bytes = await readFile(source);
      const actualDigest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== artifact.size || actualDigest !== artifact.sha256) {
        throw new Error(`ARTIFACT_INTEGRITY_FAILED: ${artifact.path} changed while publishing`);
      }
      await writeFile(destination, bytes, { flag: "wx" });
      throwIfPromotionCancelled(captured.signal);
    }
    if (manifest.assetNoticeArtifact !== undefined) {
      if (manifest.artifacts.some(({ path }) => path === ASSET_NOTICES_FILENAME)) {
        throw new Error(`Verified bundle artifact path is reserved: ${ASSET_NOTICES_FILENAME}`);
      }
      const content = renderAssetNotices(manifest.assetNotices);
      const bytes = new TextEncoder().encode(content);
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      if (
        manifest.assetNoticeArtifact.kind !== "third-party-notices" ||
        manifest.assetNoticeArtifact.path !== ASSET_NOTICES_FILENAME ||
        manifest.assetNoticeArtifact.size !== bytes.byteLength ||
        manifest.assetNoticeArtifact.sha256 !== digest
      ) throw new Error("ASSET_LICENSE_EVIDENCE_INVALID: generated asset notice identity is inconsistent");
      artifactPaths.push(ASSET_NOTICES_FILENAME);
      artifactTopLevelEntries.add(ASSET_NOTICES_FILENAME);
      await writeFile(join(staging, ASSET_NOTICES_FILENAME), bytes, { flag: "wx" });
    }

    await beforeCommit?.();
    throwIfPromotionCancelled(captured.signal);
    await requirePublicationParentAuthority(requestedParent, publicationParent);
    await requireExactPlainTree(staging, artifactPaths);
    const verifiedSourceManifest: ArtifactManifest = {
      schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
      lifecycle: "draft",
      boardRevision: manifest.boardRevision,
      artifacts: [...manifest.artifacts],
    };
    const [finalInputs, finalSourceIntegrity, stagedIntegrity] = await Promise.all([
      refreshBuildInputSnapshot(captured.projectRoot, manifest.inputSnapshot),
      verifyArtifactManifest(artifactRoot, verifiedSourceManifest),
      verifyArtifactManifest(staging, {
        schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
        lifecycle: "verified",
        boardRevision: manifest.boardRevision,
        artifacts: [...publicationArtifacts],
      }),
    ]);
    if (finalInputs.digest !== manifest.inputSnapshot.digest) {
      throw new Error("BUILD_INPUT_STALE: build inputs changed while publishing");
    }
    if (!finalSourceIntegrity.integrityValid || !stagedIntegrity.integrityValid) {
      throw new Error("ARTIFACT_INTEGRITY_FAILED: source or staged bundle artifacts changed while publishing");
    }
    throwIfPromotionCancelled(captured.signal);

    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(manifestBytes, "utf8") > VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT) {
      throw new Error(
        `Verified bundle manifest exceeds ${VERIFIED_BUNDLE_MANIFEST_BYTES_LIMIT} bytes`,
      );
    }
    const manifestSha256 = new Bun.CryptoHasher("sha256").update(manifestBytes).digest("hex");

    await requirePublicationParentAuthority(requestedParent, publicationParent);
    await mkdir(target);
    ownsTarget = true;
    targetIdentity = await captureOwnedPathIdentity(target);
    await requireOwnedDirectoryIdentity(target, targetIdentity, "Verified bundle target");
    await writeFile(
      join(target, INCOMPLETE_VERIFIED_BUNDLE_MARKER),
      manifestBytes,
      { flag: "wx" },
    );
    validityTokenIdentity = await captureOwnedPathIdentity(
      join(target, INCOMPLETE_VERIFIED_BUNDLE_MARKER),
    );
    for (const entry of [...artifactTopLevelEntries].sort()) {
      throwIfPromotionCancelled(captured.signal);
      await requireOwnedDirectoryIdentity(target, targetIdentity, "Verified bundle target");
      await rename(join(staging, entry), join(target, entry));
    }
    await requireExactPlainTree(staging, []);
    await beforeStagingCleanup?.();
    throwIfPromotionCancelled(captured.signal);
    if (!await removeOwnedPath(staging, stagingIdentity, requestedParent, publicationParent)) {
      throw new Error(`Verified bundle staging cleanup could not be authenticated at ${staging}`);
    }
    stagingIdentity = undefined;
    await beforeValidityCommit?.();
    throwIfPromotionCancelled(captured.signal);
    await requirePublicationParentAuthority(requestedParent, publicationParent);
    await requireOwnedDirectoryIdentity(target, targetIdentity, "Verified bundle target");
    const preManifestPaths = [...artifactPaths, INCOMPLETE_VERIFIED_BUNDLE_MARKER];
    await requireExactPlainTree(target, preManifestPaths);
    await requireOwnedDirectoryIdentity(target, targetIdentity, "Verified bundle target");
    await Promise.all([
      ...artifactPaths.map((path) => chmod(join(target, ...path.split("/")), 0o444)),
      chmod(join(target, INCOMPLETE_VERIFIED_BUNDLE_MARKER), 0o444),
    ]);
    const [committedInputs, committedSourceIntegrity, committedArtifactIntegrity] = await Promise.all([
      refreshBuildInputSnapshot(captured.projectRoot, manifest.inputSnapshot),
      verifyArtifactManifest(artifactRoot, verifiedSourceManifest),
      verifyArtifactManifest(target, {
        schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
        lifecycle: "verified",
        boardRevision: manifest.boardRevision,
        artifacts: [...publicationArtifacts],
      }),
    ]);
    if (committedInputs.digest !== manifest.inputSnapshot.digest) {
      throw new Error("BUILD_INPUT_STALE: build inputs changed at the validity boundary");
    }
    if (!committedSourceIntegrity.integrityValid || !committedArtifactIntegrity.integrityValid) {
      throw new Error("ARTIFACT_INTEGRITY_FAILED: source or committed artifacts changed at the validity boundary");
    }
    throwIfPromotionCancelled(captured.signal);
    await requirePublicationParentAuthority(requestedParent, publicationParent);
    await requireOwnedDirectoryIdentity(target, targetIdentity, "Verified bundle target");
    const validityToken = join(target, INCOMPLETE_VERIFIED_BUNDLE_MARKER);
    const candidateStat = await lstat(validityToken);
    if (
      candidateStat.isSymbolicLink() || !candidateStat.isFile() ||
      candidateStat.dev !== validityTokenIdentity.device ||
      candidateStat.ino !== validityTokenIdentity.inode ||
      await readFile(validityToken, "utf8") !== manifestBytes
    ) {
      throw new Error("ARTIFACT_INTEGRITY_FAILED: verified manifest changed at the validity boundary");
    }
    throwIfPromotionCancelled(captured.signal);
    requirePublicationParentAuthoritySync(requestedParent, publicationParent);
    requireOwnedDirectoryIdentitySync(target, targetIdentity, "Verified bundle target");
    requireExactPlainTreeSync(target, preManifestPaths);
    const synchronouslyRecordedFiles = [
      ...requireRecordedFilesSync(target, publicationArtifacts, "Committed verified bundle"),
      ...requireRecordedFilesSync(artifactRoot, manifest.artifacts, "Draft artifact authority"),
      ...requireBuildInputsSync(captured.projectRoot, manifest.inputSnapshot),
    ];
    afterSynchronousRecordedFiles?.();
    const synchronousTokenStat = lstatSync(validityToken);
    if (
      synchronousTokenStat.isSymbolicLink() || !synchronousTokenStat.isFile() ||
      synchronousTokenStat.dev !== validityTokenIdentity.device ||
      synchronousTokenStat.ino !== validityTokenIdentity.inode ||
      readFileSync(validityToken, "utf8") !== manifestBytes
    ) {
      throw new Error("ARTIFACT_INTEGRITY_FAILED: verified manifest changed at the synchronous validity commit");
    }
    // Hashing every recorded artifact and input can take materially longer
    // than the first synchronous inventory scan. Recheck membership after
    // those reads so a concurrent external writer cannot use that interval to
    // leave unmanifested content present at the validity rename.
    requireOwnedDirectoryIdentitySync(target, targetIdentity, "Verified bundle target");
    requireExactPlainTreeSync(target, preManifestPaths);
    requireCapturedFileIdentitiesSync(synchronouslyRecordedFiles);
    requireOwnedDirectoryIdentitySync(target, targetIdentity, "Verified bundle target");
    const finalTokenStat = lstatSync(validityToken);
    if (
      finalTokenStat.isSymbolicLink() || !finalTokenStat.isFile() ||
      finalTokenStat.dev !== validityTokenIdentity.device ||
      finalTokenStat.ino !== validityTokenIdentity.inode ||
      readFileSync(validityToken, "utf8") !== manifestBytes
    ) {
      throw new Error("ARTIFACT_INTEGRITY_FAILED: verified manifest changed immediately before the validity rename");
    }
    // One inode is both the incomplete token and the exact verified manifest.
    // This atomic rename is the validity commit: there is no state with neither
    // name, no event-loop yield after the final exact byte checks, and no
    // fallible cleanup step afterward.
    renameSync(validityToken, join(target, VERIFIED_BUNDLE_MANIFEST_FILENAME));
    validityTokenIdentity = undefined;
    return Object.freeze({
      root: target,
      manifestPath: join(target, VERIFIED_BUNDLE_MANIFEST_FILENAME),
      manifestSha256,
      artifactCount: publicationArtifacts.length,
    });
  } catch (error) {
    const retained: string[] = [];
    if (
      stagingIdentity !== undefined &&
      !await removeOwnedPath(staging, stagingIdentity, requestedParent, publicationParent)
    ) retained.push(staging);
    if (retained.length > 0) {
      throw new AggregateError(
        [error],
        `${error instanceof Error ? error.message : String(error)}; recovery retained at ${retained.join(", ")}`,
      );
    }
    if (ownsTarget) {
      throw new AggregateError(
        [error],
        `${error instanceof Error ? error.message : String(error)}; incomplete publication retained at ${target}`,
      );
    }
    throw error;
  }
}
