// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants, writeFileSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readBoundedRegularFile } from "./bounded-file";

const MACOS_CONTAINMENT_PROFILE = "(version 1)(allow default)(deny process-fork)(deny signal)";
const MACOS_CONTAINMENT_OFFLINE_PROFILE = "(version 1)(allow default)(deny network*)(deny process-fork)(deny signal)";
const WINDOWS_RESULT_LIMIT = 64 * 1024;
const WINDOWS_ERROR_LIMIT = 1_024;
const WINDOWS_TICKS_LIMIT = 3_155_378_975_999_999_999n;
const LINUX_RESULT_LIMIT = 16 * 1024;
const MACOS_MARKER_LIMIT = 256;
const MACOS_MARKER_SCRIPT = [
  'marker="$1"',
  'nonce="$2"',
  "shift 2",
  "umask 077",
  'printf "applied:%s" "$nonce" > "$marker" || exit 71',
  'exec "$@"',
].join("; ");

export interface ContainedProcessIdentity {
  readonly pid: number;
  readonly startTimeUtcTicks: string;
}

export class ProcessContainmentUnavailableError extends Error {
  readonly code = "PROCESS_CONTAINMENT_UNAVAILABLE" as const;
  readonly processes: readonly Readonly<ContainedProcessIdentity>[];

  constructor(detail: string, processes: readonly Readonly<ContainedProcessIdentity>[] = []) {
    super(`PROCESS_CONTAINMENT_UNAVAILABLE: ${detail}`);
    this.name = "ProcessContainmentUnavailableError";
    this.processes = Object.freeze(processes.map((identity) => Object.freeze({ ...identity })));
  }
}

export class ProcessContainmentOrphanedError extends Error {
  readonly code = "PROCESS_CONTAINMENT_ORPHANED" as const;
  readonly processes: readonly Readonly<ContainedProcessIdentity>[];

  constructor(processes: readonly Readonly<ContainedProcessIdentity>[]) {
    super(`PROCESS_CONTAINMENT_ORPHANED: operating-system authority contained ${processes.length} orphaned process(es)`);
    this.name = "ProcessContainmentOrphanedError";
    this.processes = Object.freeze(processes.map((identity) => Object.freeze({ ...identity })));
  }
}

