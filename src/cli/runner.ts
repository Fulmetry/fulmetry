// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { link, lstat, mkdir, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defineDiagnostic, diagnosticId, formatCompactDiagnostic, type Diagnostic } from "../diagnostics";
import { diagnosticObjectMatchesTarget } from "../diagnostic-object-selector";
import { assessCircuitElectrical } from "../electrical";
import { assessCircuitFabrication } from "../fabrication";
import { probeNgspice } from "../external-tools";
import {
  createBuildInputSnapshot,
  refreshBuildInputSnapshot,
  type BuildInputDescriptor,
} from "../artifacts/inputs";
import {
  createDraftArtifactManifest,
  verifyArtifactManifest,
  type ArtifactManifest,
} from "../artifacts/manifest";
import {
  runBunProjectTests,
  verifyProjectTestInputAuthority,
  type ProjectTestExecution,
} from "../project-tests";
import { requireTscircuitIdentity, type TscircuitIdentityReport } from "../engine-identity";
import {
  createKicadHandoff,
  validateKicadHandoffLive,
  verifyKicadLiveInputEvidence,
  withKicadLiveValidation,
} from "../kicad";
import { captureExactFlatKicadFiles } from "../kicad/exact-flat-files";
import {
  deriveManufacturingExpectation,
} from "../manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
  MANUFACTURING_ADAPTER_VERSIONS,
} from "../manufacturing/export";
import { requireManufacturingPackageIdentity } from "../manufacturing/identity";
import { verifyManufacturingDirectory } from "../manufacturing/verify";
import {
  BASELINE_FABRICATION_PROFILE,
  type ActiveFabricationProfile,
} from "../profiles/baseline";
import { assessBaselinePreCompliance } from "../standards";
import { assessRecordedSourcing } from "../sourcing";
import { loadSimulationDefinition, runQualifiedNgspice } from "../simulation";
import { loadProjectConfig, type FulmetryConfig } from "../project/config";
import { discoverProject, type DiscoveredProject } from "../project/discovery";
import { discoverProjectSourceGraph } from "../project/source-graph";
import { digestProjectInputs, type ProjectInputDigest } from "../project/input-digest";
import { enrichDiagnosticProvenance } from "../project/provenance";
import { evaluateProjectCircuitTwice } from "../project/evaluate";
import { loadFulmetryLock, type FulmetryLock } from "../project/lock";
import {
  canonicalCircuitJson,
  parseCanonicalCircuitJson,
  parseCanonicalRouteCandidateCircuitJson,
} from "../circuit-json";
import {
  FREEROUTING_SUPPORTED_VERSION,
  renderPromotedRouteSourceSet,
  runFreeroutingCandidate,
} from "../routing";
import {
  bindArtifactDigests,
  captureRunEvidenceAuthority,
  captureSelectedEvidenceAuthority,
  verifyPublishedReport,
  verifyRunEvidenceAuthority,
  type RunEvidenceAuthority,
} from "./evidence-authority";
import {
  commandResult,
  formatCompactResult,
  type ArtifactReference,
  type CommandResult,
  type ExitClassification,
} from "../result";
import {
  assuranceStatus,
  sourcingStatus,
  statusSet,
  unassessedStatusSet,
  type StatusDimension,
  type StatusSet,
} from "../status";
import { requireFulmetryVersion } from "../version";
import { applyDeclaredWaivers, loadDeclaredWaivers } from "../waivers";
import {
  requireSupportedBunRuntime,
  SUPPORTED_BUN_VERSION,
  SUPPORTED_RUNTIME_PLATFORM,
  UnsupportedBunRuntimeError,
  UnsupportedPlatformRuntimeError,
  UNSUPPORTED_BUN_DIAGNOSTIC_ID,
  UNSUPPORTED_PLATFORM_DIAGNOSTIC_ID,
} from "../runtime";
import { completeInspectDiagnosticSelection } from "./inspect-selection";
import { readBoundedRegularFile } from "../internal/bounded-file";
import {
  isFulmetryCancellationError,
  throwIfFulmetryCancelled,
} from "../internal/cancellation";

const CUSTOM_OUTPUT_OWNERSHIP_MARKER = ".fulmetry-output-root.json";
const CUSTOM_OUTPUT_PROJECT_AUTHORITY = ".fulmetry-output-ownership.json";
const CUSTOM_OUTPUT_OWNERSHIP_MARKER_LIMIT = 4_096;

interface CustomOutputOwnershipRecord {
  readonly schemaVersion: 1;
  readonly kind: "fulmetry-generated-output-root";
  readonly outputDirectory: string;
  readonly nonce: string;
}

function customOutputOwnershipMarkerBytes(record: CustomOutputOwnershipRecord): string {
  return `${JSON.stringify({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    outputDirectory: record.outputDirectory,
    nonce: record.nonce,
  })}\n`;
}

function parseCustomOutputOwnershipRecord(
  bytes: string,
  outputDirectory: string,
): CustomOutputOwnershipRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("Configured custom outputDirectory has invalid Fulmetry ownership authority JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Configured custom outputDirectory has invalid Fulmetry ownership authority");
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(["kind", "nonce", "outputDirectory", "schemaVersion"]) ||
    record.schemaVersion !== 1 || record.kind !== "fulmetry-generated-output-root" ||
    record.outputDirectory !== outputDirectory ||
    typeof record.nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.nonce)
  ) {
    throw new Error("Configured custom outputDirectory has invalid Fulmetry ownership authority");
  }
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    kind: "fulmetry-generated-output-root" as const,
    outputDirectory,
    nonce: record.nonce,
  });
  if (bytes !== customOutputOwnershipMarkerBytes(parsed)) {
    throw new Error("Configured custom outputDirectory ownership authority is not canonical");
  }
  return parsed;
}

async function readCustomOutputProjectAuthority(
  projectRoot: string,
  outputDirectory: string,
): Promise<CustomOutputOwnershipRecord> {
  const bytes = new TextDecoder().decode(await readBoundedRegularFile(
    join(projectRoot, CUSTOM_OUTPUT_PROJECT_AUTHORITY),
    CUSTOM_OUTPUT_OWNERSHIP_MARKER_LIMIT,
  ));
  return parseCustomOutputOwnershipRecord(bytes, outputDirectory);
}

async function ensureCustomOutputProjectAuthority(
  projectRoot: string,
  outputDirectory: string,
): Promise<void> {
  const normalized = outputDirectory.replaceAll("\\", "/").replace(/\/$/u, "");
  if (normalized === ".fulmetry") return;
  const authorityPath = join(projectRoot, CUSTOM_OUTPUT_PROJECT_AUTHORITY);
  try {
    await lstat(authorityPath);
    await readCustomOutputProjectAuthority(projectRoot, normalized);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const outputRoot = resolve(projectRoot, ...normalized.split("/"));
  try {
    await lstat(outputRoot);
    throw new Error(
      `Configured custom outputDirectory is missing project-bound Fulmetry ownership authority ${CUSTOM_OUTPUT_PROJECT_AUTHORITY}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const record = Object.freeze({
    schemaVersion: 1 as const,
    kind: "fulmetry-generated-output-root" as const,
    outputDirectory: normalized,
    nonce: crypto.randomUUID(),
  });
  await writeFile(authorityPath, customOutputOwnershipMarkerBytes(record), { flag: "wx" });
}

export const CLI_EXIT_CODES = Object.freeze({
  success: 0,
  failure: 1,
  unavailable: 2,
  incomplete: 3,
  unsupported: 4,
  cancelled: 130,
  "warning-only": 0,
} as const satisfies Readonly<Record<ExitClassification, number>>);

export const CLI_HELP = `Fulmetry — Bun-first circuit projects

Usage:
  fulmetry help
  fulmetry dev [--host HOST] [--port PORT] [--json]
  fulmetry build [--offline] [--json] [--run-id ID]
  fulmetry check [--offline] [--json] [--run-id ID]
  fulmetry test [--offline] [--json] [--run-id ID]
  fulmetry inspect [TARGET] [--status DIMENSION] [--rule ID] [--offline] [--json] [--run-id ID]
  fulmetry simulate [NAME] [--offline] [--json] [--run-id ID]
  fulmetry route freerouting --jar PATH --jar-sha256 SHA256 [--clearance-mm MM] [--heap-mb MB] [--threads N] [--passes N] [--timeout-ms MS] [--offline] [--json] [--run-id ID]
  fulmetry route promote CANDIDATE --output DIRECTORY --via-hole-mm MM --via-outer-mm MM [--json]
  fulmetry export kicad [--offline] [--json] [--run-id ID]
  fulmetry export gerbers [--offline] [--json] [--run-id ID]
  fulmetry verify manufacturing [--offline] [--json] [--run-id ID]

Freerouting output is always a generated candidate. Only \`route promote\` writes a fresh authored route directory, and it refuses to overwrite an existing path.`;

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  /** Test and embedding boundary for an explicitly configured local tool path. */
  readonly externalToolPaths?: Readonly<{
    ngspice?: string | null;
    kicadCli?: string | null;
    java?: string | null;
  }>;
  /** @internal Bounded process controls for deterministic CLI tests and embeddings. */
  readonly projectTestOptions?: Readonly<{
    timeoutMs?: number;
    outputLimit?: number;
  }>;
  /** @internal Deterministic adversarial hook shared by every evidence-producing command. */
  readonly testHooks?: Readonly<{
    beforeEvidenceInputCapture?: (context: Readonly<{
      runDirectory: string;
    }>) => void | Promise<void>;
    beforeEvidenceAuthorityCapture?: (context: Readonly<{
      command: string;
      runDirectory: string;
    }>) => void | Promise<void>;
    beforeFinalReportPublication?: (context: Readonly<{
      command: string;
      runDirectory: string;
    }>) => void | Promise<void>;
    afterReportPublication?: (context: Readonly<{
      command: string;
      reportPath: string;
      runDirectory: string;
    }>) => void | Promise<void>;
    beforeFailureReportPublication?: (context: Readonly<{
      command: string;
      errorPath: string;
      runDirectory: string;
    }>) => void | Promise<void>;
    afterFailureReportPublication?: (context: Readonly<{
      command: string;
      errorPath: string;
      reportPath: string;
      runDirectory: string;
    }>) => void | Promise<void>;
  }>;
  /** @internal Deterministic adversarial hooks at the final KiCad publication boundary. */
  readonly kicadTestHooks?: Readonly<{
    beforeFinalReportPublication?: () => void | Promise<void>;
    beforeLiveInputWrite?: (inputDirectory: string) => void | Promise<void>;
    beforeHandoffFileCommit?: (context: Readonly<{
      handoffDirectory: string;
      path: string;
      relativePath: string;
    }>) => void | Promise<void>;
  }>;
  /** @internal Deterministic hook for a post-verification artifact race. */
  readonly manufacturingTestHooks?: Readonly<{
    afterVerification?: (context: Readonly<{
      manufacturingDirectory: string;
    }>) => void | Promise<void>;
  }>;
}

export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly result?: Readonly<CommandResult>;
  readonly projectRoot?: string;
  readonly runDirectory?: string;
  readonly reportPath?: string;
}

interface ParsedInvocation {
  readonly json: boolean;
  readonly offline: boolean;
  readonly runId?: string;
  readonly words: readonly string[];
}

interface ParsedFreeroutingInvocation {
  readonly jarPath: string;
  readonly jarSha256: string;
  readonly clearanceMm: number;
  readonly heapMb?: number;
  readonly threads?: number;
  readonly maxPasses?: number;
  readonly timeoutMs?: number;
}

interface ParsedRoutePromotionInvocation {
  readonly candidatePath: string;
  readonly outputDirectory: string;
  readonly viaHoleMm: number;
  readonly viaOuterMm: number;
}

function numericOption(value: string | undefined, option: string): number {
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${option} requires a finite number`);
  return parsed;
}

function parseFreeroutingInvocation(words: readonly string[]): ParsedFreeroutingInvocation {
  let jarPath: string | undefined;
  let jarSha256: string | undefined;
  let clearanceMm = 0.2;
  let clearanceSeen = false;
  let heapMb: number | undefined;
  let threads: number | undefined;
  let maxPasses: number | undefined;
  let timeoutMs: number | undefined;
  const assignOnce = <T>(current: T | undefined, value: T, option: string): T => {
    if (current !== undefined) throw new TypeError(`${option} may be specified only once`);
    return value;
  };
  for (let index = 2; index < words.length; index += 1) {
    const option = words[index]!;
    const value = words[index + 1];
    switch (option) {
      case "--jar":
        if (value === undefined || value.startsWith("--")) throw new TypeError("--jar requires a path");
        jarPath = assignOnce(jarPath, value, option);
        break;
      case "--jar-sha256":
        if (value === undefined || value.startsWith("--")) throw new TypeError("--jar-sha256 requires a digest");
        jarSha256 = assignOnce(jarSha256, value, option);
        break;
      case "--clearance-mm":
        if (clearanceSeen) throw new TypeError(`${option} may be specified only once`);
        clearanceSeen = true;
        clearanceMm = numericOption(value, option);
        break;
      case "--heap-mb": heapMb = assignOnce(heapMb, numericOption(value, option), option); break;
      case "--threads": threads = assignOnce(threads, numericOption(value, option), option); break;
      case "--passes": maxPasses = assignOnce(maxPasses, numericOption(value, option), option); break;
      case "--timeout-ms": timeoutMs = assignOnce(timeoutMs, numericOption(value, option), option); break;
      default: throw new TypeError(`Unknown route option ${option}`);
    }
    index += 1;
  }
  if (jarPath === undefined || jarSha256 === undefined) {
    throw new TypeError("route freerouting requires --jar and --jar-sha256");
  }
  return Object.freeze({
    jarPath,
    jarSha256,
    clearanceMm,
    ...(heapMb === undefined ? {} : { heapMb }),
    ...(threads === undefined ? {} : { threads }),
    ...(maxPasses === undefined ? {} : { maxPasses }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function parseRoutePromotionInvocation(words: readonly string[]): ParsedRoutePromotionInvocation {
  const candidatePath = words[2];
  if (candidatePath === undefined || candidatePath.startsWith("--")) {
    throw new TypeError("route promote requires a candidate Circuit JSON path");
  }
  let outputDirectory: string | undefined;
  let viaHoleMm: number | undefined;
  let viaOuterMm: number | undefined;
  for (let index = 3; index < words.length; index += 1) {
    const option = words[index]!;
    const value = words[index + 1];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
    if (option === "--output") {
      if (outputDirectory !== undefined) throw new TypeError("--output may be specified only once");
      outputDirectory = value;
    } else if (option === "--via-hole-mm") {
      if (viaHoleMm !== undefined) throw new TypeError("--via-hole-mm may be specified only once");
      viaHoleMm = numericOption(value, option);
    } else if (option === "--via-outer-mm") {
      if (viaOuterMm !== undefined) throw new TypeError("--via-outer-mm may be specified only once");
      viaOuterMm = numericOption(value, option);
    } else {
      throw new TypeError(`Unknown route promotion option ${option}`);
    }
    index += 1;
  }
  if (outputDirectory === undefined || viaHoleMm === undefined || viaOuterMm === undefined) {
    throw new TypeError("route promote requires --output, --via-hole-mm, and --via-outer-mm");
  }
  return Object.freeze({ candidatePath, outputDirectory, viaHoleMm, viaOuterMm });
}

interface PreparedRun {
  readonly project: DiscoveredProject;
  readonly config: FulmetryConfig;
  readonly lock: FulmetryLock;
  readonly engineIdentity: TscircuitIdentityReport;
  readonly engineResolutionAuthority: ProjectEngineResolutionAuthority;
  readonly preparedInputDigest: ProjectInputDigest;
  readonly runId: string;
  readonly runDirectory: string;
  readonly reportPath: string;
  readonly runRootAuthority: RunEvidenceAuthority;
  readonly networkPolicy: "default" | "offline";
  readonly signal?: AbortSignal;
  readonly beforeFinalReportPublication?: NonNullable<RunCliOptions["testHooks"]>["beforeFinalReportPublication"];
  readonly afterReportPublication?: NonNullable<RunCliOptions["testHooks"]>["afterReportPublication"];
  readonly beforeEvidenceInputCapture?: NonNullable<RunCliOptions["testHooks"]>["beforeEvidenceInputCapture"];
  readonly beforeEvidenceAuthorityCapture?: NonNullable<RunCliOptions["testHooks"]>["beforeEvidenceAuthorityCapture"];
  readonly beforeFailureReportPublication?: NonNullable<RunCliOptions["testHooks"]>["beforeFailureReportPublication"];
  readonly afterFailureReportPublication?: NonNullable<RunCliOptions["testHooks"]>["afterFailureReportPublication"];
}

const preparedEngineVerifications = new WeakMap<PreparedRun, Promise<void>>();

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_TEXT_DIAGNOSTICS = 20;
const MAX_TEXT_CHARACTERS = 8_000;

interface ProjectEngineResolutionAuthority {
  readonly path: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
  readonly kind: "directory" | "symlink";
}

async function captureProjectEngineResolutionAuthority(
  projectRoot: string,
  expectedPackageRoot: string,
): Promise<Readonly<ProjectEngineResolutionAuthority>> {
  let directory = resolve(projectRoot);
  while (true) {
    const candidate = join(directory, "node_modules", "tscircuit");
    try {
      const entry = await lstat(candidate);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new Error("Project tscircuit resolution entry is neither a directory nor a symlink");
      }
      const target = await realpath(candidate);
      if (target !== expectedPackageRoot) {
        throw new Error("Project tscircuit resolution entry does not match the resolved package root");
      }
      return Object.freeze({
        path: candidate,
        realpath: target,
        dev: entry.dev,
        ino: entry.ino,
        kind: entry.isSymbolicLink() ? "symlink" : "directory",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not authenticate the project tscircuit resolution entry");
    }
    directory = parent;
  }
}

function parseInvocation(
  argv: readonly string[],
  suppliedRunId?: string,
): ParsedInvocation {
  let json = false;
  let offline = false;
  let runId = suppliedRunId;
  const words: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      if (json) throw new TypeError("--json may be specified only once");
      json = true;
      continue;
    }
    if (argument === "--offline") {
      if (offline) throw new TypeError("--offline may be specified only once");
      offline = true;
      continue;
    }
    if (argument === "--run-id") {
      if (runId !== undefined) throw new TypeError("run id may be specified only once");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new TypeError("--run-id requires a value");
      }
      runId = value;
      index += 1;
      continue;
    }
    words.push(argument);
  }

  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) {
    throw new TypeError(
      "run id must be 1-80 characters using letters, digits, dot, underscore, or hyphen",
    );
  }
  return Object.freeze({
    json,
    offline,
    ...(runId === undefined ? {} : { runId }),
    words: Object.freeze(words),
  });
}

export function argumentFailure(message: string, json: boolean, command = "fulmetry"): CliRun {
  const statuses = unassessedStatusSet();
  const diagnostic = defineDiagnostic({
    id: diagnosticId("CLI_ARGUMENT_INVALID_001"),
    severity: "error",
    dimension: "functional",
    message,
    waiverPolicy: "forbidden",
    objects: [],
    sourceLocations: [],
    evidence: ["invocation:rejected-before-project-evidence"],
    nextCommand: "fulmetry help",
  });
  const result = commandResult({
    command,
    runId: "argument-error",
    exitClassification: "failure",
    requestedDimensions: [],
    statuses,
    diagnostics: [diagnostic],
  });
  return Object.freeze({
    exitCode: CLI_EXIT_CODES.failure,
    stdout: json ? `${JSON.stringify(result, null, 2)}\n` : "",
    stderr: `${formatCompactDiagnostic(diagnostic)}\n`,
    result,
  });
}

function unsupportedRun(
  words: readonly string[],
  json: boolean,
  runId?: string,
): CliRun {
  const command = words.length === 0 ? "fulmetry" : `fulmetry ${words.join(" ")}`;
  const result = commandResult({
    command,
    runId: runId ?? "unsupported-command",
    exitClassification: "unsupported",
    requestedDimensions: [],
    statuses: unassessedStatusSet(),
    diagnostics: [defineDiagnostic({
      id: diagnosticId("CLI_COMMAND_UNSUPPORTED_001"),
      severity: "error",
      dimension: "functional",
      message: `${command} is not supported by this Fulmetry release`,
      waiverPolicy: "forbidden",
      objects: [],
      sourceLocations: [],
      evidence: ["invocation:recognized-as-unsupported"],
      nextCommand: "fulmetry help",
    })],
  });
  return Object.freeze({
    exitCode: CLI_EXIT_CODES.unsupported,
    stdout: json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatCompactResult(result)}\n`,
    stderr: "",
    result,
  });
}

