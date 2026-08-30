// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { chmod, lstat, mkdir, opendir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  EXTERNAL_TOOL_EXECUTABLE_BYTES_LIMIT,
  probeExternalTool,
  type ExternalToolProbe,
} from "../external-tools";
import { readBoundedRegularFile } from "../internal/bounded-file";
import {
  assertAuthenticKicadHandoff,
  assertAuthenticKicadLiveValidation,
  markAuthenticKicadLiveValidation,
} from "./authority";
import { captureExactFlatKicadFiles } from "./exact-flat-files";
import type { KicadHandoff, KicadHandoffFile, KicadLiveValidation } from "./index";
import { requireSupportedBunRuntime } from "../runtime";
import { spawnContainedProcess } from "../internal/contained-process";
import { parseJsonWithoutDuplicateKeys } from "../upgrade/jsonc";

export const KICAD_LIVE_ADAPTER_VERSION = "1" as const;
export const KICAD_DETECTION_CANDIDATE_MAJORS = Object.freeze([9, 10] as const);
export const KICAD_SUPPORTED_MAJORS = Object.freeze([10] as const);
const PRISTINE_ARRAY_INCLUDES = Function.prototype.call.bind(Array.prototype.includes) as <T>(array: readonly T[], value: T) => boolean;
const KICAD_COMMAND_TIMEOUT_MS = 60_000;
const KICAD_COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const KICAD_QUALIFICATION_FILE_LIMIT = 128;
const KICAD_QUALIFICATION_ENTRY_LIMIT = 256;
const KICAD_QUALIFICATION_DEPTH_LIMIT = 8;
const KICAD_QUALIFICATION_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
const KICAD_QUALIFICATION_TOTAL_BYTES_LIMIT = 256 * 1024 * 1024;
const OFFICIAL_KICAD_APP = "/Applications/KiCad/KiCad.app" as const;
const OFFICIAL_KICAD_CLI = `${OFFICIAL_KICAD_APP}/Contents/MacOS/kicad-cli` as const;
const OFFICIAL_KICAD_TEAM_IDENTIFIER = "9FQDHNY6U2" as const;
const KICAD_REPORT_TEXT_LIMIT = 8 * 1024 * 1024;

type KicadCommandName = "schematic-erc" | "pcb-drc" | "schematic-netlist" | "pcb-gerbers";
type KicadCommandEvidence = NonNullable<KicadLiveValidation["evidence"]>["execution"]["commands"][number];

interface CapturedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface BehavioralOutputContract {
  readonly projectName: string;
  readonly expectedKicadVersion: string;
  readonly semanticCopperLayers: readonly string[];
  readonly semanticComponentReferences: readonly string[];
  readonly semanticSchematicNetNames: readonly string[];
  readonly semanticBoard?: Readonly<{
    widthMm: number;
    heightMm: number;
    kicadCenter: Readonly<{ x: number; y: number }>;
  }>;
}

export interface KicadLiveValidationOptions {
  readonly handoff: Readonly<KicadHandoff>;
  /** Existing Fulmetry run directory. A fresh child is created and never reused. */
  readonly runDirectory: string;
  /** Parent that must contain runDirectory. */
  readonly outputRoot: string;
  /** Project authority used to reject a project-root/source run target. */
  readonly projectRoot?: string;
  /** Required with projectRoot; must resolve exactly to outputRoot. */
  readonly configuredOutputDirectory?: string;
  /** Required with projectRoot; exact authored/config/lock inputs protected from output overlap. */
  readonly protectedInputPaths?: readonly string[];
  /** Digest of the authored source graph captured by the invoking framework. */
  readonly authoredSourceDigest?: string;
  readonly executable?: string | null;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  readonly qualificationCommandTimeoutMs?: number;
  readonly qualificationCommandOutputLimit?: number;
  readonly signal?: AbortSignal;
  /** @internal Race/adversarial test hook. */
  readonly beforeFinalInputSnapshot?: (inputDirectory: string) => void | Promise<void>;
  /** @internal Runs after directory capture but before any KiCad input bytes are written. */
  readonly beforeLiveInputWrite?: (inputDirectory: string) => void | Promise<void>;
  /** @internal Prototype-poisoning test hook. */
  readonly beforeQualificationCheck?: () => void;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

interface LiveDirectoryAuthority {
  readonly output: DirectoryIdentity;
  readonly run: DirectoryIdentity;
  readonly validation: DirectoryIdentity;
  readonly input: DirectoryIdentity;
  readonly expectedFiles: readonly Readonly<CapturedFile>[];
  readonly qualificationOutput?: DirectoryIdentity;
  readonly expectedQualificationOutputs?: readonly Readonly<CapturedFile>[];
}

const LIVE_VALIDATION_DIRECTORY_AUTHORITY = new WeakMap<object, LiveDirectoryAuthority>();
const PRISTINE_WEAKMAP_SET = Function.prototype.call.bind(WeakMap.prototype.set) as <K extends object, V>(map: WeakMap<K, V>, key: K, value: V) => WeakMap<K, V>;
const PRISTINE_WEAKMAP_GET = Function.prototype.call.bind(WeakMap.prototype.get) as <K extends object, V>(map: WeakMap<K, V>, key: K) => V | undefined;

function hexSha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function snapshotHandoff(handoff: Readonly<KicadHandoff>): Readonly<{
  projectName: string;
  circuitDigest: string;
  semanticReconciliationSha256: string;
  semanticReconciliationState: "passed" | "failed";
  semanticCopperLayers: readonly string[];
  semanticComponentReferences: readonly string[];
  semanticSchematicNetNames: readonly string[];
  semanticBoard?: Readonly<{
    widthMm: number;
    heightMm: number;
    kicadCenter: Readonly<{ x: number; y: number }>;
  }>;
  files: readonly Readonly<KicadHandoffFile>[];
}> {
  const projectName = String(handoff.report.projectName);
  const circuitDigest = String(handoff.report.circuitDigest);
  const semanticReconciliationState = handoff.report.semanticReconciliation.state;
  const semanticReconciliationSha256 = String(handoff.report.semanticReconciliation.sha256);
  const semanticCopperLayers = Object.freeze(semanticReconciliationState === "passed"
    ? handoff.report.semanticReconciliation.copperLayers.map(String) : []);
  const semanticComponentReferences = Object.freeze(semanticReconciliationState === "passed"
    ? handoff.report.semanticReconciliation.componentReferences.map(String) : []);
  const semanticSchematicNetNames = Object.freeze(semanticReconciliationState === "passed"
    ? handoff.report.semanticReconciliation.schematicNetNames.map(String) : []);
  const semanticBoard = semanticReconciliationState === "passed"
    ? Object.freeze({
      widthMm: Number(handoff.report.semanticReconciliation.board.widthMm),
      heightMm: Number(handoff.report.semanticReconciliation.board.heightMm),
      kicadCenter: Object.freeze({
        x: Number(handoff.report.semanticReconciliation.board.kicadCenter.x),
        y: Number(handoff.report.semanticReconciliation.board.kicadCenter.y),
      }),
    })
    : undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(projectName)) throw new TypeError("KiCad handoff project name is unsafe");
  if (!/^[a-f0-9]{64}$/u.test(circuitDigest)) throw new TypeError("KiCad handoff circuit digest is invalid");
  if (!/^[a-f0-9]{64}$/u.test(semanticReconciliationSha256)) throw new TypeError("KiCad handoff semantic digest is invalid");
  const expectedPaths = [
    `${projectName}.kicad_pcb`,
    `${projectName}.kicad_pro`,
    `${projectName}.kicad_sch`,
  ].sort();
  const files = handoff.files.map((file) => {
    const path = String(file.path);
    const content = String(file.content);
    const sha256 = String(file.sha256);
    if (path.includes("/") || path.includes("\\") || path === "." || path === ".." || path.includes("\0")) {
      throw new TypeError("KiCad handoff contains an unsafe file path");
    }
    if (sha256 !== hexSha256(content)) throw new TypeError(`KiCad handoff digest mismatch for ${path}`);
    return Object.freeze({ path, content, sha256 });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(files.map(({ path }) => path)) !== JSON.stringify(expectedPaths)) {
    throw new TypeError("KiCad handoff must contain exactly one schematic, board, and project file");
  }
  if (new Set(files.map(({ path }) => path)).size !== files.length) throw new TypeError("KiCad handoff contains duplicate paths");
  return Object.freeze({
    projectName,
    circuitDigest,
    semanticReconciliationSha256,
    semanticReconciliationState,
    semanticCopperLayers,
    semanticComponentReferences,
    semanticSchematicNetNames,
    ...(semanticBoard === undefined ? {} : { semanticBoard }),
    files: Object.freeze(files),
  });
}

function artifactSetDigest(files: readonly CapturedFile[]): string {
  return hexSha256(files.map(({ path, size, sha256 }) => `${path}\0${size}\0${sha256}\n`).join(""));
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  terminate: () => void,
): Promise<Readonly<{ sha256: string; byteLength: number }>> {
  const reader = stream.getReader();
  const hasher = new Bun.CryptoHasher("sha256");
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > limit) {
        terminate();
        throw new Error(`KiCad command output exceeded ${limit} bytes`);
      }
      hasher.update(chunk.value);
    }
    return Object.freeze({ sha256: hasher.digest("hex"), byteLength });
  } finally {
    reader.releaseLock();
  }
}

