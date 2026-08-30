// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  fingerprintEnginePackage,
  fingerprintInstalledPackageClosure,
  readStableEnginePackageFile,
} from "../engine-package-fingerprint";
import { resolveTscircuitEntryFresh } from "../internal/fresh-package-entry";

const PACKAGE_NAME = "tscircuit";
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SRI_PATTERN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/;
const SRI_LENGTHS = Object.freeze({ sha256: 32, sha384: 48, sha512: 64 });
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f]/;

export interface InspectTscircuitCandidatePackageOptions {
  /** An already-installed or unpacked package directory. This function never installs it. */
  readonly packageDirectory: string;
  /** The registry/package-manager SRI. It is evidence distinct from the unpacked content hash. */
  readonly integrity: string;
  /** Consumer root used to resolve the exact bare runtime entrypoint. */
  readonly resolutionOrigin?: string;
  /** Exact bare entry resolved in a fresh trusted process by the caller. */
  readonly resolvedEntryPath?: string;
}

export interface TscircuitCandidatePackageDescriptor {
  readonly realPackageRoot: string;
  readonly entryPath: string;
  readonly version: string;
  readonly integrity: string;
  readonly contentSha256: string;
  readonly runtimeClosureSha256: string;
}

function validateIntegrity(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("Candidate tscircuit integrity must be a non-empty npm SRI string");
  }
  const match = SRI_PATTERN.exec(value);
  if (match === null) {
    throw new TypeError("Candidate tscircuit integrity must be one canonical sha256, sha384, or sha512 SRI");
  }
  const algorithm = match[1] as keyof typeof SRI_LENGTHS;
  const encoded = match[2]!;
  if (encoded.length % 4 !== 0) {
    throw new TypeError("Candidate tscircuit integrity contains malformed base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.byteLength !== SRI_LENGTHS[algorithm] ||
    decoded.toString("base64") !== encoded
  ) {
    throw new TypeError("Candidate tscircuit integrity has the wrong or non-canonical digest encoding");
  }
  return value;
}

function validateVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("Candidate tscircuit package version must be a non-empty string");
  }
  if (value.length > 128 || UNSAFE_TEXT_PATTERN.test(value) || !SEMVER_PATTERN.test(value)) {
    throw new TypeError(`Candidate tscircuit package version is unsafe or is not valid semver: ${JSON.stringify(value)}`);
  }
  return value;
}

function validatePathSegments(value: string, context: string, requireDotPrefix: boolean): void {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    UNSAFE_TEXT_PATTERN.test(value) ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new TypeError(`${context} is not a safe package-relative path`);
  }
  if (requireDotPrefix && !value.startsWith("./")) {
    throw new TypeError(`${context} must start with ./`);
  }
  const withoutPrefix = value.startsWith("./") ? value.slice(2) : value;
  if (
    withoutPrefix.length === 0 ||
    withoutPrefix.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${context} contains an empty or traversal path segment`);
  }
}

function validateExports(value: unknown, context = "package.json exports"): void {
  if (value === null) return;
  if (typeof value === "string") {
    validatePathSegments(value, context, true);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw new TypeError(`${context} must not be an empty fallback array`);
    value.forEach((item, index) => validateExports(item, `${context}[${index}]`));
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${context} has an unsupported target`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new TypeError(`${context} must not be empty`);
  for (const [key, target] of entries) {
    if (key.length === 0 || key.length > 128 || UNSAFE_TEXT_PATTERN.test(key) || key.includes("\\")) {
      throw new TypeError(`${context} contains an unsafe key`);
    }
    if (key === ".") {
      // The package root is the one valid exports key without a trailing path.
    } else if (key.startsWith(".")) validatePathSegments(key, `${context} key`, true);
    else if (!/^[A-Za-z0-9][A-Za-z0-9._@<>=-]*$/.test(key)) {
      throw new TypeError(`${context} contains an unsafe condition key: ${JSON.stringify(key)}`);
    }
    validateExports(target, `${context}.${key}`);
  }
}

function assertInsidePackage(realPackageRoot: string, candidate: string, context: string): void {
  const pathFromRoot = relative(realPackageRoot, candidate);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRoot)) {
    throw new TypeError(`${context} resolves outside the candidate tscircuit package`);
  }
}