export interface WindowsJobResult {
  readonly containmentApplied: boolean;
  readonly childExitCode: number;
  readonly peakJobMemoryBytes: number;
  readonly orphanProcesses: readonly Readonly<ContainedProcessIdentity>[];
  readonly survivorProcesses: readonly Readonly<ContainedProcessIdentity>[];
  readonly error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWindowsProcessIdentities(value: unknown, field: string): readonly Readonly<ContainedProcessIdentity>[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set<number>();
  return Object.freeze(value.map((entry) => {
    if (!isRecord(entry)) throw new Error(`${field} contains an invalid process identity`);
    if (Object.keys(entry).length !== 2 || !("pid" in entry) || !("startTimeUtcTicks" in entry)) {
      throw new Error(`${field} contains unexpected fields`);
    }
    if (!Number.isSafeInteger(entry.pid) || (entry.pid as number) < 1) {
      throw new Error(`${field} contains an invalid PID`);
    }
    const pid = entry.pid as number;
    const ticks = entry.startTimeUtcTicks;
    if (
      typeof ticks !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(ticks) ||
      BigInt(ticks) > WINDOWS_TICKS_LIMIT
    ) throw new Error(`${field} contains an invalid process start identity`);
    if (seen.has(pid)) throw new Error(`${field} contains a duplicate PID`);
    seen.add(pid);
    return Object.freeze({ pid, startTimeUtcTicks: ticks });
  }));
}

export function parseWindowsJobResult(bytes: Uint8Array): Readonly<WindowsJobResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProcessContainmentUnavailableError("Windows Job Object result record is not valid UTF-8 JSON");
  }
  try {
    if (!isRecord(parsed)) throw new Error("result must be an object");
    const expectedKeys = [
      "childExitCode", "containmentApplied", "error", "orphanProcesses", "peakJobMemoryBytes", "survivorProcesses",
    ];
    if (Object.keys(parsed).sort().join("\0") !== expectedKeys.join("\0")) {
      throw new Error("result fields do not match the authoritative schema");
    }
    if (typeof parsed.containmentApplied !== "boolean") throw new Error("containmentApplied must be boolean");
    if (
      typeof parsed.childExitCode !== "number" || !Number.isInteger(parsed.childExitCode) ||
      (parsed.childExitCode as number) < -2_147_483_648 ||
      (parsed.childExitCode as number) > 2_147_483_647
    ) throw new Error("childExitCode must be a signed 32-bit integer");
    if (
      typeof parsed.peakJobMemoryBytes !== "number" || !Number.isSafeInteger(parsed.peakJobMemoryBytes) ||
      parsed.peakJobMemoryBytes < 0
    ) {
      throw new Error("peakJobMemoryBytes must be a nonnegative safe integer");
    }
    const error = parsed.error ?? null;
    if (error !== null && (typeof error !== "string" || error.length > WINDOWS_ERROR_LIMIT)) {
      throw new Error(`error must be null or at most ${WINDOWS_ERROR_LIMIT} characters`);
    }
    return Object.freeze({
      containmentApplied: parsed.containmentApplied,
      childExitCode: parsed.childExitCode as number,
      peakJobMemoryBytes: parsed.peakJobMemoryBytes as number,
      orphanProcesses: parseWindowsProcessIdentities(parsed.orphanProcesses, "orphanProcesses"),
      survivorProcesses: parseWindowsProcessIdentities(parsed.survivorProcesses, "survivorProcesses"),
      error,
    });
  } catch (error) {
    if (error instanceof ProcessContainmentUnavailableError) throw error;
    throw new ProcessContainmentUnavailableError(`Windows Job Object result record has an invalid schema: ${
      error instanceof Error ? error.message : "unknown schema error"
    }`);
  }
}

export async function readWindowsJobResult(
  path: string,
  /** @internal Deterministic path-replacement test hook after the result handle is opened. */
  afterOpen?: () => void | Promise<void>,
): Promise<Readonly<WindowsJobResult>> {
  try {
    return parseWindowsJobResult(await readBoundedRegularFile(path, WINDOWS_RESULT_LIMIT, afterOpen));
  } catch (error) {
    if (error instanceof ProcessContainmentUnavailableError) throw error;
    throw new ProcessContainmentUnavailableError(`Windows Job Object result record could not be authenticated: ${
      error instanceof Error ? error.message : "unknown file error"
    }`);
  }
}

export function resolveWindowsJobResult(
  result: Readonly<WindowsJobResult>,
  wrapperExitCode?: number,
): number {
  const expectedWrapperExitCode = !result.containmentApplied || result.error !== null || result.survivorProcesses.length > 0
    ? 87
    : result.orphanProcesses.length > 0 ? 86 : result.childExitCode;
  if (wrapperExitCode !== undefined && wrapperExitCode !== expectedWrapperExitCode) {
    throw new ProcessContainmentUnavailableError(
      `Windows Job Object wrapper exit ${wrapperExitCode} did not authenticate result status ${expectedWrapperExitCode}`,
      result.survivorProcesses,
    );
  }
  if (!result.containmentApplied || result.error !== null || result.survivorProcesses.length > 0) {
    const detail = result.error === null || result.error === ""
      ? "Windows Job Object authority was not applied or did not terminate every process"
      : `Windows Job Object runner reported: ${result.error}`;
    throw new ProcessContainmentUnavailableError(detail, result.survivorProcesses);
  }
  if (result.orphanProcesses.length > 0) {
    throw new ProcessContainmentOrphanedError(result.orphanProcesses);
  }
  return result.childExitCode;
}

