// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactReference } from "../result";

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

export interface EvidenceFileIdentity {
  readonly path: string;
  readonly projectPath: string;
  readonly size: number;
  readonly sha256: string;
  readonly dev: number;
  readonly ino: number;
}

export interface RunEvidenceAuthority {
  readonly mode: "exact-tree" | "selected-files";
  readonly runDirectory: string;
  readonly runRealpath: string;
  readonly reportPath: string;
  readonly directories: readonly DirectoryIdentity[];
  readonly files: readonly EvidenceFileIdentity[];
}

export const RUN_EVIDENCE_ENTRY_LIMIT = 512;
export const RUN_EVIDENCE_DEPTH_LIMIT = 16;
export const RUN_EVIDENCE_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
export const RUN_EVIDENCE_TOTAL_BYTES_LIMIT = 256 * 1024 * 1024;

interface EvidenceCaptureBudget {
  entries: number;
  bytes: number;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function normalizedRelative(root: string, target: string): string {
  const path = relative(root, target).replaceAll("\\", "/");
  if (path === "" || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error("Evidence artifact must be a strict descendant of its run directory");
  }
  return path;
}

async function requireCanonicalRunRoot(
  projectRoot: string,
  runDirectory: string,
): Promise<string> {
  const lexicalProjectRoot = resolve(projectRoot);
  const lexicalRunDirectory = resolve(runDirectory);
  const runPath = relative(lexicalProjectRoot, lexicalRunDirectory).replaceAll("\\", "/");
  if (
    runPath === "" || runPath === ".." || runPath.startsWith("../") ||
    isAbsolute(runPath)
  ) throw new Error("Run evidence root must be a strict project descendant");
  const canonicalProjectRoot = await realpath(lexicalProjectRoot);
  const expectedRunRealpath = join(canonicalProjectRoot, ...runPath.split("/"));
  const actualRunRealpath = await realpath(lexicalRunDirectory);
  if (actualRunRealpath !== expectedRunRealpath) {
    throw new Error("Run evidence root must not traverse a symlink below the project root");
  }
  return actualRunRealpath;
}

async function captureFile(
  absolutePath: string,
  relativePath: string,
  projectPath: string,
  budget: EvidenceCaptureBudget,
  expectedRealPath?: string,
): Promise<Readonly<EvidenceFileIdentity>> {
  const requested = resolve(absolutePath);
  const actual = await realpath(requested);
  if (expectedRealPath !== undefined && actual !== resolve(expectedRealPath)) {
    throw new Error(`Evidence artifact ${relativePath} must not traverse a symlink`);
  }
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Evidence artifact ${relativePath} is not a regular file`);
    if (
      !Number.isSafeInteger(before.size) || before.size < 0 ||
      before.size > RUN_EVIDENCE_FILE_BYTES_LIMIT
    ) {
      throw new Error(
        `Evidence artifact ${relativePath} exceeds the ${RUN_EVIDENCE_FILE_BYTES_LIMIT}-byte per-file limit`,
      );
    }
    if (budget.entries + 1 > RUN_EVIDENCE_ENTRY_LIMIT) {
      throw new Error(`Run evidence exceeds ${RUN_EVIDENCE_ENTRY_LIMIT} entries`);
    }
    const nextBytes = budget.bytes + before.size;
    if (
      !Number.isSafeInteger(nextBytes) || nextBytes > RUN_EVIDENCE_TOTAL_BYTES_LIMIT
    ) {
      throw new Error(
        `Run evidence exceeds the ${RUN_EVIDENCE_TOTAL_BYTES_LIMIT}-byte aggregate limit`,
      );
    }
    budget.entries += 1;
    budget.bytes = nextBytes;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(actual);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size || current.isSymbolicLink() || !current.isFile() ||
      current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs ||
      await realpath(requested) !== actual
    ) {
      throw new Error(`Evidence artifact ${relativePath} changed while its authority was captured`);
    }
    return Object.freeze({
      path: relativePath,
      projectPath,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      dev: before.dev,
      ino: before.ino,
    });
  } finally {
    await handle.close();
  }
}

async function captureTree(options: {
  readonly runDirectory: string;
  readonly projectRoot: string;
  readonly reportPath: string;
  readonly ignoreReport: boolean;
}): Promise<Readonly<{
  runRealpath: string;
  directories: readonly DirectoryIdentity[];
  files: readonly EvidenceFileIdentity[];
}>> {
  const runEntry = await lstat(options.runDirectory);
  if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) {
    throw new Error("Run evidence root must be a regular non-symlinked directory");
  }
  const runRealpath = await requireCanonicalRunRoot(
    options.projectRoot,
    options.runDirectory,
  );
  const directories: DirectoryIdentity[] = [];
  const files: EvidenceFileIdentity[] = [];
  const budget: EvidenceCaptureBudget = { entries: 0, bytes: 0 };

  const visit = async (directory: string, depth = 0): Promise<void> => {
    if (depth > RUN_EVIDENCE_DEPTH_LIMIT) {
      throw new Error(`Run evidence exceeds ${RUN_EVIDENCE_DEPTH_LIMIT} directory levels`);
    }
    const before = await lstat(directory);
    const directoryPath = relative(options.runDirectory, directory).replaceAll("\\", "/");
    const expectedDirectoryRealpath = directoryPath === ""
      ? runRealpath
      : join(runRealpath, ...directoryPath.split("/"));
    if (
      before.isSymbolicLink() || !before.isDirectory() ||
      await realpath(directory) !== expectedDirectoryRealpath
    ) throw new Error("Run evidence contains a replaced or symlinked directory");
    if (
      directoryPath === "" &&
      (before.dev !== runEntry.dev || before.ino !== runEntry.ino)
    ) throw new Error("Run evidence root identity changed before traversal");
    directories.push({ path: directoryPath, dev: before.dev, ino: before.ino });
    for await (const entry of await opendir(directory)) {
      const absolutePath = join(directory, entry.name);
      if (options.ignoreReport && resolve(absolutePath) === resolve(options.reportPath)) continue;
      const path = normalizedRelative(options.runDirectory, absolutePath);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`Run evidence contains symlink ${path}`);
      if (stat.isDirectory()) {
        budget.entries += 1;
        if (budget.entries > RUN_EVIDENCE_ENTRY_LIMIT) {
          throw new Error(`Run evidence exceeds ${RUN_EVIDENCE_ENTRY_LIMIT} entries`);
        }
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Run evidence contains non-regular entry ${path}`);
      files.push(await captureFile(
        absolutePath,
        path,
        relative(options.projectRoot, absolutePath).replaceAll("\\", "/"),
        budget,
        join(runRealpath, ...path.split("/")),
      ));
    }
    const after = await lstat(directory);
    if (
      after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev ||
      before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || await realpath(directory) !== expectedDirectoryRealpath
    ) throw new Error("Run evidence directory changed while its authority was captured");
  };
  await visit(options.runDirectory);
  const finalRunEntry = await lstat(options.runDirectory);
  if (
    finalRunEntry.isSymbolicLink() || !finalRunEntry.isDirectory() ||
    finalRunEntry.dev !== runEntry.dev || finalRunEntry.ino !== runEntry.ino ||
    await realpath(options.runDirectory) !== runRealpath
  ) throw new Error("Run evidence root identity changed during traversal");
  return Object.freeze({
    runRealpath,
    directories: Object.freeze(directories
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => Object.freeze(entry))),
    files: Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path))),
  });
}

