// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { fingerprintPackageContent } from "./engine-identity";
import { readBoundedRegularFile } from "./internal/bounded-file";
import { requireSupportedBunRuntime } from "./runtime";

export const DISTRIBUTED_PACKAGE_LICENSES = Object.freeze([
  { name: "@tscircuit/alphabet", version: "0.0.25", license: "MIT", contentSha256: "196a98cb71f0821d256f91d86cfc19c41e52778f8d0b4fae56628f017d91b519" },
  { name: "circuit-json", version: "0.0.464", license: "ISC", contentSha256: "89da172be71b44d541f1f31798c284be574778cbd3b34bf6d9a3f74334b2a00f" },
  { name: "circuit-json-to-bom-csv", version: "0.0.14", license: "MIT", contentSha256: "c67f71defac60a3ed5fb63e65dbcab4285ebe502ba74812dd7ecadf430146955" },
  { name: "circuit-json-to-gerber", version: "0.0.90", license: "MIT", contentSha256: "5ebf1dc2cfa1f74227e037c02b3e320dac3f59761af1c46851f980a59925d0c7" },
  { name: "circuit-json-to-kicad", version: "0.0.171", license: "MIT", contentSha256: "b69b6f63a21d5d6f9088168e254508602ab589a44c2b4a35fc86c18023b3315a" },
  { name: "circuit-json-to-pnp-csv", version: "0.0.9", license: "MIT", contentSha256: "80b1fa1e8045bb83f11c6f11c3a8afad13ef895564aeb85e93b58b108741b9ba" },
  { name: "circuit-to-svg", version: "0.0.400", license: "ISC", contentSha256: "e0c26ed6f3fab4d22afad4ef2794b991b53e0a7c995efc2359d35cbe9cb3bdec" },
  { name: "format-si-prefix", version: "0.3.2", license: "MIT", contentSha256: "5f1a4e5fd4519e1f33f9c3676bd0659663b94b72691aebaad870fc7349958677" },
  { name: "gerber-parser", version: "4.2.7", license: "MIT", contentSha256: "7a7fa9ec1f2649ed8c13ee184dd73b523c8a2bdb507a533e692d7e167c2de9a6" },
  { name: "kicadts", version: "0.0.53", license: "MIT", contentSha256: "d3664508f31c9b9fecc00a4d3f4a733e46396a430da9576840aafa4830d0c334" },
  { name: "tscircuit", version: "0.0.2261", license: "MIT", contentSha256: "c0880767e6967a6b7f8423604882ba6989d9a58108355b3835f48309f09cf487" },
  { name: "typescript", version: "5.9.3", license: "Apache-2.0", contentSha256: "1247d2a746ccfbc5d73c07f6d61c2e05197373d4668f258a0681e77298eccf27" },
] as const);

const LICENSE_MARKERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  MIT: [
    "MIT License",
    "Permission is hereby granted, free of charge",
    "The above copyright notice and this permission notice shall be included",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
    "IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE",
  ],
  ISC: [
    "Permission to use, copy, modify, and/or distribute",
    "with or without fee is hereby granted",
    'THE SOFTWARE IS PROVIDED "AS IS"',
    "IN NO EVENT SHALL THE AUTHOR BE LIABLE",
  ],
  "Apache-2.0": [
    "Apache License",
    "Version 2.0, January 2004",
    "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
    "Unless required by applicable law or agreed to in writing",
    "WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND",
  ],
});

const MAX_PACKAGE_METADATA_BYTES = 1024 * 1024;
const MAX_LICENSE_BYTES = 1024 * 1024;
const MAX_NOTICE_BYTES = 1024 * 1024;
const MAX_PACKAGED_SOURCE_FILES = 256;
const MAX_PACKAGED_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGED_SOURCE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGED_SOURCE_DEPTH = 16;
const PCBOO_SOURCE_COPYRIGHT = "// SPDX-FileCopyrightText: 2026 PCBoo contributors";
const PCBOO_SOURCE_LICENSE = "// SPDX-License-Identifier: MIT";

