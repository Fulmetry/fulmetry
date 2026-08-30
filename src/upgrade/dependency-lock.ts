// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fingerprintInstalledPackageClosure } from "../engine-package-fingerprint";
import { resolveTscircuitEntryFresh } from "../internal/fresh-package-entry";
import { parseJsoncWithoutDuplicateKeys } from "./jsonc";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA512_SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;

export interface InspectTscircuitDependencyLockOptions {
  readonly lockPath: string;
  readonly candidatePackageRoot: string;
  readonly expectedVersion: string;
  readonly expectedIntegrity: string;
  /** @internal Adversarial test hook, after the first authenticated read. */
  readonly afterInitialRead?: () => Promise<void>;
}

export interface TscircuitDependencyLockDescriptor {
  readonly lockPath: string;
  readonly lockRoot: string;
  readonly nodeModulesRoot: string;
  readonly candidatePackageRoot: string;
  readonly version: string;
  readonly integrity: string;
  readonly dependencyLockSha256: string;
  readonly installedClosureSha256: string;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertSemver(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 128 || !SEMVER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an exact canonical semantic version`);
  }
}

function assertSha512Sri(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical 64-byte sha512 SRI`);
  const match = SHA512_SRI_PATTERN.exec(value);
  if (match === null) throw new TypeError(`${label} must be a canonical 64-byte sha512 SRI`);
  const encoded = match[1]!;
  const decoded = Buffer.from(encoded, "base64");
  if (encoded.length % 4 !== 0 || decoded.byteLength !== 64 || decoded.toString("base64") !== encoded) {
    throw new TypeError(`${label} must be a canonical 64-byte sha512 SRI`);
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function inspectTscircuitDependencyLock(
  options: InspectTscircuitDependencyLockOptions,
): Promise<Readonly<TscircuitDependencyLockDescriptor>> {
  if (typeof options.lockPath !== "string" || !isAbsolute(options.lockPath)) {
    throw new TypeError("Candidate dependency lock must be an explicit absolute bun.lock path");
  }
  assertSemver(options.expectedVersion, "Expected candidate tscircuit version");
  assertSha512Sri(options.expectedIntegrity, "Expected candidate tscircuit integrity");

  const initialStat = await lstat(options.lockPath);
  if (!initialStat.isFile() || initialStat.isSymbolicLink() || basename(options.lockPath) !== "bun.lock") {
    throw new TypeError("Candidate dependency lock must be a regular file named bun.lock");
  }
  const lockPath = await realpath(options.lockPath);
  const lockRoot = dirname(lockPath);
  const bytes = await readFile(lockPath);
  const text = new TextDecoder().decode(bytes);
  const parsed = parseJsoncWithoutDuplicateKeys(text, "Candidate bun.lock");
  assertRecord(parsed, "Candidate bun.lock");
  if (parsed.lockfileVersion !== 1 || parsed.configVersion !== 1) {
    throw new TypeError("Candidate bun.lock lockfileVersion and configVersion must both be 1");
  }
  assertRecord(parsed.workspaces, "Candidate bun.lock workspaces");
  if (JSON.stringify(Object.keys(parsed.workspaces).sort()) !== JSON.stringify([""])) {
    throw new TypeError("Candidate bun.lock must contain only the single Fulmetry root workspace");
  }
  assertRecord(parsed.workspaces[""], "Candidate bun.lock root workspace");
  const rootWorkspace = parsed.workspaces[""];
  assertRecord(rootWorkspace.devDependencies, "Candidate bun.lock root devDependencies");
  assertRecord(rootWorkspace.peerDependencies, "Candidate bun.lock root peerDependencies");
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const declarations = rootWorkspace[field];
    if (declarations !== undefined) {
      assertRecord(declarations, `Candidate bun.lock root ${field}`);
      if ("tscircuit" in declarations) {
        throw new TypeError(
          `Candidate bun.lock root ${field} must not contain a conflicting tscircuit declaration`,
        );
      }
    }
  }
  if (
    rootWorkspace.devDependencies.tscircuit !== options.expectedVersion ||
    rootWorkspace.peerDependencies.tscircuit !== options.expectedVersion
  ) throw new TypeError("Candidate bun.lock root dev and peer tscircuit pins must exactly match the candidate version");

  assertRecord(parsed.packages, "Candidate bun.lock packages");
  for (const [key, value] of Object.entries(parsed.packages)) {
    if (key === "tscircuit") continue;
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].startsWith("tscircuit@")) {
      throw new TypeError("Candidate bun.lock contains another tscircuit package tuple");
    }
  }
  const entry = parsed.packages.tscircuit;
  if (
    !Array.isArray(entry) || entry.length !== 4 || entry[0] !== `tscircuit@${options.expectedVersion}` ||
    entry[1] !== "" || entry[2] === null || typeof entry[2] !== "object" || Array.isArray(entry[2])
  ) {
    throw new TypeError("Candidate bun.lock must contain one exact packages.tscircuit tuple for the candidate version");
  }
  assertSha512Sri(entry[3], "Candidate bun.lock tscircuit integrity");
  if (entry[3] !== options.expectedIntegrity) {
    throw new TypeError("Candidate bun.lock tscircuit integrity does not match the supplied candidate integrity");
  }

  const nodeModulesRoot = await realpath(join(lockRoot, "node_modules"));
  const directPackageRoot = await realpath(join(nodeModulesRoot, "tscircuit"));
  const candidatePackageRoot = await realpath(options.candidatePackageRoot);
  if (directPackageRoot !== candidatePackageRoot) {
    throw new TypeError("Candidate tscircuit package is not the candidate bun.lock direct node_modules/tscircuit package");
  }
  const initialPackageStat = await lstat(directPackageRoot);
  const entryPath = await resolveTscircuitEntryFresh(lockRoot);
  const installedClosureSha256 = await fingerprintInstalledPackageClosure(candidatePackageRoot, {
    entryPath,
    resolutionOrigin: lockRoot,
  });

  await options.afterInitialRead?.();
  const finalStat = await lstat(lockPath);
  const finalBytes = await readFile(lockPath);
  const finalDirectPackageRoot = await realpath(join(nodeModulesRoot, "tscircuit"));
  const finalPackageStat = await lstat(finalDirectPackageRoot);
  if (
    finalStat.isSymbolicLink() || !finalStat.isFile() ||
    finalStat.dev !== initialStat.dev || finalStat.ino !== initialStat.ino ||
    finalStat.size !== initialStat.size || finalStat.mtimeMs !== initialStat.mtimeMs ||
    sha256(finalBytes) !== sha256(bytes) || finalDirectPackageRoot !== candidatePackageRoot ||
    finalPackageStat.dev !== initialPackageStat.dev || finalPackageStat.ino !== initialPackageStat.ino
  ) throw new Error("Candidate bun.lock or direct tscircuit package changed during inspection");

  return Object.freeze({
    lockPath,
    lockRoot,
    nodeModulesRoot,
    candidatePackageRoot,
    version: options.expectedVersion,
    integrity: options.expectedIntegrity,
    dependencyLockSha256: sha256(bytes),
    installedClosureSha256,
  });
}
