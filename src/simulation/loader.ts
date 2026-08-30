// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { terminateProcessTree } from "../external-tools";
import { discoverProjectSourceGraph } from "../project/source-graph";
import {
  assertProjectInputFileSize,
  PROJECT_INPUT_ENTRY_LIMIT,
} from "../project/input-limits";
import { parseSimulationDefinition, type SimulationDefinition } from "./definition";
import { simulationDefinitionDigest } from "./result";
import { requireSupportedBunRuntime } from "../runtime";

export const SIMULATION_DEFINITION_TIMEOUT_MS = 10_000;
export const SIMULATION_DEFINITION_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const SIMULATION_DEFINITION_LIMIT = 64;
const SIMULATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface SimulationDefinitionSourceEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface IssuedSimulationDefinitionAuthority {
  readonly kind: "fulmetry-loaded-simulation-definition";
}

export interface AuthenticatedSimulationDefinitionIdentity {
  readonly path: string;
  readonly definitionDigest: string;
  readonly sourceEntries: readonly Readonly<SimulationDefinitionSourceEntry>[];
}

interface CapturedSimulationDefinitionSourceEntry extends SimulationDefinitionSourceEntry {
  readonly device: string;
  readonly inode: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
}

interface InternalSimulationDefinitionIdentity extends AuthenticatedSimulationDefinitionIdentity {
  readonly projectRoot: string;
  readonly sourceEntries: readonly Readonly<CapturedSimulationDefinitionSourceEntry>[];
}

const ISSUED_SIMULATION_DEFINITIONS = new WeakMap<object, Readonly<InternalSimulationDefinitionIdentity>>();
const PRISTINE_SIMULATION_DEFINITION_WEAK_MAP_GET = Function.prototype.call.bind(WeakMap.prototype.get) as (
  map: WeakMap<object, Readonly<InternalSimulationDefinitionIdentity>>,
  key: object,
) => Readonly<InternalSimulationDefinitionIdentity> | undefined;
const PRISTINE_SIMULATION_DEFINITION_WEAK_MAP_SET = Function.prototype.call.bind(WeakMap.prototype.set) as (
  map: WeakMap<object, Readonly<InternalSimulationDefinitionIdentity>>,
  key: object,
  value: Readonly<InternalSimulationDefinitionIdentity>,
) => WeakMap<object, Readonly<InternalSimulationDefinitionIdentity>>;

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function captureSourceEntries(
  projectRoot: string,
  paths: readonly string[],
): Promise<readonly Readonly<CapturedSimulationDefinitionSourceEntry>[]> {
  const entries: CapturedSimulationDefinitionSourceEntry[] = [];
  for (const path of paths) {
    const target = resolve(projectRoot, ...path.split("/"));
    const unresolved = await lstat(target);
    if (unresolved.isSymbolicLink() || !unresolved.isFile()) {
      throw new Error(`Simulation definition source ${path} must be a regular non-symlinked file`);
    }
    if (await realpath(target) !== target) {
      throw new Error(`Simulation definition source ${path} must not traverse a symlink`);
    }
    assertProjectInputFileSize(path, unresolved.size);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`Simulation definition source ${path} is not a regular file`);
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const current = await lstat(target, { bigint: true });
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        BigInt(bytes.byteLength) !== before.size || current.isSymbolicLink() || !current.isFile() ||
        current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
        current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs
      ) {
        throw new Error(`Simulation definition source ${path} changed while its authority was captured`);
      }
      entries.push(Object.freeze({
        path,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        device: before.dev.toString(),
        inode: before.ino.toString(),
        modifiedNanoseconds: before.mtimeNs.toString(),
        changedNanoseconds: before.ctimeNs.toString(),
      }));
    } finally {
      await handle.close();
    }
  }
  return Object.freeze(entries);
}