async function runKicadCommand(options: {
  readonly executable: string;
  readonly name: KicadCommandName;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly home: string;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly signal?: AbortSignal;
}): Promise<Readonly<KicadCommandEvidence>> {
  const process = await spawnContainedProcess({
    command: [options.executable, ...options.arguments],
    cwd: options.cwd,
    denyNetwork: true,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: options.home,
      TMPDIR: options.home,
      LC_ALL: "C",
      LANG: "C",
    },
  });
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  const terminate = () => process.terminate();
  const abort = () => { cancelled = true; terminate(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (cancelled) terminate();
  const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readBoundedStream(process.stdout, options.outputLimit, terminate),
      readBoundedStream(process.stderr, options.outputLimit, terminate),
    ]);
    if (cancelled) throw new Error(`KiCad ${options.name} command was cancelled`);
    if (timedOut) throw new Error(`KiCad ${options.name} command exceeded ${options.timeoutMs} ms`);
    return Object.freeze({
      name: options.name,
      arguments: Object.freeze([...options.arguments]),
      exitCode,
      stdoutSha256: stdout.sha256,
      stderrSha256: stderr.sha256,
      stdoutByteLength: stdout.byteLength,
      stderrByteLength: stderr.byteLength,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    terminate();
  }
}

async function captureQualificationOutputs(root: string): Promise<readonly Readonly<CapturedFile>[]> {
  const output: CapturedFile[] = [];
  let totalBytes = 0;
  let entries = 0;
  const walk = async (directory: string, prefix = "", depth = 0): Promise<void> => {
    if (depth > KICAD_QUALIFICATION_DEPTH_LIMIT) {
      throw new Error(`KiCad qualification output exceeded depth ${KICAD_QUALIFICATION_DEPTH_LIMIT}`);
    }
    const handle = await opendir(directory);
    for await (const entry of handle) {
        entries += 1;
        if (entries > KICAD_QUALIFICATION_ENTRY_LIMIT) {
          throw new Error(`KiCad qualification produced more than ${KICAD_QUALIFICATION_ENTRY_LIMIT} entries`);
        }
        if (output.length >= KICAD_QUALIFICATION_FILE_LIMIT) {
          throw new Error(`KiCad qualification produced more than ${KICAD_QUALIFICATION_FILE_LIMIT} files`);
        }
        if (entry.name.includes("\0") || entry.name === "." || entry.name === "..") {
          throw new Error("KiCad qualification output contains an unsafe name");
        }
        const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const absolute = join(directory, entry.name);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error(`KiCad qualification output is symlinked: ${relativePath}`);
        if (stat.isDirectory()) {
          await walk(absolute, relativePath, depth + 1);
          continue;
        }
        if (!stat.isFile() || stat.size > KICAD_QUALIFICATION_FILE_BYTES_LIMIT) {
          throw new Error(`KiCad qualification output is special or oversized: ${relativePath}`);
        }
        totalBytes += stat.size;
        if (totalBytes > KICAD_QUALIFICATION_TOTAL_BYTES_LIMIT) {
          throw new Error("KiCad qualification output exceeded its aggregate byte limit");
        }
        const bytes = await readBoundedRegularFile(absolute, KICAD_QUALIFICATION_FILE_BYTES_LIMIT);
        output.push(Object.freeze({ path: relativePath, size: bytes.byteLength, sha256: hexSha256(bytes) }));
    }
  };
  await walk(root);
  output.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(output);
}

function gerberPathMatchesLayer(path: string, layer: string): boolean {
  const token = layer.replaceAll(".", "_");
  return path.startsWith("gerbers/") && path.toLowerCase().endsWith(".gbr") &&
    path.includes(`-${token}`);
}

function parseNetlistIdentity(value: string): Readonly<{
  references: ReadonlySet<string>;
  nets: ReadonlySet<string>;
}> {
  const references = new Set<string>();
  const nets = new Set<string>();
  const stack: Array<{ head?: string; firstValue?: string }> = [];
  let rootHead: string | undefined;
  let rootClosed = false;
  let tokens = 0;
  const acceptToken = (token: string): void => {
    tokens += 1;
    if (tokens > 250_000 || token.length > 65_536) throw new Error("KiCad schematic netlist exceeds parser limits");
    const frame = stack[stack.length - 1];
    if (frame === undefined) throw new Error("KiCad schematic netlist contains a token outside its root");
    if (frame.head === undefined) {
      frame.head = token;
      if (stack.length === 1) rootHead = token;
    } else if (frame.firstValue === undefined) {
      frame.firstValue = token;
    }
  };
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    if (/\s/u.test(character)) { index += 1; continue; }
    if (rootClosed) throw new Error("KiCad schematic netlist has trailing content after its root");
    if (character === "(") {
      stack.push({});
      if (stack.length > 64) throw new Error("KiCad schematic netlist exceeds parser depth 64");
      index += 1;
      continue;
    }
    if (character === ")") {
      const frame = stack.pop();
      if (frame === undefined || frame.head === undefined) throw new Error("KiCad schematic netlist has unbalanced or empty expressions");
      if (frame.head === "ref" && frame.firstValue !== undefined) references.add(frame.firstValue);
      if (frame.head === "name" && frame.firstValue !== undefined) nets.add(frame.firstValue);
      if (stack.length === 0) rootClosed = true;
      index += 1;
      continue;
    }
    if (stack.length === 0) throw new Error("KiCad schematic netlist must start with one expression");
    if (character === '"') {
      index += 1;
      let token = "";
      let closed = false;
      while (index < value.length) {
        const item = value[index++]!;
        if (item === '"') { closed = true; break; }
        if (item === "\\") {
          if (index >= value.length) throw new Error("KiCad schematic netlist ends in a string escape");
          token += value[index++]!;
        } else {
          token += item;
        }
        if (token.length > 65_536) throw new Error("KiCad schematic netlist token exceeds 65536 characters");
      }
      if (!closed) throw new Error("KiCad schematic netlist contains an unterminated string");
      acceptToken(token);
      continue;
    }
    const start = index;
    while (index < value.length && !/[\s()]/u.test(value[index]!)) index += 1;
    if (start === index) throw new Error("KiCad schematic netlist contains invalid syntax");
    acceptToken(value.slice(start, index));
  }
  if (!rootClosed || stack.length !== 0 || rootHead !== "export") {
    throw new Error("KiCad schematic netlist is not one exported S-expression");
  }
  return Object.freeze({ references, nets });
}

