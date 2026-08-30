// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import gerberParser from "gerber-parser";
import type { AnyCircuitElement } from "tscircuit";
import type {
  ExpectedFlash,
  ExpectedAssemblyAuthority,
  ExpectedDrillHit,
  ExpectedPlacement,
  ExpectedSegment,
  ManufacturingExpectation,
} from "./expectation";
import {
  MANUFACTURING_BOM_HEADERS,
  deriveManufacturingExpectation,
  manufacturingExpectationSha256,
} from "./expectation";
import { MANUFACTURING_PACKAGE_PINS } from "./identity";
import { requireSupportedBunRuntime } from "../runtime";
import { isStableAssemblyDesignator } from "../component-identity";
import { canonicalCircuitJson, parseCanonicalCircuitJson } from "../circuit-json";
import {
  BASELINE_FABRICATION_PROFILE,
  isBaselineSupportedBoardMaterial,
} from "../profiles/baseline";

export type ManufacturingFindingCode =
  | "MANUFACTURING_UNSUPPORTED"
  | "MANUFACTURING_FILE_MISSING"
  | "MANUFACTURING_FILE_UNEXPECTED"
  | "MANUFACTURING_FILE_EMPTY"
  | "MANUFACTURING_FILE_SYMLINK"
  | "MANUFACTURING_INPUT_LIMIT"
  | "GERBER_PARSE_ERROR"
  | "GERBER_PARSE_WARNING"
  | "GERBER_FILE_FUNCTION_MISMATCH"
  | "GERBER_POLARITY_MISMATCH"
  | "GERBER_STEP_REPEAT_UNSUPPORTED"
  | "GERBER_STATE_UNSUPPORTED"
  | "GERBER_NO_OPERATIONS"
  | "GERBER_FEATURE_MISSING"
  | "GERBER_FEATURE_MISMATCH"
  | "GERBER_TRACE_MISMATCH"
  | "GERBER_PROFILE_MISMATCH"
  | "DRILL_PARSE_ERROR"
  | "DRILL_FILE_FUNCTION_MISMATCH"
  | "DRILL_HIT_MISMATCH"
  | "DRILL_STATE_UNSUPPORTED"
  | "BOM_MISMATCH"
  | "PLACEMENT_MISMATCH"
  | "FABRICATION_METADATA_MISMATCH"
  | "MANUFACTURING_ARTIFACT_CHANGED";

export interface ManufacturingFinding {
  readonly code: ManufacturingFindingCode;
  readonly path?: string;
  readonly message: string;
  readonly objects?: readonly string[];
  readonly measurement?: Readonly<{
    readonly actual: string;
    readonly required?: string;
  }>;
}

export const MANUFACTURING_ARTIFACT_ENTRY_LIMIT = 128;
export const MANUFACTURING_ARTIFACT_DEPTH_LIMIT = 8;
export const MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
export const MANUFACTURING_ARTIFACT_TOTAL_BYTES_LIMIT = 64 * 1024 * 1024;
export const MANUFACTURING_TEXT_LINE_LIMIT = 250_000;
export const MANUFACTURING_PARSER_RECORD_LIMIT = 25_000;
export const MANUFACTURING_PARSER_RECORD_TOTAL_LIMIT = 125_000;
export const MANUFACTURING_PARSER_WARNING_LIMIT = 1_024;
export const MANUFACTURING_PARSER_WARNING_CHARACTER_LIMIT = 65_536;
export const MANUFACTURING_RECONCILIATION_FEATURE_LIMIT = 4_096;
export const MANUFACTURING_CSV_ROW_LIMIT = 4_096;
export const MANUFACTURING_CSV_FIELD_LIMIT = 64;
export const MANUFACTURING_CSV_FIELD_CHARACTER_LIMIT = 16_384;
export const MANUFACTURING_CSV_ROW_CHARACTER_LIMIT = 65_536;
export const MANUFACTURING_CIRCUIT_NODE_LIMIT = 250_000;
export const MANUFACTURING_CIRCUIT_MEMBER_LIMIT = 500_000;
export const MANUFACTURING_CIRCUIT_STRING_CHARACTER_LIMIT = 8 * 1024 * 1024;
export const MANUFACTURING_CIRCUIT_VALUE_STRING_LIMIT = 65_536;
export const MANUFACTURING_CIRCUIT_ARRAY_LENGTH_LIMIT = 20_000;
export const MANUFACTURING_CIRCUIT_OBJECT_KEY_LIMIT = 256;
export const MANUFACTURING_CIRCUIT_DEPTH_LIMIT = 32;

class ManufacturingInputLimitError extends Error {}
class ManufacturingSymlinkError extends Error {}

export interface ManufacturingVerification {
  readonly passed: boolean;
  readonly parser: "gerber-parser@4.2.7";
  /** Exact expectation identity against which captured artifact bytes were checked. */
  readonly expectation: {
    readonly boardName: string;
    readonly sha256: string;
  };
  readonly findings: readonly ManufacturingFinding[];
  /** Exact regular-file bytes bounded by the verification pass. */
  readonly artifacts: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

const verifierIssuedResults = new WeakSet<object>();
const hasVerifierIssuedResult = WeakSet.prototype.has.bind(verifierIssuedResults);
const markVerifierIssuedResult = WeakSet.prototype.add.bind(verifierIssuedResults);

/**
 * Identity check for evidence issued by this module's verifier. Structural
 * lookalikes cannot acquire this authority merely by copying result fields.
 */
export function isVerifierIssuedManufacturingVerification(
  value: unknown,
): value is Readonly<ManufacturingVerification> {
  return typeof value === "object" && value !== null && hasVerifierIssuedResult(value);
}

interface ParserRecord {
  line?: number;
  type?: string;
  level?: string;
  prop?: string;
  value?: unknown;
  code?: string;
  tool?: { shape?: string; params?: number[]; hole?: number[] };
  op?: string;
  coord?: { x?: number; y?: number };
}

interface ParserWarning {
  message: string;
  line?: number;
}

interface ParserBudget {
  remaining: number;
}

function isBoundedParserValue(value: unknown, depth = 0): boolean {
  if (
    value === undefined || value === null || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 4_096)
  ) return true;
  if (depth >= 2 || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.length <= 16 && value.every((item) => isBoundedParserValue(item, depth + 1));
  }
  let entries = 0;
  for (const key in value as Record<string, unknown>) {
    entries += 1;
    if (
      entries > 16 || key.length > 128 ||
      !isBoundedParserValue((value as Record<string, unknown>)[key], depth + 1)
    ) return false;
  }
  return true;
}

async function parseArtifact(
  content: string,
  filetype: "gerber" | "drill",
  aggregateBudget: ParserBudget,
): Promise<{ records: ParserRecord[]; warnings: ParserWarning[] }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const parser = gerberParser({ filetype });
    const records: ParserRecord[] = [];
    const warnings: ParserWarning[] = [];
    let warningCharacters = 0;
    let settled = false;
    parser.on("data", (record: ParserRecord) => {
      if (settled) return;
      if (
        records.length >= MANUFACTURING_PARSER_RECORD_LIMIT ||
        aggregateBudget.remaining <= 0
      ) {
        settled = true;
        const error = new ManufacturingInputLimitError(
          `Manufacturing parser exceeds ${MANUFACTURING_PARSER_RECORD_LIMIT} records per artifact or ${MANUFACTURING_PARSER_RECORD_TOTAL_LIMIT} records per package`,
        );
        rejectPromise(error);
        (parser as unknown as { destroy(): void }).destroy();
        return;
      }
      const toolParams = record.tool?.params;
      const toolHoles = record.tool?.hole;
      if (
        (toolParams !== undefined && !Array.isArray(toolParams)) ||
        (toolHoles !== undefined && !Array.isArray(toolHoles)) ||
        (toolParams?.length ?? 0) > 8 || (toolHoles?.length ?? 0) > 8 ||
        (toolParams?.length ?? 0) + (toolHoles?.length ?? 0) > 16 ||
        (toolParams ?? []).some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
        (toolHoles ?? []).some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
        [record.type, record.level, record.prop, record.code, record.op, record.tool?.shape]
          .some((value) => typeof value === "string" && value.length > 4_096) ||
        !isBoundedParserValue(record.value)
      ) {
        settled = true;
        const error = new ManufacturingInputLimitError(
          "Manufacturing parser record exceeds bounded field or tool-parameter limits",
        );
        rejectPromise(error);
        (parser as unknown as { destroy(): void }).destroy();
        return;
      }
      records.push(record);
      aggregateBudget.remaining -= 1;
    });
    parser.on("warning", (warning: ParserWarning) => {
      if (settled) return;
      warningCharacters += warning.message.length;
      if (
        warning.message.length > 4_096 ||
        warnings.length >= MANUFACTURING_PARSER_WARNING_LIMIT ||
        warningCharacters > MANUFACTURING_PARSER_WARNING_CHARACTER_LIMIT
      ) {
        settled = true;
        const error = new ManufacturingInputLimitError(
          `Manufacturing parser exceeds ${MANUFACTURING_PARSER_WARNING_LIMIT} warnings or ${MANUFACTURING_PARSER_WARNING_CHARACTER_LIMIT} warning characters per artifact`,
        );
        rejectPromise(error);
        (parser as unknown as { destroy(): void }).destroy();
        return;
      }
      warnings.push(warning);
    });
    parser.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    parser.on("finish", () => {
      if (!settled) {
        settled = true;
        resolvePromise({ records, warnings });
      }
    });
    const chunkCharacters = 64 * 1024;
    for (let offset = 0; offset < content.length && !settled; offset += chunkCharacters) {
      parser.write(content.slice(offset, offset + chunkCharacters));
    }
    if (!settled) parser.end();
  });
}

function expectedGerbers(expectation: ManufacturingExpectation): Record<string, string> {
  const count = expectation.layerCount;
  return {
    [`gerbers/${expectation.boardName}-F_Cu.gbr`]: "Copper,L1,Top",
    ...(count === 4
      ? {
          [`gerbers/${expectation.boardName}-In1_Cu.gbr`]: "Copper,L2,Inr",
          [`gerbers/${expectation.boardName}-In2_Cu.gbr`]: "Copper,L3,Inr",
        }
      : {}),
    [`gerbers/${expectation.boardName}-B_Cu.gbr`]: `Copper,L${count},Bot`,
    [`gerbers/${expectation.boardName}-F_Mask.gbr`]: "Soldermask,Top",
    [`gerbers/${expectation.boardName}-B_Mask.gbr`]: "Soldermask,Bot",
    [`gerbers/${expectation.boardName}-F_Paste.gbr`]: "Paste,Top",
    [`gerbers/${expectation.boardName}-B_Paste.gbr`]: "Paste,Bot",
    [`gerbers/${expectation.boardName}-F_SilkScreen.gbr`]: "Legend,Top",
    [`gerbers/${expectation.boardName}-B_SilkScreen.gbr`]: "Legend,Bot",
    [`gerbers/${expectation.boardName}-Edge_Cuts.gbr`]: "Profile,NP",
  };
}

function expectedPaths(expectation: ManufacturingExpectation): Set<string> {
  const paths = new Set(Object.keys(expectedGerbers(expectation)));
  if (expectation.platedDrills.length > 0) {
    paths.add(`drills/drill-L1-L${expectation.layerCount}.drl`);
  }
  if (expectation.nonPlatedDrills.length > 0) paths.add("drills/drill_npth.drl");
  paths.add("assembly/bom.csv");
  paths.add("assembly/positions.csv");
  paths.add("fabrication/metadata.json");
  return paths;
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  let entryCount = 0;
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new ManufacturingSymlinkError(
      "Manufacturing artifact root must be a regular non-symlinked directory",
    );
  }
  const rootPath = await realpath(root);
  const visit = async (directory: string, prefix = "", depth = 0): Promise<void> => {
    if (depth > MANUFACTURING_ARTIFACT_DEPTH_LIMIT) {
      throw new ManufacturingInputLimitError(
        `Manufacturing artifact traversal exceeds ${MANUFACTURING_ARTIFACT_DEPTH_LIMIT} directories`,
      );
    }
    for await (const entry of await opendir(directory)) {
      entryCount += 1;
      if (entryCount > MANUFACTURING_ARTIFACT_ENTRY_LIMIT) {
        throw new ManufacturingInputLimitError(
          `Manufacturing artifact traversal exceeds ${MANUFACTURING_ARTIFACT_ENTRY_LIMIT} entries`,
        );
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) result.push(path);
      else if (entry.isDirectory()) await visit(join(directory, entry.name), path, depth + 1);
      else if (entry.isFile()) result.push(path);
      else throw new Error(`Manufacturing artifact tree contains non-regular entry ${path}`);
    }
  };
  await visit(rootPath);
  return result.sort();
}