function comparable(authority: Pick<RunEvidenceAuthority, "runRealpath" | "directories" | "files">): string {
  return JSON.stringify({
    runRealpath: authority.runRealpath,
    directories: authority.directories,
    files: authority.files,
  });
}

/** Captures the exact command-owned run tree and binds it one-to-one to artifact references. */
export async function captureRunEvidenceAuthority(options: {
  readonly runDirectory: string;
  readonly projectRoot: string;
  readonly reportPath: string;
  readonly artifacts: readonly ArtifactReference[];
}): Promise<Readonly<RunEvidenceAuthority>> {
  const tree = await captureTree({ ...options, ignoreReport: false });
  const referencedPaths = options.artifacts.map((artifact) => {
    const absolutePath = resolve(options.projectRoot, ...artifact.path.replaceAll("\\", "/").split("/"));
    return normalizedRelative(options.runDirectory, absolutePath);
  }).sort();
  if (new Set(referencedPaths).size !== referencedPaths.length) {
    throw new Error("Command result contains duplicate evidence artifact references");
  }
  const actualPaths = tree.files.map(({ path }) => path).sort();
  if (JSON.stringify(referencedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error(
      `Command result does not reference the exact run evidence set (actual: ${actualPaths.join(", ") || "none"})`,
    );
  }
  const byProjectPath = new Map(tree.files.map((file) => [file.projectPath, file]));
  for (const artifact of options.artifacts) {
    const identity = byProjectPath.get(artifact.path);
    if (identity === undefined) throw new Error(`Evidence artifact ${artifact.path} lacks captured authority`);
    if (
      artifact.digest !== undefined &&
      artifact.digest.replace(/^sha256:/u, "") !== identity.sha256
    ) throw new Error(`Evidence artifact ${artifact.path} declares a stale digest`);
  }
  return Object.freeze({
    mode: "exact-tree",
    runDirectory: options.runDirectory,
    runRealpath: tree.runRealpath,
    reportPath: options.reportPath,
    directories: tree.directories,
    files: tree.files,
  });
}

/** Captures only explicitly referenced failure artifacts while retaining the fresh run-root identity. */
export async function captureSelectedEvidenceAuthority(options: {
  readonly runDirectory: string;
  readonly projectRoot: string;
  readonly reportPath: string;
  readonly artifacts: readonly ArtifactReference[];
}): Promise<Readonly<RunEvidenceAuthority>> {
  const runEntry = await lstat(options.runDirectory);
  if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) {
    throw new Error("Failure evidence root must be a regular non-symlinked directory");
  }
  const runRealpath = await requireCanonicalRunRoot(
    options.projectRoot,
    options.runDirectory,
  );
  const seen = new Set<string>();
  const files: EvidenceFileIdentity[] = [];
  const budget: EvidenceCaptureBudget = { entries: 0, bytes: 0 };
  for (const artifact of options.artifacts) {
    const absolutePath = resolve(options.projectRoot, ...artifact.path.replaceAll("\\", "/").split("/"));
    const path = normalizedRelative(options.runDirectory, absolutePath);
    if (path.includes("/")) throw new Error("Failure evidence artifacts must be direct run-directory files");
    if (seen.has(path)) throw new Error("Failure result contains duplicate artifact references");
    seen.add(path);
    files.push(await captureFile(
      absolutePath,
      path,
      artifact.path,
      budget,
      join(runRealpath, path),
    ));
  }
  const finalRunEntry = await lstat(options.runDirectory);
  if (
    finalRunEntry.isSymbolicLink() || !finalRunEntry.isDirectory() ||
    finalRunEntry.dev !== runEntry.dev || finalRunEntry.ino !== runEntry.ino ||
    await realpath(options.runDirectory) !== runRealpath
  ) throw new Error("Failure evidence run-directory identity changed during capture");
  return Object.freeze({
    mode: "selected-files",
    runDirectory: options.runDirectory,
    runRealpath,
    reportPath: options.reportPath,
    directories: Object.freeze([Object.freeze({ path: "", dev: runEntry.dev, ino: runEntry.ino })]),
    files: Object.freeze(files),
  });
}

