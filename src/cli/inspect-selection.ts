// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import {
  defineDiagnostic,
  diagnosticId,
  type Diagnostic,
} from "../diagnostics";
import type { StatusDimension } from "../status";

export interface InspectDiagnosticFilters {
  readonly target?: string;
  readonly status?: StatusDimension;
  readonly rule?: string;
}

export interface InspectDiagnosticSelection {
  readonly diagnostics: readonly Diagnostic[];
  readonly forcedFailure: boolean;
}

/**
 * Adds globally visible resolution evidence without letting that unrelated
 * evidence satisfy a focused target or rule query.
 */
export function completeInspectDiagnosticSelection(
  sourceDiagnostics: readonly Diagnostic[],
  focusedDiagnostics: readonly Diagnostic[],
  filters: InspectDiagnosticFilters,
  targetObjectMatched: boolean,
): InspectDiagnosticSelection {
  const hadFocusedMatch = focusedDiagnostics.length > 0;
  const diagnostics = [...focusedDiagnostics];

  for (const diagnostic of sourceDiagnostics) {
    if (
      diagnostic.disposition !== "active" &&
      !diagnostics.some(({ id }) => id === diagnostic.id)
    ) diagnostics.push(diagnostic);
  }

  if (filters.target !== undefined && !targetObjectMatched && !hadFocusedMatch) {
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("INSPECT_TARGET_NOT_FOUND_001"),
      severity: "error",
      dimension: filters.status ?? "electrical",
      message: `No circuit object or active diagnostic matches ${filters.target}`,
      waiverPolicy: "forbidden",
      objects: [filters.target],
      sourceLocations: [],
    }));
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), forcedFailure: true });
  }

  if (filters.rule !== undefined && !hadFocusedMatch) {
    diagnostics.push(defineDiagnostic({
      id: diagnosticId("INSPECT_RULE_NOT_ACTIVE_001"),
      severity: "info",
      dimension: filters.status ?? "electrical",
      message: `No active diagnostic matches ${filters.rule}`,
      waiverPolicy: "forbidden",
      objects: [],
      sourceLocations: [],
    }));
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), forcedFailure: true });
  }

  return Object.freeze({ diagnostics: Object.freeze(diagnostics), forcedFailure: false });
}