export interface LinuxCgroupResult {
  readonly containmentApplied: boolean;
  readonly childExitCode: number;
  readonly orphanPids: readonly number[];
  readonly error: string | null;
}

export function parseLinuxCgroupResult(bytes: Uint8Array): Readonly<LinuxCgroupResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProcessContainmentUnavailableError("Linux cgroup result record is not valid UTF-8 JSON");
  }
  try {
    if (!isRecord(parsed)) throw new Error("result must be an object");
    const expectedKeys = ["childExitCode", "containmentApplied", "error", "orphanPids"];
    if (Object.keys(parsed).sort().join("\0") !== expectedKeys.join("\0")) {
      throw new Error("result fields do not match the authoritative schema");
    }
    if (typeof parsed.containmentApplied !== "boolean") throw new Error("containmentApplied must be boolean");
    if (
      typeof parsed.childExitCode !== "number" || !Number.isSafeInteger(parsed.childExitCode) ||
      parsed.childExitCode < 0 || parsed.childExitCode > 255
    ) throw new Error("childExitCode must be an unsigned 8-bit process status");
    if (!Array.isArray(parsed.orphanPids)) throw new Error("orphanPids must be an array");
    const orphanPids = parsed.orphanPids.map((pid) => {
      if (!Number.isSafeInteger(pid) || (pid as number) < 1) throw new Error("orphanPids contains an invalid PID");
      return pid as number;
    });
    if (new Set(orphanPids).size !== orphanPids.length) throw new Error("orphanPids contains a duplicate PID");
    const error = parsed.error ?? null;
    if (error !== null && (typeof error !== "string" || error.length > WINDOWS_ERROR_LIMIT)) {
      throw new Error(`error must be null or at most ${WINDOWS_ERROR_LIMIT} characters`);
    }
    return Object.freeze({
      containmentApplied: parsed.containmentApplied,
      childExitCode: parsed.childExitCode,
      orphanPids: Object.freeze(orphanPids),
      error,
    });
  } catch (error) {
    throw new ProcessContainmentUnavailableError(`Linux cgroup result record has an invalid schema: ${
      error instanceof Error ? error.message : "unknown schema error"
    }`);
  }
}

export async function readLinuxCgroupResult(path: string): Promise<Readonly<LinuxCgroupResult>> {
  try {
    return parseLinuxCgroupResult(await readBoundedRegularFile(path, LINUX_RESULT_LIMIT));
  } catch (error) {
    if (error instanceof ProcessContainmentUnavailableError) throw error;
    throw new ProcessContainmentUnavailableError(`Linux cgroup result record could not be authenticated: ${
      error instanceof Error ? error.message : "unknown file error"
    }`);
  }
}

export function resolveLinuxCgroupResult(
  result: Readonly<LinuxCgroupResult>,
  wrapperExitCode: number,
): number {
  const expectedWrapperExitCode = !result.containmentApplied || result.error !== null
    ? 87
    : result.orphanPids.length > 0 ? 86 : result.childExitCode;
  if (wrapperExitCode !== expectedWrapperExitCode) {
    throw new ProcessContainmentUnavailableError(
      `Linux cgroup wrapper exit ${wrapperExitCode} did not authenticate result status ${expectedWrapperExitCode}`,
    );
  }
  if (!result.containmentApplied || result.error !== null) {
    throw new ProcessContainmentUnavailableError(
      result.error === null || result.error === "" ? "Linux cgroup authority was not applied" :
        `Linux cgroup runner reported: ${result.error}`,
    );
  }
  if (result.orphanPids.length > 0) {
    throw new ProcessContainmentOrphanedError(result.orphanPids.map((pid) => ({
      pid,
      startTimeUtcTicks: "unavailable",
    })));
  }
  return result.childExitCode;
}

