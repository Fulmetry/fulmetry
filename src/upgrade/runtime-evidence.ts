// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import {
  TSCIRCUIT_RUNTIME_PLATFORM_NAMES,
  type TscircuitRuntimePlatform,
} from "./platforms";
import { parseJsonWithoutDuplicateKeys } from "./jsonc";

const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;

export interface TscircuitRuntimeEvidence {
  readonly schemaVersion: 1;
  readonly candidate: Readonly<{ version: string; integrity: string; contentSha256: string }>;
  readonly baselineAnchorSha256: string;
  readonly semanticReportSha256: string | null;
  readonly bunVersion: string;
  readonly platform: TscircuitRuntimePlatform;
  readonly implementationSha256: string;
  readonly profiles: Readonly<{
    repository: Readonly<{ closureSha256: string; lockSha256: string }>;
    packedConsumer: Readonly<{
      closureSha256: string;
      lockSha256: string;
      manifestSha256: string;
      packedFulmetryContentSha256: string;
      projectFulmetryLockSha256: string;
      singleEngineResolutionSha256: string;
      fulmetryTarballSha256: string;
      fulmetryTarballIntegrity: string;
      contractVersion: 2;
    }>;
  }>;
  readonly evidenceSha256: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonical(value)).digest("hex");
}

export function canonicalTscircuitRuntimeEvidenceJson(
  value: TscircuitRuntimeEvidence,
): string {
  return `${canonical(value)}\n`;
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has unexpected fields`);
  }
}

function candidate(value: TscircuitRuntimeEvidence["candidate"]): TscircuitRuntimeEvidence["candidate"] {
  assertRecord(value, "Runtime evidence candidate");
  assertKeys(value, ["contentSha256", "integrity", "version"], "Runtime evidence candidate");
  if (!SEMVER.test(value.version)) throw new TypeError("Runtime evidence candidate version must be canonical semver");
  const match = SRI.exec(value.integrity);
  const decoded = match === null ? undefined : Buffer.from(match[1]!, "base64");
  if (
    match === null || match[1]!.length % 4 !== 0 || decoded?.byteLength !== 64 ||
    decoded.toString("base64") !== match[1]
  ) {
    throw new TypeError("Runtime evidence candidate integrity must be canonical sha512 SRI");
  }
  assertDigest(value.contentSha256, "Runtime evidence candidate contentSha256");
  return Object.freeze({ ...value });
}

export function parseTscircuitRuntimeEvidence(value: unknown): Readonly<TscircuitRuntimeEvidence> {
  assertRecord(value, "Runtime evidence");
  assertKeys(value, [
    "baselineAnchorSha256", "bunVersion", "candidate", "evidenceSha256", "implementationSha256",
    "semanticReportSha256",
    "platform", "profiles", "schemaVersion",
  ], "Runtime evidence");
  if (value.schemaVersion !== 1) throw new TypeError("Unsupported runtime evidence schema");
  if (typeof value.platform !== "string" || !TSCIRCUIT_RUNTIME_PLATFORM_NAMES.includes(value.platform as TscircuitRuntimePlatform)) {
    throw new TypeError("Unsupported runtime evidence platform");
  }
  if (value.bunVersion !== "1.3.14") throw new TypeError("Runtime evidence requires Bun 1.3.14");
  assertDigest(value.baselineAnchorSha256, "Runtime evidence baselineAnchorSha256");
  if (value.semanticReportSha256 !== null) {
    assertDigest(value.semanticReportSha256, "Runtime evidence semanticReportSha256");
  }
  assertDigest(value.implementationSha256, "Runtime evidence implementationSha256");
  assertDigest(value.evidenceSha256, "Runtime evidence evidenceSha256");
  assertRecord(value.profiles, "Runtime evidence profiles");
  assertKeys(value.profiles, ["packedConsumer", "repository"], "Runtime evidence profiles");
  assertRecord(value.profiles.repository, "Runtime evidence repository profile");
  assertKeys(value.profiles.repository, ["closureSha256", "lockSha256"], "Runtime evidence repository profile");
  assertRecord(value.profiles.packedConsumer, "Runtime evidence packed profile");
  assertKeys(value.profiles.packedConsumer, [
    "closureSha256", "lockSha256", "manifestSha256", "packedFulmetryContentSha256",
    "contractVersion", "fulmetryTarballIntegrity", "fulmetryTarballSha256",
    "projectFulmetryLockSha256", "singleEngineResolutionSha256",
  ], "Runtime evidence packed profile");
  const parsedCandidate = candidate(value.candidate as TscircuitRuntimeEvidence["candidate"]);
  for (const [label, hash] of [
    ["repository closure", value.profiles.repository.closureSha256],
    ["repository lock", value.profiles.repository.lockSha256],
    ["packed closure", value.profiles.packedConsumer.closureSha256],
    ["packed lock", value.profiles.packedConsumer.lockSha256],
    ["packed manifest", value.profiles.packedConsumer.manifestSha256],
    ["packed Fulmetry content", value.profiles.packedConsumer.packedFulmetryContentSha256],
    ["packed project fulmetry.lock", value.profiles.packedConsumer.projectFulmetryLockSha256],
    ["packed single-engine resolution", value.profiles.packedConsumer.singleEngineResolutionSha256],
    ["packed Fulmetry tarball", value.profiles.packedConsumer.fulmetryTarballSha256],
  ] as const) assertDigest(hash, label);
  if (value.profiles.packedConsumer.contractVersion !== 2) throw new TypeError("Unsupported packed-consumer contract version");
  const packedIntegrity = value.profiles.packedConsumer.fulmetryTarballIntegrity;
  if (typeof packedIntegrity !== "string") throw new TypeError("Packed Fulmetry tarball integrity must be canonical sha512 SRI");
  const packedSri = SRI.exec(packedIntegrity);
  if (
    packedSri === null || packedSri[1]!.length % 4 !== 0 ||
    Buffer.from(packedSri[1]!, "base64").byteLength !== 64 ||
    Buffer.from(packedSri[1]!, "base64").toString("base64") !== packedSri[1]
  ) {
    throw new TypeError("Packed Fulmetry tarball integrity must be canonical sha512 SRI");
  }
  const parsed = value as unknown as TscircuitRuntimeEvidence;
  const { evidenceSha256, ...body } = parsed;
  if (digest(body) !== evidenceSha256) throw new TypeError("Runtime evidence self-digest is invalid");
  return Object.freeze({ ...parsed, candidate: parsedCandidate });
}

export function parseTscircuitRuntimeEvidenceText(text: string): Readonly<TscircuitRuntimeEvidence> {
  const parsed = parseTscircuitRuntimeEvidence(
    parseJsonWithoutDuplicateKeys(text, "Runtime evidence"),
  );
  if (canonicalTscircuitRuntimeEvidenceJson(parsed) !== text) {
    throw new TypeError("Runtime evidence bytes must be canonical JSON");
  }
  return parsed;
}

export function createTscircuitRuntimeEvidence(
  value: Omit<TscircuitRuntimeEvidence, "schemaVersion" | "evidenceSha256">,
): Readonly<TscircuitRuntimeEvidence> {
  if (!TSCIRCUIT_RUNTIME_PLATFORM_NAMES.includes(value.platform)) throw new TypeError("Unsupported runtime evidence platform");
  if (value.bunVersion !== "1.3.14") throw new TypeError("Runtime evidence requires Bun 1.3.14");
  for (const [label, hash] of [
    ["baselineAnchorSha256", value.baselineAnchorSha256],
    ["implementationSha256", value.implementationSha256],
    ["repository closure", value.profiles.repository.closureSha256],
    ["repository lock", value.profiles.repository.lockSha256],
    ["packed closure", value.profiles.packedConsumer.closureSha256],
    ["packed lock", value.profiles.packedConsumer.lockSha256],
    ["packed manifest", value.profiles.packedConsumer.manifestSha256],
    ["packed Fulmetry content", value.profiles.packedConsumer.packedFulmetryContentSha256],
    ["packed project fulmetry.lock", value.profiles.packedConsumer.projectFulmetryLockSha256],
    ["packed single-engine resolution", value.profiles.packedConsumer.singleEngineResolutionSha256],
    ["packed Fulmetry tarball", value.profiles.packedConsumer.fulmetryTarballSha256],
  ] as const) assertDigest(hash, label);
  if (value.semanticReportSha256 !== null) {
    assertDigest(value.semanticReportSha256, "semanticReportSha256");
  }
  if (value.profiles.packedConsumer.contractVersion !== 2) throw new TypeError("Unsupported packed-consumer contract version");
  const packedSri = SRI.exec(value.profiles.packedConsumer.fulmetryTarballIntegrity);
  if (
    packedSri === null || packedSri[1]!.length % 4 !== 0 ||
    Buffer.from(packedSri[1]!, "base64").byteLength !== 64 ||
    Buffer.from(packedSri[1]!, "base64").toString("base64") !== packedSri[1]
  ) throw new TypeError("Packed Fulmetry tarball integrity must be canonical sha512 SRI");
  const body = Object.freeze({ schemaVersion: 1 as const, ...value, candidate: candidate(value.candidate) });
  return Object.freeze({ ...body, evidenceSha256: digest(body) });
}
