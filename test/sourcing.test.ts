import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "tscircuit";
import { canonicalCircuitJson } from "../src/circuit-json";
import { MANUFACTURING_ADAPTER_VERSIONS } from "../src/manufacturing/export";
import {
  parseFulmetryLock,
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
  type FulmetryLock,
} from "../src/project/lock";
import {
  assessRecordedSourcing,
  recordedSourcingPolicyDigest,
  recordedSourcingSelectionContentSha256,
} from "../src/sourcing";
import { manufacturingFixture } from "./fixtures/manufacturing";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function parse(document: unknown): FulmetryLock {
  return parseFulmetryLock(`${JSON.stringify(document)}\n`);
}

function recomputeSelection(document: any, designator: string): void {
  const selection = document.sourcing.selections[designator];
  const { contentSha256: _discard, ...withoutDigest } = selection;
  selection.contentSha256 = recordedSourcingSelectionContentSha256({
    designator,
    selection: withoutDigest,
  });
}

async function sourcedFixture(): Promise<{
  circuitJson: AnyCircuitElement[];
  document: any;
  lock: FulmetryLock;
}> {
  const circuitJson = await manufacturingFixture(2);
  const manufacturerParts: Record<string, string> = {
    R1: "RC0603FR-0710KL",
    D1: "LTST-C190KGKT",
    J1: "M20-9990245",
  };
  for (const element of circuitJson) {
    if (element.type === "source_component" && element.name in manufacturerParts) {
      (element as unknown as Record<string, unknown>).manufacturer_part_number =
        manufacturerParts[element.name!];
    }
  }
  const policyWithoutDigest = {
    name: "fulmetry-recorded-sourcing",
    version: "1.0.0",
    maxAgeSeconds: 86_400,
    maxFutureSkewSeconds: 300,
    minimumStock: 100,
  };
  const selections: Record<string, unknown> = {};
  for (const pcb of circuitJson.filter((element) => element.type === "pcb_component")) {
    if (pcb.do_not_place === true) continue;
    const source = circuitJson.find((element) =>
      element.type === "source_component" && element.source_component_id === pcb.source_component_id
    );
    const cad = circuitJson.find((element) =>
      element.type === "cad_component" && element.pcb_component_id === pcb.pcb_component_id
    );
    if (source?.type !== "source_component" || cad?.type !== "cad_component" || !source.name) continue;
    const supplierPartNumber = source.supplier_part_numbers?.jlcpcb?.[0];
    if (!supplierPartNumber || !source.manufacturer_part_number || !cad.footprinter_string) continue;
    const selection = {
      sourceComponentId: source.source_component_id,
      manufacturer: { name: source.name === "R1" ? "Yageo" : source.name === "D1" ? "Lite-On" : "Harwin" , partNumber: source.manufacturer_part_number },
      supplier: { name: "jlcpcb", partNumber: supplierPartNumber },
      package: source.name === "J1" ? "2.54mm-pin-header-1x2" : "0603-imperial",
      footprint: cad.footprinter_string,
      snapshot: {
        schemaVersion: 1 as const,
        source: `recorded:https://example.invalid/jlcpcb/${supplierPartNumber}`,
        retrievedAt: "2026-08-08T11:30:00.000Z",
        lifecycle: "active" as const,
        stock: 10_000,
        price: { currency: "USD", unitPrice: 0.01, quantity: 100 },
      },
    };
    selections[source.name] = {
      ...selection,
      contentSha256: recordedSourcingSelectionContentSha256({
        designator: source.name,
        selection,
      }),
    };
  }
  const document = {
    schemaVersion: 1,
    tscircuit: {
      version: SUPPORTED_TSCIRCUIT_VERSION,
      integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
    },
    adapters: MANUFACTURING_ADAPTER_VERSIONS,
    profiles: {},
    assets: {},
    sourcing: {
      schemaVersion: 1,
      policy: {
        ...policyWithoutDigest,
        digest: recordedSourcingPolicyDigest(policyWithoutDigest),
      },
      selections,
    },
  };
  return { circuitJson, document, lock: parse(document) };
}