export function unsupportedBunRuntimeRun(
  json: boolean,
  command = "fulmetry",
  runId = "unsupported-runtime",
): CliRun {
  const diagnostic = defineDiagnostic({
    id: diagnosticId(UNSUPPORTED_BUN_DIAGNOSTIC_ID),
    severity: "error",
    dimension: "functional",
    message: `Fulmetry requires Bun ${SUPPORTED_BUN_VERSION}; running Bun is ${Bun.version}`,
    waiverPolicy: "forbidden",
    objects: [],
    sourceLocations: [],
    evidence: [
      `runtime:bun:${Bun.version}`,
      `supported:bun:${SUPPORTED_BUN_VERSION}`,
      "project-evaluation:not-started",
    ],
    nextCommand: `Install Bun ${SUPPORTED_BUN_VERSION} and rerun ${command}`,
  });
  const result = commandResult({
    command,
    runId,
    exitClassification: "unsupported",
    requestedDimensions: [],
    statuses: unassessedStatusSet(),
    diagnostics: [diagnostic],
  });
  return Object.freeze({
    exitCode: CLI_EXIT_CODES.unsupported,
    stdout: json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCompactResult(result)}\n`,
    stderr: "",
    result,
  });
}

export function unsupportedPlatformRuntimeRun(
  json: boolean,
  command = "fulmetry",
  runId = "unsupported-runtime",
): CliRun {
  const observed = `${process.platform}-${process.arch}`;
  const diagnostic = defineDiagnostic({
    id: diagnosticId(UNSUPPORTED_PLATFORM_DIAGNOSTIC_ID),
    severity: "error",
    dimension: "functional",
    message: `Fulmetry requires Apple Silicon macOS (${SUPPORTED_RUNTIME_PLATFORM}); running platform is ${observed}`,
    waiverPolicy: "forbidden",
    objects: [],
    sourceLocations: [],
    evidence: [
      `runtime:platform:${observed}`,
      `supported:platform:${SUPPORTED_RUNTIME_PLATFORM}`,
      "project-evaluation:not-started",
    ],
    nextCommand: `Run ${command} on Apple Silicon macOS`,
  });
  const result = commandResult({
    command,
    runId,
    exitClassification: "unsupported",
    requestedDimensions: [],
    statuses: unassessedStatusSet(),
    diagnostics: [diagnostic],
  });
  return Object.freeze({
    exitCode: CLI_EXIT_CODES.unsupported,
    stdout: json ? `${JSON.stringify(result, null, 2)}\n` : `${formatCompactResult(result)}\n`,
    stderr: "",
    result,
  });
}

async function assertNoSymlinkOutputPath(
  projectRoot: string,
  outputDirectory: string,
): Promise<void> {
  let current = projectRoot;
  for (const segment of outputDirectory.replaceAll("\\", "/").split("/")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Configured output path contains a symlink: ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("contains a symlink")) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

async function assertExclusiveOutputDirectoryOwnership(
  projectRoot: string,
  outputDirectory: string,
): Promise<void> {
  await assertNoSymlinkOutputPath(projectRoot, outputDirectory);
  const normalized = outputDirectory.replaceAll("\\", "/").replace(/\/$/u, "");
  const outputRoot = resolve(projectRoot, ...normalized.split("/"));
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    const stat = await lstat(outputRoot);
    if (!stat.isDirectory()) {
      throw new Error("Configured outputDirectory must resolve to a directory");
    }
    directory = await opendir(outputRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const ownedEntries = new Set([
    "runs",
    ...(normalized === ".fulmetry"
      ? ["cache", "upgrade-reviews"]
      : [CUSTOM_OUTPUT_OWNERSHIP_MARKER]),
  ]);
  let foundOwnershipMarker = normalized === ".fulmetry";
  for await (const entry of directory) {
    const isOwnershipMarker = entry.name === CUSTOM_OUTPUT_OWNERSHIP_MARKER;
    if (entry.isSymbolicLink()) {
      throw new Error(`Configured output path contains a symlink: ${join(outputRoot, entry.name)}`);
    }
    if (
      !ownedEntries.has(entry.name) ||
      (isOwnershipMarker ? !entry.isFile() : !entry.isDirectory())
    ) {
      throw new Error(
        `Configured outputDirectory must be exclusively owned by Fulmetry generated output; unexpected entry ${entry.name}`,
      );
    }
    if (isOwnershipMarker) foundOwnershipMarker = true;
  }
  if (!foundOwnershipMarker) {
    throw new Error(
      `Configured custom outputDirectory is missing Fulmetry ownership marker ${CUSTOM_OUTPUT_OWNERSHIP_MARKER}`,
    );
  }
  if (normalized !== ".fulmetry") {
    const authority = await readCustomOutputProjectAuthority(projectRoot, normalized);
    const markerBytes = new TextDecoder().decode(await readBoundedRegularFile(
      join(outputRoot, CUSTOM_OUTPUT_OWNERSHIP_MARKER),
      CUSTOM_OUTPUT_OWNERSHIP_MARKER_LIMIT,
    ));
    if (markerBytes !== customOutputOwnershipMarkerBytes(authority)) {
      throw new Error("Configured custom outputDirectory has an invalid Fulmetry ownership marker");
    }
  }
}

async function ensureOutputDirectoryOwnership(
  projectRoot: string,
  outputDirectory: string,
): Promise<void> {
  const normalized = outputDirectory.replaceAll("\\", "/").replace(/\/$/u, "");
  const outputRoot = resolve(projectRoot, ...normalized.split("/"));
  try {
    await lstat(outputRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(outputRoot), { recursive: true });
    await mkdir(outputRoot);
    if (normalized !== ".fulmetry") {
      const authority = await readCustomOutputProjectAuthority(projectRoot, normalized);
      await writeFile(
        join(outputRoot, CUSTOM_OUTPUT_OWNERSHIP_MARKER),
        customOutputOwnershipMarkerBytes(authority),
        { flag: "wx" },
      );
    }
  }
  await assertExclusiveOutputDirectoryOwnership(projectRoot, normalized);
}

async function prepareRun(
  cwd: string,
  requestedRunId?: string,
  offline = false,
  beforeFinalReportPublication?: NonNullable<RunCliOptions["testHooks"]>["beforeFinalReportPublication"],
  afterReportPublication?: NonNullable<RunCliOptions["testHooks"]>["afterReportPublication"],
  beforeEvidenceInputCapture?: NonNullable<RunCliOptions["testHooks"]>["beforeEvidenceInputCapture"],
  beforeEvidenceAuthorityCapture?: NonNullable<RunCliOptions["testHooks"]>["beforeEvidenceAuthorityCapture"],
  beforeFailureReportPublication?: NonNullable<RunCliOptions["testHooks"]>["beforeFailureReportPublication"],
  afterFailureReportPublication?: NonNullable<RunCliOptions["testHooks"]>["afterFailureReportPublication"],
  signal?: AbortSignal,
): Promise<PreparedRun> {
  const project = await discoverProject(cwd);
  const [config, lock] = await Promise.all([
    loadProjectConfig(project.root),
    loadFulmetryLock(project.root),
  ]);
  const [sourcePaths, configPaths, engineIdentity] = await Promise.all([
    discoverProjectSourceGraph(project.root, config.entry),
    discoverProjectSourceGraph(project.root, "fulmetry.config.ts"),
    requireTscircuitIdentity({
      projectRoot: project.root,
      expectedVersion: lock.tscircuit.version,
    }),
  ]);
  const outputPrefix = config.outputDirectory.replaceAll("\\", "/").replace(/\/$/, "");
  if ([...sourcePaths, ...configPaths, "fulmetry.lock"].some((path) =>
    path === outputPrefix || path.startsWith(`${outputPrefix}/`)
  )) {
    throw new Error("Configured outputDirectory overlaps project source, configuration, or lock inputs");
  }
  await ensureCustomOutputProjectAuthority(project.root, config.outputDirectory);
  await assertExclusiveOutputDirectoryOwnership(project.root, config.outputDirectory);
  const engineResolutionAuthority = await captureProjectEngineResolutionAuthority(
    project.root,
    engineIdentity.project!.packageRoot,
  );
  const initialPreparedInputDigest = await digestProjectInputs({
    projectRoot: project.root,
    entry: config.entry,
    outputDirectory: config.outputDirectory,
    profiles: config.profiles,
    ...(config.boardRevision === undefined ? {} : { boardRevision: config.boardRevision }),
    evaluateSimulationDefinitions: !offline,
  });
  const [confirmedConfig, confirmedLock] = await Promise.all([
    loadProjectConfig(project.root),
    loadFulmetryLock(project.root),
  ]);
  if (!isDeepStrictEqual(confirmedConfig, config) || !isDeepStrictEqual(confirmedLock, lock)) {
    throw new Error("Project configuration or lock changed during run preparation");
  }
  const preparedInputDigest = await digestProjectInputs({
    projectRoot: project.root,
    entry: config.entry,
    outputDirectory: config.outputDirectory,
    profiles: config.profiles,
    ...(config.boardRevision === undefined ? {} : { boardRevision: config.boardRevision }),
    evaluateSimulationDefinitions: !offline,
  });
  if (preparedInputDigest.projectDigest !== initialPreparedInputDigest.projectDigest) {
    throw new Error("Project inputs changed during run preparation");
  }
  await assertNoSymlinkOutputPath(
    project.root,
    `${config.outputDirectory.replaceAll("\\", "/")}/runs`,
  );
  await ensureOutputDirectoryOwnership(project.root, config.outputDirectory);
  const runId = requestedRunId ?? crypto.randomUUID();
  const runsDirectory = resolve(
    project.root,
    ...config.outputDirectory.replaceAll("\\", "/").split("/"),
    "runs",
  );
  await mkdir(runsDirectory, { recursive: true });
  const runDirectory = join(runsDirectory, runId);
  await mkdir(runDirectory, { recursive: false });
  const reportPath = join(runDirectory, "report.json");
  const runRootAuthority = await captureSelectedEvidenceAuthority({
    runDirectory,
    projectRoot: project.root,
    reportPath,
    artifacts: [],
  });
  return Object.freeze({
    project,
    config,
    lock,
    engineIdentity,
    engineResolutionAuthority,
    preparedInputDigest,
    runId,
    runDirectory,
    reportPath,
    runRootAuthority,
    networkPolicy: offline ? "offline" as const : "default" as const,
    ...(signal === undefined ? {} : { signal }),
    ...(beforeFinalReportPublication === undefined ? {} : { beforeFinalReportPublication }),
    ...(afterReportPublication === undefined ? {} : { afterReportPublication }),
    ...(beforeEvidenceInputCapture === undefined ? {} : { beforeEvidenceInputCapture }),
    ...(beforeEvidenceAuthorityCapture === undefined ? {} : { beforeEvidenceAuthorityCapture }),
    ...(beforeFailureReportPublication === undefined ? {} : { beforeFailureReportPublication }),
    ...(afterFailureReportPublication === undefined ? {} : { afterFailureReportPublication }),
  });
}

async function atomicWrite(path: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${path}.tmp`;
  let temporaryCreated = false;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    temporaryCreated = true;
    // A rename would replace a destination created after our initial checks.
    // Linking is an atomic no-replace commit: EEXIST preserves that file.
    await link(temporary, path);
  } finally {
    if (temporaryCreated) await rm(temporary, { force: true });
  }
}

