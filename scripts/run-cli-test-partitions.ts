#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  REPOSITORY_TEST_JUNIT_BYTES_LIMIT,
  parseRepositoryTestJunit,
} from "./repository-test-contract";

export const CLI_TESTS_PER_PARTITION_LIMIT = 1;
export const CLI_PARTITION_TIMEOUT_MS = 150_000;
export const CLI_OVERALL_TIMEOUT_MS = 45 * 60_000;
const CLI_TEST_PATH = join(import.meta.dir, "..", "test", "cli.test.ts");
const CLI_TEST_EVIDENCE_PATH = "test/cli.test.ts";
const CLI_SUITE_NAME = "Fulmetry CLI";
const policyPreload = join(import.meta.dir, "repository-test-policy-preload.ts");

async function readStableJunit(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > REPOSITORY_TEST_JUNIT_BYTES_LIMIT) {
      throw new Error("CLI partition JUnit is missing, special, or oversized");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size
    ) throw new Error("CLI partition JUnit changed while captured");
    return bytes;
  } finally {
    await handle.close();
  }
}

function callTitle(node: ts.CallExpression): string {
  const title = node.arguments[0];
  if (title === undefined || (!ts.isStringLiteral(title) && !ts.isNoSubstitutionTemplateLiteral(title))) {
    throw new Error("CLI test titles must be static string literals");
  }
  return title.text;
}

/** Syntax-aware inventory. Unsupported declarations fail instead of disappearing from the gate. */
export function extractCliTestTitles(source: string): readonly string[] {
  const file = ts.createSourceFile("test/cli.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const titles: string[] = [];
  const acceptedTestIdentifiers = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "bun:test"
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      throw new Error("CLI test inventory forbids namespace-imported test APIs");
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        if (importedName === "it" || (importedName === "test" && specifier.name.text !== "test")) {
          throw new Error("CLI test inventory forbids aliased or alternate test APIs");
        }
        if (importedName === "test") {
          acceptedTestIdentifiers.add(specifier.name.text);
        }
      }
    }
  }
  if (acceptedTestIdentifiers.size !== 1 || !acceptedTestIdentifiers.has("test")) {
    throw new Error("CLI test inventory requires one direct named test import from bun:test");
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "test") {
        titles.push(callTitle(node));
        for (const argument of node.arguments.slice(1)) visit(argument);
        return;
      } else if (
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        ts.isIdentifier(node.expression.expression.expression) &&
        node.expression.expression.expression.text === "test"
      ) {
        const modifier = node.expression.expression.name.text;
        if (modifier !== "skipIf") throw new Error(`CLI test modifier is forbidden: ${modifier}`);
        if (node.expression.arguments.length !== 1) throw new Error("CLI test skipIf requires one condition");
        titles.push(callTitle(node));
        for (const argument of node.arguments.slice(1)) visit(argument);
        return;
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "test"
      ) {
        throw new Error(`CLI test modifier is forbidden: ${node.expression.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (titles.length === 0) throw new Error("CLI partition inventory found no tests");
  if (new Set(titles).size !== titles.length) throw new Error("CLI test titles must be unique");
  return Object.freeze(titles);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function cliTestPartitions(titles: readonly string[]): readonly (readonly string[])[] {
  if (titles.length === 0) throw new Error("CLI test inventory is empty");
  const partitionCount = Math.ceil(titles.length / CLI_TESTS_PER_PARTITION_LIMIT);
  const partitions = Array.from({ length: partitionCount }, () => [] as string[]);
  titles.forEach((title, index) => partitions[index % partitionCount]!.push(title));
  if (partitions.some((partition) => partition.length === 0)) throw new Error("CLI test partition is empty");
  if (partitions.some((partition) => partition.length > CLI_TESTS_PER_PARTITION_LIMIT)) {
    throw new Error("CLI test partition exceeds the per-process limit");
  }
  return Object.freeze(partitions.map((partition) => Object.freeze(partition)));
}

export function cliTestPartitionPattern(titles: readonly string[]): string {
  if (titles.length === 0) throw new Error("CLI test partition is empty");
  return `^${escapeRegularExpression(CLI_SUITE_NAME)} (?:${titles.map(escapeRegularExpression).join("|")})$`;
}

function terminate(child: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group may already be empty. */ }
  }
  try { child.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
}

async function runCliPartition(
  selected: readonly string[],
  inventory: readonly string[],
  index: number,
  remainingOverallMilliseconds: number,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "fulmetry-cli-partition-"));
  const junitPath = join(directory, "junit.xml");
  const child = Bun.spawn([
    process.execPath,
    ...(process.platform === "win32" ? [] : ["--no-orphans"]),
    "test",
    "--max-concurrency=1",
    "--timeout=120000",
    "--preload",
    policyPreload,
    "--test-name-pattern",
    cliTestPartitionPattern(selected),
    "--reporter=junit",
    `--reporter-outfile=${junitPath}`,
    CLI_TEST_PATH,
  ], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, FULMETRY_REPOSITORY_TEST_POLICY_REQUIRED: "1" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const effectiveTimeout = Math.min(CLI_PARTITION_TIMEOUT_MS, remainingOverallMilliseconds);
  if (effectiveTimeout <= 0) throw new Error(`CLI integration exceeded ${CLI_OVERALL_TIMEOUT_MS} ms`);
  const stop = () => terminate(child);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = setTimeout(() => { timedOut = true; terminate(child); }, effectiveTimeout);
  try {
    const exitCode = await child.exited;
    if (timedOut) throw new Error(`CLI partition ${index} exceeded its ${effectiveTimeout} ms deadline`);
    if (exitCode !== 0) throw new Error(`CLI test partition ${index} failed with exit ${exitCode}`);
    const report = parseRepositoryTestJunit(await readStableJunit(junitPath));
    if (report.total !== inventory.length || report.failures !== 0) {
      throw new Error(`CLI partition ${index} reported an invalid inventory or failure count`);
    }
    const executed = report.cases.filter(({ skipped }) => !skipped);
    if (
      executed.length !== selected.length ||
      executed.some(({ className, file, failed }) =>
        className !== CLI_SUITE_NAME || file !== CLI_TEST_EVIDENCE_PATH || failed
      ) ||
      executed.map(({ name }) => name).sort().join("\0") !== [...selected].sort().join("\0")
    ) {
      throw new Error(`CLI partition ${index} did not execute exactly its selected tests`);
    }
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    terminate(child);
    await child.exited.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runCliTestPartitions(): Promise<void> {
  const titles = extractCliTestTitles(await readFile(CLI_TEST_PATH, "utf8"));
  const partitions = cliTestPartitions(titles);
  const startedAt = performance.now();
  for (let index = 0; index < partitions.length; index += 1) {
    const remaining = Math.floor(CLI_OVERALL_TIMEOUT_MS - (performance.now() - startedAt));
    if (remaining <= 0) throw new Error(`CLI integration exceeded ${CLI_OVERALL_TIMEOUT_MS} ms`);
    const selected = partitions[index]!;
    process.stdout.write(`CLI partition ${index + 1}/${partitions.length}: ${selected.join(", ")}\n`);
    await runCliPartition(selected, titles, index + 1, remaining);
  }
}

if (import.meta.main) {
  try {
    await runCliTestPartitions();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
