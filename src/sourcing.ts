// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import { canonicalCircuitJson } from "./circuit-json";
import { defineDiagnostic, diagnosticId, type Diagnostic } from "./diagnostics";
import type {
  FulmetryLock,
  RecordedSourcingPolicyLock,
  RecordedSourcingSelectionLock,
} from "./project/lock";
import { sourcingStatus, type SourcingState, type SourcingStatus } from "./status";

export const RECORDED_SOURCING_SCHEMA_VERSION = 1 as const;

export interface RecordedSourcingSelectionDigestInput {
  readonly designator: string;
  readonly selection: Omit<RecordedSourcingSelectionLock, "contentSha256">;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Sourcing evidence contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") throw new TypeError("Sourcing evidence must be JSON-serializable");
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function sha256(value: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

/** Binds a named sourcing policy to its exact freshness and stock thresholds. */
export function recordedSourcingPolicyDigest(
  policy: Omit<RecordedSourcingPolicyLock, "digest">,
): string {
  return `sha256:${sha256(policy)}`;
}

/**
 * Binds one self-authored selection record and digest to a designator,
 * distinct manufacturer and supplier identities, source-component identity,
 * and recorded package and footprint strings.
 */
export function recordedSourcingSelectionContentSha256(
  input: RecordedSourcingSelectionDigestInput,
): string {
  return sha256(input);
}

export interface RecordedSourcingSelectionEvidence {
  readonly designator: string;
  readonly sourceComponentId: string;
  readonly manufacturer: { readonly name: string; readonly partNumber: string };
  readonly supplier: { readonly name: string; readonly partNumber: string };
  readonly package: string;
  readonly footprint: string;
  readonly source: string;
  readonly retrievedAt: string;
  readonly contentSha256: string;
  readonly lifecycle: "active" | "nrnd" | "obsolete" | "unknown";
  readonly stock: number | null;
  readonly price: {
    readonly currency: string;
    readonly unitPrice: number;
    readonly quantity: number;
  } | null;
  readonly ageSeconds: number | null;
  /** Observation about untrusted recorded metadata; never an availability status. */
  readonly recordedCondition: Exclude<SourcingState, "unchecked">;
}

export interface RecordedSourcingEvidence {
  readonly schemaVersion: typeof RECORDED_SOURCING_SCHEMA_VERSION;
  readonly mode: "recorded-offline";
  readonly networkAccess: "none";
  readonly claim: "recorded-selection-integrity-only" | "not-checked-no-policy";
  readonly checkedAt: string;
  readonly timeAuthority: "host-wall-clock";
  readonly canonicalCircuitJsonSha256: string;
  readonly sourcingLockSha256: string;
  readonly policy: RecordedSourcingPolicyLock | null;
  readonly selections: readonly RecordedSourcingSelectionEvidence[];
  readonly knownGaps: readonly string[];
}

export interface RecordedSourcingAssessment {
  readonly status: SourcingStatus;
  readonly diagnostics: readonly Diagnostic[];
  readonly evidence: RecordedSourcingEvidence;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_SOURCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/#@()-]{0,127}$/;
const SAFE_PROVIDER_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function sourcingDiagnostic(options: {
  readonly id: string;
  readonly message: string;
  readonly objects?: readonly string[];
  readonly evidence?: readonly string[];
}): Diagnostic {
  return defineDiagnostic({
    id: diagnosticId(options.id),
    severity: "warning",
    dimension: "sourcing",
    message: options.message,
    waiverPolicy: "forbidden",
    objects: options.objects ?? [],
    sourceLocations: [],
    evidence: options.evidence ?? [],
    nextCommand: `fulmetry inspect --status sourcing --rule ${options.id}`,
  });
}

function manufacturedComponents(circuitJson: readonly AnyCircuitElement[]) {
  const sources = new Map(circuitJson.flatMap((element) =>
    element.type === "source_component" ? [[element.source_component_id, element] as const] : []
  ));
  const cad = circuitJson.filter((element) => element.type === "cad_component");
  const infrastructure = new Set(circuitJson.flatMap((element) =>
    element.type === "source_manually_placed_via" ? [element.source_manually_placed_via_id] : []
  ));
  return circuitJson.flatMap((element) => {
    if (
      element.type !== "pcb_component" || element.do_not_place === true ||
      infrastructure.has(element.source_component_id)
    ) return [];
    const source = sources.get(element.source_component_id);
    if (source?.ftype === "simple_test_point") return [];
    const matchingCad = cad.filter((candidate) =>
      candidate.pcb_component_id === element.pcb_component_id
    );
    return [{ pcb: element, source, cad: matchingCad }];
  });
}

function worstState(states: readonly Exclude<SourcingState, "unchecked">[]): Exclude<SourcingState, "unchecked"> {
  for (const state of ["unavailable", "stale", "constrained", "available"] as const) {
    if (states.includes(state)) return state;
  }
  return "unavailable";
}

function frozenEvidence(options: {
  readonly checkedAt: string;
  readonly circuitJson: readonly AnyCircuitElement[];
  readonly lock: FulmetryLock;
  readonly selections: readonly RecordedSourcingSelectionEvidence[];
  readonly policy: RecordedSourcingPolicyLock | null;
}): RecordedSourcingEvidence {
  return Object.freeze({
    schemaVersion: RECORDED_SOURCING_SCHEMA_VERSION,
    mode: "recorded-offline" as const,
    networkAccess: "none" as const,
    claim: options.policy === null
      ? "not-checked-no-policy" as const
      : "recorded-selection-integrity-only" as const,
    checkedAt: options.checkedAt,
    timeAuthority: "host-wall-clock" as const,
    canonicalCircuitJsonSha256: new Bun.CryptoHasher("sha256")
      .update(canonicalCircuitJson(options.circuitJson))
      .digest("hex"),
    sourcingLockSha256: sha256(options.lock.sourcing),
    policy: options.policy,
    selections: Object.freeze(options.selections.map((selection) => Object.freeze({ ...selection }))),
    knownGaps: Object.freeze([
      "No live supplier request, provider authentication, ordering, or automatic substitution is performed.",
      "A self-authored selection record and digest, including its recorded stock condition, price, and lifecycle, is not authenticated provider evidence and cannot establish availability.",
      "Package and footprint strings are compared literally; this is not an independent mechanical fit qualification.",
      "Freshness observations trust the evaluating host's wall clock; Fulmetry does not provide trusted time attestation.",
    ]),
  });
}

export function assessRecordedSourcing(options: {
  readonly circuitJson: readonly AnyCircuitElement[];
  readonly lock: FulmetryLock;
  readonly now?: Date;
  readonly requirePolicy?: boolean;
}): Readonly<RecordedSourcingAssessment> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) throw new TypeError("Sourcing evaluation time is invalid");
  const checkedAt = now.toISOString();
  const policy = options.lock.sourcing.policy;
  if (policy === null) {
    const diagnostics = options.requirePolicy === true
      ? [
        sourcingDiagnostic({
          id: "SRC_RECORDED_POLICY_REQUIRED_001",
          message: "No locked recorded-sourcing policy is configured; availability remains unchecked",
        }),
        sourcingDiagnostic({
          id: "SRC_AUTHENTICATED_PROVIDER_EVIDENCE_UNAVAILABLE_001",
          message: "Required sourcing availability needs authenticated provider/cache evidence; no such adapter evidence is present",
          evidence: ["network:none"],
        }),
      ]
      : [];
    const status = options.requirePolicy === true
      ? sourcingStatus("unavailable", {
        diagnosticIds: diagnostics.map(({ id }) => id),
        summary: "Required recorded sourcing evidence is unavailable",
        checkedAt,
      })
      : sourcingStatus("unchecked", {
        summary: "No sourcing policy requested; no network request was made",
        checkedAt,
      });
    return Object.freeze({
      status,
      diagnostics: Object.freeze(diagnostics),
      evidence: frozenEvidence({
        checkedAt,
        circuitJson: options.circuitJson,
        lock: options.lock,
        selections: [],
        policy: null,
      }),
    });
  }

  const diagnostics: Diagnostic[] = [];
  const expectedPolicyDigest = recordedSourcingPolicyDigest({
    name: policy.name,
    version: policy.version,
    maxAgeSeconds: policy.maxAgeSeconds,
    maxFutureSkewSeconds: policy.maxFutureSkewSeconds,
    minimumStock: policy.minimumStock,
  });
  if (policy.digest !== expectedPolicyDigest) {
    diagnostics.push(sourcingDiagnostic({
      id: "SRC_POLICY_DIGEST_MISMATCH_001",
      message: "Recorded sourcing policy digest does not bind its exact freshness and stock thresholds",
      evidence: [`expected:${expectedPolicyDigest}`, `actual:${policy.digest}`],
    }));
  }

  const components = manufacturedComponents(options.circuitJson);
  const expectedDesignators = new Set<string>();
  const selectionSourceIds = new Map<string, string>();
  const evidence: RecordedSourcingSelectionEvidence[] = [];
  const selectionStates: Exclude<SourcingState, "unchecked">[] = [];
  const seenCircuitSourceIds = new Set<string>();
  for (const element of options.circuitJson) {
    if (element.type !== "source_component") continue;
    const supplierEntries = Object.entries(element.supplier_part_numbers ?? {})
      .flatMap(([provider, values]) => (values ?? []).map((partNumber) => ({ provider, partNumber })));
    if (
      !SAFE_SOURCE_TOKEN.test(element.source_component_id) ||
      (element.name !== undefined && !SAFE_SOURCE_TOKEN.test(element.name)) ||
      (element.manufacturer_part_number !== undefined &&
        !SAFE_SOURCE_TOKEN.test(element.manufacturer_part_number)) ||
      supplierEntries.some(({ provider, partNumber }) =>
        !SAFE_PROVIDER_TOKEN.test(provider) || !SAFE_SOURCE_TOKEN.test(partNumber)
      )
    ) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_IDENTITY_TEXT_UNSAFE_001",
        message: `${element.source_component_id} sourcing identity contains non-conservative text; Unicode controls, bidi, zero-width, and confusable characters are rejected`,
        objects: [element.source_component_id],
      }));
      selectionStates.push("unavailable");
    }
    if (seenCircuitSourceIds.has(element.source_component_id)) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_COMPONENT_IDENTITY_CONFLICT_001",
        message: `Circuit JSON source component identity ${element.source_component_id} is duplicated`,
        objects: [element.source_component_id],
      }));
      selectionStates.push("unavailable");
    }
    seenCircuitSourceIds.add(element.source_component_id);
  }

  for (const component of components) {
    const sourceId = component.pcb.source_component_id;
    const designator = component.source?.name?.trim();
    if (!designator || component.source === undefined) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_COMPONENT_IDENTITY_MISSING_001",
        message: `${component.pcb.pcb_component_id} has no unique stable source component designator`,
        objects: [component.pcb.pcb_component_id, sourceId],
      }));
      selectionStates.push("unavailable");
      continue;
    }
    if (expectedDesignators.has(designator)) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_COMPONENT_IDENTITY_CONFLICT_001",
        message: `Manufactured designator ${designator} is duplicated`,
        objects: [designator, sourceId],
      }));
      selectionStates.push("unavailable");
      continue;
    }
    expectedDesignators.add(designator);
    const selection = Object.hasOwn(options.lock.sourcing.selections, designator)
      ? options.lock.sourcing.selections[designator]
      : undefined;
    if (selection === undefined) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_LOCK_SELECTION_MISSING_001",
        message: `Manufactured component ${designator} has no recorded sourcing selection in fulmetry.lock`,
        objects: [designator, sourceId],
      }));
      selectionStates.push("unavailable");
      continue;
    }

    let state: Exclude<SourcingState, "unchecked"> = "available";
    const previousDesignator = selectionSourceIds.get(selection.sourceComponentId);
    if (previousDesignator !== undefined || selection.sourceComponentId !== sourceId) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_LOCK_COMPONENT_REPLAY_001",
        message: previousDesignator === undefined
          ? `Selection ${designator} targets ${selection.sourceComponentId}, not ${sourceId}`
          : `Selections ${previousDesignator} and ${designator} reuse source component ${selection.sourceComponentId}`,
        objects: [designator, sourceId, selection.sourceComponentId],
      }));
      state = "unavailable";
    }
    selectionSourceIds.set(selection.sourceComponentId, designator);

    const supplierEntries = Object.entries(component.source.supplier_part_numbers ?? {})
      .flatMap(([name, values]) => (values ?? []).map((partNumber) => ({ name, partNumber })));
    const matchingSupplier = supplierEntries.filter(({ name, partNumber }) =>
      name.toLowerCase() === selection.supplier.name.toLowerCase() &&
      partNumber === selection.supplier.partNumber
    );
    if (
      supplierEntries.length !== 1 || matchingSupplier.length !== 1 ||
      new Set(supplierEntries.map(({ name, partNumber }) => `${name.toLowerCase()}\0${partNumber}`)).size !== supplierEntries.length
    ) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_SUPPLIER_IDENTITY_CONFLICT_001",
        message: `${designator} must select exactly one supplier and supplier part number matching fulmetry.lock`,
        objects: [designator, sourceId],
      }));
      state = "unavailable";
    }
    if (
      selection.manufacturer.name.trim().toLowerCase() === selection.supplier.name.trim().toLowerCase() ||
      component.source.manufacturer_part_number !== selection.manufacturer.partNumber
    ) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_MANUFACTURER_IDENTITY_CONFLICT_001",
        message: `${designator} manufacturer identity/MPN is missing, conflated with its supplier, or differs from fulmetry.lock`,
        objects: [designator, sourceId],
      }));
      state = "unavailable";
    }

    if (
      component.cad.length !== 1 ||
      component.cad[0]!.footprinter_string !== selection.footprint ||
      selection.package.trim() === ""
    ) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_PACKAGE_FOOTPRINT_MISMATCH_001",
        message: `${designator} recorded footprint string differs from the manufactured CAD footprint, or its recorded package string is blank`,
        objects: [designator, sourceId, component.pcb.pcb_component_id],
      }));
      state = "unavailable";
    }

    const expectedContent = recordedSourcingSelectionContentSha256({
      designator,
      selection: {
        sourceComponentId: selection.sourceComponentId,
        manufacturer: selection.manufacturer,
        supplier: selection.supplier,
        package: selection.package,
        footprint: selection.footprint,
        snapshot: selection.snapshot,
      },
    });
    if (selection.contentSha256 !== expectedContent) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_RECORDED_CONTENT_MISMATCH_001",
        message: `${designator} self-authored selection record digest does not bind its identity, package and footprint strings, source, time, lifecycle, price, and recorded stock condition`,
        objects: [designator, sourceId],
        evidence: [`expected:${expectedContent}`, `actual:${selection.contentSha256}`],
      }));
      state = "unavailable";
    }
    if (!selection.snapshot.source.startsWith("recorded:")) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_RECORDED_SOURCE_INVALID_001",
        message: `${designator} sourcing snapshot does not declare a recorded source identifier bound by its content digest`,
        objects: [designator, sourceId],
      }));
      state = "unavailable";
    }

    const retrievedAt = ISO_INSTANT.test(selection.snapshot.retrievedAt)
      ? new Date(selection.snapshot.retrievedAt)
      : new Date(Number.NaN);
    const canonicalRetrievedAt = Number.isNaN(retrievedAt.valueOf())
      ? undefined
      : selection.snapshot.retrievedAt.includes(".")
        ? retrievedAt.toISOString()
        : retrievedAt.toISOString().replace(".000Z", "Z");
    const ageSeconds = (now.valueOf() - retrievedAt.valueOf()) / 1000;
    if (
      canonicalRetrievedAt !== selection.snapshot.retrievedAt ||
      Number.isNaN(ageSeconds) || ageSeconds < -policy.maxFutureSkewSeconds
    ) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_RECORDED_TIME_INVALID_001",
        message: `${designator} recorded retrieval time is invalid or too far in the future for the locked policy`,
        objects: [designator, sourceId],
      }));
      state = "unavailable";
    } else if (ageSeconds > policy.maxAgeSeconds && state !== "unavailable") {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_RECORDED_DATA_STALE_001",
        message: `${designator} recorded sourcing data is ${Math.floor(ageSeconds)} seconds old, exceeding ${policy.maxAgeSeconds}`,
        objects: [designator, sourceId],
      }));
      state = "stale";
    }

    if (
      selection.snapshot.lifecycle === "unknown" || selection.snapshot.lifecycle === "obsolete" ||
      selection.snapshot.stock === null || selection.snapshot.stock === 0
    ) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_RECORDED_AVAILABILITY_UNAVAILABLE_001",
        message: `${designator} recorded lifecycle or stock evidence does not establish availability`,
        objects: [designator, sourceId],
      }));
      state = "unavailable";
    } else if (
      state === "available" &&
      (selection.snapshot.lifecycle === "nrnd" || selection.snapshot.stock < policy.minimumStock)
    ) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_RECORDED_AVAILABILITY_CONSTRAINED_001",
        message: `${designator} is recorded as NRND or below the locked minimum-stock threshold`,
        objects: [designator, sourceId],
      }));
      state = "constrained";
    }

    selectionStates.push(state);
    evidence.push(Object.freeze({
      designator,
      sourceComponentId: sourceId,
      manufacturer: selection.manufacturer,
      supplier: selection.supplier,
      package: selection.package,
      footprint: selection.footprint,
      source: selection.snapshot.source,
      retrievedAt: selection.snapshot.retrievedAt,
      contentSha256: selection.contentSha256,
      lifecycle: selection.snapshot.lifecycle,
      stock: selection.snapshot.stock,
      price: selection.snapshot.price,
      ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
      recordedCondition: state,
    }));
  }

  for (const designator of Object.keys(options.lock.sourcing.selections)) {
    if (!expectedDesignators.has(designator)) {
      diagnostics.push(sourcingDiagnostic({
        id: "SRC_LOCK_SELECTION_ORPHANED_001",
        message: `Recorded sourcing selection ${designator} does not identify a manufactured component in this circuit`,
        objects: [designator],
      }));
      selectionStates.push("unavailable");
    }
  }
  if (components.length === 0) {
    diagnostics.push(sourcingDiagnostic({
      id: "SRC_MANUFACTURED_PARTS_MISSING_001",
      message: "No populated manufactured parts were available for sourcing assessment",
    }));
    selectionStates.push("unavailable");
  }

  const recordedCondition = diagnostics.some(({ id }) => id === "SRC_POLICY_DIGEST_MISMATCH_001")
    ? "unavailable" as const
    : worstState(selectionStates);
  if (options.requirePolicy === true) {
    diagnostics.push(sourcingDiagnostic({
      id: "SRC_AUTHENTICATED_PROVIDER_EVIDENCE_UNAVAILABLE_001",
      message: "Required sourcing availability needs authenticated provider/cache evidence; a self-authored selection record and digest prove reviewable selection integrity only",
      evidence: [`recorded-condition:${recordedCondition}`, "network:none"],
    }));
  }
  const status = sourcingStatus(options.requirePolicy === true ? "unavailable" : "unchecked", {
    diagnosticIds: diagnostics.map(({ id }) => id),
    summary: options.requirePolicy === true
      ? "Required authenticated sourcing availability evidence is unavailable"
      : `Recorded selection integrity was checked; recorded stock condition is ${recordedCondition}; supplier availability was not checked`,
    checkedAt,
  });
  return Object.freeze({
    status,
    diagnostics: Object.freeze(diagnostics),
    evidence: frozenEvidence({
      checkedAt,
      circuitJson: options.circuitJson,
      lock: options.lock,
      selections: evidence,
      policy,
    }),
  });
}
