// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactReference } from "../result";

const SHA256_REFERENCE = /^(?:sha256:)?[a-f0-9]{64}$/u;

interface FileSystemIdentity {
  readonly path: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

interface BoundArtifact {
  readonly reference: Readonly<Required<ArtifactReference>>;
  readonly absolutePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly identity: FileSystemIdentity;
  readonly ancestors: readonly FileSystemIdentity[];
}

export interface ServerArtifactAuthority {
  readonly project: FileSystemIdentity;
  readonly run: FileSystemIdentity;
  readonly runAncestors: readonly FileSystemIdentity[];
  readonly referenceSetSha256: string;
  readonly artifacts: readonly BoundArtifact[];
}

export interface ServerGeneratedFileAuthority {
  readonly authority: Readonly<ServerArtifactAuthority>;
  readonly reference: Readonly<Required<ArtifactReference>>;
}

export class ServerArtifactFreshnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerArtifactFreshnessError";
  }
}

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function isStrictChild(parent: string, child: string): boolean {
  const within = relative(parent, child);
  return within !== "" && !within.startsWith("..") && !isAbsolute(within);
}

async function captureDirectory(path: string, label: string): Promise<Readonly<FileSystemIdentity>> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ServerArtifactFreshnessError(`${label} must be a real non-symlink directory`);
  }
  return Object.freeze({ path, realpath: await realpath(path), dev: entry.dev, ino: entry.ino });
}

async function assertIdentity(identity: FileSystemIdentity, label: string): Promise<void> {
  const current = await captureDirectory(identity.path, label);
  if (current.realpath !== identity.realpath || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new ServerArtifactFreshnessError(`${label} identity changed`);
  }
}

function snapshotReferences(references: readonly ArtifactReference[]): readonly Readonly<Required<ArtifactReference>>[] {
  const snapshots = references.map((reference) => {
    const kind = String(reference.kind);
    const path = String(reference.path);
    const digest = reference.digest === undefined ? "" : String(reference.digest);
    if (!kind.trim() || !path || !SHA256_REFERENCE.test(digest)) {
      throw new ServerArtifactFreshnessError(`Artifact ${path || "<empty>"} requires a lowercase SHA-256 digest`);
    }
    if (
      path.includes("\\") || path.includes("\0") || isAbsolute(path) ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) throw new ServerArtifactFreshnessError(`Artifact path is unsafe: ${path}`);
    return Object.freeze({ kind, path, digest });
  });
  const keys = snapshots.map(({ kind, path, digest }) => `${kind}\0${path}\0${digest}`).sort();
  if (new Set(keys).size !== keys.length) {
    throw new ServerArtifactFreshnessError("Artifact reference set contains duplicates");
  }
  return Object.freeze(snapshots.sort((left, right) =>
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
  ));
}

function referenceSetDigest(references: readonly Readonly<Required<ArtifactReference>>[]): string {
  return sha256(references.map(({ kind, path, digest }) => `${kind}\0${path}\0${digest}\n`).join(""));
}

