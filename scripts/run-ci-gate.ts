#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireSupportedBunRuntime } from "../src/runtime";
import {
  REGULAR_CI_GATE_NAMES,
  regularTestShardFiles,
  type RegularCiGateName,
} from "./regular-test-shards";

export { HEAVY_TEST_FILES, REGULAR_CI_GATE_NAMES } from "./regular-test-shards";

export const CI_GATE_NAMES = Object.freeze([
  "typecheck",
  ...REGULAR_CI_GATE_NAMES,
  "cli-integration",
  "accept-tscircuit-upgrade",
  "artifact-manifest",
  "manufacturing-properties",
  "semantic-properties",
  "manufacturing-verify",
  "production-promotion",
  "scaffold",
  "server",
  "ngspice-live",
  "performance",
  "packed-e2e",
] as const);

export type CiGateName = typeof CI_GATE_NAMES[number];

const repositoryRoot = join(import.meta.dir, "..");
const windowsJobRunner = join(import.meta.dir, "..", "src", "internal", "windows-job-runner.ps1");

function bunCommand(arguments_: readonly string[]): readonly string[] {
  return Object.freeze([
    process.execPath,
    ...(process.platform === "win32" ? [] : ["--no-orphans"]),
    ...arguments_,
  ]);
}

function bunTestCommand(paths: readonly string[]): readonly string[] {
  return bunCommand([join(repositoryRoot, "scripts", "run-repository-test-gate.ts"), ...paths]);
}

export async function ciGateCommand(name: CiGateName): Promise<readonly string[]> {
  if (name === "typecheck") {
    return bunCommand([
      join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
    ]);
  }
  if (REGULAR_CI_GATE_NAMES.includes(name as RegularCiGateName)) {
    return bunTestCommand(await regularTestShardFiles(name as RegularCiGateName));
  }
  if (name === "packed-e2e") {
    return bunCommand([join(repositoryRoot, "scripts", "packed-e2e.ts")]);
  }
  if (name === "cli-integration") {
    return bunCommand([join(repositoryRoot, "scripts", "run-cli-test-partitions.ts")]);
  }
  if (name === "performance") {
    return bunCommand([join(repositoryRoot, "scripts", "performance-qualification.ts")]);
  }
  return bunTestCommand([`./test/${name}.test.ts`]);
}

function parseGateName(value: string | undefined): CiGateName {
  if (!CI_GATE_NAMES.includes(value as CiGateName)) {
    throw new TypeError(`Expected one CI gate: ${CI_GATE_NAMES.join(", ")}`);
  }
  return value as CiGateName;
}

interface ProcessSnapshotEntry {
  readonly parentPid: number;
  readonly processGroupId: number | undefined;
  readonly rssBytes: number;
  readonly startIdentity: string;
}

function processSnapshot(): ReadonlyMap<number, ProcessSnapshotEntry> {
  const command = process.platform === "win32"
    ? [
        Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.CreationDate.ToUniversalTime().Ticks)" }',
      ]
    : [Bun.which("ps") ?? "/bin/ps", "-axo", "pid=,ppid=,pgid=,rss=,lstart="];
  const snapshot = Bun.spawnSync({
    cmd: command,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (snapshot.exitCode !== 0) {
    throw new Error(
      `CI_GATE_PROCESS_GRAPH_UNAVAILABLE: ${new TextDecoder().decode(snapshot.stderr).trim()}`,
    );
  }
  const graph = new Map<number, ProcessSnapshotEntry>();
  for (const line of new TextDecoder().decode(snapshot.stdout).split(/\r?\n/u)) {
    const match = process.platform === "win32"
      ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line)
      : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = process.platform === "win32" ? undefined : Number(match[3]);
    const rssBytes = Number(match[process.platform === "win32" ? 3 : 4]) *
      (process.platform === "win32" ? 1 : 1024);
    const startIdentity = match[process.platform === "win32" ? 4 : 5] ?? "";
    if (
      Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid) && pid > 0 &&
      Number.isSafeInteger(rssBytes) && rssBytes >= 0 &&
      (processGroupId === undefined || Number.isSafeInteger(processGroupId)) &&
      startIdentity.length > 0
    ) {
      graph.set(pid, { parentPid, processGroupId, rssBytes, startIdentity });
    }
  }
  if (graph.size === 0) {
    throw new Error("CI_GATE_PROCESS_GRAPH_UNAVAILABLE: process graph was empty");
  }
  return graph;
}

