// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PCBOO_PACKAGE_NAME } from "../version";
import {
  assertProjectInputFileSize,
  assertProjectInputTotalSize,
  PROJECT_INPUT_FILE_LIMIT,
} from "./input-limits";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;
const FORBIDDEN_RUNTIME_GLOBALS = new Set([
  "Bun",
  "process",
  "Deno",
  "fetch",
  "eval",
  "Function",
  "globalThis",
  "window",
  "self",
  "require",
  "global",
  "Reflect",
  "Proxy",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "ShadowRealm",
  // Bun exposes Node and Bun modules as globals in `bun -e`; imports are not
  // required to reach these capabilities.
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "constants",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "ffi",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "jsc",
  "net",
  "os",
  "path",
  "perf_hooks",
  "punycode",
  "querystring",
  "readline",
  "sqlite",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
  // Other ambient input, clock, concurrency, and unsafe-memory surfaces.
  "alert",
  "confirm",
  "prompt",
  "Buffer",
  "File",
  "Atomics",
  "SharedArrayBuffer",
  "MessageChannel",
  "MessagePort",
  "PerformanceObserver",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "postMessage",
  "reportError",
  "onerror",
  "onmessage",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
]);

const AMBIENT_NONDETERMINISM_GLOBALS = new Set([
  "Date",
  "performance",
  "crypto",
  "Temporal",
  "navigator",
  "Intl",
  "WeakRef",
  "FinalizationRegistry",
]);

const DETERMINISTIC_RUNTIME_GLOBALS = new Set([
  "undefined", "NaN", "Infinity",
  "Object", "Boolean", "Number", "BigInt", "String", "Symbol",
  "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError",
  "SyntaxError", "TypeError", "URIError",
  "Array", "ArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array",
  "Float16Array", "Float32Array", "Float64Array",
  "Map", "Set", "WeakMap", "WeakSet", "JSON", "RegExp", "Promise", "Math",
  "parseFloat", "parseInt", "isFinite", "isNaN",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
  "escape", "unescape", "atob", "btoa",
  "TextEncoder", "TextDecoder", "structuredClone", "Iterator",
  "DisposableStack", "AsyncDisposableStack",
]);

const AUTHORING_IMPORTS = new Set([
  "AnyCircuitElement",
  "Battery",
  "Board",
  "Bus",
  "Capacitor",
  "Chip",
  "Circuit",
  "CircuitJson",
  "Connector",
  "Constraint",
  "CopperPour",
  "Crystal",
  "CurrentSource",
  "Cutout",
  "DifferentialPair",
  "Diode",
  "DrcCheck",
  "Footprint",
  "Fuse",
  "Group",
  "Hole",
  "Inductor",
  "Jumper",
  "Keepout",
  "Led",
  "Mosfet",
  "Net",
  "NetLabel",
  "OpAmp",
  "Panel",
  "PcbCopperLayer",
  "PcbTrace",
  "PcbVia",
  "PinHeader",
  "PlatedHole",
  "Potentiometer",
  "PowerSource",
  "Project",
  "PushButton",
  "Resistor",
  "ResolvedSemanticPcbRoute",
  "SemanticPcbTrace",
  "SemanticPcbRouteDefinition",
  "SemanticPortSelector",
  "SmtPad",
  "SolderJumper",
  "Subcircuit",
  "Switch",
  "TestPoint",
  "Trace",
  "Transistor",
  "Via",
  "VoltageSource",
  "createElement",
  "defineRoute",
  "defineRoutes",
  "port",
  "resolveSemanticPcbRoute",
  "sel",
]);

const DANGEROUS_REFLECTION_PROPERTIES = new Set([
  "__proto__",
  "constructor",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "setPrototypeOf",
  "evaluate",
  "importValue",
  "stack",
  "caller",
  "callee",
]);

function staticString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  return undefined;
}