function normalizedLicenseText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export const PCBOO_DISTRIBUTION_FILES = Object.freeze([
  "compatibility",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "src",
] as const);

export const CREATE_PCBOO_DISTRIBUTION_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "src",
] as const);

export const PCBOO_MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 PCBoo contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const PINNED_SPDX_METADATA_FALLBACKS: Readonly<Record<string, Readonly<{
  license: string;
  source: string;
  contentSha256: string;
}>>> = Object.freeze({
  "circuit-json@0.0.464": Object.freeze({
    license: "ISC",
    source: "https://spdx.org/licenses/ISC.html",
    contentSha256: "89da172be71b44d541f1f31798c284be574778cbd3b34bf6d9a3f74334b2a00f",
  }),
  "circuit-to-svg@0.0.400": Object.freeze({
    license: "ISC",
    source: "https://spdx.org/licenses/ISC.html",
    contentSha256: "e0c26ed6f3fab4d22afad4ef2794b991b53e0a7c995efc2359d35cbe9cb3bdec",
  }),
});

export interface DistributionLicenseFinding {
  readonly package: string;
  readonly message: string;
}

async function licenseText(packageRoot: string): Promise<string> {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"]) {
    try {
      return decodeUtf8(
        await readBoundedRegularFile(join(packageRoot, name), MAX_LICENSE_BYTES),
        `${name} license text`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Try the next conventional name only when this spelling is absent.
    }
  }
  throw new Error("license text is missing");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("contains NUL");
    return text;
  } catch (error) {
    throw new Error(`${label} is not bounded valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeSourceUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not bounded valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function boundedText(path: string, limit: number, label: string): Promise<string> {
  return decodeUtf8(await readBoundedRegularFile(path, limit), label);
}

export async function validateDistributionLicenses(
  nodeModulesRoot: string,
): Promise<readonly DistributionLicenseFinding[]> {
  const root = await realpath(nodeModulesRoot);
  const findings: DistributionLicenseFinding[] = [];
  for (const expected of DISTRIBUTED_PACKAGE_LICENSES) {
    try {
      const packageRoot = await realpath(join(root, ...expected.name.split("/")));
      const metadata = JSON.parse(await boundedText(
        join(packageRoot, "package.json"),
        MAX_PACKAGE_METADATA_BYTES,
        `${expected.name} package metadata`,
      )) as {
        name?: unknown;
        version?: unknown;
        license?: unknown;
      };
      if (metadata.name !== expected.name || metadata.version !== expected.version) {
        findings.push({
          package: expected.name,
          message: `expected ${expected.name}@${expected.version}, found ${String(metadata.name)}@${String(metadata.version)}`,
        });
        continue;
      }
      if (
        typeof metadata.license === "string" && metadata.license !== expected.license
      ) {
        findings.push({
          package: expected.name,
          message: `expected ${expected.license}, package declares ${String(metadata.license)}`,
        });
        continue;
      }
      const fallback = PINNED_SPDX_METADATA_FALLBACKS[`${expected.name}@${expected.version}`];
      if (fallback !== undefined && metadata.license !== expected.license) {
        findings.push({
          package: expected.name,
          message: `pinned SPDX fallback requires package metadata license ${expected.license}, found ${String(metadata.license)}`,
        });
        continue;
      }
      const contentSha256 = await fingerprintPackageContent(packageRoot);
      if (contentSha256 !== expected.contentSha256) {
        findings.push({
          package: expected.name,
          message: `installed content ${contentSha256} does not match reviewed content ${expected.contentSha256}`,
        });
        continue;
      }
      if (fallback !== undefined) {
        if (
          fallback.license !== expected.license ||
          fallback.source !== `https://spdx.org/licenses/${expected.license}.html`
        ) {
          findings.push({
            package: expected.name,
            message: "pinned SPDX classification metadata is internally inconsistent",
          });
          continue;
        }
        if (expected.contentSha256 !== fallback.contentSha256) {
          findings.push({
            package: expected.name,
            message: "reviewed package content does not match pinned SPDX-classified content",
          });
        }
        continue;
      }
      try {
        const text = await licenseText(packageRoot);
        const markers = LICENSE_MARKERS[expected.license];
        const normalized = normalizedLicenseText(text);
        if (
          markers === undefined ||
          !markers.every((marker) => normalized.includes(normalizedLicenseText(marker)))
        ) {
          findings.push({
            package: expected.name,
            message: `license text does not prove the pinned ${expected.license} classification`,
          });
        }
      } catch (error) {
        throw error;
      }
    } catch (error) {
      findings.push({
        package: expected.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.freeze(findings.map((finding) => Object.freeze(finding)));
}

export function renderThirdPartyNotices(): string {
  const rows = DISTRIBUTED_PACKAGE_LICENSES.map(({ name, version, license, contentSha256 }) =>
    `| ${name} | ${version} | ${license} | ${
      PINNED_SPDX_METADATA_FALLBACKS[`${name}@${version}`] === undefined
        ? `Reviewed package content sha256:${contentSha256} + package license file`
        : `[Pinned nonbundled package content + metadata + SPDX classification](${PINNED_SPDX_METADATA_FALLBACKS[`${name}@${version}`]!.source})`
    } | https://www.npmjs.com/package/${name} |`
  );
  return [
    "# Third-Party Notices",
    "",
    "PCBoo is an independent MIT-licensed project built on tscircuit. It is not an official tscircuit product and does not imply endorsement by or affiliation with tscircuit Inc.",
    "",
    "The following direct runtime, optional, and peer packages are declared by PCBoo but are not bundled into PCBoo's package tarball. Their own license terms remain in force. The normal package prepack boundary recursively accepts only reviewed MIT/SPDX-marked PCBoo TypeScript under src, reconciles its bare imports to this table, requires the exact qualified top-level inventory, complete PCBoo MIT text, this generated notice, and exact reviewed installed package content. The two explicit ISC fallbacks classify exact pinned nonbundled bytes using package metadata and SPDX, and are not represented as package-specific copyright notices.",
    "",
    "| Package | Pinned version | License | Evidence | Source |",
    "| --- | ---: | --- | --- | --- |",
    ...rows,
    "",
    "PCBoo's MIT license does not relicense user circuit source, vendored models or footprints, datasheets, or generated manufacturing artifacts. Those materials retain their respective ownership, provenance, and redistribution terms.",
    "",
  ].join("\n");
}

interface DistributionPackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly files?: unknown;
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly bundledDependencies?: unknown;
  readonly bundleDependencies?: unknown;
}

function requireStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string" || !version) throw new Error(`${label}.${name} must be a non-empty string`);
    result[name] = version;
  }
  return Object.freeze(result);
}

