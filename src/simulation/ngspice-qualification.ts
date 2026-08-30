// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { chmod, lstat, mkdir, opendir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { NGSPICE_EXECUTABLE_BYTES_LIMIT, type ExternalToolProbe } from "../external-tools";
import { hashBoundedRegularFile, readBoundedRegularFile } from "../internal/bounded-file";
import { throwIfFulmetryCancelled } from "../internal/cancellation";
import { spawnContainedProcess } from "../internal/contained-process";
import {
  isNgspiceDcSweepAxisName,
  isNgspiceFrequencyAxisName,
  isSemanticallyRealFrequencySample,
  parseNgspiceRawVariableDeclaration,
} from "./ngspice-raw-variable";

export const NGSPICE_QUALIFIER_VERSION = "2";
export const NGSPICE_QUALIFICATION_CASE_TIMEOUT_MS = 2_000;
export const NGSPICE_QUALIFICATION_TOTAL_TIMEOUT_MS = 10_000;
export const NGSPICE_QUALIFICATION_RAW_LIMIT = 1024 * 1024;
export const NGSPICE_QUALIFICATION_STDIO_LIMIT = 256 * 1024;

interface QualificationSample {
  readonly real: number;
  readonly imaginary: number;
}

interface ParsedQualificationRaw {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, readonly QualificationSample[]>>;
}

export interface NgspiceQualificationCaseEvidence {
  readonly id: "operating-point" | "rc-transient" | "rc-ac" | "dc-sweep";
  readonly analysis: "operating-point" | "transient" | "ac" | "dc-sweep";
  readonly deckSha256: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutSha256?: string;
  readonly stdoutBytes?: number;
  readonly stderrSha256?: string;
  readonly stderrBytes?: number;
  readonly rawSha256?: string;
  readonly rawBytes?: number;
  readonly parsedSha256?: string;
  readonly measurements?: readonly number[];
  readonly status: "passed" | "failed";
  readonly failure?: string;
}

export interface NgspiceQualificationEvidence {
  readonly schemaVersion: 1;
  readonly qualifier: {
    readonly name: "fulmetry-ngspice-behavioral-qualification";
    readonly version: typeof NGSPICE_QUALIFIER_VERSION;
    readonly implementationSha256: string;
  };
  readonly host: {
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly bunVersion: string;
  };
  readonly tool: {
    readonly name: "ngspice";
    readonly version: string;
    readonly executableSha256: string;
    readonly probeStdoutSha256: string;
    readonly probeStdoutBytes: number;
    readonly probeStderrSha256: string;
    readonly probeStderrBytes: number;
  };
  readonly limits: {
    readonly caseTimeoutMs: typeof NGSPICE_QUALIFICATION_CASE_TIMEOUT_MS;
    readonly totalTimeoutMs: typeof NGSPICE_QUALIFICATION_TOTAL_TIMEOUT_MS;
    readonly rawBytes: typeof NGSPICE_QUALIFICATION_RAW_LIMIT;
    readonly stdioBytes: typeof NGSPICE_QUALIFICATION_STDIO_LIMIT;
    readonly caseCount: 4;
  };
  readonly cases: readonly NgspiceQualificationCaseEvidence[];
  readonly qualified: boolean;
}

export interface IssuedNgspiceQualification {
  readonly evidence: Readonly<NgspiceQualificationEvidence>;
  readonly evidenceBytes: Uint8Array;
  readonly sha256: string;
}

interface QualificationCase {
  readonly id: NgspiceQualificationCaseEvidence["id"];
  readonly analysis: NgspiceQualificationCaseEvidence["analysis"];
  readonly deck: string;
}