function parseGerberCommands(text: string, layer: string): readonly string[] {
  const commands: string[] = [];
  let index = 0;
  let terminated = false;
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index]!)) index += 1;
    if (index === text.length) break;
    let command: string;
    if (text[index] === "%") {
      const end = text.indexOf("%", index + 1);
      if (end < 0) throw new Error(`KiCad ${layer} Gerber contains an unterminated extended command`);
      command = text.slice(index, end + 1);
      index = end + 1;
    } else {
      const end = text.indexOf("*", index);
      if (end < 0) throw new Error(`KiCad ${layer} Gerber contains an unterminated command`);
      command = text.slice(index, end + 1);
      index = end + 1;
    }
    commands.push(command);
    if (commands.length > 250_000) throw new Error(`KiCad ${layer} Gerber exceeds its command limit`);
    if (command === "M02*") {
      while (index < text.length && /\s/u.test(text[index]!)) index += 1;
      if (index !== text.length) throw new Error(`KiCad ${layer} Gerber contains commands after M02 termination`);
      terminated = true;
      break;
    }
  }
  if (!terminated) throw new Error(`KiCad ${layer} Gerber lacks terminal M02`);
  return Object.freeze(commands);
}

function requireExactFileFunction(commands: readonly string[], expected: string, layer: string): void {
  const declarations = commands.filter((command) => command.startsWith("%TF.FileFunction"));
  if (declarations.length !== 1 || declarations[0] !== expected) {
    throw new Error(`KiCad ${layer} Gerber must contain exactly one X2 file-function attribute: ${expected}`);
  }
}

function requireCleanKicadRuleReport(
  value: unknown,
  kind: "erc" | "drc",
  contract: BehavioralOutputContract,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`KiCad ${kind} report root is not a JSON object`);
  }
  const report = value as Record<string, unknown>;
  const allowedRootKeys = new Set(kind === "erc"
    ? ["$schema", "source", "date", "kicad_version", "sheets", "coordinate_units", "included_severities", "ignored_checks"]
    : ["$schema", "source", "date", "kicad_version", "violations", "unconnected_items", "schematic_parity", "coordinate_units", "included_severities", "ignored_checks"]);
  if (Object.keys(report).some((key) => !allowedRootKeys.has(key))) {
    throw new Error(`KiCad ${kind} report contains an unknown root property`);
  }
  const date = typeof report.date === "string" ? Date.parse(report.date) : Number.NaN;
  const includedSeverities = report.included_severities;
  const ignoredChecks = report.ignored_checks;
  if (
    report.$schema !== `https://schemas.kicad.org/${kind}.v1.json` ||
    report.coordinate_units !== "mm" ||
    report.source !== `${contract.projectName}.kicad_${kind === "erc" ? "sch" : "pcb"}` ||
    report.kicad_version !== contract.expectedKicadVersion ||
    !/^10\.\d{1,2}\.\d{1,2}$/u.test(contract.expectedKicadVersion) ||
    typeof report.date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(report.date) ||
    !Number.isFinite(date) || !Array.isArray(includedSeverities) ||
    [...includedSeverities].sort().join("\0") !== ["error", "exclusion", "warning"].join("\0") ||
    !Array.isArray(ignoredChecks) || ignoredChecks.length !== 0
  ) throw new Error(`KiCad ${kind} report does not match the qualified KiCad 10 JSON identity`);
  if (kind === "erc") {
    if (!Array.isArray(report.sheets) || report.sheets.length === 0) {
      throw new Error("KiCad erc report omits its non-empty sheets array");
    }
    let rootSheets = 0;
    for (const sheet of report.sheets) {
      if (typeof sheet !== "object" || sheet === null || Array.isArray(sheet)) {
        throw new Error("KiCad erc report contains an invalid sheet");
      }
      const candidate = sheet as Record<string, unknown>;
      if (Object.keys(candidate).sort().join("\0") !== ["path", "uuid_path", "violations"].sort().join("\0")) {
        throw new Error("KiCad erc report contains an unknown sheet property");
      }
      if (typeof candidate.path !== "string" || typeof candidate.uuid_path !== "string" ||
        !Array.isArray(candidate.violations)) throw new Error("KiCad erc report contains an invalid sheet schema");
      if (candidate.path === "/") rootSheets += 1;
      if (!/^(?:\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})+$/u.test(candidate.uuid_path)) {
        throw new Error("KiCad erc report contains an invalid sheet UUID path");
      }
      if (candidate.violations.length !== 0) throw new Error("KiCad erc report contains violations");
    }
    if (rootSheets !== 1) throw new Error("KiCad erc report must contain exactly one root sheet");
    return;
  }
  for (const field of ["violations", "unconnected_items", "schematic_parity"] as const) {
    if (!Array.isArray(report[field])) throw new Error(`KiCad drc report omits its ${field} array`);
    if (report[field].length !== 0) throw new Error(`KiCad drc report contains ${field.replaceAll("_", " ")}`);
  }
}

