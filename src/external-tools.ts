// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { hashBoundedRegularFile } from "./internal/bounded-file";
import { spawnContainedProcess, type ContainedProcess } from "./internal/contained-process";
import { requireSupportedBunRuntime } from "./runtime";

export const EXTERNAL_TOOL_PROBE_TIMEOUT_MS = 5_000;
export const EXTERNAL_TOOL_PROBE_OUTPUT_LIMIT = 64 * 1024;
export const EXTERNAL_TOOL_EXECUTABLE_BYTES_LIMIT = 256 * 1024 * 1024;
export const NGSPICE_EXECUTABLE_BYTES_LIMIT = 64 * 1024 * 1024;
export const NGSPICE_MIN_MAJOR = 42;
export const NGSPICE_MAX_MAJOR = 47;

export interface ExternalToolProbe {
  readonly tool: string;
  readonly state: "detected" | "unavailable";
  readonly executable?: string;
  readonly executableSha256?: string;
  readonly version?: string;
  readonly versionOutput?: string;
  /** Exact hashes and lengths of the bounded, untrusted probe streams. */
  readonly stdoutSha256?: string;
  readonly stderrSha256?: string;
  readonly stdoutByteLength?: number;
  readonly stderrByteLength?: number;
  readonly reason?: string;
}

export function terminateProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync({
        cmd: ["taskkill", "/PID", String(pid), "/T", "/F"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      try { process.kill(pid, 0); } catch { return; }
      // A project or external tool can create a new process group with
      // `detached: true`, which escapes a signal sent only to `-pid`. Freeze
      // the root, enumerate the OS parent graph without a shell, freeze the
      // descendants, then kill both the explicit descendants and root group.
      // The second snapshot closes ordinary fork races during the first pass.
      try { process.kill(pid, "SIGSTOP"); } catch { /* process may already be gone */ }
      const descendants = new Set<number>();
      for (let pass = 0; pass < 2; pass += 1) {
        const ps = Bun.spawnSync({
          cmd: [Bun.which("ps") ?? "/bin/ps", "-axo", "pid=,ppid="],
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        if (ps.exitCode !== 0) break;
        const children = new Map<number, number[]>();
        for (const line of new TextDecoder().decode(ps.stdout).split(/\r?\n/u)) {
          const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
          if (match === null) continue;
          const child = Number(match[1]); const parent = Number(match[2]);
          if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent) || child <= 1) continue;
          children.set(parent, [...(children.get(parent) ?? []), child]);
        }
        const pending = [pid, ...descendants];
        while (pending.length > 0) {
          for (const child of children.get(pending.pop()!) ?? []) {
            if (descendants.has(child)) continue;
            descendants.add(child);
            pending.push(child);
          }
        }
        for (const child of descendants) {
          try { process.kill(child, "SIGSTOP"); } catch { /* descendant may already be gone */ }
        }
      }
      for (const child of [...descendants].reverse()) {
        try { process.kill(child, "SIGKILL"); } catch { /* descendant may already be gone */ }
      }
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  terminate: () => void,
): Promise<Readonly<{ text: string; sha256: string; byteLength: number }>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        terminate();
        throw new Error(`version output exceeded ${limit} bytes`);
      }
      hasher.update(chunk.value);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return Object.freeze({ text, sha256: hasher.digest("hex"), byteLength: size });
  } finally {
    reader.releaseLock();
  }
}