const CASES: readonly QualificationCase[] = Object.freeze([
  Object.freeze({
    id: "operating-point" as const,
    analysis: "operating-point" as const,
    deck: [
      "* Fulmetry operating-point qualification",
      ".options filetype=ascii",
      "V1 vin 0 5",
      "R1 vin out 10k",
      "R2 out 0 10k",
      ".save v(out)",
      ".op",
      ".end",
      "",
    ].join("\n"),
  }),
  Object.freeze({
    id: "rc-transient" as const,
    analysis: "transient" as const,
    deck: [
      "* Fulmetry transient qualification",
      ".options filetype=ascii",
      "V1 vin 0 PULSE(0 5 0 1n 1n 5m 10m)",
      "R1 vin out 1k",
      "C1 out 0 1u",
      ".save v(out)",
      ".tran 100u 12m 0",
      ".end",
      "",
    ].join("\n"),
  }),
  Object.freeze({
    id: "rc-ac" as const,
    analysis: "ac" as const,
    deck: [
      "* Fulmetry AC qualification",
      ".options filetype=ascii",
      "V1 vin 0 DC 0 AC 1 0",
      "R1 vin out 1591.5494309189535",
      "C1 out 0 1u",
      ".save v(out)",
      ".ac dec 1 10 1000",
      ".end",
      "",
    ].join("\n"),
  }),
  Object.freeze({
    id: "dc-sweep" as const,
    analysis: "dc-sweep" as const,
    deck: [
      "* Fulmetry DC-sweep qualification",
      ".options filetype=ascii",
      "V1 vin 0 1",
      "R1 vin out 10k",
      "R2 out 0 10k",
      ".save v(out)",
      ".dc V1 1 5 1",
      ".end",
      "",
    ].join("\n"),
  }),
]);

const ISSUED_QUALIFICATIONS = new WeakSet<object>();
const PRISTINE_WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const PRISTINE_WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;

