// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { terminateProcessTree } from "../external-tools";
import { discoverProjectSourceGraph } from "./source-graph";
import { requireSupportedBunRuntime } from "../runtime";

export const FULMETRY_CONFIG_SCHEMA_VERSION = 1 as const;
export const CONFIG_EVALUATION_TIMEOUT_MS = 10_000;
export const CONFIG_EVALUATION_OUTPUT_LIMIT = 1024 * 1024;

export interface ConfigEvaluationOptions {
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  readonly signal?: AbortSignal;
}

export interface FulmetryConfig {
  readonly schemaVersion: typeof FULMETRY_CONFIG_SCHEMA_VERSION;
  readonly entry: string;
  readonly outputDirectory: string;
  readonly profiles: readonly string[];
  /** Source-controlled design revision required for verified production promotion. */
  readonly boardRevision?: string;
}

export type FulmetryConfigInput = Partial<Omit<FulmetryConfig, "schemaVersion">> & {
  readonly schemaVersion?: typeof FULMETRY_CONFIG_SCHEMA_VERSION;
  readonly entry: string;
};

export function defineConfig(config: FulmetryConfigInput): FulmetryConfigInput {
  return config;
}

function assertPlainSerializable(
  value: unknown,
  path = "config",
  ancestors = new Set<object>(),
): void {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains non-serializable ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainSerializable(item, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain objects and arrays`);
    }
    for (const item of Object.values(value)) {
      assertPlainSerializable(item, `${path}.field`, ancestors);
    }
  }
  ancestors.delete(value);
}

function safeRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || isAbsolute(value)) {
    throw new TypeError(`${field} must be a non-empty project-relative path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new TypeError(`${field} cannot contain dot, empty, or parent-relative segments`);
  }
  return normalized;
}

function normalizeConfig(value: unknown): Readonly<FulmetryConfig> {
  assertPlainSerializable(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fulmetry.config.ts must default-export a plain object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "entry", "outputDirectory", "profiles", "boardRevision",
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`Fulmetry config contains ${unknown.length} unknown field(s)`);
  if (record.schemaVersion !== undefined && record.schemaVersion !== FULMETRY_CONFIG_SCHEMA_VERSION) {
    throw new TypeError("Fulmetry config schemaVersion is unsupported");
  }
  const profiles = record.profiles ?? [];
  if (!Array.isArray(profiles) || profiles.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError("profiles must contain non-empty names");
  }
  if (new Set(profiles).size !== profiles.length) {
    throw new TypeError("profiles cannot contain duplicates");
  }
  if (
    record.boardRevision !== undefined &&
    (
      typeof record.boardRevision !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.boardRevision)
    )
  ) {
    throw new TypeError(
      "boardRevision must be a conservative 1-64 character source-controlled identifier",
    );
  }
  const entry = safeRelativePath(record.entry, "entry");
  const outputDirectory = safeRelativePath(record.outputDirectory ?? ".fulmetry", "outputDirectory");
  if (entry === outputDirectory || entry.startsWith(`${outputDirectory}/`)) {
    throw new TypeError("outputDirectory cannot contain the circuit entry");
  }
  return Object.freeze({
    schemaVersion: FULMETRY_CONFIG_SCHEMA_VERSION,
    entry,
    outputDirectory,
    profiles: Object.freeze([...profiles].sort()),
    ...(record.boardRevision === undefined
      ? {}
      : { boardRevision: record.boardRevision }),
  });
}

function stableConfigJson(config: FulmetryConfig): string {
  return JSON.stringify(config);
}