function requireDrawableGerberGeometry(
  commands: readonly string[],
  layer: string,
  expectedBoard?: BehavioralOutputContract["semanticBoard"],
): void {
  interface Point { readonly x: bigint; readonly y: bigint }
  let x: bigint | undefined;
  let y: bigint | undefined;
  let modalOperation: "draw" | "move" | "flash" | undefined;
  let contour: Point[] = [];
  const contours: Point[][] = [];
  const definedApertures = new Set<number>();
  let selectedAperture: number | undefined;
  let draws = 0;
  let flashes = 0;
  for (const command of commands) {
    if (command.startsWith("%")) {
      if (command.startsWith("%AM")) {
        throw new Error(`KiCad ${layer} Gerber aperture macros are outside the qualified live-output dialect`);
      }
      const aperture = /^%ADD(\d{2,})(C|R|O|P),([0-9]+(?:\.[0-9]+)?(?:X[0-9]+(?:\.[0-9]+)?){0,3})\*%$/u.exec(command);
      if (aperture !== null) {
        const code = Number(aperture[1]);
        const shape = aperture[2]!;
        const parameters = aperture[3]!.split("X").map(Number);
        if (!Number.isSafeInteger(code) || code < 10 || definedApertures.has(code)) {
          throw new Error(`KiCad ${layer} Gerber contains an invalid or duplicate aperture definition`);
        }
        if (parameters.some((parameter) => !Number.isFinite(parameter))) {
          throw new Error(`KiCad ${layer} Gerber contains an invalid aperture parameter`);
        }
        if (
          (shape === "C" && (parameters.length !== 1 || parameters[0]! <= 0)) ||
          ((shape === "R" || shape === "O") &&
            (parameters.length !== 2 || parameters[0]! <= 0 || parameters[1]! <= 0)) ||
          (shape === "P" && (parameters.length < 2 || parameters.length > 3 ||
            parameters[0]! <= 0 || !Number.isInteger(parameters[1]) || parameters[1]! < 3 || parameters[1]! > 12))
        ) {
          throw new Error(`KiCad ${layer} Gerber contains invalid ${shape} aperture parameters`);
        }
        definedApertures.add(code);
      } else if (command.startsWith("%ADD")) {
        throw new Error(`KiCad ${layer} Gerber contains an unsupported aperture definition`);
      }
      continue;
    }
    if (command.startsWith("G04")) continue;
    if (command === "G01*") continue;
    if (command === "G02*" || command === "G03*") {
      throw new Error(`KiCad ${layer} Gerber uses curved interpolation outside the linear live-output contract`);
    }
    const selection = /^D(\d{2,})\*$/u.exec(command);
    if (selection !== null) {
      const code = Number(selection[1]);
      if (!definedApertures.has(code)) throw new Error(`KiCad ${layer} Gerber selects an undefined aperture`);
      selectedAperture = code;
      continue;
    }
    const coordinate = /^(?:G0?([123]))?(?=[XY])(?:X([+-]?\d+))?(?:Y([+-]?\d+))?(?:I[+-]?\d+)?(?:J[+-]?\d+)?(?:D0?([123]))?\*$/u.exec(command);
    if (coordinate === null) continue;
    if (coordinate[1] === "2" || coordinate[1] === "3") {
      throw new Error(`KiCad ${layer} Gerber uses curved interpolation outside the linear live-output contract`);
    }
    const previousPoint = x === undefined || y === undefined ? undefined : { x, y };
    if (coordinate[2] !== undefined) x = BigInt(coordinate[2]);
    if (coordinate[3] !== undefined) y = BigInt(coordinate[3]);
    const point = x === undefined || y === undefined ? undefined : { x, y };
    const explicitOperation = coordinate[4];
    if (explicitOperation === "1") modalOperation = "draw";
    if (explicitOperation === "2") modalOperation = "move";
    if (explicitOperation === "3") modalOperation = "flash";
    const operation = modalOperation;
    if (point === undefined) continue;
    if (operation === "move") {
      if (contour.length > 1) contours.push(contour);
      contour = [point];
    } else if (
      operation === "draw" && previousPoint !== undefined &&
      (previousPoint.x !== point.x || previousPoint.y !== point.y)
    ) {
      if (selectedAperture === undefined) throw new Error(`KiCad ${layer} Gerber draws without a defined selected aperture`);
      if (contour.length === 0) contour = [previousPoint];
      contour.push(point);
      draws += 1;
    } else if (operation === "flash") {
      if (selectedAperture === undefined) throw new Error(`KiCad ${layer} Gerber flashes without a defined selected aperture`);
      flashes += 1;
    }
  }
  if (contour.length > 1) contours.push(contour);
  if (layer === "Edge.Cuts") {
    const cross = (a: Point, b: Point, c: Point): bigint =>
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const between = (a: bigint, b: bigint, value: bigint): boolean =>
      value >= (a < b ? a : b) && value <= (a > b ? a : b);
    const intersects = (a: Point, b: Point, c: Point, d: Point): boolean => {
      const abC = cross(a, b, c);
      const abD = cross(a, b, d);
      const cdA = cross(c, d, a);
      const cdB = cross(c, d, b);
      if (abC === 0n && between(a.x, b.x, c.x) && between(a.y, b.y, c.y)) return true;
      if (abD === 0n && between(a.x, b.x, d.x) && between(a.y, b.y, d.y)) return true;
      if (cdA === 0n && between(c.x, d.x, a.x) && between(c.y, d.y, a.y)) return true;
      if (cdB === 0n && between(c.x, d.x, b.x) && between(c.y, d.y, b.y)) return true;
      return (abC < 0n) !== (abD < 0n) && (cdA < 0n) !== (cdB < 0n);
    };
    const validContour = (points: readonly Point[]): boolean => {
      if (points.length < 4) return false;
      const first = points[0]!;
      const last = points.at(-1)!;
      if (first.x !== last.x || first.y !== last.y) return false;
      let doubleArea = 0n;
      for (let index = 0; index < points.length - 1; index += 1) {
        const left = points[index]!;
        const right = points[index + 1]!;
        doubleArea += left.x * right.y - right.x * left.y;
      }
      if (doubleArea === 0n) return false;
      const segmentCount = points.length - 1;
      for (let left = 0; left < segmentCount; left += 1) {
        for (let right = left + 1; right < segmentCount; right += 1) {
          if (right === left + 1 || (left === 0 && right === segmentCount - 1)) continue;
          if (intersects(points[left]!, points[left + 1]!, points[right]!, points[right + 1]!)) return false;
        }
      }
      return true;
    };
    if (draws < 3 || contours.length !== 1 || !contours.every(validContour)) {
      throw new Error("KiCad Edge.Cuts Gerber lacks a closed drawable profile");
    }
    if (expectedBoard !== undefined) {
      const points = contours[0]!;
      const scale = 1_000_000;
      const expectedMinX = BigInt(Math.round((expectedBoard.kicadCenter.x - expectedBoard.widthMm / 2) * scale));
      const expectedMaxX = BigInt(Math.round((expectedBoard.kicadCenter.x + expectedBoard.widthMm / 2) * scale));
      const expectedMinY = BigInt(Math.round((expectedBoard.kicadCenter.y - expectedBoard.heightMm / 2) * scale));
      const expectedMaxY = BigInt(Math.round((expectedBoard.kicadCenter.y + expectedBoard.heightMm / 2) * scale));
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const minX = xs.reduce((left, right) => left < right ? left : right);
      const maxX = xs.reduce((left, right) => left > right ? left : right);
      const minY = ys.reduce((left, right) => left < right ? left : right);
      const maxY = ys.reduce((left, right) => left > right ? left : right);
      const rectangleEdges = points.slice(0, -1).every((point, index) => {
        const next = points[index + 1]!;
        return (point.x === next.x || point.y === next.y) &&
          (point.x === expectedMinX || point.x === expectedMaxX || point.y === expectedMinY || point.y === expectedMaxY);
      });
      if (
        minX !== expectedMinX || maxX !== expectedMaxX || minY !== expectedMinY || maxY !== expectedMaxY ||
        !rectangleEdges
      ) throw new Error("KiCad Edge.Cuts Gerber profile does not match the reconciled board dimensions and position");
    }
  } else if (draws === 0 && flashes === 0) {
    throw new Error(`KiCad ${layer} Gerber lacks drawable copper geometry`);
  }
}

