// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import ts from "typescript";
import { requireCompleteTscircuitRuntimeClosures } from "./platforms";

export interface CanonicalRefreshEngineIdentity {
  readonly version: string;
  readonly integrity: string;
  readonly contentSha256: string;
}

export interface TscircuitCompatibilityAnchor {
  readonly schemaVersion: 3;
  readonly accepted: CanonicalRefreshEngineIdentity;
  readonly runtimeClosures: Readonly<Record<string, Readonly<{
    readonly repository: string;
    readonly packedConsumer: string;
  }>>>;
  readonly acceptedUpgradeReview: null | Readonly<{
    readonly fromVersion: string;
    readonly reportSha256: string;
    readonly runtimeEvidenceSha256: string;
  }>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA512_SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;

function isCanonicalSha512Sri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SHA512_SRI_PATTERN.exec(value);
  if (match === null || match[1]!.length % 4 !== 0) return false;
  const decoded = Buffer.from(match[1]!, "base64");
  return decoded.byteLength === 64 && decoded.toString("base64") === match[1];
}

export function parseTscircuitCompatibilityAnchor(value: unknown): Readonly<TscircuitCompatibilityAnchor> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tscircuit compatibility anchor must be an object");
  }
  const anchor = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(anchor).sort()) !== JSON.stringify([
    "accepted", "acceptedUpgradeReview", "runtimeClosures", "schemaVersion",
  ])) throw new TypeError("tscircuit compatibility anchor has unexpected fields");
  if (anchor.schemaVersion !== 3) throw new TypeError("Unsupported tscircuit compatibility anchor schema");
  if (anchor.accepted === null || typeof anchor.accepted !== "object" || Array.isArray(anchor.accepted)) {
    throw new TypeError("tscircuit compatibility anchor accepted identity must be an object");
  }
  const accepted = anchor.accepted as Record<string, unknown>;
  if (JSON.stringify(Object.keys(accepted).sort()) !== JSON.stringify([
    "contentSha256", "integrity", "version",
  ])) throw new TypeError("tscircuit compatibility anchor accepted identity has unexpected fields");
  if (typeof accepted.version !== "string" || !SEMVER_PATTERN.test(accepted.version)) {
    throw new TypeError("tscircuit compatibility anchor version must be exact canonical semver");
  }
  if (!isCanonicalSha512Sri(accepted.integrity)) {
    throw new TypeError("tscircuit compatibility anchor integrity must be canonical 64-byte sha512 SRI");
  }
  if (typeof accepted.contentSha256 !== "string" || !SHA256_PATTERN.test(accepted.contentSha256)) {
    throw new TypeError("tscircuit compatibility anchor contentSha256 must be lowercase SHA-256");
  }
  if (
    anchor.runtimeClosures === null || typeof anchor.runtimeClosures !== "object" ||
    Array.isArray(anchor.runtimeClosures)
  ) throw new TypeError("tscircuit compatibility anchor runtimeClosures must be an object");
  const runtimeClosures: Record<string, Readonly<{ repository: string; packedConsumer: string }>> = {};
  for (const [platform, rawProfiles] of Object.entries(anchor.runtimeClosures as Record<string, unknown>).sort()) {
    if (!/^[a-z0-9]+-[a-z0-9_]+$/u.test(platform)) {
      throw new TypeError("tscircuit compatibility runtime platform must be canonical");
    }
    if (rawProfiles === null || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) {
      throw new TypeError(`tscircuit compatibility runtime closures for ${platform} must be an object`);
    }
    const profiles = rawProfiles as Record<string, unknown>;
    if (JSON.stringify(Object.keys(profiles).sort()) !== JSON.stringify(["packedConsumer", "repository"])) {
      throw new TypeError(`tscircuit compatibility runtime closures for ${platform} have unexpected profiles`);
    }
    if (
      typeof profiles.repository !== "string" || !SHA256_PATTERN.test(profiles.repository) ||
      typeof profiles.packedConsumer !== "string" || !SHA256_PATTERN.test(profiles.packedConsumer)
    ) throw new TypeError(`tscircuit compatibility runtime closures for ${platform} must be lowercase SHA-256`);
    runtimeClosures[platform] = Object.freeze({
      repository: profiles.repository,
      packedConsumer: profiles.packedConsumer,
    });
  }
  requireCompleteTscircuitRuntimeClosures(runtimeClosures);
  let acceptedUpgradeReview: TscircuitCompatibilityAnchor["acceptedUpgradeReview"] = null;
  if (anchor.acceptedUpgradeReview !== null) {
    if (
      typeof anchor.acceptedUpgradeReview !== "object" ||
      Array.isArray(anchor.acceptedUpgradeReview)
    ) throw new TypeError("acceptedUpgradeReview must be null or an object");
    const review = anchor.acceptedUpgradeReview as Record<string, unknown>;
    if (JSON.stringify(Object.keys(review).sort()) !== JSON.stringify([
      "fromVersion", "reportSha256", "runtimeEvidenceSha256",
    ])) {
      throw new TypeError("acceptedUpgradeReview has unexpected fields");
    }
    if (typeof review.fromVersion !== "string" || !SEMVER_PATTERN.test(review.fromVersion)) {
      throw new TypeError("acceptedUpgradeReview.fromVersion must be exact canonical semver");
    }
    if (typeof review.reportSha256 !== "string" || !SHA256_PATTERN.test(review.reportSha256)) {
      throw new TypeError("acceptedUpgradeReview.reportSha256 must be lowercase SHA-256");
    }
    if (
      typeof review.runtimeEvidenceSha256 !== "string" ||
      !SHA256_PATTERN.test(review.runtimeEvidenceSha256)
    ) throw new TypeError("acceptedUpgradeReview.runtimeEvidenceSha256 must be lowercase SHA-256");
    acceptedUpgradeReview = Object.freeze({
      fromVersion: review.fromVersion,
      reportSha256: review.reportSha256,
      runtimeEvidenceSha256: review.runtimeEvidenceSha256,
    });
  }
  return Object.freeze({
    schemaVersion: 3,
    accepted: Object.freeze({
      version: accepted.version,
      integrity: accepted.integrity,
      contentSha256: accepted.contentSha256,
    }),
    runtimeClosures: Object.freeze(runtimeClosures),
    acceptedUpgradeReview,
  });
}