async function safeReadBytes(root: string, path: string): Promise<Buffer> {
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new ManufacturingSymlinkError(
      "Manufacturing artifact root must be a regular non-symlinked directory",
    );
  }
  const rootPath = await realpath(root);
  const candidate = resolve(rootPath, ...path.split("/"));
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("artifact is a symlink or is not a regular file");
  }
  const actual = await realpath(candidate);
  if (
    (actual !== rootPath && !actual.startsWith(`${rootPath}${sep}`)) ||
    actual !== candidate
  ) {
    throw new Error("artifact resolves outside the manufacturing directory");
  }
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("artifact is not a regular file");
    if (
      !Number.isSafeInteger(before.size) || before.size < 0 ||
      before.size > MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT
    ) {
      throw new ManufacturingInputLimitError(
        `${path} exceeds the ${MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT}-byte manufacturing artifact limit`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(actual);
    const currentCandidate = await realpath(candidate);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size || current.isSymbolicLink() || !current.isFile() ||
      current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs ||
      currentCandidate !== actual
    ) throw new Error(`${path} changed while its bytes were captured`);
    return bytes;
  } finally {
    await handle.close();
  }
}

interface CapturedArtifactSnapshot {
  readonly artifacts: ManufacturingVerification["artifacts"];
  readonly bytesByPath: ReadonlyMap<string, Buffer>;
}

async function captureArtifactSnapshot(
  root: string,
  paths: readonly string[],
): Promise<CapturedArtifactSnapshot> {
  const artifacts: Array<{ path: string; size: number; sha256: string }> = [];
  const bytesByPath = new Map<string, Buffer>();
  let declaredBytes = 0;
  for (const path of [...paths].sort()) {
    try {
      const stat = await lstat(join(root, ...path.split("/")));
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (
        !Number.isSafeInteger(stat.size) || stat.size < 0 ||
        stat.size > MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT
      ) return Object.freeze({ artifacts: Object.freeze([]), bytesByPath });
      declaredBytes += stat.size;
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes > MANUFACTURING_ARTIFACT_TOTAL_BYTES_LIMIT
      ) return Object.freeze({ artifacts: Object.freeze([]), bytesByPath });
    } catch {
      // Missing and unsafe files are represented by an incomplete snapshot.
    }
  }
  let totalBytes = 0;
  for (const path of [...paths].sort()) {
    try {
      const bytes = await safeReadBytes(root, path);
      if (
        !Number.isSafeInteger(totalBytes + bytes.byteLength) ||
        totalBytes + bytes.byteLength > MANUFACTURING_ARTIFACT_TOTAL_BYTES_LIMIT
      ) continue;
      totalBytes += bytes.byteLength;
      bytesByPath.set(path, bytes);
      artifacts.push(Object.freeze({
        path,
        size: bytes.byteLength,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      }));
    } catch {
      // The main verifier reports missing, symlinked, or escaped files. A
      // partial set can never accompany a passing result.
    }
  }
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    bytesByPath,
  });
}

function isKnownParserLimitation(warning: ParserWarning): boolean {
  return (
    warning.message.includes("was not recognized and was ignored") &&
    (warning.message.includes("%TF.") || warning.message.includes('"%TD"') ||
      /"%LR(?:0|90|180|270)"/u.test(warning.message))
  ) || warning.message === "zero suppression missing; assuming trailing suppression";
}

function fileAttributeValues(content: string, attribute: string): string[] {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(
    content.matchAll(
      new RegExp(
        `^(?:%TF\\.${escaped},([^*\\r\\n]+)\\*%|; #@! TF\\.${escaped},([^\\r\\n]+))$`,
        "gm",
      ),
    ),
    (match) => match[1] ?? match[2]!,
  );
}

function fileFunctions(content: string): string[] {
  return fileAttributeValues(content, "FileFunction");
}

function wholeLineCount(content: string, line: string): number {
  return content.split(/\r?\n/).filter((candidate) => candidate === line).length;
}

function nonBlankLines(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function assertTextLineLimit(content: string, path: string): void {
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > MANUFACTURING_TEXT_LINE_LIMIT) {
      throw new ManufacturingInputLimitError(
        `${path} exceeds ${MANUFACTURING_TEXT_LINE_LIMIT} logical text lines`,
      );
    }
  }
}

function normalizedDrillCommand(line: string): string {
  return line.trim().replace(/^N\d+\s*/i, "");
}

function close(a: number, b: number, tolerance = 0.000_01): boolean {
  return Math.abs(a - b) <= tolerance;
}

interface ParsedFlash {
  x: number;
  y: number;
  shape: string;
  dimensions: number[];
  holes: number[];
}

interface ParsedSegment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  interpolation: string;
  apertureShape: string;
  apertureDimensions: number[];
  apertureHoles: number[];
}

interface ParsedGeometry {
  flashes: ParsedFlash[];
  segments: ParsedSegment[];
  plottedOperationCount: number;
  representedOperationCount: number;
  unrepresentableOperationCount: number;
}

interface ParsedAperture {
  shape: string;
  dimensions: number[];
  holes: number[];
}

function hasFinitePositiveDimensions(
  aperture: ParsedAperture,
  count: number,
): boolean {
  return aperture.dimensions.length === count &&
    aperture.dimensions.every((value) => Number.isFinite(value) && value > 0) &&
    aperture.holes.length === 0;
}

function isRepresentableFlashAperture(aperture: ParsedAperture): boolean {
  return (aperture.shape === "circle" && hasFinitePositiveDimensions(aperture, 1)) ||
    (aperture.shape === "rect" && hasFinitePositiveDimensions(aperture, 2));
}

function isRepresentableDrawAperture(aperture: ParsedAperture): boolean {
  return aperture.shape === "circle" && hasFinitePositiveDimensions(aperture, 1);
}

function parsedGeometry(records: ParserRecord[]): {
  flashes: ParsedFlash[];
  segments: ParsedSegment[];
  plottedOperationCount: number;
  representedOperationCount: number;
  unrepresentableOperationCount: number;
} {
  const tools = new Map<string, ParsedAperture>();
  let selected: string | undefined;
  let current: { x: number; y: number } | undefined;
  let interpolation = "i";
  const flashes: ParsedFlash[] = [];
  const segments: ParsedSegment[] = [];
  let plottedOperationCount = 0;
  let representedOperationCount = 0;
  let unrepresentableOperationCount = 0;
  for (const record of records) {
    if (
      record.type === "tool" && record.code !== undefined &&
      typeof record.tool?.shape === "string" && Array.isArray(record.tool.params)
    ) {
      tools.set(record.code, {
        shape: record.tool.shape,
        dimensions: [...record.tool.params],
        holes: [...(record.tool.hole ?? [])],
      });
    } else if (record.type === "set" && record.prop === "tool") {
      selected = String(record.value);
    } else if (record.type === "set" && record.prop === "mode") {
      interpolation = String(record.value);
    } else if (record.type === "op") {
      const hasPoint = record.coord !== undefined &&
        typeof record.coord.x === "number" && Number.isFinite(record.coord.x) &&
        typeof record.coord.y === "number" && Number.isFinite(record.coord.y);
      const point = hasPoint ? { x: record.coord!.x!, y: record.coord!.y! } : undefined;
      const plotted = record.op === "flash" || record.op === "int";
      if (plotted) plottedOperationCount += 1;
      if (plotted && point === undefined) {
        unrepresentableOperationCount += 1;
        continue;
      }
      const tool = selected === undefined ? undefined : tools.get(selected);
      if (record.op === "flash" && point !== undefined) {
        if (tool === undefined || !isRepresentableFlashAperture(tool)) {
          unrepresentableOperationCount += 1;
          current = point;
          continue;
        }
        if (flashes.length >= MANUFACTURING_RECONCILIATION_FEATURE_LIMIT) {
          throw new ManufacturingInputLimitError(
            `Parsed flashes exceed ${MANUFACTURING_RECONCILIATION_FEATURE_LIMIT} features`,
          );
        }
        flashes.push({
          ...point,
          shape: tool.shape,
          dimensions: [...tool.dimensions],
          holes: [...tool.holes],
        });
        representedOperationCount += 1;
      } else if (record.op === "int" && point !== undefined) {
        if (current === undefined || tool === undefined || !isRepresentableDrawAperture(tool)) {
          unrepresentableOperationCount += 1;
          current = point;
          continue;
        }
        if (segments.length >= MANUFACTURING_RECONCILIATION_FEATURE_LIMIT) {
          throw new ManufacturingInputLimitError(
            `Parsed segments exceed ${MANUFACTURING_RECONCILIATION_FEATURE_LIMIT} features`,
          );
        }
        segments.push({
          startX: current.x,
          startY: current.y,
          endX: point.x,
          endY: point.y,
          width: tool.dimensions[0]!,
          interpolation,
          apertureShape: tool.shape,
          apertureDimensions: [...tool.dimensions],
          apertureHoles: [...tool.holes],
        });
        representedOperationCount += 1;
      }
      if (point !== undefined) current = point;
    }
  }
  return {
    flashes,
    segments,
    plottedOperationCount,
    representedOperationCount,
    unrepresentableOperationCount,
  } satisfies ParsedGeometry;
}

function sameFlash(actual: ParsedFlash, expected: ExpectedFlash): boolean {
  return close(actual.x, expected.x) && close(actual.y, expected.y) &&
    actual.shape === expected.shape &&
    actual.holes.length === 0 &&
    actual.dimensions.length === expected.dimensions.length &&
    actual.dimensions.every((dimension, index) =>
      close(dimension, expected.dimensions[index]!)
    );
}

function sameSegment(actual: ParsedSegment, expected: ExpectedSegment): boolean {
  const forward = close(actual.startX, expected.startX) &&
    close(actual.startY, expected.startY) &&
    close(actual.endX, expected.endX) && close(actual.endY, expected.endY);
  const reverse = close(actual.startX, expected.endX) &&
    close(actual.startY, expected.endY) &&
    close(actual.endX, expected.startX) && close(actual.endY, expected.startY);
  return (forward || reverse) && close(actual.width, expected.width) &&
    actual.interpolation === "i" && actual.apertureShape === "circle" &&
    actual.apertureDimensions.length === 1 && actual.apertureHoles.length === 0;
}