function assertAuthoringPackageImport(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  path: string,
  configMode: boolean,
): void {
  if (node.moduleSpecifier === undefined || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
  const specifier = node.moduleSpecifier.text;
  const isPcboo = specifier === "pcboo" || specifier === "pcboo/authoring";
  const isTscircuit = specifier === "tscircuit";
  if (!isPcboo && !isTscircuit) {
    if (specifier.startsWith("pcboo/") || specifier.startsWith("tscircuit/")) {
      throw new Error(`Verified source forbids operational package surface ${JSON.stringify(specifier)} in ${path}`);
    }
    return;
  }
  const bindings = ts.isImportDeclaration(node)
    ? node.importClause?.namedBindings
    : node.exportClause;
  if (bindings === undefined || !ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) {
    throw new Error(`Verified source requires explicit named authoring imports from ${specifier} in ${path}`);
  }
  for (const binding of bindings.elements) {
    const importedName = binding.propertyName?.text ?? binding.name.text;
    const allowed = configMode
      ? isPcboo && specifier === "pcboo" && importedName === "defineConfig"
      : AUTHORING_IMPORTS.has(importedName);
    if (!allowed) {
      throw new Error(
        `Verified source forbids non-authoring import ${importedName} from ${specifier} in ${path}`,
      );
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function findPackageRoot(start: string, packageName: string): Promise<string> {
  let current = dirname(start);
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(resolve(current, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (packageJson.name === packageName) return await realpath(current);
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot find package root for ${packageName}`);
    current = parent;
  }
}

const runtimePcbooRoot = findPackageRoot(fileURLToPath(import.meta.url), PCBOO_PACKAGE_NAME);

async function resolveLocalImport(
  projectRoot: string,
  importer: string,
  specifier: string,
  enforceVerifiedSemantics: boolean,
): Promise<string | undefined> {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    if (!enforceVerifiedSemantics) return undefined;
    throw new Error(`Verified source forbids undeclared runtime I/O package ${JSON.stringify(specifier)}`);
  }
  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, dirname(importer));
  } catch (error) {
    throw new Error(
      `Cannot resolve import ${JSON.stringify(specifier)} from ${relative(projectRoot, importer)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const canonical = await realpath(resolved);
  const bare = !specifier.startsWith(".") && !isAbsolute(specifier);
  if (!bare) {
    const lexicalBase = resolve(dirname(importer), specifier);
    const lexicalCandidates = [
      lexicalBase,
      ...SOURCE_EXTENSIONS.map((extension) => `${lexicalBase}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => resolve(lexicalBase, `index${extension}`)),
    ];
    for (const candidate of lexicalCandidates) {
      try {
        const actual = await realpath(candidate);
        if (actual !== canonical) continue;
        if (actual !== candidate) {
          throw new Error(
            `Project source import must not traverse a symlink: ${relative(projectRoot, importer)} -> ${specifier}`,
          );
        }
        break;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Project source import must not traverse a symlink")
        ) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
  if (canonical.split(sep).includes("node_modules")) {
    if (bare && packageName === "pcboo") {
      const importedRoot = await findPackageRoot(canonical, PCBOO_PACKAGE_NAME);
      if (importedRoot !== await runtimePcbooRoot) {
        throw new Error("Verified source resolved pcboo to a different physical package");
      }
      return undefined;
    }
    if (bare && packageName === "tscircuit") return undefined;
    if (!enforceVerifiedSemantics && bare) return undefined;
    throw new Error(`Verified source imports unlocked package ${JSON.stringify(packageName)}`);
  }
  if (!isInside(projectRoot, canonical)) {
    if (specifier.startsWith(".") || isAbsolute(specifier)) {
      throw new Error(
        `Project source import escapes the project root: ${relative(projectRoot, importer)} -> ${specifier}`,
      );
    }
    if (bare && packageName === "pcboo") {
      const importedRoot = await findPackageRoot(canonical, PCBOO_PACKAGE_NAME);
      if (importedRoot !== await runtimePcbooRoot) {
        throw new Error("Verified source resolved pcboo to a different physical package");
      }
      return undefined;
    }
    if (bare && packageName === "tscircuit") return undefined;
    if (!enforceVerifiedSemantics && bare) return undefined;
    throw new Error(`Verified source imports unbound external package ${JSON.stringify(packageName)}`);
  }
  const stat = await lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Project source import must resolve to a regular non-symlink file: ${specifier}`);
  }
  return canonical;
}

function assertLiteralModuleLoads(
  source: string,
  path: string,
  enforceVerifiedSemantics: boolean,
  forbidAmbientNondeterminism: boolean,
  configMode: boolean,
): void {
  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => fileName === path
      ? ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
      : undefined,
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (fileName) => fileName === path,
    readFile: (fileName) => fileName === path ? source : undefined,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([path], compilerOptions, host);
  const sourceFile = program.getSourceFile(path);
  if (sourceFile === undefined) throw new Error(`Unable to parse verified source ${path}`);
  const checker = program.getTypeChecker();
  const hasDeclareModifier = (declaration: ts.Declaration): boolean => {
    for (
      let current: ts.Node | undefined = declaration;
      current !== undefined && !ts.isSourceFile(current);
      current = current.parent
    ) {
      if (ts.canHaveModifiers(current) &&
        ts.getModifiers(current)?.some(({ kind }) => kind === ts.SyntaxKind.DeclareKeyword)) {
        return true;
      }
    }
    return false;
  };
  const declarationEmitsRuntimeBinding = (declaration: ts.Declaration): boolean => {
    if (hasDeclareModifier(declaration)) return false;
    if (ts.isImportSpecifier(declaration)) {
      const importDeclaration = declaration.parent.parent.parent;
      return !declaration.isTypeOnly &&
        ts.isImportDeclaration(importDeclaration) &&
        importDeclaration.importClause?.isTypeOnly !== true;
    }
    if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) {
      const importClause = ts.isImportClause(declaration)
        ? declaration
        : declaration.parent.parent;
      return ts.isImportClause(importClause) && !importClause.isTypeOnly;
    }
    if (ts.isImportEqualsDeclaration(declaration)) return !declaration.isTypeOnly;
    if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration) ||
      ts.isParameter(declaration) || ts.isClassDeclaration(declaration) ||
      ts.isClassExpression(declaration) || ts.isEnumDeclaration(declaration)) return true;
    if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) {
      return declaration.body !== undefined;
    }
    return false;
  };
  const symbolEmitsRuntimeBinding = (symbol: ts.Symbol | undefined): boolean =>
    symbol?.declarations?.some(declarationEmitsRuntimeBinding) === true;
  const isUnboundValueReference = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (
      ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) ||
      ts.isImportClause(parent) || ts.isImportEqualsDeclaration(parent)
    ) return false;
    if (
      ts.isExportSpecifier(parent) &&
      ts.isExportDeclaration(parent.parent.parent) &&
      parent.parent.parent.moduleSpecifier !== undefined
    ) return false;
    if (
      ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) ||
        ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) || ts.isEnumDeclaration(parent) ||
        ts.isEnumMember(parent) || ts.isTypeParameterDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) ||
        ts.isModuleDeclaration(parent) || ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
        parent.name === node) ||
      (ts.isLabeledStatement(parent) && parent.label === node) ||
      ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)
    ) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isQualifiedName(parent) && parent.right === node) return false;
    if (ts.isJsxAttribute(parent) && parent.name === node) return false;
    if (
      (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) ||
        ts.isJsxClosingElement(parent)) &&
      parent.tagName === node && /^[a-z]/u.test(node.text)
    ) return false;
    if (ts.isShorthandPropertyAssignment(parent)) {
      return !symbolEmitsRuntimeBinding(checker.getShorthandAssignmentValueSymbol(parent));
    }
    for (let current: ts.Node | undefined = parent; current !== undefined; current = current.parent) {
      if (ts.isTypeNode(current)) return false;
      if (ts.isExpression(current) || ts.isStatement(current) || ts.isSourceFile(current)) break;
    }
    return !symbolEmitsRuntimeBinding(checker.getSymbolAtLocation(node));
  };
  const isAmbientValueReference = (node: ts.Identifier): boolean =>
    node.text === "globalThis" || isUnboundValueReference(node);
  const bindingPropertyName = (node: ts.BindingElement): string | undefined => {
    const property = node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined);
    if (property === undefined) return undefined;
    if (ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)) {
      return property.text;
    }
    if (ts.isComputedPropertyName(property)) return staticString(property.expression);
    return undefined;
  };
  const isDangerousObjectBinding = (node: ts.Node): boolean => {
    if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent)) return false;
    const property = node.propertyName;
    const name = bindingPropertyName(node);
    return (property !== undefined && ts.isComputedPropertyName(property) && name === undefined) ||
      name !== undefined && DANGEROUS_REFLECTION_PROPERTIES.has(name);
  };
  const isDirectDeterministicMathMember = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      return parent.name.text !== "random";
    }
    if (
      ts.isElementAccessExpression(parent) && parent.expression === node &&
      parent.argumentExpression !== undefined
    ) {
      const member = staticString(parent.argumentExpression);
      return member !== undefined && member !== "random";
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (enforceVerifiedSemantics && ts.isImportEqualsDeclaration(node)) {
      throw new Error(`Verified source forbids import-equals declarations in ${path}`);
    }
    if (enforceVerifiedSemantics && ts.isModuleDeclaration(node)) {
      throw new Error(`Verified source forbids namespace and module declarations in ${path}`);
    }
    if (
      enforceVerifiedSemantics &&
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    ) assertAuthoringPackageImport(node, path, configMode);
    if (enforceVerifiedSemantics && ts.isMetaProperty(node)) {
      throw new Error(`Verified source forbids runtime import.meta access in ${path}`);
    }
    if (
      forbidAmbientNondeterminism &&
      ts.isIdentifier(node) &&
      isAmbientValueReference(node) &&
      (
        AMBIENT_NONDETERMINISM_GLOBALS.has(node.text) ||
        (node.text === "Math" && !isDirectDeterministicMathMember(node))
      )
    ) {
      throw new Error(
        `Verified source forbids ambient nondeterminism global ${node.text} in ${path}`,
      );
    }
    if (
      forbidAmbientNondeterminism &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      isUnboundValueReference(node.expression) &&
      node.name.text === "random"
    ) {
      throw new Error(
        `Verified source forbids ambient nondeterminism Math.random in ${path}`,
      );
    }
    if (
      enforceVerifiedSemantics && ts.isIdentifier(node) &&
      isAmbientValueReference(node) &&
      FORBIDDEN_RUNTIME_GLOBALS.has(node.text)
    ) {
      throw new Error(
        `Verified source forbids undeclared runtime I/O global ${node.text} in ${path}`,
      );
    }
    if (
      enforceVerifiedSemantics && ts.isIdentifier(node) &&
      isAmbientValueReference(node) &&
      !DETERMINISTIC_RUNTIME_GLOBALS.has(node.text)
    ) {
      throw new Error(
        `Verified source forbids unbound runtime global ${node.text} in ${path}`,
      );
    }
    if (
      enforceVerifiedSemantics &&
      (ts.isPropertyAccessExpression(node) &&
        DANGEROUS_REFLECTION_PROPERTIES.has(node.name.text)) ||
      (enforceVerifiedSemantics && ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        !ts.isNumericLiteral(node.argumentExpression) &&
        (
          staticString(node.argumentExpression) === undefined ||
          DANGEROUS_REFLECTION_PROPERTIES.has(staticString(node.argumentExpression)!)
        )) ||
      (enforceVerifiedSemantics && isDangerousObjectBinding(node))
    ) {
      throw new Error(
        `Verified source forbids runtime constructor/evaluator access in ${path}`,
      );
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (
          enforceVerifiedSemantics && isDynamicImport ||
          argument === undefined ||
          (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          throw new Error(
            `Verified source forbids ${argument === undefined || ts.isStringLiteralLike(argument) ? "" : "computed "}${isDynamicImport ? "dynamic import" : "require"} in ${path}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  switch (extname(path)) {
    case ".ts": return "ts";
    case ".tsx": return "tsx";
    case ".jsx": return "jsx";
    default: return "js";
  }
}

async function readStableProjectSource(path: string, projectPath: string): Promise<{
  readonly source: string;
  readonly size: number;
}> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Project source must be a regular file: ${projectPath}`);
    assertProjectInputFileSize(projectPath, before.size);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== before.size || current.isSymbolicLink() || !current.isFile() ||
      current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs
    ) throw new Error(`${projectPath} project source changed while it was inspected`);
    return Object.freeze({ source: new TextDecoder().decode(bytes), size: before.size });
  } finally {
    await handle.close();
  }
}

export async function discoverProjectSourceGraph(
  projectRoot: string,
  entry: string,
  options: Readonly<{
    enforceVerifiedSemantics?: boolean;
    forbidAmbientNondeterminism?: boolean;
  }> = {},
): Promise<readonly string[]> {
  const enforceVerifiedSemantics = options.enforceVerifiedSemantics ?? true;
  const forbidAmbientNondeterminism =
    options.forbidAmbientNondeterminism ?? enforceVerifiedSemantics;
  const configMode = entry.replaceAll("\\", "/") === "pcboo.config.ts";
  const root = await realpath(resolve(projectRoot));
  const unresolvedEntryPath = resolve(root, ...entry.replaceAll("\\", "/").split("/"));
  const entryPath = await realpath(unresolvedEntryPath);
  if (!isInside(root, entryPath)) throw new Error("Circuit entry resolves outside the project root");
  if (entryPath !== unresolvedEntryPath) {
    throw new Error("Project source entry must not traverse a symlink");
  }
  const pending = [entryPath];
  const visited = new Set<string>();
  let totalBytes = 0;
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > PROJECT_INPUT_FILE_LIMIT) {
      throw new Error(`Project source graph contains more than ${PROJECT_INPUT_FILE_LIMIT} files`);
    }
    const projectPath = relative(root, path);
    const entryStat = await lstat(path);
    if (!entryStat.isFile()) {
      throw new Error(`Project source must be a regular file: ${projectPath}`);
    }
    assertProjectInputFileSize(projectPath, entryStat.size);
    if (!SOURCE_EXTENSIONS.includes(extname(path) as (typeof SOURCE_EXTENSIONS)[number])) {
      throw new Error(`Unsupported project source extension: ${projectPath}`);
    }
    if (extname(path) === ".json") {
      totalBytes += entryStat.size;
      assertProjectInputTotalSize(totalBytes);
      continue;
    }
    const captured = await readStableProjectSource(path, projectPath);
    totalBytes += captured.size;
    assertProjectInputTotalSize(totalBytes);
    const source = captured.source;
    assertLiteralModuleLoads(
      source,
      projectPath,
      enforceVerifiedSemantics,
      forbidAmbientNondeterminism,
      configMode,
    );
    const scan = await new Bun.Transpiler({ loader: loaderFor(path) }).scan(source);
    for (const imported of scan.imports) {
      const dependency = await resolveLocalImport(
        root,
        path,
        imported.path,
        enforceVerifiedSemantics,
      );
      if (dependency !== undefined && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return Object.freeze([...visited]
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort());
}
