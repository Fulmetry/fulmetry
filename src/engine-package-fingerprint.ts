// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { resolveTscircuitEntryFresh } from "./internal/fresh-package-entry";

// The pinned clean-install runtime closure contains lucide-react with 4,097
// owned entries (4,090 files, seven child directories). Keep bounded headroom
// above that observed distribution without permitting an unbounded walk.
export const ENGINE_PACKAGE_ENTRY_LIMIT = 8_192;
export const ENGINE_PACKAGE_DEPTH_LIMIT = 32;
export const ENGINE_PACKAGE_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
export const ENGINE_PACKAGE_TOTAL_BYTES_LIMIT = 128 * 1024 * 1024;
export const ENGINE_PACKAGE_METADATA_BYTES_LIMIT = 1024 * 1024;
export const ENGINE_PACKAGE_CLOSURE_LIMIT = 1_024;
export const ENGINE_PACKAGE_CLOSURE_DEPTH_LIMIT = 64;
export const ENGINE_CLOSURE_FILE_LIMIT = 65_536;
export const ENGINE_CLOSURE_DIRECTORY_LIMIT = 8_192;
export const ENGINE_CLOSURE_LINK_LIMIT = 4_096;
export const ENGINE_CLOSURE_TOTAL_BYTES_LIMIT = 2 * 1024 * 1024 * 1024;
const ENGINE_PACKAGE_CLOSURE_NODE_CONCURRENCY = 8;
const ENGINE_PACKAGE_DEPENDENCY_CONCURRENCY = 4;
const ENGINE_PACKAGE_METADATA_IO_CONCURRENCY = 16;
const ENGINE_PACKAGE_CONTENT_IO_CONCURRENCY = 16;
const ENGINE_PACKAGE_CONTENT_BATCH_BYTES = 8 * 1024 * 1024;

interface FileIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface Inventory {
  readonly root: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly files: readonly Readonly<FileIdentity>[];
  readonly directories: readonly Readonly<DirectoryIdentity>[];
}

interface CachedPackageFingerprint {
  readonly inventory: Readonly<Inventory>;
  readonly digest: string;
}

const packageFingerprintCache = new Map<string, CachedPackageFingerprint>();

/**
 * An installed package's top-level node_modules directory belongs to the
 * package manager's dependency layout, not to the package's published content
 * identity. Its presence and hoisting shape legitimately vary between clean
 * installs even when the package tarball is byte-identical.
 */
const INSTALL_LAYOUT_DIRECTORY = "node_modules";

export interface FingerprintEnginePackageOptions {
  /** Test seam for proving the final inventory rejects post-read mutation. */
  readonly beforeFinalInventory?: (canonicalPackageRoot: string) => void | Promise<void>;
  /** Test seam for proving cross-file mutation cannot hide in the final sweep. */
  readonly beforeFinalIdentityCheck?: (
    canonicalPackageRoot: string,
    relativePath: string,
    index: number,
  ) => void | Promise<void>;
}

export interface FingerprintInstalledPackageClosureOptions {
  /** Exact public entrypoint already resolved by the consuming project. */
  readonly entryPath?: string;
  /** Directory from which the consumer resolves the bare `tscircuit` import. */
  readonly resolutionOrigin?: string;
  /** Test seam proving installed package bytes/topology cannot change after capture. */
  readonly beforeFinalInventory?: (canonicalModulePaths: readonly string[]) => void | Promise<void>;
}

const PRISTINE_ARRAY_SORT = Function.prototype.call.bind(Array.prototype.sort) as <T>(array: T[], compare: (left: T, right: T) => number) => T[];

async function runBoundedIndexes(
  length: number,
  concurrency: number,
  operation: (index: number) => void | Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= length) return;
      await operation(index);
    }
  }));
}

