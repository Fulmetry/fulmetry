// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  ProcessContainmentOrphanedError,
  ProcessContainmentUnavailableError,
  spawnContainedProcess,
  type ContainedProcess,
} from "./internal/contained-process";
import { PROJECT_INPUT_DEPTH_LIMIT, PROJECT_INPUT_ENTRY_LIMIT } from "./project/input-limits";
import { requireSupportedBunRuntime } from "./runtime";

export const PROJECT_TEST_TIMEOUT_MS = 120_000;
export const PROJECT_TEST_OUTPUT_LIMIT = 1024 * 1024;
export const PROJECT_TEST_JUNIT_LIMIT = 4 * 1024 * 1024;
export const PROJECT_TEST_FILE_LIMIT = 1_000;
export const PROJECT_TEST_SOURCE_LIMIT = 10_000;
export const PROJECT_TEST_INPUT_FILE_LIMIT = 8 * 1024 * 1024;
export const PROJECT_TEST_INPUT_TOTAL_LIMIT = 64 * 1024 * 1024;

const TEST_FILE_PATTERN = /\.test\.tsx?$/u;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
const SUBPROCESS_MODULES = new Set([
  "bun",
  "bun:ffi",
  "child_process",
  "node:child_process",
  "cluster",
  "node:cluster",
]);
const runtimePcbooRoot = realpath(join(import.meta.dir, ".."));

