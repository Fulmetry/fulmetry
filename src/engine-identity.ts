// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import compatibilityAnchor from "../compatibility/tscircuit.json";
import {
  fingerprintEnginePackage,
  fingerprintInstalledPackageClosure,
  readStableEnginePackageFile,
} from "./engine-package-fingerprint";
import { resolveTscircuitEntryFresh } from "./internal/fresh-package-entry";

export const EXPECTED_TSCIRCUIT_VERSION = "0.0.2261" as const;
export const EXPECTED_TSCIRCUIT_CONTENT_SHA256 =
  "c0880767e6967a6b7f8423604882ba6989d9a58108355b3835f48309f09cf487" as const;

export const QUALIFIED_TSCIRCUIT_RUNTIME_CLOSURES = Object.freeze(Object.fromEntries(
  Object.entries(compatibilityAnchor.runtimeClosures).map(([platform, profiles]) => [
    platform,
    Object.freeze([profiles.repository, profiles.packedConsumer]),
  ]),
));

export type EngineIdentityIssueCode =
  | "TSCIRCUIT_UNAVAILABLE"
  | "TSCIRCUIT_PACKAGE_INVALID"
  | "TSCIRCUIT_VERSION_MISMATCH"
  | "TSCIRCUIT_CONTENT_MISMATCH"
  | "TSCIRCUIT_RUNTIME_CLOSURE_UNQUALIFIED"
  | "TSCIRCUIT_DUPLICATE_ENGINE";

export interface EngineIdentityIssue {
  readonly code: EngineIdentityIssueCode;
  readonly message: string;
  readonly scope?: "project" | "pcboo";
}

export interface TscircuitEngineLocation {
  readonly entryPath: string;
  readonly packageRoot: string;
  readonly version: string;
  readonly contentSha256: string;
  readonly runtimeClosureSha256: string;
}

export interface TscircuitIdentityReport {
  readonly compatible: boolean;
  readonly expectedVersion: string;
  readonly project?: TscircuitEngineLocation;
  readonly pcboo?: TscircuitEngineLocation;
  readonly issues: readonly EngineIdentityIssue[];
}

export interface InspectTscircuitIdentityOptions {
  readonly projectRoot: string;
  readonly pcbooRoot?: string;
  readonly expectedVersion?: string;
  readonly expectedContentSha256?: string;
  readonly expectedRuntimeClosureSha256?: readonly string[];
}

export async function fingerprintTscircuitPackage(packageRoot: string): Promise<string> {
  return fingerprintEnginePackage(packageRoot);
}

/** Package-owned bytes only, used for direct distribution-license review pins. */
export async function fingerprintPackageContent(packageRoot: string): Promise<string> {
  return fingerprintEnginePackage(packageRoot);
}

async function findPackageRoot(entryPath: string): Promise<string> {
  let candidate = dirname(entryPath);

  while (true) {
    const packageJsonPath = join(candidate, "package.json");
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await readStableEnginePackageFile(packageJsonPath),
      )) as {
        name?: unknown;
      };
      if (parsed.name === "tscircuit") return await realpath(candidate);
    } catch {
      // Continue upward. A package boundary is proven by its own package.json.
    }

    const parent = dirname(candidate);
    if (parent === candidate || parse(candidate).root === candidate) {
      throw new Error(`Could not locate the tscircuit package for ${entryPath}`);
    }
    candidate = parent;
  }
}

async function resolveEngine(from: string): Promise<TscircuitEngineLocation> {
  const entryPath = await resolveTscircuitEntryFresh(from);
  const packageRoot = await findPackageRoot(entryPath);
  const packageJsonPath = join(packageRoot, "package.json");
  const metadataBefore = await readStableEnginePackageFile(packageJsonPath);
  const packageJson = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(metadataBefore),
  ) as { name?: unknown; version?: unknown };

  if (
    packageJson.name !== "tscircuit" ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error(`Invalid tscircuit package metadata at ${packageRoot}`);
  }

  const contentSha256 = await fingerprintTscircuitPackage(packageRoot);
  const runtimeClosureSha256 = await fingerprintInstalledPackageClosure(packageRoot, {
    entryPath,
    resolutionOrigin: from,
  });
  const metadataAfter = await readStableEnginePackageFile(packageJsonPath);
  if (!Buffer.from(metadataBefore).equals(metadataAfter)) {
    throw new Error(`tscircuit package metadata changed during identity inspection at ${packageRoot}`);
  }

  return Object.freeze({
    entryPath,
    packageRoot,
    version: packageJson.version,
    contentSha256,
    runtimeClosureSha256,
  });
}

async function resolveEngineReference(from: string): Promise<Readonly<{
  entryPath: string;
  packageRoot: string;
}>> {
  const entryPath = await resolveTscircuitEntryFresh(from);
  return Object.freeze({ entryPath, packageRoot: await findPackageRoot(entryPath) });
}