async function stableDirectory(root: string, path: string, relativePath: string) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`tscircuit package contains a symlink or non-directory: ${relativePath || "."}`);
  }
  const expectedRealpath = relativePath === "" ? root : join(root, relativePath);
  if (await realpath(path) !== expectedRealpath) {
    throw new Error(`tscircuit package directory escaped its canonical root: ${relativePath || "."}`);
  }
  return Object.freeze({
    path: relativePath,
    dev: entry.dev,
    ino: entry.ino,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  });
}

async function inventoryPackage(root: string): Promise<Readonly<Inventory>> {
  const rootBefore = await stableDirectory(root, root, "");
  const files: Readonly<FileIdentity>[] = [];
  const directories: Readonly<DirectoryIdentity>[] = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > ENGINE_PACKAGE_DEPTH_LIMIT) {
      throw new Error(`tscircuit package exceeds directory depth ${ENGINE_PACKAGE_DEPTH_LIMIT}`);
    }
    const before = await stableDirectory(root, directory, prefix);
    const handle = await opendir(directory);
    const directoryEntries: Array<Readonly<{ name: string; relativePath: string; path: string }>> = [];
    try {
      for await (const entry of handle) {
        entries += 1;
        if (entries > ENGINE_PACKAGE_ENTRY_LIMIT) {
          throw new Error(`tscircuit package exceeds ${ENGINE_PACKAGE_ENTRY_LIMIT} entries`);
        }
        if (
          !entry.name ||
          entry.name.includes("/") ||
          entry.name.includes("\\") ||
          /[\u0000-\u001f\u007f]/.test(entry.name)
        ) {
          throw new Error(`tscircuit package contains an unsafe entry name`);
        }
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(directory, entry.name);
        if (prefix === "" && entry.name === INSTALL_LAYOUT_DIRECTORY) {
          // The complete install-layout entry is outside this digest domain,
          // including symlink/junction representations used by other package
          // managers and operating systems.
          continue;
        }
        directoryEntries.push(Object.freeze({ name: entry.name, relativePath, path }));
      }
    } finally {
      try { await handle.close(); } catch { /* for-await closes on completion */ }
    }
    const stats = new Array<Stats>(directoryEntries.length);
    await runBoundedIndexes(
      directoryEntries.length,
      ENGINE_PACKAGE_METADATA_IO_CONCURRENCY,
      async (index) => { stats[index] = await lstat(directoryEntries[index]!.path); },
    );
    for (let index = 0; index < directoryEntries.length; index += 1) {
        const { relativePath, path } = directoryEntries[index]!;
        const stat = stats[index]!;
        if (stat.isSymbolicLink()) throw new Error(`tscircuit package contains a symlink: ${relativePath}`);
        if (stat.isDirectory()) {
          await visit(path, relativePath, depth + 1);
        } else if (stat.isFile()) {
          if (stat.size > ENGINE_PACKAGE_FILE_BYTES_LIMIT) {
            throw new Error(`tscircuit package file ${relativePath} exceeds ${ENGINE_PACKAGE_FILE_BYTES_LIMIT} bytes`);
          }
          totalBytes += stat.size;
          if (totalBytes > ENGINE_PACKAGE_TOTAL_BYTES_LIMIT) {
            throw new Error(`tscircuit package exceeds ${ENGINE_PACKAGE_TOTAL_BYTES_LIMIT} aggregate bytes`);
          }
          files[files.length] = Object.freeze({
            path: relativePath,
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          });
        } else {
          throw new Error(`tscircuit package contains a special filesystem entry: ${relativePath}`);
        }
    }
    const after = await stableDirectory(root, directory, prefix);
    if (!isDeepStrictEqual(before, after)) {
      throw new Error(`tscircuit package directory changed while being inventoried: ${prefix || "."}`);
    }
    directories[directories.length] = after;
  };
  await visit(root, "", 0);
  PRISTINE_ARRAY_SORT(files, (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  PRISTINE_ARRAY_SORT(directories, (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze({
    root,
    rootDev: rootBefore.dev,
    rootIno: rootBefore.ino,
    files: Object.freeze(files),
    directories: Object.freeze(directories),
  });
}

async function assertFileIdentity(root: string, expected: Readonly<FileIdentity>): Promise<void> {
  const path = join(root, expected.path);
  const current = await lstat(path);
  if (
    current.isSymbolicLink() || !current.isFile() || current.dev !== expected.dev ||
    current.ino !== expected.ino || current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs ||
    await realpath(path) !== path
  ) throw new Error(`tscircuit package file changed during fingerprinting: ${expected.path}`);
}

async function readFingerprintFile(
  root: string,
  expected: Readonly<FileIdentity>,
): Promise<Uint8Array> {
  const path = join(root, expected.path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino ||
      before.size !== expected.size || before.mtimeMs !== expected.mtimeMs ||
      before.ctimeMs !== expected.ctimeMs
    ) throw new Error(`tscircuit package file changed before fingerprinting: ${expected.path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size
    ) throw new Error(`tscircuit package file changed while being fingerprinted: ${expected.path}`);
    await assertFileIdentity(root, expected);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Reads small package metadata through one stable, non-following descriptor. */
export async function readStableEnginePackageFile(
  path: string,
  byteLimit = ENGINE_PACKAGE_METADATA_BYTES_LIMIT,
): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > byteLimit) {
      throw new Error(`Engine package metadata exceeds ${byteLimit} bytes or is not a regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      current.isSymbolicLink() || !current.isFile() ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size || await realpath(path) !== path
    ) throw new Error("Engine package metadata changed while being read");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Stable, bounded content fingerprint shared by accepted and candidate tscircuit inspection. */
export async function fingerprintEnginePackage(
  packageRoot: string,
  options: FingerprintEnginePackageOptions = {},
): Promise<string> {
  const root = await realpath(packageRoot);
  const initial = await inventoryPackage(root);
  if (
    options.beforeFinalInventory === undefined &&
    options.beforeFinalIdentityCheck === undefined
  ) {
    const cached = packageFingerprintCache.get(root);
    if (cached !== undefined && isDeepStrictEqual(cached.inventory, initial)) {
      const confirmation = await inventoryPackage(root);
      if (isDeepStrictEqual(initial, confirmation)) return cached.digest;
      throw new Error("tscircuit package changed during cached fingerprint verification");
    }
  }
  const hasher = new Bun.CryptoHasher("sha256");
  let batchStart = 0;
  while (batchStart < initial.files.length) {
    let batchEnd = batchStart;
    let batchBytes = 0;
    while (
      batchEnd < initial.files.length &&
      batchEnd - batchStart < ENGINE_PACKAGE_CONTENT_IO_CONCURRENCY
    ) {
      const nextSize = initial.files[batchEnd]!.size;
      if (batchEnd > batchStart && batchBytes + nextSize > ENGINE_PACKAGE_CONTENT_BATCH_BYTES) break;
      batchBytes += nextSize;
      batchEnd += 1;
    }
    const contents = await Promise.all(
      initial.files.slice(batchStart, batchEnd).map((expected) =>
        readFingerprintFile(root, expected)
      ),
    );
    for (let offset = 0; offset < contents.length; offset += 1) {
      const expected = initial.files[batchStart + offset]!;
      hasher.update(expected.path);
      hasher.update("\0");
      hasher.update(contents[offset]!);
      hasher.update("\0");
    }
    batchStart = batchEnd;
  }
  await options.beforeFinalInventory?.(root);
  const final = await inventoryPackage(root);
  if (!isDeepStrictEqual(initial, final)) throw new Error("tscircuit package changed during fingerprinting");
  const assertFinalFile = async (index: number) => {
    const expected = final.files[index]!;
    await options.beforeFinalIdentityCheck?.(root, expected.path, index);
    await assertFileIdentity(root, expected);
  };
  if (options.beforeFinalIdentityCheck === undefined) {
    await runBoundedIndexes(
      final.files.length,
      ENGINE_PACKAGE_METADATA_IO_CONCURRENCY,
      assertFinalFile,
    );
  } else {
    // The injected mutation seam is intentionally ordered so tests can prove
    // the final inventory rejects a file changed after its individual check.
    for (let index = 0; index < final.files.length; index += 1) await assertFinalFile(index);
  }
  await runBoundedIndexes(
    final.directories.length,
    ENGINE_PACKAGE_METADATA_IO_CONCURRENCY,
    async (index) => {
      const expected = final.directories[index]!;
      const current = await stableDirectory(
        root,
        expected.path === "" ? root : join(root, expected.path),
        expected.path,
      );
      if (!isDeepStrictEqual(current, expected)) throw new Error(`tscircuit package directory changed after fingerprinting: ${expected.path || "."}`);
    },
  );
  const afterSweep = await inventoryPackage(root);
  if (!isDeepStrictEqual(final, afterSweep)) {
    throw new Error("tscircuit package changed during final fingerprint verification");
  }
  const digest = hasher.digest("hex");
  if (
    options.beforeFinalInventory === undefined &&
    options.beforeFinalIdentityCheck === undefined
  ) packageFingerprintCache.set(root, Object.freeze({ inventory: afterSweep, digest }));
  return digest;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface ClosurePackage {
  readonly nodeId: string;
  readonly packageName: string;
  readonly realRoot: string;
  readonly contentSha256: string;
}

interface ClosureEdge {
  readonly from: string;
  readonly dependency: string;
  readonly resolutionDepth: number;
  readonly linked: boolean;
  readonly to: string;
}

interface ClosureCapture {
  readonly packageRoot: string;
  readonly entryPath?: string;
  readonly packages: readonly ClosurePackage[];
  readonly edges: readonly ClosureEdge[];
  readonly binEntries: readonly ClosureBinEntry[];
  readonly digest: string;
}

interface ClosureBinEntry {
  readonly scope: string;
  readonly name: string;
  readonly kind: "link" | "file";
  readonly target: string;
  readonly sha256: string | null;
}

function normalizedRelativePath(root: string, target: string, label: string): string {
  const candidate = relative(root, target).replaceAll("\\", "/");
  if (
    candidate === "" || candidate === ".." || candidate.startsWith("../") ||
    isAbsolute(candidate) || candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new Error(`${label} escaped the authenticated tscircuit installation`);
  return candidate;
}

async function resolveInstalledPackageRoot(
  packageName: string,
  ownerRoot: string,
): Promise<Readonly<{ root: string; resolutionDepth: number; linked: boolean; slotPath: string }>> {
  const segments = packageName.split("/");
  if (
    segments.length < 1 || segments.length > 2 ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\")) ||
    (segments.length === 2 && !segments[0]!.startsWith("@"))
  ) throw new Error(`Unsafe installed dependency name ${JSON.stringify(packageName)}`);
  let cursor = ownerRoot;
  let resolutionDepth = 0;
  while (true) {
    const candidate = join(cursor, "node_modules", ...segments);
    try {
      const stat = await lstat(candidate);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(`Installed dependency slot ${packageName} is not a directory or link`);
      }
      const root = await realpath(candidate);
      await readStableEnginePackageFile(join(root, "package.json"));
      return Object.freeze({ root, resolutionDepth, linked: stat.isSymbolicLink(), slotPath: candidate });
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      // Continue through the normal node_modules ancestor search only when
      // this slot is absent. A malformed nearest slot must never be bypassed.
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Installed dependency ${packageName} cannot be resolved from ${ownerRoot}`);
    cursor = parent;
    resolutionDepth += 1;
    if (resolutionDepth > ENGINE_PACKAGE_CLOSURE_DEPTH_LIMIT) {
      throw new Error(`Installed dependency resolution exceeds depth ${ENGINE_PACKAGE_CLOSURE_DEPTH_LIMIT}`);
    }
  }
}

async function listInstalledPackageLayout(owner: ClosurePackage, remainingSlotBudget: number): Promise<Readonly<{
  slots: readonly string[];
  binRoots: readonly string[];
}>> {
  const ownerRoot = owner.realRoot;
  const modulesRoot = join(ownerRoot, INSTALL_LAYOUT_DIRECTORY);
  try {
    const modulesStat = await lstat(modulesRoot);
    if (!modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
      throw new Error(`Installed package node_modules is not a directory`);
    }
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return Object.freeze({ slots: [], binRoots: [] });
    throw error;
  }
  const handle = await opendir(modulesRoot);
  const slots: string[] = [];
  const binRoots: string[] = [];
  try {
    for await (const entry of handle) {
      if (entry.name === ".bin") {
        const binRoot = join(modulesRoot, ".bin");
        const binRootStat = await lstat(binRoot);
        if (!binRootStat.isDirectory() || binRootStat.isSymbolicLink()) {
          throw new Error("Installed package .bin must be a physical directory");
        }
        binRoots.push(binRoot);
        continue;
      }
      if (entry.name.startsWith(".")) {
        throw new Error(`Installed package contains an unauthenticated package-manager slot ${entry.name}`);
      }
      const slotPath = join(modulesRoot, entry.name);
      const slotStat = await lstat(slotPath);
      if (entry.name.startsWith("@")) {
        if (!slotStat.isDirectory() || slotStat.isSymbolicLink()) {
          throw new Error(`Installed package scope ${entry.name} is not a directory`);
        }
        const scope = await opendir(slotPath);
        try {
          for await (const scopedEntry of scope) {
            if (scopedEntry.name.startsWith(".")) {
              throw new Error(`Installed package scope ${entry.name} contains an unsafe slot`);
            }
            const scopedPath = join(slotPath, scopedEntry.name);
            const scopedStat = await lstat(scopedPath);
            if (!scopedStat.isDirectory() && !scopedStat.isSymbolicLink()) {
              throw new Error(`Installed package slot ${entry.name}/${scopedEntry.name} is not a directory or link`);
            }
            if (slots.length >= remainingSlotBudget) {
              throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_PACKAGE_CLOSURE_LIMIT} dependency slots`);
            }
            slots.push(`${entry.name}/${scopedEntry.name}`);
          }
        } finally {
          try { await scope.close(); } catch { /* for-await closes on completion */ }
        }
        continue;
      }
      if (!slotStat.isDirectory() && !slotStat.isSymbolicLink()) {
        throw new Error(`Installed package slot ${entry.name} is not a directory or link`);
      }
      if (slots.length >= remainingSlotBudget) {
        throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_PACKAGE_CLOSURE_LIMIT} dependency slots`);
      }
      slots.push(entry.name);
    }
  } finally {
    try { await handle.close(); } catch { /* for-await closes on completion */ }
  }
  const ownerModulesRoot = dirname(ownerRoot);
  if (
    basename(ownerModulesRoot) === INSTALL_LAYOUT_DIRECTORY &&
    basename(dirname(dirname(ownerModulesRoot))) === ".bun"
  ) {
    const tupleBinRoot = join(ownerModulesRoot, ".bin");
    try {
      const stat = await lstat(tupleBinRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Installed tuple .bin must be a physical directory");
      }
      if (!binRoots.includes(tupleBinRoot)) binRoots.push(tupleBinRoot);
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return Object.freeze({
    slots: Object.freeze(slots.sort(compareStrings)),
    binRoots: Object.freeze(binRoots.sort(compareStrings)),
  });
}

function authenticatedBinTarget(target: string, packages: readonly ClosurePackage[]): string {
  for (const candidate of packages) {
    const path = relative(candidate.realRoot, target);
    if (
      path !== "" && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path)
    ) return `${candidate.nodeId}\0${path.replaceAll("\\", "/")}`;
  }
  throw new Error("Installed package bin target is outside the authenticated package closure");
}

async function captureBinRoot(
  path: string,
  scope: string,
  packages: readonly ClosurePackage[],
  remaining: { count: number },
): Promise<readonly ClosureBinEntry[]> {
  const entries: ClosureBinEntry[] = [];
  const handle = await opendir(path);
  try {
    for await (const item of handle) {
      if (
        !item.name || item.name.startsWith(".") || item.name.includes("/") || item.name.includes("\\") ||
        /[\u0000-\u001f\u007f]/u.test(item.name)
      ) throw new Error("Installed package .bin contains an unsafe name");
      remaining.count += 1;
      if (remaining.count > ENGINE_CLOSURE_LINK_LIMIT) {
        throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_CLOSURE_LINK_LIMIT} bin entries`);
      }
      const entryPath = join(path, item.name);
      const stat = await lstat(entryPath);
      if (stat.isSymbolicLink()) {
        const rawTarget = (await readlink(entryPath)).replaceAll("\\", "/");
        const target = await realpath(entryPath);
        const targetStat = await lstat(target);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
          throw new Error(`Installed package .bin target ${item.name} is not a regular package file`);
        }
        entries.push(Object.freeze({
          scope,
          name: item.name,
          kind: "link",
          target: `${rawTarget}\0${authenticatedBinTarget(target, packages)}`,
          sha256: null,
        }));
      } else if (stat.isFile()) {
        const bytes = await readStableEnginePackageFile(entryPath);
        entries.push(Object.freeze({
          scope,
          name: item.name,
          kind: "file",
          target: "",
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        }));
      } else throw new Error(`Installed package .bin entry ${item.name} is not a file or link`);
    }
  } finally {
    try { await handle.close(); } catch { /* for-await closes on completion */ }
  }
  return Object.freeze(entries);
}