/** Runtime authentication for a loader-issued definition token. */
export async function authenticateSimulationDefinitionAuthority(
  authority: Readonly<IssuedSimulationDefinitionAuthority> | undefined,
  expected: {
    readonly projectRoot: string;
    readonly definition: Readonly<SimulationDefinition>;
    readonly inputSnapshot: Readonly<{
      readonly inputs: readonly Readonly<{ path: string; role: string; sha256: string; size: number }>[];
    }>;
  },
): Promise<Readonly<AuthenticatedSimulationDefinitionIdentity> | undefined> {
  if (authority === undefined) return undefined;
  const identity = PRISTINE_SIMULATION_DEFINITION_WEAK_MAP_GET(
    ISSUED_SIMULATION_DEFINITIONS,
    authority,
  );
  if (
    identity === undefined ||
    identity.projectRoot !== await realpath(resolve(expected.projectRoot)) ||
    identity.definitionDigest !== simulationDefinitionDigest(expected.definition)
  ) return undefined;
  for (const source of identity.sourceEntries) {
    const snapshotEntry = expected.inputSnapshot.inputs.find(({ path }) => path === source.path);
    if (
      snapshotEntry === undefined ||
      (source.path === identity.path && snapshotEntry.role !== "test") ||
      snapshotEntry.sha256 !== source.sha256 || snapshotEntry.size !== source.size
    ) return undefined;
  }
  return Object.freeze({
    path: identity.path,
    definitionDigest: identity.definitionDigest,
    sourceEntries: Object.freeze(identity.sourceEntries.map(({ path, sha256, size }) =>
      Object.freeze({ path, sha256, size })
    )),
  });
}

async function resolveSimulationDirectory(projectRoot: string): Promise<{
  readonly root: string;
  readonly directory: string;
} | undefined> {
  const root = await realpath(projectRoot);
  const directory = join(root, "simulations");
  let entry;
  try {
    entry = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Simulation definitions directory must be a regular non-symlinked project directory");
  }
  const actual = await realpath(directory);
  const within = relative(root, actual);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    throw new Error("Simulation definitions directory escapes the project");
  }
  return Object.freeze({ root, directory: actual });
}

