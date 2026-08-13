// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { requireSupportedBunRuntime } from "../runtime";

export const SIMULATION_ARTIFACT_ENTRY_LIMIT = 256;
export const SIMULATION_ARTIFACT_DEPTH_LIMIT = 2;
export const SIMULATION_ARTIFACT_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
export const SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT = 256 * 1024 * 1024;

export interface SimulationArtifactExpectation {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface SimulationDirectoryIdentity {
  readonly path: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

interface ExpectedDirectory {
  readonly files: Map<string, Readonly<SimulationArtifactExpectation>>;
  readonly directories: Map<string, ExpectedDirectory>;
}

interface CapturedSimulationFile {
  readonly expected: Readonly<SimulationArtifactExpectation>;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

const PRISTINE_MAP = Map;
const PRISTINE_SET = Set;
const PRISTINE_MAP_GET = Function.prototype.call.bind(Map.prototype.get) as <K, V>(map: Map<K, V>, key: K) => V | undefined;
const PRISTINE_MAP_HAS = Function.prototype.call.bind(Map.prototype.has) as <K, V>(map: Map<K, V>, key: K) => boolean;
const PRISTINE_MAP_SET = Function.prototype.call.bind(Map.prototype.set) as <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
const PRISTINE_MAP_FOR_EACH = Function.prototype.call.bind(Map.prototype.forEach) as <K, V>(map: Map<K, V>, callback: (value: V, key: K) => void) => void;
const PRISTINE_SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
const PRISTINE_SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function captureSimulationDirectoryIdentity(path: string): Promise<Readonly<SimulationDirectoryIdentity>> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Simulation artifact root is not a real directory");
  return Object.freeze({ path, realpath: await realpath(path), dev: entry.dev, ino: entry.ino });
}

export async function assertSimulationDirectoryIdentity(
  expected: Readonly<SimulationDirectoryIdentity>,
): Promise<void> {
  const current = await captureSimulationDirectoryIdentity(expected.path);
  if (current.realpath !== expected.realpath || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error("Simulation artifact directory identity changed");
  }
}

async function stableDirectory(path: string, label: string) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return Object.freeze({
    realpath: await realpath(path), dev: entry.dev, ino: entry.ino,
    mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
  });
}

async function captureFile(
  rootRealpath: string,
  directory: string,
  expected: Readonly<SimulationArtifactExpectation>,
): Promise<Readonly<CapturedSimulationFile>> {
  const path = join(directory, expected.path.split("/").at(-1)!);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Simulation artifact ${expected.path} is not a regular file`);
    if (before.size > SIMULATION_ARTIFACT_FILE_BYTES_LIMIT) {
      throw new Error(`Simulation artifact ${expected.path} exceeds ${SIMULATION_ARTIFACT_FILE_BYTES_LIMIT} bytes`);
    }
    if (before.size !== expected.size) throw new Error(`Simulation artifact ${expected.path} bytes changed`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      current.isSymbolicLink() || !current.isFile() ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size || await realpath(path) !== join(rootRealpath, ...expected.path.split("/"))
    ) throw new Error(`Simulation artifact ${expected.path} changed while being captured`);
    if (sha256(bytes) !== expected.sha256) throw new Error(`Simulation artifact ${expected.path} bytes changed`);
    return Object.freeze({
      expected,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    });
  } finally {
    await handle.close();
  }
}

function expectedTree(files: readonly Readonly<SimulationArtifactExpectation>[]): ExpectedDirectory {
  const root: ExpectedDirectory = { files: new PRISTINE_MAP(), directories: new PRISTINE_MAP() };
  let total = 0;
  for (let index = 0; index < files.length; index += 1) {
    const source = files[index]!;
    const file = Object.freeze({ path: String(source.path), size: Number(source.size), sha256: String(source.sha256) });
    if (!file.path || isAbsolute(file.path) || file.path.includes("\\") || file.path.includes("\0")) {
      throw new Error(`Simulation artifact path is unsafe: ${file.path}`);
    }
    const parts = file.path.split("/");
    let invalidPart = false;
    for (const part of parts) if (!part || part === "." || part === "..") invalidPart = true;
    if (invalidPart || parts.length > SIMULATION_ARTIFACT_DEPTH_LIMIT) {
      throw new Error(`Simulation artifact ${file.path} exceeds depth ${SIMULATION_ARTIFACT_DEPTH_LIMIT}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > SIMULATION_ARTIFACT_FILE_BYTES_LIMIT) {
      throw new Error(`Simulation artifact ${file.path} exceeds ${SIMULATION_ARTIFACT_FILE_BYTES_LIMIT} bytes`);
    }
    if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error(`Simulation artifact ${file.path} has invalid digest`);
    total += file.size;
    if (total > SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT) {
      throw new Error(`Simulation artifacts exceed ${SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT} aggregate bytes`);
    }
    let directory = root;
    for (let partIndex = 0; partIndex < parts.length - 1; partIndex += 1) {
      const segment = parts[partIndex]!;
      let child = PRISTINE_MAP_GET(directory.directories, segment);
      if (child === undefined) {
        child = { files: new PRISTINE_MAP(), directories: new PRISTINE_MAP() };
        PRISTINE_MAP_SET(directory.directories, segment, child);
      }
      directory = child;
    }
    const name = parts[parts.length - 1]!;
    if (PRISTINE_MAP_HAS(directory.files, name) || PRISTINE_MAP_HAS(directory.directories, name)) {
      throw new Error(`Simulation artifact manifest duplicates ${file.path}`);
    }
    PRISTINE_MAP_SET(directory.files, name, file);
  }
  return root;
}

