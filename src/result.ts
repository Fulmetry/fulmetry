// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import {
  defineDiagnostic,
  formatCompactDiagnostic,
  type Diagnostic,
} from "./diagnostics";
import {
  isAssurancePassing,
  STATUS_DIMENSIONS,
  statusSet,
  statusEntries,
  type StatusDimension,
  type StatusSet,
} from "./status";
import type { RecordedSourcingEvidence } from "./sourcing";

export const RESULT_SCHEMA_VERSION = "1" as const;

export type ExitClassification =
  | "success"
  | "failure"
  | "warning-only"
  | "unavailable"
  | "incomplete"
  | "cancelled"
  | "unsupported";

const EXIT_CLASSIFICATIONS: readonly ExitClassification[] = [
  "success",
  "failure",
  "warning-only",
  "unavailable",
  "incomplete",
  "cancelled",
  "unsupported",
];

export interface ArtifactReference {
  readonly kind: string;
  readonly path: string;
  readonly digest?: string;
}

export interface ProjectResultContext {
  readonly networkPolicy: "default" | "offline";
  readonly projectDigest: string;
  readonly entry: string;
  readonly sourceDigest: string;
  readonly configDigest: string;
  readonly lockDigest: string;
  readonly tscircuit: {
    readonly version: string;
    readonly integrity: string;
    readonly contentSha256: string;
    readonly runtimeClosureSha256: string;
  };
}

export interface CommandResult {
  readonly schemaVersion: typeof RESULT_SCHEMA_VERSION;
  readonly command: string;
  readonly runId: string;
  /** Outcome of the requested command, never an aggregate board-ready signal. */
  readonly exitClassification: ExitClassification;
  /** Status dimensions the command claims to have evaluated. */
  readonly requestedDimensions: readonly StatusDimension[];
  readonly statuses: StatusSet;
  readonly diagnostics: readonly Diagnostic[];
  readonly artifacts: readonly ArtifactReference[];
  readonly sourcingEvidence?: RecordedSourcingEvidence;
  readonly project?: ProjectResultContext;
}

