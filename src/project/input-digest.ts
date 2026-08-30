// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { discoverSimulationNames, loadSimulationDefinition } from "../simulation";
import { discoverProjectSourceGraph } from "./source-graph";
import {
  assertProjectInputFileSize,
  assertProjectInputTotalSize,
  PROJECT_INPUT_DEPTH_LIMIT,
  PROJECT_INPUT_ENTRY_LIMIT,
  PROJECT_INPUT_FILE_LIMIT,
  PROJECT_SIMULATION_EVALUATION_TIMEOUT_MS,
} from "./input-limits";
import { requireSupportedBunRuntime } from "../runtime";

export interface ProjectInputDigest {
  readonly projectDigest: string;
  readonly sourceDigest: string;
  readonly configDigest: string;
  readonly lockDigest: string;
  readonly simulationDigest: string;
  readonly inputPaths: readonly string[];
  readonly simulationNames: readonly string[];
}

async function digestFiles(projectRoot: string, paths: readonly string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  let totalBytes = 0;
  for (const path of [...new Set(paths)].sort()) {
    hasher.update(path + "\0");
    const target = join(projectRoot, ...path.split("/"));
    try {
      const entry = await lstat(target);
      if (entry.isSymbolicLink()) hasher.update("SYMLINK");
      else if (entry.isFile()) {
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          if (!before.isFile()) throw new Error(`${path} project input is not a regular file`);
          assertProjectInputFileSize(path, before.size);
          totalBytes += before.size;
          assertProjectInputTotalSize(totalBytes);
          const bytes = await handle.readFile();
          const after = await handle.stat();
          const current = await lstat(target);
          if (
            before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
            bytes.byteLength !== before.size || current.isSymbolicLink() || !current.isFile() ||
            current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
            current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs
          ) throw new Error(`${path} project input changed while its authority was captured`);
          hasher.update(bytes);
        } finally {
          await handle.close();
        }
      }
      else hasher.update("NON_REGULAR");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hasher.update("MISSING");
    }
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

async function collectDirectoryFiles(projectRoot: string, directory: string): Promise<string[]> {
  const project = await realpath(projectRoot);
  const root = join(project, ...directory.split("/"));
  let rootEntry;
  try { rootEntry = await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`${directory} input directory must be a regular non-symlinked project directory`);
  }
  const actual = await realpath(root);
  const within = relative(project, actual);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    throw new Error(`${directory} input directory escapes the project`);
  }
  const paths: string[] = [];
  let entryCount = 0;
  const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
    if (depth > PROJECT_INPUT_DEPTH_LIMIT) {
      throw new Error(
        `${prefix} input traversal exceeds the ${PROJECT_INPUT_DEPTH_LIMIT}-directory depth limit`,
      );
    }
    for await (const entry of await opendir(current)) {
      const path = `${prefix}/${entry.name}`;
      entryCount += 1;
      if (entryCount > PROJECT_INPUT_ENTRY_LIMIT) {
        throw new Error(`Project input traversal exceeds ${PROJECT_INPUT_ENTRY_LIMIT} entries`);
      }
      if (entry.isSymbolicLink()) throw new Error(`${path} input entry must not be a symlink`);
      if (entry.isDirectory()) await walk(join(current, entry.name), path, depth + 1);
      else if (entry.isFile()) {
        paths.push(path);
        if (paths.length > PROJECT_INPUT_FILE_LIMIT) {
          throw new Error(`Project contains more than ${PROJECT_INPUT_FILE_LIMIT} input files`);
        }
      } else throw new Error(`${path} input entry must be a regular file or directory`);
    }
  };
  await walk(actual, directory, 1);
  return paths;
}