async function owningPackageRoot(path: string, packageName: string): Promise<string> {
  let directory = dirname(path);
  while (true) {
    try {
      const metadata = JSON.parse(await Bun.file(join(directory, "package.json")).text()) as {
        name?: unknown;
      };
      if (metadata.name === packageName) return await realpath(directory);
    } catch {
      // Continue to the owning package boundary.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot find package root for ${packageName}`);
    directory = parent;
  }
}
const PROJECT_TEST_POLICY_GUARD_SOURCE = `
import { describe, test } from "bun:test";
const seen = new WeakSet();
const fixed = (target, key, value) => Object.defineProperty(target, key, {
  value, configurable: false, enumerable: false, writable: false,
});
const get = (target, key) => { try { return target[key]; } catch { return undefined; } };
const rejectFocused = () => { throw new Error("PCBOO_FOCUSED_TEST_FORBIDDEN"); };
const rejectFailing = () => { throw new Error("PCBOO_EXPECTED_FAILURE_TEST_FORBIDDEN"); };
const guard = (api, depth = 0) => {
  if (typeof api !== "function" || seen.has(api)) return api;
  seen.add(api);
  fixed(api, "only", rejectFocused);
  if (typeof get(api, "failing") === "function") fixed(api, "failing", rejectFailing);
  if (typeof get(api, "failingIf") === "function") {
    const original = get(api, "failingIf");
    fixed(api, "failingIf", (condition) => {
      if (condition) return rejectFailing();
      return guard(Reflect.apply(original, api, [condition]), depth + 1);
    });
  }
  for (const key of ["if", "skipIf", "todoIf", "concurrentIf", "serialIf", "each"]) {
    if (typeof get(api, key) !== "function") continue;
    const original = get(api, key);
    fixed(api, key, (...args) => guard(Reflect.apply(original, api, args), depth + 1));
  }
  if (depth < 3) {
    for (const key of ["skip", "todo", "concurrent", "serial"]) {
      if (typeof get(api, key) !== "function") continue;
      const variant = guard(get(api, key), depth + 1);
      fixed(api, key, variant);
    }
  }
  return api;
};
guard(test);
guard(describe);
`;

interface TestInputFileIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface ProjectTestInputAuthority {
  readonly testFiles: readonly string[];
  readonly sourceFiles: readonly TestInputFileIdentity[];
  readonly focusedDeclarations: readonly string[];
  readonly subprocessDeclarations: readonly string[];
}

export interface ProjectTestCounts {
  readonly total: number;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly assertions: number;
}

export type ProjectTestOutcome =
  | "passed"
  | "failed"
  | "incomplete"
  | "cancelled";

export type ProjectTestReason =
  | "passed"
  | "no-test-files"
  | "no-test-cases"
  | "skipped-tests"
  | "focused-tests"
  | "expected-failing-tests"
  | "subprocess-forbidden"
  | "offline-containment-unavailable"
  | "process-containment-unavailable"
  | "process-containment-violation"
  | "test-failures"
  | "runner-exit"
  | "runner-output-invalid"
  | "timeout"
  | "output-limit"
  | "cancelled"
  | "start-failed";

export interface ProjectTestExecution {
  readonly schemaVersion: 1;
  readonly outcome: ProjectTestOutcome;
  readonly reason: ProjectTestReason;
  readonly testFiles: readonly string[];
  readonly counts: Readonly<ProjectTestCounts> | null;
  readonly execution: Readonly<{
    exitCode: number | null;
    timeoutMs: number;
    outputLimitBytes: number;
    timedOut: boolean;
    cancelled: boolean;
    stdoutExceeded: boolean;
    stderrExceeded: boolean;
    junitExceeded: boolean;
    focusSentinelsExpected: number;
    focusSentinelsObserved: number;
  }>;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly junit: Uint8Array | null;
  readonly inputAuthority: Readonly<ProjectTestInputAuthority>;
}

export function classifyProjectTestContainmentError(error: unknown): Readonly<{
  outcome: "failed" | "incomplete";
  reason: "process-containment-unavailable" | "process-containment-violation";
}> | null {
  if (error instanceof ProcessContainmentUnavailableError) {
    return Object.freeze({ outcome: "incomplete", reason: "process-containment-unavailable" });
  }
  if (error instanceof ProcessContainmentOrphanedError) {
    return Object.freeze({ outcome: "failed", reason: "process-containment-violation" });
  }
  return null;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function normalizedRelative(root: string, target: string): string {
  const path = relative(root, target).replaceAll("\\", "/");
  if (path === "" || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error("Project test path escapes the project root");
  }
  return path;
}

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  switch (extname(path)) {
    case ".ts": return "ts";
    case ".tsx": return "tsx";
    case ".jsx": return "jsx";
    default: return "js";
  }
}

function inspectTestSource(source: string, path: string): Readonly<{
  focusedDeclarations: readonly string[];
  subprocessDeclarations: readonly string[];
}> {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const testApiNames = new Set(["test", "it", "describe"]);
  const testApiIdentifiers = new Set(testApiNames);
  const testApiNamespaces = new Set<string>();
  const createRequireIdentifiers = new Set<string>();
  const moduleNamespaces = new Set<string>();
  const subprocessImportLocations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = literalTextValue(statement.moduleSpecifier);
    if (moduleName !== undefined && SUBPROCESS_MODULES.has(moduleName)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        statement.moduleSpecifier.getStart(sourceFile),
      );
      subprocessImportLocations.push(`${path}:${line + 1}:${character + 1}`);
    }
    const bindings = statement.importClause?.namedBindings;
    if (moduleName === "node:module" || moduleName === "module") {
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        moduleNamespaces.add(bindings.name.text);
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if ((specifier.propertyName?.text ?? specifier.name.text) === "createRequire") {
            createRequireIdentifiers.add(specifier.name.text);
          }
        }
      }
    }
    if (moduleName !== "bun:test") continue;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) testApiNamespaces.add(bindings.name.text);
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        if (testApiNames.has(importedName)) testApiIdentifiers.add(specifier.name.text);
      }
    }
  }
  const stringConstants = new Map<string, string>();
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
    ) current = current.expression;
    return current;
  };
  const constantText = (expression: ts.Expression | undefined): string | undefined => {
    if (expression === undefined) return undefined;
    const current = unwrap(expression);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
    if (ts.isIdentifier(current)) return stringConstants.get(current.text);
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantText(current.left); const right = constantText(current.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const collectConstants = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const value = constantText(node.initializer);
        if (value !== undefined) stringConstants.set(node.name.text, value);
      }
      ts.forEachChild(node, collectConstants);
    };
    collectConstants(sourceFile);
  }
  const isTestApi = (expression: ts.Expression): boolean => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) return testApiIdentifiers.has(current.text);
    return ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression) &&
      testApiNamespaces.has(current.expression.text) && testApiNames.has(current.name.text);
  };
  const isBunObject = (expression: ts.Expression): boolean => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) return current.text === "Bun";
    if (
      ts.isPropertyAccessExpression(current) && current.name.text === "Bun" &&
      ts.isIdentifier(current.expression) && current.expression.text === "globalThis"
    ) return true;
    return ts.isElementAccessExpression(current) &&
      ts.isIdentifier(current.expression) && current.expression.text === "globalThis" &&
      constantText(current.argumentExpression) === "Bun";
  };
  const focused: string[] = [];
  const subprocess: string[] = [...subprocessImportLocations];
  const recordFocus = (node: ts.Node): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    focused.push(`${path}:${line + 1}:${character + 1}`);
  };
  const recordSubprocess = (node: ts.Node): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    subprocess.push(`${path}:${line + 1}:${character + 1}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const importMetaRequire = ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "require" &&
        ts.isMetaProperty(node.expression.expression) &&
        node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
      const createRequireCall =
        (ts.isIdentifier(node.expression) && createRequireIdentifiers.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "createRequire" &&
          ts.isIdentifier(node.expression.expression) &&
          moduleNamespaces.has(node.expression.expression.text));
      if (importMetaRequire || createRequireCall) {
        throw new Error(
          `Project test evidence forbids runtime module loaders in ${path}; use a static contained import`,
        );
      }
      if (dynamicImport || requireCall) {
        const argument = node.arguments[0];
        if (
          argument === undefined ||
          (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          throw new Error(
            `Project test evidence forbids computed ${dynamicImport ? "dynamic import" : "require"} in ${path}`,
          );
        }
        if (SUBPROCESS_MODULES.has(constantText(argument) ?? "")) recordSubprocess(node);
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "process" &&
        node.expression.name.text === "getBuiltinModule" &&
        SUBPROCESS_MODULES.has(constantText(node.arguments[0]) ?? "")
      ) recordSubprocess(node.expression);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ["spawn", "spawnSync", "$"].includes(node.name.text) &&
      isBunObject(node.expression)
    ) recordSubprocess(node);
    if (
      ts.isElementAccessExpression(node) &&
      ["spawn", "spawnSync", "$"].includes(constantText(node.argumentExpression) ?? "") &&
      isBunObject(node.expression)
    ) recordSubprocess(node);
    if (
      ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined && isBunObject(node.initializer) &&
      node.name.elements.some((element) =>
        ["spawn", "spawnSync", "$"].includes(
          element.propertyName === undefined && ts.isIdentifier(element.name)
            ? element.name.text
            : element.propertyName === undefined
              ? ""
              : propertyNameText(element.propertyName) ?? "",
        )
      )
    ) recordSubprocess(node.name);
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ((ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Reflect" && node.expression.name.text === "get") ||
        (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && node.expression.name.text === "getOwnPropertyDescriptor")) &&
      node.arguments[0] !== undefined && isBunObject(node.arguments[0]) &&
      ["spawn", "spawnSync", "$"].includes(constantText(node.arguments[1]) ?? "")
    ) recordSubprocess(node.expression);
    if (
      ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "Command" &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Deno"
    ) recordSubprocess(node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "only") recordFocus(node.name);
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      constantText(node.argumentExpression) === "only" &&
      isTestApi(node.expression)
    ) recordFocus(node.argumentExpression);
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ((ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Reflect" && node.expression.name.text === "get") ||
        (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && node.expression.name.text === "getOwnPropertyDescriptor")) &&
      node.arguments[0] !== undefined && isTestApi(node.arguments[0]) &&
      constantText(node.arguments[1]) === "only"
    ) recordFocus(node.expression);
    if (
      ts.isBindingElement(node) &&
      ((node.propertyName !== undefined && propertyNameText(node.propertyName) === "only") ||
        (node.propertyName === undefined && ts.isIdentifier(node.name) && node.name.text === "only"))
    ) recordFocus(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze({
    focusedDeclarations: Object.freeze(focused),
    subprocessDeclarations: Object.freeze(subprocess),
  });
}

function propertyNameText(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

function literalTextValue(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

async function discoverTestFiles(
  projectRoot: string,
  outputDirectory: string,
): Promise<readonly string[]> {
  const root = await realpath(projectRoot);
  const outputPrefix = outputDirectory.replaceAll("\\", "/").replace(/\/$/u, "");
  const found: string[] = [];
  let entryCount = 0;
  const visit = async (directory: string, depth = 0): Promise<void> => {
    if (depth > PROJECT_INPUT_DEPTH_LIMIT) {
      throw new Error(`Project test traversal exceeds ${PROJECT_INPUT_DEPTH_LIMIT} directories`);
    }
    for await (const entry of await opendir(directory)) {
      const absolutePath = join(directory, entry.name);
      const projectPath = normalizedRelative(root, absolutePath);
      if (
        entry.name === ".git" || entry.name === "node_modules" ||
        projectPath === outputPrefix || projectPath.startsWith(`${outputPrefix}/`)
      ) continue;
      entryCount += 1;
      if (entryCount > PROJECT_INPUT_ENTRY_LIMIT) {
        throw new Error(`Project test traversal exceeds ${PROJECT_INPUT_ENTRY_LIMIT} entries`);
      }
      if (entry.isSymbolicLink()) {
        if (TEST_FILE_PATTERN.test(entry.name)) {
          throw new Error(`Project test file must not be a symlink: ${projectPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        found.push(projectPath);
        if (found.length > PROJECT_TEST_FILE_LIMIT) {
          throw new Error(`Project contains more than ${PROJECT_TEST_FILE_LIMIT} test files`);
        }
      }
    }
  };
  await visit(root);
  return Object.freeze(found.sort());
}