/** Discovers names only; it never imports or executes project code. */
export async function discoverSimulationNames(projectRoot: string): Promise<readonly string[]> {
  const resolved = await resolveSimulationDirectory(projectRoot);
  if (resolved === undefined) return Object.freeze([]);
  const names: string[] = [];
  let entryCount = 0;
  for await (const entry of await opendir(resolved.directory)) {
    entryCount += 1;
    if (entryCount > PROJECT_INPUT_ENTRY_LIMIT) {
      throw new Error(`Simulation discovery exceeds ${PROJECT_INPUT_ENTRY_LIMIT} entries`);
    }
    if (!entry.name.endsWith(".testbench.ts")) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Simulation definition ${entry.name} must be a regular non-symlinked file`);
    const name = entry.name.slice(0, -".testbench.ts".length);
    if (!SIMULATION_NAME.test(name)) throw new Error(`Simulation definition filename ${entry.name} is invalid`);
    names.push(name);
    if (names.length > SIMULATION_DEFINITION_LIMIT) {
      throw new Error(`Project contains more than ${SIMULATION_DEFINITION_LIMIT} simulation definitions`);
    }
  }
  const folded = names.map((name) => name.toLowerCase());
  if (new Set(folded).size !== folded.length) throw new Error("Simulation definition names collide case-insensitively");
  return Object.freeze(names.sort());
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  terminate: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        terminate();
        throw new Error(`Simulation definition output exceeded ${limit} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function evaluateDefinition(
  path: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<Readonly<SimulationDefinition>> {
  const script = [
    `const m=await import(${JSON.stringify(pathToFileURL(path).href)})`,
    "let value=m.default",
    "if(typeof value==='function')value=await value()",
    "process.stdout.write(JSON.stringify(value))",
  ].join(";");
  const child = Bun.spawn([
    process.execPath,
    ...(process.platform === "win32" ? [] : ["--no-orphans"]),
    "-e",
    script,
  ], {
    cwd: projectRoot,
    env: {
      FULMETRY_VERIFIED_SIMULATION: "1",
      BUN_CONFIG_NO_NETWORK: "1",
      NO_PROXY: "*",
      no_proxy: "*",
      ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
      ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  const terminate = () => terminateProcessTree(child.pid);
  let timedOut = false;
  let cancelled = signal?.aborted ?? false;
  const onAbort = () => {
    cancelled = true;
    terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (cancelled) terminate();
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, SIMULATION_DEFINITION_TIMEOUT_MS);
  try {
    const [stdout, _stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, SIMULATION_DEFINITION_OUTPUT_LIMIT, terminate),
      readBounded(child.stderr, SIMULATION_DEFINITION_OUTPUT_LIMIT, terminate),
      child.exited,
    ]);
    if (cancelled) throw new Error("Simulation definition evaluation was cancelled");
    if (timedOut) throw new Error(`Simulation definition evaluation exceeded ${SIMULATION_DEFINITION_TIMEOUT_MS} ms`);
    if (exitCode !== 0) throw new Error(`Simulation definition evaluation failed with exit ${exitCode}; project stderr is not echoed`);
    try {
      return parseSimulationDefinition(JSON.parse(stdout));
    } catch (error) {
      throw new Error(`Simulation definition is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Loads one explicit source-controlled simulations/<name>.testbench.ts module twice. */
export async function loadSimulationDefinition(options: {
  readonly projectRoot: string;
  readonly name: string;
  readonly signal?: AbortSignal;
}): Promise<Readonly<{
  definition: Readonly<SimulationDefinition>;
  path: string;
  authority: Readonly<IssuedSimulationDefinitionAuthority>;
}>> {
  requireSupportedBunRuntime();
  if (!SIMULATION_NAME.test(options.name)) {
    throw new TypeError("Simulation name must be 1-80 safe filename characters without path separators");
  }
  const resolved = await resolveSimulationDirectory(options.projectRoot);
  if (resolved === undefined) throw new Error(`Simulation ${options.name} does not exist`);
  const { root, directory } = resolved;
  const requested = join(directory, `${options.name}.testbench.ts`);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Simulation ${options.name} must be a regular non-symlinked simulations/${options.name}.testbench.ts file`);
  }
  assertProjectInputFileSize(`simulations/${options.name}.testbench.ts`, stat.size);
  const path = await realpath(requested);
  const within = relative(directory, path);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    throw new Error(`Simulation ${options.name} escapes the simulations directory`);
  }
  const graphBefore = await discoverProjectSourceGraph(root, `simulations/${options.name}.testbench.ts`, {
    enforceVerifiedSemantics: true,
    forbidAmbientNondeterminism: true,
  });
  const sourcesBefore = await captureSourceEntries(root, graphBefore);
  const first = await evaluateDefinition(path, root, options.signal);
  const second = await evaluateDefinition(path, root, options.signal);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`Simulation ${options.name} is nondeterministic across fresh sanitized processes`);
  }
  if (first.name !== options.name) {
    throw new Error(`Simulation definition name ${first.name} does not match requested name ${options.name}`);
  }
  const graphAfter = await discoverProjectSourceGraph(root, `simulations/${options.name}.testbench.ts`, {
    enforceVerifiedSemantics: true,
    forbidAmbientNondeterminism: true,
  });
  const sourcesAfter = await captureSourceEntries(root, graphAfter);
  if (JSON.stringify(sourcesBefore) !== JSON.stringify(sourcesAfter)) {
    throw new Error(`Simulation ${options.name} source graph changed while its authority was captured`);
  }
  const definitionPath = `simulations/${options.name}.testbench.ts`;
  const identity = Object.freeze({
    projectRoot: root,
    path: definitionPath,
    definitionDigest: simulationDefinitionDigest(first),
    sourceEntries: sourcesAfter,
  });
  const authority = Object.freeze({ kind: "fulmetry-loaded-simulation-definition" as const });
  PRISTINE_SIMULATION_DEFINITION_WEAK_MAP_SET(ISSUED_SIMULATION_DEFINITIONS, authority, identity);
  return Object.freeze({ definition: first, path: definitionPath, authority });
}