async function captureRegularFile(path: string, displayPath: string): Promise<Readonly<{
  size: number;
  sha256: string;
  identity: FileSystemIdentity;
}>> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new ServerArtifactFreshnessError(`Artifact ${displayPath} could not be opened as a regular non-symlink file: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ServerArtifactFreshnessError(`Artifact ${displayPath} is not a regular file`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size
    ) throw new ServerArtifactFreshnessError(`Artifact ${displayPath} changed while being read`);
    const real = await realpath(path);
    const current = await lstat(path);
    if (
      current.isSymbolicLink() || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
    ) throw new ServerArtifactFreshnessError(`Artifact ${displayPath} identity changed while being captured`);
    return Object.freeze({
      size: bytes.byteLength,
      sha256: sha256(bytes),
      identity: Object.freeze({ path, realpath: real, dev: before.dev, ino: before.ino }),
    });
  } finally {
    await handle.close();
  }
}

async function captureArtifact(options: {
  readonly project: FileSystemIdentity;
  readonly run: FileSystemIdentity;
  readonly reference: Readonly<Required<ArtifactReference>>;
}): Promise<Readonly<BoundArtifact>> {
  const absolutePath = resolve(options.project.path, ...options.reference.path.split("/"));
  if (!isStrictChild(options.project.path, absolutePath) || !isStrictChild(options.run.path, absolutePath)) {
    throw new ServerArtifactFreshnessError(`Artifact path is outside its action run: ${options.reference.path}`);
  }
  const withinRun = relative(options.run.path, absolutePath);
  const segments = withinRun.split(/[\\/]/u);
  const ancestors: FileSystemIdentity[] = [];
  let current = options.run.path;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    ancestors.push(await captureDirectory(current, `Artifact ancestor ${relative(options.run.path, current)}`));
  }
  const file = await captureRegularFile(absolutePath, options.reference.path);
  if (!isStrictChild(options.project.realpath, file.identity.realpath) || !isStrictChild(options.run.realpath, file.identity.realpath)) {
    throw new ServerArtifactFreshnessError(`Artifact real path escaped its action run: ${options.reference.path}`);
  }
  if (options.reference.digest.replace(/^sha256:/u, "") !== file.sha256) {
    throw new ServerArtifactFreshnessError(`Artifact digest mismatch: ${options.reference.path}`);
  }
  await assertIdentity(options.project, "Artifact project root");
  await assertIdentity(options.run, "Artifact action run directory");
  for (const ancestor of ancestors) await assertIdentity(ancestor, "Artifact ancestor directory");
  return Object.freeze({
    reference: options.reference,
    absolutePath,
    size: file.size,
    sha256: file.sha256,
    identity: file.identity,
    ancestors: Object.freeze(ancestors),
  });
}

async function captureDirectoryChain(
  parent: string,
  child: string,
): Promise<readonly Readonly<FileSystemIdentity>[]> {
  const within = relative(parent, child);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    throw new ServerArtifactFreshnessError("Artifact action run directory must be a strict project descendant");
  }
  const segments = within.split(/[\\/]/u);
  const identities: FileSystemIdentity[] = [];
  let current = parent;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    identities.push(await captureDirectory(current, `Artifact run ancestor ${relative(parent, current)}`));
  }
  return Object.freeze(identities);
}

export async function captureServerArtifactAuthority(options: {
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly artifacts: readonly ArtifactReference[];
}): Promise<Readonly<ServerArtifactAuthority>> {
  const references = snapshotReferences(options.artifacts);
  if (references.length === 0) throw new ServerArtifactFreshnessError("Artifact authority requires at least one reference");
  const projectPath = resolve(String(options.projectRoot));
  const runPath = resolve(String(options.runDirectory));
  const project = await captureDirectory(projectPath, "Artifact project root");
  const runAncestors = await captureDirectoryChain(projectPath, runPath);
  const run = await captureDirectory(runPath, "Artifact action run directory");
  if (!isStrictChild(project.path, run.path) || !isStrictChild(project.realpath, run.realpath)) {
    throw new ServerArtifactFreshnessError("Artifact action run directory must remain strictly inside the project");
  }
  const artifacts = Object.freeze(await Promise.all(references.map((reference) =>
    captureArtifact({ project, run, reference })
  )));
  const fileIdentities = new Set(artifacts.map(({ identity }) => `${identity.dev}:${identity.ino}`));
  if (fileIdentities.size !== artifacts.length) {
    throw new ServerArtifactFreshnessError("Artifact references alias the same physical file");
  }
  await assertIdentity(project, "Artifact project root");
  for (const ancestor of runAncestors) await assertIdentity(ancestor, "Artifact run ancestor directory");
  await assertIdentity(run, "Artifact action run directory");
  return Object.freeze({ project, run, runAncestors, referenceSetSha256: referenceSetDigest(references), artifacts });
}

export async function verifyServerArtifactAuthority(
  authority: Readonly<ServerArtifactAuthority>,
  references: readonly ArtifactReference[],
): Promise<void> {
  const snapshots = snapshotReferences(references);
  if (referenceSetDigest(snapshots) !== authority.referenceSetSha256 || snapshots.length !== authority.artifacts.length) {
    throw new ServerArtifactFreshnessError("Stored artifact reference set changed");
  }
  await assertIdentity(authority.project, "Artifact project root");
  for (const ancestor of authority.runAncestors) await assertIdentity(ancestor, "Artifact run ancestor directory");
  await assertIdentity(authority.run, "Artifact action run directory");
  for (const artifact of authority.artifacts) {
    for (const ancestor of artifact.ancestors) await assertIdentity(ancestor, "Artifact ancestor directory");
    const current = await captureRegularFile(artifact.absolutePath, artifact.reference.path);
    if (
      current.identity.realpath !== artifact.identity.realpath || current.identity.dev !== artifact.identity.dev ||
      current.identity.ino !== artifact.identity.ino || current.size !== artifact.size || current.sha256 !== artifact.sha256 ||
      current.sha256 !== artifact.reference.digest.replace(/^sha256:/u, "")
    ) throw new ServerArtifactFreshnessError(`Stored artifact is stale: ${artifact.reference.path}`);
  }
  await assertIdentity(authority.project, "Artifact project root");
  for (const ancestor of authority.runAncestors) await assertIdentity(ancestor, "Artifact run ancestor directory");
  await assertIdentity(authority.run, "Artifact action run directory");
}

/** Captures a framework-generated file that has no public ArtifactReference, such as report.json. */
export async function captureServerGeneratedFileAuthority(options: {
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly absolutePath: string;
  readonly kind: string;
  readonly expectedBytes: Uint8Array | string;
}): Promise<Readonly<ServerGeneratedFileAuthority>> {
  const projectRoot = resolve(String(options.projectRoot));
  const runDirectory = resolve(String(options.runDirectory));
  const absolutePath = resolve(String(options.absolutePath));
  if (!isStrictChild(projectRoot, absolutePath) || !isStrictChild(runDirectory, absolutePath)) {
    throw new ServerArtifactFreshnessError("Generated evidence file is outside its action run");
  }
  const projectPath = relative(projectRoot, absolutePath).replaceAll("\\", "/");
  const captured = await captureRegularFile(absolutePath, projectPath);
  const expectedBytes = typeof options.expectedBytes === "string"
    ? new TextEncoder().encode(options.expectedBytes)
    : options.expectedBytes;
  if (captured.size !== expectedBytes.byteLength || captured.sha256 !== sha256(expectedBytes)) {
    throw new ServerArtifactFreshnessError("Generated evidence file bytes do not match the action result");
  }
  const reference = Object.freeze({
    kind: String(options.kind),
    path: projectPath,
    digest: captured.sha256,
  });
  const authority = await captureServerArtifactAuthority({
    projectRoot,
    runDirectory,
    artifacts: [reference],
  });
  return Object.freeze({ authority, reference });
}