function sameMultiset<A, E>(
  actual: A[],
  expected: readonly E[],
  matches: (actual: A, expected: E) => boolean,
): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  for (const wanted of expected) {
    const index = remaining.findIndex((item) => matches(item, wanted));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function isStrictSubset<A, E>(
  actual: A[],
  expected: readonly E[],
  matches: (actual: A, expected: E) => boolean,
): boolean {
  if (actual.length >= expected.length) return false;
  const remaining = [...expected];
  for (const item of actual) {
    const index = remaining.findIndex((wanted) => matches(item, wanted));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length > 0;
}

function parsedDrillHits(records: ParserRecord[], content: string): ExpectedDrillHit[] {
  const tools = new Map<string, number>();
  let selected: string | undefined;
  const hits: ExpectedDrillHit[] = [];
  const lines = content.split(/\r?\n/u);
  for (const record of records) {
    if (
      record.type === "tool" &&
      record.code !== undefined &&
      typeof record.tool?.params?.[0] === "number"
    ) {
      tools.set(record.code, record.tool.params[0]);
    } else if (record.type === "set" && record.prop === "tool") {
      selected = String(record.value);
    } else if (
      record.type === "op" &&
      record.op === "flash" &&
      typeof record.coord?.x === "number" &&
      typeof record.coord.y === "number" &&
      selected !== undefined &&
      tools.has(selected)
    ) {
      if (hits.length >= MANUFACTURING_RECONCILIATION_FEATURE_LIMIT) {
        throw new ManufacturingInputLimitError(
          `Parsed drill hits exceed ${MANUFACTURING_RECONCILIATION_FEATURE_LIMIT} features`,
        );
      }
      const line = record.line === undefined ? "" : normalizedDrillCommand(lines[record.line - 1] ?? "");
      const diameter = tools.get(selected)!;
      if (line.startsWith("G85")) {
        const start = hits.pop();
        if (start === undefined || start.slot !== undefined || !Number.isFinite(diameter)) {
          throw new Error("Routed slot is missing one authenticated start coordinate");
        }
        hits.push({
          x: (start.x + record.coord.x) / 2,
          y: (start.y + record.coord.y) / 2,
          diameter,
          source: "parsed-artifact",
          slot: {
            startX: start.x,
            startY: start.y,
            endX: record.coord.x,
            endY: record.coord.y,
          },
        });
      } else {
        hits.push({
          x: record.coord.x,
          y: record.coord.y,
          diameter,
          source: "parsed-artifact",
        });
      }
    }
  }
  return hits;
}

function hasInvalidDrillToolDefinition(records: readonly ParserRecord[]): boolean {
  return records.some((record) => {
    if (record.type !== "tool") return false;
    const diameter = record.tool?.params?.[0];
    return record.code === undefined || record.tool?.shape !== "circle" ||
      !Array.isArray(record.tool.params) || record.tool.params.length !== 1 ||
      typeof diameter !== "number" || !Number.isFinite(diameter) || diameter <= 0 ||
      !Array.isArray(record.tool.hole) || record.tool.hole.length !== 0;
  });
}

function hasUnresolvedToolOperation(records: readonly ParserRecord[]): boolean {
  const declared = new Set<string>();
  let selected: string | undefined;
  for (const record of records) {
    if (record.type === "tool" && record.code !== undefined) {
      declared.add(record.code);
    } else if (record.type === "set" && record.prop === "tool") {
      selected = String(record.value);
      if (!declared.has(selected)) return true;
    } else if (record.type === "op" && ["flash", "int"].includes(String(record.op))) {
      if (selected === undefined || !declared.has(selected)) return true;
    }
  }
  return false;
}

function sameHits(actual: ExpectedDrillHit[], expected: readonly ExpectedDrillHit[]): boolean {
  if (actual.length !== expected.length) return false;
  // The pinned Excellon adapter emits ordinary hits to 4 decimals and G85
  // slot endpoints to 3 decimals. Reconciliation uses exactly that declared
  // output resolution, never a wider manufacturing tolerance.
  const drillClose = (left: number, right: number): boolean => close(left, right, 0.000_51);
  const remaining = [...actual];
  for (const wanted of expected) {
    const index = remaining.findIndex((hit) => {
      if (!drillClose(hit.x, wanted.x) || !drillClose(hit.y, wanted.y) ||
        !drillClose(hit.diameter, wanted.diameter) ||
        (hit.slot === undefined) !== (wanted.slot === undefined)) return false;
      if (hit.slot === undefined || wanted.slot === undefined) return true;
      const forward = drillClose(hit.slot.startX, wanted.slot.startX) &&
        drillClose(hit.slot.startY, wanted.slot.startY) &&
        drillClose(hit.slot.endX, wanted.slot.endX) && drillClose(hit.slot.endY, wanted.slot.endY);
      const reverse = drillClose(hit.slot.startX, wanted.slot.endX) &&
        drillClose(hit.slot.startY, wanted.slot.endY) &&
        drillClose(hit.slot.endX, wanted.slot.startX) && drillClose(hit.slot.endY, wanted.slot.startY);
      return forward || reverse;
    });
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let rowCharacters = 0;
  const pushField = (): void => {
    if (row.length >= MANUFACTURING_CSV_FIELD_LIMIT) {
      throw new ManufacturingInputLimitError(
        `CSV row exceeds ${MANUFACTURING_CSV_FIELD_LIMIT} fields`,
      );
    }
    row.push(field.replace(/\r$/, ""));
    field = "";
    quoteClosed = false;
  };
  const pushRow = (): void => {
    if (row.some((value) => value.length > 0)) {
      if (rows.length >= MANUFACTURING_CSV_ROW_LIMIT) {
        throw new ManufacturingInputLimitError(
          `CSV exceeds ${MANUFACTURING_CSV_ROW_LIMIT} rows`,
        );
      }
      rows.push(row);
    }
    row = [];
    rowCharacters = 0;
  };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char !== "\n") {
      rowCharacters += 1;
      if (rowCharacters > MANUFACTURING_CSV_ROW_CHARACTER_LIMIT) {
        throw new ManufacturingInputLimitError(
          `CSV row exceeds ${MANUFACTURING_CSV_ROW_CHARACTER_LIMIT} characters`,
        );
      }
    }
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        quoteClosed = true;
      }
      else field += char;
    } else if (char === '"') {
      if (field.length > 0 || quoteClosed) throw new Error("quote starts inside an unquoted CSV field");
      quoted = true;
    }
    else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushField();
      pushRow();
    } else {
      if (quoteClosed && char !== "\r") throw new Error("characters follow a closed CSV quote");
      field += char;
    }
    if (field.length > MANUFACTURING_CSV_FIELD_CHARACTER_LIMIT) {
      throw new ManufacturingInputLimitError(
        `CSV field exceeds ${MANUFACTURING_CSV_FIELD_CHARACTER_LIMIT} characters`,
      );
    }
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
}

function assertNoDuplicateJsonObjectKeys(content: string): void {
  const whitespace = /\s/u;
  const skipWhitespace = (start: number): number => {
    let index = start;
    while (index < content.length && whitespace.test(content[index]!)) index += 1;
    return index;
  };
  const stringEnd = (start: number): number => {
    let index = start + 1;
    while (index < content.length) {
      if (content[index] === "\\") {
        index += 2;
        continue;
      }
      if (content[index] === '"') return index + 1;
      index += 1;
    }
    throw new SyntaxError("Unterminated JSON string");
  };
  const visitValue = (start: number): number => {
    let index = skipWhitespace(start);
    if (content[index] === '"') return stringEnd(index);
    if (content[index] === "[") {
      index = skipWhitespace(index + 1);
      if (content[index] === "]") return index + 1;
      while (index < content.length) {
        index = skipWhitespace(visitValue(index));
        if (content[index] === "]") return index + 1;
        if (content[index] !== ",") throw new SyntaxError("Invalid JSON array");
        index = skipWhitespace(index + 1);
      }
      throw new SyntaxError("Unterminated JSON array");
    }
    if (content[index] === "{") {
      const keys = new Set<string>();
      index = skipWhitespace(index + 1);
      if (content[index] === "}") return index + 1;
      while (index < content.length) {
        if (content[index] !== '"') throw new SyntaxError("Invalid JSON object key");
        const end = stringEnd(index);
        const key = JSON.parse(content.slice(index, end)) as string;
        if (keys.has(key)) throw new SyntaxError(`Duplicate JSON object key ${JSON.stringify(key)}`);
        keys.add(key);
        index = skipWhitespace(end);
        if (content[index] !== ":") throw new SyntaxError("Invalid JSON object");
        index = skipWhitespace(visitValue(index + 1));
        if (content[index] === "}") return index + 1;
        if (content[index] !== ",") throw new SyntaxError("Invalid JSON object");
        index = skipWhitespace(index + 1);
      }
      throw new SyntaxError("Unterminated JSON object");
    }
    while (
      index < content.length &&
      content[index] !== "," && content[index] !== "]" && content[index] !== "}" &&
      !whitespace.test(content[index]!)
    ) index += 1;
    return index;
  };

  const end = skipWhitespace(visitValue(0));
  if (end !== content.length) throw new SyntaxError("Trailing JSON content");
}

function samePlacement(actual: string[], expected: ExpectedPlacement): boolean {
  const numeric = [actual[1], actual[2], actual[4]];
  if (numeric.some((value) => value === undefined || value.trim() === "" || !Number.isFinite(Number(value)))) {
    return false;
  }
  return actual[0] === expected.designator &&
    close(Number(actual[1]), expected.x, 0.000_51) &&
    close(Number(actual[2]), expected.y, 0.000_51) &&
    actual[3] === expected.layer &&
    close(Number(actual[4]), expected.rotation, 0.000_51);
}

function sameCountedRows(actual: readonly string[][], expected: readonly string[][]): boolean {
  if (actual.length !== expected.length) return false;
  const counts = new Map<string, number>();
  for (const row of actual) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of expected) {
    const key = JSON.stringify(row);
    const count = counts.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
  }
  return counts.size === 0;
}

function samePlacementMultiset(
  actual: string[][],
  expected: readonly ExpectedPlacement[],
): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  for (const placement of expected) {
    const index = remaining.findIndex((row) => samePlacement(row, placement));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function assertBoundedArray(name: string, value: unknown, limit: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new ManufacturingInputLimitError(`${name} exceeds ${limit} entries`);
  }
}

function assertBoundedString(name: string, value: unknown, limit: number): asserts value is string {
  if (typeof value !== "string" || value.length > limit) {
    throw new ManufacturingInputLimitError(`${name} exceeds ${limit} characters`);
  }
}

function assertManufacturingSourceIdentifier(value: unknown): asserts value is string {
  assertBoundedString("manufacturing expectation source", value, 4_096);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new ManufacturingInputLimitError(
      "manufacturing expectation source must be a non-empty conservative circuit identifier",
    );
  }
}

function assertFiniteExpectationNumber(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ManufacturingInputLimitError(`${name} must be a finite number`);
  }
}

function assertPositiveExpectationNumber(name: string, value: unknown): asserts value is number {
  assertFiniteExpectationNumber(name, value);
  if (value <= 0) {
    throw new ManufacturingInputLimitError(`${name} must be strictly positive`);
  }
}

