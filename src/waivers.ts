// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildInputSnapshot } from "./artifacts/inputs";
import { defineDiagnostic, diagnosticId, type Diagnostic } from "./diagnostics";
import {
  STATUS_DIMENSIONS,
  assuranceStatus,
  statusSet,
  type StatusDimension,
  type StatusSet,
} from "./status";

export interface DeclaredWaiver {
  readonly diagnosticId: string;
  readonly dimension: Exclude<StatusDimension, "sourcing">;
  readonly scope: string;
  readonly justification: string;
  readonly expiresAt?: string;
  readonly declarationPath: string;
  readonly declarationIndex: number;
}

const loadedDeclarationSets = new WeakSet<object>();
const hasLoadedDeclarationSet = WeakSet.prototype.has.bind(loadedDeclarationSets);
const markLoadedDeclarationSet = WeakSet.prototype.add.bind(loadedDeclarationSets);

/** Identity check for declarations captured by Fulmetry's filesystem loader. */
export function isLoadedDeclaredWaiverSet(
  value: unknown,
): value is readonly Readonly<DeclaredWaiver>[] {
  return typeof value === "object" && value !== null && hasLoadedDeclarationSet(value);
}

export function isValidWaiverDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function waiverIdentity(waiver: Pick<
  DeclaredWaiver,
  "diagnosticId" | "dimension" | "scope" | "justification" | "expiresAt"
>): string {
  return JSON.stringify({
    diagnosticId: waiver.diagnosticId,
    dimension: waiver.dimension,
    scope: waiver.scope,
    justification: waiver.justification,
    expiresAt: waiver.expiresAt ?? null,
  });
}

export async function loadDeclaredWaivers(
  projectRoot: string,
  snapshot: BuildInputSnapshot,
): Promise<readonly Readonly<DeclaredWaiver>[]> {
  const declarations: DeclaredWaiver[] = [];
  for (const input of snapshot.inputs.filter(({ role }) => role === "waiver")) {
    if (input.size > 1024 * 1024) {
      throw new Error(`Waiver declaration exceeds 1 MiB: ${input.path}`);
    }
    const bytes = await readFile(join(projectRoot, ...input.path.split("/")));
    const exactSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== input.size || exactSha256 !== input.sha256) {
      throw new Error(`Waiver declaration bytes do not match the build snapshot: ${input.path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Waiver declaration is not valid JSON: ${input.path}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Waiver declaration must be an object: ${input.path}`);
    }
    const document = parsed as Record<string, unknown>;
    if (
      Object.keys(document).some((key) => key !== "schemaVersion" && key !== "waivers") ||
      document.schemaVersion !== 1 || !Array.isArray(document.waivers)
    ) {
      throw new Error(
        `Waiver declaration must contain only schemaVersion 1 and a waivers array: ${input.path}`,
      );
    }
    for (const [index, value] of document.waivers.entries()) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Waiver ${input.path}#${index} must be an object`);
      }
      const record = value as Record<string, unknown>;
      const allowed = new Set(["diagnosticId", "dimension", "scope", "justification", "expiresAt"]);
      if (Object.keys(record).some((key) => !allowed.has(key))) {
        throw new Error(`Waiver ${input.path}#${index} contains an unknown field`);
      }
      const dimension = record.dimension;
      if (
        typeof record.diagnosticId !== "string" ||
        !STATUS_DIMENSIONS.includes(dimension as StatusDimension) ||
        dimension === "sourcing" ||
        typeof record.scope !== "string" || !record.scope.trim() ||
        typeof record.justification !== "string" || !record.justification.trim() ||
        (record.expiresAt !== undefined &&
          (typeof record.expiresAt !== "string" || !isValidWaiverDate(record.expiresAt)))
      ) {
        throw new Error(`Waiver ${input.path}#${index} has invalid required fields`);
      }
      declarations.push(Object.freeze({
        diagnosticId: diagnosticId(record.diagnosticId),
        dimension: dimension as Exclude<StatusDimension, "sourcing">,
        scope: record.scope,
        justification: record.justification,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt as string }),
        declarationPath: input.path,
        declarationIndex: index,
      }));
    }
  }
  const identities = declarations.map(waiverIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Source-controlled waiver declarations contain an exact duplicate");
  }
  const loaded = Object.freeze(declarations);
  markLoadedDeclarationSet(loaded);
  return loaded;
}

