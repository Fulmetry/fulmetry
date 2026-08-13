// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { STATUS_DIMENSIONS, type StatusDimension } from "./status";

declare const diagnosticIdBrand: unique symbol;

export type DiagnosticId = string & {
  readonly [diagnosticIdBrand]: true;
};

export type DiagnosticSeverity = "error" | "warning" | "info";
export type DiagnosticDisposition = "active" | "waived" | "suppressed";
export type DiagnosticWaiverPolicy = "allowed" | "forbidden";

const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info"] as const;
const DIAGNOSTIC_DISPOSITIONS = ["active", "waived", "suppressed"] as const;
const DIAGNOSTIC_WAIVER_POLICIES = ["allowed", "forbidden"] as const;

export interface DiagnosticMeasurement {
  readonly actual: string;
  readonly required?: string;
}

export interface DiagnosticResolution {
  readonly justification: string;
  readonly scope: string;
  readonly expiresAt?: string;
}

export interface Diagnostic {
  readonly id: DiagnosticId;
  readonly severity: DiagnosticSeverity;
  readonly dimension: StatusDimension;
  readonly message: string;
  readonly waiverPolicy: DiagnosticWaiverPolicy;
  readonly disposition: DiagnosticDisposition;
  readonly objects: readonly string[];
  readonly sourceLocations: readonly string[];
  readonly measurement?: DiagnosticMeasurement;
  readonly layers?: readonly string[];
  readonly profile?: string;
  readonly evidence?: readonly string[];
  readonly omittedMessageCharacterCount?: number;
  readonly omittedObjectCount?: number;
  readonly omittedSourceLocationCount?: number;
  readonly omittedEvidenceCount?: number;
  readonly nextCommand?: string;
  readonly resolution?: DiagnosticResolution;
}

const DIAGNOSTIC_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+_\d{3,}$/;
export const DIAGNOSTIC_REFERENCE_LIMIT = 256;
export const DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT = 4_096;
export const DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT = 8_192;

export function diagnosticId(value: string): DiagnosticId {
  if (!DIAGNOSTIC_ID_PATTERN.test(value)) {
    throw new TypeError(
      `Invalid diagnostic id "${value}"; expected a stable identifier such as PCB_CLEARANCE_001`,
    );
  }

  return value as DiagnosticId;
}