/** Rechecks containment, directory identities, exact membership, size, and bytes. */
export async function verifyRunEvidenceAuthority(
  authority: Readonly<RunEvidenceAuthority>,
  projectRoot: string,
): Promise<void> {
  if (authority.mode === "selected-files") {
    const runEntry = await lstat(authority.runDirectory);
    const root = authority.directories[0];
    if (
      root === undefined || !runEntry.isDirectory() || runEntry.isSymbolicLink() ||
      runEntry.dev !== root.dev || runEntry.ino !== root.ino ||
      await realpath(authority.runDirectory) !== authority.runRealpath
    ) throw new Error("Failure evidence run-directory identity changed");
    const budget: EvidenceCaptureBudget = { entries: 0, bytes: 0 };
    const captured: EvidenceFileIdentity[] = [];
    for (const file of authority.files) {
      captured.push(await captureFile(
        join(authority.runDirectory, file.path),
        file.path,
        file.projectPath,
        budget,
        join(authority.runRealpath, file.path),
      ));
    }
    const finalRunEntry = await lstat(authority.runDirectory);
    if (
      finalRunEntry.isSymbolicLink() || !finalRunEntry.isDirectory() ||
      finalRunEntry.dev !== root.dev || finalRunEntry.ino !== root.ino ||
      await realpath(authority.runDirectory) !== authority.runRealpath
    ) throw new Error("Failure evidence run-directory identity changed during verification");
    if (JSON.stringify(captured) !== JSON.stringify(authority.files)) {
      throw new Error("Failure evidence bytes no longer match their publication authority");
    }
    return;
  }
  const current = await captureTree({
    runDirectory: authority.runDirectory,
    projectRoot,
    reportPath: authority.reportPath,
    ignoreReport: true,
  });
  if (comparable(current) !== comparable(authority)) {
    throw new Error("Run evidence no longer matches its captured publication authority");
  }
}

export function bindArtifactDigests(
  artifacts: readonly ArtifactReference[],
  authority: Readonly<RunEvidenceAuthority>,
): readonly ArtifactReference[] {
  const identities = new Map(authority.files.map((file) => [file.projectPath, file]));
  return Object.freeze(artifacts.map((artifact) => {
    const identity = identities.get(artifact.path);
    if (identity === undefined) throw new Error(`Evidence artifact ${artifact.path} lacks captured authority`);
    return Object.freeze({ ...artifact, digest: artifact.digest ?? identity.sha256 });
  }));
}

/** Verifies that the newly published contextual report is exactly the bytes the CLI authored. */
export async function verifyPublishedReport(
  reportPath: string,
  expectedBytes: string,
): Promise<void> {
  const entry = await lstat(reportPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("Published report must be a regular non-symlinked file");
  }
  const expected = new TextEncoder().encode(expectedBytes);
  const captured = await captureFile(
    reportPath,
    "report.json",
    "report.json",
    { entries: 0, bytes: 0 },
  );
  if (captured.size !== expected.byteLength || captured.sha256 !== sha256(expected)) {
    throw new Error("Published report bytes do not match the contextual command result");
  }
}