async function processesWithContainmentToken(token: string): Promise<readonly number[]> {
  if (process.platform === "darwin") {
    const snapshot = Bun.spawnSync({
      cmd: [Bun.which("ps") ?? "/bin/ps", "eww", "-axo", "pid=,command="],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (snapshot.exitCode !== 0) {
      throw new Error(
        `CI_GATE_PROCESS_ENVIRONMENT_UNAVAILABLE: ${new TextDecoder().decode(snapshot.stderr).trim()}`,
      );
    }
    const marker = `FULMETRY_CI_CONTAINMENT_TOKEN=${token}`;
    return Object.freeze(new TextDecoder().decode(snapshot.stdout)
      .split(/\r?\n/u)
      .flatMap((line) => {
        if (!line.includes(marker)) return [];
        const match = /^\s*(\d+)\s/u.exec(line);
        return match === null ? [] : [Number(match[1])];
      })
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1));
  }
  if (process.platform === "linux") {
    const marker = new TextEncoder().encode(`FULMETRY_CI_CONTAINMENT_TOKEN=${token}`);
    const matches: number[] = [];
    for await (const entry of await opendir("/proc")) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        const environment = await readFile(`/proc/${entry.name}/environ`);
        outer: for (let offset = 0; offset <= environment.byteLength - marker.byteLength; offset += 1) {
          for (let index = 0; index < marker.byteLength; index += 1) {
            if (environment[offset + index] !== marker[index]) continue outer;
          }
          const before = offset === 0 || environment[offset - 1] === 0;
          const afterIndex = offset + marker.byteLength;
          const after = afterIndex === environment.byteLength || environment[afterIndex] === 0;
          if (before && after) {
            matches.push(pid);
            break;
          }
        }
      } catch {
        // Processes may exit or deny inspection between /proc enumeration and read.
      }
    }
    return Object.freeze(matches.sort((a, b) => a - b));
  }
  return Object.freeze([]);
}

function descendantsOf(
  graph: ReadonlyMap<number, ProcessSnapshotEntry>,
  rootPid: number,
): readonly number[] {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, entry] of graph) {
      if (
        pid !== rootPid && !descendants.has(pid) &&
        (entry.parentPid === rootPid || descendants.has(entry.parentPid))
      ) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return Object.freeze([...descendants].sort((a, b) => a - b));
}

function treeRssBytes(
  graph: ReadonlyMap<number, ProcessSnapshotEntry>,
  rootPid: number,
  descendants: readonly number[],
): number {
  return [rootPid, ...descendants].reduce(
    (total, pid) => total + (graph.get(pid)?.rssBytes ?? 0),
    0,
  );
}

function nonnegativeMetric(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`CI_GATE_RESOURCE_USAGE_INVALID: ${label}`);
  }
  return numeric;
}

interface WindowsProcessIdentity {
  readonly pid: number;
  readonly startTimeUtcTicks: string;
}

interface WindowsJobResult {
  readonly containmentApplied: boolean;
  readonly childExitCode: number;
  readonly peakJobMemoryBytes: number;
  readonly orphanProcesses: readonly WindowsProcessIdentity[];
  readonly survivorProcesses: readonly WindowsProcessIdentity[];
  readonly error?: string;
}

interface PreparedCommand {
  readonly command: readonly string[];
  readonly resultPath?: string;
  readonly temporaryDirectory?: string;
}

async function prepareCommand(command: readonly string[]): Promise<PreparedCommand> {
  if (process.platform !== "win32") return { command };
  const powershell = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe";
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "fulmetry-ci-job-"));
  const resultPath = join(temporaryDirectory, "result.json");
  const payload = Buffer.from(JSON.stringify({
    executable: command[0],
    arguments: command.slice(1),
    workingDirectory: repositoryRoot,
    resultPath,
  }), "utf8").toString("base64");
  return {
    command: Object.freeze([
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsJobRunner,
      "-Payload",
      payload,
    ]),
    resultPath,
    temporaryDirectory,
  };
}