export function defineDiagnostic(
  diagnostic: Omit<Diagnostic, "objects" | "sourceLocations" | "disposition"> & {
    readonly objects?: readonly string[];
    readonly sourceLocations?: readonly string[];
    readonly disposition?: DiagnosticDisposition;
  },
): Readonly<Diagnostic> {
  const id = diagnosticId(String(diagnostic.id));
  if (!DIAGNOSTIC_SEVERITIES.includes(diagnostic.severity)) {
    throw new TypeError(`Unknown diagnostic severity: ${String(diagnostic.severity)}`);
  }
  if (!STATUS_DIMENSIONS.includes(diagnostic.dimension)) {
    throw new TypeError(`Unknown diagnostic dimension: ${String(diagnostic.dimension)}`);
  }
  if (!DIAGNOSTIC_WAIVER_POLICIES.includes(diagnostic.waiverPolicy)) {
    throw new TypeError(`Unknown diagnostic waiver policy: ${String(diagnostic.waiverPolicy)}`);
  }
  const disposition = diagnostic.disposition ?? "active";
  if (!DIAGNOSTIC_DISPOSITIONS.includes(disposition)) {
    throw new TypeError(`Unknown diagnostic disposition: ${String(disposition)}`);
  }
  if (!diagnostic.message.trim()) {
    throw new TypeError("Diagnostic message cannot be empty");
  }
  if (
    !Number.isSafeInteger(diagnostic.omittedMessageCharacterCount ?? 0) ||
    (diagnostic.omittedMessageCharacterCount ?? 0) < 0
  ) throw new TypeError("Diagnostic omitted-message count must be a non-negative safe integer");
  const messageWasTruncated = diagnostic.message.length > DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT;
  const message = messageWasTruncated
    ? `${diagnostic.message.slice(0, DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT - 1)}…`
    : diagnostic.message;
  const omittedMessageCharacterCount = (diagnostic.omittedMessageCharacterCount ?? 0) +
    (messageWasTruncated
      ? diagnostic.message.length - (DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT - 1)
      : 0);
  if (!Number.isSafeInteger(omittedMessageCharacterCount)) {
    throw new TypeError("Diagnostic omitted-message count overflowed a safe integer");
  }
  const inputObjects = diagnostic.objects ?? [];
  const inputSourceLocations = diagnostic.sourceLocations ?? [];
  const inputEvidence = diagnostic.evidence ?? [];
  const hasInvalidReference = (values: readonly string[]): boolean =>
    values.some((value) =>
      typeof value !== "string" || value.length === 0 ||
      value.length > DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT
    );
  if (
    hasInvalidReference(inputObjects) || hasInvalidReference(inputSourceLocations) ||
    hasInvalidReference(inputEvidence)
  ) {
    throw new TypeError(
      `Diagnostic references must be non-empty strings of at most ${DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT} characters`,
    );
  }
  const declaredOmissions = [
    diagnostic.omittedObjectCount ?? 0,
    diagnostic.omittedSourceLocationCount ?? 0,
    diagnostic.omittedEvidenceCount ?? 0,
  ];
  if (declaredOmissions.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Diagnostic omitted-reference counts must be non-negative safe integers");
  }
  const objects = [...inputObjects.slice(0, DIAGNOSTIC_REFERENCE_LIMIT)];
  const sourceLocations = [...inputSourceLocations.slice(0, DIAGNOSTIC_REFERENCE_LIMIT)];
  const evidence = [...inputEvidence.slice(0, DIAGNOSTIC_REFERENCE_LIMIT)];
  const omittedObjectCount = declaredOmissions[0]! + inputObjects.length - objects.length;
  const omittedSourceLocationCount = declaredOmissions[1]! +
    inputSourceLocations.length - sourceLocations.length;
  const omittedEvidenceCount = declaredOmissions[2]! + inputEvidence.length - evidence.length;
  if (
    !Number.isSafeInteger(omittedObjectCount) ||
    !Number.isSafeInteger(omittedSourceLocationCount) ||
    !Number.isSafeInteger(omittedEvidenceCount)
  ) throw new TypeError("Diagnostic omitted-reference count overflowed a safe integer");

  const resolved = disposition === "waived" || disposition === "suppressed";
  if (resolved && diagnostic.waiverPolicy !== "allowed") {
    throw new TypeError(
      `Diagnostic ${id} is non-waivable and cannot be ${disposition}`,
    );
  }
  if (resolved && diagnostic.resolution === undefined) {
    throw new TypeError(
      `A ${disposition} diagnostic requires scope and justification`,
    );
  }
  if (diagnostic.resolution !== undefined && !resolved) {
    throw new TypeError(
      "Resolution details are only valid for a waived or suppressed diagnostic",
    );
  }
  if (
    diagnostic.resolution !== undefined &&
    (!diagnostic.resolution.scope.trim() ||
      !diagnostic.resolution.justification.trim())
  ) {
    throw new TypeError("Diagnostic resolution scope and justification cannot be empty");
  }

  const {
    objects: _objects,
    sourceLocations: _sourceLocations,
    evidence: _evidence,
    omittedMessageCharacterCount: _omittedMessageCharacterCount,
    omittedObjectCount: _omittedObjectCount,
    omittedSourceLocationCount: _omittedSourceLocationCount,
    omittedEvidenceCount: _omittedEvidenceCount,
    ...base
  } = diagnostic;
  return Object.freeze({
    ...base,
    id,
    message,
    disposition,
    objects: Object.freeze(objects),
    sourceLocations: Object.freeze(sourceLocations),
    ...(omittedMessageCharacterCount === 0 ? {} : { omittedMessageCharacterCount }),
    ...(omittedObjectCount === 0 ? {} : { omittedObjectCount }),
    ...(omittedSourceLocationCount === 0 ? {} : { omittedSourceLocationCount }),
    ...(omittedEvidenceCount === 0 ? {} : { omittedEvidenceCount }),
    ...(diagnostic.measurement === undefined
      ? {}
      : { measurement: Object.freeze({ ...diagnostic.measurement }) }),
    ...(diagnostic.resolution === undefined
      ? {}
      : { resolution: Object.freeze({ ...diagnostic.resolution }) }),
    ...(diagnostic.layers === undefined
      ? {}
      : { layers: Object.freeze([...diagnostic.layers]) }),
    ...(diagnostic.evidence === undefined && omittedEvidenceCount === 0
      ? {}
      : { evidence: Object.freeze(evidence) }),
  });
}

export function formatCompactDiagnostic(diagnostic: Diagnostic): string {
  const severity =
    diagnostic.severity === "error"
      ? "E"
      : diagnostic.severity === "warning"
        ? "W"
        : "I";
  const location = diagnostic.sourceLocations[0];
  const object = diagnostic.objects[0];
  const context = [location, object].filter(Boolean).join("  ");
  const disposition = diagnostic.disposition === "active"
    ? ""
    : ` [${diagnostic.disposition}]`;
  const lines = [
    `${severity} ${diagnostic.id}${disposition}${context ? `  ${context}` : ""}`,
    `  ${diagnostic.message}`,
  ];

  if (diagnostic.measurement !== undefined) {
    const required = diagnostic.measurement.required === undefined
      ? ""
      : `; required ${diagnostic.measurement.required}`;
    lines.push(`  Actual ${diagnostic.measurement.actual}${required}`);
  }
  const omitted = [
    diagnostic.omittedMessageCharacterCount === undefined
      ? undefined
      : `${diagnostic.omittedMessageCharacterCount} message character(s)`,
    diagnostic.omittedObjectCount === undefined
      ? undefined
      : `${diagnostic.omittedObjectCount} object reference(s)`,
    diagnostic.omittedSourceLocationCount === undefined
      ? undefined
      : `${diagnostic.omittedSourceLocationCount} source location(s)`,
    diagnostic.omittedEvidenceCount === undefined
      ? undefined
      : `${diagnostic.omittedEvidenceCount} evidence reference(s)`,
  ].filter((value): value is string => value !== undefined);
  if (omitted.length > 0) lines.push(`  Bounded detail: omitted ${omitted.join(", ")}`);
  if (diagnostic.nextCommand !== undefined) {
    lines.push(`  Inspect: ${diagnostic.nextCommand}`);
  }

  return lines.join("\n");
}