/** @internal Pure output validator used after the official-app identity gate. */
export async function validateKicadBehavioralOutputs(
  qualificationOutputDirectory: string,
  outputs: readonly Readonly<CapturedFile>[],
  contract: BehavioralOutputContract,
): Promise<void> {
  for (const required of ["erc.json", "drc.json", "board.net"] as const) {
    const file = outputs.find(({ path }) => path === required);
    if (file === undefined || file.size === 0) throw new Error(`KiCad qualification output is missing or empty: ${required}`);
  }
  for (const required of ["erc.json", "drc.json"] as const) {
    const bytes = await readBoundedRegularFile(join(qualificationOutputDirectory, required), KICAD_REPORT_TEXT_LIMIT);
    const kind = required === "erc.json" ? "erc" : "drc";
    const parsed = parseJsonWithoutDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      `KiCad ${kind} report`,
    );
    requireCleanKicadRuleReport(parsed, kind, contract);
  }
  const netlistBytes = await readBoundedRegularFile(join(qualificationOutputDirectory, "board.net"), KICAD_REPORT_TEXT_LIMIT);
  const netlistText = new TextDecoder("utf-8", { fatal: true }).decode(netlistBytes);
  const netlist = parseNetlistIdentity(netlistText);
  for (const reference of contract.semanticComponentReferences) {
    if (!netlist.references.has(reference)) {
      throw new Error(`KiCad schematic netlist omitted component reference ${reference}`);
    }
  }
  for (const net of contract.semanticSchematicNetNames) {
    if (!netlist.nets.has(net)) {
      throw new Error(`KiCad schematic netlist omitted net ${net}`);
    }
  }
  for (const [index, layer] of [...contract.semanticCopperLayers, "Edge.Cuts"].entries()) {
    const candidates = outputs.filter(({ path, size }) => size > 0 && gerberPathMatchesLayer(path, layer));
    if (candidates.length !== 1) throw new Error(`KiCad Gerber output does not contain exactly one non-empty ${layer} layer`);
    const bytes = await readBoundedRegularFile(join(qualificationOutputDirectory, candidates[0]!.path), KICAD_REPORT_TEXT_LIMIT);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const commands = parseGerberCommands(text, layer);
    if (
      commands.filter((command) => command.startsWith("%FS")).length !== 1 ||
      commands.filter((command) => command.startsWith("%MO")).length !== 1 ||
      !commands.includes("%FSLAX46Y46*%") || !commands.includes("%MOMM*%")
    ) {
      throw new Error(`KiCad ${layer} Gerber lacks explicit format, millimetre units, or termination`);
    }
    if (layer.endsWith(".Cu")) {
      const copperIndex = index + 1;
      const side = index === 0 ? "Top" : index === contract.semanticCopperLayers.length - 1 ? "Bot" : "Inr";
      const expectedFunction = `%TF.FileFunction,Copper,L${copperIndex},${side}*%`;
      requireExactFileFunction(commands, expectedFunction, layer);
    }
    if (layer === "Edge.Cuts") {
      requireExactFileFunction(commands, "%TF.FileFunction,Profile,NP*%", layer);
    }
    requireDrawableGerberGeometry(commands, layer, contract.semanticBoard);
  }
}

async function captureDirectoryIdentity(path: string, label: string): Promise<Readonly<DirectoryIdentity>> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return Object.freeze({ path, realpath: await realpath(path), dev: entry.dev, ino: entry.ino });
}

async function assertDirectoryIdentity(identity: DirectoryIdentity, label: string): Promise<void> {
  const current = await captureDirectoryIdentity(identity.path, label);
  if (current.realpath !== identity.realpath || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`${label} identity changed`);
  }
}

function strictChild(parent: string, child: string): boolean {
  const within = relative(parent, child);
  return within !== "" && !within.startsWith("..") && !isAbsolute(within);
}

async function assertLiveDirectoryAuthority(authority: LiveDirectoryAuthority): Promise<void> {
  await assertDirectoryIdentity(authority.output, "KiCad configured output root");
  await assertDirectoryIdentity(authority.run, "KiCad live validation run directory");
  await assertDirectoryIdentity(authority.validation, "KiCad live validation directory");
  await assertDirectoryIdentity(authority.input, "KiCad live input directory");
  if (
    !strictChild(authority.output.realpath, authority.run.realpath) ||
    !strictChild(authority.run.realpath, authority.validation.realpath) ||
    !strictChild(authority.validation.realpath, authority.input.realpath)
  ) throw new Error("KiCad live validation directory containment changed");
  if (authority.qualificationOutput !== undefined) {
    await assertDirectoryIdentity(authority.qualificationOutput, "KiCad qualification output directory");
    if (!strictChild(authority.validation.realpath, authority.qualificationOutput.realpath)) {
      throw new Error("KiCad qualification output directory containment changed");
    }
  }
}

async function validateDirectoryAuthority(options: {
  readonly outputRoot: string;
  readonly runDirectory: string;
  readonly projectRoot?: string;
  readonly configuredOutputDirectory?: string;
  readonly protectedInputPaths?: readonly string[];
}): Promise<Readonly<{ output: DirectoryIdentity; run: DirectoryIdentity }>> {
  const outputAbsolute = resolve(options.outputRoot);
  const runAbsolute = resolve(options.runDirectory);
  const lexicalWithinOutput = relative(outputAbsolute, runAbsolute);
  if (lexicalWithinOutput === "" || lexicalWithinOutput.startsWith("..") || isAbsolute(lexicalWithinOutput)) {
    throw new Error("KiCad live validation run directory must be a strict child of the output root");
  }
  const outputIdentity = await captureDirectoryIdentity(outputAbsolute, "KiCad configured output root");
  let candidate = outputAbsolute;
  for (const segment of lexicalWithinOutput.split(sep)) {
    candidate = join(candidate, segment);
    const entry = await lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("KiCad live validation directory chain must be symlink-free real directories");
    }
  }
  const runIdentity = await captureDirectoryIdentity(runAbsolute, "KiCad live validation run directory");
  const resolvedOutput = outputIdentity.realpath;
  const resolvedRun = runIdentity.realpath;
  const realWithinOutput = relative(resolvedOutput, resolvedRun);
  if (realWithinOutput === "" || realWithinOutput.startsWith("..") || isAbsolute(realWithinOutput)) {
    throw new Error("KiCad live validation real directory escaped its output root");
  }
  if (options.projectRoot !== undefined) {
    const projectAbsolute = resolve(options.projectRoot);
    const projectEntry = await lstat(projectAbsolute);
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) throw new Error("KiCad project root must be a real directory");
    const resolvedProject = await realpath(projectAbsolute);
    if (resolvedOutput === resolvedProject) {
      throw new Error("KiCad live validation output root cannot be the authored project root");
    }
    const outputWithinProject = relative(resolvedProject, resolvedOutput);
    if (outputWithinProject.startsWith("..") || isAbsolute(outputWithinProject)) {
      throw new Error("KiCad live validation output root must remain inside the project root");
    }
    const configured = options.configuredOutputDirectory;
    if (
      typeof configured !== "string" || !configured || isAbsolute(configured) ||
      configured.replaceAll("\\", "/").split("/").some((segment) => segment === "" || segment === "..")
    ) throw new Error("KiCad live validation requires the configured relative output directory");
    const configuredAbsolute = resolve(resolvedProject, ...configured.replaceAll("\\", "/").split("/"));
    if (await realpath(configuredAbsolute) !== resolvedOutput) {
      throw new Error("KiCad live validation output root does not match the configured output directory");
    }
    const protectedPaths = options.protectedInputPaths;
    if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) {
      throw new Error("KiCad live validation requires protected authored input paths");
    }
    const normalizedProtected = protectedPaths.map((path) => String(path).replaceAll("\\", "/"));
    if (!normalizedProtected.includes("fulmetry.config.ts") || !normalizedProtected.includes("fulmetry.lock")) {
      throw new Error("KiCad live validation must protect fulmetry.config.ts and fulmetry.lock");
    }
    for (const path of normalizedProtected) {
      if (!path || isAbsolute(path) || path.split("/").some((segment) => !segment || segment === "..")) {
        throw new Error(`KiCad protected input path is unsafe: ${path}`);
      }
      const input = resolve(resolvedProject, ...path.split("/"));
      if (input === resolvedOutput || strictChild(resolvedOutput, input)) {
        throw new Error(`KiCad configured output root overlaps authored input ${path}`);
      }
      const inputParentWithinProject = relative(resolvedProject, resolve(input, ".."));
      if (inputParentWithinProject !== "" && strictChild(resolve(input, ".."), resolvedOutput)) {
        throw new Error(`KiCad configured output root is inside authored input subtree ${inputParentWithinProject}`);
      }
    }
  } else if (options.configuredOutputDirectory !== undefined || options.protectedInputPaths !== undefined) {
    throw new Error("KiCad configured output authority requires projectRoot");
  }
  return Object.freeze({ output: outputIdentity, run: runIdentity });
}