export async function inspectTscircuitIdentity(
  options: InspectTscircuitIdentityOptions,
): Promise<Readonly<TscircuitIdentityReport>> {
  const expectedVersion = options.expectedVersion ?? EXPECTED_TSCIRCUIT_VERSION;
  const expectedContentSha256 = options.expectedContentSha256 ??
    EXPECTED_TSCIRCUIT_CONTENT_SHA256;
  const platformRuntimeClosures = QUALIFIED_TSCIRCUIT_RUNTIME_CLOSURES[
    `${process.platform}-${process.arch}` as keyof typeof QUALIFIED_TSCIRCUIT_RUNTIME_CLOSURES
  ];
  const expectedRuntimeClosures = options.expectedRuntimeClosureSha256 ??
    (options.expectedContentSha256 === undefined ? platformRuntimeClosures ?? [] : []);
  const pcbooRoot =
    options.pcbooRoot ?? fileURLToPath(new URL(".", import.meta.url));
  const issues: EngineIdentityIssue[] = [];
  let project: TscircuitEngineLocation | undefined;
  let pcboo: TscircuitEngineLocation | undefined;

  let projectReference: Awaited<ReturnType<typeof resolveEngineReference>> | undefined;
  let pcbooReference: Awaited<ReturnType<typeof resolveEngineReference>> | undefined;
  try {
    projectReference = await resolveEngineReference(options.projectRoot);
  } catch (error) {
    issues.push({
      code: "TSCIRCUIT_UNAVAILABLE",
      scope: "project",
      message: `project cannot resolve tscircuit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  try {
    pcbooReference = await resolveEngineReference(pcbooRoot);
  } catch (error) {
    issues.push({
      code: "TSCIRCUIT_UNAVAILABLE",
      scope: "pcboo",
      message: `pcboo cannot resolve tscircuit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  if (projectReference !== undefined && pcbooReference !== undefined) {
    if (projectReference.packageRoot === pcbooReference.packageRoot) {
      try {
        project = await resolveEngine(options.projectRoot);
        const [projectAfter, pcbooAfter] = await Promise.all([
          resolveEngineReference(options.projectRoot),
          resolveEngineReference(pcbooRoot),
        ]);
        if (
          projectAfter.entryPath !== projectReference.entryPath ||
          projectAfter.packageRoot !== projectReference.packageRoot ||
          pcbooAfter.entryPath !== pcbooReference.entryPath ||
          pcbooAfter.packageRoot !== pcbooReference.packageRoot
        ) throw new Error("tscircuit resolution changed during identity inspection");
        pcboo = Object.freeze({ ...project, entryPath: pcbooReference.entryPath });
      } catch (error) {
        project = undefined;
        issues.push({
          code: "TSCIRCUIT_UNAVAILABLE",
          scope: "project",
          message: `project cannot authenticate tscircuit: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    } else {
      try {
        project = await resolveEngine(options.projectRoot);
      } catch (error) {
        issues.push({
          code: "TSCIRCUIT_UNAVAILABLE",
          scope: "project",
          message: `project cannot authenticate tscircuit: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      try {
        pcboo = await resolveEngine(pcbooRoot);
      } catch (error) {
        issues.push({
          code: "TSCIRCUIT_UNAVAILABLE",
          scope: "pcboo",
          message: `pcboo cannot authenticate tscircuit: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }
  for (const [scope, engine] of [
    ["project", project],
    ["pcboo", pcboo],
  ] as const) {
    if (engine !== undefined && engine.version !== expectedVersion) {
      issues.push({
        code: "TSCIRCUIT_VERSION_MISMATCH",
        scope,
        message: `${scope} resolved tscircuit ${engine.version}; PCBoo requires ${expectedVersion}`,
      });
    }
    if (engine !== undefined && engine.contentSha256 !== expectedContentSha256) {
      issues.push({
        code: "TSCIRCUIT_CONTENT_MISMATCH",
        scope,
        message: `${scope} resolved tscircuit content ${engine.contentSha256}; PCBoo requires ${expectedContentSha256}`,
      });
    }
    if (
      engine !== undefined && expectedRuntimeClosures.length > 0 &&
      !expectedRuntimeClosures.includes(engine.runtimeClosureSha256)
    ) {
      issues.push({
        code: "TSCIRCUIT_RUNTIME_CLOSURE_UNQUALIFIED",
        scope,
        message:
          `${scope} resolved tscircuit runtime closure ${engine.runtimeClosureSha256}; ` +
          `PCBoo has not qualified that dependency graph on ${process.platform}-${process.arch}`,
      });
    }
    if (engine !== undefined && expectedRuntimeClosures.length === 0 && options.expectedContentSha256 === undefined) {
      issues.push({
        code: "TSCIRCUIT_RUNTIME_CLOSURE_UNQUALIFIED",
        scope,
        message: `PCBoo has no qualified tscircuit runtime closure for ${process.platform}-${process.arch}`,
      });
    }
  }

  if (
    project !== undefined &&
    pcboo !== undefined &&
    project.packageRoot !== pcboo.packageRoot
  ) {
    issues.push({
      code: "TSCIRCUIT_DUPLICATE_ENGINE",
      message:
        `Project and PCBoo resolved different tscircuit package roots: ` +
        `${project.packageRoot} and ${pcboo.packageRoot}`,
    });
  }

  return Object.freeze({
    compatible: issues.length === 0,
    expectedVersion,
    ...(project === undefined ? {} : { project }),
    ...(pcboo === undefined ? {} : { pcboo }),
    issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
  });
}

export async function requireTscircuitIdentity(
  options: InspectTscircuitIdentityOptions,
): Promise<Readonly<TscircuitIdentityReport>> {
  const report = await inspectTscircuitIdentity(options);
  if (!report.compatible) {
    throw new Error(report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  }
  return report;
}