function assertManufacturingExpectationLimits(expectation: ManufacturingExpectation): void {
  if (typeof expectation.boardName !== "string" || expectation.boardName.length > 128) {
    throw new ManufacturingInputLimitError("Manufacturing board name exceeds 128 characters");
  }
  assertBoundedString("Manufacturing board material", expectation.board.material, 256);
  if (!isBaselineSupportedBoardMaterial(expectation.board.material)) {
    throw new ManufacturingInputLimitError(
      `Manufacturing board material must be one of ${BASELINE_FABRICATION_PROFILE.supportedBoardMaterials.join(", ")}`,
    );
  }
  if (expectation.layerCount !== 2 && expectation.layerCount !== 4) {
    throw new ManufacturingInputLimitError("Manufacturing layer count must be 2 or 4");
  }
  for (const [name, value] of Object.entries({
    centerX: expectation.board.centerX,
    centerY: expectation.board.centerY,
  })) assertFiniteExpectationNumber(`board.${name}`, value);
  for (const [name, value] of Object.entries({
    width: expectation.board.width,
    height: expectation.board.height,
    thickness: expectation.board.thickness,
  })) assertPositiveExpectationNumber(`board.${name}`, value);
  const featureRecords = [
    ["flashes", expectation.flashes],
    ["copper segments", expectation.copperSegments],
    ["silkscreen segments", expectation.silkscreenSegments],
  ] as const;
  for (const [name, record] of featureRecords) {
    let groups = 0;
    for (const key in record) {
      groups += 1;
      if (key.length > 64) {
        throw new ManufacturingInputLimitError(`${name} layer key exceeds 64 characters`);
      }
      if (groups > 16) {
        throw new ManufacturingInputLimitError(`${name} exceeds 16 layer groups`);
      }
      assertBoundedArray(
        `${name}.${key}`,
        record[key],
        MANUFACTURING_RECONCILIATION_FEATURE_LIMIT,
      );
      const collection = record[key] as ReadonlyArray<{
        source?: unknown;
        dimensions?: unknown;
      }>;
      for (const item of collection) {
        assertManufacturingSourceIdentifier(item.source);
        if (
          name === "flashes" && /_Cu$/.test(key) &&
          !/^pcb_(?:smtpad|plated_hole|via)_/.test(item.source)
        ) {
          throw new ManufacturingInputLimitError(
            "copper flash sources must retain a typed SMT-pad, plated-hole, or via identity",
          );
        }
        const numeric = item as unknown as Record<string, unknown>;
        for (const field of ["x", "y", "startX", "startY", "endX", "endY", "width"]) {
          if (field in numeric) {
            assertFiniteExpectationNumber(`${name}.${key}.${field}`, numeric[field]);
          }
        }
        if (item.dimensions !== undefined) {
          assertBoundedArray(`${name}.${key} dimensions`, item.dimensions, 8);
          for (const dimension of item.dimensions) {
            assertFiniteExpectationNumber(`${name}.${key} dimension`, dimension);
          }
        }
      }
    }
  }
  const copperLayers = [
    "F_Cu",
    ...(expectation.layerCount === 4 ? ["In1_Cu", "In2_Cu"] : []),
    "B_Cu",
  ];
  const requireExactLayerKeys = (
    name: string,
    record: Readonly<Record<string, unknown>>,
    expected: readonly string[],
  ) => {
    const actual = Object.keys(record).sort();
    const required = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(required)) {
      throw new ManufacturingInputLimitError(
        `${name} must contain exactly ${required.join(", ")}`,
      );
    }
  };
  requireExactLayerKeys("flashes", expectation.flashes, [
    ...copperLayers,
    "F_Mask",
    "B_Mask",
    "F_Paste",
    "B_Paste",
  ]);
  requireExactLayerKeys("copper segments", expectation.copperSegments, copperLayers);
  requireExactLayerKeys(
    "silkscreen segments",
    expectation.silkscreenSegments,
    ["F_SilkScreen", "B_SilkScreen"],
  );
  for (const [name, value, limit] of [
    ["plated-through sources", expectation.platedThroughSources, MANUFACTURING_RECONCILIATION_FEATURE_LIMIT],
    ["plated drills", expectation.platedDrills, MANUFACTURING_RECONCILIATION_FEATURE_LIMIT],
    ["non-plated drills", expectation.nonPlatedDrills, MANUFACTURING_RECONCILIATION_FEATURE_LIMIT],
    ["assembly authority", expectation.assemblyAuthority, MANUFACTURING_CSV_ROW_LIMIT],
    ["BOM rows", expectation.bomRows, MANUFACTURING_CSV_ROW_LIMIT],
    ["placements", expectation.placements, MANUFACTURING_CSV_ROW_LIMIT],
    ["BOM headers", expectation.bomHeaders, MANUFACTURING_CSV_FIELD_LIMIT],
    ["unsupported findings", expectation.unsupported, MANUFACTURING_RECONCILIATION_FEATURE_LIMIT],
    ["unsupported details", expectation.unsupportedDetails ?? [], MANUFACTURING_RECONCILIATION_FEATURE_LIMIT],
  ] as const) assertBoundedArray(name, value, limit);
  for (const detail of expectation.unsupportedDetails ?? []) {
    assertBoundedArray("unsupported detail objects", detail.objects, 64);
    assertBoundedString("unsupported detail message", detail.message, 8_192);
    for (const object of detail.objects) {
      assertBoundedString("unsupported detail object", object, 4_096);
    }
    if (detail.measurement !== undefined) {
      assertBoundedString("unsupported measurement actual", detail.measurement.actual, 4_096);
      if (detail.measurement.required !== undefined) {
        assertBoundedString("unsupported measurement required", detail.measurement.required, 4_096);
      }
    }
  }
  for (const value of expectation.unsupported) {
    assertBoundedString("unsupported finding", value, 8_192);
  }
  for (const header of expectation.bomHeaders) {
    assertBoundedString("BOM header", header, 256);
  }
  if (JSON.stringify(expectation.bomHeaders) !== JSON.stringify(MANUFACTURING_BOM_HEADERS)) {
    throw new ManufacturingInputLimitError(
      "BOM headers must match the canonical assembly schema exactly",
    );
  }
  const platedThroughSources = new Set<string>();
  for (const source of expectation.platedThroughSources) {
    assertManufacturingSourceIdentifier(source);
    if (platedThroughSources.has(source)) {
      throw new ManufacturingInputLimitError("plated-through source identities must be unique");
    }
    platedThroughSources.add(source);
  }
  if (
    JSON.stringify([...platedThroughSources].sort()) !==
      JSON.stringify(expectation.platedThroughSources)
  ) {
    throw new ManufacturingInputLimitError(
      "plated-through source identities must use canonical sorted order",
    );
  }
  for (const item of [
    ...expectation.platedDrills,
    ...expectation.nonPlatedDrills,
    ...expectation.placements,
  ]) {
    assertManufacturingSourceIdentifier(item.source);
    assertFiniteExpectationNumber("manufacturing expectation x", item.x);
    assertFiniteExpectationNumber("manufacturing expectation y", item.y);
    if ("diameter" in item) {
      assertFiniteExpectationNumber("manufacturing expectation diameter", item.diameter);
      if (item.slot !== undefined) {
        assertFiniteExpectationNumber("manufacturing expectation slot start x", item.slot.startX);
        assertFiniteExpectationNumber("manufacturing expectation slot start y", item.slot.startY);
        assertFiniteExpectationNumber("manufacturing expectation slot end x", item.slot.endX);
        assertFiniteExpectationNumber("manufacturing expectation slot end y", item.slot.endY);
      }
    }
    if ("rotation" in item) {
      assertFiniteExpectationNumber("manufacturing expectation rotation", item.rotation);
    }
  }
  const placementDesignators = new Set<string>();
  for (const placement of expectation.placements) {
    assertBoundedString("placement designator", placement.designator, 256);
    if (!isStableAssemblyDesignator(placement.designator)) {
      throw new ManufacturingInputLimitError(
        "placement designator must be an explicit stable assembly reference",
      );
    }
    if (placementDesignators.has(placement.designator)) {
      throw new ManufacturingInputLimitError("placement designators must be unique");
    }
    placementDesignators.add(placement.designator);
    assertBoundedString("placement layer", placement.layer, 16);
    if (placement.layer !== "top" && placement.layer !== "bottom") {
      throw new ManufacturingInputLimitError(
        "placement layer must be exactly top or bottom",
      );
    }
  }
  for (const group of Object.values(expectation.flashes)) {
    for (const flash of group) assertBoundedString("flash shape", flash.shape, 16);
  }
  const copperSources = new Set(
    copperLayers.flatMap((layer) =>
      expectation.flashes[layer]!.map(({ source }) => source)
    ),
  );
  const fullStackCopper = new Map<string, ExpectedFlash>();
  for (const source of copperSources) {
    const byLayer = copperLayers.map((layer) =>
      expectation.flashes[layer]!.filter((flash) => flash.source === source)
    );
    const populatedLayerCount = byLayer.filter((flashes) => flashes.length > 0).length;
    const typedAsPlatedThrough = source.startsWith("pcb_plated_hole_") ||
      source.startsWith("pcb_via_");
    if (
      populatedLayerCount < 2 && !platedThroughSources.has(source) &&
      !typedAsPlatedThrough
    ) continue;
    const [first] = byLayer[0]!;
    if (
      !byLayer.every((flashes) => flashes.length === 1) || first === undefined ||
      !((first.shape === "circle" && first.dimensions.length === 1) ||
        (first.shape === "rect" && first.dimensions.length === 2)) ||
      first.dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0) ||
      byLayer.some(([flash]) =>
        flash === undefined || flash.shape !== first.shape ||
        flash.x !== first.x || flash.y !== first.y ||
        JSON.stringify(flash.dimensions) !== JSON.stringify(first.dimensions)
      )
    ) {
      throw new ManufacturingInputLimitError(
        "full-stack copper flashes must be one aligned circular or rectangular feature per layer and source",
      );
    }
    fullStackCopper.set(source, first);
  }
  const platedDrillsBySource = new Map<string, ExpectedDrillHit[]>();
  for (const drill of expectation.platedDrills) {
    const values = platedDrillsBySource.get(drill.source) ?? [];
    values.push(drill);
    platedDrillsBySource.set(drill.source, values);
  }
  const authoritySources = new Set([
    ...platedThroughSources,
    ...fullStackCopper.keys(),
    ...platedDrillsBySource.keys(),
  ]);
  for (const source of authoritySources) {
    const flash = fullStackCopper.get(source);
    const drills = platedDrillsBySource.get(source) ?? [];
    const drill = drills[0];
    const drillFits = flash !== undefined && drill !== undefined &&
      (drill.slot === undefined
        ? flash.shape === "circle" && drill.diameter < flash.dimensions[0]!
        : flash.shape === "rect" &&
          Math.abs(drill.slot.endX - drill.slot.startX) + drill.diameter < flash.dimensions[0]! + 1e-9 &&
          Math.abs(drill.slot.endY - drill.slot.startY) + drill.diameter < flash.dimensions[1]! + 1e-9);
    if (
      !platedThroughSources.has(source) || flash === undefined || drills.length !== 1 ||
      drill!.x !== flash.x || drill!.y !== flash.y ||
      !Number.isFinite(drill!.diameter) || drill!.diameter <= 0 || !drillFits
    ) {
      throw new ManufacturingInputLimitError(
        "full-stack copper and plated drill authority must reconcile exactly by source and geometry",
      );
    }
  }
  for (const row of expectation.bomRows) {
    let fields = 0;
    for (const key in row.columns) {
      fields += 1;
      if (fields > MANUFACTURING_CSV_FIELD_LIMIT) {
        throw new ManufacturingInputLimitError(
          `Expected BOM row exceeds ${MANUFACTURING_CSV_FIELD_LIMIT} fields`,
        );
      }
      const value = row.columns[key];
      if (
        key.length > 256 || typeof value !== "string" ||
        value.length > MANUFACTURING_CSV_FIELD_CHARACTER_LIMIT
      ) {
        throw new ManufacturingInputLimitError("Expected BOM field exceeds its character limit");
      }
    }
  }
  const physicalComponentPadSources = new Set(
    copperLayers.flatMap((layer) => expectation.flashes[layer]!)
      .map(({ source }) => source)
      .filter((source) => /^(?:pcb_smtpad_|pcb_plated_hole_)/.test(source)),
  );
  const claimedPadSources = new Set<string>();
  const sourceComponentIds = new Set<string>();
  const pcbComponentIds = new Set<string>();
  const authorityDesignators = new Set<string>();
  const requiredBomDesignators: string[] = [];
  const requiredPlacements = new Map<string, ExpectedAssemblyAuthority>();
  for (const component of expectation.assemblyAuthority) {
    assertManufacturingSourceIdentifier(component.sourceComponentId);
    assertManufacturingSourceIdentifier(component.pcbComponentId);
    assertBoundedString("assembly authority designator", component.designator, 256);
    if (!isStableAssemblyDesignator(component.designator)) {
      throw new ManufacturingInputLimitError(
        "assembly authority designator must be an explicit stable assembly reference",
      );
    }
    if (component.role !== "assembled" && component.role !== "test-point") {
      throw new ManufacturingInputLimitError(
        "assembly authority role must be exactly assembled or test-point",
      );
    }
    if (component.role === "test-point" && !/^TP[1-9][0-9]*$/.test(component.designator)) {
      throw new ManufacturingInputLimitError(
        "test-point assembly authority must use an explicit TP designator",
      );
    }
    if (
      typeof component.dnp !== "boolean" ||
      typeof component.bomRequired !== "boolean" ||
      typeof component.placementRequired !== "boolean"
    ) {
      throw new ManufacturingInputLimitError(
        "assembly authority requirement flags must be booleans",
      );
    }
    const expectedBomRequired = component.role === "assembled";
    const expectedPlacementRequired = expectedBomRequired && !component.dnp;
    if (
      component.bomRequired !== expectedBomRequired ||
      component.placementRequired !== expectedPlacementRequired
    ) {
      throw new ManufacturingInputLimitError(
        "assembly authority BOM and placement requirements contradict role or DNP state",
      );
    }
    if (
      sourceComponentIds.has(component.sourceComponentId) ||
      pcbComponentIds.has(component.pcbComponentId) ||
      authorityDesignators.has(component.designator)
    ) {
      throw new ManufacturingInputLimitError(
        "assembly authority source, PCB, and designator identities must be unique",
      );
    }
    sourceComponentIds.add(component.sourceComponentId);
    pcbComponentIds.add(component.pcbComponentId);
    authorityDesignators.add(component.designator);
    assertBoundedArray(
      "assembly authority pad sources",
      component.padSources,
      MANUFACTURING_RECONCILIATION_FEATURE_LIMIT,
    );
    if (component.padSources.length === 0) {
      throw new ManufacturingInputLimitError(
        "assembly authority must own at least one emitted copper pad source",
      );
    }
    if (component.role === "test-point" && component.padSources.length !== 1) {
      throw new ManufacturingInputLimitError(
        "test-point assembly authority must own exactly one emitted copper pad source",
      );
    }
    const localPadSources = new Set<string>();
    for (const source of component.padSources) {
      assertManufacturingSourceIdentifier(source);
      if (
        !/^(?:pcb_smtpad_|pcb_plated_hole_)/.test(source) ||
        localPadSources.has(source) || claimedPadSources.has(source) ||
        !physicalComponentPadSources.has(source)
      ) {
        throw new ManufacturingInputLimitError(
          "assembly authority pad sources must uniquely claim emitted component copper",
        );
      }
      localPadSources.add(source);
      claimedPadSources.add(source);
    }
    if (
      JSON.stringify([...localPadSources].sort()) !== JSON.stringify(component.padSources)
    ) {
      throw new ManufacturingInputLimitError(
        "assembly authority pad sources must use canonical sorted order",
      );
    }
    if (component.bomRequired) requiredBomDesignators.push(component.designator);
    if (component.placementRequired) requiredPlacements.set(component.designator, component);
  }
  if (
    JSON.stringify([...authorityDesignators].sort()) !==
      JSON.stringify(expectation.assemblyAuthority.map(({ designator }) => designator))
  ) {
    throw new ManufacturingInputLimitError(
      "assembly authority must use canonical designator order",
    );
  }
  const bomDesignators = expectation.bomRows.map(({ columns }) => columns.Designator ?? "");
  if (
    JSON.stringify([...bomDesignators].sort()) !==
      JSON.stringify(requiredBomDesignators.sort())
  ) {
    throw new ManufacturingInputLimitError(
      "BOM expectation must contain exactly every assembly-authority designator",
    );
  }
  const placementDesignatorSources = expectation.placements
    .map(({ designator, source }) => `${designator}\0${source}`)
    .sort();
  const requiredPlacementDesignatorSources = [...requiredPlacements]
    .map(([designator, component]) => `${designator}\0${component.pcbComponentId}`)
    .sort();
  if (
    JSON.stringify(placementDesignatorSources) !==
      JSON.stringify(requiredPlacementDesignatorSources)
  ) {
    throw new ManufacturingInputLimitError(
      "placement expectation must contain exactly every required assembly component and PCB owner",
    );
  }
}