async function requireMacosSeatbeltMarker(path: string, nonce: string): Promise<void> {
  try {
    const marker = new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedRegularFile(path, MACOS_MARKER_LIMIT),
    );
    if (marker !== `applied:${nonce}`) throw new Error("marker nonce or state did not match");
  } catch (error) {
    throw new ProcessContainmentUnavailableError(`macOS Seatbelt application was not authenticated: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

export interface ContainedProcess {
  /** PID of the containment root, not necessarily the wrapped executable. */
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly terminate: () => void;
}

async function createLinuxCgroup(): Promise<string> {
  let membership: string;
  try {
    membership = await readFile("/proc/self/cgroup", "utf8");
  } catch (error) {
    throw new ProcessContainmentUnavailableError(`Linux cgroup membership: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
  const unified = membership.split(/\r?\n/u)
    .map((line) => /^0::(\/.*)$/u.exec(line)?.[1])
    .find((path): path is string => path !== undefined);
  if (unified === undefined || unified.includes("\0") || unified.split("/").includes("..")) {
    throw new ProcessContainmentUnavailableError("a safe cgroup v2 membership was not found");
  }
  const cgroupRoot = resolve("/sys/fs/cgroup");
  const parent = resolve(cgroupRoot, `.${unified}`);
  if (parent !== cgroupRoot && !parent.startsWith(`${cgroupRoot}${sep}`)) {
    throw new ProcessContainmentUnavailableError("cgroup membership escaped its root");
  }
  const directory = join(parent, `fulmetry-${process.pid}-${crypto.randomUUID()}`);
  try {
    await mkdir(directory);
    await access(join(directory, "cgroup.procs"), constants.W_OK);
    await access(join(directory, "cgroup.kill"), constants.W_OK);
    return directory;
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    throw new ProcessContainmentUnavailableError(`delegated cgroup v2 kill authority: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

async function cleanupLinuxCgroup(directory: string): Promise<void> {
  let remaining = "";
  try {
    remaining = (await readFile(join(directory, "cgroup.procs"), "utf8")).trim();
    if (remaining !== "") await writeFile(join(directory, "cgroup.kill"), "1");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      remaining = (await readFile(join(directory, "cgroup.procs"), "utf8")).trim();
      if (remaining === "") break;
      await Bun.sleep(25);
    }
    if (remaining !== "") {
      throw new ProcessContainmentUnavailableError(
        `Linux cgroup retained processes after cgroup.kill: ${remaining.replaceAll("\n", ",")}`,
      );
    }
  } catch (error) {
    if (error instanceof ProcessContainmentUnavailableError) throw error;
    throw new ProcessContainmentUnavailableError(`Linux cgroup cleanup could not be authenticated: ${
      error instanceof Error ? error.message : String(error)
    }`);
  } finally {
    await rmdir(directory).catch(() => undefined);
  }
}

export async function spawnContainedProcess(options: {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  /** Denies every macOS network operation for external-tool qualification. */
  readonly denyNetwork?: boolean;
  /** @internal Invalid-profile regression hook; production callers never set this. */
  readonly macosProfileForTest?: string;
}): Promise<Readonly<ContainedProcess>> {
  if (options.command.length === 0 || options.command[0] === undefined) {
    throw new TypeError("Contained process command cannot be empty");
  }
  let temporaryDirectory: string | undefined;
  let linuxCgroup: string | undefined;
  let resultKind: "windows" | "macos" | "linux" | undefined;
  let macosMarkerNonce: string | undefined;
  let command: readonly string[];
  if (process.platform === "win32") {
    const powershell = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe";
    temporaryDirectory = await mkdtemp(join(tmpdir(), "fulmetry-process-job-"));
    const resultPath = join(temporaryDirectory, "result.json");
    resultKind = "windows";
    const payload = Buffer.from(JSON.stringify({
      executable: options.command[0],
      arguments: options.command.slice(1),
      workingDirectory: options.cwd ?? process.cwd(),
      resultPath,
    }), "utf8").toString("base64");
    command = Object.freeze([
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(import.meta.dir, "windows-job-runner.ps1"),
      "-Payload",
      payload,
    ]);
  } else if (process.platform === "darwin") {
    let executable: string;
    try {
      executable = await realpath(resolve(options.cwd ?? process.cwd(), options.command[0]));
      const executableStat = await lstat(executable);
      if (!executableStat.isFile()) throw new Error("selected executable is not a regular file");
      await access(executable, constants.X_OK);
      temporaryDirectory = await mkdtemp(join(tmpdir(), "fulmetry-macos-seatbelt-"));
    } catch (error) {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new ProcessContainmentUnavailableError(`macOS containment executable/setup identity: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    const markerPath = join(temporaryDirectory, "applied.marker");
    macosMarkerNonce = crypto.randomUUID();
    resultKind = "macos";
    command = Object.freeze([
      "/usr/bin/sandbox-exec",
      "-p",
      options.macosProfileForTest ??
        (options.denyNetwork ? MACOS_CONTAINMENT_OFFLINE_PROFILE : MACOS_CONTAINMENT_PROFILE),
      "/bin/sh",
      "-c",
      MACOS_MARKER_SCRIPT,
      "fulmetry-seatbelt-runner",
      markerPath,
      macosMarkerNonce,
      executable,
      ...options.command.slice(1),
    ]);
  } else if (process.platform === "linux") {
    linuxCgroup = await createLinuxCgroup();
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "fulmetry-linux-containment-"));
    } catch (error) {
      await cleanupLinuxCgroup(linuxCgroup);
      throw new ProcessContainmentUnavailableError(`Linux containment result directory: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    const resultPath = join(temporaryDirectory, "result.json");
    resultKind = "linux";
    const payload = Buffer.from(JSON.stringify({
      command: options.command,
      cgroup: linuxCgroup,
      resultPath,
    }), "utf8").toString("base64");
    command = Object.freeze([
      process.execPath,
      "--no-orphans",
      join(import.meta.dir, "linux-cgroup-runner.ts"),
      payload,
    ]);
  } else {
    throw new ProcessContainmentUnavailableError(`unsupported platform ${process.platform}`);
  }

  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [...command],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (linuxCgroup !== undefined) await cleanupLinuxCgroup(linuxCgroup);
    throw new ProcessContainmentUnavailableError(`operating-system containment root could not start: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  const terminate = (): void => {
    if (linuxCgroup !== undefined) {
      try { writeFileSync(join(linuxCgroup, "cgroup.kill"), "1"); } catch { /* cleanup verifies */ }
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // Fall through when the dedicated process group already disappeared.
      }
    }
    try { child.kill("SIGKILL"); } catch { /* containment root already exited */ }
  };
  const exited = (async (): Promise<number> => {
    try {
      const wrapperExitCode = await child.exited;
      if (temporaryDirectory === undefined) return wrapperExitCode;
      const resultPath = join(temporaryDirectory, "result.json");
      if (resultKind === "windows") {
        return resolveWindowsJobResult(await readWindowsJobResult(resultPath), wrapperExitCode);
      }
      if (resultKind === "macos") {
        if (macosMarkerNonce === undefined) {
          throw new ProcessContainmentUnavailableError("macOS Seatbelt marker nonce was not selected");
        }
        await requireMacosSeatbeltMarker(join(temporaryDirectory, "applied.marker"), macosMarkerNonce);
        return wrapperExitCode;
      }
      if (resultKind === "linux") {
        return resolveLinuxCgroupResult(await readLinuxCgroupResult(resultPath), wrapperExitCode);
      }
      throw new ProcessContainmentUnavailableError("containment result authority was not selected");
    } finally {
      try {
        if (linuxCgroup !== undefined) await cleanupLinuxCgroup(linuxCgroup);
      } finally {
        if (temporaryDirectory !== undefined) {
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  })();
  return Object.freeze({
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    terminate,
  });
}