async function discoverProjectInputFiles(
  projectRoot: string,
  outputDirectory: string,
): Promise<readonly string[]> {
  const root = await realpath(projectRoot);
  const outputPrefix = outputDirectory.replaceAll("\\", "/").replace(/\/$/u, "");
  const found: string[] = [];
  let entryCount = 0;
  const visit = async (directory: string, depth = 0): Promise<void> => {
    if (depth > PROJECT_INPUT_DEPTH_LIMIT) {
      throw new Error(`Project test input traversal exceeds ${PROJECT_INPUT_DEPTH_LIMIT} directories`);
    }
    for await (const entry of await opendir(directory)) {
      const absolutePath = join(directory, entry.name);
      const projectPath = normalizedRelative(root, absolutePath);
      if (
        entry.name === ".git" || entry.name === "node_modules" ||
        projectPath === outputPrefix || projectPath.startsWith(`${outputPrefix}/`)
      ) continue;
      entryCount += 1;
      if (entryCount > PROJECT_INPUT_ENTRY_LIMIT) {
        throw new Error(`Project test input traversal exceeds ${PROJECT_INPUT_ENTRY_LIMIT} entries`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Project test input must not be a symlink: ${projectPath}`);
      }
      if (entry.isDirectory()) await visit(absolutePath, depth + 1);
      else if (entry.isFile()) {
        found.push(projectPath);
        if (found.length > PROJECT_TEST_SOURCE_LIMIT) {
          throw new Error(`Project contains more than ${PROJECT_TEST_SOURCE_LIMIT} test-authority inputs`);
        }
      }
    }
  };
  await visit(root);
  return Object.freeze(found.sort());
}

async function discoverTestSourceGraph(
  projectRoot: string,
  testFiles: readonly string[],
): Promise<Readonly<{
  sourcePaths: readonly string[];
  focusedDeclarations: readonly string[];
  subprocessDeclarations: readonly string[];
}>> {
  const root = await realpath(projectRoot);
  const pending = testFiles.map((path) => resolve(root, ...path.split("/")));
  const visited = new Set<string>();
  const authenticatedPackageEntryLeaves = new Set<string>();
  const focusedDeclarations: string[] = [];
  const subprocessDeclarations: string[] = [];
  while (pending.length > 0) {
    const unresolved = pending.pop()!;
    const path = await realpath(unresolved);
    if (!isInside(root, path)) throw new Error("Project test source resolves outside the project root");
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > PROJECT_TEST_SOURCE_LIMIT) {
      throw new Error(`Project test graph contains more than ${PROJECT_TEST_SOURCE_LIMIT} source files`);
    }
    const entry = await lstat(unresolved);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Project test source must be a regular non-symlink file: ${normalizedRelative(root, unresolved)}`);
    }
    if (!SOURCE_EXTENSIONS.has(extname(path))) {
      throw new Error(`Unsupported project test source extension: ${normalizedRelative(root, path)}`);
    }
    const projectPath = normalizedRelative(root, path);
    if (extname(path) === ".json") continue;
    const source = new TextDecoder().decode((await readStableInput(path, projectPath)).bytes);
    if (authenticatedPackageEntryLeaves.has(path)) continue;
    const inspection = inspectTestSource(source, projectPath);
    focusedDeclarations.push(...inspection.focusedDeclarations);
    subprocessDeclarations.push(...inspection.subprocessDeclarations);
    const scan = await new Bun.Transpiler({ loader: loaderFor(path) }).scan(source);
    for (const imported of scan.imports) {
      if (imported.path.startsWith("node:") || imported.path.startsWith("bun:")) continue;
      if (SUBPROCESS_MODULES.has(imported.path)) continue;
      let resolvedImport: string;
      try {
        resolvedImport = Bun.resolveSync(imported.path, path.slice(0, path.lastIndexOf(sep)));
      } catch (error) {
        throw new Error(
          `Cannot resolve project test import ${JSON.stringify(imported.path)} from ${projectPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const canonical = await realpath(resolvedImport);
      const bare = !imported.path.startsWith(".") && !isAbsolute(imported.path);
      const packageName = imported.path.startsWith("@")
        ? imported.path.split("/").slice(0, 2).join("/")
        : imported.path.split("/")[0]!;
      if (bare && packageName === "pcboo") {
        if (await owningPackageRoot(canonical, "pcboo") !== await runtimePcbooRoot) {
          throw new Error("Project test resolved pcboo to a different physical package");
        }
        if (isInside(root, canonical)) {
          authenticatedPackageEntryLeaves.add(canonical);
          pending.push(canonical);
        }
        continue;
      }
      if (bare && packageName === "tscircuit") {
        const projectEngineRoot = await realpath(join(root, "node_modules", "tscircuit"));
        if (await owningPackageRoot(canonical, "tscircuit") !== projectEngineRoot) {
          throw new Error("Project test resolved tscircuit to a different physical package");
        }
        if (isInside(root, canonical)) {
          authenticatedPackageEntryLeaves.add(canonical);
          pending.push(canonical);
        }
        continue;
      }
      if (!isInside(root, canonical)) {
        throw new Error(
          `Project test import or dependency resolves outside the project root: ${projectPath} -> ${imported.path}`,
        );
      }
      pending.push(resolvedImport);
    }
  }
  return Object.freeze({
    sourcePaths: Object.freeze([...visited].map((path) => normalizedRelative(root, path)).sort()),
    focusedDeclarations: Object.freeze([...new Set(focusedDeclarations)].sort()),
    subprocessDeclarations: Object.freeze([...new Set(subprocessDeclarations)].sort()),
  });
}

async function captureInputFile(
  projectRoot: string,
  path: string,
): Promise<Readonly<TestInputFileIdentity>> {
  const absolutePath = resolve(projectRoot, ...path.split("/"));
  const captured = await readStableInput(absolutePath, path);
  return Object.freeze({
    path,
    size: captured.bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(captured.bytes).digest("hex"),
    dev: captured.dev,
    ino: captured.ino,
    mtimeMs: captured.mtimeMs,
    ctimeMs: captured.ctimeMs,
  });
}

async function readStableInput(
  absolutePath: string,
  projectPath: string,
): Promise<Readonly<{
  bytes: Uint8Array;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}>> {
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Project test input is not a regular file: ${projectPath}`);
    if (!Number.isSafeInteger(before.size) || before.size > PROJECT_TEST_INPUT_FILE_LIMIT) {
      throw new Error(
        `Project test input exceeds the ${PROJECT_TEST_INPUT_FILE_LIMIT}-byte per-file limit: ${projectPath}`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size
    ) throw new Error(`Project test input changed while being captured: ${projectPath}`);
    return Object.freeze({
      bytes,
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    });
  } finally {
    await handle.close();
  }
}

async function assertBoundedProjectTestInputs(
  projectRoot: string,
  paths: readonly string[],
): Promise<void> {
  let total = 0;
  for (const path of paths) {
    const absolutePath = resolve(projectRoot, ...path.split("/"));
    const entry = await lstat(absolutePath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Project test input is not a regular non-symlink file: ${path}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size > PROJECT_TEST_INPUT_FILE_LIMIT) {
      throw new Error(
        `Project test input exceeds the ${PROJECT_TEST_INPUT_FILE_LIMIT}-byte per-file limit: ${path}`,
      );
    }
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > PROJECT_TEST_INPUT_TOTAL_LIMIT) {
      throw new Error(
        `Project test inputs exceed the ${PROJECT_TEST_INPUT_TOTAL_LIMIT}-byte aggregate limit`,
      );
    }
  }
}

export async function captureProjectTestInputAuthority(options: {
  readonly projectRoot: string;
  readonly outputDirectory: string;
}): Promise<Readonly<ProjectTestInputAuthority>> {
  const testFiles = await discoverTestFiles(options.projectRoot, options.outputDirectory);
  const graph = await discoverTestSourceGraph(options.projectRoot, testFiles);
  const projectInputPaths = await discoverProjectInputFiles(options.projectRoot, options.outputDirectory);
  const sourcePaths = [...new Set([...graph.sourcePaths, ...projectInputPaths])].sort();
  await assertBoundedProjectTestInputs(options.projectRoot, sourcePaths);
  const sourceFiles: TestInputFileIdentity[] = [];
  for (const path of sourcePaths) {
    sourceFiles.push(await captureInputFile(options.projectRoot, path));
  }
  return Object.freeze({
    testFiles,
    sourceFiles: Object.freeze(sourceFiles),
    focusedDeclarations: graph.focusedDeclarations,
    subprocessDeclarations: graph.subprocessDeclarations,
  });
}

export async function verifyProjectTestInputAuthority(
  authority: Readonly<ProjectTestInputAuthority>,
  options: { readonly projectRoot: string; readonly outputDirectory: string },
): Promise<void> {
  const current = await captureProjectTestInputAuthority(options);
  if (JSON.stringify(current) !== JSON.stringify(authority)) {
    throw new Error("Project code or test inputs changed during test execution");
  }
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  terminate: () => void,
): Promise<Readonly<{ bytes: Uint8Array; exceeded: boolean }>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let observed = 0;
  let exceeded = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      observed += chunk.value.byteLength;
      if (captured < limit) {
        const remaining = limit - captured;
        const retained = chunk.value.byteLength <= remaining
          ? chunk.value
          : chunk.value.slice(0, remaining);
        chunks.push(retained);
        captured += retained.byteLength;
      }
      if (!exceeded && observed > limit) {
        exceeded = true;
        terminate();
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Object.freeze({ bytes: concatChunks(chunks, captured), exceeded });
}

function parseNonnegativeInteger(attributes: string, name: string): number {
  const match = new RegExp(`(?:^|\\s)${name}="(\\d+)"(?:\\s|$)`, "u").exec(attributes);
  if (match === null) throw new Error(`JUnit summary is missing ${name}`);
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error(`JUnit ${name} is outside the safe integer range`);
  return value;
}

export function parseBunJunitSummary(bytes: Uint8Array): Readonly<ProjectTestCounts> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const root = /<testsuites\s+([^>]*)>/u.exec(text);
  if (root === null) throw new Error("Bun JUnit output has no testsuites root");
  const attributes = root[1]!;
  const total = parseNonnegativeInteger(attributes, "tests");
  const failures = parseNonnegativeInteger(attributes, "failures");
  const skipped = parseNonnegativeInteger(attributes, "skipped");
  const assertions = parseNonnegativeInteger(attributes, "assertions");
  if (failures > total || skipped > total || failures + skipped > total) {
    throw new Error("Bun JUnit counts are contradictory");
  }
  const executed = total - skipped;
  return Object.freeze({
    total,
    executed,
    passed: executed - failures,
    failed: failures,
    skipped,
    assertions,
  });
}

function countFrameworkSentinels(
  bytes: Uint8Array,
  expected: readonly Readonly<{ name: string; file: string }>[],
): number {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const expectedByName = new Map(expected.map((item) => [item.name, item] as const));
  const observed = new Set<string>();
  for (const match of text.matchAll(/<testcase\s+([^>]*)\/>/gu)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[1]!.matchAll(/([A-Za-z][A-Za-z0-9_.-]*)="([^"]*)"/gu)) {
      if (attributes.has(attribute[1]!)) return -1;
      attributes.set(attribute[1]!, attribute[2]!);
    }
    const name = attributes.get("name");
    if (name === undefined) continue;
    const sentinel = expectedByName.get(name);
    if (sentinel === undefined) continue;
    if (
      observed.has(name) || attributes.get("file") !== sentinel.file ||
      attributes.get("line") !== "3" || attributes.get("assertions") !== "0"
    ) return -1;
    observed.add(name);
  }
  return observed.size;
}