function rejectDuplicateAnchorKeys(text: string): void {
  const source = ts.parseJsonText("compatibility/tscircuit.json", text);
  const diagnostics = (source as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length > 0) {
    throw new TypeError(
      `tscircuit compatibility anchor is invalid JSON: ${ts.flattenDiagnosticMessageText(
        diagnostics[0]!.messageText,
        " ",
      )}`,
    );
  }
  const walk = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set<string>();
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          (!ts.isStringLiteral(property.name) && !ts.isNumericLiteral(property.name))
        ) throw new TypeError("tscircuit compatibility anchor contains an unsupported JSON property");
        const key = property.name.text;
        if (keys.has(key)) {
          throw new TypeError(`tscircuit compatibility anchor contains duplicate key ${JSON.stringify(key)}`);
        }
        keys.add(key);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
}

export function parseTscircuitCompatibilityAnchorText(
  text: string,
): Readonly<TscircuitCompatibilityAnchor> {
  if (typeof text !== "string") throw new TypeError("tscircuit compatibility anchor text must be a string");
  rejectDuplicateAnchorKeys(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TypeError(
      `tscircuit compatibility anchor must be strict JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseTscircuitCompatibilityAnchor(value);
}

/**
 * Golden refresh is maintenance for the separately recorded compatibility
 * anchor, never an upgrade mechanism. This is a review-visible tripwire, not
 * proof of human acceptance: only the separate digest-bound acceptance
 * transaction may advance the anchor after fresh qualification.
 */
export function requireAcceptedEngineForCanonicalRefresh(options: Readonly<{
  fixtureName: string;
  anchored: CanonicalRefreshEngineIdentity;
  requested: CanonicalRefreshEngineIdentity;
}>): void {
  const { fixtureName, anchored, requested } = options;
  for (const field of ["version", "integrity", "contentSha256"] as const) {
    if (anchored[field] !== requested[field]) {
      throw new Error(
        `TSCIRCUIT_UPGRADE_REVIEW_REQUIRED: the accepted compatibility anchor records tscircuit ${field} ` +
        `${JSON.stringify(anchored[field])}, but ${fixtureName} refresh requested ${JSON.stringify(requested[field])}; ` +
        "ordinary golden refresh cannot advance the anchor; a digest-bound upstream acceptance transaction is required",
      );
    }
  }
}