async function collectAuthoritativeProjectFiles(
  projectRoot: string,
  outputDirectory: string,
): Promise<string[]> {
  const root = await realpath(projectRoot);
  const excludedTopLevel = new Set([".git", "node_modules"]);
  const outputPrefix = outputDirectory
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
  let fileCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  const walk = async (
    directory: string,
    relativeDirectory = "",
    depth = 0,
  ): Promise<string[]> => {
    if (depth > PROJECT_INPUT_DEPTH_LIMIT) {
      throw new Error(
        `${relativeDirectory} project input traversal exceeds the ${PROJECT_INPUT_DEPTH_LIMIT}-directory depth limit`,
      );
    }
    const files: string[] = [];
    for await (const entry of await opendir(directory)) {
      const relativePath = relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      if (relativeDirectory === "" && excludedTopLevel.has(entry.name)) continue;
      if (relativePath === outputPrefix || relativePath.startsWith(`${outputPrefix}/`)) continue;
      entryCount += 1;
      if (entryCount > PROJECT_INPUT_ENTRY_LIMIT) {
        throw new Error(`Project input traversal exceeds ${PROJECT_INPUT_ENTRY_LIMIT} entries`);
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (relativePath === "models" || relativePath === "simulations") {
          throw new Error(
            `${relativePath} input directory must be a regular non-symlinked project directory`,
          );
        }
        if (relativePath.startsWith("models/") || relativePath.startsWith("simulations/")) {
          throw new Error(`${relativePath} input entry must not be a symlink`);
        }
        throw new Error(`${relativePath} project input must not be a symlink`);
      }
      if (entry.isDirectory()) files.push(...await walk(path, relativePath, depth + 1));
      else if (entry.isFile()) {
        const stat = await lstat(path);
        if (!stat.isFile()) throw new Error(`${relativePath} project input must be a regular file`);
        fileCount += 1;
        if (fileCount > PROJECT_INPUT_FILE_LIMIT) {
          throw new Error(`Project contains more than ${PROJECT_INPUT_FILE_LIMIT} input files`);
        }
        assertProjectInputFileSize(relativePath, stat.size);
        totalBytes += stat.size;
        assertProjectInputTotalSize(totalBytes);
        files.push(relativePath);
      }
      else throw new Error(`${relativePath} project input must be a regular file or directory`);
    }
    return files;
  };
  return (await walk(root)).sort();
}

/**
 * Captures every input that can affect circuit or named-simulation evidence.
 * Testbench modules are evaluated by the same deterministic loader used by the
 * CLI; their imported source graph and every digest-bound model are included.
 */