function boundedManufacturingExpectationSnapshot(
  input: ManufacturingExpectation,
): ManufacturingExpectation {
  assertManufacturingExpectationLimits(input);
  const point = <T extends { readonly x: number; readonly y: number; readonly source: string }>(
    value: T,
  ) => ({ x: value.x, y: value.y, source: value.source });
  const flashes: Record<string, ExpectedFlash[]> = {};
  for (const key in input.flashes) {
    flashes[key] = input.flashes[key]!.map((value) => ({
      ...point(value),
      shape: value.shape,
      dimensions: [...value.dimensions],
    }));
  }
  const copySegments = (record: ManufacturingExpectation["copperSegments"]) => {
    const result: Record<string, ExpectedSegment[]> = {};
    for (const key in record) {
      result[key] = record[key]!.map((value) => ({
        startX: value.startX,
        startY: value.startY,
        endX: value.endX,
        endY: value.endY,
        width: value.width,
        source: value.source,
      }));
    }
    return result;
  };
  const drill = (value: ExpectedDrillHit): ExpectedDrillHit => ({
    ...point(value),
    diameter: value.diameter,
    ...(value.slot === undefined ? {} : { slot: { ...value.slot } }),
  });
  const snapshot: ManufacturingExpectation = {
    boardName: input.boardName,
    layerCount: input.layerCount,
    board: {
      centerX: input.board.centerX,
      centerY: input.board.centerY,
      width: input.board.width,
      height: input.board.height,
      thickness: input.board.thickness,
      material: input.board.material,
    },
    flashes,
    copperSegments: copySegments(input.copperSegments),
    silkscreenSegments: copySegments(input.silkscreenSegments),
    platedThroughSources: [...input.platedThroughSources],
    platedDrills: input.platedDrills.map(drill),
    nonPlatedDrills: input.nonPlatedDrills.map(drill),
    assemblyAuthority: input.assemblyAuthority.map((component) => ({
      sourceComponentId: component.sourceComponentId,
      pcbComponentId: component.pcbComponentId,
      designator: component.designator,
      role: component.role,
      dnp: component.dnp,
      bomRequired: component.bomRequired,
      placementRequired: component.placementRequired,
      padSources: [...component.padSources],
    })),
    bomRows: input.bomRows.map((row) => {
      const columns: Record<string, string> = {};
      for (const key in row.columns) columns[key] = row.columns[key]!;
      return { columns };
    }),
    bomHeaders: [...input.bomHeaders],
    placements: input.placements.map((value) => ({
      ...point(value),
      designator: value.designator,
      layer: value.layer,
      rotation: value.rotation,
    })),
    unsupported: [...input.unsupported],
    ...(input.unsupportedDetails === undefined
      ? {}
      : {
          unsupportedDetails: input.unsupportedDetails.map((detail) => ({
            message: detail.message,
            objects: [...detail.objects],
            ...(detail.measurement === undefined
              ? {}
              : { measurement: { ...detail.measurement } }),
          })),
        }),
  };
  // Preflight protects allocation bounds. Validate the newly allocated value
  // again so caller accessors or proxy mutations cannot substitute different
  // primitives between validation and capture.
  assertManufacturingExpectationLimits(snapshot);
  return snapshot;
}

function independentlyDerivedAssemblyAuthority(
  circuitJson: readonly AnyCircuitElement[],
): readonly ExpectedAssemblyAuthority[] {
  if (!Array.isArray(circuitJson) || circuitJson.length > 8_000) {
    throw new ManufacturingInputLimitError(
      "Circuit JSON assembly authority exceeds 8000 elements",
    );
  }
  const sourceComponents = new Map(circuitJson.flatMap((element) =>
    element.type === "source_component"
      ? [[element.source_component_id, element] as const]
      : []
  ));
  const infrastructureSourceIds = new Set(circuitJson.flatMap((element) =>
    element.type === "source_manually_placed_via"
      ? [element.source_manually_placed_via_id]
      : []
  ));
  const pads = circuitJson.filter((element) =>
    element.type === "pcb_smtpad" || element.type === "pcb_plated_hole"
  );
  return Object.freeze(circuitJson.flatMap((element): ExpectedAssemblyAuthority[] => {
    if (
      element.type !== "pcb_component" ||
      infrastructureSourceIds.has(element.source_component_id)
    ) return [];
    const source = sourceComponents.get(element.source_component_id);
    const designator = source?.name ?? "";
    if (source === undefined || !isStableAssemblyDesignator(designator)) return [];
    const role = source.ftype === "simple_test_point" ? "test-point" : "assembled";
    const dnp = element.do_not_place === true;
    return [{
      sourceComponentId: source.source_component_id,
      pcbComponentId: element.pcb_component_id,
      designator,
      role,
      dnp,
      bomRequired: role === "assembled",
      placementRequired: role === "assembled" && !dnp,
      padSources: pads.flatMap((pad) => {
        if (pad.pcb_component_id !== element.pcb_component_id) return [];
        return [pad.type === "pcb_smtpad" ? pad.pcb_smtpad_id : pad.pcb_plated_hole_id];
      }).sort(),
    }];
  }).sort((left, right) => left.designator.localeCompare(right.designator)));
}