/** Detects a separately installed executable without a shell or installation side effect. */
export async function probeExternalTool(options: {
  readonly tool: string;
  readonly executable?: string | null;
  readonly versionArguments?: readonly string[];
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  readonly executableBytesLimit?: number;
  readonly signal?: AbortSignal;
  /** Exact minimal environment for tools that require a private HOME. */
  readonly env?: Readonly<Record<string, string>>;
  /** @internal Deterministic path-replacement test hook after the executable handle is opened. */
  readonly afterExecutableOpen?: (resolvedPath: string) => void | Promise<void>;
}): Promise<Readonly<ExternalToolProbe>> {
  requireSupportedBunRuntime();
  const executable = options.executable === null
    ? null
    : options.executable ?? Bun.which(options.tool);
  if (executable === null) {
    return Object.freeze({
      tool: options.tool,
      state: "unavailable" as const,
      reason: `${options.tool} was not found on PATH; PCBoo does not install external tools`,
    });
  }
  if (executable.includes("\0")) throw new TypeError("Executable path cannot contain NUL");

  let resolvedExecutable: string;
  let executableSha256: string;
  try {
    resolvedExecutable = await realpath(executable);
    const executableStat = await lstat(resolvedExecutable);
    if (!executableStat.isFile()) {
      throw new Error("resolved executable is not a regular file");
    }
    const executableBytesLimit = options.executableBytesLimit ?? EXTERNAL_TOOL_EXECUTABLE_BYTES_LIMIT;
    await access(resolvedExecutable, constants.X_OK);
    executableSha256 = await hashBoundedRegularFile(
      resolvedExecutable,
      executableBytesLimit,
      options.afterExecutableOpen === undefined
        ? undefined
        : () => options.afterExecutableOpen!(resolvedExecutable),
    );
  } catch (error) {
    return Object.freeze({
      tool: options.tool,
      state: "unavailable" as const,
      executable,
      reason: `Executable identity failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let subprocess: Readonly<ContainedProcess>;
  try {
    subprocess = await spawnContainedProcess({
      command: [resolvedExecutable, ...(options.versionArguments ?? ["--version"])],
      env: options.env ?? { PATH: process.env.PATH ?? "" },
    });
  } catch (error) {
    return Object.freeze({
      tool: options.tool,
      state: "unavailable" as const,
      executable: resolvedExecutable,
      executableSha256,
      reason: `Version probe could not start: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const onAbort = () => {
    cancelled = true;
    subprocess.terminate();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (cancelled) subprocess.terminate();
  const timer = setTimeout(() => {
    timedOut = true;
    subprocess.terminate();
  }, options.timeoutMs ?? EXTERNAL_TOOL_PROBE_TIMEOUT_MS);
  try {
    const terminate = () => subprocess.terminate();
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      readBounded(subprocess.stdout, options.outputLimit ?? EXTERNAL_TOOL_PROBE_OUTPUT_LIMIT, terminate),
      readBounded(subprocess.stderr, options.outputLimit ?? EXTERNAL_TOOL_PROBE_OUTPUT_LIMIT, terminate),
    ]);
    const versionOutput = `${stdout.text}\n${stderr.text}`.trim().slice(0, 4_096);
    const outputIdentity = {
      stdoutSha256: stdout.sha256,
      stderrSha256: stderr.sha256,
      stdoutByteLength: stdout.byteLength,
      stderrByteLength: stderr.byteLength,
    } as const;
    if (cancelled) throw new Error(`${options.tool} version probe was cancelled`);
    if (timedOut) {
      return Object.freeze({
        tool: options.tool,
        state: "unavailable" as const,
        executable: resolvedExecutable,
        executableSha256,
        ...outputIdentity,
        reason: `Version probe exceeded ${options.timeoutMs ?? EXTERNAL_TOOL_PROBE_TIMEOUT_MS} ms`,
      });
    }
    if (exitCode !== 0 || versionOutput === "") {
      return Object.freeze({
        tool: options.tool,
        state: "unavailable" as const,
        executable: resolvedExecutable,
        executableSha256,
        ...outputIdentity,
        reason: `Version probe exited ${exitCode}${versionOutput ? "; untrusted tool output is not echoed" : ""}`,
      });
    }
    const finalExecutableSha256 = await hashBoundedRegularFile(
      resolvedExecutable,
      options.executableBytesLimit ?? EXTERNAL_TOOL_EXECUTABLE_BYTES_LIMIT,
    );
    if (finalExecutableSha256 !== executableSha256) throw new Error(`${options.tool} executable changed during version probe`);
    return Object.freeze({
      tool: options.tool,
      state: "detected" as const,
      executable: resolvedExecutable,
      executableSha256,
      versionOutput,
      ...outputIdentity,
    });
  } catch (error) {
    subprocess.terminate();
    if (cancelled) throw new Error(`${options.tool} version probe was cancelled`);
    return Object.freeze({
      tool: options.tool,
      state: "unavailable" as const,
      executable: resolvedExecutable,
      executableSha256,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Parses only output that identifies the probed product as ngspice. */
export function parseNgspiceVersionOutput(output: string): string | null {
  const match = /(?:^|\s)ngspice(?:[-\s]+)(\d+(?:\.\d+)*)(?=\s|$)/im.exec(output);
  return match?.[1] ?? null;
}

export function isSupportedNgspiceVersion(version: string): boolean {
  const major = Number(version.split(".")[0]);
  return Number.isSafeInteger(major) && major >= NGSPICE_MIN_MAJOR && major <= NGSPICE_MAX_MAJOR;
}

/** Detects a real ngspice executable rather than accepting arbitrary successful output. */
export async function probeNgspice(options: {
  readonly executable?: string | null;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  readonly signal?: AbortSignal;
} = {}): Promise<Readonly<ExternalToolProbe>> {
  const probe = await probeExternalTool({
    tool: "ngspice",
    executableBytesLimit: NGSPICE_EXECUTABLE_BYTES_LIMIT,
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.outputLimit === undefined ? {} : { outputLimit: options.outputLimit }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (probe.state === "unavailable") return probe;
  const version = parseNgspiceVersionOutput(probe.versionOutput ?? "");
  if (version === null) {
    return Object.freeze({
      ...probe,
      state: "unavailable" as const,
      reason: "Version probe output did not identify the executable as ngspice",
    });
  }
  if (!isSupportedNgspiceVersion(version)) {
    return Object.freeze({
      ...probe,
      state: "unavailable" as const,
      version,
      reason: `ngspice ${version} is outside PCBoo's detected compatibility range ${NGSPICE_MIN_MAJOR}-${NGSPICE_MAX_MAJOR}`,
    });
  }
  return Object.freeze({ ...probe, version });
}