function sortedEntries(value: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
  return Object.freeze(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => Object.freeze([name, version] as const)),
  );
}

function requireExactFiles(actual: unknown, expected: readonly string[], packageName: string): void {
  if (!Array.isArray(actual) || actual.some((entry) => typeof entry !== "string")) {
    throw new Error(`${packageName} package files must be an explicit string array`);
  }
  const normalized = [...actual].sort();
  if (JSON.stringify(normalized) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${packageName} package files do not match the qualified distribution inventory`);
  }
}

function requireNoBundledDependencies(metadata: DistributionPackageMetadata, packageName: string): void {
  for (const value of [metadata.bundledDependencies, metadata.bundleDependencies]) {
    if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) {
      throw new Error(`${packageName} may not silently bundle dependency code`);
    }
  }
}

function barePackageName(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") || specifier.startsWith("/") ||
    specifier.startsWith("node:") || specifier.startsWith("bun:")
  ) return undefined;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function importedPackageNames(source: string, relativePath: string): readonly string[] {
  const names = new Set<string>();
  const moduleSpecifiers = new Set<string>();
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const addLiteral = (value: ts.Expression | undefined, kind: string): void => {
    if (value === undefined || !ts.isStringLiteralLike(value)) {
      throw new Error(`pcboo packaged source ${relativePath} uses non-literal ${kind}`);
    }
    moduleSpecifiers.add(value.text);
  };
  const isModuleLoaderBuiltin = (value: ts.Expression | undefined): boolean =>
    value !== undefined && ts.isStringLiteralLike(value) &&
    (value.text === "node:module" || value.text === "module");
  const forbidRuntimeLoader = (): never => {
    throw new Error(
      `pcboo packaged source ${relativePath} forbids runtime module loaders; use a static declared import`,
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addLiteral(node.moduleSpecifier, "import");
      if (isModuleLoaderBuiltin(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        if (
          clause?.name !== undefined ||
          (bindings !== undefined && ts.isNamespaceImport(bindings)) ||
          (bindings !== undefined && ts.isNamedImports(bindings) &&
            bindings.elements.some((item) =>
              (item.propertyName?.text ?? item.name.text) === "createRequire"
            ))
        ) forbidRuntimeLoader();
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addLiteral(node.moduleSpecifier, "export");
      if (
        isModuleLoaderBuiltin(node.moduleSpecifier) &&
        (node.exportClause === undefined ||
          (ts.isNamedExports(node.exportClause) && node.exportClause.elements.some((item) =>
            (item.propertyName?.text ?? item.name.text) === "createRequire"
          )))
      ) forbidRuntimeLoader();
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression, "import-equals");
      if (isModuleLoaderBuiltin(node.moduleReference.expression)) forbidRuntimeLoader();
    } else if (
      ts.isVariableDeclaration(node) && node.initializer !== undefined &&
      ts.isIdentifier(node.initializer) && node.initializer.text === "require"
    ) {
      forbidRuntimeLoader();
    } else if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.right) && node.right.text === "require"
    ) {
      forbidRuntimeLoader();
    } else if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "eval" || node.expression.text === "Function")
      ) forbidRuntimeLoader();
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isDirectRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isDirectRequire) {
        if (node.arguments.length !== 1) {
          throw new Error(`pcboo packaged source ${relativePath} uses invalid ${isDynamicImport ? "dynamic import" : "require"}`);
        }
        addLiteral(node.arguments[0], isDynamicImport ? "dynamic import" : "require");
        if (isModuleLoaderBuiltin(node.arguments[0])) forbidRuntimeLoader();
      }
    } else if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "require" &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) ||
      (ts.isElementAccessExpression(node) && ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword)
    ) {
      forbidRuntimeLoader();
    } else if (
      ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
      (node.expression.text === "globalThis" || node.expression.text === "process")
    ) {
      forbidRuntimeLoader();
    } else if (
      ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "process" && node.name.text === "getBuiltinModule"
    ) {
      forbidRuntimeLoader();
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "eval" || node.expression.text === "Function")
    ) {
      forbidRuntimeLoader();
    } else if (ts.isIdentifier(node) && node.text === "createRequire") {
      forbidRuntimeLoader();
    } else if (ts.isIdentifier(node) && node.text === "require") {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression === node)) {
        forbidRuntimeLoader();
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const specifier of moduleSpecifiers) {
    const name = barePackageName(specifier);
    if (name !== undefined) names.add(name);
  }
  return Object.freeze([...names].sort());
}

async function requireQualifiedPackagedSourceTree(
  sourceRoot: string,
  declaredPackages: ReadonlySet<string>,
  qualifiedJavaScriptLaunchers: ReadonlySet<string>,
): Promise<void> {
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_PACKAGED_SOURCE_DEPTH) {
      throw new Error(`pcboo packaged source exceeds ${MAX_PACKAGED_SOURCE_DEPTH} directory levels`);
    }
    const before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`pcboo packaged source directory is not a regular owned directory: ${prefix || "src"}`);
    }
    const handle = await opendir(directory);
    const names: string[] = [];
    try {
      for await (const entry of handle) {
        names.push(entry.name);
        if (names.length > MAX_PACKAGED_SOURCE_FILES) {
          throw new Error(`pcboo packaged source exceeds ${MAX_PACKAGED_SOURCE_FILES} entries`);
        }
      }
    } finally {
      try {
        await handle.close();
      } catch {
        // `for await` closes a fully consumed directory handle.
      }
    }
    names.sort();
    for (const name of names) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`pcboo packaged source contains symlink ${relativePath}`);
      if (stat.isDirectory()) {
        if (/^(?:vendor|third[-_]?party|external)$/iu.test(name)) {
          throw new Error(`pcboo packaged source contains unqualified third-party directory ${relativePath}`);
        }
        await walk(path, relativePath, depth + 1);
        continue;
      }
      const qualifiedPowerShell = relativePath === "internal/windows-job-runner.ps1";
      const qualifiedBunConfig = relativePath === "internal/empty-bunfig.toml";
      const qualifiedJavaScriptLauncher = qualifiedJavaScriptLaunchers.has(relativePath);
      if (
        !stat.isFile() ||
        (!name.endsWith(".ts") && !qualifiedPowerShell && !qualifiedBunConfig && !qualifiedJavaScriptLauncher)
      ) {
        throw new Error(`pcboo packaged source contains an unqualified non-TypeScript asset ${relativePath}`);
      }
      fileCount += 1;
      if (fileCount > MAX_PACKAGED_SOURCE_FILES) {
        throw new Error(`pcboo packaged source exceeds ${MAX_PACKAGED_SOURCE_FILES} files`);
      }
      if (stat.size > MAX_PACKAGED_SOURCE_FILE_BYTES) {
        throw new Error(`pcboo packaged source file exceeds ${MAX_PACKAGED_SOURCE_FILE_BYTES} bytes: ${relativePath}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_PACKAGED_SOURCE_TOTAL_BYTES) {
        throw new Error(`pcboo packaged source exceeds ${MAX_PACKAGED_SOURCE_TOTAL_BYTES} aggregate bytes`);
      }
      const source = decodeSourceUtf8(
        await readBoundedRegularFile(path, MAX_PACKAGED_SOURCE_FILE_BYTES),
        `packaged source ${relativePath}`,
      );
      const sourceLines = source.split(/\r?\n/u);
      const provenanceOffset = sourceLines[0]?.startsWith("#!") ? 1 : 0;
      const copyright = sourceLines[provenanceOffset];
      const license = sourceLines[provenanceOffset + 1];
      const hashComment = qualifiedPowerShell || qualifiedBunConfig;
      const expectedCopyright = hashComment
        ? PCBOO_SOURCE_COPYRIGHT.replace(/^\/\//u, "#")
        : PCBOO_SOURCE_COPYRIGHT;
      const expectedLicense = hashComment
        ? PCBOO_SOURCE_LICENSE.replace(/^\/\//u, "#")
        : PCBOO_SOURCE_LICENSE;
      if (copyright !== expectedCopyright || license !== expectedLicense) {
        throw new Error(`pcboo packaged source lacks reviewed PCBoo provenance headers: ${relativePath}`);
      }
      if (!qualifiedPowerShell && !qualifiedBunConfig) {
        for (const packageName of importedPackageNames(source, relativePath)) {
          if (!declaredPackages.has(packageName)) {
            throw new Error(`pcboo packaged source ${relativePath} imports unqualified package ${packageName}`);
          }
        }
      }
    }
    const after = await lstat(directory);
    if (
      after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev ||
      before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) throw new Error(`pcboo packaged source directory changed during prepack: ${prefix || "src"}`);
  };
  await walk(sourceRoot, "", 0);
  if (fileCount === 0) throw new Error("pcboo packaged source inventory is empty");
}