async function readBoundedConfigOutput(
  stream: ReadableStream<Uint8Array>,
  terminate: () => void,
  outputLimit: number,
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
      if (size > outputLimit) {
        terminate();
        throw new Error(`Configuration evaluation output exceeded ${outputLimit} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function importConfigInFreshProcess(
  configPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  options: Readonly<{ timeoutMs: number; outputLimit: number; signal?: AbortSignal }>,
): Promise<Readonly<FulmetryConfig>> {
  const url = pathToFileURL(configPath).href;
  const script = [
    "class ConfigSerializationError extends Error{}",
    "const fail=(message)=>{throw new ConfigSerializationError(message)}",
    `const m=await import(${JSON.stringify(url)})`,
    "const seen=new Set()",
    "function plain(v,p='config'){if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'){if(!Number.isFinite(v))fail(p+' contains a non-finite number');return}if(typeof v!=='object')fail(p+' contains non-serializable '+typeof v);if(seen.has(v))fail(p+' contains a cycle');seen.add(v);if(Array.isArray(v)){v.forEach((item,index)=>plain(item,p+'['+index+']'))}else{const proto=Object.getPrototypeOf(v);if(proto!==Object.prototype&&proto!==null)fail(p+' must contain only plain objects and arrays');for(const item of Object.values(v))plain(item,p+'.field')}seen.delete(v)}",
    "try{plain(m.default);process.stdout.write(JSON.stringify({ok:true,value:m.default}))}catch(error){if(error instanceof ConfigSerializationError)process.stdout.write(JSON.stringify({ok:false,error:error.message}));else throw error}",
  ].join(";");
  const child = Bun.spawn([
    process.execPath,
    ...(process.platform === "win32" ? [] : ["--no-orphans"]),
    "-e",
    script,
  ], {
    env: Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  const terminate = () => terminateProcessTree(child.pid);
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const onAbort = () => {
    cancelled = true;
    terminate();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (cancelled) terminate();
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  let stdout: string;
  let exitCode: number;
  try {
    [stdout, , exitCode] = await Promise.all([
      readBoundedConfigOutput(child.stdout, terminate, options.outputLimit),
      readBoundedConfigOutput(child.stderr, terminate, options.outputLimit),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (cancelled) throw new Error("Configuration evaluation was cancelled");
  if (timedOut) {
    throw new Error(`Configuration evaluation exceeded ${options.timeoutMs} ms`);
  }
  if (exitCode !== 0) {
    throw new Error(`Configuration evaluation failed with exit ${exitCode}; project stderr is not echoed`);
  }
  try {
    const envelope = JSON.parse(stdout) as { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown };
    if (envelope.ok === false && typeof envelope.error === "string") {
      throw new TypeError(envelope.error);
    }
    if (envelope.ok !== true) throw new TypeError("configuration process returned an invalid envelope");
    return normalizeConfig(envelope.value);
  } catch (error) {
    throw new Error(
      `Configuration evaluation did not return one serializable object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sanitizedConfigEnvironment(): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    FULMETRY_VERIFIED_CONFIG: "1",
    BUN_CONFIG_NO_NETWORK: "1",
    NO_PROXY: "*",
    no_proxy: "*",
  });
}

export async function loadProjectConfig(
  projectRoot: string,
  options: ConfigEvaluationOptions = {},
): Promise<Readonly<FulmetryConfig>> {
  requireSupportedBunRuntime();
  const timeoutMs = options.timeoutMs ?? CONFIG_EVALUATION_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? CONFIG_EVALUATION_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) {
    throw new TypeError("Configuration evaluation timeout must be an integer from 10 through 300000 ms");
  }
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1_024 || outputLimit > 16 * 1024 * 1024) {
    throw new TypeError("Configuration evaluation output limit must be an integer from 1024 through 16777216 bytes");
  }
  const evaluationOptions = Object.freeze({
    timeoutMs,
    outputLimit,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const root = await realpath(projectRoot);
  const configPath = resolve(root, "fulmetry.config.ts");
  const stat = await lstat(configPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("fulmetry.config.ts must be a regular file, not a symlink");
  }
  await discoverProjectSourceGraph(root, "fulmetry.config.ts", {
    enforceVerifiedSemantics: true,
    forbidAmbientNondeterminism: true,
  });
  const first = await importConfigInFreshProcess(configPath, process.env, evaluationOptions);
  const second = await importConfigInFreshProcess(configPath, sanitizedConfigEnvironment(), evaluationOptions);
  if (stableConfigJson(first) !== stableConfigJson(second)) {
    throw new Error("fulmetry.config.ts resolved nondeterministically across isolated evaluations");
  }
  for (const [field, relative] of [
    ["entry", first.entry],
    ["outputDirectory", first.outputDirectory],
  ] as const) {
    const target = resolve(root, ...relative.split("/"));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`${field} resolves outside the project root`);
    }
  }
  const entryPath = resolve(root, ...first.entry.split("/"));
  const entryStat = await lstat(entryPath);
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
    throw new Error("Configured circuit entry must be a regular file, not a symlink");
  }
  return first;
}