interface KicadPublicationDirectoryIdentity {
  readonly path: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
}

interface KicadPublicationFileIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface KicadPublicationAuthority {
  readonly directory: KicadPublicationDirectoryIdentity;
  readonly files: readonly KicadPublicationFileIdentity[];
}

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function captureKicadPublicationDirectory(
  path: string,
): Promise<Readonly<KicadPublicationDirectoryIdentity>> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("KiCad handoff publication root is not a real directory");
  }
  return Object.freeze({ path, realpath: await realpath(path), dev: entry.dev, ino: entry.ino });
}

async function assertKicadPublicationDirectory(
  identity: Readonly<KicadPublicationDirectoryIdentity>,
): Promise<void> {
  const current = await captureKicadPublicationDirectory(identity.path);
  if (current.realpath !== identity.realpath || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("KiCad handoff publication directory identity changed");
  }
}

async function verifyKicadHandoffPublication(
  authority: Readonly<KicadPublicationAuthority>,
): Promise<void> {
  await assertKicadPublicationDirectory(authority.directory);
  const captured = await captureExactFlatKicadFiles({
    root: authority.directory.path,
    expected: authority.files,
    rootIdentity: authority.directory,
    label: "KiCad handoff publication",
  });
  const expected = [...authority.files].sort((left, right) => left.path.localeCompare(right.path));
  if (!isDeepStrictEqual(captured, expected)) {
    throw new Error("KiCad handoff publication bytes changed and no longer match authenticated evidence");
  }
  await assertKicadPublicationDirectory(authority.directory);
}

function withOneFinalNewline(contents: string): string {
  return `${contents.replace(/\n+$/, "")}\n`;
}

function projectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).replaceAll("\\", "/");
}

function activeFabricationProfile(
  config: FulmetryConfig,
  lock: FulmetryLock,
): ActiveFabricationProfile | undefined {
  if (!config.profiles.includes(BASELINE_FABRICATION_PROFILE.name)) return undefined;
  const locked = lock.profiles[BASELINE_FABRICATION_PROFILE.name];
  if (locked === undefined) return undefined;
  return Object.freeze({
    name: BASELINE_FABRICATION_PROFILE.name,
    version: locked.version,
    digest: locked.digest,
  });
}

function mergeAssessmentStatuses(
  fabrication: ReturnType<typeof assessCircuitFabrication>["status"],
  electrical: ReturnType<typeof assessCircuitElectrical>["status"],
  standards = assuranceStatus("standards", "not-run"),
  sourcing = sourcingStatus("unchecked"),
): Readonly<StatusSet> {
  return statusSet({
    fabrication,
    electrical,
    functional: assuranceStatus("functional", "not-run"),
    standards,
    sourcing,
  });
}

function classify(
  statuses: StatusSet,
  requestedDimensions: readonly StatusDimension[],
  diagnostics: readonly Diagnostic[],
): ExitClassification {
  const states = requestedDimensions.map((dimension) => statuses[dimension].state);
  if (states.includes("failed")) return "failure";
  if (states.includes("unavailable")) return "unavailable";
  if (
    states.includes("incomplete") || states.includes("not-run") ||
    states.includes("unchecked") || states.includes("stale")
  ) return "incomplete";
  if (
    states.includes("passed-with-waivers") ||
    states.includes("constrained") ||
    diagnostics.some((diagnostic) =>
      requestedDimensions.includes(diagnostic.dimension) && diagnostic.severity === "warning"
    )
  ) return "warning-only";
  return "success";
}

function sourceOnlyAssessment(assessment: Awaited<ReturnType<typeof assessProject>>): {
  readonly statuses: Readonly<StatusSet>;
  readonly diagnostics: readonly Diagnostic[];
} {
  if (
    assessment.fabrication.status.state !== "passed" &&
    assessment.fabrication.status.state !== "passed-with-waivers"
  ) {
    return { statuses: assessment.statuses, diagnostics: assessment.diagnostics };
  }
  const diagnostic = defineDiagnostic({
    id: diagnosticId("FAB_ARTIFACT_VERIFICATION_NOT_RUN_001"),
    severity: "warning",
    dimension: "fabrication",
    message: "Source geometry passed, but emitted manufacturing artifacts were not independently verified",
    waiverPolicy: "forbidden",
    objects: [],
    sourceLocations: ["fulmetry.config.ts:1:1"],
    evidence: ["manufacturing-artifacts:not-run"],
    nextCommand: "fulmetry verify manufacturing",
  });
  return Object.freeze({
    statuses: statusSet({
      ...assessment.statuses,
      fabrication: assuranceStatus("fabrication", "incomplete", {
        diagnosticIds: [...assessment.fabrication.status.diagnosticIds, diagnostic.id],
        summary: "Source checks passed; manufacturing artifact verification has not run",
      }),
    }),
    diagnostics: Object.freeze([...assessment.diagnostics, diagnostic]),
  });
}

function boundedText(result: CommandResult, reportPath: string): string {
  const visible = result.diagnostics.slice(0, MAX_TEXT_DIAGNOSTICS);
  let text = formatCompactResult({ ...result, diagnostics: visible });
  if (visible.length !== result.diagnostics.length) {
    text += `\n\n${result.diagnostics.length - visible.length} more diagnostic(s); full report: ${reportPath}`;
  }
  if (text.length > MAX_TEXT_CHARACTERS) {
    text = `${text.slice(0, MAX_TEXT_CHARACTERS - 80)}\n… output truncated; full report: ${reportPath}`;
  }
  return `${text}\n`;
}

async function assertPreparedEngineIdentity(prepared: PreparedRun): Promise<void> {
  const previous = preparedEngineVerifications.get(prepared) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await previous;
    await assertPreparedEngineIdentityOnce(prepared);
  });
  preparedEngineVerifications.set(prepared, current);
  return current;
}

