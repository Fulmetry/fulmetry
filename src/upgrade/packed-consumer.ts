// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fingerprintEnginePackage, fingerprintInstalledPackageClosure } from "../engine-package-fingerprint";
import { resolvePackageEntryFresh, resolveTscircuitEntryFresh } from "../internal/fresh-package-entry";
import { parseJsoncWithoutDuplicateKeys, parseJsonWithoutDuplicateKeys } from "./jsonc";
import { parsePcbooLock } from "../project/lock";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
const QUALIFIED_TSCIRCUIT_CLI_VERSION = "0.1.1858";
const QUALIFIED_TSCIRCUIT_CLI_INTEGRITY = "sha512-FPrP/p1BqGHTOKXiKHv1CCe95jE2fuOKLBjA52GdrlWy9QB9VMY8rgjr8JHj8OjU2R3WzX7rWQ//+NO2qsisoA==";
const QUALIFIED_BUN_MATCH_SVG_VERSION = "0.0.15";

export interface InspectPackedConsumerOptions {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly expectedVersion: string;
  readonly expectedIntegrity: string;
  readonly expectedPcbooVersion: string;
  /** Additional package roots whose file identities must not be shared. */
  readonly independentTscircuitRoots?: readonly string[];
  readonly afterInitialRead?: () => void | Promise<void>;
}

export interface PackedConsumerDescriptor {
  readonly root: string;
  readonly nodeModulesRoot: string;
  readonly tscircuitPackageRoot: string;
  readonly pcbooPackageRoot: string;
  readonly entryPath: string;
  readonly runtimeClosureSha256: string;
  readonly lockSha256: string;
  readonly manifestSha256: string;
  readonly packedPcbooContentSha256: string;
  readonly projectPcbooLockSha256: string;
  readonly pcbooTarballSha256: string;
  readonly pcbooTarballIntegrity: string;
  readonly singleEngineResolutionSha256: string;
}

