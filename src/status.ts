// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
/** Evidence dimensions are deliberately independent. There is no universal ready state. */
export const STATUS_DIMENSIONS = [
  "fabrication",
  "electrical",
  "functional",
  "standards",
  "sourcing",
] as const;

export type StatusDimension = (typeof STATUS_DIMENSIONS)[number];
export type AssuranceDimension = Exclude<StatusDimension, "sourcing">;

export const ASSURANCE_DIMENSIONS = [
  "fabrication",
  "electrical",
  "functional",
  "standards",
] as const satisfies readonly AssuranceDimension[];

export const ASSURANCE_STATES = [
  "not-run",
  "passed",
  "passed-with-waivers",
  "failed",
  "incomplete",
  "unavailable",
] as const;

export type AssuranceState = (typeof ASSURANCE_STATES)[number];

export const SOURCING_STATES = [
  "available",
  "constrained",
  "unavailable",
  "stale",
  "unchecked",
] as const;

export type SourcingState = (typeof SOURCING_STATES)[number];

export interface AssuranceStatus<D extends AssuranceDimension = AssuranceDimension> {
  readonly dimension: D;
  readonly state: AssuranceState;
  readonly diagnosticIds: readonly string[];
  readonly summary?: string;
}

export interface SourcingStatus {
  readonly dimension: "sourcing";
  readonly state: SourcingState;
  readonly diagnosticIds: readonly string[];
  readonly summary?: string;
  readonly checkedAt?: string;
}

export interface StatusSet {
  readonly fabrication: AssuranceStatus<"fabrication">;
  readonly electrical: AssuranceStatus<"electrical">;
  readonly functional: AssuranceStatus<"functional">;
  readonly standards: AssuranceStatus<"standards">;
  readonly sourcing: SourcingStatus;
}

export type AnyStatus = StatusSet[keyof StatusSet];

function includesValue<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function assuranceStatus<D extends AssuranceDimension>(
  dimension: D,
  state: AssuranceState,
  options: {
    readonly diagnosticIds?: readonly string[];
    readonly summary?: string;
  } = {},
): AssuranceStatus<D> {
  if (!includesValue(ASSURANCE_DIMENSIONS, dimension)) {
    throw new TypeError(`Unknown assurance dimension: ${String(dimension)}`);
  }
  if (!includesValue(ASSURANCE_STATES, state)) {
    throw new TypeError(`Unknown assurance state: ${String(state)}`);
  }

  const diagnosticIds = [...new Set(options.diagnosticIds ?? [])];
  if (state === "passed-with-waivers" && diagnosticIds.length === 0) {
    throw new TypeError(
      "passed-with-waivers requires at least one waived diagnostic identifier",
    );
  }

  return Object.freeze({
    dimension,
    state,
    diagnosticIds: Object.freeze(diagnosticIds),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
  });
}

export function sourcingStatus(
  state: SourcingState,
  options: {
    readonly diagnosticIds?: readonly string[];
    readonly summary?: string;
    readonly checkedAt?: string;
  } = {},
): SourcingStatus {
  if (!includesValue(SOURCING_STATES, state)) {
    throw new TypeError(`Unknown sourcing state: ${String(state)}`);
  }

  return Object.freeze({
    dimension: "sourcing" as const,
    state,
    diagnosticIds: Object.freeze([...new Set(options.diagnosticIds ?? [])]),
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.checkedAt === undefined ? {} : { checkedAt: options.checkedAt }),
  });
}

/**
 * Builds a status set without deriving one dimension from another. Runtime
 * checks protect callers crossing an untyped JSON or adapter boundary.
 */
export function statusSet(statuses: StatusSet): Readonly<StatusSet> {
  for (const dimension of STATUS_DIMENSIONS) {
    if (statuses[dimension].dimension !== dimension) {
      throw new TypeError(
        `Status slot "${dimension}" contains "${statuses[dimension].dimension}"`,
      );
    }
  }

  return Object.freeze({
    fabrication: assuranceStatus("fabrication", statuses.fabrication.state, {
      diagnosticIds: statuses.fabrication.diagnosticIds,
      ...(statuses.fabrication.summary === undefined
        ? {}
        : { summary: statuses.fabrication.summary }),
    }),
    electrical: assuranceStatus("electrical", statuses.electrical.state, {
      diagnosticIds: statuses.electrical.diagnosticIds,
      ...(statuses.electrical.summary === undefined
        ? {}
        : { summary: statuses.electrical.summary }),
    }),
    functional: assuranceStatus("functional", statuses.functional.state, {
      diagnosticIds: statuses.functional.diagnosticIds,
      ...(statuses.functional.summary === undefined
        ? {}
        : { summary: statuses.functional.summary }),
    }),
    standards: assuranceStatus("standards", statuses.standards.state, {
      diagnosticIds: statuses.standards.diagnosticIds,
      ...(statuses.standards.summary === undefined
        ? {}
        : { summary: statuses.standards.summary }),
    }),
    sourcing: sourcingStatus(statuses.sourcing.state, {
      diagnosticIds: statuses.sourcing.diagnosticIds,
      ...(statuses.sourcing.summary === undefined
        ? {}
        : { summary: statuses.sourcing.summary }),
      ...(statuses.sourcing.checkedAt === undefined
        ? {}
        : { checkedAt: statuses.sourcing.checkedAt }),
    }),
  });
}

export function unassessedStatusSet(): Readonly<StatusSet> {
  return statusSet({
    fabrication: assuranceStatus("fabrication", "not-run"),
    electrical: assuranceStatus("electrical", "not-run"),
    functional: assuranceStatus("functional", "not-run"),
    standards: assuranceStatus("standards", "not-run"),
    sourcing: sourcingStatus("unchecked"),
  });
}

export function statusEntries(statuses: StatusSet): readonly AnyStatus[] {
  return STATUS_DIMENSIONS.map((dimension) => statuses[dimension]);
}

export function isAssurancePassing(status: AssuranceStatus): boolean {
  return status.state === "passed" || status.state === "passed-with-waivers";
}
