// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export const BUILD_INPUT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const BUILD_INPUT_ROLES = [
  "source",
  "config",
  "config-dependency",
  "test",
  "profile",
  "waiver",
  "lockfile",
  "vendored",
] as const;

export type BuildInputRole = (typeof BUILD_INPUT_ROLES)[number];

export interface BuildInputDescriptor {
  readonly path: string;
  readonly role: BuildInputRole;
}

export interface BuildInputEntry extends BuildInputDescriptor {
  readonly sha256: string;
  readonly size: number;
}

export interface BuildInputSnapshot {
  readonly schemaVersion: typeof BUILD_INPUT_SNAPSHOT_SCHEMA_VERSION;
  readonly digest: string;
  readonly inputs: readonly BuildInputEntry[];
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function assertDescriptor(descriptor: BuildInputDescriptor): void {
  const path = normalizePath(descriptor.path);
  if (!path || isAbsolute(path) || path.split("/").includes("..")) {
    throw new Error(`Build input must be a contained relative path: ${descriptor.path}`);
  }
  if (!BUILD_INPUT_ROLES.includes(descriptor.role)) {
    throw new Error(`Unknown build-input role: ${String(descriptor.role)}`);
  }
}

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function createBuildInputSnapshot(options: {
  readonly projectRoot: string;
  readonly inputs: readonly BuildInputDescriptor[];
  readonly maximumInputBytes?: number;
}): Promise<Readonly<BuildInputSnapshot>> {
  const maximumInputBytes = options.maximumInputBytes ?? 64 * 1024 * 1024;
  const realRoot = await realpath(resolve(options.projectRoot));
  const normalized = options.inputs.map((input) => ({
    path: normalizePath(input.path),
    role: input.role,
  }));
  for (const descriptor of normalized) assertDescriptor(descriptor);
  normalized.sort((a, b) =>
    a.path.localeCompare(b.path) || a.role.localeCompare(b.role)
  );

  if (normalized.length === 0) throw new Error("Build snapshot has no inputs");
  if (normalized.filter(({ role }) => role === "source").length === 0) {
    throw new Error("Build snapshot requires at least one source input");
  }
  const configInputs = normalized.filter(({ role }) => role === "config");
  if (configInputs.length !== 1 || configInputs[0]!.path !== "fulmetry.config.ts") {
    throw new Error("Build snapshot requires fulmetry.config.ts as its sole config input");
  }
  const lockfileInputs = normalized.filter(({ role }) => role === "lockfile");
  if (lockfileInputs.length !== 1 || lockfileInputs[0]!.path !== "fulmetry.lock") {
    throw new Error("Build snapshot requires fulmetry.lock as its sole lockfile input");
  }
  const logicalKeys = new Set(normalized.map(({ path, role }) => `${role}:${path}`));
  if (logicalKeys.size !== normalized.length) {
    throw new Error("Build snapshot contains duplicate input descriptors");
  }

  const realPaths = new Set<string>();
  const entries: BuildInputEntry[] = [];
  for (const descriptor of normalized) {
    const candidate = resolve(realRoot, ...descriptor.path.split("/"));
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Build input must be a regular non-symlink file: ${descriptor.path}`);
    }
    if (stat.size > maximumInputBytes) {
      throw new Error(
        `Build input exceeds ${maximumInputBytes} bytes: ${descriptor.path}`,
      );
    }
    const actual = await realpath(candidate);
    if (!isInside(realRoot, actual)) {
      throw new Error(`Build input escapes the project root: ${descriptor.path}`);
    }
    if (realPaths.has(actual)) {
      throw new Error(`Multiple build inputs resolve to the same file: ${descriptor.path}`);
    }
    realPaths.add(actual);
    const bytes = await readFile(actual);
    entries.push({
      ...descriptor,
      sha256: await hashBytes(bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      )),
      size: bytes.byteLength,
    });
  }

  const digestPayload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const digest = await hashBytes(new TextEncoder().encode(digestPayload).buffer);
  return Object.freeze({
    schemaVersion: BUILD_INPUT_SNAPSHOT_SCHEMA_VERSION,
    digest,
    inputs: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

export async function refreshBuildInputSnapshot(
  projectRoot: string,
  snapshot: BuildInputSnapshot,
): Promise<Readonly<BuildInputSnapshot>> {
  if (snapshot.schemaVersion !== BUILD_INPUT_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported build-input snapshot schema: ${snapshot.schemaVersion}`);
  }
  return await createBuildInputSnapshot({
    projectRoot,
    inputs: snapshot.inputs.map(({ path, role }) => ({ path, role })),
  });
}