async function readWindowsJobResult(path: string | undefined): Promise<WindowsJobResult> {
  if (path === undefined) {
    throw new Error("CI_GATE_PROCESS_CONTAINMENT_UNAVAILABLE: Windows result path missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(path, "utf8")).trim());
  } catch (error) {
    throw new Error(
      `CI_GATE_PROCESS_CONTAINMENT_UNAVAILABLE: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("CI_GATE_PROCESS_CONTAINMENT_UNAVAILABLE: invalid Windows result");
  }
  const candidate = parsed as Partial<WindowsJobResult>;
  if (
    candidate.containmentApplied !== true ||
    (typeof candidate.error === "string" && candidate.error.length > 0) ||
    !Number.isSafeInteger(candidate.childExitCode) ||
    !Number.isSafeInteger(candidate.peakJobMemoryBytes) ||
    !Array.isArray(candidate.orphanProcesses) ||
    !Array.isArray(candidate.survivorProcesses)
  ) {
    throw new Error(
      `CI_GATE_PROCESS_CONTAINMENT_UNAVAILABLE: ${candidate.error ?? "invalid Windows job record"}`,
    );
  }
  return candidate as WindowsJobResult;
}

function terminatePosixContainment(rootPid: number, extraPids: readonly number[] = []): void {
  try {
    process.kill(-rootPid, "SIGKILL");
  } catch {
    // The dedicated process group may already be empty.
  }
  for (const pid of extraPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // An escaped descendant may exit between the snapshot and cleanup.
    }
  }
}

function currentlyMatchingProcessIdentities(
  identities: ReadonlyMap<number, string>,
): readonly number[] {
  try {
    const snapshot = processSnapshot();
    return Object.freeze([...identities]
      .filter(([pid, startIdentity]) => snapshot.get(pid)?.startIdentity === startIdentity)
      .map(([pid]) => pid));
  } catch {
    // Group cleanup remains safe. Never kill an unverified numeric PID.
    return Object.freeze([]);
  }
}

async function waitForExactPosixProcessesToExit(
  identities: ReadonlyMap<number, string>,
): Promise<readonly number[]> {
  const deadline = Date.now() + 5_000;
  let survivors: readonly number[] = Object.freeze([...identities.keys()]);
  while (survivors.length > 0 && Date.now() < deadline) {
    await Bun.sleep(25);
    const snapshot = processSnapshot();
    survivors = Object.freeze([...identities]
      .filter(([pid, startIdentity]) => snapshot.get(pid)?.startIdentity === startIdentity)
      .map(([pid]) => pid));
  }
  return survivors;
}

export interface CiGateRecord {
  readonly schemaVersion: 1;
  readonly gate: string;
  readonly command: readonly string[];
  readonly containment: "best-effort-posix-process-group+sampled-ancestry+inherited-token" | "windows-job-object";
  readonly orphanDetectionCoverage: "observed-or-token-retaining-descendants" | "kernel-job-membership";
  readonly exitCode: number;
  readonly elapsedMilliseconds: number;
  readonly deadlineMilliseconds: number | null;
  readonly timedOut: boolean;
  readonly directProcessMaxRssBytes: number;
  readonly sampledProcessTreePeakRssBytes: number;
  readonly swapCount: number;
  readonly cpuMicroseconds: number;
  readonly observedDescendantCount: number;
  readonly orphanPids: readonly number[];
}

interface SupervisorOptions {
  /** @internal Makes the containment regression stricter; production never sets this. */
  readonly initialSampleDelayMilliseconds?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly onStarted?: () => void;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function superviseCiCommand(
  gate: string,
  command: readonly string[],
  options: SupervisorOptions = {},
): Promise<CiGateRecord> {
  if (command.length === 0 || command[0] === undefined) {
    throw new TypeError("CI_GATE_COMMAND_INVALID");
  }
  if (signalIsAborted(options.signal)) throw new Error("CI_GATE_CANCELLED");
  if (
    options.timeoutMilliseconds !== undefined &&
    (!Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1_000 ||
      options.timeoutMilliseconds > 2 * 60 * 60_000)
  ) throw new TypeError("CI_GATE_TIMEOUT_INVALID");
  const prepared = await prepareCommand(command);
  if (signalIsAborted(options.signal)) {
    if (prepared.temporaryDirectory !== undefined) {
      await rm(prepared.temporaryDirectory, { recursive: true, force: true });
    }
    throw new Error("CI_GATE_CANCELLED");
  }
  const containmentToken = crypto.randomUUID();
  const startedAt = performance.now();
  const child = Bun.spawn([...prepared.command], {
    cwd: repositoryRoot,
    env: { ...process.env, FULMETRY_CI_CONTAINMENT_TOKEN: containmentToken },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: process.platform !== "win32",
  });
  const observedDescendants = new Map<number, string>();
  const observedDescendantIdentities = new Set<string>();
  let sampledProcessTreePeakRssBytes = 0;
  let settled = false;
  let timedOut = false;
  const exitPromise = child.exited.then((exitCode) => {
    settled = true;
    return exitCode;
  });
  const forwardSignal = () => {
    if (process.platform === "win32") child.kill("SIGKILL");
    else terminatePosixContainment(
      child.pid,
      currentlyMatchingProcessIdentities(observedDescendants),
    );
  };
  const deadlineTimer = options.timeoutMilliseconds === undefined
    ? undefined
    : setTimeout(() => { timedOut = true; forwardSignal(); }, options.timeoutMilliseconds);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  options.signal?.addEventListener("abort", forwardSignal, { once: true });
  try {
    options.onStarted?.();
    if (signalIsAborted(options.signal)) forwardSignal();
    if ((options.initialSampleDelayMilliseconds ?? 0) > 0) {
      await Bun.sleep(options.initialSampleDelayMilliseconds!);
    }
    while (!settled) {
      const graph = processSnapshot();
      for (const [pid, startIdentity] of observedDescendants) {
        if (graph.get(pid)?.startIdentity !== startIdentity) observedDescendants.delete(pid);
      }
      const descendants = descendantsOf(graph, child.pid);
      for (const pid of descendants) {
        const startIdentity = graph.get(pid)?.startIdentity;
        if (startIdentity !== undefined) {
          observedDescendants.set(pid, startIdentity);
          observedDescendantIdentities.add(`${pid}\0${startIdentity}`);
        }
      }
      sampledProcessTreePeakRssBytes = Math.max(
        sampledProcessTreePeakRssBytes,
        treeRssBytes(graph, child.pid, descendants),
      );
      await Bun.sleep(process.platform === "win32" ? 250 : 100);
    }
    const wrapperExitCode = await exitPromise;
    await Bun.sleep(100);
    const after = processSnapshot();
    let exitCode = wrapperExitCode;
    let orphanPids: readonly number[];
    let containment: CiGateRecord["containment"];
    let orphanDetectionCoverage: CiGateRecord["orphanDetectionCoverage"];
    let authoritativePeakRssBytes = 0;

    if (process.platform === "win32") {
      const result = await readWindowsJobResult(prepared.resultPath);
      exitCode = result.childExitCode;
      authoritativePeakRssBytes = nonnegativeMetric(
        result.peakJobMemoryBytes,
        "peakJobMemoryBytes",
      );
      orphanPids = Object.freeze(result.orphanProcesses.map(({ pid }) => pid));
      containment = "windows-job-object";
      orphanDetectionCoverage = "kernel-job-membership";
      if (result.survivorProcesses.length > 0) {
        throw new Error(
          `CI_GATE_PROCESS_CONTAINMENT_FAILED: ${result.survivorProcesses
            .map(({ pid, startTimeUtcTicks }) => `${pid}:${startTimeUtcTicks}`)
            .join(",")}`,
        );
      }
    } else {
      const groupMembers = [...after]
        .filter(([pid, entry]) => pid !== child.pid && entry.processGroupId === child.pid)
        .map(([pid]) => pid);
      const escapedObserved = [...observedDescendants]
        .filter(([pid, startIdentity]) => after.get(pid)?.startIdentity === startIdentity)
        .map(([pid]) => pid);
      const tokenProcesses = await processesWithContainmentToken(containmentToken);
      orphanPids = Object.freeze([...new Set([
        ...groupMembers,
        ...escapedObserved,
        ...tokenProcesses.filter((pid) => after.has(pid)),
      ])].sort(
        (a, b) => a - b,
      ));
      containment = "best-effort-posix-process-group+sampled-ancestry+inherited-token";
      orphanDetectionCoverage = "observed-or-token-retaining-descendants";
    }

    const usage = child.resourceUsage();
    if (usage === undefined) throw new Error("CI_GATE_RESOURCE_USAGE_UNAVAILABLE");
    const directProcessMaxRssBytes = nonnegativeMetric(usage.maxRSS, "maxRSS");
    if (orphanPids.length > 0) {
      if (process.platform !== "win32") {
        const orphanIdentities = new Map(orphanPids.flatMap((pid) => {
          const startIdentity = after.get(pid)?.startIdentity;
          return startIdentity === undefined ? [] : [[pid, startIdentity] as const];
        }));
        terminatePosixContainment(
          child.pid,
          currentlyMatchingProcessIdentities(orphanIdentities),
        );
        const survivors = await waitForExactPosixProcessesToExit(orphanIdentities);
        if (survivors.length > 0) {
          throw new Error(`CI_GATE_PROCESS_CONTAINMENT_FAILED: ${survivors.join(",")}`);
        }
      }
      throw new Error(`CI_GATE_ORPHANED_PROCESS: ${orphanPids.join(",")}`);
    }
    return Object.freeze({
      schemaVersion: 1,
      gate,
      command: Object.freeze([...command]),
      containment,
      orphanDetectionCoverage,
      exitCode,
      elapsedMilliseconds: Math.round(performance.now() - startedAt),
      deadlineMilliseconds: options.timeoutMilliseconds ?? null,
      timedOut,
      directProcessMaxRssBytes,
      sampledProcessTreePeakRssBytes: Math.max(
        sampledProcessTreePeakRssBytes,
        directProcessMaxRssBytes,
        authoritativePeakRssBytes,
      ),
      swapCount: nonnegativeMetric(usage.swapCount, "swapCount"),
      cpuMicroseconds: nonnegativeMetric(usage.cpuTime.total, "cpuTime.total"),
      observedDescendantCount: observedDescendantIdentities.size,
      orphanPids,
    });
  } catch (error) {
    if (!settled) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else terminatePosixContainment(
        child.pid,
        currentlyMatchingProcessIdentities(observedDescendants),
      );
      await child.exited.catch(() => undefined);
    }
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
    options.signal?.removeEventListener("abort", forwardSignal);
    if (prepared.temporaryDirectory !== undefined) {
      await rm(prepared.temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export async function runCiGate(name: CiGateName): Promise<number> {
  requireSupportedBunRuntime();
  const deadlineMilliseconds = name === "cli-integration" ? 50 * 60_000 : 20 * 60_000;
  const record = await superviseCiCommand(name, await ciGateCommand(name), {
    timeoutMilliseconds: deadlineMilliseconds,
  });
  if (name === "ngspice-live" && process.env.FULMETRY_LIVE_NGSPICE_REQUIRED === "1") {
    const directory = join(
      repositoryRoot,
      ".fulmetry-ci",
      `ngspice-live-${process.platform}-${process.arch}`,
    );
    await mkdir(directory, { recursive: true });
    const bytes = `${JSON.stringify({
      ...record,
      requirement: "F: required live ngspice and functional production release",
    }, null, 2)}\n`;
    await writeFile(join(directory, "gate.json"), bytes, { flag: "wx" });
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "gate.sha256"), `sha256:${digest}  gate.json\n`, { flag: "wx" });
  }
  process.stdout.write(`FULMETRY_CI_GATE ${JSON.stringify(record)}\n`);
  return record.timedOut ? 1 : record.exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await runCiGate(parseGateName(process.argv[2]));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