function isExplicitNpmAlias(specifier: string, packageName: string): boolean {
  return specifier === `npm:${packageName}` || specifier.startsWith(`npm:${packageName}@`);
}

async function captureClosurePackages(
  packageRoot: string,
  expectedEntryPath?: string,
  resolutionOrigin?: string,
): Promise<Readonly<ClosureCapture>> {
  const packageRootCanonical = await realpath(packageRoot);
  const packages: ClosurePackage[] = [];
  const edges: ClosureEdge[] = [];
  const binEntries: ClosureBinEntry[] = [];
  const byRealRoot = new Map<string, ClosurePackage>();
  const pending: ClosurePackage[] = [];
  const installedSlots = new Set<string>();
  const resolvedSlots = new Set<string>();
  const binScopes = new Map<string, Set<string>>();
  let closureFiles = 0;
  let closureDirectories = 0;
  let closureLinks = 0;
  let closureBytes = 0;
  const addPackage = async (nodeId: string, path: string): Promise<ClosurePackage> => {
    const realRoot = await realpath(path);
    const existing = byRealRoot.get(realRoot);
    if (existing !== undefined) return existing;
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      await readStableEnginePackageFile(join(realRoot, "package.json")),
    )) as { name?: unknown };
    if (typeof metadata.name !== "string" || metadata.name.length === 0) {
      throw new Error(`Installed package ${nodeId} has no valid package name`);
    }
    const inventory = await inventoryPackage(realRoot);
    closureFiles += inventory.files.length;
    closureDirectories += inventory.directories.length;
    closureBytes += inventory.files.reduce((total, file) => total + file.size, 0);
    if (closureFiles > ENGINE_CLOSURE_FILE_LIMIT) {
      throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_CLOSURE_FILE_LIMIT} files`);
    }
    if (closureDirectories > ENGINE_CLOSURE_DIRECTORY_LIMIT) {
      throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_CLOSURE_DIRECTORY_LIMIT} directories`);
    }
    if (closureBytes > ENGINE_CLOSURE_TOTAL_BYTES_LIMIT) {
      throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_CLOSURE_TOTAL_BYTES_LIMIT} aggregate bytes`);
    }
    const captured = Object.freeze({
      nodeId,
      packageName: metadata.name,
      realRoot,
      contentSha256: await fingerprintEnginePackage(realRoot),
    });
    byRealRoot.set(realRoot, captured);
    packages.push(captured);
    pending.push(captured);
    if (packages.length > ENGINE_PACKAGE_CLOSURE_LIMIT) {
      throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_PACKAGE_CLOSURE_LIMIT} packages`);
    }
    return captured;
  };

  const rootNode = await addPackage("tscircuit", packageRootCanonical);
  if (rootNode.packageName !== "tscircuit") throw new Error("Closure root is not the tscircuit package");
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const owner = pending[cursor]!;
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      await readStableEnginePackageFile(join(owner.realRoot, "package.json")),
    )) as {
      dependencies?: unknown;
      optionalDependencies?: unknown;
      peerDependencies?: unknown;
      peerDependenciesMeta?: unknown;
    };
    const dependencyKinds = [metadata.dependencies, metadata.optionalDependencies, metadata.peerDependencies];
    const declarations = new Map<string, string>();
    for (const dependencies of dependencyKinds) {
      if (dependencies === undefined) continue;
      if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
        throw new Error(`Installed package ${owner.packageName} has invalid dependency metadata`);
      }
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== "string" || specifier.length === 0) {
          throw new Error(`Installed package ${owner.packageName} has invalid dependency declaration ${name}`);
        }
        declarations.set(name, specifier);
      }
    }
    const layout = await listInstalledPackageLayout(
      owner,
      ENGINE_PACKAGE_CLOSURE_LIMIT - installedSlots.size,
    );
    for (const binRoot of layout.binRoots) {
      const scopes = binScopes.get(binRoot) ?? new Set<string>();
      scopes.add(owner.nodeId);
      binScopes.set(binRoot, scopes);
    }
    const tupleModulesRoot = dirname(owner.realRoot);
    if (
      basename(tupleModulesRoot) === INSTALL_LAYOUT_DIRECTORY &&
      basename(dirname(dirname(tupleModulesRoot))) === ".bun"
    ) {
      const tupleBinRoot = join(tupleModulesRoot, ".bin");
      try {
        const stat = await lstat(tupleBinRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Installed tuple .bin must be a physical directory");
        }
        const scopes = binScopes.get(tupleBinRoot) ?? new Set<string>();
        scopes.add(owner.nodeId);
        binScopes.set(tupleBinRoot, scopes);
      } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    for (const slot of layout.slots) {
      if (installedSlots.size >= ENGINE_PACKAGE_CLOSURE_LIMIT) {
        throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_PACKAGE_CLOSURE_LIMIT} dependency slots`);
      }
      installedSlots.add(join(owner.realRoot, INSTALL_LAYOUT_DIRECTORY, ...slot.split("/")));
    }
    const optionalPeers = metadata.peerDependenciesMeta !== null && typeof metadata.peerDependenciesMeta === "object" &&
      !Array.isArray(metadata.peerDependenciesMeta)
      ? metadata.peerDependenciesMeta as Record<string, { optional?: unknown }>
      : {};
    const orderedNames = [...declarations.keys()].sort(compareStrings);
    for (const dependency of orderedNames) {
      let resolvedDependency: Awaited<ReturnType<typeof resolveInstalledPackageRoot>>;
      try {
        resolvedDependency = await resolveInstalledPackageRoot(dependency, owner.realRoot);
      } catch (error) {
        const optional = dependency in (metadata.optionalDependencies as Record<string, unknown> ?? {}) ||
          optionalPeers[dependency]?.optional === true;
        if (optional) continue;
        throw new Error(`Installed dependency ${dependency} of ${owner.packageName} cannot be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
      if (resolvedDependency.linked) {
        closureLinks += 1;
        if (closureLinks > ENGINE_CLOSURE_LINK_LIMIT) {
          throw new Error(`Tscircuit installed package closure exceeds ${ENGINE_CLOSURE_LINK_LIMIT} package links`);
        }
      }
      resolvedSlots.add(resolvedDependency.slotPath);
      const target = await addPackage(`${owner.nodeId}/node_modules/${dependency}`, resolvedDependency.root);
      if (
        target.packageName !== dependency &&
        !isExplicitNpmAlias(declarations.get(dependency)!, target.packageName)
      ) {
        throw new Error(
          `Installed dependency slot ${dependency} contains package ${target.packageName} without an explicit npm alias`,
        );
      }
      edges.push(Object.freeze({
        from: owner.nodeId,
        dependency,
        resolutionDepth: resolvedDependency.resolutionDepth,
        linked: resolvedDependency.linked,
        to: target.nodeId,
      }));
    }
  }
  for (const slotPath of installedSlots) {
    if (!resolvedSlots.has(slotPath)) {
      throw new Error(`Installed package closure contains undeclared installed package slot ${slotPath}`);
    }
  }
  const binBudget = { count: 0 };
  for (const [binRoot, owners] of [...binScopes.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    const scope = [...owners].sort(compareStrings).join("+");
    binEntries.push(...await captureBinRoot(binRoot, scope, packages, binBudget));
  }

  PRISTINE_ARRAY_SORT(packages, (left, right) => compareStrings(left.nodeId, right.nodeId));
  PRISTINE_ARRAY_SORT(edges, (left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  PRISTINE_ARRAY_SORT(binEntries, (left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  let entryPath: string | undefined;
  if (resolutionOrigin !== undefined) {
    const resolvedEntry = await resolveTscircuitEntryFresh(resolutionOrigin);
    if (expectedEntryPath !== undefined && resolvedEntry !== await realpath(expectedEntryPath)) {
      throw new Error("Resolved tscircuit runtime entrypoint differs from the executed entrypoint");
    }
    entryPath = resolvedEntry;
  } else if (expectedEntryPath !== undefined) {
    entryPath = await realpath(expectedEntryPath);
  }
  if (entryPath !== undefined) {
    const candidate = relative(packageRootCanonical, entryPath);
    if (candidate === ".." || candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(candidate)) {
      throw new Error("Resolved tscircuit entrypoint is outside the authenticated tscircuit package");
    }
  }
  const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify({
    schemaVersion: 3,
    bunVersion: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    entry: entryPath === undefined ? null : normalizedRelativePath(packageRootCanonical, entryPath, "Entrypoint"),
    packages: packages.map(({ nodeId, packageName, contentSha256 }) => ({ nodeId, packageName, contentSha256 })),
    edges,
    binEntries,
  })).digest("hex");
  return Object.freeze({
    packageRoot: packageRootCanonical,
    ...(entryPath === undefined ? {} : { entryPath }),
    packages: Object.freeze(packages),
    edges: Object.freeze(edges),
    binEntries: Object.freeze(binEntries),
    digest,
  });
}

/**
 * Authenticates the complete package-owned byte closure exposed by tscircuit's
 * installed dependency slots. It intentionally does not infer reachability
 * from JavaScript syntax: createRequire(), eval/import(), native loaders, and
 * package resources remain covered because every declared installed package
 * is byte-bound and undeclared nested slots fail closed. The logical slot map
 * distinguishes hoisted/aliased/duplicated and link-versus-directory layouts.
 */
export async function fingerprintInstalledPackageClosure(
  packageRoot: string,
  options: FingerprintInstalledPackageClosureOptions = {},
): Promise<string> {
  const initial = await captureClosurePackages(packageRoot, options.entryPath, options.resolutionOrigin);
  await options.beforeFinalInventory?.(Object.freeze(initial.packages.map(({ realRoot }) => realRoot)));
  const final = await captureClosurePackages(initial.packageRoot, initial.entryPath, options.resolutionOrigin);
  const rootsBefore = initial.packages.map(({ nodeId, realRoot }) => ({ nodeId, realRoot }));
  const rootsAfter = final.packages.map(({ nodeId, realRoot }) => ({ nodeId, realRoot }));
  if (initial.digest !== final.digest || !isDeepStrictEqual(rootsBefore, rootsAfter)) {
    throw new Error("Installed tscircuit package closure changed during fingerprinting");
  }
  return initial.digest;
}