async function captureExactInputSet(
  root: string,
  expectedFiles: readonly Readonly<CapturedFile>[],
  rootIdentity: Readonly<DirectoryIdentity>,
): Promise<readonly Readonly<CapturedFile>[]> {
  return captureExactFlatKicadFiles({
    root,
    expected: expectedFiles,
    rootIdentity,
    label: "KiCad live input",
  });
}

/** Parses only the documented plain numeric output of `kicad-cli version`. */
export function parseKicadCliVersionOutput(output: string): string | null {
  const normalized = output.trim();
  return /^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(normalized) ? normalized : null;
}

type KicadDistributionEvidence = NonNullable<NonNullable<KicadLiveValidation["evidence"]>["tool"]>["distribution"];

function detectedToolEvidence(
  probe: Readonly<ExternalToolProbe>,
  version: string,
  major: number,
  distribution?: KicadDistributionEvidence,
) {
  if (
    probe.executableSha256 === undefined || probe.stdoutSha256 === undefined ||
    probe.stderrSha256 === undefined || probe.stdoutByteLength === undefined ||
    probe.stderrByteLength === undefined
  ) throw new Error("KiCad probe omitted exact executable or output identity");
  return Object.freeze({
    name: "kicad-cli" as const,
    version,
    major,
    platform: process.platform,
    architecture: process.arch,
    executableSha256: probe.executableSha256,
    ...(distribution === undefined ? {} : { distribution }),
    versionProbe: Object.freeze({
      arguments: Object.freeze(["version"] as const),
      stdoutSha256: probe.stdoutSha256,
      stderrSha256: probe.stderrSha256,
      stdoutByteLength: probe.stdoutByteLength,
      stderrByteLength: probe.stderrByteLength,
    }),
  });
}