export function applyDeclaredWaivers(options: {
  readonly diagnostics: readonly Diagnostic[];
  readonly statuses: Readonly<StatusSet>;
  readonly declarations: readonly Readonly<DeclaredWaiver>[];
  readonly evaluationDate: string;
}): Readonly<{
  diagnostics: readonly Readonly<Diagnostic>[];
  statuses: Readonly<StatusSet>;
}> {
  if (!isValidWaiverDate(options.evaluationDate)) {
    throw new TypeError("Waiver evaluation date must be an exact UTC calendar date");
  }
  const used = new Set<DeclaredWaiver>();
  const diagnostics: Diagnostic[] = [];
  for (const diagnostic of options.diagnostics) {
    const matchingScopes = new Set(options.declarations.filter((waiver) =>
      waiver.diagnosticId === diagnostic.id && waiver.dimension === diagnostic.dimension &&
      diagnostic.objects.includes(waiver.scope)
    ).map(({ scope }) => scope));
    const occurrences = matchingScopes.size === 0 || diagnostic.objects.length <= 1
      ? [diagnostic]
      : diagnostic.objects.map((object) => defineDiagnostic({
          ...diagnostic,
          objects: [object],
          omittedObjectCount: 0,
        }));
    for (const occurrence of occurrences) {
      const scope = occurrence.objects.length === 1 ? occurrence.objects[0] : undefined;
      const matches = scope === undefined ? [] : options.declarations.filter((waiver) =>
        waiver.diagnosticId === occurrence.id && waiver.dimension === occurrence.dimension &&
        waiver.scope === scope
      );
      if (matches.length === 0) {
        diagnostics.push(occurrence);
        continue;
      }
      if (matches.length !== 1) {
        throw new Error(`Waiver ${occurrence.id} scope ${scope} is declared more than once`);
      }
      const waiver = matches[0]!;
      if (occurrence.waiverPolicy !== "allowed") {
        throw new Error(`Waiver ${occurrence.id} scope ${scope} targets a non-waivable diagnostic`);
      }
      if ((diagnostic.omittedObjectCount ?? 0) > 0) {
        throw new Error(`Waiver ${occurrence.id} cannot resolve diagnostics with omitted scopes`);
      }
      if (waiver.expiresAt !== undefined && waiver.expiresAt < options.evaluationDate) {
        throw new Error(`Waiver ${occurrence.id} scope ${scope} expired on ${waiver.expiresAt}`);
      }
      used.add(waiver);
      diagnostics.push(defineDiagnostic({
        ...occurrence,
        disposition: "waived",
        resolution: {
          scope: waiver.scope,
          justification: waiver.justification,
          ...(waiver.expiresAt === undefined ? {} : { expiresAt: waiver.expiresAt }),
        },
        evidence: [
          ...(occurrence.evidence ?? []),
          `waiver:${waiver.declarationPath}#${waiver.declarationIndex}`,
          `waiver-evaluation-date:${options.evaluationDate}`,
        ],
      }));
    }
  }
  const unused = options.declarations.filter((waiver) => !used.has(waiver));
  if (unused.length > 0) {
    const waiver = unused[0]!;
    throw new Error(
      `Waiver ${waiver.diagnosticId} scope ${waiver.scope} does not match one active diagnostic occurrence`,
    );
  }

  const resolvedStatuses = Object.fromEntries(STATUS_DIMENSIONS.map((dimension) => {
    const original = options.statuses[dimension];
    if (dimension === "sourcing") return [dimension, original];
    const evidence = diagnostics.filter((diagnostic) =>
      diagnostic.dimension === dimension && original.diagnosticIds.includes(diagnostic.id)
    );
    const waived = evidence.filter(({ disposition }) => disposition === "waived");
    if (waived.length === 0) return [dimension, original];
    const activeNonpassing = evidence.some((diagnostic) =>
      diagnostic.disposition === "active" &&
      (diagnostic.severity === "error" || diagnostic.severity === "warning")
    );
    if (activeNonpassing) return [dimension, original];
    return [dimension, assuranceStatus(dimension, "passed-with-waivers", {
      diagnosticIds: waived.map(({ id }) => id),
      summary: `${waived.length} narrowly scoped source-controlled waiver(s) applied`,
    })];
  })) as unknown as StatusSet;
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    statuses: statusSet(resolvedStatuses),
  });
}