async function captureOptionalJunit(
  junitPath: string,
): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(junitPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > PROJECT_TEST_JUNIT_LIMIT) return null;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size
    ) throw new Error("Bun JUnit output changed while being captured");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function probeRuntimeFocus(options: {
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly testFiles: readonly string[];
  readonly offline: boolean;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly signal?: AbortSignal;
}): Promise<Readonly<{
  focused: number;
  reason?: "timeout" | "output-limit" | "cancelled" | "runner-output-invalid" | "runner-exit" | "process-containment-unavailable" | "process-containment-violation";
}>> {
  if (options.timeoutMs < 10) return Object.freeze({ focused: 0, reason: "timeout" as const });
  const junitPath = join(options.runDirectory, "focus-probe.xml");
  const bunfigPath = join(options.runDirectory, "focus-probe-bunfig.toml");
  await writeFile(bunfigPath, "# PCBoo-controlled Bun focus-probe configuration\n", { flag: "wx" });
  let child: Readonly<ContainedProcess>;
  try {
    child = await spawnContainedProcess({
      command: [
      process.execPath, "test", "--config", bunfigPath,
      "--only",
      ...options.testFiles.map((path) => resolve(options.projectRoot, ...path.split("/"))),
      "--reporter=junit", `--reporter-outfile=${junitPath}`,
      ],
      cwd: options.projectRoot,
      env: sanitizedTestEnvironment(options.offline),
    });
  } catch (error) {
    await rm(bunfigPath, { force: true });
    const containment = classifyProjectTestContainmentError(error);
    return Object.freeze({
      focused: 0,
      reason: containment?.reason ?? "runner-exit" as const,
    });
  }
  const terminate = () => child.terminate();
  let timedOut = false; let cancelled = options.signal?.aborted ?? false; let junitExceeded = false;
  const onAbort = () => { cancelled = true; terminate(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (cancelled) terminate();
  const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  const monitor = setInterval(async () => {
    try { if ((await stat(junitPath)).size > PROJECT_TEST_JUNIT_LIMIT) { junitExceeded = true; terminate(); } } catch { /* not created yet */ }
  }, 20);
  let stdout: Readonly<{ bytes: Uint8Array; exceeded: boolean }>;
  let stderr: Readonly<{ bytes: Uint8Array; exceeded: boolean }>;
  let exitCode: number | null = null;
  let containment: ReturnType<typeof classifyProjectTestContainmentError> = null;
  const stdoutPromise = readBoundedBytes(child.stdout, options.outputLimit, terminate);
  const stderrPromise = readBoundedBytes(child.stderr, options.outputLimit, terminate);
  try {
    try { exitCode = await child.exited; }
    catch (error) {
      containment = classifyProjectTestContainmentError(error);
      if (containment === null) throw error;
    }
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  } finally {
    clearTimeout(timer); clearInterval(monitor); options.signal?.removeEventListener("abort", onAbort);
    terminate(); await child.exited.catch(() => undefined);
  }
  const junit = junitExceeded ? null : await captureOptionalJunit(junitPath).catch(() => null);
  await rm(junitPath, { force: true });
  await rm(bunfigPath, { force: true });
  if (cancelled) return Object.freeze({ focused: 0, reason: "cancelled" as const });
  if (timedOut) return Object.freeze({ focused: 0, reason: "timeout" as const });
  if (stdout.exceeded || stderr.exceeded || junitExceeded) return Object.freeze({ focused: 0, reason: "output-limit" as const });
  if (containment !== null) return Object.freeze({ focused: 0, reason: containment.reason });
  if (exitCode !== 0) return Object.freeze({ focused: 0, reason: "runner-exit" as const });
  // Bun 1.3.14 does not create a JUnit file for a successful --only run with
  // zero focused declarations. A nonzero process exit is handled above.
  if (junit === null) return Object.freeze({ focused: 0 });
  try { return Object.freeze({ focused: parseBunJunitSummary(junit).total }); }
  catch { return Object.freeze({ focused: 0, reason: "runner-output-invalid" as const }); }
}

function sanitizedTestEnvironment(offline: boolean): Record<string, string> {
  const environment: Record<string, string> = { PCBOO_PROJECT_TEST: "1" };
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (offline) {
    environment.BUN_CONFIG_NO_NETWORK = "1";
    environment.NO_PROXY = "*";
    environment.no_proxy = "*";
  }
  return environment;
}

function executionResult(options: {
  readonly authority: Readonly<ProjectTestInputAuthority>;
  readonly outcome: ProjectTestOutcome;
  readonly reason: ProjectTestReason;
  readonly counts?: Readonly<ProjectTestCounts> | null;
  readonly exitCode?: number | null;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly stdoutExceeded?: boolean;
  readonly stderrExceeded?: boolean;
  readonly junitExceeded?: boolean;
  readonly focusSentinelsExpected?: number;
  readonly focusSentinelsObserved?: number;
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly junit?: Uint8Array | null;
}): Readonly<ProjectTestExecution> {
  return Object.freeze({
    schemaVersion: 1 as const,
    outcome: options.outcome,
    reason: options.reason,
    testFiles: options.authority.testFiles,
    counts: options.counts ?? null,
    execution: Object.freeze({
      exitCode: options.exitCode ?? null,
      timeoutMs: options.timeoutMs,
      outputLimitBytes: options.outputLimit,
      timedOut: options.timedOut ?? false,
      cancelled: options.cancelled ?? false,
      stdoutExceeded: options.stdoutExceeded ?? false,
      stderrExceeded: options.stderrExceeded ?? false,
      junitExceeded: options.junitExceeded ?? false,
      focusSentinelsExpected: options.focusSentinelsExpected ?? 0,
      focusSentinelsObserved: options.focusSentinelsObserved ?? 0,
    }),
    stdout: options.stdout ?? new Uint8Array(),
    stderr: options.stderr ?? new Uint8Array(),
    junit: options.junit ?? null,
    inputAuthority: options.authority,
  });
}

/** Runs only explicitly discovered standard Bun test files, without a shell. */
export async function runBunProjectTests(options: {
  readonly projectRoot: string;
  readonly outputDirectory: string;
  readonly runDirectory: string;
  readonly offline?: boolean;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  readonly signal?: AbortSignal;
}): Promise<Readonly<ProjectTestExecution>> {
  requireSupportedBunRuntime();
  const timeoutMs = options.timeoutMs ?? PROJECT_TEST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const outputLimit = options.outputLimit ?? PROJECT_TEST_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) {
    throw new TypeError("Project test timeout must be an integer from 10 through 300000 ms");
  }
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1_024 || outputLimit > 16 * 1024 * 1024) {
    throw new TypeError("Project test output limit must be an integer from 1024 through 16777216 bytes");
  }
  const authority = await captureProjectTestInputAuthority(options);
  if (authority.testFiles.length === 0) {
    return executionResult({ authority, outcome: "incomplete", reason: "no-test-files", timeoutMs, outputLimit });
  }
  if (options.offline === true) {
    return executionResult({
      authority,
      outcome: "incomplete",
      reason: "offline-containment-unavailable",
      timeoutMs,
      outputLimit,
    });
  }
  if (authority.focusedDeclarations.length > 0) {
    return executionResult({ authority, outcome: "incomplete", reason: "focused-tests", timeoutMs, outputLimit });
  }
  if (authority.subprocessDeclarations.length > 0) {
    return executionResult({ authority, outcome: "incomplete", reason: "subprocess-forbidden", timeoutMs, outputLimit });
  }

  const junitPath = join(options.runDirectory, "junit.xml");
  const wrapperDirectory = join(options.runDirectory, "test-wrappers");
  await mkdir(wrapperDirectory);
  const guardPath = join(wrapperDirectory, "pcboo-test-policy-guard.mjs");
  const bunfigPath = join(wrapperDirectory, "pcboo-controlled-bunfig.toml");
  await writeFile(guardPath, PROJECT_TEST_POLICY_GUARD_SOURCE, { flag: "wx" });
  await writeFile(bunfigPath, "# PCBoo-controlled Bun test configuration\n", { flag: "wx" });
  const sentinels = authority.testFiles.map((_, index) =>
    `PCBOO_SUITE_SENTINEL_${index}_${crypto.randomUUID().replaceAll("-", "")}`
  );
  const wrapperPaths = await Promise.all(authority.testFiles.map(async (path, index) => {
    const wrapperPath = join(wrapperDirectory, `${String(index).padStart(4, "0")}.test.ts`);
    const sourceUrl = pathToFileURL(resolve(options.projectRoot, ...path.split("/"))).href;
    await writeFile(
      wrapperPath,
      `import ${JSON.stringify(sourceUrl)};\nimport { test } from "bun:test";\ntest(${JSON.stringify(sentinels[index]!)}, () => {});\n`,
      { flag: "wx" },
    );
    return wrapperPath;
  }));
  const wrapperCanonicalPaths = await Promise.all(wrapperPaths.map((path) => realpath(path)));
  const canonicalProjectRoot = await realpath(options.projectRoot);
  const wrapperEvidencePaths = wrapperCanonicalPaths.map((path) => normalizedRelative(canonicalProjectRoot, path));
  let child: Readonly<ContainedProcess>;
  try {
    child = await spawnContainedProcess({
      command: [
        process.execPath,
        "test",
        "--config",
        bunfigPath,
        "--preload",
        guardPath,
        ...wrapperPaths,
        "--reporter=junit",
        `--reporter-outfile=${junitPath}`,
      ],
      cwd: options.projectRoot,
      env: sanitizedTestEnvironment(options.offline ?? false),
    });
  } catch (error) {
    await rm(wrapperDirectory, { recursive: true, force: true });
    const containment = classifyProjectTestContainmentError(error);
    return executionResult({
      authority,
      outcome: containment?.outcome ?? "failed",
      reason: containment?.reason ?? "start-failed",
      timeoutMs,
      outputLimit,
    });
  }

  const terminate = () => child.terminate();
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;
  let junitExceeded = false;
  const onAbort = () => { cancelled = true; terminate(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (cancelled) terminate();
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  const monitor = setInterval(async () => {
    try {
      if ((await stat(junitPath)).size > PROJECT_TEST_JUNIT_LIMIT) {
        junitExceeded = true;
        terminate();
      }
    } catch {
      // The reporter creates the file after the process starts.
    }
  }, 20);
  let stdout: Readonly<{ bytes: Uint8Array; exceeded: boolean }>;
  let stderr: Readonly<{ bytes: Uint8Array; exceeded: boolean }>;
  let exitCode: number | null = null;
  let containment: ReturnType<typeof classifyProjectTestContainmentError> = null;
  const stdoutPromise = readBoundedBytes(child.stdout, outputLimit, terminate);
  const stderrPromise = readBoundedBytes(child.stderr, outputLimit, terminate);
  try {
    try { exitCode = await child.exited; }
    catch (error) {
      containment = classifyProjectTestContainmentError(error);
      if (containment === null) throw error;
    }
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    options.signal?.removeEventListener("abort", onAbort);
    terminate();
    await child.exited.catch(() => undefined);
    await rm(wrapperDirectory, { recursive: true, force: true });
  }
  if (containment !== null) {
    await rm(junitPath, { force: true });
    const containmentCommon = {
      authority, exitCode: null, timeoutMs, outputLimit,
      timedOut, cancelled, stdoutExceeded: stdout.exceeded,
      stderrExceeded: stderr.exceeded, junitExceeded,
      stdout: stdout.bytes, stderr: stderr.bytes,
    } as const;
    if (cancelled) return executionResult({ ...containmentCommon, outcome: "cancelled", reason: "cancelled" });
    if (timedOut) return executionResult({ ...containmentCommon, outcome: "failed", reason: "timeout" });
    if (stdout.exceeded || stderr.exceeded || junitExceeded) {
      return executionResult({ ...containmentCommon, outcome: "failed", reason: "output-limit" });
    }
    return executionResult({
      ...containmentCommon,
      outcome: containment.outcome,
      reason: containment.reason,
    });
  }
  let junit: Uint8Array | null = null;
  try {
    junit = junitExceeded ? null : await captureOptionalJunit(junitPath);
  } catch {
    junit = null;
  }
  // The reporter-owned path is untrusted mutable process output. The caller
  // publishes only a fresh captured copy of these exact bytes.
  await rm(junitPath, { force: true });
  const common = {
    authority, exitCode, timeoutMs, outputLimit,
    timedOut, cancelled, stdoutExceeded: stdout.exceeded,
    stderrExceeded: stderr.exceeded, junitExceeded,
    stdout: stdout.bytes, stderr: stderr.bytes, junit,
  } as const;
  if (cancelled) return executionResult({ ...common, outcome: "cancelled", reason: "cancelled" });
  if (timedOut) return executionResult({ ...common, outcome: "failed", reason: "timeout" });
  if (stdout.exceeded || stderr.exceeded || junitExceeded) {
    return executionResult({ ...common, outcome: "failed", reason: "output-limit" });
  }
  const stderrText = new TextDecoder().decode(stderr.bytes);
  if (/^error: PCBOO_FOCUSED_TEST_FORBIDDEN$/mu.test(stderrText)) {
    return executionResult({ ...common, outcome: "incomplete", reason: "focused-tests" });
  }
  if (/^error: PCBOO_EXPECTED_FAILURE_TEST_FORBIDDEN$/mu.test(stderrText)) {
    return executionResult({ ...common, outcome: "incomplete", reason: "expected-failing-tests" });
  }

  let counts: Readonly<ProjectTestCounts> | null = null;
  if (junit !== null) {
    try { counts = parseBunJunitSummary(junit); }
    catch { counts = null; }
  }
  const sentinelCount = junit === null ? 0 : countFrameworkSentinels(
    junit,
    sentinels.map((name, index) => Object.freeze({ name, file: wrapperEvidencePaths[index]! })),
  );
  if (exitCode === 0 && counts !== null && sentinelCount !== sentinels.length) {
    return executionResult({
      ...common,
      counts,
      outcome: "incomplete",
      reason: "focused-tests",
      focusSentinelsExpected: sentinels.length,
      focusSentinelsObserved: sentinelCount,
    });
  }
  if (counts !== null && sentinelCount === sentinels.length) {
    counts = Object.freeze({
      total: counts.total - sentinelCount,
      executed: counts.executed - sentinelCount,
      passed: counts.passed - sentinelCount,
      failed: counts.failed,
      skipped: counts.skipped,
      assertions: counts.assertions,
    });
    if (counts.total < 0 || counts.executed < 0 || counts.passed < 0) counts = null;
  }
  if (exitCode !== 0) {
    return executionResult({
      ...common,
      counts,
      outcome: "failed",
      reason: counts !== null && counts.failed > 0 ? "test-failures" : "runner-exit",
    });
  }
  if (counts === null || counts.failed !== 0) {
    return executionResult({ ...common, counts, outcome: "failed", reason: "runner-output-invalid" });
  }
  if (counts.skipped > 0) {
    return executionResult({ ...common, counts, outcome: "incomplete", reason: "skipped-tests" });
  }
  if (counts.total === 0 || counts.executed === 0) {
    return executionResult({ ...common, counts, outcome: "incomplete", reason: "no-test-cases" });
  }
  const focusProbe = await probeRuntimeFocus({
    projectRoot: options.projectRoot,
    runDirectory: options.runDirectory,
    testFiles: authority.testFiles,
    offline: options.offline ?? false,
    timeoutMs: deadline - Date.now(),
    outputLimit,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (focusProbe.reason !== undefined) {
    return executionResult({
      ...common,
      counts,
      outcome: focusProbe.reason === "cancelled" ? "cancelled" :
        focusProbe.reason === "process-containment-unavailable" ? "incomplete" : "failed",
      reason: focusProbe.reason,
    });
  }
  if (focusProbe.focused > 0) {
    return executionResult({
      ...common,
      counts,
      outcome: "incomplete",
      reason: "focused-tests",
      focusSentinelsExpected: sentinels.length,
      focusSentinelsObserved: sentinelCount,
    });
  }
  return executionResult({
    ...common,
    counts,
    outcome: "passed",
    reason: "passed",
    focusSentinelsExpected: sentinels.length,
    focusSentinelsObserved: sentinelCount,
  });
}