/**
 * Fail-closed prepack boundary for the two registry packages in this source
 * tree. It validates checked-in notice bytes and the installed direct package
 * evidence; it never rewrites source or downloads missing evidence.
 */
export async function requireDistributionPackageReady(options: {
  readonly packageRoot: string;
  readonly nodeModulesRoot?: string;
}): Promise<void> {
  requireSupportedBunRuntime();
  const packageRoot = await realpath(options.packageRoot);
  const metadata = JSON.parse(await boundedText(
    join(packageRoot, "package.json"),
    MAX_PACKAGE_METADATA_BYTES,
    "distribution package metadata",
  )) as DistributionPackageMetadata;
  if (metadata.name !== "pcboo" && metadata.name !== "create-pcboo") {
    throw new Error(`Unsupported distribution package ${String(metadata.name)}`);
  }
  const packageName = metadata.name;
  if (typeof metadata.version !== "string" || !metadata.version) {
    throw new Error(`${packageName} package version must be a non-empty string`);
  }
  if (metadata.license !== "MIT") throw new Error(`${packageName} package license must be MIT`);
  requireNoBundledDependencies(metadata, packageName);
  const ownLicense = await boundedText(join(packageRoot, "LICENSE"), MAX_LICENSE_BYTES, `${packageName} LICENSE`);
  if (ownLicense !== PCBOO_MIT_LICENSE_TEXT) {
    throw new Error(`${packageName} package must contain PCBoo's complete reviewed MIT license`);
  }

  const dependencies = requireStringMap(metadata.dependencies, `${packageName}.dependencies`);
  const optionalDependencies = requireStringMap(
    metadata.optionalDependencies,
    `${packageName}.optionalDependencies`,
  );
  const peers = requireStringMap(metadata.peerDependencies, `${packageName}.peerDependencies`);
  if (packageName === "create-pcboo") {
    requireExactFiles(metadata.files, CREATE_PCBOO_DISTRIBUTION_FILES, packageName);
    if (
      Object.keys(dependencies).length > 0 || Object.keys(optionalDependencies).length > 0 ||
      Object.keys(peers).length > 0
    ) {
      throw new Error("create-pcboo distribution dependencies require an explicit notice policy");
    }
    await requireQualifiedPackagedSourceTree(
      join(packageRoot, "src"),
      new Set(),
      new Set(["create-pcboo.js"]),
    );
    return;
  }

  requireExactFiles(metadata.files, PCBOO_DISTRIBUTION_FILES, packageName);
  const declared = { ...dependencies };
  for (const [field, entries] of [
    ["optionalDependencies", optionalDependencies],
    ["peerDependencies", peers],
  ] as const) {
    for (const [name, version] of Object.entries(entries)) {
      if (declared[name] !== undefined && declared[name] !== version) {
        throw new Error(`pcboo declares conflicting distribution versions for ${name} in ${field}`);
      }
      declared[name] = version;
    }
  }
  const noticed = Object.fromEntries(
    DISTRIBUTED_PACKAGE_LICENSES.map(({ name, version }) => [name, version]),
  ) as Record<string, string>;
  if (JSON.stringify(sortedEntries(declared)) !== JSON.stringify(sortedEntries(noticed))) {
    throw new Error("pcboo direct runtime, optional, and peer graph does not exactly match its qualified notice graph");
  }
  await requireQualifiedPackagedSourceTree(
    join(packageRoot, "src"),
    new Set(Object.keys(declared)),
    new Set(["cli/pcboo.js"]),
  );
  const checkedNotice = await boundedText(
    join(packageRoot, "THIRD_PARTY_NOTICES.md"),
    MAX_NOTICE_BYTES,
    "THIRD_PARTY_NOTICES.md",
  );
  if (checkedNotice !== renderThirdPartyNotices()) {
    throw new Error("THIRD_PARTY_NOTICES.md is stale relative to the qualified distribution graph");
  }
  const findings = await validateDistributionLicenses(
    options.nodeModulesRoot ?? join(packageRoot, "node_modules"),
  );
  if (findings.length > 0) {
    throw new AggregateError(
      findings.map(({ package: name, message }) => new Error(`${name}: ${message}`)),
      `Distribution licensing failed for ${findings.length} package${findings.length === 1 ? "" : "s"}`,
    );
  }
}