function sha256(value: Uint8Array | string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

const QUALIFIER_IMPLEMENTATION_SHA256 = sha256(JSON.stringify({
  cases: CASES,
  oracle: "op-divider-5v-half;rc-1k-1u-charge-discharge;rc-100hz-lowpass-mag-phase;dc-divider-half-v1",
  parser: "fulmetry-ngspice-ascii-raw-v2",
}));

function boundedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return new TextDecoder().decode(new TextEncoder().encode(message).subarray(0, 1_024));
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  terminate: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > NGSPICE_QUALIFICATION_STDIO_LIMIT) {
        terminate();
        throw new Error(
          `Qualification stdio exceeded ${NGSPICE_QUALIFICATION_STDIO_LIMIT} bytes`,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function rawNumber(value: string): QualificationSample {
  const parts = value.replace(/^\(/u, "").replace(/\)$/u, "").split(",");
  if (parts.length > 2) throw new Error("Qualification raw sample is malformed");
  const real = Number(parts[0]);
  const imaginary = parts.length === 2 ? Number(parts[1]) : 0;
  if (!Number.isFinite(real) || !Number.isFinite(imaginary)) {
    throw new Error("Qualification raw sample is non-finite");
  }
  return Object.freeze({ real, imaginary });
}

function parseRaw(bytes: Uint8Array): ParsedQualificationRaw {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Qualification raw output is not UTF-8 ASCII");
  }
  if (text.includes("\0") || /(?:^|\n)Binary:/iu.test(text)) {
    throw new Error("Qualification raw output is binary");
  }
  const lines = text.split(/\r?\n/u);
  const variablesAt = lines.findIndex((line) => line.trim() === "Variables:");
  const valuesAt = lines.findIndex((line) => line.trim() === "Values:");
  if (variablesAt < 0 || valuesAt <= variablesAt) {
    throw new Error("Qualification raw output lacks Variables and Values");
  }
  const header = Object.fromEntries(lines.slice(0, variablesAt).flatMap((line) => {
    const at = line.indexOf(":");
    return at < 0 ? [] : [[line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]];
  }));
  const variableCount = Number(header["no. variables"]);
  const pointCount = Number(header["no. points"]);
  if (
    !Number.isSafeInteger(variableCount) || variableCount < 1 || variableCount > 4 ||
    !Number.isSafeInteger(pointCount) || pointCount < 1 || pointCount > 1_000
  ) throw new Error("Qualification raw cardinality is invalid");
  const variables = lines.slice(variablesAt + 1, valuesAt)
    .filter((line) => line.trim())
    .map((line) => parseNgspiceRawVariableDeclaration(
      line,
      "Qualification raw variable is malformed",
    ))
    .map(({ index, name, type, grid }) => ({ index, name: name.toLowerCase(), type, grid }));
  if (
    variables.length !== variableCount ||
    variables.some(({ index }, position) => index !== position) ||
    new Set(variables.map(({ name }) => name)).size !== variables.length
  ) throw new Error("Qualification raw variables are missing or duplicated");
  for (const variable of variables) {
    const expectedGrid = header.plotname?.toLowerCase() === "ac analysis" &&
      isNgspiceFrequencyAxisName(variable.name) ? 3 : null;
    if (variable.grid !== expectedGrid) {
      throw new Error("Qualification raw variable grid metadata is invalid");
    }
  }
  const rows = lines.slice(valuesAt + 1).filter((line) => line.trim());
  const samples = variables.map(() => [] as QualificationSample[]);
  let row = 0;
  for (let point = 0; point < pointCount; point += 1) {
    for (let variable = 0; variable < variableCount; variable += 1) {
      const tokens = rows[row++]?.trim().split(/\s+/u);
      if (tokens === undefined) throw new Error("Qualification raw output ended early");
      if (variable === 0) {
        if (tokens.length !== 2 || Number(tokens[0]) !== point) {
          throw new Error("Qualification raw point index is invalid");
        }
        samples[variable]!.push(rawNumber(tokens[1]!));
      } else {
        if (tokens.length !== 1) throw new Error("Qualification raw sample row is malformed");
        samples[variable]!.push(rawNumber(tokens[0]!));
      }
    }
  }
  if (row !== rows.length) throw new Error("Qualification raw output has trailing samples");
  return Object.freeze({
    names: Object.freeze(variables.map(({ name }) => name)),
    values: Object.freeze(Object.fromEntries(variables.map(({ name }, index) => [
      name,
      Object.freeze(samples[index]!),
    ]))),
  });
}

function nearest(
  axis: readonly QualificationSample[],
  samples: readonly QualificationSample[],
  target: number,
  maximumDistance: number,
): QualificationSample {
  let best = 0;
  for (let index = 1; index < axis.length; index += 1) {
    if (Math.abs(axis[index]!.real - target) < Math.abs(axis[best]!.real - target)) best = index;
  }
  if (Math.abs(axis[best]!.real - target) > maximumDistance || samples[best] === undefined) {
    throw new Error(`Qualification raw axis does not cover ${target}`);
  }
  return samples[best]!;
}

function close(actual: number, expected: number, tolerance: number, label: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} ${actual} is outside ${expected} ± ${tolerance}`);
  }
}

function validateCase(
  testCase: QualificationCase,
  parsed: ParsedQualificationRaw,
): readonly number[] {
  const out = parsed.values["v(out)"];
  if (out === undefined) throw new Error("Qualification raw output lacks v(out)");
  if (testCase.id === "operating-point") {
    if (parsed.names.length !== 1 || out.length !== 1) {
      throw new Error("Operating-point qualification has unexpected vectors");
    }
    close(out[0]!.real, 2.5, 0.001, "Divider operating point");
    close(out[0]!.imaginary, 0, 1e-12, "Divider imaginary output");
    return Object.freeze([out[0]!.real]);
  }
  const axisName = testCase.id === "rc-transient" ? "time"
    : testCase.id === "rc-ac" ? "frequency"
    : parsed.names.find(isNgspiceDcSweepAxisName) ?? "v-sweep";
  const axis = parsed.values[axisName];
  if (axis === undefined || parsed.names.length !== 2 || axis.length !== out.length) {
    throw new Error(`${testCase.id} qualification has unexpected vectors`);
  }
  if (testCase.id === "rc-ac" && axis.some(({ real, imaginary }) =>
    !isSemanticallyRealFrequencySample(real, imaginary)
  )) throw new Error("RC AC qualification frequency axis is materially complex");
  if (testCase.id === "rc-transient") {
    const at1 = nearest(axis, out, 0.001, 0.000075).real;
    const at4 = nearest(axis, out, 0.004, 0.000075).real;
    const at6 = nearest(axis, out, 0.006, 0.000075).real;
    close(at1, 3.1606, 0.2, "RC charge at 1 ms");
    close(at4, 4.9084, 0.12, "RC charge at 4 ms");
    close(at6, 1.805, 0.2, "RC discharge at 6 ms");
    return Object.freeze([at1, at4, at6]);
  }
  if (testCase.id === "rc-ac") {
    const measurements: number[] = [];
    for (const [frequency, magnitude, phase] of [
      [10, 0.995037, -5.71059],
      [100, 0.707107, -45],
      [1_000, 0.0995037, -84.2894],
    ] as const) {
      const sample = nearest(axis, out, frequency, frequency * 1e-9);
      const actualMagnitude = Math.hypot(sample.real, sample.imaginary);
      const actualPhase = Math.atan2(sample.imaginary, sample.real) * 180 / Math.PI;
      close(actualMagnitude, magnitude, 0.02, `RC AC magnitude at ${frequency} Hz`);
      close(actualPhase, phase, 2, `RC AC phase at ${frequency} Hz`);
      measurements.push(actualMagnitude, actualPhase);
    }
    return Object.freeze(measurements);
  }
  const measurements: number[] = [];
  for (let voltage = 1; voltage <= 5; voltage += 1) {
    const output = nearest(axis, out, voltage, 1e-9).real;
    close(output, voltage / 2, 1e-6, `DC divider output at ${voltage} V`);
    measurements.push(output);
  }
  return Object.freeze(measurements);
}

async function exactCaseTree(directory: string): Promise<void> {
  const expected = new Set(["input.cir", "result.raw", "stdout.bin", "stderr.bin"]);
  const seen = new Set<string>();
  for await (const entry of await opendir(directory)) {
    if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Qualification case produced unexpected entry ${entry.name}`);
    }
    const metadata = await lstat(join(directory, entry.name));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Qualification case entry ${entry.name} is not a regular file`);
    }
    seen.add(entry.name);
  }
  if (seen.size !== expected.size) throw new Error("Qualification case output is incomplete");
}

async function executeCase(options: {
  readonly testCase: QualificationCase;
  readonly executable: string;
  readonly root: string;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}): Promise<Readonly<NgspiceQualificationCaseEvidence>> {
  const { testCase } = options;
  const directory = join(options.root, testCase.id);
  await mkdir(directory);
  const inputPath = join(directory, "input.cir");
  await writeFile(inputPath, testCase.deck, { flag: "wx", mode: 0o400 });
  await chmod(inputPath, 0o400);
  let stdout: Uint8Array | undefined;
  let stderr: Uint8Array | undefined;
  let raw: Uint8Array | undefined;
  let exitCode: number | null = null;
  let timedOut = false;
  try {
    throwIfFulmetryCancelled(options.signal, "ngspice qualification was cancelled");
    if (Date.now() >= options.deadline) throw new Error("ngspice qualification exceeded its aggregate deadline");
    const child = await spawnContainedProcess({
      command: [options.executable, "-n", "-b", "-r", "result.raw", basename(inputPath)],
      cwd: directory,
      env: {
        HOME: directory,
        USERPROFILE: directory,
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory,
        LC_ALL: "C",
        LANG: "C",
        ...(process.env.SYSTEMROOT === undefined ? {} : { SYSTEMROOT: process.env.SYSTEMROOT }),
        ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
      },
    });
    const terminate = () => child.terminate();
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const remaining = Math.max(1, options.deadline - Date.now());
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.min(NGSPICE_QUALIFICATION_CASE_TIMEOUT_MS, remaining));
    const monitor = setInterval(async () => {
      try {
        if ((await stat(join(directory, "result.raw"))).size > NGSPICE_QUALIFICATION_RAW_LIMIT) {
          timedOut = true;
          terminate();
        }
      } catch {
        // The solver may not have created the result yet.
      }
    }, 20);
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        readStream(child.stdout, terminate),
        readStream(child.stderr, terminate),
        child.exited,
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(monitor);
      options.signal?.removeEventListener("abort", onAbort);
      terminate();
    }
    throwIfFulmetryCancelled(options.signal, "ngspice qualification was cancelled");
    await writeFile(join(directory, "stdout.bin"), stdout, { flag: "wx" });
    await writeFile(join(directory, "stderr.bin"), stderr, { flag: "wx" });
    if (timedOut) throw new Error("ngspice qualification case timed out or exceeded its raw limit");
    if (exitCode !== 0) throw new Error(`ngspice qualification case exited ${exitCode}`);
    raw = await readBoundedRegularFile(join(directory, "result.raw"), NGSPICE_QUALIFICATION_RAW_LIMIT);
    const parsed = parseRaw(raw);
    const measurements = validateCase(testCase, parsed);
    await exactCaseTree(directory);
    const parsedSha256 = sha256(JSON.stringify(parsed));
    return Object.freeze({
      id: testCase.id,
      analysis: testCase.analysis,
      deckSha256: sha256(testCase.deck),
      exitCode,
      timedOut: false,
      stdoutSha256: sha256(stdout),
      stdoutBytes: stdout.byteLength,
      stderrSha256: sha256(stderr),
      stderrBytes: stderr.byteLength,
      rawSha256: sha256(raw),
      rawBytes: raw.byteLength,
      parsedSha256,
      measurements,
      status: "passed",
    });
  } catch (error) {
    return Object.freeze({
      id: testCase.id,
      analysis: testCase.analysis,
      deckSha256: sha256(testCase.deck),
      exitCode,
      timedOut,
      ...(stdout === undefined ? {} : {
        stdoutSha256: sha256(stdout),
        stdoutBytes: stdout.byteLength,
      }),
      ...(stderr === undefined ? {} : {
        stderrSha256: sha256(stderr),
        stderrBytes: stderr.byteLength,
      }),
      ...(raw === undefined ? {} : { rawSha256: sha256(raw), rawBytes: raw.byteLength }),
      status: "failed",
      failure: boundedFailure(error),
    });
  }
}

export async function qualifyCapturedNgspice(options: {
  readonly executable: string;
  readonly directory: string;
  readonly tool: Readonly<ExternalToolProbe>;
  readonly signal?: AbortSignal;
  /** Retains exact case decks/raw/stdio for an explicit live-evidence collector. */
  readonly retainCaseArtifacts?: boolean;
}): Promise<Readonly<IssuedNgspiceQualification>> {
  if (
    options.tool.state !== "detected" || options.tool.version === undefined ||
    options.tool.executableSha256 === undefined ||
    options.tool.stdoutSha256 === undefined || options.tool.stdoutByteLength === undefined ||
    options.tool.stderrSha256 === undefined || options.tool.stderrByteLength === undefined
  ) throw new Error("ngspice qualification requires a detected exact executable identity");
  await mkdir(options.directory);
  const assertExecutableIdentity = async (): Promise<void> => {
    const digest = await hashBoundedRegularFile(options.executable, NGSPICE_EXECUTABLE_BYTES_LIMIT);
    if (digest !== options.tool.executableSha256) {
      throw new Error("ngspice executable changed during behavioral qualification");
    }
  };
  await assertExecutableIdentity();
  const deadline = Date.now() + NGSPICE_QUALIFICATION_TOTAL_TIMEOUT_MS;
  const cases: NgspiceQualificationCaseEvidence[] = [];
  try {
    for (const testCase of CASES) {
      await assertExecutableIdentity();
      cases.push(await executeCase({
        testCase,
        executable: options.executable,
        root: options.directory,
        deadline,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
      await assertExecutableIdentity();
      throwIfFulmetryCancelled(options.signal, "ngspice qualification was cancelled");
    }
  } finally {
    if (options.retainCaseArtifacts !== true) {
      await rm(options.directory, { recursive: true, force: true });
    }
  }
  const qualified = cases.length === CASES.length && cases.every(({ status }) => status === "passed");
  const evidence = Object.freeze({
    schemaVersion: 1 as const,
    qualifier: Object.freeze({
      name: "fulmetry-ngspice-behavioral-qualification" as const,
      version: NGSPICE_QUALIFIER_VERSION,
      implementationSha256: QUALIFIER_IMPLEMENTATION_SHA256,
    }),
    host: Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      bunVersion: Bun.version,
    }),
    tool: Object.freeze({
      name: "ngspice" as const,
      version: options.tool.version,
      executableSha256: options.tool.executableSha256,
      probeStdoutSha256: options.tool.stdoutSha256,
      probeStdoutBytes: options.tool.stdoutByteLength,
      probeStderrSha256: options.tool.stderrSha256,
      probeStderrBytes: options.tool.stderrByteLength,
    }),
    limits: Object.freeze({
      caseTimeoutMs: NGSPICE_QUALIFICATION_CASE_TIMEOUT_MS,
      totalTimeoutMs: NGSPICE_QUALIFICATION_TOTAL_TIMEOUT_MS,
      rawBytes: NGSPICE_QUALIFICATION_RAW_LIMIT,
      stdioBytes: NGSPICE_QUALIFICATION_STDIO_LIMIT,
      caseCount: 4 as const,
    }),
    cases: Object.freeze(cases),
    qualified,
  });
  const evidenceBytes = new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`);
  const issued = Object.freeze({ evidence, evidenceBytes, sha256: sha256(evidenceBytes) });
  if (qualified) PRISTINE_WEAK_SET_ADD(ISSUED_QUALIFICATIONS, issued);
  return issued;
}

export function isIssuedNgspiceQualification(
  qualification: Readonly<IssuedNgspiceQualification>,
  tool: Readonly<ExternalToolProbe>,
): boolean {
  return PRISTINE_WEAK_SET_HAS(ISSUED_QUALIFICATIONS, qualification) && qualification.evidence.qualified &&
    qualification.evidence.tool.version === tool.version &&
    qualification.evidence.tool.executableSha256 === tool.executableSha256 &&
    qualification.sha256 === sha256(qualification.evidenceBytes);
}