describe("recorded offline sourcing evidence", () => {
  test("reports recorded selection integrity but never elevates a self-authored selection record to availability", async () => {
    const fixture = await sourcedFixture();
    const assessment = assessRecordedSourcing({
      circuitJson: fixture.circuitJson,
      lock: fixture.lock,
      now: NOW,
      requirePolicy: true,
    });
    expect(assessment.status).toMatchObject({
      dimension: "sourcing",
      state: "unavailable",
      checkedAt: NOW.toISOString(),
    });
    expect(assessment.status.diagnosticIds).toContain(
      "SRC_AUTHENTICATED_PROVIDER_EVIDENCE_UNAVAILABLE_001",
    );
    expect(assessment.evidence).toMatchObject({
      mode: "recorded-offline",
      networkAccess: "none",
      claim: "recorded-selection-integrity-only",
      canonicalCircuitJsonSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourcingLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(assessment.evidence.selections).toHaveLength(3);
    expect(assessment.evidence.selections.every(({ recordedCondition }) => recordedCondition === "available"))
      .toBeTrue();
    expect(assessment.evidence.selections[0]?.price).toEqual({
      currency: "USD",
      unitPrice: 0.01,
      quantity: 100,
    });
    expect(assessment.evidence.timeAuthority).toBe("host-wall-clock");
    expect(assessment.evidence.knownGaps.join(" ")).toContain("No live supplier request");
    expect(assessRecordedSourcing({
      circuitJson: fixture.circuitJson,
      lock: fixture.lock,
      now: NOW,
    }).status.state).toBe("unchecked");
  });

  test("keeps no-policy projects unchecked and never infers freshness while offline", async () => {
    const fixture = await sourcedFixture();
    fixture.document.sourcing = { schemaVersion: 1, policy: null, selections: {} };
    const lock = parse(fixture.document);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("network must not be touched"); }) as unknown as typeof fetch;
    try {
      const advisory = assessRecordedSourcing({ circuitJson: fixture.circuitJson, lock, now: NOW });
      expect(advisory.status.state).toBe("unchecked");
      expect(advisory.evidence.networkAccess).toBe("none");
      const required = assessRecordedSourcing({
        circuitJson: fixture.circuitJson,
        lock,
        now: NOW,
        requirePolicy: true,
      });
      expect(required.status.state).toBe("unavailable");
      expect(required.status.diagnosticIds).toContain("SRC_RECORDED_POLICY_REQUIRED_001");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects JLC/LCSC supplier conflicts and manufacturer/supplier identity conflation", async () => {
    const supplierConflict = await sourcedFixture();
    const r1 = supplierConflict.circuitJson.find((element) =>
      element.type === "source_component" && element.name === "R1"
    )! as unknown as Record<string, any>;
    r1.supplier_part_numbers.lcsc = ["C25804"];
    const conflicted = assessRecordedSourcing({
      circuitJson: supplierConflict.circuitJson,
      lock: supplierConflict.lock,
      now: NOW,
      requirePolicy: true,
    });
    expect(conflicted.status.state).toBe("unavailable");
    expect(conflicted.status.diagnosticIds).toContain("SRC_SUPPLIER_IDENTITY_CONFLICT_001");

    const conflated = await sourcedFixture();
    conflated.document.sourcing.selections.R1.manufacturer.name = "JLCPCB";
    recomputeSelection(conflated.document, "R1");
    const conflatedAssessment = assessRecordedSourcing({
      circuitJson: conflated.circuitJson,
      lock: parse(conflated.document),
      now: NOW,
      requirePolicy: true,
    });
    expect(conflatedAssessment.status.state).toBe("unavailable");
    expect(conflatedAssessment.status.diagnosticIds).toContain("SRC_MANUFACTURER_IDENTITY_CONFLICT_001");
  });

  test("rejects missing MPN, missing or duplicate supplier IDs, and package/footprint mismatches", async () => {
    const missingMpn = await sourcedFixture();
    const r1 = missingMpn.circuitJson.find((element) =>
      element.type === "source_component" && element.name === "R1"
    )! as unknown as Record<string, any>;
    delete r1.manufacturer_part_number;
    expect(assessRecordedSourcing({
      circuitJson: missingMpn.circuitJson,
      lock: missingMpn.lock,
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_MANUFACTURER_IDENTITY_CONFLICT_001");

    const duplicateSupplier = await sourcedFixture();
    const d1 = duplicateSupplier.circuitJson.find((element) =>
      element.type === "source_component" && element.name === "D1"
    )! as unknown as Record<string, any>;
    d1.supplier_part_numbers.jlcpcb.push(d1.supplier_part_numbers.jlcpcb[0]);
    expect(assessRecordedSourcing({
      circuitJson: duplicateSupplier.circuitJson,
      lock: duplicateSupplier.lock,
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_SUPPLIER_IDENTITY_CONFLICT_001");

    const missingSupplier = await sourcedFixture();
    const j1 = missingSupplier.circuitJson.find((element) =>
      element.type === "source_component" && element.name === "J1"
    )! as unknown as Record<string, any>;
    j1.supplier_part_numbers = {};
    expect(assessRecordedSourcing({
      circuitJson: missingSupplier.circuitJson,
      lock: missingSupplier.lock,
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_SUPPLIER_IDENTITY_CONFLICT_001");

    const mapping = await sourcedFixture();
    mapping.document.sourcing.selections.D1.footprint = "looks-similar-but-wrong";
    recomputeSelection(mapping.document, "D1");
    expect(assessRecordedSourcing({
      circuitJson: mapping.circuitJson,
      lock: parse(mapping.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_PACKAGE_FOOTPRINT_MISMATCH_001");

    const unsafeLock = await sourcedFixture();
    unsafeLock.document.sourcing.selections.R1.manufacturer.name = "Yageo\u202eJLCPCB";
    recomputeSelection(unsafeLock.document, "R1");
    expect(() => parse(unsafeLock.document)).toThrow("printable ASCII");

    const unsafeSource = await sourcedFixture();
    const unsafeR1 = unsafeSource.circuitJson.find((element) =>
      element.type === "source_component" && element.name === "R1"
    )! as unknown as Record<string, any>;
    unsafeR1.supplier_part_numbers.jlcpcb = ["C25804\u200b"];
    expect(assessRecordedSourcing({
      circuitJson: unsafeSource.circuitJson,
      lock: unsafeSource.lock,
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_IDENTITY_TEXT_UNSAFE_001");
  });

  test("fails stale, future, unknown, and contradictory recorded metadata against host time", async () => {
    const stale = await sourcedFixture();
    stale.document.sourcing.selections.R1.snapshot.retrievedAt = "2026-08-01T00:00:00.000Z";
    recomputeSelection(stale.document, "R1");
    expect(assessRecordedSourcing({
      circuitJson: stale.circuitJson,
      lock: parse(stale.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_RECORDED_DATA_STALE_001");

    const future = await sourcedFixture();
    future.document.sourcing.selections.R1.snapshot.retrievedAt = "2026-08-09T00:00:00.000Z";
    recomputeSelection(future.document, "R1");
    expect(assessRecordedSourcing({
      circuitJson: future.circuitJson,
      lock: parse(future.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_RECORDED_TIME_INVALID_001");

    const unknown = await sourcedFixture();
    unknown.document.sourcing.selections.R1.snapshot.lifecycle = "unknown";
    recomputeSelection(unknown.document, "R1");
    expect(assessRecordedSourcing({
      circuitJson: unknown.circuitJson,
      lock: parse(unknown.document),
      now: NOW,
      requirePolicy: true,
    }).status.state).toBe("unavailable");

    const constrained = await sourcedFixture();
    constrained.document.sourcing.selections.R1.snapshot.stock = 50;
    recomputeSelection(constrained.document, "R1");
    expect(assessRecordedSourcing({
      circuitJson: constrained.circuitJson,
      lock: parse(constrained.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_RECORDED_AVAILABILITY_CONSTRAINED_001");

    const badPolicy = await sourcedFixture();
    badPolicy.document.sourcing.policy.minimumStock = 1;
    expect(assessRecordedSourcing({
      circuitJson: badPolicy.circuitJson,
      lock: parse(badPolicy.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_POLICY_DIGEST_MISMATCH_001");

    const unrecorded = await sourcedFixture();
    unrecorded.document.sourcing.selections.R1.snapshot.source = "https://mutable.example.invalid/part";
    recomputeSelection(unrecorded.document, "R1");
    expect(assessRecordedSourcing({
      circuitJson: unrecorded.circuitJson,
      lock: parse(unrecorded.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_RECORDED_SOURCE_INVALID_001");

    const invalidPrice = await sourcedFixture();
    invalidPrice.document.sourcing.selections.R1.snapshot.price.currency = "usd";
    recomputeSelection(invalidPrice.document, "R1");
    expect(() => parse(invalidPrice.document)).toThrow("uppercase currency");
    invalidPrice.document.sourcing.selections.R1.snapshot.price.currency = "USD";
    invalidPrice.document.sourcing.selections.R1.snapshot.price.quantity = 0;
    recomputeSelection(invalidPrice.document, "R1");
    expect(() => parse(invalidPrice.document)).toThrow("positive quantity");

    const absentPrice = await sourcedFixture();
    absentPrice.document.sourcing.selections.R1.snapshot.price = null;
    recomputeSelection(absentPrice.document, "R1");
    const absentAssessment = assessRecordedSourcing({
      circuitJson: absentPrice.circuitJson,
      lock: parse(absentPrice.document),
      now: NOW,
    });
    expect(absentAssessment.status.state).toBe("unchecked");
    expect(absentAssessment.evidence.selections.find(({ designator }) => designator === "R1")?.price)
      .toBeNull();
  });

  test("detects replay, orphaned records, and stock mutation without selecting a substitute", async () => {
    for (const prototypeName of ["constructor", "toString", "__proto__"]) {
      const prototypeAttack = await sourcedFixture();
      const r1 = prototypeAttack.circuitJson.find((element) =>
        element.type === "source_component" && element.name === "R1"
      )! as unknown as Record<string, unknown>;
      r1.name = prototypeName;
      const assessment = assessRecordedSourcing({
        circuitJson: prototypeAttack.circuitJson,
        lock: prototypeAttack.lock,
        now: NOW,
        requirePolicy: true,
      });
      expect(assessment.status.diagnosticIds).toContain("SRC_LOCK_SELECTION_MISSING_001");
    }

    const duplicateCircuitId = await sourcedFixture();
    const duplicatedSource = duplicateCircuitId.circuitJson.find((element) =>
      element.type === "source_component" && element.name === "R1"
    )!;
    duplicateCircuitId.circuitJson.push(structuredClone(duplicatedSource));
    expect(assessRecordedSourcing({
      circuitJson: duplicateCircuitId.circuitJson,
      lock: duplicateCircuitId.lock,
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_COMPONENT_IDENTITY_CONFLICT_001");

    const replay = await sourcedFixture();
    replay.document.sourcing.selections.D1.sourceComponentId = "source_component_0";
    recomputeSelection(replay.document, "D1");
    expect(assessRecordedSourcing({
      circuitJson: replay.circuitJson,
      lock: parse(replay.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_LOCK_COMPONENT_REPLAY_001");

    const orphan = await sourcedFixture();
    orphan.document.sourcing.selections.X99 = structuredClone(orphan.document.sourcing.selections.R1);
    recomputeSelection(orphan.document, "X99");
    expect(assessRecordedSourcing({
      circuitJson: orphan.circuitJson,
      lock: parse(orphan.document),
      now: NOW,
      requirePolicy: true,
    }).status.diagnosticIds).toContain("SRC_LOCK_SELECTION_ORPHANED_001");

    const stockAttack = await sourcedFixture();
    const circuitDigestBefore = new Bun.CryptoHasher("sha256")
      .update(canonicalCircuitJson(stockAttack.circuitJson)).digest("hex");
    stockAttack.document.sourcing.selections.R1.snapshot.stock = 0;
    const attacked = assessRecordedSourcing({
      circuitJson: stockAttack.circuitJson,
      lock: parse(stockAttack.document),
      now: NOW,
      requirePolicy: true,
    });
    expect(attacked.status.state).toBe("unavailable");
    expect(attacked.status.diagnosticIds).toContain("SRC_RECORDED_CONTENT_MISMATCH_001");
    expect(new Bun.CryptoHasher("sha256").update(canonicalCircuitJson(stockAttack.circuitJson)).digest("hex"))
      .toBe(circuitDigestBefore);
  });
});