export const PACKED_CONSUMER_CONTRACT_VERSION = 2 as const;

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sha512Sri(bytes: Uint8Array): string {
  return `sha512-${Buffer.from(new Bun.CryptoHasher("sha512").update(bytes).digest()).toString("base64")}`;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function relativeOwnedPath(root: string, candidate: string, label: string): string {
  const path = relative(root, candidate);
  if (path === "" || isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new TypeError(`${label} is outside its direct installed package`);
  }
  return path.replaceAll("\\", "/");
}

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function keys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has unexpected fields`);
  }
}

function canonicalSri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SRI.exec(value);
  if (match === null || match[1]!.length % 4 !== 0) return false;
  const bytes = Buffer.from(match[1]!, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === match[1];
}

async function regularFileBytes(
  path: string,
  label: string,
  byteLimit = 16 * 1024 * 1024,
): Promise<Readonly<{ bytes: Uint8Array; stat: Awaited<ReturnType<typeof lstat>> }>> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > byteLimit) {
    throw new TypeError(`${label} must be a regular non-link file no larger than ${byteLimit} bytes`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size
  ) throw new Error(`${label} changed while being read`);
  return Object.freeze({ bytes, stat: after });
}

async function inspectPackageTarball(bytes: Uint8Array): Promise<Readonly<{
  name: string;
  version: string;
  contentSha256: string;
  packageMetadata: Record<string, unknown>;
}>> {
  const archive = new Bun.Archive(bytes);
  const files = await archive.files();
  const manifestFile = files.get("package/package.json");
  if (manifestFile === undefined || manifestFile.size > 1024 * 1024) {
    throw new TypeError("Packed PCBoo tarball must contain one bounded package/package.json");
  }
  if (files.size === 0 || files.size > 8_192) throw new TypeError("Packed PCBoo tarball file count is invalid");
  const owned: Array<Readonly<{ path: string; file: File }>> = [];
  let totalBytes = 0;
  for (const [path, file] of files) {
    if (
      !path.startsWith("package/") || path === "package/" ||
      path.includes("\\") || path.includes("\0") ||
      path.slice("package/".length).split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) throw new TypeError("Packed PCBoo tarball contains an unsafe regular-file path");
    const relativePath = path.slice("package/".length);
    if (relativePath === "node_modules" || relativePath.startsWith("node_modules/")) {
      throw new TypeError("Packed PCBoo tarball contains an installation layout");
    }
    if (file.size > 64 * 1024 * 1024) throw new TypeError("Packed PCBoo tarball contains an oversized file");
    totalBytes += file.size;
    if (totalBytes > 128 * 1024 * 1024) throw new TypeError("Packed PCBoo tarball is too large");
    owned.push(Object.freeze({ path: relativePath, file }));
  }
  owned.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const item of owned) {
    hasher.update(item.path);
    hasher.update("\0");
    hasher.update(await item.file.bytes());
    hasher.update("\0");
  }
  const value = parseJsonWithoutDuplicateKeys(await manifestFile.text(), "Packed PCBoo tarball manifest");
  record(value, "Packed PCBoo tarball manifest");
  if (value.name !== "pcboo" || typeof value.version !== "string" || !SEMVER.test(value.version)) {
    throw new TypeError("Packed PCBoo tarball identity is invalid");
  }
  return Object.freeze({
    name: value.name,
    version: value.version,
    contentSha256: hasher.digest("hex"),
    packageMetadata: Object.freeze({ ...value }),
  });
}

function canonicalLockMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    "dependencies", "optionalDependencies", "peerDependencies", "bin", "os", "cpu",
  ].flatMap((key) => value[key] === undefined ? [] : [[key, value[key]] as const]));
}

/** Bun 1.3.14 authenticates tarball bytes with SRI but omits package platform
 * selectors from a local-tarball lock tuple. We authenticate those selectors
 * directly from the tarball manifest and require the exact Bun lock projection. */
function canonicalLocalTarballLockMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    "dependencies", "optionalDependencies", "peerDependencies", "bin",
  ].flatMap((key) => value[key] === undefined ? [] : [[key, value[key]] as const]));
}

interface IndependenceEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

async function captureIndependenceTree(root: string, label: string): Promise<readonly IndependenceEntry[]> {
  const result: IndependenceEntry[] = [];
  let entries = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > 32) throw new TypeError(`${label} exceeds the independence depth limit`);
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        entries += 1;
        if (entries > 32_768) throw new TypeError(`${label} exceeds the independence entry limit`);
        if (!entry.name || entry.name.includes("/") || entry.name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(entry.name)) {
          throw new TypeError(`${label} contains an unsafe entry name`);
        }
        if (relativeDirectory === "" && [".git", ".pcboo", ".pcboo-ci", "node_modules"].includes(entry.name)) continue;
        const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new TypeError(`${label} contains a symlink`);
        const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
        if (kind === undefined) throw new TypeError(`${label} contains a special filesystem entry`);
        result.push(Object.freeze({
          path: relativePath, kind, dev: stat.dev, ino: stat.ino, size: stat.size,
          mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
        }));
        if (kind === "directory") await visit(path, relativePath, depth + 1);
      }
    } finally {
      try { await handle.close(); } catch { /* for-await closes on completion */ }
    }
  };
  await visit(root, "", 0);
  return Object.freeze(result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function requirePackageTreesAreStablyInodeDisjoint(options: Readonly<{
  leftRoot: string;
  rightRoot: string;
  label: string;
}>): Promise<void> {
  const rightInitial = await captureIndependenceTree(options.rightRoot, options.label);
  const leftInitial = await captureIndependenceTree(options.leftRoot, options.label);
  const rightFinal = await captureIndependenceTree(options.rightRoot, options.label);
  const leftFinal = await captureIndependenceTree(options.leftRoot, options.label);
  if (JSON.stringify(rightInitial) !== JSON.stringify(rightFinal) || JSON.stringify(leftInitial) !== JSON.stringify(leftFinal)) {
    throw new Error(`${options.label} changed during independence inspection`);
  }
  const rightIdentities = new Set(rightFinal.filter(({ kind }) => kind === "file").map(({ dev, ino }) => `${dev}:${ino}`));
  if (leftFinal.some(({ kind, dev, ino }) => kind === "file" && rightIdentities.has(`${dev}:${ino}`))) {
    throw new TypeError(`${options.label} shares a hard-linked file`);
  }
}

/** Authenticates a clean, physically independent consumer of the packed PCBoo tarball. */
export async function inspectPackedConsumer(
  options: InspectPackedConsumerOptions,
): Promise<Readonly<PackedConsumerDescriptor>> {
  if (!isAbsolute(options.root) || !isAbsolute(options.repositoryRoot)) {
    throw new TypeError("Packed consumer and repository roots must be absolute");
  }
  if (!SEMVER.test(options.expectedVersion) || !SEMVER.test(options.expectedPcbooVersion)) {
    throw new TypeError("Packed consumer expected versions must be canonical semver");
  }
  if (!canonicalSri(options.expectedIntegrity)) {
    throw new TypeError("Packed consumer tscircuit integrity must be canonical sha512 SRI");
  }
  const requestedRootStat = await lstat(options.root);
  if (!requestedRootStat.isDirectory() || requestedRootStat.isSymbolicLink()) {
    throw new TypeError("Packed consumer root must be a physical directory");
  }
  const root = await realpath(options.root);
  const repositoryRoot = await realpath(options.repositoryRoot);
  if (root === repositoryRoot) throw new TypeError("Packed consumer must not be the repository");
  const nodeModulesPath = join(root, "node_modules");
  const nodeModulesStat = await lstat(nodeModulesPath);
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
    throw new TypeError("Packed consumer node_modules must be a physical directory");
  }
  const nodeModulesRoot = await realpath(nodeModulesPath);
  if (nodeModulesRoot === await realpath(join(repositoryRoot, "node_modules"))) {
    throw new TypeError("Packed consumer node_modules must be physically distinct from the repository");
  }
  const pcbooSlot = join(nodeModulesPath, "pcboo");
  const pcbooSlotStat = await lstat(pcbooSlot);
  if (!pcbooSlotStat.isDirectory() || pcbooSlotStat.isSymbolicLink()) {
    throw new TypeError("Packed consumer pcboo must be an unpacked physical directory, not a workspace link");
  }
  const pcbooPackageRoot = await realpath(pcbooSlot);
  const tscircuitSlot = join(nodeModulesPath, "tscircuit");
  const tscircuitSlotStat = await lstat(tscircuitSlot);
  if (!tscircuitSlotStat.isDirectory() || tscircuitSlotStat.isSymbolicLink()) {
    throw new TypeError("Packed consumer tscircuit must be an unpacked physical directory");
  }
  const tscircuitPackageRoot = await realpath(tscircuitSlot);
  if (isInside(repositoryRoot, pcbooPackageRoot) || isInside(repositoryRoot, tscircuitPackageRoot)) {
    throw new TypeError("Packed consumer package roots must not point into the repository");
  }
  await requirePackageTreesAreStablyInodeDisjoint({
    leftRoot: pcbooPackageRoot,
    rightRoot: repositoryRoot,
    label: "Packed consumer PCBoo package",
  });
  for (const independentRoot of options.independentTscircuitRoots ?? []) {
    await requirePackageTreesAreStablyInodeDisjoint({
      leftRoot: tscircuitPackageRoot,
      rightRoot: await realpath(independentRoot),
      label: "Packed and candidate tscircuit packages",
    });
  }
  await requirePackageTreesAreStablyInodeDisjoint({
    leftRoot: tscircuitPackageRoot,
    rightRoot: join(repositoryRoot, "node_modules", "tscircuit"),
    label: "Packed consumer tscircuit package",
  });

  const manifestPath = join(root, "package.json");
  const lockPath = join(root, "bun.lock");
  const pcbooLockPath = join(root, "pcboo.lock");
  const manifestRead = await regularFileBytes(manifestPath, "Packed consumer manifest", 1024 * 1024);
  const lockRead = await regularFileBytes(lockPath, "Packed consumer lock", 64 * 1024 * 1024);
  const pcbooLockRead = await regularFileBytes(pcbooLockPath, "Packed consumer pcboo.lock", 1024 * 1024);
  const manifest = parseJsonWithoutDuplicateKeys(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestRead.bytes),
    "Packed consumer manifest",
  );
  record(manifest, "Packed consumer manifest");
  keys(manifest, [
    "dependencies", "devDependencies", "engines", "name", "overrides", "packageManager", "private", "scripts", "type", "version",
  ], "Packed consumer manifest");
  if (
    manifest.name !== "board" || manifest.version !== "0.0.0" || manifest.private !== true ||
    manifest.type !== "module" || manifest.packageManager !== "bun@1.3.14"
  ) {
    throw new TypeError("Packed consumer manifest identity is invalid");
  }
  record(manifest.engines, "Packed consumer engines");
  keys(manifest.engines, ["bun"], "Packed consumer engines");
  if (manifest.engines.bun !== "1.3.14") throw new TypeError("Packed consumer Bun engine is invalid");
  record(manifest.scripts, "Packed consumer scripts");
  if (JSON.stringify(manifest.scripts) !== JSON.stringify({
    build: "pcboo build",
    check: "pcboo check",
    inspect: "pcboo inspect",
    dev: "pcboo dev",
    test: "pcboo test",
    "export:gerbers": "pcboo export gerbers",
  })) throw new TypeError("Packed consumer scripts differ from the qualified scaffold");
  record(manifest.devDependencies, "Packed consumer devDependencies");
  keys(manifest.devDependencies, ["@types/bun", "@types/node"], "Packed consumer devDependencies");
  if (
    manifest.devDependencies["@types/bun"] !== "1.3.14" ||
    manifest.devDependencies["@types/node"] !== "24.13.3"
  ) throw new TypeError("Packed consumer runtime type dependencies are invalid");
  record(manifest.dependencies, "Packed consumer dependencies");
  keys(manifest.dependencies, ["pcboo", "tscircuit"], "Packed consumer dependencies");
  const pcbooReference = `file:../../packages/pcboo-${options.expectedPcbooVersion}.tgz`;
  if (
    manifest.dependencies.pcboo !== pcbooReference ||
    manifest.dependencies.tscircuit !== options.expectedVersion
  ) throw new TypeError("Packed consumer dependencies are not the exact qualified inputs");
  record(manifest.overrides, "Packed consumer overrides");
  keys(manifest.overrides, ["@tscircuit/cli", "bun-match-svg"], "Packed consumer overrides");
  if (
    manifest.overrides["@tscircuit/cli"] !== QUALIFIED_TSCIRCUIT_CLI_VERSION ||
    manifest.overrides["bun-match-svg"] !== QUALIFIED_BUN_MATCH_SVG_VERSION
  ) {
    throw new TypeError("Packed consumer dependency overrides are not qualified");
  }
  const pcbooTarball = join(dirname(dirname(root)), "packages", `pcboo-${options.expectedPcbooVersion}.tgz`);
  const pcbooTarballRead = await regularFileBytes(pcbooTarball, "Packed PCBoo tarball", 64 * 1024 * 1024);
  const tarballManifest = await inspectPackageTarball(pcbooTarballRead.bytes);
  if (tarballManifest.version !== options.expectedPcbooVersion) {
    throw new TypeError("Packed PCBoo tarball version does not match the qualification request");
  }
  if (
    JSON.stringify(tarballManifest.packageMetadata.os) !== JSON.stringify(["darwin"]) ||
    JSON.stringify(tarballManifest.packageMetadata.cpu) !== JSON.stringify(["arm64"])
  ) {
    throw new TypeError("Packed PCBoo tarball must target only Apple Silicon macOS");
  }

  const lock = parseJsoncWithoutDuplicateKeys(
    new TextDecoder("utf-8", { fatal: true }).decode(lockRead.bytes),
    "Packed consumer bun.lock",
  );
  record(lock, "Packed consumer bun.lock");
  keys(lock, ["configVersion", "lockfileVersion", "overrides", "packages", "workspaces"], "Packed consumer bun.lock");
  record(lock.overrides, "Packed consumer lock overrides");
  keys(lock.overrides, ["@tscircuit/cli", "bun-match-svg"], "Packed consumer lock overrides");
  if (
    lock.overrides["@tscircuit/cli"] !== QUALIFIED_TSCIRCUIT_CLI_VERSION ||
    lock.overrides["bun-match-svg"] !== QUALIFIED_BUN_MATCH_SVG_VERSION
  ) throw new TypeError("Packed consumer lock overrides are not qualified");
  if (lock.lockfileVersion !== 1 || lock.configVersion !== 1) throw new TypeError("Packed consumer lock format is unsupported");
  record(lock.workspaces, "Packed consumer lock workspaces");
  keys(lock.workspaces, [""], "Packed consumer lock workspaces");
  record(lock.workspaces[""], "Packed consumer lock root workspace");
  const workspace = lock.workspaces[""];
  keys(workspace, ["dependencies", "devDependencies", "name"], "Packed consumer lock root workspace");
  if (workspace.name !== manifest.name) throw new TypeError("Packed consumer lock root name differs from its manifest");
  record(workspace.dependencies, "Packed consumer lock dependencies");
  if (JSON.stringify(workspace.dependencies) !== JSON.stringify(manifest.dependencies)) {
    throw new TypeError("Packed consumer lock root dependencies differ from its manifest");
  }
  record(workspace.devDependencies, "Packed consumer lock devDependencies");
  if (JSON.stringify(workspace.devDependencies) !== JSON.stringify(manifest.devDependencies)) {
    throw new TypeError("Packed consumer lock root devDependencies differ from its manifest");
  }
  record(lock.packages, "Packed consumer lock packages");
  const cliTuple = lock.packages["@tscircuit/cli"];
  if (
    !Array.isArray(cliTuple) || cliTuple.length !== 4 ||
    cliTuple[0] !== `@tscircuit/cli@${QUALIFIED_TSCIRCUIT_CLI_VERSION}` || cliTuple[1] !== "" ||
    cliTuple[2] === null || typeof cliTuple[2] !== "object" || Array.isArray(cliTuple[2]) ||
    cliTuple[3] !== QUALIFIED_TSCIRCUIT_CLI_INTEGRITY
  ) throw new TypeError("Packed consumer lock does not bind the qualified tscircuit CLI tuple");
  const cliScopeSlot = join(nodeModulesPath, "@tscircuit");
  const cliPackageSlot = join(cliScopeSlot, "cli");
  const [cliScopeStat, cliPackageStat] = await Promise.all([lstat(cliScopeSlot), lstat(cliPackageSlot)]);
  if (
    !cliScopeStat.isDirectory() || cliScopeStat.isSymbolicLink() ||
    !cliPackageStat.isDirectory() || cliPackageStat.isSymbolicLink()
  ) throw new TypeError("Packed consumer tscircuit CLI must use physical scope and package directories");
  const cliPackageRoot = await realpath(cliPackageSlot);
  if (isInside(repositoryRoot, cliPackageRoot)) throw new TypeError("Packed consumer tscircuit CLI points into the repository");
  const cliMetadata = parseJsonWithoutDuplicateKeys(
    new TextDecoder("utf-8", { fatal: true }).decode(
      (await regularFileBytes(join(cliPackageRoot, "package.json"), "Packed tscircuit CLI manifest")).bytes,
    ),
    "Packed tscircuit CLI manifest",
  );
  record(cliMetadata, "Packed tscircuit CLI manifest");
  const qualifiedCliLockMetadata = {
    peerDependencies: { "circuit-json": "^0.0.464", tscircuit: "*" },
    bin: { "tscircuit-cli": "cli/entrypoint.js" },
  };
  if (
    cliMetadata.name !== "@tscircuit/cli" || cliMetadata.version !== QUALIFIED_TSCIRCUIT_CLI_VERSION ||
    JSON.stringify(cliTuple[2]) !== JSON.stringify(qualifiedCliLockMetadata) ||
    JSON.stringify(cliMetadata.peerDependencies) !== JSON.stringify(qualifiedCliLockMetadata.peerDependencies) ||
    JSON.stringify(cliMetadata.bin) !== JSON.stringify({ "tscircuit-cli": "./cli/entrypoint.js" })
  ) throw new TypeError("Packed consumer installed tscircuit CLI differs from its qualified lock tuple");
  const tscircuitTuple = lock.packages.tscircuit;
  if (
    !Array.isArray(tscircuitTuple) || tscircuitTuple.length !== 4 ||
    tscircuitTuple[0] !== `tscircuit@${options.expectedVersion}` || tscircuitTuple[1] !== "" ||
    tscircuitTuple[2] === null || typeof tscircuitTuple[2] !== "object" || Array.isArray(tscircuitTuple[2]) ||
    !canonicalSri(tscircuitTuple[3]) || tscircuitTuple[3] !== options.expectedIntegrity
  ) throw new TypeError("Packed consumer lock does not bind the exact tscircuit tuple and integrity");
  const installedTscircuitMetadata = parseJsonWithoutDuplicateKeys(
    new TextDecoder("utf-8", { fatal: true }).decode(
      (await regularFileBytes(join(tscircuitPackageRoot, "package.json"), "Packed tscircuit manifest")).bytes,
    ),
    "Packed tscircuit manifest",
  );
  record(installedTscircuitMetadata, "Packed tscircuit manifest");
  if (JSON.stringify(tscircuitTuple[2]) !== JSON.stringify(canonicalLockMetadata(installedTscircuitMetadata))) {
    throw new TypeError("Packed consumer tscircuit lock metadata differs from its installed package manifest");
  }
  const pcbooTuple = lock.packages.pcboo;
  if (
    !Array.isArray(pcbooTuple) || pcbooTuple.length !== 3 ||
    pcbooTuple[0] !== `pcboo@../../packages/pcboo-${options.expectedPcbooVersion}.tgz` ||
    pcbooTuple[1] === null || typeof pcbooTuple[1] !== "object" || Array.isArray(pcbooTuple[1]) ||
    !canonicalSri(pcbooTuple[2]) || pcbooTuple[2] !== sha512Sri(pcbooTarballRead.bytes)
  ) throw new TypeError("Packed consumer lock does not bind the exact packed PCBoo tarball");
  if (JSON.stringify(pcbooTuple[1]) !== JSON.stringify(canonicalLocalTarballLockMetadata(tarballManifest.packageMetadata))) {
    throw new TypeError("Packed consumer PCBoo lock metadata differs from its authenticated tarball manifest");
  }
  for (const [key, tuple] of Object.entries(lock.packages)) {
    if (key === "pcboo" || key === "tscircuit" || !Array.isArray(tuple) || typeof tuple[0] !== "string") continue;
    const identity = tuple[0].toLowerCase();
    if (
      /(?:^|[/+:])pcboo@/u.test(identity) ||
      /(?:^|[/+:])tscircuit@/u.test(identity)
    ) throw new TypeError("Packed consumer lock contains another PCBoo or tscircuit package tuple");
  }
  const pcbooLockText = new TextDecoder("utf-8", { fatal: true }).decode(pcbooLockRead.bytes);
  parseJsonWithoutDuplicateKeys(pcbooLockText, "Packed consumer pcboo.lock");
  const parsedPcbooLock = parsePcbooLock(pcbooLockText);
  if (
    parsedPcbooLock.tscircuit.version !== options.expectedVersion ||
    parsedPcbooLock.tscircuit.integrity !== options.expectedIntegrity
  ) throw new TypeError("Packed consumer pcboo.lock does not bind the candidate tscircuit identity");

  const pcbooEntryPath = await resolvePackageEntryFresh("pcboo", root);
  const pcbooEntryRelative = relativeOwnedPath(pcbooPackageRoot, pcbooEntryPath, "Packed PCBoo entry");
  const entryPath = await resolveTscircuitEntryFresh(root);
  const pcbooAuthoringOrigin = join(pcbooPackageRoot, "src");
  const fromPcboo = await resolveTscircuitEntryFresh(pcbooAuthoringOrigin);
  if (entryPath !== fromPcboo) throw new TypeError("Packed consumer and packed PCBoo resolve different tscircuit engines");
  const tscircuitEntryRelative = relativeOwnedPath(tscircuitPackageRoot, entryPath, "Packed tscircuit entry");
  const singleEngineResolutionSha256 = sha256(new TextEncoder().encode(JSON.stringify({
    pcbooEntry: pcbooEntryRelative,
    tscircuitEntry: tscircuitEntryRelative,
  })));
  const runtimeClosureSha256 = await fingerprintInstalledPackageClosure(tscircuitPackageRoot, {
    entryPath,
    resolutionOrigin: root,
  });
  const packedPcbooContentSha256 = await fingerprintEnginePackage(pcbooPackageRoot);
  if (packedPcbooContentSha256 !== tarballManifest.contentSha256) {
    throw new TypeError("Installed packed PCBoo bytes do not match the referenced tarball");
  }

  await options.afterInitialRead?.();
  await requirePackageTreesAreStablyInodeDisjoint({
    leftRoot: pcbooPackageRoot,
    rightRoot: repositoryRoot,
    label: "Packed consumer PCBoo package",
  });
  for (const independentRoot of options.independentTscircuitRoots ?? []) {
    await requirePackageTreesAreStablyInodeDisjoint({
      leftRoot: tscircuitPackageRoot,
      rightRoot: await realpath(independentRoot),
      label: "Packed and candidate tscircuit packages",
    });
  }
  await requirePackageTreesAreStablyInodeDisjoint({
    leftRoot: tscircuitPackageRoot,
    rightRoot: join(repositoryRoot, "node_modules", "tscircuit"),
    label: "Packed consumer tscircuit package",
  });
  const [manifestFinal, lockFinal, pcbooLockFinal, pcbooTarballFinal] = await Promise.all([
    regularFileBytes(manifestPath, "Packed consumer manifest", 1024 * 1024),
    regularFileBytes(lockPath, "Packed consumer lock", 64 * 1024 * 1024),
    regularFileBytes(pcbooLockPath, "Packed consumer pcboo.lock", 1024 * 1024),
    regularFileBytes(pcbooTarball, "Packed PCBoo tarball", 64 * 1024 * 1024),
  ]);
  const [rootFinalStat, nodeModulesFinalStat, pcbooSlotFinalStat, tscircuitSlotFinalStat, cliScopeFinalStat, cliPackageFinalStat] = await Promise.all([
    lstat(root), lstat(nodeModulesPath), lstat(pcbooSlot), lstat(tscircuitSlot), lstat(cliScopeSlot), lstat(cliPackageSlot),
  ]);
  if (
    rootFinalStat.isSymbolicLink() || !rootFinalStat.isDirectory() ||
    rootFinalStat.dev !== requestedRootStat.dev || rootFinalStat.ino !== requestedRootStat.ino ||
    nodeModulesFinalStat.isSymbolicLink() || !nodeModulesFinalStat.isDirectory() ||
    nodeModulesFinalStat.dev !== nodeModulesStat.dev || nodeModulesFinalStat.ino !== nodeModulesStat.ino ||
    pcbooSlotFinalStat.isSymbolicLink() || !pcbooSlotFinalStat.isDirectory() ||
    pcbooSlotFinalStat.dev !== pcbooSlotStat.dev || pcbooSlotFinalStat.ino !== pcbooSlotStat.ino ||
    tscircuitSlotFinalStat.isSymbolicLink() || !tscircuitSlotFinalStat.isDirectory() ||
    tscircuitSlotFinalStat.dev !== tscircuitSlotStat.dev || tscircuitSlotFinalStat.ino !== tscircuitSlotStat.ino ||
    cliScopeFinalStat.isSymbolicLink() || !cliScopeFinalStat.isDirectory() ||
    cliScopeFinalStat.dev !== cliScopeStat.dev || cliScopeFinalStat.ino !== cliScopeStat.ino ||
    cliPackageFinalStat.isSymbolicLink() || !cliPackageFinalStat.isDirectory() ||
    cliPackageFinalStat.dev !== cliPackageStat.dev || cliPackageFinalStat.ino !== cliPackageStat.ino ||
    manifestFinal.stat.dev !== manifestRead.stat.dev || manifestFinal.stat.ino !== manifestRead.stat.ino ||
    lockFinal.stat.dev !== lockRead.stat.dev || lockFinal.stat.ino !== lockRead.stat.ino ||
    pcbooLockFinal.stat.dev !== pcbooLockRead.stat.dev || pcbooLockFinal.stat.ino !== pcbooLockRead.stat.ino ||
    pcbooTarballFinal.stat.dev !== pcbooTarballRead.stat.dev || pcbooTarballFinal.stat.ino !== pcbooTarballRead.stat.ino ||
    sha256(manifestFinal.bytes) !== sha256(manifestRead.bytes) ||
    sha256(lockFinal.bytes) !== sha256(lockRead.bytes) ||
    sha256(pcbooLockFinal.bytes) !== sha256(pcbooLockRead.bytes) ||
    sha256(pcbooTarballFinal.bytes) !== sha256(pcbooTarballRead.bytes) ||
    await realpath(pcbooSlot) !== pcbooPackageRoot ||
    await realpath(join(nodeModulesPath, "tscircuit")) !== tscircuitPackageRoot ||
    await realpath(cliPackageSlot) !== cliPackageRoot ||
    await resolveTscircuitEntryFresh(root) !== entryPath ||
    await resolveTscircuitEntryFresh(pcbooAuthoringOrigin) !== entryPath ||
    await resolvePackageEntryFresh("pcboo", root) !== pcbooEntryPath ||
    await fingerprintEnginePackage(pcbooPackageRoot) !== packedPcbooContentSha256 ||
    await fingerprintInstalledPackageClosure(tscircuitPackageRoot, { entryPath, resolutionOrigin: root }) !== runtimeClosureSha256
  ) throw new Error("Packed consumer authority changed during inspection");

  return Object.freeze({
    root,
    nodeModulesRoot,
    tscircuitPackageRoot,
    pcbooPackageRoot,
    entryPath,
    runtimeClosureSha256,
    lockSha256: sha256(lockRead.bytes),
    manifestSha256: sha256(manifestRead.bytes),
    packedPcbooContentSha256,
    projectPcbooLockSha256: sha256(pcbooLockRead.bytes),
    pcbooTarballSha256: sha256(pcbooTarballRead.bytes),
    pcbooTarballIntegrity: sha512Sri(pcbooTarballRead.bytes),
    singleEngineResolutionSha256,
  });
}