/** Verifies the exact bounded root/models artifact tree without entering unexpected directories. */
export async function verifyExactSimulationArtifacts(options: {
  readonly rootIdentity: Readonly<SimulationDirectoryIdentity>;
  readonly expected: readonly Readonly<SimulationArtifactExpectation>[];
  /** @internal Deterministic cross-file mutation test hook. */
  readonly beforeFinalRevalidation?: () => void | Promise<void>;
  /** @internal Runs before each file capture in the initial and final tree scans. */
  readonly beforeFileCapture?: (phase: "initial" | "final", path: string) => void | Promise<void>;
}): Promise<void> {
  requireSupportedBunRuntime();
  if (options.expected.length > SIMULATION_ARTIFACT_ENTRY_LIMIT) {
    throw new Error(`Simulation artifact manifest exceeds ${SIMULATION_ARTIFACT_ENTRY_LIMIT} files`);
  }
  const tree = expectedTree(options.expected);
  const rootBefore = await stableDirectory(options.rootIdentity.path, "Simulation artifact root");
  if (
    rootBefore.realpath !== options.rootIdentity.realpath || rootBefore.dev !== options.rootIdentity.dev ||
    rootBefore.ino !== options.rootIdentity.ino
  ) throw new Error("Simulation artifact root identity changed");
  let entries = 0;
  let phase: "initial" | "final" = "initial";
  let activeFiles: Readonly<CapturedSimulationFile>[] = [];
  let activeDirectories: Array<Readonly<{
    path: string;
    snapshot: Awaited<ReturnType<typeof stableDirectory>>;
  }>> = [];
  const visit = async (directory: string, prefix: string, expected: ExpectedDirectory): Promise<void> => {
    const before = await stableDirectory(directory, `Simulation artifact directory ${prefix || "."}`);
    const seenFiles = new PRISTINE_SET<string>();
    const seenDirectories = new PRISTINE_SET<string>();
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        entries += 1;
        if (entries > SIMULATION_ARTIFACT_ENTRY_LIMIT) {
          throw new Error(`Simulation artifact tree exceeds ${SIMULATION_ARTIFACT_ENTRY_LIMIT} entries`);
        }
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const expectedFile = PRISTINE_MAP_GET(expected.files, entry.name);
        const expectedDirectory = PRISTINE_MAP_GET(expected.directories, entry.name);
        if (expectedFile === undefined && expectedDirectory === undefined) {
          throw new Error(`Simulation artifact set mismatch (unexpected: ${path})`);
        }
        if (entry.isSymbolicLink()) throw new Error(`Simulation artifact tree contains symlink ${path}`);
        if (expectedFile !== undefined) {
          if (!entry.isFile()) throw new Error(`Simulation artifact ${path} is not a regular file`);
          PRISTINE_SET_ADD(seenFiles, entry.name);
          await options.beforeFileCapture?.(phase, path);
          activeFiles[activeFiles.length] = await captureFile(rootBefore.realpath, directory, expectedFile);
        } else {
          if (!entry.isDirectory()) throw new Error(`Simulation artifact ${path} is not a real directory`);
          PRISTINE_SET_ADD(seenDirectories, entry.name);
          await visit(join(directory, entry.name), path, expectedDirectory!);
        }
      }
    } finally {
      try { await handle.close(); } catch { /* for-await closes on completion */ }
    }
    let missing: string | undefined;
    PRISTINE_MAP_FOR_EACH(expected.files, (_file, name) => {
      if (missing === undefined && !PRISTINE_SET_HAS(seenFiles, name)) missing = `${prefix ? `${prefix}/` : ""}${name}`;
    });
    PRISTINE_MAP_FOR_EACH(expected.directories, (_child, name) => {
      if (missing === undefined && !PRISTINE_SET_HAS(seenDirectories, name)) missing = `${prefix ? `${prefix}/` : ""}${name}`;
    });
    if (missing !== undefined) throw new Error(`Simulation artifact set mismatch (missing: ${missing})`);
    const after = await stableDirectory(directory, `Simulation artifact directory ${prefix || "."}`);
    if (
      before.realpath !== after.realpath || before.dev !== after.dev || before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) throw new Error(`Simulation artifact directory ${prefix || "."} changed while being captured`);
    activeDirectories[activeDirectories.length] = Object.freeze({ path: directory, snapshot: after });
  };
  await visit(options.rootIdentity.path, "", tree);
  const capturedFiles = activeFiles;
  await options.beforeFinalRevalidation?.();
  entries = 0;
  phase = "final";
  activeFiles = [];
  activeDirectories = [];
  await visit(options.rootIdentity.path, "", tree);
  const revalidatedFiles = activeFiles;
  const revalidatedByPath = new PRISTINE_MAP<string, Readonly<CapturedSimulationFile>>();
  for (const current of revalidatedFiles) PRISTINE_MAP_SET(revalidatedByPath, current.expected.path, current);
  for (const captured of capturedFiles) {
    const current = PRISTINE_MAP_GET(revalidatedByPath, captured.expected.path);
    if (current === undefined) throw new Error(`Simulation artifact ${captured.expected.path} disappeared during final capture`);
    if (
      current.dev !== captured.dev || current.ino !== captured.ino || current.size !== captured.size ||
      current.mtimeMs !== captured.mtimeMs || current.ctimeMs !== captured.ctimeMs
    ) throw new Error(`Simulation artifact ${captured.expected.path} changed after initial capture`);
  }
  for (const captured of revalidatedFiles) {
    const path = join(options.rootIdentity.path, ...captured.expected.path.split("/"));
    const current = await lstat(path);
    if (
      current.isSymbolicLink() || !current.isFile() || current.dev !== captured.dev ||
      current.ino !== captured.ino || current.size !== captured.size ||
      current.mtimeMs !== captured.mtimeMs || current.ctimeMs !== captured.ctimeMs ||
      await realpath(path) !== join(rootBefore.realpath, ...captured.expected.path.split("/"))
    ) throw new Error(`Simulation artifact ${captured.expected.path} changed after final capture`);
  }
  for (const captured of activeDirectories) {
    const current = await stableDirectory(captured.path, "Simulation artifact directory final check");
    if (
      current.realpath !== captured.snapshot.realpath || current.dev !== captured.snapshot.dev ||
      current.ino !== captured.snapshot.ino || current.mtimeMs !== captured.snapshot.mtimeMs ||
      current.ctimeMs !== captured.snapshot.ctimeMs
    ) throw new Error("Simulation artifact directory changed after final capture");
  }
  const rootAfter = await stableDirectory(options.rootIdentity.path, "Simulation artifact root");
  if (
    rootAfter.realpath !== options.rootIdentity.realpath || rootAfter.dev !== options.rootIdentity.dev ||
    rootAfter.ino !== options.rootIdentity.ino
  ) throw new Error("Simulation artifact root identity changed");
}