export function commandResult(
  result: Omit<CommandResult, "schemaVersion" | "diagnostics" | "artifacts"> & {
    readonly diagnostics?: readonly Diagnostic[];
    readonly artifacts?: readonly ArtifactReference[];
  },
): Readonly<CommandResult> {
  if (!result.command.trim() || !result.runId.trim()) {
    throw new TypeError("Command and runId must be non-empty strings");
  }
  if (!EXIT_CLASSIFICATIONS.includes(result.exitClassification)) {
    throw new TypeError(
      `Unknown exit classification: ${String(result.exitClassification)}`,
    );
  }

  const requestedDimensions = [...result.requestedDimensions];
  if (
    requestedDimensions.some(
      (dimension) => !STATUS_DIMENSIONS.includes(dimension),
    )
  ) {
    throw new TypeError("Command result contains an unknown requested dimension");
  }
  if (new Set(requestedDimensions).size !== requestedDimensions.length) {
    throw new TypeError("Command result contains duplicate requested dimensions");
  }

  const statuses = statusSet(result.statuses);
  const diagnostics = (result.diagnostics ?? []).map((diagnostic) =>
    defineDiagnostic(diagnostic)
  );
  const diagnosticsById = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const occurrences = diagnosticsById.get(diagnostic.id) ?? [];
    if (occurrences.some(({ dimension }) => dimension !== diagnostic.dimension)) {
      throw new TypeError(
        `Command result reuses diagnostic ${diagnostic.id} across status dimensions`,
      );
    }
    occurrences.push(diagnostic);
    diagnosticsById.set(diagnostic.id, occurrences);
  }
  for (const dimension of STATUS_DIMENSIONS) {
    for (const id of statuses[dimension].diagnosticIds) {
      const occurrences = diagnosticsById.get(id);
      if (
        occurrences === undefined ||
        !occurrences.some((diagnostic) => diagnostic.dimension === dimension)
      ) {
        throw new TypeError(
          `${dimension} status references diagnostic ${id} without matching evidence in that dimension`,
        );
      }
    }
  }
  const artifacts = (result.artifacts ?? []).map((artifact) => {
    if (!artifact.kind.trim() || !artifact.path.trim()) {
      throw new TypeError("Artifact references require non-empty kind and path");
    }
    return Object.freeze({ ...artifact });
  });
  if (
    result.sourcingEvidence !== undefined &&
    statuses.sourcing.checkedAt !== result.sourcingEvidence.checkedAt
  ) {
    throw new TypeError("Sourcing status and evidence must share one evaluation instant");
  }
  const project = result.project === undefined
    ? undefined
    : Object.freeze({
      ...result.project,
      tscircuit: Object.freeze({ ...result.project.tscircuit }),
    });
  if (
    result.exitClassification === "success" ||
    result.exitClassification === "warning-only"
  ) {
    for (const dimension of requestedDimensions) {
      const passing = dimension === "sourcing"
        ? statuses.sourcing.state === "available" ||
          statuses.sourcing.state === "constrained"
        : isAssurancePassing(statuses[dimension]);
      if (!passing) {
        const state = statuses[dimension].state;
        throw new TypeError(
          `${result.exitClassification} ${result.command} result cannot contain requested ${dimension} status ${state}`,
        );
      }
    }
  }
  for (const dimension of ["fabrication", "electrical", "functional", "standards"] as const) {
    const status = statuses[dimension];
    if (status.state !== "passed-with-waivers") continue;
    for (const id of status.diagnosticIds) {
      const occurrences = diagnosticsById.get(id) ?? [];
      if (!occurrences.some(({ disposition }) => disposition !== "active")) {
        throw new TypeError(
          `passed-with-waivers ${dimension} status requires waived or suppressed evidence for ${id}`,
        );
      }
    }
  }
  if (
    result.exitClassification === "success" ||
    result.exitClassification === "warning-only"
  ) {
    const activeRequestedError = diagnostics.find((diagnostic) =>
      requestedDimensions.includes(diagnostic.dimension) &&
      diagnostic.disposition === "active" &&
      diagnostic.severity === "error"
    );
    if (activeRequestedError !== undefined) {
      throw new TypeError(
        `${result.exitClassification} ${result.command} result cannot contain active requested-dimension error ${activeRequestedError.id}`,
      );
    }
  }
  const requestedDiagnostics = diagnostics.filter((diagnostic) =>
    requestedDimensions.includes(diagnostic.dimension)
  );
  if (result.exitClassification === "success") {
    const warningEvidence = requestedDiagnostics.find((diagnostic) =>
      diagnostic.severity === "warning" || diagnostic.disposition !== "active"
    );
    const waivedStatus = requestedDimensions.find((dimension) =>
      dimension !== "sourcing" && statuses[dimension].state === "passed-with-waivers"
    );
    const constrainedSourcing = requestedDimensions.includes("sourcing") &&
      statuses.sourcing.state === "constrained";
    if (warningEvidence !== undefined || waivedStatus !== undefined || constrainedSourcing) {
      throw new TypeError(
        `A successful ${result.command} result cannot hide requested warning or waiver evidence`,
      );
    }
  }
  if (result.exitClassification === "warning-only") {
    const hasWarningEvidence = requestedDiagnostics.some((diagnostic) =>
      diagnostic.severity === "warning" || diagnostic.disposition !== "active"
    ) || requestedDimensions.some((dimension) =>
      dimension !== "sourcing" && statuses[dimension].state === "passed-with-waivers"
    ) || (requestedDimensions.includes("sourcing") && statuses.sourcing.state === "constrained");
    if (!hasWarningEvidence) {
      throw new TypeError(
        `warning-only ${result.command} result requires requested warning or waiver evidence`,
      );
    }
  }

  return Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    ...result,
    requestedDimensions: Object.freeze(requestedDimensions),
    statuses,
    diagnostics: Object.freeze(diagnostics),
    artifacts: Object.freeze(artifacts),
    ...(project === undefined ? {} : { project }),
  });
}

export function formatCompactResult(result: CommandResult): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of result.diagnostics) {
    counts[diagnostic.severity] += 1;
  }

  const lines = [
    `${result.exitClassification.toUpperCase()} ${result.command}: ${counts.error} errors, ${counts.warning} warnings`,
    "",
    ...statusEntries(result.statuses).map(
      (status) => `${status.dimension}: ${status.state}`,
    ),
  ];

  if (result.diagnostics.length > 0) {
    lines.push("", result.diagnostics.map(formatCompactDiagnostic).join("\n\n"));
  }

  return lines.join("\n");
}
