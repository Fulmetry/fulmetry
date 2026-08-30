// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  ProcessContainmentUnavailableError,
  spawnContainedProcess,
  type ContainedProcess,
} from "../src/internal/contained-process";

const MAXIMUM_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAXIMUM_DIAGNOSTIC_CHARACTERS = 8_192;

function acceptanceChildEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    BUN_CONFIG_NO_NETWORK: "1",
    NO_PROXY: "*",
    no_proxy: "*",
    FULMETRY_VERIFIED_BUILD: "1",
    NO_COLOR: "1",
  };
  for (const name of ["TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function acceptanceChildContainmentAvailable(): boolean {
  if (process.platform === "win32") return true;
  if (process.platform !== "linux") return false;
  try {
    const membership = readFileSync("/proc/self/cgroup", "utf8");
    const unified = membership.split(/\r?\n/u)
      .map((line) => /^0::(\/.*)$/u.exec(line)?.[1])
      .find((path): path is string => path !== undefined);
    if (unified === undefined || unified.includes("\0") || unified.split("/").includes("..")) return false;
    const cgroupRoot = resolve("/sys/fs/cgroup");
    const parent = resolve(cgroupRoot, `.${unified}`);
    if (parent !== cgroupRoot && !parent.startsWith(`${cgroupRoot}${sep}`)) return false;
    accessSync(parent, constants.W_OK);
    accessSync(resolve(parent, "cgroup.procs"), constants.W_OK);
    accessSync(resolve(parent, "cgroup.kill"), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs reviewed acceptance work only where the OS can contain every descendant. */
export async function runBoundedAcceptanceChild(options: Readonly<{
  argv: readonly string[];
  cwd: string;
  label: string;
  timeoutMs: number;
}>): Promise<string> {
  if (options.argv[0] !== process.execPath) {
    throw new TypeError("Acceptance child commands must use Fulmetry's exact Bun runtime");
  }
  if (!acceptanceChildContainmentAvailable()) {
    throw new ProcessContainmentUnavailableError(
      process.platform === "darwin"
        ? "macOS cannot authoritatively contain external double-fork descendants for upgrade acceptance"
        : `upgrade acceptance has no delegated operating-system containment on ${process.platform}`,
    );
  }
  const command = process.platform === "win32" || options.argv[1] === "--no-orphans"
    ? [...options.argv]
    : [options.argv[0], "--no-orphans", ...options.argv.slice(1)];
  const environment = acceptanceChildEnvironment();
  const child: Readonly<ContainedProcess> = await spawnContainedProcess({
    command,
    cwd: options.cwd,
    env: environment,
  });
  const terminate = () => child.terminate();
  const bounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let output = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAXIMUM_CHILD_OUTPUT_BYTES) {
          terminate();
          throw new Error(`Acceptance child output exceeded ${MAXIMUM_CHILD_OUTPUT_BYTES} bytes`);
        }
        output += decoder.decode(chunk.value, { stream: true });
      }
      return output + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      bounded(child.stdout),
      bounded(child.stderr),
    ]);
    if (timedOut) throw new Error(`${options.label} exceeded ${options.timeoutMs} ms`);
    if (exit !== 0) {
      const output = stderr.trim() || stdout.trim();
      const diagnostic = output.length <= MAXIMUM_DIAGNOSTIC_CHARACTERS
        ? output
        : `${output.slice(0, 2_048)}\n... ${output.length - MAXIMUM_DIAGNOSTIC_CHARACTERS} diagnostic characters omitted ...\n${output.slice(-6_144)}`;
      throw new Error(`${options.label} failed${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    terminate();
  }
}