async function fingerprintRegularPackage(realPackageRoot: string): Promise<string> {
  return fingerprintEnginePackage(realPackageRoot);
}

/**
 * Inspects untrusted candidate package bytes without treating them as Fulmetry's accepted engine.
 * The candidate entrypoint is resolved but deliberately never imported or executed.
 */
export async function inspectTscircuitCandidatePackage(
  options: InspectTscircuitCandidatePackageOptions,
): Promise<Readonly<TscircuitCandidatePackageDescriptor>> {
  if (typeof options.packageDirectory !== "string" || options.packageDirectory.length === 0) {
    throw new TypeError("Candidate tscircuit packageDirectory must be a non-empty explicit path");
  }
  const integrity = validateIntegrity(options.integrity);
  if (typeof options.packageDirectory !== "string" || !isAbsolute(options.packageDirectory)) {
    throw new TypeError("Candidate tscircuit packageDirectory must be an explicit absolute path");
  }
  if (options.resolutionOrigin !== undefined && !isAbsolute(options.resolutionOrigin)) {
    throw new TypeError("Candidate tscircuit resolutionOrigin must be an explicit absolute consumer path");
  }
  const realPackageRoot = await realpath(options.packageDirectory);
  const rootStat = await lstat(realPackageRoot);
  if (!rootStat.isDirectory()) {
    throw new TypeError("Candidate tscircuit packageDirectory must resolve to a directory");
  }

  const packageJsonPath = join(realPackageRoot, "package.json");
  const metadataBytes = await readStableEnginePackageFile(packageJsonPath);
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes),
    ) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("package.json must contain an object");
    }
    metadata = parsed as Record<string, unknown>;
  } catch (error) {
    throw new TypeError(`Candidate tscircuit package.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.name !== PACKAGE_NAME) {
    throw new TypeError(`Candidate package name must be exactly ${PACKAGE_NAME}`);
  }
  const version = validateVersion(metadata.version);
  if (metadata.main !== undefined) {
    if (typeof metadata.main !== "string") throw new TypeError("Candidate package.json main must be a string");
    validatePathSegments(metadata.main, "package.json main", false);
  }
  if (metadata.exports !== undefined) validateExports(metadata.exports);

  const contentSha256 = await fingerprintRegularPackage(realPackageRoot);
  let resolvedEntry: string;
  try {
    resolvedEntry = options.resolvedEntryPath ?? (options.resolutionOrigin === undefined
      ? Bun.resolveSync(realPackageRoot, dirname(realPackageRoot))
      : await resolveTscircuitEntryFresh(options.resolutionOrigin));
  } catch (error) {
    throw new TypeError(`Candidate tscircuit package entrypoint cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entryPath = await realpath(resolvedEntry);
  assertInsidePackage(realPackageRoot, entryPath, "Candidate package entrypoint");
  const entryStat = await lstat(entryPath);
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new TypeError("Candidate tscircuit package entrypoint must be a regular file");
  }
  const runtimeClosureSha256 = await fingerprintInstalledPackageClosure(realPackageRoot, {
    entryPath,
    ...(options.resolutionOrigin === undefined ? {} : { resolutionOrigin: options.resolutionOrigin }),
  });
  if (contentSha256 !== await fingerprintRegularPackage(realPackageRoot)) {
    throw new Error("Candidate tscircuit package changed while it was being inspected");
  }
  if (runtimeClosureSha256 !== await fingerprintInstalledPackageClosure(realPackageRoot, {
    entryPath,
    ...(options.resolutionOrigin === undefined ? {} : { resolutionOrigin: options.resolutionOrigin }),
  })) {
    throw new Error("Candidate tscircuit runtime closure changed while it was being inspected");
  }
  if (!Buffer.from(metadataBytes).equals(await readStableEnginePackageFile(packageJsonPath))) {
    throw new Error("Candidate tscircuit package metadata changed while it was being inspected");
  }

  return Object.freeze({
    realPackageRoot,
    entryPath,
    version,
    integrity,
    contentSha256,
    runtimeClosureSha256,
  });
}