function boundedCircuitJsonSnapshot(
  input: readonly AnyCircuitElement[],
): AnyCircuitElement[] {
  if (!Array.isArray(input) || input.length > 8_000) {
    throw new ManufacturingInputLimitError(
      "Circuit JSON manufacturing authority exceeds 8000 elements",
    );
  }
  const pending: Array<
    { value: unknown; depth: number; exit?: false } | { value: object; depth: number; exit: true }
  > = [{ value: input, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;
  let members = 0;
  let stringCharacters = 0;
  const accountString = (value: string, kind: "value" | "property name"): void => {
    if (value.length > MANUFACTURING_CIRCUIT_VALUE_STRING_LIMIT) {
      throw new ManufacturingInputLimitError(
        `Circuit JSON ${kind} exceeds ${MANUFACTURING_CIRCUIT_VALUE_STRING_LIMIT} characters`,
      );
    }
    stringCharacters += value.length;
    if (stringCharacters > MANUFACTURING_CIRCUIT_STRING_CHARACTER_LIMIT) {
      throw new ManufacturingInputLimitError(
        `Circuit JSON manufacturing authority exceeds ${MANUFACTURING_CIRCUIT_STRING_CHARACTER_LIMIT} string characters`,
      );
    }
  };
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const { value, depth } = entry;
    if (entry.exit === true) {
      active.delete(entry.value);
      continue;
    }
    nodes += 1;
    if (nodes > MANUFACTURING_CIRCUIT_NODE_LIMIT) {
      throw new ManufacturingInputLimitError(
        `Circuit JSON manufacturing authority exceeds ${MANUFACTURING_CIRCUIT_NODE_LIMIT} values`,
      );
    }
    if (depth > MANUFACTURING_CIRCUIT_DEPTH_LIMIT) {
      throw new ManufacturingInputLimitError(
        `Circuit JSON manufacturing authority exceeds depth ${MANUFACTURING_CIRCUIT_DEPTH_LIMIT}`,
      );
    }
    if (typeof value === "string") {
      accountString(value, "value");
      continue;
    }
    if (
      value === null || value === undefined || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) continue;
    if (typeof value !== "object") {
      throw new ManufacturingInputLimitError(
        "Circuit JSON manufacturing authority contains a non-data value",
      );
    }
    if (active.has(value)) {
      throw new ManufacturingInputLimitError(
        "Circuit JSON manufacturing authority contains a cycle",
      );
    }
    active.add(value);
    let prototype: object | null;
    let ownKeys: readonly PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(value);
      ownKeys = Reflect.ownKeys(value);
    } catch (error) {
      throw new ManufacturingInputLimitError(
        `Circuit JSON manufacturing authority cannot inspect data shape: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new ManufacturingInputLimitError(
        "Circuit JSON manufacturing authority contains a symbol key",
      );
    }
    const array = Array.isArray(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new ManufacturingInputLimitError(
        "Circuit JSON manufacturing authority must contain only plain data objects and arrays",
      );
    }
    const ownStringKeys = ownKeys.filter((key) => key !== "length") as string[];
    for (const key of ownStringKeys) accountString(key, "property name");
    const numericArrayKeys = array
      ? ownStringKeys.filter((key) => /^(?:0|[1-9][0-9]*)$/.test(key))
      : [];
    const arrayDecorations = array
      ? ownStringKeys.filter((key) => !/^(?:0|[1-9][0-9]*)$/.test(key))
      : [];
    if (
      arrayDecorations.length > 0 &&
      (value !== input || arrayDecorations.some((key) =>
        key !== "_internal_store" && key !== "editCount"
      ))
    ) {
      throw new ManufacturingInputLimitError(
        "Circuit JSON manufacturing authority contains a decorated nested array",
      );
    }
    const dataKeys = ownStringKeys;
    if (
      (array && value.length > MANUFACTURING_CIRCUIT_ARRAY_LENGTH_LIMIT) ||
      (!array && dataKeys.length > MANUFACTURING_CIRCUIT_OBJECT_KEY_LIMIT)
    ) {
      throw new ManufacturingInputLimitError(
        array
          ? `Circuit JSON array exceeds ${MANUFACTURING_CIRCUIT_ARRAY_LENGTH_LIMIT} entries`
          : `Circuit JSON object exceeds ${MANUFACTURING_CIRCUIT_OBJECT_KEY_LIMIT} keys`,
      );
    }
    if (
      array && (
        numericArrayKeys.length !== value.length ||
        numericArrayKeys.some((key, index) => Number(key) !== index)
      )
    ) {
      throw new ManufacturingInputLimitError(
        "Circuit JSON manufacturing authority contains a sparse or decorated array",
      );
    }
    members += dataKeys.length;
    if (members > MANUFACTURING_CIRCUIT_MEMBER_LIMIT) {
      throw new ManufacturingInputLimitError(
        `Circuit JSON manufacturing authority exceeds ${MANUFACTURING_CIRCUIT_MEMBER_LIMIT} members`,
      );
    }
    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value) as Record<
        PropertyKey,
        PropertyDescriptor
      >;
    } catch (error) {
      throw new ManufacturingInputLimitError(
        `Circuit JSON manufacturing authority cannot inspect data shape: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    pending.push({ value, depth, exit: true });
    for (const key of dataKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined || descriptor.get !== undefined ||
        descriptor.set !== undefined || !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new ManufacturingInputLimitError(
          "Circuit JSON manufacturing authority contains an accessor or hidden property",
        );
      }
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  let snapshot: unknown;
  try {
    snapshot = structuredClone(input);
  } catch (error) {
    throw new ManufacturingInputLimitError(
      `Circuit JSON manufacturing authority cannot be captured: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(snapshot) || snapshot.length !== input.length) {
    throw new ManufacturingInputLimitError(
      "Circuit JSON manufacturing authority changed during capture",
    );
  }
  return snapshot as AnyCircuitElement[];
}

function assertCompleteCircuitAuthority(
  expectation: ManufacturingExpectation,
  circuitJson: AnyCircuitElement[],
): void {
  let independentlyDerived: Readonly<ManufacturingExpectation>;
  try {
    independentlyDerived = deriveManufacturingExpectation({
      boardName: expectation.boardName,
      circuitJson,
    });
  } catch (error) {
    throw new ManufacturingInputLimitError(
      `Circuit JSON manufacturing authority is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    manufacturingExpectationSha256(independentlyDerived) !==
      manufacturingExpectationSha256(expectation)
  ) {
    throw new ManufacturingInputLimitError(
      "manufacturing expectation must exactly match the complete supplied Circuit JSON authority",
    );
  }
}

function assertIndependentAssemblyAuthority(
  expectation: ManufacturingExpectation,
  circuitJson: readonly AnyCircuitElement[],
): void {
  const independentlyDerived = independentlyDerivedAssemblyAuthority(circuitJson);
  if (JSON.stringify(independentlyDerived) !== JSON.stringify(expectation.assemblyAuthority)) {
    throw new ManufacturingInputLimitError(
      "assembly authority must exactly match independently derived Circuit JSON component ownership",
    );
  }
}

function inputLimitVerification(
  boardName: string,
  sha256: string,
  message: string,
): Readonly<ManufacturingVerification> {
  const result: Readonly<ManufacturingVerification> = Object.freeze({
    passed: false,
    parser: "gerber-parser@4.2.7" as const,
    expectation: Object.freeze({ boardName: boardName.slice(0, 128), sha256 }),
    findings: Object.freeze([Object.freeze({
      code: "MANUFACTURING_INPUT_LIMIT" as const,
      message,
    })]),
    artifacts: Object.freeze([]),
  });
  markVerifierIssuedResult(result);
  return result;
}

export async function verifyManufacturingDirectory(options: {
  readonly root: string;
  readonly expectation: ManufacturingExpectation;
  readonly circuitJson: readonly AnyCircuitElement[];
  readonly allowedAdditionalPaths?: readonly string[];
  /** @internal Deterministic proof that parsing uses captured bytes. */
  readonly afterInitialArtifactSnapshot?: () => Promise<void>;
  /** @internal Deterministic artifact-mutation test hook. */
  readonly beforeFinalArtifactSnapshot?: () => Promise<void>;
}): Promise<Readonly<ManufacturingVerification>> {
  requireSupportedBunRuntime();
  // The expectation is caller-owned mutable data. Snapshot and validate its
  // complete JSON identity before the first await so one immutable value drives
  // path selection, parsing, reconciliation, and the issued evidence binding.
  let expectation: ManufacturingExpectation;
  try {
    expectation = boundedManufacturingExpectationSnapshot(options.expectation);
    const boundedCircuitJson = boundedCircuitJsonSnapshot(options.circuitJson);
    const circuitJson = parseCanonicalCircuitJson(canonicalCircuitJson(boundedCircuitJson));
    assertCompleteCircuitAuthority(expectation, circuitJson);
    assertIndependentAssemblyAuthority(expectation, circuitJson);
  } catch (error) {
    return inputLimitVerification(
      "invalid",
      "0".repeat(64),
      error instanceof Error ? error.message : String(error),
    );
  }
  const expectationSha256 = manufacturingExpectationSha256(expectation);
  const detailByMessage = new Map(
    (expectation.unsupportedDetails ?? []).map((detail) => [detail.message, detail] as const),
  );
  if (
    detailByMessage.size !== (expectation.unsupportedDetails?.length ?? 0) ||
    [...detailByMessage].some(([message]) => !expectation.unsupported.includes(message))
  ) throw new TypeError("Manufacturing unsupported details must uniquely describe an unsupported finding");
  const findings: ManufacturingFinding[] = expectation.unsupported.map(
    (message) => {
      const detail = detailByMessage.get(message);
      return {
        code: "MANUFACTURING_UNSUPPORTED" as const,
        message,
        ...(detail === undefined ? {} : {
          objects: Object.freeze([...detail.objects]),
          ...(detail.measurement === undefined
            ? {}
            : { measurement: Object.freeze({ ...detail.measurement }) }),
        }),
      };
    },
  );
  const expected = expectedPaths(expectation);
  const allowedAdditionalPaths = options.allowedAdditionalPaths ?? [];
  if (allowedAdditionalPaths.length > MANUFACTURING_ARTIFACT_ENTRY_LIMIT) {
    return inputLimitVerification(
      expectation.boardName,
      expectationSha256,
      `Additional manufacturing paths exceed ${MANUFACTURING_ARTIFACT_ENTRY_LIMIT} entries`,
    );
  }
  for (const path of allowedAdditionalPaths) {
    if (
      path.length > 4_096 ||
      path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      return inputLimitVerification(
        expectation.boardName,
        expectationSha256,
        `Unsafe or oversized additional artifact path ${JSON.stringify(path.slice(0, 256))}`,
      );
    }
    expected.add(path);
  }
  if (expected.size > MANUFACTURING_ARTIFACT_ENTRY_LIMIT) {
    return inputLimitVerification(
      expectation.boardName,
      expectationSha256,
      `Expected manufacturing set exceeds ${MANUFACTURING_ARTIFACT_ENTRY_LIMIT} entries`,
    );
  }
  let actualPaths: string[] = [];
  try {
    actualPaths = await listFiles(options.root);
  } catch (error) {
    findings.push({
      code: error instanceof ManufacturingInputLimitError
        ? "MANUFACTURING_INPUT_LIMIT"
        : error instanceof ManufacturingSymlinkError
          ? "MANUFACTURING_FILE_SYMLINK"
          : "MANUFACTURING_FILE_MISSING",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  for (const path of expected) {
    if (!actualPaths.includes(path)) {
      findings.push({ code: "MANUFACTURING_FILE_MISSING", path, message: `${path} is missing` });
    }
  }

  const initialSnapshot = await captureArtifactSnapshot(options.root, [...expected]);
  const initialArtifacts = initialSnapshot.artifacts;
  const capturedText = (path: string): string => {
    const bytes = initialSnapshot.bytesByPath.get(path);
    if (bytes === undefined) throw new Error(`${path} was not captured as a safe regular file`);
    return bytes.toString("utf8");
  };
  await options.afterInitialArtifactSnapshot?.();
  for (const path of actualPaths) {
    if (!expected.has(path)) {
      findings.push({
        code: "MANUFACTURING_FILE_UNEXPECTED",
        path,
        message: `${path} is not part of the expected manufacturing set`,
      });
    }
  }
  let declaredArtifactBytes = 0;
  let aggregateLimitReported = false;
  for (const path of expected) {
    if (!actualPaths.includes(path)) continue;
    try {
      const stat = await lstat(join(options.root, ...path.split("/")));
      if (stat.isSymbolicLink() || !stat.isFile()) {
        findings.push({
          code: "MANUFACTURING_FILE_SYMLINK",
          path,
          message: `${path} must be a regular file and cannot be a symlink`,
        });
      } else if (
        !Number.isSafeInteger(stat.size) || stat.size < 0 ||
        stat.size > MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT
      ) {
        findings.push({
          code: "MANUFACTURING_INPUT_LIMIT",
          path,
          message: `${path} exceeds the ${MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT}-byte manufacturing artifact limit`,
        });
      } else {
        declaredArtifactBytes += stat.size;
        if (
          !aggregateLimitReported &&
          (!Number.isSafeInteger(declaredArtifactBytes) ||
            declaredArtifactBytes > MANUFACTURING_ARTIFACT_TOTAL_BYTES_LIMIT)
        ) {
          aggregateLimitReported = true;
          findings.push({
            code: "MANUFACTURING_INPUT_LIMIT",
            message: `Manufacturing artifacts exceed the ${MANUFACTURING_ARTIFACT_TOTAL_BYTES_LIMIT}-byte aggregate limit`,
          });
        }
      }
    } catch {
      // Missing paths were already reported above.
    }
  }

  const parserBudget: ParserBudget = { remaining: MANUFACTURING_PARSER_RECORD_TOTAL_LIMIT };
  const gerberGeometry = new Map<string, ReturnType<typeof parsedGeometry>>();
  for (const [path, expectedFunction] of Object.entries(
    expectedGerbers(expectation),
  )) {
    if (!actualPaths.includes(path)) continue;
    let content: string;
    try {
      content = capturedText(path);
    } catch (error) {
      findings.push({
        code: "MANUFACTURING_FILE_SYMLINK",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (content.length === 0) {
      findings.push({ code: "MANUFACTURING_FILE_EMPTY", path, message: `${path} is empty` });
      continue;
    }
    try {
      assertTextLineLimit(content, path);
    } catch (error) {
      findings.push({
        code: "MANUFACTURING_INPUT_LIMIT",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const declaredFunctions = fileFunctions(content);
    if (declaredFunctions.length !== 1 || declaredFunctions[0] !== expectedFunction) {
      findings.push({
        code: "GERBER_FILE_FUNCTION_MISMATCH",
        path,
        message: `${path} does not declare ${expectedFunction}`,
      });
    }
    const canonicalGerberLines = nonBlankLines(content);
    const expectedGenerationSoftware =
      `%TF.GenerationSoftware,tscircuit,circuit-json-to-gerber,${MANUFACTURING_PACKAGE_PINS.gerber.version}*%`;
    const formatIndex = canonicalGerberLines.indexOf("%FSLAX46Y46*%");
    const fileAttributeIndexes = canonicalGerberLines.flatMap((line, index) =>
      line.startsWith("%TF.") ? [index] : []
    );
    const deleteAttributeIndexes = canonicalGerberLines.flatMap((line, index) =>
      line === "%TD*%" ? [index] : []
    );
    const apertureDefinitionIndexes = canonicalGerberLines.flatMap((line, index) =>
      /^%ADD\d+/.test(line) ? [index] : []
    );
    const apertureListStartIndexes = canonicalGerberLines.flatMap((line, index) =>
      line === "G04 aperture START LIST*" ? [index] : []
    );
    const apertureListEndIndexes = canonicalGerberLines.flatMap((line, index) =>
      line === "G04 aperture END LIST*" ? [index] : []
    );
    const modeIndex = canonicalGerberLines.indexOf("%MOMM*%");
    const hasGeneratedApertureList = apertureListStartIndexes.length > 0;
    const attributeDeleteIsCanonical = hasGeneratedApertureList
      ? apertureListStartIndexes.length === 1 && apertureListEndIndexes.length === 1 &&
        deleteAttributeIndexes.length === 1 && apertureDefinitionIndexes.length > 0 &&
        apertureListStartIndexes[0]! < apertureDefinitionIndexes[0]! &&
        deleteAttributeIndexes[0] === apertureDefinitionIndexes.at(-1)! + 1 &&
        apertureListEndIndexes[0] === deleteAttributeIndexes[0]! + 1
      : path.endsWith("Edge_Cuts.gbr") && deleteAttributeIndexes.length === 0 &&
        apertureDefinitionIndexes.length === 1;
    const apertureAndGeometryOrderIsCanonical =
      apertureDefinitionIndexes.length > 0 &&
      apertureDefinitionIndexes.every((index) => index > modeIndex) &&
      canonicalGerberLines.flatMap((line, index) =>
        line.startsWith("%AM") ? [index] : []
      ).every((index) => index > modeIndex) &&
      canonicalGerberLines.flatMap((line, index) =>
        /^(?:D\d+\*|X-?\d+)/.test(line) ? [index] : []
      ).every((index) => index > apertureDefinitionIndexes.at(-1)!);
    if (
      wholeLineCount(content, "%FSLAX46Y46*%") !== 1 ||
      wholeLineCount(content, "%MOMM*%") !== 1 ||
      canonicalGerberLines[0] !== expectedGenerationSoftware ||
      canonicalGerberLines.filter((line) =>
        line.startsWith("%TF.GenerationSoftware,")
      ).length !== 1 ||
      canonicalGerberLines.indexOf("%MOMM*%") !== formatIndex + 1 ||
      fileAttributeIndexes.length === 0 ||
      fileAttributeIndexes.some((index) => index >= formatIndex) ||
      !attributeDeleteIsCanonical ||
      !apertureAndGeometryOrderIsCanonical ||
      /^G(?:70|71|90|91)\*$/m.test(content) ||
      canonicalGerberLines.some((line) => line !== line.trim())
    ) {
      findings.push({
        code: "GERBER_STATE_UNSUPPORTED",
        path,
        message: `${path} must use exactly the canonical absolute 4.6 metric Gerber dialect`,
      });
    }
    const expectedPolarity = path.endsWith("Edge_Cuts.gbr")
      ? undefined
      : path.includes("_Mask.gbr")
        ? "Negative"
        : "Positive";
    const declaredPolarities = fileAttributeValues(content, "FilePolarity");
    if (
      expectedPolarity === undefined
        ? declaredPolarities.length !== 0
        : declaredPolarities.length !== 1 || declaredPolarities[0] !== expectedPolarity
    ) {
      findings.push({
        code: "GERBER_POLARITY_MISMATCH",
        path,
        message: `${path} has missing, duplicate, or incorrect X2 file polarity`,
      });
    }
    const gerberLines = nonBlankLines(content).map((line) => line.trim());
    if (
      gerberLines.at(-1) !== "M02*" ||
      (content.match(/M02\*/g) ?? []).length !== 1
    ) {
      findings.push({ code: "GERBER_PARSE_ERROR", path, message: `${path} must have exactly one final Gerber end marker` });
    }
    try {
      const parsed = await parseArtifact(content, "gerber", parserBudget);
      const geometry = parsedGeometry(parsed.records);
      gerberGeometry.set(path, geometry);
      if (
        geometry.unrepresentableOperationCount > 0 ||
        geometry.representedOperationCount !== geometry.flashes.length + geometry.segments.length ||
        geometry.plottedOperationCount !==
          geometry.representedOperationCount + geometry.unrepresentableOperationCount
      ) {
        findings.push({
          code: "GERBER_STATE_UNSUPPORTED",
          path,
          message: `${path} contains ${geometry.unrepresentableOperationCount} plotted operation(s) whose aperture or coordinates cannot be reconciled`,
        });
      }
      const apertureCodes = parsed.records.flatMap((record) =>
        record.type === "tool" && record.code !== undefined ? [record.code] : []
      );
      if (new Set(apertureCodes).size !== apertureCodes.length) {
        findings.push({
          code: "GERBER_STATE_UNSUPPORTED",
          path,
          message: `${path} redefines an aperture D-code`,
        });
      }
      if (hasUnresolvedToolOperation(parsed.records)) {
        findings.push({
          code: "GERBER_STATE_UNSUPPORTED",
          path,
          message: `${path} selects or operates with an undefined aperture`,
        });
      }
      if (
        parsed.records.some(
          (record) => record.type === "level" && record.level === "polarity" && record.value !== "D",
        )
      ) {
        findings.push({
          code: "GERBER_POLARITY_MISMATCH",
          path,
          message: `${path} contains subtractive clear-polarity operations not present in the supported authored geometry`,
        });
      }
      if (
        parsed.records.some((record) =>
          record.type === "set" &&
          (
            record.prop === "backupNota" || record.prop === "backupUnits" ||
            (record.prop === "nota" && record.value !== "A") ||
            (record.prop === "units" && record.value !== "mm") ||
            (record.prop === "mode" && record.value !== "i") ||
            (record.prop === "arc" && record.value !== "m")
          )
        )
      ) {
        findings.push({
          code: "GERBER_STATE_UNSUPPORTED",
          path,
          message: `${path} changes coordinate, unit, interpolation, or arc state outside the canonical dialect`,
        });
      }
      if (
        parsed.records.some(
          (record) => record.type === "level" && record.level === "stepRep",
        )
      ) {
        findings.push({
          code: "GERBER_STEP_REPEAT_UNSUPPORTED",
          path,
          message: `${path} uses step-repeat geometry that is not present in the authored board`,
        });
      }
      if (
        parsed.records.some(
          (record) => record.type === "set" && record.prop === "region",
        )
      ) {
        findings.push({
          code: "GERBER_FEATURE_MISMATCH",
          path,
          message: `${path} uses Gerber regions that are not present in the supported authored geometry`,
        });
      }
      for (const warning of parsed.warnings.filter((item) => !isKnownParserLimitation(item))) {
        findings.push({
          code: "GERBER_PARSE_WARNING",
          path,
          message: `line ${warning.line ?? "?"}: ${warning.message}`,
        });
      }
    } catch (error) {
      findings.push({
        code: error instanceof ManufacturingInputLimitError
          ? "MANUFACTURING_INPUT_LIMIT"
          : "GERBER_PARSE_ERROR",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [layer, expectedFlashes] of Object.entries(expectation.flashes)) {
    const path = `gerbers/${expectation.boardName}-${layer}.gbr`;
    const geometry = gerberGeometry.get(path);
    if (geometry === undefined) continue;
    const actual = geometry.flashes;
    if (isStrictSubset(actual, expectedFlashes, sameFlash)) {
      findings.push({
        code: "GERBER_FEATURE_MISSING",
        path,
        message: `${path} is missing one or more authored flashes and contains no unexpected flashes`,
      });
    } else if (!sameMultiset(actual, expectedFlashes, sameFlash)) {
      findings.push({
        code: "GERBER_FEATURE_MISMATCH",
        path,
        message: `${path} parsed flashes do not match authored coordinates, shapes, and dimensions`,
      });
    }
    if (
      (layer.endsWith("_Mask") || layer.endsWith("_Paste")) &&
      geometry.segments.length > 0
    ) {
      findings.push({
        code: "GERBER_FEATURE_MISMATCH",
        path,
        message: `${path} contains unexpected drawn geometry in a flash-only layer`,
      });
    }
  }

  for (const [layer, expectedSegments] of Object.entries(
    expectation.copperSegments,
  )) {
    const path = `gerbers/${expectation.boardName}-${layer}.gbr`;
    const geometry = gerberGeometry.get(path);
    if (geometry === undefined) continue;
    const actual = geometry.segments;
    if (!sameMultiset(actual, expectedSegments, sameSegment)) {
      findings.push({
        code: "GERBER_TRACE_MISMATCH",
        path,
        message: `${path} parsed trace segments or widths do not match the routed board`,
      });
    }
    if (actual.length === 0 && expectedSegments.length > 0) {
      findings.push({ code: "GERBER_NO_OPERATIONS", path, message: `${path} contains no plotted copper traces` });
    }
  }

  for (const [layer, expectedSegments] of Object.entries(
    expectation.silkscreenSegments,
  )) {
    const path = `gerbers/${expectation.boardName}-${layer}.gbr`;
    const geometry = gerberGeometry.get(path);
    if (geometry === undefined) continue;
    const actual = geometry.segments;
    if (!sameMultiset(actual, expectedSegments, sameSegment)) {
      findings.push({
        code: "GERBER_FEATURE_MISMATCH",
        path,
        message: `${path} parsed silkscreen strokes do not match authored paths and text`,
      });
    }
    if (geometry.flashes.length > 0) {
      findings.push({
        code: "GERBER_FEATURE_MISMATCH",
        path,
        message: `${path} contains unexpected flashed geometry in a stroke-only layer`,
      });
    }
  }

  const profilePath = `gerbers/${expectation.boardName}-Edge_Cuts.gbr`;
  const profileGeometry = gerberGeometry.get(profilePath);
  if (profileGeometry !== undefined) {
    const expected = expectation.board;
    const left = expected.centerX - expected.width / 2;
    const right = expected.centerX + expected.width / 2;
    const bottom = expected.centerY - expected.height / 2;
    const top = expected.centerY + expected.height / 2;
    const expectedSegments: ExpectedSegment[] = [
      { startX: left, startY: bottom, endX: right, endY: bottom, width: 0.05, source: "board" },
      { startX: right, startY: bottom, endX: right, endY: top, width: 0.05, source: "board" },
      { startX: right, startY: top, endX: left, endY: top, width: 0.05, source: "board" },
      { startX: left, startY: top, endX: left, endY: bottom, width: 0.05, source: "board" },
    ];
    if (!sameMultiset(profileGeometry.segments, expectedSegments, sameSegment)) {
      findings.push({
        code: "GERBER_PROFILE_MISMATCH",
        path: profilePath,
        message: "Parsed profile bounds do not match the authored board",
      });
    }
    if (profileGeometry.flashes.length > 0) {
      findings.push({
        code: "GERBER_PROFILE_MISMATCH",
        path: profilePath,
        message: "Board profile contains unexpected flashed geometry",
      });
    }
  }

  for (const drill of [
    {
      path: `drills/drill-L1-L${expectation.layerCount}.drl`,
      fileFunction: `Plated,1,${expectation.layerCount},PTH`,
      hits: expectation.platedDrills,
    },
    {
      path: "drills/drill_npth.drl",
      fileFunction: `NonPlated,1,${expectation.layerCount},NPTH`,
      hits: expectation.nonPlatedDrills,
    },
  ]) {
    if (drill.hits.length === 0 || !actualPaths.includes(drill.path)) continue;
    try {
      const content = capturedText(drill.path);
      assertTextLineLimit(content, drill.path);
      const drillLines = nonBlankLines(content);
      const drillCommands = drillLines.map(normalizedDrillCommand);
      const declaredFunctions = fileFunctions(content);
      if (declaredFunctions.length !== 1 || declaredFunctions[0] !== drill.fileFunction) {
        findings.push({
          code: "DRILL_FILE_FUNCTION_MISMATCH",
          path: drill.path,
          message: `${drill.path} does not declare ${drill.fileFunction}`,
        });
      }
      if (
        drillCommands.at(-1) !== "M30" ||
        (content.match(/M30/g) ?? []).length !== 1
      ) {
        findings.push({ code: "DRILL_PARSE_ERROR", path: drill.path, message: "Drill file must have exactly one final end marker" });
      }
      const parsed = await parseArtifact(content, "drill", parserBudget);
      if (hasInvalidDrillToolDefinition(parsed.records)) {
        findings.push({
          code: "DRILL_STATE_UNSUPPORTED",
          path: drill.path,
          message: `${drill.path} declares a drill tool without exactly one finite, strictly positive circular diameter`,
        });
      }
      if (hasUnresolvedToolOperation(parsed.records)) {
        findings.push({
          code: "DRILL_STATE_UNSUPPORTED",
          path: drill.path,
          message: `${drill.path} selects or drills with an undefined tool`,
        });
      }
      const headerDelimiterIndex = drillLines.indexOf("%");
      const strictHeaderGrammar = headerDelimiterIndex > 0 && drillLines
        .slice(0, headerDelimiterIndex + 1)
        .every((line, index) =>
          (index === 0 && line === "M48") ||
          line === "; FORMAT={-:-/ absolute / metric / decimal}" ||
          line === "; #@! TF.GenerationSoftware,tscircuit" ||
          line.startsWith("; #@! TF.FileFunction,") ||
          line === "FMAT,2" || line === "METRIC" ||
          line.startsWith("; #@! TA.AperFunction,") ||
          /^T\d+C\d+(?:\.\d+)?$/.test(line) || line === "%"
        );
      const strictBodyGrammar = headerDelimiterIndex >= 0 && drillLines
        .slice(headerDelimiterIndex + 1)
        .every((line, index) =>
          (index === 0 && line === "G90") ||
          (index === 1 && line === "G05") ||
          /^T\d+$/.test(line) ||
          /^X-?\d+(?:\.\d+)?Y-?\d+(?:\.\d+)?$/.test(line) ||
          /^G85X-?\d+(?:\.\d+)?Y-?\d+(?:\.\d+)?$/.test(line) ||
          line === "M30"
        );
      if (
        wholeLineCount(content, "METRIC") !== 1 ||
        wholeLineCount(content, "G90") !== 1 ||
        drillLines[0] !== "M48" ||
        drillLines[1] !== "; FORMAT={-:-/ absolute / metric / decimal}" ||
        drillLines[2] !== "; #@! TF.GenerationSoftware,tscircuit" ||
        drillLines[3]?.startsWith("; #@! TF.FileFunction,") !== true ||
        drillLines[4] !== "FMAT,2" || drillLines[5] !== "METRIC" ||
        drillLines.some((line) => line !== line.trim() || /^N\d+/i.test(line)) ||
        drillCommands.some((line) => /^(?:G91|M7[12]|INCH)$/i.test(line)) ||
        Array.from(content.matchAll(/M\d+/gi), (match) => match[0].toUpperCase())
          .some((command) => command !== "M48" && command !== "M30") ||
        Array.from(content.matchAll(/G\d+/gi), (match) => match[0].toUpperCase())
          .some((command) => command !== "G90" && command !== "G05" && command !== "G85") ||
        drillCommands.some((line) => /^ICI(?:,|$)/i.test(line)) ||
        !strictHeaderGrammar || !strictBodyGrammar ||
        parsed.records.some((record) =>
          record.type === "set" &&
          (
            record.prop === "backupNota" || record.prop === "backupUnits" ||
            (record.prop === "nota" && record.value !== "A") ||
            (record.prop === "units" && record.value !== "mm")
          )
        )
      ) {
        findings.push({
          code: "DRILL_STATE_UNSUPPORTED",
          path: drill.path,
          message: `${drill.path} must use exactly the canonical absolute metric drill dialect`,
        });
      }
      const expectedToolFunction = drill.path.endsWith("drill_npth.drl")
        ? "NonPlated,NPTH,ComponentDrill"
        : "Plated,PTH,ComponentDrill";
      const declaredToolFunctions = Array.from(
        content.matchAll(/^; #@! TA\.AperFunction,([^\r\n]+)$/gm),
        (match) => match[1]!,
      );
      const toolCount = parsed.records.filter((record) => record.type === "tool").length;
      const parsedToolCodes = parsed.records.flatMap((record) =>
        record.type === "tool" && record.code !== undefined ? [record.code] : []
      );
      const headerEnds = drillLines.flatMap((line, index) => line === "%" ? [index] : []);
      const toolDefinitionIndexes = drillLines.flatMap((line, index) =>
        /^T\d+C\d/i.test(line) ? [index] : []
      );
      const toolAttributeIndexes = drillLines.flatMap((line, index) =>
        line.startsWith("; #@! TA.AperFunction,") ? [index] : []
      );
      const fileAttributeIndexes = drillLines.flatMap((line, index) =>
        line.startsWith("; #@! TF.") ? [index] : []
      );
      const attributeOrderValid = headerEnds.length === 1 &&
        drillLines[0] === "M48" &&
        drillLines.filter((line) => line === "M48").length === 1 &&
        drillLines[1] === "; FORMAT={-:-/ absolute / metric / decimal}" &&
        drillLines[2] === "; #@! TF.GenerationSoftware,tscircuit" &&
        drillLines[3]?.startsWith("; #@! TF.FileFunction,") === true &&
        drillLines[4] === "FMAT,2" && drillLines[5] === "METRIC" &&
        toolAttributeIndexes.every((index) => index >= 6) &&
        drillLines[headerEnds[0]! + 1] === "G90" &&
        drillLines[headerEnds[0]! + 2] === "G05" &&
        fileAttributeIndexes.length > 0 &&
        fileAttributeIndexes.every((index) => index > 0 && index < headerEnds[0]!) &&
        new Set(parsedToolCodes).size === parsedToolCodes.length &&
        toolDefinitionIndexes.length === toolAttributeIndexes.length &&
        toolAttributeIndexes.every(
          (index) => index < headerEnds[0]! && toolDefinitionIndexes.includes(index + 1),
        ) &&
        toolDefinitionIndexes.every((index) => toolAttributeIndexes.includes(index - 1));
      if (
        declaredToolFunctions.length !== toolCount ||
        declaredToolFunctions.some((value) => value !== expectedToolFunction) ||
        !attributeOrderValid
      ) {
        findings.push({
          code: "DRILL_FILE_FUNCTION_MISMATCH",
          path: drill.path,
          message: `${drill.path} has missing or contradictory per-tool plating attributes`,
        });
      }
      const containsUnsupportedRouting = parsed.records.some(
        (record) => record.type === "op" && record.op !== "flash",
      );
      if (
        containsUnsupportedRouting ||
        !sameHits(parsedDrillHits(parsed.records, content), drill.hits)
      ) {
        findings.push({
          code: "DRILL_HIT_MISMATCH",
          path: drill.path,
          message: "Parsed drill coordinates, diameters, or hit count do not match the authored board",
        });
      }
    } catch (error) {
      findings.push({
        code: error instanceof ManufacturingInputLimitError
          ? "MANUFACTURING_INPUT_LIMIT"
          : "DRILL_PARSE_ERROR",
        path: drill.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (actualPaths.includes("assembly/bom.csv")) {
    try {
      const content = capturedText("assembly/bom.csv");
      const rows = parseCsv(content);
      const header = rows[0] ?? [];
      const headerMatches = expectation.bomRows.length === 0
        ? content === ""
        : header.length === expectation.bomHeaders.length &&
          header.every((value, index) => value === expectation.bomHeaders[index]);
      const actualRows = rows.slice(1);
      const expectedRows = expectation.bomRows.map((expected) =>
        header.map((column) => expected.columns[column] ?? "")
      );
      const rowsMatch = actualRows.every((actual) => actual.length === header.length) &&
        sameCountedRows(actualRows, expectedRows);
      if (!headerMatches || !rowsMatch) {
        findings.push({ code: "BOM_MISMATCH", path: "assembly/bom.csv", message: "BOM quantity, values, footprints, manufacturer, supplier, or designators do not match the authored assembly" });
      }
    } catch (error) {
      findings.push({
        code: error instanceof ManufacturingInputLimitError
          ? "MANUFACTURING_INPUT_LIMIT"
          : "BOM_MISMATCH",
        path: "assembly/bom.csv",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (actualPaths.includes("assembly/positions.csv")) {
    try {
      const content = capturedText("assembly/positions.csv");
      const rows = parseCsv(content);
      const actual = rows.slice(1);
      const placementHeader = ["Designator", "Mid X", "Mid Y", "Layer", "Rotation"];
      const matched = expectation.placements.length === 0
        ? content === ""
        : rows[0]?.length === placementHeader.length &&
          rows[0]!.every((value, index) => value === placementHeader[index]) &&
          actual.every((row) => row.length === 5) &&
          samePlacementMultiset(actual, expectation.placements);
      if (!matched) {
        findings.push({ code: "PLACEMENT_MISMATCH", path: "assembly/positions.csv", message: "Placement coordinates, side, rotation, or designators do not match authored components" });
      }
    } catch (error) {
      findings.push({
        code: error instanceof ManufacturingInputLimitError
          ? "MANUFACTURING_INPUT_LIMIT"
          : "PLACEMENT_MISMATCH",
        path: "assembly/positions.csv",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (actualPaths.includes("fabrication/metadata.json")) {
    try {
      const metadataText = capturedText("fabrication/metadata.json");
      assertTextLineLimit(metadataText, "fabrication/metadata.json");
      const actual = JSON.parse(metadataText) as unknown;
      assertNoDuplicateJsonObjectKeys(metadataText);
      const expectedMetadata = {
        schemaVersion: 1,
        boardName: expectation.boardName,
        units: "mm",
        board: {
          center: {
            x: expectation.board.centerX,
            y: expectation.board.centerY,
          },
          width: expectation.board.width,
          height: expectation.board.height,
          thickness: expectation.board.thickness,
          material: expectation.board.material,
        },
        layerStack: expectation.layerCount === 4
          ? ["top", "inner1", "inner2", "bottom"]
          : ["top", "bottom"],
        coordinates: {
          origin: "pcb-board-center",
          xAxis: "right",
          yAxis: "up",
        },
        placement: {
          units: "mm",
          coordinates: "absolute-board",
          rotation: "counterclockwise-degrees",
          bottomSide: "as-authored-not-mirrored",
        },
      };
      if (JSON.stringify(actual) !== JSON.stringify(expectedMetadata)) {
        findings.push({
          code: "FABRICATION_METADATA_MISMATCH",
          path: "fabrication/metadata.json",
          message: "Layer stack, board dimensions, units, origin, or placement convention does not match authored evidence",
        });
      }
    } catch (error) {
      findings.push({
        code: error instanceof ManufacturingInputLimitError
          ? "MANUFACTURING_INPUT_LIMIT"
          : "FABRICATION_METADATA_MISMATCH",
        path: "fabrication/metadata.json",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await options.beforeFinalArtifactSnapshot?.();
  let finalPaths: string[] = [];
  try {
    finalPaths = await listFiles(options.root);
  } catch (error) {
    if (error instanceof ManufacturingInputLimitError) {
      findings.push({ code: "MANUFACTURING_INPUT_LIMIT", message: error.message });
    }
    // The initial directory read already has a specific finding when absent;
    // membership mismatch below closes changes during verification.
  }
  const finalArtifacts = (await captureArtifactSnapshot(options.root, [...expected])).artifacts;
  if (JSON.stringify(finalPaths) !== JSON.stringify(actualPaths)) {
    findings.push({
      code: "MANUFACTURING_ARTIFACT_CHANGED",
      message: "Manufacturing artifact directory membership changed during independent verification",
    });
  }
  if (JSON.stringify(finalArtifacts) !== JSON.stringify(initialArtifacts)) {
    findings.push({
      code: "MANUFACTURING_ARTIFACT_CHANGED",
      message: "Manufacturing artifact bytes changed during independent verification",
    });
  }
  if (initialArtifacts.length !== expected.size) {
    // Missing/unsafe entries have specific findings above. Keep the set
    // completeness invariant explicit so no future finding regression can
    // accidentally turn a partial identity set into a pass.
    findings.push({
      code: "MANUFACTURING_ARTIFACT_CHANGED",
      message: "The independently verified artifact identity set is incomplete",
    });
  }

  const result: Readonly<ManufacturingVerification> = Object.freeze({
    passed: findings.length === 0,
    parser: "gerber-parser@4.2.7" as const,
    expectation: Object.freeze({
      boardName: expectation.boardName,
      sha256: expectationSha256,
    }),
    findings: Object.freeze(findings.map((finding) => Object.freeze({ ...finding }))),
    artifacts: initialArtifacts,
  });
  markVerifierIssuedResult(result);
  return result;
}