export async function digestProjectInputs(options: {
  readonly projectRoot: string;
  readonly entry: string;
  readonly outputDirectory?: string;
  /** Canonical active profile names from the resolved fulmetry.config.ts. */
  readonly profiles: readonly string[];
  /** Canonical source-controlled board revision from the resolved config, when present. */
  readonly boardRevision?: string;
  readonly signal?: AbortSignal;
  readonly simulationEvaluationTimeoutMs?: number;
  /** False binds raw simulation/model bytes without executing trusted testbench modules. */
  readonly evaluateSimulationDefinitions?: boolean;
}): Promise<Readonly<ProjectInputDigest>> {
  requireSupportedBunRuntime();
  const simulationEvaluationTimeoutMs = options.simulationEvaluationTimeoutMs ??
    PROJECT_SIMULATION_EVALUATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(simulationEvaluationTimeoutMs) || simulationEvaluationTimeoutMs < 10 ||
    simulationEvaluationTimeoutMs > PROJECT_SIMULATION_EVALUATION_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Simulation input evaluation timeout must be an integer from 10 through ${PROJECT_SIMULATION_EVALUATION_TIMEOUT_MS} ms`,
    );
  }
  const [sourcePaths, configPaths, simulationNames, authoritativeProjectPaths] = await Promise.all([
    discoverProjectSourceGraph(options.projectRoot, options.entry),
    discoverProjectSourceGraph(options.projectRoot, "fulmetry.config.ts"),
    discoverSimulationNames(options.projectRoot),
    collectAuthoritativeProjectFiles(
      options.projectRoot,
      options.outputDirectory ?? ".fulmetry",
    ),
  ]);
  const simulationPaths = new Set<string>([
    ...await collectDirectoryFiles(options.projectRoot, "simulations"),
    ...await collectDirectoryFiles(options.projectRoot, "models"),
  ]);
  if (options.evaluateSimulationDefinitions !== false) {
    const simulationController = new AbortController();
    let simulationTimedOut = false;
    const onAbort = () => simulationController.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) simulationController.abort();
    const simulationTimer = setTimeout(() => {
      simulationTimedOut = true;
      simulationController.abort();
    }, simulationEvaluationTimeoutMs);
    try {
      for (const name of simulationNames) {
        try {
          const loaded = await loadSimulationDefinition({
            projectRoot: options.projectRoot,
            name,
            signal: simulationController.signal,
          });
          for (const path of await discoverProjectSourceGraph(options.projectRoot, loaded.path)) simulationPaths.add(path);
          for (const model of loaded.definition.models) simulationPaths.add(model.path);
        } catch {
          if (simulationController.signal.aborted) {
            throw new Error(simulationTimedOut
              ? `Simulation input evaluation exceeded the ${simulationEvaluationTimeoutMs} ms aggregate limit`
              : "Project input capture was cancelled");
          }
          // Simulation semantics are a separately composable authority. The raw
          // simulations/models trees are still digest-bound so unrelated build,
          // check, and manufacturing commands remain runnable and any repair
          // invalidates prior simulation evidence.
        }
      }
    } finally {
      clearTimeout(simulationTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  const orderedSimulationPaths = [...simulationPaths].sort();
  const [sourceDigest, configSourceDigest, lockDigest, simulationDigest] = await Promise.all([
    digestFiles(options.projectRoot, authoritativeProjectPaths),
    digestFiles(options.projectRoot, configPaths),
    digestFiles(options.projectRoot, ["fulmetry.lock"]),
    digestFiles(options.projectRoot, orderedSimulationPaths),
  ]);
  const finalAuthoritativeProjectPaths = await collectAuthoritativeProjectFiles(
    options.projectRoot,
    options.outputDirectory ?? ".fulmetry",
  );
  if (
    finalAuthoritativeProjectPaths.length !== authoritativeProjectPaths.length ||
    finalAuthoritativeProjectPaths.some((path, index) => path !== authoritativeProjectPaths[index])
  ) {
    throw new Error("Project input inventory changed while its authority was captured");
  }
  const profiles = [...options.profiles].sort();
  if (
    profiles.some((profile) => typeof profile !== "string" || profile.trim() === "") ||
    new Set(profiles).size !== profiles.length
  ) throw new TypeError("Resolved project profiles must be unique non-empty strings");
  const resolvedConfig = JSON.stringify({
    schemaVersion: 1,
    entry: options.entry,
    outputDirectory: options.outputDirectory ?? ".fulmetry",
    profiles,
    ...(options.boardRevision === undefined
      ? {}
      : { boardRevision: options.boardRevision }),
  });
  const configDigest = new Bun.CryptoHasher("sha256")
    .update(`source\0${configSourceDigest}\0resolved\0${resolvedConfig}`)
    .digest("hex");
  const projectDigest = new Bun.CryptoHasher("sha256")
    .update(`${options.entry}\0${sourceDigest}\0${configDigest}\0${lockDigest}\0${simulationDigest}`)
    .digest("hex");
  return Object.freeze({
    projectDigest, sourceDigest, configDigest, lockDigest, simulationDigest,
    inputPaths: Object.freeze([...new Set([
      ...authoritativeProjectPaths,
      ...sourcePaths,
      ...configPaths,
      "fulmetry.lock",
      ...orderedSimulationPaths,
    ])].sort()),
    simulationNames,
  });
}
