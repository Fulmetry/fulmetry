// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

export const REPOSITORY_TEST_JUNIT_BYTES_LIMIT = 4 * 1024 * 1024;

const MACOS_INTENTIONAL_SKIPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["test/contained-process.test.ts", new Set([
    "a missing Windows target reports typed containment unavailability",
  ])],
  ["test/accept-tscircuit-upgrade.test.ts", new Set([
    "rejects a self-consistent but stale reviewed report after fresh requalification",
    "rejects a runtime-compatible candidate whose public type surface breaks Fulmetry",
    "rolls back every accepted authority when publication fails part-way",
  ])],
  ["test/review-tscircuit-upgrade.test.ts", new Set([
    "rejects one installation masquerading as both runtime profiles",
    "reviews the installed candidate offline with zero semantic/manufacturing deltas and no other repo mutation",
    "reports candidate version, integrity, and content changes separately from unchanged board artifacts",
    "does not publish when the candidate is missing required authoring exports",
    "does not publish when fulmetry and direct imports resolve duplicate physical engines",
    "does not publish if staged regular inputs mutate after authentication",
  ])],
]);

export interface RepositoryTestCase {
  readonly name: string;
  readonly className: string;
  readonly file: string;
  readonly skipped: boolean;
  readonly failed: boolean;
}

export interface RepositoryTestReport {
  readonly total: number;
  readonly failures: number;
  readonly skipped: number;
  readonly assertions: number;
  readonly cases: readonly RepositoryTestCase[];
}

function integerAttribute(attributes: string, name: string): number {
  const match = new RegExp(`(?:^|\\s)${name}="(\\d+)"(?:\\s|$)`, "u").exec(attributes);
  if (match === null) throw new Error(`REPOSITORY_TEST_JUNIT_INVALID: missing ${name}`);
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error(`REPOSITORY_TEST_JUNIT_INVALID: ${name}`);
  return value;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stringAttribute(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"(?:\\s|$)`, "u").exec(attributes);
  if (match === null) throw new Error(`REPOSITORY_TEST_JUNIT_INVALID: testcase missing ${name}`);
  return decodeXmlAttribute(match[1]!);
}

export function parseRepositoryTestJunit(bytes: Uint8Array): RepositoryTestReport {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const root = /<testsuites\s+([^>]*)>/u.exec(text);
  if (root === null) throw new Error("REPOSITORY_TEST_JUNIT_INVALID: no testsuites root");
  const attributes = root[1]!;
  const total = integerAttribute(attributes, "tests");
  const failures = integerAttribute(attributes, "failures");
  const skipped = integerAttribute(attributes, "skipped");
  const assertions = integerAttribute(attributes, "assertions");
  if (failures > total || skipped > total || failures + skipped > total) {
    throw new Error("REPOSITORY_TEST_JUNIT_INVALID: contradictory counts");
  }
  const cases: RepositoryTestCase[] = [];
  for (const match of text.matchAll(/<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const body = match[2] ?? "";
    cases.push(Object.freeze({
      name: stringAttribute(match[1]!, "name"),
      className: stringAttribute(match[1]!, "classname"),
      file: stringAttribute(match[1]!, "file").replaceAll("\\", "/").replace(/^\.\//u, ""),
      skipped: /<skipped(?:\s[^>]*)?\s*\/>/u.test(body),
      failed: /<(?:failure|error)(?:\s[^>]*)?>/u.test(body),
    }));
  }
  if (cases.length !== total) {
    throw new Error(`REPOSITORY_TEST_JUNIT_INVALID: ${cases.length} cases for total ${total}`);
  }
  if (cases.filter(({ skipped: value }) => value).length !== skipped) {
    throw new Error("REPOSITORY_TEST_JUNIT_INVALID: skipped case mismatch");
  }
  if (cases.filter(({ failed }) => failed).length !== failures) {
    throw new Error("REPOSITORY_TEST_JUNIT_INVALID: failure case mismatch");
  }
  return Object.freeze({ total, failures, skipped, assertions, cases: Object.freeze(cases) });
}

export function requirePassingRepositoryTestReport(
  report: RepositoryTestReport,
  selectedFiles: readonly string[],
): void {
  if (report.total === 0 || report.failures !== 0) {
    throw new Error("REPOSITORY_TEST_RESULT_INVALID: zero tests or failures");
  }
  const normalized = selectedFiles.map((path) => path.replaceAll("\\", "/").replace(/^\.\//u, ""));
  const allowedSkips = new Set<string>();
  if (process.platform === "darwin" && process.arch === "arm64") {
    for (const file of normalized) {
      for (const name of MACOS_INTENTIONAL_SKIPS.get(file) ?? []) allowedSkips.add(`${file}\0${name}`);
    }
  }
  const observedSkips = new Set(report.cases
    .filter(({ skipped }) => skipped)
    .map(({ file, name }) => `${file}\0${name}`));
  if (
    report.skipped !== observedSkips.size ||
    observedSkips.size !== allowedSkips.size ||
    [...observedSkips].some((identity) => !allowedSkips.has(identity))
  ) {
    throw new Error("REPOSITORY_TEST_UNEXPECTED_SKIP: exact supported-platform allowlist mismatch");
  }
  for (const file of normalized) {
    if (!report.cases.some((entry) => entry.file === file && !entry.skipped && !entry.failed)) {
      throw new Error(`REPOSITORY_TEST_FILE_UNEXECUTED: ${file}`);
    }
  }
}
