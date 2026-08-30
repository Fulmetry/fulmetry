// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

/**
 * Parse the bounded internal-detail selector grammar emitted by Fulmetry's own
 * deterministic assessors. The head is an exact circuit object selector;
 * details are non-empty, colon-separated, whitespace-free tokens.
 */
export function internalDiagnosticObjectHead(selector: string): string | undefined {
  return /^([^\s:.]+):[^\s:]+(?::[^\s:]+)*$/u.exec(selector)?.[1];
}

export function componentReferenceDiagnosticObjectHead(
  selector: string,
): string | undefined {
  return /^([^\s:.]+)\.reference$/u.exec(selector)?.[1];
}

export function diagnosticObjectMatchesTarget(
  selector: string,
  target: string,
): boolean {
  return selector === target || internalDiagnosticObjectHead(selector) === target ||
    componentReferenceDiagnosticObjectHead(selector) === target;
}