async function assertPreparedEngineIdentityOnce(prepared: PreparedRun): Promise<void> {
  let resolution: Readonly<ProjectEngineResolutionAuthority>;
  try {
    resolution = await captureProjectEngineResolutionAuthority(
      prepared.project.root,
      prepared.engineIdentity.project!.packageRoot,
    );
  } catch (error) {
    throw new Error(
      `Project tscircuit engine changed after run preparation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isDeepStrictEqual(resolution, prepared.engineResolutionAuthority)) {
    throw new Error("Project tscircuit engine resolution changed after run preparation");
  }
  let current: Readonly<TscircuitIdentityReport>;
  try {
    current = await requireTscircuitIdentity({
      projectRoot: prepared.project.root,
      expectedVersion: prepared.lock.tscircuit.version,
    });
  } catch (error) {
    throw new Error(
      `Project tscircuit engine changed after run preparation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isDeepStrictEqual(current, prepared.engineIdentity)) {
    throw new Error("Project tscircuit engine identity changed after run preparation");
  }
}

async function assertPreparedConfig(prepared: PreparedRun): Promise<void> {
  if (!isDeepStrictEqual(await loadProjectConfig(prepared.project.root), prepared.config)) {
    throw new Error("Resolved project configuration changed after run preparation");
  }
  await assertExclusiveOutputDirectoryOwnership(
    prepared.project.root,
    prepared.config.outputDirectory,
  );
}

function contextualizeResult(
  prepared: PreparedRun,
  result: Readonly<CommandResult>,
  inputDigest: Readonly<ProjectInputDigest>,
): Readonly<CommandResult> {
  const { schemaVersion: _schemaVersion, ...resultFields } = result;
  return commandResult({
    ...resultFields,
    project: {
      networkPolicy: prepared.networkPolicy,
      projectDigest: inputDigest.projectDigest,
      entry: prepared.config.entry,
      sourceDigest: inputDigest.sourceDigest,
      configDigest: inputDigest.configDigest,
      lockDigest: inputDigest.lockDigest,
      tscircuit: {
        version: prepared.engineIdentity.project!.version,
        integrity: prepared.lock.tscircuit.integrity,
        contentSha256: prepared.engineIdentity.project!.contentSha256,
        runtimeClosureSha256: prepared.engineIdentity.project!.runtimeClosureSha256,
      },
    },
  });
}

function finishedCliRun(
  prepared: PreparedRun,
  result: Readonly<CommandResult>,
  json: boolean,
): CliRun {
  const relativeReport = projectRelative(prepared.project.root, prepared.reportPath);
  return Object.freeze({
    exitCode: CLI_EXIT_CODES[result.exitClassification],
    stdout: json
      ? `${JSON.stringify(result, null, 2)}\n`
      : boundedText(result, relativeReport),
    stderr: "",
    result,
    projectRoot: prepared.project.root,
    runDirectory: prepared.runDirectory,
    reportPath: prepared.reportPath,
  });
}

async function finishRun(
  prepared: PreparedRun,
  result: Readonly<CommandResult>,
  json: boolean,
  authority?: Readonly<{
    expectedInputDigest: Readonly<ProjectInputDigest>;
    evidence: Readonly<RunEvidenceAuthority>;
    verifyArtifacts?: () => void | Promise<void>;
    beforeReportPublication?: () => void | Promise<void>;
  }>,
): Promise<CliRun> {
  const assertNotCancelled = (): void => {
    if (prepared.signal?.aborted && result.exitClassification !== "cancelled") {
      throwIfFulmetryCancelled(prepared.signal, "Command cancelled before evidence publication");
    }
  };
  assertNotCancelled();
  await assertPreparedConfig(prepared);
  const currentInputDigest = await digestProjectInputs({
    projectRoot: prepared.project.root,
    entry: prepared.config.entry,
    outputDirectory: prepared.config.outputDirectory,
    profiles: prepared.config.profiles,
    ...(prepared.config.boardRevision === undefined
      ? {}
      : { boardRevision: prepared.config.boardRevision }),
    evaluateSimulationDefinitions: prepared.networkPolicy !== "offline",
  });
  const inputDigest = authority?.expectedInputDigest ?? currentInputDigest;
  const assertInputAuthority = (current: Readonly<ProjectInputDigest>): void => {
    if (current.projectDigest !== inputDigest.projectDigest) {
      throw new Error("Project inputs changed during command finalization; evidence was not published");
    }
  };
  const verifyAuthority = async (): Promise<void> => {
    if (authority === undefined) {
      await assertPreparedConfig(prepared);
      return;
    }
    await Promise.all([
      assertPreparedConfig(prepared),
      verifyRunEvidenceAuthority(prepared.runRootAuthority, prepared.project.root),
      authority.verifyArtifacts?.(),
      verifyRunEvidenceAuthority(authority.evidence, prepared.project.root),
      assertPreparedEngineIdentity(prepared),
    ]);
  };
  if (authority !== undefined) {
    assertNotCancelled();
    assertInputAuthority(currentInputDigest);
    await verifyAuthority();
    await prepared.beforeFinalReportPublication?.({
      command: result.command,
      runDirectory: prepared.runDirectory,
    });
    await authority.beforeReportPublication?.();
    assertNotCancelled();
    assertInputAuthority(await digestProjectInputs({
      projectRoot: prepared.project.root,
      entry: prepared.config.entry,
      outputDirectory: prepared.config.outputDirectory,
      profiles: prepared.config.profiles,
      ...(prepared.config.boardRevision === undefined
        ? {}
        : { boardRevision: prepared.config.boardRevision }),
      evaluateSimulationDefinitions: prepared.networkPolicy !== "offline",
    }));
    await verifyAuthority();
  }
  const contextualResult = contextualizeResult(prepared, result, inputDigest);
  const reportBytes = `${JSON.stringify(contextualResult, null, 2)}\n`;
  await atomicWrite(prepared.reportPath, reportBytes);
  if (authority !== undefined) {
    try {
      await prepared.afterReportPublication?.({
        command: result.command,
        reportPath: prepared.reportPath,
        runDirectory: prepared.runDirectory,
      });
      assertNotCancelled();
      assertInputAuthority(await digestProjectInputs({
        projectRoot: prepared.project.root,
        entry: prepared.config.entry,
        outputDirectory: prepared.config.outputDirectory,
        profiles: prepared.config.profiles,
        ...(prepared.config.boardRevision === undefined
          ? {}
          : { boardRevision: prepared.config.boardRevision }),
        evaluateSimulationDefinitions: prepared.networkPolicy !== "offline",
      }));
      await verifyAuthority();
      await verifyPublishedReport(prepared.reportPath, reportBytes);
    } catch (error) {
      await rm(prepared.reportPath, { recursive: true, force: true });
      throw error;
    }
  }
  return finishedCliRun(prepared, contextualResult, json);
}

async function captureProjectInputAuthority(
  prepared: PreparedRun,
  signal?: AbortSignal,
): Promise<Readonly<ProjectInputDigest>> {
  await prepared.beforeEvidenceInputCapture?.({ runDirectory: prepared.runDirectory });
  const digestOptions = {
    projectRoot: prepared.project.root,
    entry: prepared.config.entry,
    outputDirectory: prepared.config.outputDirectory,
    profiles: prepared.config.profiles,
    ...(prepared.config.boardRevision === undefined
      ? {}
      : { boardRevision: prepared.config.boardRevision }),
    evaluateSimulationDefinitions: prepared.networkPolicy !== "offline",
    ...(signal === undefined ? {} : { signal }),
  };
  const [, before] = await Promise.all([
    assertPreparedEngineIdentity(prepared),
    digestProjectInputs(digestOptions),
  ]);
  const [currentConfig, currentLock, after] = await Promise.all([
    loadProjectConfig(prepared.project.root),
    loadFulmetryLock(prepared.project.root),
    digestProjectInputs(digestOptions),
    assertPreparedEngineIdentity(prepared),
  ]);
  if (before.projectDigest !== after.projectDigest) {
    throw new Error("Project inputs changed while input authority was captured");
  }
  if (
    !isDeepStrictEqual(currentConfig, prepared.config) ||
    !isDeepStrictEqual(currentLock, prepared.lock)
  ) {
    throw new Error("Project configuration or lock changed after run preparation");
  }
  return after;
}

async function finishEvidenceRun(
  prepared: PreparedRun,
  result: Readonly<CommandResult>,
  json: boolean,
  inputAuthority: Readonly<ProjectInputDigest>,
  additions?: Readonly<{
    verifyArtifacts?: () => void | Promise<void>;
    beforeReportPublication?: () => void | Promise<void>;
  }>,
): Promise<CliRun> {
  if (prepared.signal?.aborted && result.exitClassification !== "cancelled") {
    throwIfFulmetryCancelled(prepared.signal, "Command cancelled before evidence publication");
  }
  const unhashed = result.artifacts.filter(({ digest }) => digest === undefined);
  if (unhashed.length > 0) {
    throw new Error(
      `Evidence artifacts lack author-time digests: ${unhashed.map(({ path }) => path).join(", ")}`,
    );
  }
  await verifyRunEvidenceAuthority(prepared.runRootAuthority, prepared.project.root);
  await prepared.beforeEvidenceAuthorityCapture?.({
    command: result.command,
    runDirectory: prepared.runDirectory,
  });
  const evidence = await captureRunEvidenceAuthority({
    runDirectory: prepared.runDirectory,
    projectRoot: prepared.project.root,
    reportPath: prepared.reportPath,
    artifacts: result.artifacts,
  });
  const { schemaVersion: _schemaVersion, ...resultFields } = result;
  const boundResult = commandResult({
    ...resultFields,
    artifacts: bindArtifactDigests(result.artifacts, evidence),
  });
  return finishRun(prepared, boundResult, json, {
    expectedInputDigest: inputAuthority,
    evidence,
    ...(additions?.verifyArtifacts === undefined
      ? {}
      : { verifyArtifacts: additions.verifyArtifacts }),
    ...(additions?.beforeReportPublication === undefined
      ? {}
      : { beforeReportPublication: additions.beforeReportPublication }),
  });
}

async function finishFailureRun(
  prepared: PreparedRun,
  result: Readonly<CommandResult>,
  json: boolean,
  errorPath: string,
): Promise<CliRun> {
  const inputDigest = prepared.preparedInputDigest;
  try {
    await verifyRunEvidenceAuthority(prepared.runRootAuthority, prepared.project.root);
    const evidence = await captureSelectedEvidenceAuthority({
      runDirectory: prepared.runDirectory,
      projectRoot: prepared.project.root,
      reportPath: prepared.reportPath,
      artifacts: result.artifacts,
    });
    const { schemaVersion: _schemaVersion, ...resultFields } = result;
    const boundResult = commandResult({
      ...resultFields,
      artifacts: bindArtifactDigests(result.artifacts, evidence),
    });
    const contextualResult = contextualizeResult(prepared, boundResult, inputDigest);
    const reportBytes = `${JSON.stringify(contextualResult, null, 2)}\n`;
    await verifyRunEvidenceAuthority(evidence, prepared.project.root);
    await prepared.beforeFailureReportPublication?.({
      command: result.command,
      errorPath,
      runDirectory: prepared.runDirectory,
    });
    await verifyRunEvidenceAuthority(evidence, prepared.project.root);
    await atomicWrite(prepared.reportPath, reportBytes);
    await prepared.afterFailureReportPublication?.({
      command: result.command,
      errorPath,
      reportPath: prepared.reportPath,
      runDirectory: prepared.runDirectory,
    });
    await verifyRunEvidenceAuthority(evidence, prepared.project.root);
    await verifyPublishedReport(prepared.reportPath, reportBytes);
    return finishedCliRun(prepared, contextualResult, json);
  } catch {
    // A failure-artifact publication race must never leave a stale reference.
    // The original command remains failed, while the report is downgraded to
    // an explicit zero-artifact error result.
    const { schemaVersion: _schemaVersion, ...resultFields } = result;
    const sanitized = contextualizeResult(prepared, commandResult({
      ...resultFields,
      artifacts: [],
    }), inputDigest);
    try {
      await verifyRunEvidenceAuthority(prepared.runRootAuthority, prepared.project.root);
    } catch {
      return Object.freeze({
        exitCode: CLI_EXIT_CODES[sanitized.exitClassification],
        stdout: json
          ? `${JSON.stringify(sanitized, null, 2)}\n`
          : boundedText(sanitized, "report unavailable: run-directory identity changed"),
        stderr: "",
        result: sanitized,
        projectRoot: prepared.project.root,
      });
    }
    await rm(prepared.reportPath, { recursive: true, force: true });
    const reportBytes = `${JSON.stringify(sanitized, null, 2)}\n`;
    await atomicWrite(prepared.reportPath, reportBytes);
    await verifyPublishedReport(prepared.reportPath, reportBytes);
    return finishedCliRun(prepared, sanitized, json);
  }
}

async function runBuild(prepared: PreparedRun, json: boolean, signal?: AbortSignal): Promise<CliRun> {
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  const evaluated = await evaluateProjectCircuitTwice(prepared.project.root, {
    expectedConfig: prepared.config,
    ...(signal === undefined ? {} : { signal }),
  });
  const pcbBoards = evaluated.circuitJson.filter(({ type }) => type === "pcb_board") as unknown as ReadonlyArray<{
    readonly pcb_board_id: string;
    readonly source_board_id?: string;
  }>;
  const sourceBoards = evaluated.circuitJson.filter(({ type }) => type === "source_board") as unknown as ReadonlyArray<{
    readonly source_board_id: string;
    readonly source_group_id?: string;
  }>;
  const sourceGroups = evaluated.circuitJson.filter(({ type }) => type === "source_group") as unknown as ReadonlyArray<{
    readonly source_group_id: string;
    readonly subcircuit_id?: string;
    readonly parent_source_group_id?: string;
    readonly parent_subcircuit_id?: string;
    readonly is_subcircuit?: boolean;
  }>;
  const rootGroups = sourceGroups.filter((group) =>
    group.parent_source_group_id === undefined && group.parent_subcircuit_id === undefined
  );
  const groupsById = new Map(sourceGroups.map((group) => [group.source_group_id, group] as const));
  const groupsBySubcircuitId = new Map(
    sourceGroups.flatMap((group) => group.subcircuit_id === undefined
      ? []
      : [[group.subcircuit_id, group] as const]),
  );
  let groupGraphValid = groupsById.size === sourceGroups.length &&
    groupsBySubcircuitId.size === sourceGroups.filter(({ subcircuit_id }) => subcircuit_id !== undefined).length;
  const parentByGroupId = new Map<string, string>();
  for (const group of sourceGroups) {
    const parentById = group.parent_source_group_id === undefined
      ? undefined
      : groupsById.get(group.parent_source_group_id);
    const parentBySubcircuit = group.parent_subcircuit_id === undefined
      ? undefined
      : groupsBySubcircuitId.get(group.parent_subcircuit_id);
    if (group.parent_source_group_id === undefined && group.parent_subcircuit_id === undefined) continue;
    if (
      (group.parent_source_group_id !== undefined && parentById === undefined) ||
      (group.parent_subcircuit_id !== undefined && parentBySubcircuit === undefined) ||
      (parentById !== undefined && parentBySubcircuit !== undefined && parentById !== parentBySubcircuit)
    ) {
      groupGraphValid = false;
      continue;
    }
    const parent = parentById ?? parentBySubcircuit;
    if (parent === undefined || parent.source_group_id === group.source_group_id) {
      groupGraphValid = false;
      continue;
    }
    parentByGroupId.set(group.source_group_id, parent.source_group_id);
  }
  if (rootGroups.length === 1) {
    for (const group of sourceGroups) {
      const visited = new Set<string>();
      let cursor: string | undefined = group.source_group_id;
      while (cursor !== rootGroups[0]!.source_group_id) {
        if (visited.has(cursor)) {
          groupGraphValid = false;
          break;
        }
        visited.add(cursor);
        cursor = parentByGroupId.get(cursor);
        if (cursor === undefined) {
          groupGraphValid = false;
          break;
        }
      }
    }
  } else {
    groupGraphValid = false;
  }
  const pcbSourceBoardId = pcbBoards.length === 1
    ? (pcbBoards[0] as unknown as { readonly source_board_id?: unknown }).source_board_id
    : undefined;
  const sourceGroupId = sourceBoards.length === 1 ? sourceBoards[0]!.source_group_id : undefined;
  const cardinalityValid = groupGraphValid && pcbBoards.length === 1 && sourceBoards.length === 1 &&
    rootGroups.length === 1 && typeof pcbSourceBoardId === "string" &&
    pcbSourceBoardId === sourceBoards[0]!.source_board_id &&
    sourceGroupId === rootGroups[0]!.source_group_id && rootGroups[0]!.is_subcircuit === true &&
    typeof rootGroups[0]!.subcircuit_id === "string" && rootGroups[0]!.subcircuit_id!.length > 0;
  if (!cardinalityValid) {
    const baseDiagnostic = defineDiagnostic({
      id: diagnosticId("PROJECT_BOARD_CARDINALITY_UNSUPPORTED_001"),
      severity: "error",
      dimension: "fabrication",
      message: "Fulmetry projects must normalize to exactly one linked source board, PCB board, and root assembly",
      waiverPolicy: "forbidden",
      objects: sourceGroups.length > 0
        ? sourceGroups.map(({ source_group_id }) => source_group_id)
        : [
          ...sourceBoards.map(({ source_board_id }) => source_board_id),
          ...pcbBoards.map(({ pcb_board_id }) => pcb_board_id),
        ],
      sourceLocations: [],
      measurement: {
        actual: `${sourceBoards.length} source board(s), ${pcbBoards.length} PCB board(s), ${rootGroups.length} root assembly group(s)`,
        required: "1 linked source board, 1 PCB board, 1 root assembly group",
      },
      evidence: ["project-contract:single-board-single-assembly"],
      nextCommand: "fulmetry inspect --status fabrication --rule FAB_BOARD_COUNT_001",
    });
    const [located] = await enrichDiagnosticProvenance({
      projectRoot: prepared.project.root,
      entry: prepared.config.entry,
      circuitJson: evaluated.circuitJson,
      diagnostics: [baseDiagnostic],
      allowInternalDetailSelectors: true,
    });
    const diagnostic = located!.sourceLocations.length > 0
      ? located!
      : defineDiagnostic({ ...located!, sourceLocations: [`${prepared.config.entry}:1:1`] });
    const statuses = statusSet({
      ...unassessedStatusSet(),
      fabrication: assuranceStatus("fabrication", "incomplete", {
        diagnosticIds: [diagnostic.id],
        summary: "Project board or root assembly cardinality is unsupported",
      }),
    });
    return finishEvidenceRun(prepared, commandResult({
      command: "fulmetry build",
      runId: prepared.runId,
      exitClassification: "unsupported",
      requestedDimensions: [],
      statuses,
      diagnostics: [diagnostic],
      artifacts: [],
    }), json, inputAuthority);
  }
  const artifact = await writeCircuitArtifact(prepared, evaluated.canonicalJson);
  const result = commandResult({
    command: "fulmetry build",
    runId: prepared.runId,
    exitClassification: "success",
    requestedDimensions: [],
    statuses: unassessedStatusSet(),
    artifacts: [artifact],
  });
  return finishEvidenceRun(prepared, result, json, inputAuthority);
}

async function assessProject(
  prepared: PreparedRun,
  inputAuthority: Readonly<ProjectInputDigest>,
  signal?: AbortSignal,
) {
  const evaluated = await evaluateProjectCircuitTwice(prepared.project.root, {
    expectedConfig: prepared.config,
    ...(signal === undefined ? {} : { signal }),
  });
  const electrical = assessCircuitElectrical(evaluated.circuitJson);
  const fabrication = assessCircuitFabrication(
    evaluated.circuitJson,
    activeFabricationProfile(prepared.config, prepared.lock),
  );
  const sourcing = assessRecordedSourcing({
    circuitJson: evaluated.circuitJson,
    lock: prepared.lock,
  });
  const diagnostics = await enrichDiagnosticProvenance({
    projectRoot: prepared.project.root,
    entry: prepared.config.entry,
    circuitJson: evaluated.circuitJson,
    diagnostics: [...electrical.diagnostics, ...fabrication.diagnostics, ...sourcing.diagnostics],
    allowInternalDetailSelectors: true,
  });
  const initialStatuses = mergeAssessmentStatuses(
    fabrication.status,
    electrical.status,
    assuranceStatus("standards", "not-run"),
    sourcing.status,
  );
  const waiverSnapshot = await captureDraftExportInputSnapshot(prepared, inputAuthority);
  const waiverDeclarations = await loadDeclaredWaivers(
    prepared.project.root,
    waiverSnapshot,
  );
  const waiverEvaluationDate = new Date().toISOString().slice(0, 10);
  const waiverApplication = applyDeclaredWaivers({
    diagnostics,
    statuses: initialStatuses,
    declarations: waiverDeclarations,
    evaluationDate: waiverEvaluationDate,
  });
  const fabricationDiagnostics = waiverApplication.diagnostics.filter(
    ({ dimension }) => dimension === "fabrication",
  );
  return Object.freeze({
    evaluated,
    electrical,
    fabrication: Object.freeze({
      ...fabrication,
      status: waiverApplication.statuses.fabrication,
      diagnostics: Object.freeze(fabricationDiagnostics),
    }),
    sourcing,
    statuses: waiverApplication.statuses,
    diagnostics: waiverApplication.diagnostics,
    waiverAuthority: Object.freeze({
      declarations: waiverDeclarations,
      evaluationDate: waiverEvaluationDate,
    }),
  });
}

async function writeCircuitArtifact(
  prepared: PreparedRun,
  canonicalJson: string,
): Promise<ArtifactReference> {
  const circuitPath = join(prepared.runDirectory, "circuit.json");
  const bytes = withOneFinalNewline(canonicalJson);
  await atomicWrite(circuitPath, bytes);
  return Object.freeze({
    kind: "circuit-json",
    path: projectRelative(prepared.project.root, circuitPath),
    digest: sha256(bytes),
  });
}

async function runRouteFreerouting(
  prepared: PreparedRun,
  json: boolean,
  invocation: ParsedFreeroutingInvocation,
  javaExecutable?: string | null,
  signal?: AbortSignal,
): Promise<CliRun> {
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  const evaluated = await evaluateProjectCircuitTwice(prepared.project.root, {
    expectedConfig: prepared.config,
    ...(signal === undefined ? {} : { signal }),
  });
  const candidate = await runFreeroutingCandidate({
    circuitJson: evaluated.circuitJson,
    runDirectory: prepared.runDirectory,
    clearanceMm: invocation.clearanceMm,
    jarPath: invocation.jarPath,
    jarSha256: invocation.jarSha256,
    freeroutingVersion: FREEROUTING_SUPPORTED_VERSION,
    ...(javaExecutable === undefined ? {} : { javaExecutable }),
    ...(invocation.heapMb === undefined ? {} : { heapMb: invocation.heapMb }),
    ...(invocation.threads === undefined ? {} : { threads: invocation.threads }),
    ...(invocation.maxPasses === undefined ? {} : { maxPasses: invocation.maxPasses }),
    ...(invocation.timeoutMs === undefined ? {} : { timeoutMs: invocation.timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  });
  const evidencePath = join(prepared.runDirectory, "freerouting-evidence.json");
  const evidenceBytes = `${JSON.stringify({
    schemaVersion: 1,
    state: candidate.state,
    message: candidate.message,
    evidence: candidate.evidence,
  }, null, 2)}\n`;
  await atomicWrite(evidencePath, evidenceBytes);
  const artifacts: ArtifactReference[] = [{
    kind: "freerouting-evidence",
    path: projectRelative(prepared.project.root, evidencePath),
    digest: sha256(evidenceBytes),
  }];
  for (const artifact of candidate.workspaceArtifacts ?? []) {
    artifacts.push({
      kind: artifact.kind,
      path: projectRelative(prepared.project.root, artifact.path),
      digest: artifact.digest,
    });
  }
  if (candidate.candidateCircuitJson !== undefined) {
    const candidatePath = join(prepared.runDirectory, "candidate-circuit.json");
    const candidateBytes = canonicalCircuitJson(candidate.candidateCircuitJson);
    await atomicWrite(candidatePath, candidateBytes);
    artifacts.push({
      kind: "candidate-circuit-json",
      path: projectRelative(prepared.project.root, candidatePath),
      digest: sha256(candidateBytes),
    });
  }
  const diagnostic = defineDiagnostic({
    id: diagnosticId(candidate.state === "candidate"
      ? "ROUTE_CANDIDATE_REVIEW_REQUIRED_001"
      : candidate.state === "unavailable"
      ? "ROUTE_FREEROUTING_UNAVAILABLE_001"
      : "ROUTE_FREEROUTING_FAILED_001"),
    severity: candidate.state === "candidate" ? "warning" : "error",
    dimension: "functional",
    message: candidate.message,
    waiverPolicy: "forbidden",
    objects: [],
    sourceLocations: [],
    evidence: [`freerouting:adapter:${candidate.evidence.adapter.version}`],
    nextCommand: candidate.state === "candidate"
      ? "Review candidate-circuit.json, then promote stable semantic routes into source"
      : "Inspect freerouting-evidence.json and correct the qualified tool setup",
  });
  return finishEvidenceRun(prepared, commandResult({
    command: "fulmetry route freerouting",
    runId: prepared.runId,
    exitClassification: candidate.state === "candidate"
      ? "incomplete"
      : candidate.state === "failed"
      ? "failure"
      : "unavailable",
    requestedDimensions: [],
    statuses: unassessedStatusSet(),
    diagnostics: [diagnostic],
    artifacts,
  }), json, inputAuthority);
}

async function runRoutePromote(
  cwd: string,
  json: boolean,
  invocation: ParsedRoutePromotionInvocation,
): Promise<CliRun> {
  const project = await discoverProject(cwd);
  const config = await loadProjectConfig(project.root);
  const candidatePath = resolve(project.root, invocation.candidatePath);
  const candidateRelative = relative(project.root, candidatePath).replaceAll("\\", "/");
  if (candidateRelative === "" || candidateRelative === ".." || candidateRelative.startsWith("../")) {
    throw new Error("Route candidate must be a file inside the Fulmetry project");
  }
  const candidateStat = await lstat(candidatePath);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error("Route candidate must be a regular, non-symlink file");
  }
  const candidateBytes = await readBoundedRegularFile(candidatePath, 64 * 1024 * 1024);
  const candidateText = new TextDecoder("utf-8", { fatal: true }).decode(candidateBytes);
  const circuitJson = parseCanonicalRouteCandidateCircuitJson(candidateText);
  const sourceSet = renderPromotedRouteSourceSet(circuitJson, {
    defaultViaHoleDiameter: invocation.viaHoleMm,
    defaultViaOuterDiameter: invocation.viaOuterMm,
  });
  const outputDirectory = resolve(project.root, invocation.outputDirectory);
  const outputRelative = relative(project.root, outputDirectory).replaceAll("\\", "/");
  if (outputRelative === "" || outputRelative === ".." || outputRelative.startsWith("../")) {
    throw new Error("Route source output must be a new directory inside the Fulmetry project");
  }
  const generatedPrefix = config.outputDirectory.replaceAll("\\", "/").replace(/\/$/u, "");
  if (outputRelative === generatedPrefix || outputRelative.startsWith(`${generatedPrefix}/`)) {
    throw new Error("Promoted authored routes cannot be written inside generated Fulmetry output");
  }
  await assertNoSymlinkOutputPath(project.root, outputRelative);
  let created = false;
  try {
    await mkdir(outputDirectory, { recursive: false });
    created = true;
    const artifacts: ArtifactReference[] = [];
    for (const module of sourceSet.modules) {
      const path = join(outputDirectory, module.fileName);
      await writeFile(path, module.source, { flag: "wx" });
      artifacts.push({
        kind: "authored-route-source",
        path: projectRelative(project.root, path),
        digest: sha256(module.source),
      });
    }
    const indexPath = join(outputDirectory, "index.ts");
    await writeFile(indexPath, sourceSet.indexSource, { flag: "wx" });
    artifacts.push({
      kind: "authored-route-index",
      path: projectRelative(project.root, indexPath),
      digest: sha256(sourceSet.indexSource),
    });
    const result = commandResult({
      command: "fulmetry route promote",
      runId: "source-promotion",
      exitClassification: "success",
      requestedDimensions: [],
      statuses: unassessedStatusSet(),
      artifacts,
    });
    return Object.freeze({
      exitCode: CLI_EXIT_CODES.success,
      stdout: json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Promoted ${sourceSet.routes.length} candidate traces into ${sourceSet.modules.length} semantic net modules at ${outputRelative}\n`,
      stderr: "",
      result,
      projectRoot: project.root,
    });
  } catch (error) {
    if (created) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function runCheck(prepared: PreparedRun, json: boolean, signal?: AbortSignal): Promise<CliRun> {
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  const assessment = await assessProject(prepared, inputAuthority, signal);
  const sourceOnly = sourceOnlyAssessment(assessment);
  const requestedDimensions = ["electrical", "fabrication"] as const;
  const artifact = await writeCircuitArtifact(prepared, assessment.evaluated.canonicalJson);
  const sourcingPath = join(prepared.runDirectory, "sourcing", "recorded-evidence.json");
  await mkdir(dirname(sourcingPath), { recursive: true });
  const sourcingBytes = `${JSON.stringify(assessment.sourcing.evidence, null, 2)}\n`;
  await atomicWrite(sourcingPath, sourcingBytes);
  const result = commandResult({
    command: "fulmetry check",
    runId: prepared.runId,
    exitClassification: classify(
      sourceOnly.statuses,
      requestedDimensions,
      sourceOnly.diagnostics,
    ),
    requestedDimensions,
    statuses: sourceOnly.statuses,
    diagnostics: sourceOnly.diagnostics,
    sourcingEvidence: assessment.sourcing.evidence,
    artifacts: [artifact, {
      kind: "sourcing-evidence",
      path: projectRelative(prepared.project.root, sourcingPath),
      digest: sha256(sourcingBytes),
    }],
  });
  return finishEvidenceRun(prepared, result, json, inputAuthority);
}

function projectTestDiagnostic(
  execution: Readonly<ProjectTestExecution>,
  summaryPath: string,
): Readonly<Diagnostic> | undefined {
  if (execution.outcome === "passed") return undefined;
  const details = {
    "no-test-files": {
      id: "TEST_NO_TEST_FILES_001",
      message: "No standard .test.ts or .test.tsx project test files were found",
    },
    "no-test-cases": {
      id: "TEST_NO_TEST_CASES_001",
      message: "Bun discovered test files but executed no test cases",
    },
    "skipped-tests": {
      id: "TEST_SKIPPED_001",
      message: "Bun skipped one or more project tests, so functional validation is incomplete",
    },
    "focused-tests": {
      id: "TEST_FOCUSED_DECLARATION_001",
      message: "Focused Bun test declarations would omit part of the project test suite",
    },
    "expected-failing-tests": {
      id: "TEST_EXPECTED_FAILURE_DECLARATION_001",
      message: "Expected-failure Bun tests do not prove the declared behavior and cannot count as passed",
    },
    "subprocess-forbidden": {
      id: "TEST_SUBPROCESS_CONTAINMENT_UNAVAILABLE_001",
      message: "Authoritative project tests cannot spawn subprocesses; use Fulmetry's bounded build, simulation, and external-tool actions",
    },
    "offline-containment-unavailable": {
      id: "TEST_OFFLINE_CONTAINMENT_UNAVAILABLE_001",
      message: "Authoritative project tests cannot run under offline policy until macOS process network containment is qualified",
    },
    "process-containment-unavailable": {
      id: "TEST_PROCESS_CONTAINMENT_UNAVAILABLE_001",
      message: "Authoritative project tests require the declared operating-system process containment authority",
    },
    "process-containment-violation": {
      id: "TEST_PROCESS_CONTAINMENT_VIOLATION_001",
      message: "A project test attempted to leave a child process after its contained test runner exited",
    },
    "test-failures": {
      id: "TEST_FAILED_001",
      message: "One or more project tests failed",
    },
    "runner-exit": {
      id: "TEST_RUNNER_EXIT_001",
      message: "Bun test exited nonzero without complete failure counts",
    },
    "runner-output-invalid": {
      id: "TEST_RUNNER_EVIDENCE_INVALID_001",
      message: "Bun test did not produce a valid reconciled JUnit summary",
    },
    timeout: {
      id: "TEST_TIMEOUT_001",
      message: `Project tests exceeded the ${execution.execution.timeoutMs} ms execution limit`,
    },
    "output-limit": {
      id: "TEST_OUTPUT_LIMIT_001",
      message: "Project test output exceeded a bounded evidence limit",
    },
    cancelled: {
      id: "TEST_CANCELLED_001",
      message: "Project test execution was cancelled",
    },
    "start-failed": {
      id: "TEST_RUNNER_START_FAILED_001",
      message: "The pinned Bun test process could not be started",
    },
  } as const;
  const detail = details[execution.reason as Exclude<typeof execution.reason, "passed">];
  const counts = execution.counts;
  const measurement = execution.reason === "timeout"
    ? { actual: `>${execution.execution.timeoutMs} ms`, required: `<=${execution.execution.timeoutMs} ms` }
    : execution.reason === "output-limit"
      ? {
          actual: `stdout=${execution.execution.stdoutExceeded ? ">" : "<="}${execution.execution.outputLimitBytes} bytes, stderr=${execution.execution.stderrExceeded ? ">" : "<="}${execution.execution.outputLimitBytes} bytes, junit=${execution.execution.junitExceeded ? ">" : "<="}4194304 bytes`,
          required: "every captured stream within its declared limit",
        }
      : counts === null
        ? undefined
        : {
            actual: `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.executed} executed`,
            required: "at least 1 executed, 0 failed, 0 skipped",
          };
  return defineDiagnostic({
    id: diagnosticId(detail.id),
    severity: "error",
    dimension: "functional",
    message: detail.message,
    waiverPolicy: "forbidden",
    objects: execution.testFiles,
    sourceLocations: execution.reason === "focused-tests" &&
        execution.inputAuthority.focusedDeclarations.length > 0
      ? execution.inputAuthority.focusedDeclarations
      : execution.testFiles.map((path) => `${path}:1:1`),
    ...(measurement === undefined ? {} : { measurement }),
    evidence: [
      `bun:${Bun.version}`,
      `exit:${execution.execution.exitCode ?? "none"}`,
      `test-summary:${summaryPath}`,
    ],
    nextCommand: `Read ${summaryPath}`,
  });
}

async function runProjectTestCommand(
  prepared: PreparedRun,
  json: boolean,
  signal?: AbortSignal,
  limits?: Readonly<{ timeoutMs?: number; outputLimit?: number }>,
): Promise<CliRun> {
  // The project input authority deliberately does not use the caller's signal:
  // cancellation is represented as functional test evidence once the bounded
  // child boundary starts, rather than being laundered into a generic success.
  const inputAuthority = await captureProjectInputAuthority(prepared);
  const testDirectory = join(prepared.runDirectory, "project-tests");
  await mkdir(testDirectory);
  const execution = await runBunProjectTests({
    projectRoot: prepared.project.root,
    outputDirectory: prepared.config.outputDirectory,
    runDirectory: testDirectory,
    offline: prepared.networkPolicy === "offline",
    ...(signal === undefined ? {} : { signal }),
    ...(limits?.timeoutMs === undefined ? {} : { timeoutMs: limits.timeoutMs }),
    ...(limits?.outputLimit === undefined ? {} : { outputLimit: limits.outputLimit }),
  });
  // A passing process cannot authenticate stale or swapped test code. This is
  // checked immediately and again at the final publication boundary.
  await verifyProjectTestInputAuthority(execution.inputAuthority, {
    projectRoot: prepared.project.root,
    outputDirectory: prepared.config.outputDirectory,
  });

  const stdoutPath = join(testDirectory, "stdout.bin");
  const stderrPath = join(testDirectory, "stderr.bin");
  const junitPath = join(testDirectory, "captured-junit.xml");
  const summaryPath = join(testDirectory, "summary.json");
  const relativeSummaryPath = projectRelative(prepared.project.root, summaryPath);
  await atomicWrite(stdoutPath, execution.stdout);
  await atomicWrite(stderrPath, execution.stderr);
  if (execution.junit !== null) await atomicWrite(junitPath, execution.junit);
  const summary = Object.freeze({
    schemaVersion: 1 as const,
    runner: Object.freeze({ name: "bun" as const, version: Bun.version }),
    outcome: execution.outcome,
    reason: execution.reason,
    testFiles: execution.testFiles,
    sourceInputs: Object.freeze(execution.inputAuthority.sourceFiles.map(({ path, size, sha256 }) =>
      Object.freeze({ path, size, sha256 })
    )),
    focusedDeclarations: execution.inputAuthority.focusedDeclarations,
    subprocessDeclarations: execution.inputAuthority.subprocessDeclarations,
    counts: execution.counts,
    execution: execution.execution,
  });
  const summaryBytes = `${JSON.stringify(summary, null, 2)}\n`;
  await atomicWrite(summaryPath, summaryBytes);

  const artifacts: ArtifactReference[] = [
    { kind: "project-test-summary", path: relativeSummaryPath, digest: sha256(summaryBytes) },
    { kind: "project-test-stdout", path: projectRelative(prepared.project.root, stdoutPath), digest: sha256(execution.stdout) },
    { kind: "project-test-stderr", path: projectRelative(prepared.project.root, stderrPath), digest: sha256(execution.stderr) },
  ];
  if (execution.junit !== null) {
    artifacts.push({
      kind: "project-test-junit",
      path: projectRelative(prepared.project.root, junitPath),
      digest: sha256(execution.junit),
    });
  }
  const diagnostic = projectTestDiagnostic(execution, relativeSummaryPath);
  const functional = assuranceStatus(
    "functional",
    execution.outcome === "passed"
      ? "passed"
      : execution.outcome === "failed"
        ? "failed"
        : "incomplete",
    diagnostic === undefined
      ? { summary: `${execution.counts!.passed} project tests passed` }
      : {
          diagnosticIds: [diagnostic.id],
          summary: diagnostic.message,
        },
  );
  const statuses = statusSet({ ...unassessedStatusSet(), functional });
  const result = commandResult({
    command: "fulmetry test",
    runId: prepared.runId,
    exitClassification: execution.outcome === "cancelled"
      ? "cancelled"
      : classify(statuses, ["functional"], diagnostic === undefined ? [] : [diagnostic]),
    requestedDimensions: ["functional"],
    statuses,
    diagnostics: diagnostic === undefined ? [] : [diagnostic],
    artifacts,
  });
  return finishEvidenceRun(prepared, result, json, inputAuthority, {
    verifyArtifacts: () => verifyProjectTestInputAuthority(execution.inputAuthority, {
      projectRoot: prepared.project.root,
      outputDirectory: prepared.config.outputDirectory,
    }),
  });
}

interface InspectFilters {
  readonly target?: string;
  readonly status?: StatusDimension;
  readonly rule?: string;
}

function parseInspect(words: readonly string[]): InspectFilters {
  let target: string | undefined;
  let status: StatusDimension | undefined;
  let rule: string | undefined;
  const dimensions = new Set<StatusDimension>([
    "fabrication",
    "electrical",
    "functional",
    "standards",
    "sourcing",
  ]);
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--status") {
      const value = words[++index];
      if (value === undefined || !dimensions.has(value as StatusDimension) || status !== undefined) {
        throw new TypeError("--status requires one valid, non-repeated status dimension");
      }
      status = value as StatusDimension;
    } else if (word === "--rule") {
      const value = words[++index];
      if (value === undefined || rule !== undefined) {
        throw new TypeError("--rule requires one non-repeated diagnostic id");
      }
      rule = String(diagnosticId(value));
    } else if (word.startsWith("--")) {
      throw new TypeError(`Unknown inspect option ${word}`);
    } else if (target === undefined) {
      target = word;
    } else {
      throw new TypeError("inspect accepts at most one target");
    }
  }
  return Object.freeze({
    ...(target === undefined ? {} : { target }),
    ...(status === undefined ? {} : { status }),
    ...(rule === undefined ? {} : { rule }),
  });
}

async function runInspect(
  prepared: PreparedRun,
  json: boolean,
  filters: InspectFilters,
  signal?: AbortSignal,
): Promise<CliRun> {
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  const assessment = await assessProject(prepared, inputAuthority, signal);
  const sourceOnly = sourceOnlyAssessment(assessment);
  const focusedDiagnostics = sourceOnly.diagnostics.filter((diagnostic) =>
    (filters.status === undefined || diagnostic.dimension === filters.status) &&
    (filters.rule === undefined || diagnostic.id === filters.rule) &&
    (filters.target === undefined || diagnostic.objects.some((object) =>
      diagnosticObjectMatchesTarget(object, filters.target!)
    ))
  );
  const requestedDimensions = filters.status === undefined
    ? (["electrical", "fabrication"] as const)
    : ([filters.status] as const);
  const artifact = await writeCircuitArtifact(prepared, assessment.evaluated.canonicalJson);
  const sourcingPath = join(prepared.runDirectory, "sourcing", "recorded-evidence.json");
  await mkdir(dirname(sourcingPath), { recursive: true });
  const sourcingBytes = `${JSON.stringify(assessment.sourcing.evidence, null, 2)}\n`;
  await atomicWrite(sourcingPath, sourcingBytes);
  const matchedObjects = filters.target === undefined ? [] : assessment.evaluated.circuitJson.filter(
    (element) => Object.entries(element as Record<string, unknown>).some(([key, value]) =>
      typeof value === "string" && value === filters.target &&
      (key === "name" || key.endsWith("_id"))
    ),
  );
  const selection = completeInspectDiagnosticSelection(
    sourceOnly.diagnostics,
    focusedDiagnostics,
    filters,
    matchedObjects.length > 0,
  );
  const diagnostics = [...selection.diagnostics];
  const forcedFailure = selection.forcedFailure;
  if (
    filters.status === "sourcing" && filters.rule === undefined &&
    filters.target === undefined
  ) {
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("SRC_RECORDED_EVIDENCE_001"),
      severity: "info",
      dimension: "sourcing",
      message: "Focused sourcing inspection includes the exact recorded-selection evidence; it is not live provider availability",
      waiverPolicy: "forbidden",
      objects: assessment.sourcing.evidence.selections.map(({ designator }) => designator),
      sourceLocations: [],
      evidence: ["sourcing:recorded-offline"],
      nextCommand: `Read ${projectRelative(prepared.project.root, sourcingPath)}`,
    }));
  }
  const visibleIds = new Set(diagnostics.map(({ id }) => String(id)));
  const focusedStatuses = statusSet({
    fabrication: assuranceStatus("fabrication", sourceOnly.statuses.fabrication.state, {
      diagnosticIds: sourceOnly.statuses.fabrication.diagnosticIds.filter((id) => visibleIds.has(id)),
      ...(sourceOnly.statuses.fabrication.summary === undefined
        ? {}
        : { summary: sourceOnly.statuses.fabrication.summary }),
    }),
    electrical: assuranceStatus("electrical", sourceOnly.statuses.electrical.state, {
      diagnosticIds: sourceOnly.statuses.electrical.diagnosticIds.filter((id) => visibleIds.has(id)),
      ...(sourceOnly.statuses.electrical.summary === undefined
        ? {}
        : { summary: sourceOnly.statuses.electrical.summary }),
    }),
    functional: assuranceStatus("functional", sourceOnly.statuses.functional.state, {
      diagnosticIds: sourceOnly.statuses.functional.diagnosticIds.filter((id) => visibleIds.has(id)),
      ...(sourceOnly.statuses.functional.summary === undefined
        ? {}
        : { summary: sourceOnly.statuses.functional.summary }),
    }),
    standards: assuranceStatus("standards", sourceOnly.statuses.standards.state, {
      diagnosticIds: sourceOnly.statuses.standards.diagnosticIds.filter((id) => visibleIds.has(id)),
      ...(sourceOnly.statuses.standards.summary === undefined
        ? {}
        : { summary: sourceOnly.statuses.standards.summary }),
    }),
    sourcing: sourcingStatus(sourceOnly.statuses.sourcing.state, {
      diagnosticIds: sourceOnly.statuses.sourcing.diagnosticIds.filter((id) => visibleIds.has(id)),
      ...(sourceOnly.statuses.sourcing.summary === undefined
        ? {}
        : { summary: sourceOnly.statuses.sourcing.summary }),
      ...(sourceOnly.statuses.sourcing.checkedAt === undefined
        ? {}
        : { checkedAt: sourceOnly.statuses.sourcing.checkedAt }),
    }),
  });
  const inspectArtifacts: ArtifactReference[] = [artifact, {
    kind: "sourcing-evidence",
    path: projectRelative(prepared.project.root, sourcingPath),
    digest: sha256(sourcingBytes),
  }];
  if (filters.target !== undefined && matchedObjects.length > 0) {
    const inspectionPath = join(prepared.runDirectory, "inspection.json");
    const inspectionBytes = `${JSON.stringify({
      schemaVersion: "1",
      target: filters.target,
      objects: matchedObjects,
    }, null, 2)}\n`;
    await atomicWrite(inspectionPath, inspectionBytes);
    inspectArtifacts.push({
      kind: "inspection",
      path: projectRelative(prepared.project.root, inspectionPath),
      digest: sha256(inspectionBytes),
    });
  }
  const result = commandResult({
    command: "fulmetry inspect",
    runId: prepared.runId,
    exitClassification: forcedFailure
      ? "failure"
      : classify(focusedStatuses, requestedDimensions, diagnostics),
    requestedDimensions,
    statuses: focusedStatuses,
    diagnostics,
    sourcingEvidence: assessment.sourcing.evidence,
    artifacts: inspectArtifacts,
  });
  return finishEvidenceRun(prepared, result, json, inputAuthority);
}

function manufacturingDiagnostics(
  verification: Awaited<ReturnType<typeof verifyManufacturingDirectory>>,
  artifactRoot: string,
): readonly Diagnostic[] {
  return verification.findings.map((finding) => defineDiagnostic({
    id: diagnosticId(`MFG_${finding.code}_001`),
    severity: "error",
    dimension: "fabrication",
    message: finding.message,
    waiverPolicy: "forbidden",
    objects: finding.objects ?? (finding.path === undefined
      ? (/^([A-Za-z][A-Za-z0-9_-]*):/u.exec(finding.message)?.[1] === undefined
        ? []
        : [/^([A-Za-z][A-Za-z0-9_-]*):/u.exec(finding.message)![1]!])
      : [finding.path]),
    sourceLocations: finding.path === undefined
      ? []
      : [`${artifactRoot}/${finding.path}:${/^line (\d+):/u.exec(finding.message)?.[1] ?? "1"}:1`],
    ...(finding.measurement === undefined ? {} : { measurement: finding.measurement }),
    evidence: finding.path === undefined ? [] : [`manufacturing:${finding.path}`],
    nextCommand: `fulmetry inspect --status fabrication --rule MFG_${finding.code}_001`,
  }));
}

async function runVerifyManufacturing(
  prepared: PreparedRun,
  json: boolean,
  signal?: AbortSignal,
  hooks?: RunCliOptions["manufacturingTestHooks"],
): Promise<CliRun> {
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  const manufacturingPackages = await requireManufacturingPackageIdentity();
  const assessment = await assessProject(prepared, inputAuthority, signal);
  const files = await exportManufacturingFiles({
    boardName: "board",
    circuitJson: assessment.evaluated.circuitJson,
  });
  const manufacturingDirectory = join(prepared.runDirectory, "manufacturing-draft");
  const paths = await emitDraftManufacturingDirectory({
    targetDirectory: manufacturingDirectory,
    files,
  });
  const expectation = deriveManufacturingExpectation({
    boardName: "board",
    circuitJson: assessment.evaluated.circuitJson,
  });
  const verification = await verifyManufacturingDirectory({
    root: manufacturingDirectory,
    expectation,
    circuitJson: assessment.evaluated.circuitJson,
  });
  await hooks?.afterVerification?.({ manufacturingDirectory });
  const activeProfile = activeFabricationProfile(prepared.config, prepared.lock);
  const standards = assessBaselinePreCompliance({
    circuitJson: assessment.evaluated.circuitJson,
    ...(activeProfile === undefined ? {} : { activeProfile }),
    manufacturingVerification: verification,
    sourceWaivers: assessment.waiverAuthority,
  });
  const standardsPath = join(prepared.runDirectory, "standards", "pre-compliance.json");
  await mkdir(dirname(standardsPath), { recursive: true });
  const standardsBytes = `${JSON.stringify(standards.evidence, null, 2)}\n`;
  await atomicWrite(standardsPath, standardsBytes);
  const sourcing = assessRecordedSourcing({
    circuitJson: assessment.evaluated.circuitJson,
    lock: prepared.lock,
  });
  const sourcingPath = join(prepared.runDirectory, "sourcing", "recorded-evidence.json");
  await mkdir(dirname(sourcingPath), { recursive: true });
  const sourcingBytes = `${JSON.stringify(sourcing.evidence, null, 2)}\n`;
  await atomicWrite(sourcingPath, sourcingBytes);
  const enrichedIndependentDiagnostics = await enrichDiagnosticProvenance({
    projectRoot: prepared.project.root,
    entry: prepared.config.entry,
    circuitJson: assessment.evaluated.circuitJson,
    diagnostics: manufacturingDiagnostics(
      verification,
      projectRelative(prepared.project.root, manufacturingDirectory),
    ),
  });
  const independentDiagnostics = Object.freeze(
    enrichedIndependentDiagnostics.map((diagnostic) =>
      diagnostic.sourceLocations.length > 0
        ? diagnostic
        : defineDiagnostic({
            ...diagnostic,
            sourceLocations: [`${prepared.config.entry}:1:1`],
          })
    ),
  );
  const fabrication = verification.passed
    ? assessment.fabrication.status
    : assuranceStatus("fabrication", "failed", {
      diagnosticIds: [
        ...assessment.fabrication.status.diagnosticIds,
        ...independentDiagnostics.map(({ id }) => id),
      ],
      summary: "Independent manufacturing artifact verification failed",
    });
  const statuses = mergeAssessmentStatuses(
    fabrication,
    assessment.electrical.status,
    standards.status,
    sourcing.status,
  );
  const diagnostics = Object.freeze([
    ...assessment.diagnostics,
    ...independentDiagnostics,
    ...standards.diagnostics,
    ...sourcing.diagnostics,
  ]);
  const verificationPath = join(prepared.runDirectory, "manufacturing-verification.json");
  const verificationBytes = `${JSON.stringify({
    schemaVersion: 1,
    lifecycle: "independent-manufacturing-verification",
    parser: verification.parser,
    adapters: MANUFACTURING_ADAPTER_VERSIONS,
    authenticatedPackages: manufacturingPackages,
    expectation: verification.expectation,
    project: {
      projectDigest: inputAuthority.projectDigest,
      sourceDigest: inputAuthority.sourceDigest,
      configDigest: inputAuthority.configDigest,
      lockDigest: inputAuthority.lockDigest,
    },
    passed: verification.passed,
    artifacts: verification.artifacts,
    findings: verification.findings,
  }, null, 2)}\n`;
  await atomicWrite(verificationPath, verificationBytes);
  const requestedDimensions = ["fabrication", "electrical", "standards"] as const;
  const circuitArtifact = await writeCircuitArtifact(
    prepared,
    assessment.evaluated.canonicalJson,
  );
  const artifacts: ArtifactReference[] = [
    circuitArtifact,
    {
      kind: "standards-evidence",
      path: projectRelative(prepared.project.root, standardsPath),
      digest: sha256(standardsBytes),
    },
    {
      kind: "sourcing-evidence",
      path: projectRelative(prepared.project.root, sourcingPath),
      digest: sha256(sourcingBytes),
    },
    {
      kind: "manufacturing-verification",
      path: projectRelative(prepared.project.root, verificationPath),
      digest: sha256(verificationBytes),
    },
    ...paths.map((path) => {
      const file = files.find((candidate) => candidate.path === path);
      if (file === undefined) throw new Error(`Exporter omitted authored bytes for ${path}`);
      return {
        kind: "draft-manufacturing",
        path: projectRelative(prepared.project.root, join(manufacturingDirectory, path)),
        digest: sha256(file.content),
      };
    }),
  ];
  const result = commandResult({
    command: "fulmetry verify manufacturing",
    runId: prepared.runId,
    exitClassification: classify(statuses, requestedDimensions, diagnostics),
    requestedDimensions,
    statuses,
    diagnostics,
    sourcingEvidence: sourcing.evidence,
    artifacts,
  });
  return finishEvidenceRun(prepared, result, json, inputAuthority, {
    verifyArtifacts: async () => {
      const currentManufacturingPackages = await requireManufacturingPackageIdentity();
      if (!isDeepStrictEqual(currentManufacturingPackages, manufacturingPackages)) {
        throw new Error("Manufacturing package identity changed during verification");
      }
      const replayed = await verifyManufacturingDirectory({
        root: manufacturingDirectory,
        expectation,
        circuitJson: assessment.evaluated.circuitJson,
      });
      if (!isDeepStrictEqual(replayed, verification)) {
        throw new Error(
          "Manufacturing artifacts no longer match the independently verified bytes",
        );
      }
    },
  });
}

async function runSimulate(
  prepared: PreparedRun,
  json: boolean,
  name: string | undefined,
  ngspicePath: string | null | undefined,
  signal?: AbortSignal,
): Promise<CliRun> {
  const command = `fulmetry simulate${name === undefined ? "" : ` ${name}`}`;
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  if (name === undefined) {
    const id = diagnosticId("SIM_TESTBENCH_REQUIRED_001");
    const diagnostic = defineDiagnostic({ id, severity: "error", dimension: "functional", message: "A named simulations/<name>.testbench.ts is required", waiverPolicy: "forbidden", objects: [], sourceLocations: [], nextCommand: "fulmetry simulate <name>" });
    const statuses = statusSet({ ...unassessedStatusSet(), functional: assuranceStatus("functional", "incomplete", { diagnosticIds: [id], summary: "No explicit simulation testbench was selected" }) });
    return finishEvidenceRun(prepared, commandResult({ command, runId: prepared.runId, exitClassification: "incomplete", requestedDimensions: ["functional"], statuses, diagnostics: [diagnostic] }), json, inputAuthority);
  }
  if (prepared.networkPolicy === "offline") {
    const id = diagnosticId("SIM_OFFLINE_CONTAINMENT_UNAVAILABLE_001");
    const diagnostic = defineDiagnostic({
      id,
      severity: "error",
      dimension: "functional",
      message: "Simulation testbench code cannot run under offline policy until macOS process network containment is qualified",
      waiverPolicy: "forbidden",
      objects: [name],
      sourceLocations: [`simulations/${name}.testbench.ts:1:1`],
      nextCommand: `fulmetry simulate ${name}`,
    });
    const statuses = statusSet({
      ...unassessedStatusSet(),
      functional: assuranceStatus("functional", "incomplete", {
        diagnosticIds: [id],
        summary: "Offline simulation testbench containment is unavailable",
      }),
    });
    return finishEvidenceRun(
      prepared,
      commandResult({
        command,
        runId: prepared.runId,
        exitClassification: "incomplete",
        requestedDimensions: ["functional"],
        statuses,
        diagnostics: [diagnostic],
      }),
      json,
      inputAuthority,
    );
  }
  const probe = await probeNgspice({
    ...(ngspicePath === undefined ? {} : { executable: ngspicePath }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (probe.state === "unavailable") {
    const unsupportedVersion = probe.version !== undefined && probe.reason?.includes("outside Fulmetry's detected compatibility range");
    const id = diagnosticId(unsupportedVersion ? "SIM_NGSPICE_VERSION_UNSUPPORTED_001" : "SIM_NGSPICE_UNAVAILABLE_001");
    const diagnostic = defineDiagnostic({
      id, severity: "error", dimension: "functional", message: probe.reason!,
      waiverPolicy: "forbidden", objects: name === undefined ? [] : [name], sourceLocations: [],
      evidence: probe.executable === undefined ? ["tool:ngspice:unavailable"] : [`tool:ngspice:${probe.executableSha256 ?? "identity-unavailable"}:${probe.executable}`],
      nextCommand: "fulmetry inspect --status functional",
    });
    const statuses = statusSet({ ...unassessedStatusSet(), functional: assuranceStatus("functional", "unavailable", { diagnosticIds: [id], summary: "ngspice is unavailable" }) });
    return finishEvidenceRun(prepared, commandResult({ command, runId: prepared.runId, exitClassification: unsupportedVersion ? "unsupported" : "unavailable", requestedDimensions: ["functional"], statuses, diagnostics: [diagnostic] }), json, inputAuthority);
  }
  let loaded: Awaited<ReturnType<typeof loadSimulationDefinition>>;
  try {
    loaded = await loadSimulationDefinition({ projectRoot: prepared.project.root, name, ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    const id = diagnosticId("SIM_TESTBENCH_INVALID_001");
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = defineDiagnostic({ id, severity: "error", dimension: "functional", message, waiverPolicy: "forbidden", objects: [name], sourceLocations: [], nextCommand: `fulmetry simulate ${name}` });
    const statuses = statusSet({ ...unassessedStatusSet(), functional: assuranceStatus("functional", "incomplete", { diagnosticIds: [id], summary: "Simulation testbench is unavailable or invalid" }) });
    return finishEvidenceRun(
      prepared,
      commandResult({ command, runId: prepared.runId, exitClassification: "incomplete", requestedDimensions: ["functional"], statuses, diagnostics: [diagnostic] }),
      json,
      inputAuthority,
    );
  }
  const evaluated = await evaluateProjectCircuitTwice(prepared.project.root, {
    expectedConfig: prepared.config,
    ...(signal === undefined ? {} : { signal }),
  });
  const simulationInputSnapshot = await captureDraftExportInputSnapshot(prepared, inputAuthority);
  const executed = await runQualifiedNgspice({
    projectRoot: prepared.project.root, runDirectory: prepared.runDirectory,
    outputRoot: dirname(prepared.runDirectory),
    definition: loaded.definition, circuitJson: evaluated.circuitJson,
    definitionAuthority: loaded.authority,
    inputSnapshot: simulationInputSnapshot,
    executable: probe.executable!, ...(signal === undefined ? {} : { signal }),
  });
  const definitionPath = join(prepared.runDirectory, "simulation", "definition.json");
  const definitionBytes = `${JSON.stringify(loaded.definition, null, 2)}\n`;
  await atomicWrite(definitionPath, definitionBytes);
  const artifacts: ArtifactReference[] = [
    { kind: "simulation-definition", path: projectRelative(prepared.project.root, definitionPath), digest: new Bun.CryptoHasher("sha256").update(definitionBytes).digest("hex") },
    ...executed.artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: projectRelative(prepared.project.root, join(prepared.runDirectory, artifact.path)),
      digest: artifact.digest.slice("sha256:".length),
    })),
  ];
  const statuses = statusSet({ ...unassessedStatusSet(), functional: executed.assessment.status });
  const requestedDimensions = ["functional"] as const;
  const result = commandResult({ command, runId: prepared.runId, exitClassification: classify(statuses, requestedDimensions, executed.assessment.diagnostics), requestedDimensions, statuses, diagnostics: executed.assessment.diagnostics, artifacts });
  return finishEvidenceRun(prepared, result, json, inputAuthority);
}

async function runExportKicad(
  prepared: PreparedRun,
  json: boolean,
  kicadCliPath?: string | null,
  signal?: AbortSignal,
  hooks?: RunCliOptions["kicadTestHooks"],
): Promise<CliRun> {
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  const evaluated = await evaluateProjectCircuitTwice(prepared.project.root, {
    expectedConfig: prepared.config,
    ...(signal === undefined ? {} : { signal }),
  });
  const offlineHandoff = await createKicadHandoff(evaluated.circuitJson, { projectName: "board" });
  const liveKiCadValidation = await validateKicadHandoffLive({
    handoff: offlineHandoff,
    runDirectory: prepared.runDirectory,
    outputRoot: resolve(
      prepared.project.root,
      ...prepared.config.outputDirectory.replaceAll("\\", "/").split("/"),
    ),
    projectRoot: prepared.project.root,
    configuredOutputDirectory: prepared.config.outputDirectory,
    protectedInputPaths: inputAuthority.inputPaths,
    authoredSourceDigest: inputAuthority.sourceDigest,
    ...(hooks?.beforeLiveInputWrite === undefined
      ? {}
      : { beforeLiveInputWrite: hooks.beforeLiveInputWrite }),
    ...(kicadCliPath === undefined ? {} : { executable: kicadCliPath }),
    ...(signal === undefined ? {} : { signal }),
  });
  const finalInputAuthority = await digestProjectInputs({
    projectRoot: prepared.project.root,
    entry: prepared.config.entry,
    outputDirectory: prepared.config.outputDirectory,
    profiles: prepared.config.profiles,
    ...(prepared.config.boardRevision === undefined
      ? {}
      : { boardRevision: prepared.config.boardRevision }),
    evaluateSimulationDefinitions: prepared.networkPolicy !== "offline",
    ...(signal === undefined ? {} : { signal }),
  });
  if (finalInputAuthority.projectDigest !== inputAuthority.projectDigest) {
    throw new Error("Project inputs changed during KiCad export; live evidence is stale and was not attached");
  }
  const handoff = withKicadLiveValidation(offlineHandoff, liveKiCadValidation);
  const handoffDirectory = join(prepared.runDirectory, "kicad-handoff");
  await verifyKicadLiveInputEvidence(liveKiCadValidation);
  await mkdir(handoffDirectory);
  await verifyKicadLiveInputEvidence(liveKiCadValidation);
  const handoffReportBytes = `${JSON.stringify(handoff.report, null, 2)}\n`;
  const handoffReportSha256 = sha256(handoffReportBytes);
  const publicationAuthority = Object.freeze({
    directory: await captureKicadPublicationDirectory(handoffDirectory),
    files: Object.freeze([
      ...handoff.files.map((file) => Object.freeze({
        path: file.path,
        size: new TextEncoder().encode(file.content).byteLength,
        sha256: file.sha256,
      })),
      Object.freeze({
        path: "handoff-report.json",
        size: new TextEncoder().encode(handoffReportBytes).byteLength,
        sha256: handoffReportSha256,
      }),
    ]),
  });
  await verifyKicadLiveInputEvidence(liveKiCadValidation);
  await assertKicadPublicationDirectory(publicationAuthority.directory);
  const artifacts: ArtifactReference[] = [];
  for (const file of handoff.files) {
    await verifyKicadLiveInputEvidence(liveKiCadValidation);
    await assertKicadPublicationDirectory(publicationAuthority.directory);
    const path = join(handoffDirectory, file.path);
    await hooks?.beforeHandoffFileCommit?.({
      handoffDirectory,
      path,
      relativePath: file.path,
    });
    await atomicWrite(path, file.content);
    await verifyKicadLiveInputEvidence(liveKiCadValidation);
    await assertKicadPublicationDirectory(publicationAuthority.directory);
    artifacts.push({
      kind: "kicad-handoff",
      path: projectRelative(prepared.project.root, path),
      digest: `sha256:${file.sha256}`,
    });
  }
  for (const file of liveKiCadValidation.evidence?.input.artifacts ?? []) {
    artifacts.push({
      kind: "kicad-live-input",
      path: projectRelative(prepared.project.root, join(prepared.runDirectory, "kicad-live-validation", "input", file.path)),
      digest: `sha256:${file.sha256}`,
    });
  }
  for (const file of liveKiCadValidation.evidence?.execution.outputs ?? []) {
    artifacts.push({
      kind: "kicad-live-output",
      path: projectRelative(
        prepared.project.root,
        join(
          prepared.runDirectory,
          "kicad-live-validation",
          "qualification-output",
          ...file.path.split("/"),
        ),
      ),
      digest: `sha256:${file.sha256}`,
    });
  }
  const handoffReportPath = join(handoffDirectory, "handoff-report.json");
  await verifyKicadLiveInputEvidence(liveKiCadValidation);
  await assertKicadPublicationDirectory(publicationAuthority.directory);
  await hooks?.beforeHandoffFileCommit?.({
    handoffDirectory,
    path: handoffReportPath,
    relativePath: "handoff-report.json",
  });
  await atomicWrite(handoffReportPath, handoffReportBytes);
  await verifyKicadLiveInputEvidence(liveKiCadValidation);
  await verifyKicadHandoffPublication(publicationAuthority);
  artifacts.push({
    kind: "kicad-handoff-report",
    path: projectRelative(prepared.project.root, handoffReportPath),
    digest: `sha256:${handoffReportSha256}`,
  });
  const unsupported = handoff.report.mapping.filter(({ disposition }) => disposition === "unsupported");
  const semanticPassed = handoff.report.semanticReconciliation.state === "passed";
  const qualified = unsupported.length === 0 && semanticPassed &&
    handoff.report.liveKiCadValidation.state === "qualified";
  const id = diagnosticId(
    qualified
      ? "KICAD_HANDOFF_QUALIFIED_001"
      : !semanticPassed
        ? "KICAD_HANDOFF_SEMANTIC_FAILED_001"
        : unsupported.length > 0
          ? "KICAD_HANDOFF_UNSUPPORTED_001"
        : handoff.report.liveKiCadValidation.state === "failed"
          ? "KICAD_HANDOFF_LIVE_FAILED_001"
          : "KICAD_HANDOFF_UNQUALIFIED_001",
  );
  const diagnostic = defineDiagnostic({
    id,
    severity: qualified ? "info" : "error",
    dimension: "fabrication",
    message: qualified
      ? "Detached KiCad handoff passed independent source-to-KiCad semantic reconciliation; current-run KiCad 10 executed ERC and DRC and captured parseable netlist and Gerber reports, while approximated and omitted mappings remain listed"
      : !semanticPassed
        ? "Detached KiCad handoff parsed offline, but independent source-to-KiCad semantic reconciliation failed"
        : unsupported.length > 0
          ? `Detached KiCad handoff contains ${unsupported.length} Circuit JSON type(s) without a qualified mapping; see handoff-report.json`
        : handoff.report.liveKiCadValidation.state === "failed"
          ? "Detached KiCad handoff parsed offline, but live KiCad behavioral qualification failed"
          : "Detached KiCad handoff parsed offline, but live KiCad 10 behavioral qualification did not run",
    waiverPolicy: "forbidden",
    objects: unsupported.flatMap(({ circuitJsonType }) => [circuitJsonType]),
    sourceLocations: [],
    evidence: [
      `kicad-converter:${handoff.report.adapter.converter.version}:${handoff.report.adapter.converter.contentSha256}`,
      `kicad-parser:${handoff.report.adapter.parser.version}:${handoff.report.adapter.parser.contentSha256}`,
      `circuit:sha256:${handoff.report.circuitDigest}`,
      `kicad-semantics:sha256:${handoff.report.semanticReconciliation.sha256}`,
      `kicad-live:${handoff.report.liveKiCadValidation.state}:${handoff.report.liveKiCadValidation.evidence?.tool?.executableSha256 ?? "tool-unavailable"}`,
    ],
    nextCommand: `Read ${projectRelative(prepared.project.root, handoffReportPath)}`,
  });
  const result = commandResult({
    command: "fulmetry export kicad",
    runId: prepared.runId,
    exitClassification: qualified ? "success" : "incomplete",
    requestedDimensions: [],
    statuses: unassessedStatusSet(),
    diagnostics: [diagnostic],
    artifacts,
  });
  return finishEvidenceRun(prepared, result, json, inputAuthority, {
    verifyArtifacts: async () => {
      await verifyKicadLiveInputEvidence(liveKiCadValidation);
      await verifyKicadHandoffPublication(publicationAuthority);
    },
    ...(hooks?.beforeFinalReportPublication === undefined
      ? {}
      : { beforeReportPublication: hooks.beforeFinalReportPublication }),
  });
}

function throwIfGerberExportCancelled(signal?: AbortSignal): void {
  throwIfFulmetryCancelled(signal, "Draft Gerber export was cancelled");
}

async function captureDraftExportInputSnapshot(
  prepared: PreparedRun,
  inputAuthority: Readonly<ProjectInputDigest>,
): Promise<Readonly<Awaited<ReturnType<typeof createBuildInputSnapshot>>>> {
  const [sourcePaths, configPaths] = await Promise.all([
    discoverProjectSourceGraph(prepared.project.root, prepared.config.entry),
    discoverProjectSourceGraph(prepared.project.root, "fulmetry.config.ts"),
  ]);
  const sourceSet = new Set(sourcePaths);
  const configSet = new Set(configPaths);
  const inputs: BuildInputDescriptor[] = inputAuthority.inputPaths.map((path) => {
    if (path === "fulmetry.config.ts") return { path, role: "config" as const };
    if (path === "fulmetry.lock") return { path, role: "lockfile" as const };
    if (path.startsWith("waivers/")) return { path, role: "waiver" as const };
    if (
      path === "models" || path.startsWith("models/") ||
      path === "vendor" || path.startsWith("vendor/")
    ) {
      return { path, role: "vendored" as const };
    }
    if (sourceSet.has(path)) return { path, role: "source" as const };
    if (configSet.has(path)) return { path, role: "config-dependency" as const };
    if (
      path === "simulations" || path.startsWith("simulations/") ||
      /\.test\.tsx?$/u.test(path)
    ) {
      return { path, role: "test" as const };
    }
    return { path, role: "source" as const };
  });
  return await createBuildInputSnapshot({
    projectRoot: prepared.project.root,
    inputs,
  });
}

async function runExportGerbers(
  prepared: PreparedRun,
  json: boolean,
  signal?: AbortSignal,
): Promise<CliRun> {
  const inputAuthority = await captureProjectInputAuthority(prepared, signal);
  const manufacturingPackages = await requireManufacturingPackageIdentity();
  throwIfGerberExportCancelled(signal);
  const inputSnapshot = await captureDraftExportInputSnapshot(prepared, inputAuthority);
  throwIfGerberExportCancelled(signal);
  const evaluated = await evaluateProjectCircuitTwice(
    prepared.project.root,
    {
      expectedConfig: prepared.config,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  throwIfGerberExportCancelled(signal);
  const evaluatedInputAuthority = await digestProjectInputs({
    projectRoot: prepared.project.root,
    entry: prepared.config.entry,
    outputDirectory: prepared.config.outputDirectory,
    profiles: prepared.config.profiles,
    ...(prepared.config.boardRevision === undefined
      ? {}
      : { boardRevision: prepared.config.boardRevision }),
    evaluateSimulationDefinitions: prepared.networkPolicy !== "offline",
    ...(signal === undefined ? {} : { signal }),
  });
  if (evaluatedInputAuthority.projectDigest !== inputAuthority.projectDigest) {
    throw new Error("Project inputs changed during draft Gerber evaluation");
  }
  const files = await exportManufacturingFiles({
    boardName: "board",
    circuitJson: evaluated.circuitJson,
  });
  throwIfGerberExportCancelled(signal);

  const circuitArtifact = await writeCircuitArtifact(prepared, evaluated.canonicalJson);
  const inputSnapshotPath = join(prepared.runDirectory, "draft-input-snapshot.json");
  const inputSnapshotBytes = `${JSON.stringify(inputSnapshot, null, 2)}\n`;
  await atomicWrite(inputSnapshotPath, inputSnapshotBytes);
  const manufacturingDirectory = join(prepared.runDirectory, "manufacturing-draft");
  const manufacturingPaths = await emitDraftManufacturingDirectory({
    targetDirectory: manufacturingDirectory,
    files,
  });
  throwIfGerberExportCancelled(signal);

  const manifestedPaths = Object.freeze([
    "circuit.json",
    "draft-input-snapshot.json",
    ...manufacturingPaths.map((path) => `manufacturing-draft/${path}`),
  ].sort());
  const artifactKinds = Object.freeze(Object.fromEntries([
    ["circuit.json", "compiled-circuit"],
    ["draft-input-snapshot.json", "input-snapshot"],
    ...manufacturingPaths.map((path) => {
      const file = files.find((candidate) => candidate.path === path);
      if (file === undefined) throw new Error(`Exporter omitted authored bytes for ${path}`);
      return [`manufacturing-draft/${path}`, file.kind] as const;
    }),
  ]));
  const activeProfile = activeFabricationProfile(prepared.config, prepared.lock);
  const fulmetryVersion = await requireFulmetryVersion();
  const draftManifest: Readonly<ArtifactManifest> = await createDraftArtifactManifest({
    root: prepared.runDirectory,
    ...(prepared.config.boardRevision === undefined
      ? {}
      : { boardRevision: prepared.config.boardRevision }),
    artifactPaths: [...manifestedPaths],
    artifactKinds,
    provenance: {
      generatedAt: new Date().toISOString(),
      sourceControl: {
        state: "not-assessed",
        reason: "This draft command does not invoke Git; revision and dirty-tree state are unknown",
      },
      inputDigests: {
        project: inputAuthority.projectDigest,
        source: inputAuthority.sourceDigest,
        config: inputAuthority.configDigest,
        lockfile: inputAuthority.lockDigest,
      },
      tools: {
        fulmetry: { package: "fulmetry", version: fulmetryVersion },
        bun: { package: "bun", version: Bun.version },
        tscircuit: {
          package: "tscircuit",
          version: prepared.engineIdentity.project!.version,
          contentSha256: prepared.engineIdentity.project!.contentSha256,
          runtimeClosureSha256: prepared.engineIdentity.project!.runtimeClosureSha256,
        },
      },
      adapters: Object.freeze(Object.fromEntries(
        Object.entries(manufacturingPackages).map(([role, identity]) => [role, {
          package: identity.package,
          version: identity.version,
          contentSha256: identity.contentSha256,
        }]),
      )),
      validation: {
        fabrication: "incomplete",
        electrical: "not-run",
        functional: "not-run",
        standards: "not-run",
        sourcing: "unchecked",
        boardRevision: prepared.config.boardRevision === undefined
          ? "missing"
          : `declared:${prepared.config.boardRevision}`,
      },
      knownLimitations: [
        "Manufacturing verification has not run",
        "Source-control revision and dirty-tree state were not assessed",
        ...(prepared.config.boardRevision === undefined
          ? ["No board revision was declared for this draft"]
          : []),
        "No external executable capability was invoked",
      ],
      externalCapabilities: [],
      activeProfiles: activeProfile === undefined ? [] : [{ ...activeProfile }],
      waivers: [],
      verificationResults: { manufacturing: "not-run" },
    },
  });
  if (draftManifest.lifecycle !== "draft") {
    throw new Error("Draft Gerber export refused a non-draft artifact manifest");
  }
  const manifestPath = join(prepared.runDirectory, "draft-artifact-manifest.json");
  const manifestBytes = `${JSON.stringify(draftManifest, null, 2)}\n`;
  await atomicWrite(manifestPath, manifestBytes);

  const diagnostic = defineDiagnostic({
    id: diagnosticId("FAB_DRAFT_EXPORT_UNVERIFIED_001"),
    severity: "warning",
    dimension: "fabrication",
    message: "Draft Gerber, drill, BOM, and placement files were exported but were not independently verified and are not a production bundle",
    waiverPolicy: "forbidden",
    objects: [],
    sourceLocations: [],
    evidence: [
      "artifact-lifecycle:draft",
      `input-snapshot:sha256:${inputSnapshot.digest}`,
      `gerber-exporter:${MANUFACTURING_ADAPTER_VERSIONS.gerber}`,
      `bom-exporter:${MANUFACTURING_ADAPTER_VERSIONS.bom}`,
      `pick-and-place-exporter:${MANUFACTURING_ADAPTER_VERSIONS.pickAndPlace}`,
      ...Object.values(manufacturingPackages).map(
        (identity) =>
          `authenticated-package:${identity.package}@${identity.version}:sha256:${identity.contentSha256}`,
      ),
      "manufacturing-verification:not-run",
    ],
    nextCommand: "fulmetry verify manufacturing",
  });
  const statuses = statusSet({
    ...unassessedStatusSet(),
    fabrication: assuranceStatus("fabrication", "incomplete", {
      diagnosticIds: [diagnostic.id],
      summary: "Draft files exist; independent manufacturing verification has not run",
    }),
  });
  const artifacts: ArtifactReference[] = [
    circuitArtifact,
    {
      kind: "draft-input-snapshot",
      path: projectRelative(prepared.project.root, inputSnapshotPath),
      digest: sha256(inputSnapshotBytes),
    },
    ...manufacturingPaths.map((path) => {
      const file = files.find((candidate) => candidate.path === path);
      if (file === undefined) throw new Error(`Exporter omitted authored bytes for ${path}`);
      return {
        kind: "draft-manufacturing",
        path: projectRelative(prepared.project.root, join(manufacturingDirectory, path)),
        digest: sha256(file.content),
      };
    }),
    {
      kind: "draft-artifact-manifest",
      path: projectRelative(prepared.project.root, manifestPath),
      digest: sha256(manifestBytes),
    },
  ];
  const result = commandResult({
    command: "fulmetry export gerbers",
    runId: prepared.runId,
    exitClassification: "incomplete",
    requestedDimensions: ["fabrication"],
    statuses,
    diagnostics: [diagnostic],
    artifacts,
  });
  return finishEvidenceRun(prepared, result, json, inputAuthority, {
    verifyArtifacts: async () => {
      const currentManufacturingPackages = await requireManufacturingPackageIdentity();
      if (!isDeepStrictEqual(currentManufacturingPackages, manufacturingPackages)) {
        throw new Error("Manufacturing package identity changed during draft export");
      }
      const refreshedSnapshot = await refreshBuildInputSnapshot(
        prepared.project.root,
        inputSnapshot,
      );
      if (!isDeepStrictEqual(refreshedSnapshot, inputSnapshot)) {
        throw new Error("Draft Gerber export input snapshot is stale");
      }
      const integrity = await verifyArtifactManifest(prepared.runDirectory, draftManifest);
      if (!integrity.integrityValid || integrity.lifecycle !== "draft") {
        throw new Error("Draft Gerber export artifacts no longer match their draft manifest");
      }
      const currentPaths = draftManifest.artifacts.map(({ path }) => path).sort();
      if (!isDeepStrictEqual(currentPaths, manifestedPaths)) {
        throw new Error("Draft Gerber export manifest membership changed");
      }
    },
  });
}

export async function runCli(options: RunCliOptions): Promise<CliRun> {
  let invocation: ParsedInvocation;
  try {
    invocation = parseInvocation(options.argv, options.runId);
  } catch (error) {
    return argumentFailure(
      error instanceof Error ? error.message : String(error),
      options.argv.includes("--json"),
    );
  }

  const words = invocation.words;
  if (
    words.length === 0 || words[0] === "help" || words[0] === "--help" ||
    words[0] === "-h"
  ) {
    if (words.length > 1) return argumentFailure("help accepts no arguments", invocation.json);
    if (invocation.json) {
      const result = commandResult({
        command: "fulmetry help",
        runId: "help",
        exitClassification: "success",
        requestedDimensions: [],
        statuses: unassessedStatusSet(),
      });
      return Object.freeze({
        exitCode: CLI_EXIT_CODES.success,
        stdout: `${JSON.stringify(result, null, 2)}\n`,
        stderr: "",
        result,
      });
    }
    return Object.freeze({ exitCode: 0, stdout: `${CLI_HELP}\n`, stderr: "" });
  }

  const command = words[0]!;
  const recognized = command === "build" || command === "check" || command === "test" ||
    command === "inspect" || command === "simulate" ||
    (command === "route" && (words[1] === "freerouting" || words[1] === "promote")) ||
    (command === "export" && (words[1] === "kicad" || words[1] === "gerbers")) ||
    (command === "verify" && words[1] === "manufacturing");
  if (!recognized) {
    return unsupportedRun(words, invocation.json, invocation.runId);
  }
  if ((command === "build" || command === "check" || command === "test") && words.length !== 1) {
    return argumentFailure(`${command} accepts no positional arguments`, invocation.json);
  }
  if (command === "verify" && words.length !== 2) {
    return argumentFailure("verify manufacturing accepts no additional arguments", invocation.json);
  }
  if (command === "export" && words.length !== 2) {
    return argumentFailure(`export ${words[1] ?? "<format>"} accepts no additional arguments`, invocation.json);
  }
  if (command === "simulate" && (words.length > 2 || words[1]?.startsWith("--"))) {
    return argumentFailure("simulate accepts at most one simulation name", invocation.json);
  }
  let inspectFilters: InspectFilters = {};
  let freeroutingInvocation: ParsedFreeroutingInvocation | undefined;
  let routePromotionInvocation: ParsedRoutePromotionInvocation | undefined;
  if (command === "inspect") {
    try {
      inspectFilters = parseInspect(words);
    } catch (error) {
      return argumentFailure(
        error instanceof Error ? error.message : String(error),
        invocation.json,
      );
    }
  }
  if (command === "route") {
    try {
      if (words[1] === "freerouting") {
        freeroutingInvocation = parseFreeroutingInvocation(words);
      } else {
        routePromotionInvocation = parseRoutePromotionInvocation(words);
      }
    } catch (error) {
      return argumentFailure(
        error instanceof Error ? error.message : String(error),
        invocation.json,
      );
    }
  }

  try {
    requireSupportedBunRuntime();
  } catch (error) {
    if (error instanceof UnsupportedBunRuntimeError) {
      return unsupportedBunRuntimeRun(
        invocation.json,
        `fulmetry ${words.join(" ")}`,
        invocation.runId,
      );
    }
    if (error instanceof UnsupportedPlatformRuntimeError) {
      return unsupportedPlatformRuntimeRun(
        invocation.json,
        `fulmetry ${words.join(" ")}`,
        invocation.runId,
      );
    }
    throw error;
  }

  if (routePromotionInvocation !== undefined) {
    try {
      return await runRoutePromote(
        options.cwd ?? process.cwd(),
        invocation.json,
        routePromotionInvocation,
      );
    } catch (error) {
      return argumentFailure(error instanceof Error ? error.message : String(error), invocation.json);
    }
  }

  let prepared: PreparedRun;
  try {
    prepared = await prepareRun(
      options.cwd ?? process.cwd(),
      invocation.runId,
      invocation.offline,
      options.testHooks?.beforeFinalReportPublication,
      options.testHooks?.afterReportPublication,
      options.testHooks?.beforeEvidenceInputCapture,
      options.testHooks?.beforeEvidenceAuthorityCapture,
      options.testHooks?.beforeFailureReportPublication,
      options.testHooks?.afterFailureReportPublication,
      options.signal,
    );
  } catch (error) {
    return argumentFailure(error instanceof Error ? error.message : String(error), invocation.json);
  }

  try {
    if (command === "build") return await runBuild(prepared, invocation.json, options.signal);
    if (command === "check") return await runCheck(prepared, invocation.json, options.signal);
    if (command === "test") {
      return await runProjectTestCommand(
        prepared,
        invocation.json,
        options.signal,
        options.projectTestOptions,
      );
    }
    if (command === "inspect") {
      return await runInspect(prepared, invocation.json, inspectFilters, options.signal);
    }
    if (command === "simulate") {
      return await runSimulate(
        prepared,
        invocation.json,
        words[1],
        options.externalToolPaths?.ngspice,
        options.signal,
      );
    }
    if (command === "route") {
      return await runRouteFreerouting(
        prepared,
        invocation.json,
        freeroutingInvocation!,
        options.externalToolPaths?.java,
        options.signal,
      );
    }
    if (command === "export") {
      if (words[1] === "gerbers") {
        return await runExportGerbers(prepared, invocation.json, options.signal);
      }
      return await runExportKicad(
        prepared,
        invocation.json,
        options.externalToolPaths?.kicadCli,
        options.signal,
        options.kicadTestHooks,
      );
    }
    return await runVerifyManufacturing(
      prepared,
      invocation.json,
      options.signal,
      options.manufacturingTestHooks,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = options.signal?.aborted === true || isFulmetryCancellationError(error);
    if (command === "export" && words[1] === "gerbers") {
      // This file is the draft tree's validity marker. Preserve partial files for
      // diagnosis, but never leave a manifest that authenticates a cancelled or
      // otherwise failed command.
      await rm(join(prepared.runDirectory, "draft-artifact-manifest.json"), {
        force: true,
      });
    }
    if (command === "verify" && words[1] === "manufacturing") {
      // These are standalone pass/evidence claims. A failed command may retain
      // raw draft manufacturing bytes for diagnosis, but it must not leave a
      // verifier, standards, or sourcing result that looks current in isolation.
      await Promise.all([
        rm(join(prepared.runDirectory, "manufacturing-verification.json"), {
          recursive: true,
          force: true,
        }),
        rm(join(prepared.runDirectory, "standards", "pre-compliance.json"), {
          recursive: true,
          force: true,
        }),
        rm(join(prepared.runDirectory, "sourcing", "recorded-evidence.json"), {
          recursive: true,
          force: true,
        }),
      ]);
    }
    try {
      await verifyRunEvidenceAuthority(prepared.runRootAuthority, prepared.project.root);
    } catch {
      const result = contextualizeResult(prepared, commandResult({
        command: `fulmetry ${words.join(" ")}`,
        runId: prepared.runId,
        exitClassification: cancelled ? "cancelled" : "failure",
        requestedDimensions: [],
        statuses: unassessedStatusSet(),
        artifacts: [],
      }), prepared.preparedInputDigest);
      return Object.freeze({
        exitCode: CLI_EXIT_CODES[result.exitClassification],
        stdout: invocation.json ? `${JSON.stringify(result, null, 2)}\n` : "",
        stderr: `fulmetry: ${message}\n`,
        result,
        projectRoot: prepared.project.root,
      });
    }
    await rm(prepared.reportPath, { recursive: true, force: true });
    const errorPath = join(prepared.runDirectory, "command-error.txt");
    await rm(errorPath, { recursive: true, force: true });
    await atomicWrite(errorPath, `${message}\n`);
    const result = commandResult({
      command: `fulmetry ${words.join(" ")}`,
      runId: prepared.runId,
      exitClassification: cancelled ? "cancelled" : "failure",
      requestedDimensions: [],
      statuses: unassessedStatusSet(),
      artifacts: [{
        kind: "command-error",
        path: projectRelative(prepared.project.root, errorPath),
      }],
    });
    const finished = await finishFailureRun(prepared, result, invocation.json, errorPath);
    return Object.freeze({
      ...finished,
      stdout: invocation.json ? finished.stdout : "",
      stderr: `fulmetry: ${message}\n`,
    });
  }
}
