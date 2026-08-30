import { describe, expect, test } from "bun:test";
import {
  DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT,
  DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT,
  DIAGNOSTIC_REFERENCE_LIMIT,
  defineDiagnostic,
  diagnosticId,
  formatCompactDiagnostic,
} from "../src/diagnostics";

describe("diagnostics", () => {
  test("formats a concise, source-addressable diagnostic", () => {
    const diagnostic = defineDiagnostic({
      id: diagnosticId("PCB_CLEARANCE_001"),
      severity: "error",
      dimension: "fabrication",
      message: "Copper clearance is below the active rule",
      waiverPolicy: "allowed",
      objects: ["trace.T1", "pad.U1.4"],
      measurement: { actual: "0.12mm", required: ">=0.20mm" },
      sourceLocations: ["circuit/controller/mcu.tsx:42"],
      nextCommand: "fulmetry inspect trace.T1",
    });

    expect(formatCompactDiagnostic(diagnostic)).toBe(
      [
        "E PCB_CLEARANCE_001  circuit/controller/mcu.tsx:42  trace.T1",
        "  Copper clearance is below the active rule",
        "  Actual 0.12mm; required >=0.20mm",
        "  Inspect: fulmetry inspect trace.T1",
      ].join("\n"),
    );
  });

  test("rejects unstable diagnostic identifiers", () => {
    expect(() => diagnosticId("clearance error")).toThrow(
      "expected a stable identifier",
    );
  });

  test("requires scope and justification for waived findings", () => {
    expect(() =>
      defineDiagnostic({
        id: diagnosticId("ERC_UNUSED_PIN_001"),
        severity: "warning",
        dimension: "electrical",
        message: "Unused pin",
        waiverPolicy: "allowed",
        disposition: "waived",
      }),
    ).toThrow("requires scope and justification");
  });

  test("retains waived disposition in compact output", () => {
    const diagnostic = defineDiagnostic({
      id: diagnosticId("ERC_UNUSED_PIN_001"),
      severity: "warning",
      dimension: "electrical",
      message: "Unused pin is intentional",
      waiverPolicy: "allowed",
      disposition: "waived",
      resolution: {
        scope: "U1.8",
        justification: "Reserved for a future hardware revision",
      },
    });

    expect(formatCompactDiagnostic(diagnostic)).toContain(
      "W ERC_UNUSED_PIN_001 [waived]",
    );
  });

  test("requires non-empty justification for suppressed findings", () => {
    expect(() =>
      defineDiagnostic({
        id: diagnosticId("ERC_UNUSED_PIN_001"),
        severity: "warning",
        dimension: "electrical",
        message: "Unused pin",
        waiverPolicy: "allowed",
        disposition: "suppressed",
        resolution: { scope: "U1.8", justification: "  " },
      }),
    ).toThrow("cannot be empty");
  });

  test("rejects waiver or suppression for a non-waivable finding", () => {
    expect(() =>
      defineDiagnostic({
        id: diagnosticId("PCB_ARTIFACT_INTEGRITY_001"),
        severity: "error",
        dimension: "fabrication",
        message: "Artifact bytes do not match the manifest",
        waiverPolicy: "forbidden",
        disposition: "waived",
        resolution: { scope: "bundle", justification: "Ignore the mismatch" },
      }),
    ).toThrow("non-waivable");
  });

  test("rejects invented runtime fields and deep-copies nested evidence", () => {
    expect(() =>
      defineDiagnostic({
        id: "INVENTED" as never,
        severity: "panic" as never,
        dimension: "fabrication",
        message: "bad",
        waiverPolicy: "forbidden",
      }),
    ).toThrow("Invalid diagnostic id");

    const measurement = { actual: "0.1 mm", required: "0.2 mm" };
    const diagnostic = defineDiagnostic({
      id: diagnosticId("PCB_CLEARANCE_002"),
      severity: "error",
      dimension: "fabrication",
      message: "Clearance is too small",
      waiverPolicy: "forbidden",
      measurement,
    });
    measurement.actual = "999 mm";
    expect(diagnostic.measurement?.actual).toBe("0.1 mm");
  });

  test("bounds reference arrays and preserves explicit omission counts", () => {
    const references = Array.from(
      { length: DIAGNOSTIC_REFERENCE_LIMIT + 17 },
      (_, index) => `reference-${index}`,
    );
    const diagnostic = defineDiagnostic({
      id: diagnosticId("PCB_BOUNDED_REPORT_001"),
      severity: "error",
      dimension: "fabrication",
      message: "Many affected objects",
      waiverPolicy: "forbidden",
      objects: references,
      sourceLocations: references.map((value) => `source/${value}.tsx:1`),
      evidence: references.map((value) => `circuit-json:${value}`),
    });

    expect(diagnostic.objects).toHaveLength(DIAGNOSTIC_REFERENCE_LIMIT);
    expect(diagnostic.sourceLocations).toHaveLength(DIAGNOSTIC_REFERENCE_LIMIT);
    expect(diagnostic.evidence).toHaveLength(DIAGNOSTIC_REFERENCE_LIMIT);
    expect(diagnostic.omittedObjectCount).toBe(17);
    expect(diagnostic.omittedSourceLocationCount).toBe(17);
    expect(diagnostic.omittedEvidenceCount).toBe(17);

    const normalizedAgain = defineDiagnostic(diagnostic);
    expect(normalizedAgain.omittedObjectCount).toBe(17);
    expect(normalizedAgain.omittedSourceLocationCount).toBe(17);
    expect(normalizedAgain.omittedEvidenceCount).toBe(17);
    expect(normalizedAgain.objects).toEqual(diagnostic.objects);
    expect(formatCompactDiagnostic(diagnostic)).toContain(
      "Bounded detail: omitted 17 object reference(s), 17 source location(s), 17 evidence reference(s)",
    );

    expect(() => defineDiagnostic({
      ...diagnostic,
      omittedObjectCount: -1,
    })).toThrow("non-negative safe integers");

    expect(() => defineDiagnostic({
      ...diagnostic,
      objects: [...diagnostic.objects, "one-more"],
      omittedObjectCount: Number.MAX_SAFE_INTEGER,
    })).toThrow("overflowed a safe integer");
  });

  test("bounds messages and rejects individually oversized references", () => {
    const diagnostic = defineDiagnostic({
      id: diagnosticId("PCB_BOUNDED_MESSAGE_001"),
      severity: "error",
      dimension: "fabrication",
      message: "m".repeat(DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT + 10),
      waiverPolicy: "forbidden",
    });
    expect(diagnostic.message).toHaveLength(DIAGNOSTIC_MESSAGE_CHARACTER_LIMIT);
    expect(diagnostic.omittedMessageCharacterCount).toBe(11);
    expect(formatCompactDiagnostic(diagnostic)).toContain(
      "Bounded detail: omitted 11 message character(s)",
    );

    expect(() => defineDiagnostic({
      ...diagnostic,
      objects: ["x".repeat(DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT + 1)],
    })).toThrow(`at most ${DIAGNOSTIC_REFERENCE_CHARACTER_LIMIT} characters`);
  });
});