async function officialMacosDistributionEvidence(
  executable: string,
): Promise<Readonly<KicadDistributionEvidence> | undefined> {
  if (process.platform !== "darwin" || process.arch !== "arm64") return undefined;
  if (await realpath(executable) !== OFFICIAL_KICAD_CLI) return undefined;
  const verify = Bun.spawnSync({
    cmd: ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", OFFICIAL_KICAD_APP],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (verify.exitCode !== 0) return undefined;
  const detail = Bun.spawnSync({
    cmd: ["/usr/bin/codesign", "-dvv", OFFICIAL_KICAD_APP],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (detail.exitCode !== 0) return undefined;
  const detailBytes = new Uint8Array([
    ...new Uint8Array(detail.stdout),
    ...new Uint8Array(detail.stderr),
  ]);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(detailBytes);
  if (!text.split(/\r?\n/u).includes(`TeamIdentifier=${OFFICIAL_KICAD_TEAM_IDENTIFIER}`)) {
    return undefined;
  }
  const file = Bun.spawnSync({
    cmd: ["/usr/bin/file", "-b", executable],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (file.exitCode !== 0) return undefined;
  const fileOutput = new TextDecoder().decode(file.stdout);
  if (!fileOutput.includes("Mach-O") || !fileOutput.includes("arm64")) return undefined;
  const architectures = Object.freeze(
    ["arm64", "x86_64"].filter((architecture) => fileOutput.includes(architecture)),
  );
  return Object.freeze({
    kind: "official-macos-app" as const,
    bundlePath: OFFICIAL_KICAD_APP,
    teamIdentifier: OFFICIAL_KICAD_TEAM_IDENTIFIER,
    architectures,
    codeSignatureSha256: hexSha256(detailBytes),
  });
}

function validationResult(options: {
  readonly state: KicadLiveValidation["state"];
  readonly message: string;
  readonly snapshot: ReturnType<typeof snapshotHandoff>;
  readonly artifacts: readonly Readonly<CapturedFile>[];
  readonly tool?: ReturnType<typeof detectedToolEvidence>;
  readonly authoredSourceDigest?: string;
  readonly directoryAuthority: LiveDirectoryAuthority;
  readonly execution?: NonNullable<KicadLiveValidation["evidence"]>["execution"];
}): Readonly<KicadLiveValidation> {
  const evidence = Object.freeze({
    schemaVersion: 1 as const,
    adapter: Object.freeze({ name: "fulmetry-kicad-cli" as const, version: KICAD_LIVE_ADAPTER_VERSION }),
    source: Object.freeze({
      circuitDigest: options.snapshot.circuitDigest,
      semanticReconciliationSha256: options.snapshot.semanticReconciliationSha256,
      ...(options.authoredSourceDigest === undefined ? {} : { authoredSourceDigest: options.authoredSourceDigest }),
    }),
    input: Object.freeze({
      artifactSetSha256: artifactSetDigest(options.artifacts),
      artifacts: Object.freeze(options.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
    }),
    ...(options.tool === undefined ? {} : { tool: options.tool }),
    execution: options.execution ?? Object.freeze({
      state: options.state === "unsupported"
        ? "not-run-unsupported-version" as const
        : options.state === "unqualified"
          ? "not-run-unqualified-identity" as const
          : "not-run-tool-unavailable" as const,
      commands: Object.freeze([]),
      outputs: Object.freeze([]),
    }),
  });
  const result = Object.freeze({
    state: options.state,
    supportedMajors: KICAD_SUPPORTED_MAJORS,
    detectionCandidateMajors: KICAD_DETECTION_CANDIDATE_MAJORS,
    message: options.message,
    evidence,
  });
  const authentic = markAuthenticKicadLiveValidation(result);
  PRISTINE_WEAKMAP_SET(LIVE_VALIDATION_DIRECTORY_AUTHORITY, authentic, options.directoryAuthority);
  return authentic;
}

/** Revalidates the exact isolated input bytes represented by live evidence. */
export async function verifyKicadLiveInputEvidence(
  validation: Readonly<KicadLiveValidation>,
): Promise<void> {
  requireSupportedBunRuntime();
  assertAuthenticKicadLiveValidation(validation);
  const authority = PRISTINE_WEAKMAP_GET(LIVE_VALIDATION_DIRECTORY_AUTHORITY, validation);
  if (authority === undefined || validation.evidence === undefined) {
    throw new Error("KiCad live validation lacks private directory authority");
  }
  await assertLiveDirectoryAuthority(authority);
  const captured = await captureExactInputSet(authority.input.path, authority.expectedFiles, authority.input);
  const expected = validation.evidence.input.artifacts;
  if (
    artifactSetDigest(captured) !== validation.evidence.input.artifactSetSha256 ||
    JSON.stringify(captured) !== JSON.stringify(expected)
  ) throw new Error("KiCad live input bytes no longer match authenticated evidence");
  if (
    authority.qualificationOutput !== undefined &&
    authority.expectedQualificationOutputs !== undefined
  ) {
    const outputs = await captureQualificationOutputs(authority.qualificationOutput.path);
    if (JSON.stringify(outputs) !== JSON.stringify(authority.expectedQualificationOutputs)) {
      throw new Error("KiCad qualification outputs no longer match authenticated evidence");
    }
  }
}

/**
 * Detects KiCad and binds the exact generated handoff to live-adapter evidence.
 * No KiCad design command runs until an exact binary/platform identity has live
 * fixtures and exact command semantics. The qualification registry is empty.
 */
export async function validateKicadHandoffLive(
  options: KicadLiveValidationOptions,
): Promise<Readonly<KicadLiveValidation>> {
  requireSupportedBunRuntime();
  // Snapshot caller-controlled authority synchronously, before the first await.
  assertAuthenticKicadHandoff(options.handoff);
  const snapshot = snapshotHandoff(options.handoff);
  const runDirectory = String(options.runDirectory);
  const outputRoot = String(options.outputRoot);
  const projectRoot = options.projectRoot === undefined ? undefined : String(options.projectRoot);
  const configuredOutputDirectory = options.configuredOutputDirectory === undefined
    ? undefined
    : String(options.configuredOutputDirectory);
  const protectedInputPaths = options.protectedInputPaths === undefined
    ? undefined
    : Object.freeze(options.protectedInputPaths.map((path) => String(path)));
  const authoredSourceDigest = options.authoredSourceDigest === undefined ? undefined : String(options.authoredSourceDigest);
  if (authoredSourceDigest !== undefined && !/^[a-f0-9]{64}$/u.test(authoredSourceDigest)) {
    throw new TypeError("KiCad live validation authored source digest is invalid");
  }
  const initialArtifacts = Object.freeze(snapshot.files.map(({ path, content, sha256 }) =>
    Object.freeze({ path, size: new TextEncoder().encode(content).byteLength, sha256 })
  ));

  const authority = await validateDirectoryAuthority({
    outputRoot,
    runDirectory,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(configuredOutputDirectory === undefined ? {} : { configuredOutputDirectory }),
    ...(protectedInputPaths === undefined ? {} : { protectedInputPaths }),
  });
  const resolvedRunDirectory = authority.run.realpath;
  const validationDirectory = join(resolvedRunDirectory, "kicad-live-validation");
  await mkdir(validationDirectory);
  await assertDirectoryIdentity(authority.output, "KiCad configured output root");
  await assertDirectoryIdentity(authority.run, "KiCad live validation run directory");
  const validationIdentity = await captureDirectoryIdentity(validationDirectory, "KiCad live validation directory");
  await assertDirectoryIdentity(authority.output, "KiCad configured output root");
  await assertDirectoryIdentity(authority.run, "KiCad live validation run directory");
  const inputDirectory = join(validationDirectory, "input");
  await mkdir(inputDirectory);
  await assertDirectoryIdentity(authority.output, "KiCad configured output root");
  await assertDirectoryIdentity(authority.run, "KiCad live validation run directory");
  await assertDirectoryIdentity(validationIdentity, "KiCad live validation directory");
  const inputIdentity = await captureDirectoryIdentity(inputDirectory, "KiCad live input directory");
  await assertDirectoryIdentity(authority.output, "KiCad configured output root");
  await assertDirectoryIdentity(authority.run, "KiCad live validation run directory");
  await assertDirectoryIdentity(validationIdentity, "KiCad live validation directory");
  const directoryAuthority = Object.freeze({
    output: authority.output,
    run: authority.run,
    validation: validationIdentity,
    input: inputIdentity,
    expectedFiles: initialArtifacts,
  });
  await options.beforeLiveInputWrite?.(inputDirectory);
  await assertLiveDirectoryAuthority(directoryAuthority);
  for (const file of snapshot.files) {
    await assertLiveDirectoryAuthority(directoryAuthority);
    await writeFile(join(inputDirectory, file.path), file.content, { flag: "wx", mode: 0o400 });
    await assertLiveDirectoryAuthority(directoryAuthority);
  }
  await assertLiveDirectoryAuthority(directoryAuthority);
  const capturedInitial = await captureExactInputSet(inputDirectory, initialArtifacts, inputIdentity);
  if (artifactSetDigest(capturedInitial) !== artifactSetDigest(initialArtifacts)) {
    throw new Error("KiCad live input capture does not match the generated handoff snapshot");
  }
  if (snapshot.semanticReconciliationState !== "passed") {
    return validationResult({
      state: "unqualified",
      message: "KiCad design commands were not run because independent source-to-KiCad semantic reconciliation failed",
      snapshot,
      artifacts: capturedInitial,
      directoryAuthority,
      ...(authoredSourceDigest === undefined ? {} : { authoredSourceDigest }),
    });
  }

  const qualificationHomeDirectory = join(validationDirectory, "home");
  await mkdir(qualificationHomeDirectory);
  const probe = await probeExternalTool({
    tool: "kicad-cli",
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    versionArguments: ["version"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: qualificationHomeDirectory,
      TMPDIR: qualificationHomeDirectory,
      LC_ALL: "C",
      LANG: "C",
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.outputLimit === undefined ? {} : { outputLimit: options.outputLimit }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (options.signal?.aborted) throw new Error("kicad-cli validation was cancelled");
  await options.beforeFinalInputSnapshot?.(inputDirectory);
  await assertLiveDirectoryAuthority(directoryAuthority);
  const capturedFinal = await captureExactInputSet(inputDirectory, initialArtifacts, inputIdentity);
  if (artifactSetDigest(capturedFinal) !== artifactSetDigest(capturedInitial)) {
    throw new Error("KiCad live input changed during tool detection");
  }
  const finishValidation = async (result: {
    readonly state: KicadLiveValidation["state"];
    readonly message: string;
    readonly tool?: ReturnType<typeof detectedToolEvidence>;
  }): Promise<Readonly<KicadLiveValidation>> => {
    await assertLiveDirectoryAuthority(directoryAuthority);
    const durableArtifacts = await captureExactInputSet(directoryAuthority.input.path, initialArtifacts, inputIdentity);
    if (
      artifactSetDigest(durableArtifacts) !== artifactSetDigest(capturedInitial) ||
      JSON.stringify(durableArtifacts) !== JSON.stringify(capturedInitial)
    ) throw new Error("KiCad live input changed before validation evidence publication");
    return validationResult({
      ...result,
      snapshot,
      artifacts: durableArtifacts,
      directoryAuthority,
      ...(authoredSourceDigest === undefined ? {} : { authoredSourceDigest }),
    });
  };
  if (probe.state === "unavailable") {
    return finishValidation({
      state: "unavailable",
      message: probe.reason ?? "kicad-cli is unavailable",
    });
  }

  if (probe.executable === undefined || probe.executableSha256 === undefined) {
    throw new Error("Detected kicad-cli omitted executable identity");
  }
  const executableBytes = await readBoundedRegularFile(
    probe.executable,
    EXTERNAL_TOOL_EXECUTABLE_BYTES_LIMIT,
  );
  if (hexSha256(executableBytes) !== probe.executableSha256) {
    throw new Error("kicad-cli executable changed after the version probe");
  }
  const version = parseKicadCliVersionOutput(probe.versionOutput ?? "");
  if (version === null) {
    return finishValidation({
      state: "unsupported",
      message: "kicad-cli version output did not match the documented plain numeric format",
    });
  }
  const major = Number(version.split(".")[0]);
  const distribution = await officialMacosDistributionEvidence(probe.executable);
  const tool = detectedToolEvidence(probe, version, major, distribution);
  if (!PRISTINE_ARRAY_INCLUDES(KICAD_DETECTION_CANDIDATE_MAJORS, major)) {
    return finishValidation({
      state: "unsupported",
      message: `KiCad ${version} is outside Fulmetry's detection-candidate majors ${KICAD_DETECTION_CANDIDATE_MAJORS.join(", ")}`,
      tool,
    });
  }
  if (!PRISTINE_ARRAY_INCLUDES(KICAD_SUPPORTED_MAJORS, major)) {
    return finishValidation({
      state: "unqualified",
      message: `KiCad ${version} is a detection candidate, but Fulmetry's Apple Silicon qualification currently supports major ${KICAD_SUPPORTED_MAJORS.join(", ")}`,
      tool,
    });
  }
  if (distribution === undefined) {
    return finishValidation({
      state: "unqualified",
      message: `KiCad ${version} is a detection candidate, but the executable is not the official signed Apple Silicon macOS app at ${OFFICIAL_KICAD_CLI}; design commands were not run`,
      tool,
    });
  }
  // KiCad may otherwise create a project-local .kicad_prl sidecar while
  // reading the handoff. The live input authority is immutable: commands may
  // write only to the separately captured output and HOME directories.
  await chmod(inputDirectory, 0o500);
  await assertLiveDirectoryAuthority(directoryAuthority);
  options.beforeQualificationCheck?.();
  const qualificationOutputDirectory = join(validationDirectory, "qualification-output");
  await mkdir(qualificationOutputDirectory);
  const qualificationOutputIdentity = await captureDirectoryIdentity(
    qualificationOutputDirectory,
    "KiCad qualification output directory",
  );
  const schematic = `${snapshot.projectName}.kicad_sch`;
  const pcb = `${snapshot.projectName}.kicad_pcb`;
  const commandTimeoutMs = options.qualificationCommandTimeoutMs ?? KICAD_COMMAND_TIMEOUT_MS;
  const commandOutputLimit = options.qualificationCommandOutputLimit ?? KICAD_COMMAND_OUTPUT_LIMIT;
  const commandSpecs = Object.freeze([
    Object.freeze({
      name: "schematic-erc" as const,
      arguments: Object.freeze([
        "sch", "erc", "--format", "json", "--severity-all", "--exit-code-violations", "--output",
        "../qualification-output/erc.json", schematic,
      ]),
      requiredOutput: "erc.json",
    }),
    Object.freeze({
      name: "pcb-drc" as const,
      arguments: Object.freeze([
        "pcb", "drc", "--format", "json", "--severity-all", "--schematic-parity", "--exit-code-violations", "--output",
        "../qualification-output/drc.json", pcb,
      ]),
      requiredOutput: "drc.json",
    }),
    Object.freeze({
      name: "schematic-netlist" as const,
      arguments: Object.freeze([
        "sch", "export", "netlist", "--format", "kicadsexpr", "--output",
        "../qualification-output/board.net", schematic,
      ]),
      requiredOutput: "board.net",
    }),
    Object.freeze({
      name: "pcb-gerbers" as const,
      arguments: Object.freeze([
        "pcb", "export", "gerbers", "--output",
        "../qualification-output/gerbers", pcb,
      ]),
      requiredOutput: "gerbers",
    }),
  ]);
  const commands: KicadCommandEvidence[] = [];
  try {
    for (const spec of commandSpecs) {
      if (spec.name === "pcb-gerbers") {
        await mkdir(join(qualificationOutputDirectory, "gerbers"));
      }
      await assertLiveDirectoryAuthority({
        ...directoryAuthority,
        qualificationOutput: qualificationOutputIdentity,
      });
      const evidence = await runKicadCommand({
        executable: probe.executable,
        name: spec.name,
        arguments: spec.arguments,
        cwd: inputDirectory,
        home: qualificationHomeDirectory,
        timeoutMs: commandTimeoutMs,
        outputLimit: commandOutputLimit,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      commands.push(evidence);
      const ruleCheckReportedViolations =
        (spec.name === "schematic-erc" || spec.name === "pcb-drc") &&
        evidence.exitCode === 5;
      if (evidence.exitCode !== 0 && !ruleCheckReportedViolations) {
        throw new Error(`KiCad ${spec.name} exited ${evidence.exitCode}`);
      }
      const produced = await lstat(join(qualificationOutputDirectory, spec.requiredOutput));
      if (spec.requiredOutput === "gerbers" ? !produced.isDirectory() : !produced.isFile()) {
        throw new Error(`KiCad ${spec.name} omitted required output ${spec.requiredOutput}`);
      }
    }
    const finalExecutable = await readBoundedRegularFile(
      probe.executable,
      EXTERNAL_TOOL_EXECUTABLE_BYTES_LIMIT,
    );
    if (hexSha256(finalExecutable) !== probe.executableSha256) {
      throw new Error("kicad-cli executable changed during behavioral qualification");
    }
    const finalDistribution = await officialMacosDistributionEvidence(probe.executable);
    if (JSON.stringify(finalDistribution) !== JSON.stringify(distribution)) {
      throw new Error("Official KiCad application identity changed during behavioral qualification");
    }
    const finalInput = await captureExactInputSet(inputDirectory, initialArtifacts, inputIdentity);
    if (JSON.stringify(finalInput) !== JSON.stringify(capturedInitial)) {
      throw new Error("KiCad live input changed during behavioral qualification");
    }
    const outputs = await captureQualificationOutputs(qualificationOutputDirectory);
    await validateKicadBehavioralOutputs(qualificationOutputDirectory, outputs, {
      ...snapshot,
      expectedKicadVersion: version,
    });
    const qualifiedAuthority = Object.freeze({
      ...directoryAuthority,
      qualificationOutput: qualificationOutputIdentity,
      expectedQualificationOutputs: outputs,
    });
    const execution = Object.freeze({
      state: "qualified" as const,
      commands: Object.freeze(commands),
      outputs,
    });
    const result = validationResult({
      state: "qualified",
      message: `KiCad ${version} accepted the isolated handoff and produced bounded ERC, DRC, netlist, and Gerber outputs`,
      snapshot,
      artifacts: finalInput,
      tool,
      directoryAuthority: qualifiedAuthority,
      execution,
      ...(authoredSourceDigest === undefined ? {} : { authoredSourceDigest }),
    });
    await verifyKicadLiveInputEvidence(result);
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    let outputs: readonly Readonly<CapturedFile>[] = Object.freeze([]);
    try { outputs = await captureQualificationOutputs(qualificationOutputDirectory); } catch { /* failure remains explicit */ }
    const failedAuthority = Object.freeze({
      ...directoryAuthority,
      qualificationOutput: qualificationOutputIdentity,
      expectedQualificationOutputs: outputs,
    });
    return validationResult({
      state: "failed",
      message: `KiCad behavioral qualification failed: ${error instanceof Error ? error.message : String(error)}`,
      snapshot,
      artifacts: capturedFinal,
      tool,
      directoryAuthority: failedAuthority,
      execution: Object.freeze({
        state: "failed" as const,
        commands: Object.freeze(commands),
        outputs,
      }),
      ...(authoredSourceDigest === undefined ? {} : { authoredSourceDigest }),
    });
  }
}
