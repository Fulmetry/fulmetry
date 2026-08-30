// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";

export const KICAD_ARTIFACT_ENTRY_LIMIT = 16;
export const KICAD_ARTIFACT_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
export const KICAD_ARTIFACT_TOTAL_BYTES_LIMIT = 256 * 1024 * 1024;
const PRISTINE_MAP = Map;
const PRISTINE_SET = Set;
const PRISTINE_MAP_GET = Function.prototype.call.bind(Map.prototype.get) as <K, V>(map: Map<K, V>, key: K) => V | undefined;
const PRISTINE_MAP_HAS = Function.prototype.call.bind(Map.prototype.has) as <K, V>(map: Map<K, V>, key: K) => boolean;
const PRISTINE_MAP_SET = Function.prototype.call.bind(Map.prototype.set) as <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
const PRISTINE_SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
const PRISTINE_SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const PRISTINE_ARRAY_SORT = Function.prototype.call.bind(Array.prototype.sort) as <T>(array: T[], compare: (left: T, right: T) => number) => T[];

export interface ExactKicadFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ExactKicadDirectoryIdentity {
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function directoryIdentity(root: string, label: string) {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} root is not a real directory`);
  return Object.freeze({
    realpath: await realpath(root),
    dev: entry.dev,
    ino: entry.ino,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  });
}

function requireDirectoryIdentity(
  actual: Awaited<ReturnType<typeof directoryIdentity>>,
  expected: Readonly<ExactKicadDirectoryIdentity>,
  label: string,
): void {
  if (actual.realpath !== expected.realpath || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`${label} directory identity changed`);
  }
}

async function captureFile(
  root: string,
  rootRealpath: string,
  expected: Readonly<ExactKicadFile>,
  label: string,
): Promise<Readonly<ExactKicadFile>> {
  const path = join(root, expected.path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} ${expected.path} is not a regular file`);
    if (before.size > KICAD_ARTIFACT_FILE_BYTES_LIMIT) {
      throw new Error(`${label} ${expected.path} exceeds ${KICAD_ARTIFACT_FILE_BYTES_LIMIT} bytes`);
    }
    if (before.size !== expected.size) {
      throw new Error(`${label} bytes changed and no longer match authenticated evidence`);
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
      bytes.byteLength !== before.size || await realpath(path) !== join(rootRealpath, expected.path)
    ) throw new Error(`${label} ${expected.path} changed while being captured`);
    const captured = Object.freeze({ path: expected.path, size: bytes.byteLength, sha256: digest(bytes) });
    if (captured.sha256 !== expected.sha256) throw new Error(`${label} bytes changed and no longer match authenticated evidence`);
    return captured;
  } finally {
    await handle.close();
  }
}

/** Captures a small, exact, direct-file manifest without traversing untrusted subtrees. */
export async function captureExactFlatKicadFiles(options: {
  readonly root: string;
  readonly expected: readonly Readonly<ExactKicadFile>[];
  readonly rootIdentity: Readonly<ExactKicadDirectoryIdentity>;
  readonly label: string;
}): Promise<readonly Readonly<ExactKicadFile>[]> {
  // Copy every primitive before the first await so caller mutation cannot
  // rewrite the manifest while filesystem capture is in flight.
  const expected: Readonly<ExactKicadFile>[] = [];
  for (let index = 0; index < options.expected.length; index += 1) {
    const file = options.expected[index]!;
    expected[index] = Object.freeze({ path: String(file.path), size: Number(file.size), sha256: String(file.sha256) });
  }
  PRISTINE_ARRAY_SORT(expected, (left, right) => left.path.localeCompare(right.path));
  if (expected.length > KICAD_ARTIFACT_ENTRY_LIMIT) {
    throw new Error(`${options.label} exceeds ${KICAD_ARTIFACT_ENTRY_LIMIT} entries`);
  }
  const expectedByPath = new PRISTINE_MAP<string, Readonly<ExactKicadFile>>();
  let expectedBytes = 0;
  for (const file of expected) {
    if (!file.path || file.path.includes("/") || file.path.includes("\\") || file.path.includes("\0")) {
      throw new Error(`${options.label} expected path is not a direct safe filename`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > KICAD_ARTIFACT_FILE_BYTES_LIMIT) {
      throw new Error(`${options.label} ${file.path} exceeds ${KICAD_ARTIFACT_FILE_BYTES_LIMIT} bytes`);
    }
    if (!/^[a-f0-9]{64}$/u.test(file.sha256) || PRISTINE_MAP_HAS(expectedByPath, file.path)) {
      throw new Error(`${options.label} expected manifest is invalid`);
    }
    expectedBytes += file.size;
    if (expectedBytes > KICAD_ARTIFACT_TOTAL_BYTES_LIMIT) {
      throw new Error(`${options.label} exceeds ${KICAD_ARTIFACT_TOTAL_BYTES_LIMIT} aggregate bytes`);
    }
    PRISTINE_MAP_SET(expectedByPath, file.path, file);
  }

  const before = await directoryIdentity(options.root, options.label);
  requireDirectoryIdentity(before, options.rootIdentity, options.label);
  const seen = new PRISTINE_SET<string>();
  const captured: Readonly<ExactKicadFile>[] = [];
  const directory = await opendir(options.root);
  try {
    for await (const entry of directory) {
      if (seen.size >= KICAD_ARTIFACT_ENTRY_LIMIT) {
        throw new Error(`${options.label} exceeds ${KICAD_ARTIFACT_ENTRY_LIMIT} entries`);
      }
      const expectedFile = PRISTINE_MAP_GET(expectedByPath, entry.name);
      if (expectedFile === undefined) {
        throw new Error(`${options.label} artifact set mismatch (unexpected: ${entry.name})`);
      }
      if (PRISTINE_SET_HAS(seen, entry.name)) throw new Error(`${options.label} artifact set contains duplicate ${entry.name}`);
      PRISTINE_SET_ADD(seen, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${options.label} contains symlink ${entry.name}`);
      if (!entry.isFile()) throw new Error(`${options.label} contains non-regular entry ${entry.name}`);
      captured[captured.length] = await captureFile(options.root, before.realpath, expectedFile, options.label);
    }
  } finally {
    try { await directory.close(); } catch { /* for-await closes the directory on completion */ }
  }
  const missing: string[] = [];
  for (const file of expected) if (!PRISTINE_SET_HAS(seen, file.path)) missing[missing.length] = file.path;
  if (missing.length > 0) throw new Error(`${options.label} artifact set mismatch (missing: ${missing.join(", ")})`);
  const after = await directoryIdentity(options.root, options.label);
  requireDirectoryIdentity(after, options.rootIdentity, options.label);
  if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`${options.label} directory changed while being captured`);
  }
  PRISTINE_ARRAY_SORT(captured, (left, right) => left.path.localeCompare(right.path));
  return Object.freeze(captured);
}
