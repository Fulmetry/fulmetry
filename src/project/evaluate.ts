// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonicalCircuitJson, parseCanonicalCircuitJson } from "../circuit-json";
import { loadProjectConfig, type PcbooConfig } from "./config";
import { terminateProcessTree } from "../external-tools";
import { requireSupportedBunRuntime } from "../runtime";
import { normalizeCircuitQuantityValues } from "../units";

export const PROJECT_EVALUATION_TIMEOUT_MS = 30_000;
export const PROJECT_EVALUATION_OUTPUT_LIMIT = 64 * 1024 * 1024;

export interface ProjectCircuitEvaluation {
  readonly circuitJson: ReturnType<typeof parseCanonicalCircuitJson>;
  readonly canonicalJson: string;
}

function sanitizedEnvironment(): Record<string, string> {
  const allowed = ["PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"];
  const result: Record<string, string> = {
    PCBOO_VERIFIED_BUILD: "1",
    BUN_CONFIG_NO_NETWORK: "1",
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  terminate: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        terminate();
        throw new Error(`Project evaluation output exceeded ${maximumBytes} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function evaluateOnce(
  projectRoot: string,
  entry: string,
  options: { readonly timeoutMs: number; readonly outputLimit: number; readonly signal?: AbortSignal },
): Promise<ProjectCircuitEvaluation> {
  const entryUrl = pathToFileURL(resolve(projectRoot, ...entry.split("/"))).href;
  const script = [
    "let verifiedNetworkAttempts=0",
    "const denyVerifiedNetwork=()=>{verifiedNetworkAttempts+=1;throw new Error('PCBoo verified evaluation forbids runtime network access; use a locked vendored asset')}",
    "Object.defineProperty(globalThis,'fetch',{value:denyVerifiedNetwork,writable:false,configurable:false})",
    `const m=await import(${JSON.stringify(entryUrl)})`,
    "let value=m.default",
    "if(typeof value==='function')value=await value()",
    "if(value&&typeof value.renderUntilSettled==='function'&&typeof value.getCircuitJson==='function'){await value.renderUntilSettled();value=value.getCircuitJson()}",
    "if(!Array.isArray(value))throw new TypeError('PCBoo entry must default-export Circuit JSON, a Circuit, or a factory returning one')",
    "if(verifiedNetworkAttempts!==0)throw new Error('PCBoo verified evaluation rejected a runtime network attempt; use a locked vendored asset')",
    "process.stdout.write(JSON.stringify(value))",
  ].join(";");
  const child = Bun.spawn([
    process.execPath,
    ...(process.platform === "win32" ? [] : ["--no-orphans"]),
    "-e",
    script,
  ], {
    cwd: projectRoot,
    env: sanitizedEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const terminate = () => terminateProcessTree(child.pid);
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
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(child.stdout, options.outputLimit, terminate),
      readBoundedOutput(child.stderr, Math.min(options.outputLimit, 1024 * 1024), terminate),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (cancelled) throw new Error("Project entry evaluation was cancelled");
  if (timedOut) throw new Error(`Project entry evaluation exceeded ${options.timeoutMs} ms`);
  if (exitCode !== 0) {
    throw new Error(`Project entry evaluation failed with exit ${exitCode}; project stderr is not echoed`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("Project entry wrote non-JSON output; remove console output from verified evaluation");
  }
  if (!Array.isArray(raw)) throw new TypeError("Project entry evaluation did not return an array");
  const canonicalJson = canonicalCircuitJson(normalizeCircuitQuantityValues(raw));
  return Object.freeze({
    circuitJson: parseCanonicalCircuitJson(canonicalJson),
    canonicalJson,
  });
}

export async function evaluateProjectCircuitTwice(
  projectRoot: string,
  options: {
    readonly timeoutMs?: number;
    readonly outputLimit?: number;
    readonly signal?: AbortSignal;
    readonly expectedConfig?: Readonly<PcbooConfig>;
  } = {},
): Promise<Readonly<ProjectCircuitEvaluation>> {
  requireSupportedBunRuntime();
  const timeoutMs = options.timeoutMs ?? PROJECT_EVALUATION_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? PROJECT_EVALUATION_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) {
    throw new TypeError("Project evaluation timeout must be an integer from 10 through 300000 ms");
  }
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1_024 || outputLimit > 256 * 1024 * 1024) {
    throw new TypeError("Project evaluation output limit must be an integer from 1024 through 268435456 bytes");
  }
  const loadedConfig = await loadProjectConfig(projectRoot);
  if (
    options.expectedConfig !== undefined &&
    !isDeepStrictEqual(loadedConfig, options.expectedConfig)
  ) throw new Error("Resolved project configuration changed before circuit evaluation");
  const config = options.expectedConfig ?? loadedConfig;
  const runOptions = {
    timeoutMs,
    outputLimit,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const first = await evaluateOnce(projectRoot, config.entry, runOptions);
  const second = await evaluateOnce(projectRoot, config.entry, runOptions);
  if (first.canonicalJson !== second.canonicalJson) {
    throw new Error("Project Circuit JSON is nondeterministic across fresh sanitized processes");
  }
  if (!isDeepStrictEqual(await loadProjectConfig(projectRoot), config)) {
    throw new Error("Resolved project configuration changed during circuit evaluation");
  }
  return first;
}
