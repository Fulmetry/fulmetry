import { describe, expect, test } from "bun:test";
import { defineDiagnostic, diagnosticId } from "../src/diagnostics";
import { commandResult, formatCompactResult } from "../src/result";
import type { ExitClassification } from "../src/result";
import {
  assuranceStatus,
  sourcingStatus,
  statusSet,
} from "../src/status";

describe("command results", () => {
  test("preserves every declared exit classification without rewriting it", () => {
    const classifications: readonly ExitClassification[] = [
      "success",
      "failure",
      "warning-only",
      "unavailable",
      "incomplete",
      "cancelled",
      "unsupported",
    ];
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "not-run"),
      electrical: assuranceStatus("electrical", "not-run"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });

    expect(
      classifications.map((exitClassification) =>
        commandResult({
          command: "fulmetry check",
          runId: `run-${exitClassification}`,
          exitClassification,
          requestedDimensions: exitClassification === "warning-only" ? ["electrical"] : [],
          statuses: exitClassification === "warning-only"
            ? statusSet({
              ...statuses,
              electrical: assuranceStatus("electrical", "passed"),
            })
            : statuses,
          diagnostics: exitClassification === "warning-only"
            ? [defineDiagnostic({
              id: diagnosticId("ERC_UNUSED_PIN_005"),
              severity: "warning",
              dimension: "electrical",
              message: "A pin is unused",
              waiverPolicy: "allowed",
            })]
            : [],
        }).exitClassification,
      ),
    ).toEqual([...classifications]);
  });

  test("serializes every status independently under a versioned contract", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "passed"),
      electrical: assuranceStatus("electrical", "failed", {
        diagnosticIds: ["ERC_SHORT_001"],
      }),
      functional: assuranceStatus("functional", "incomplete"),
      standards: assuranceStatus("standards", "unavailable"),
      sourcing: sourcingStatus("stale"),
    });
    const result = commandResult({
      command: "fulmetry check",
      runId: "run-001",
      exitClassification: "failure",
      requestedDimensions: ["electrical", "functional", "standards"],
      statuses,
      diagnostics: [
        defineDiagnostic({
          id: diagnosticId("ERC_SHORT_001"),
          severity: "error",
          dimension: "electrical",
          message: "A short circuit was detected",
          waiverPolicy: "forbidden",
        }),
      ],
    });

    expect(result.schemaVersion).toBe("1");
    expect(Object.keys(result.statuses)).toEqual([
      "fabrication",
      "electrical",
      "functional",
      "standards",
      "sourcing",
    ]);
    expect(JSON.parse(JSON.stringify(result)).statuses).toEqual(statuses);
  });

  test("preserves bounded diagnostic omission counts through command-result normalization", () => {
    const references = Array.from({ length: 300 }, (_, index) => `object-${index}`);
    const diagnostic = defineDiagnostic({
      id: diagnosticId("ERC_BOUNDED_RESULT_001"),
      severity: "error",
      dimension: "electrical",
      message: "Many electrical findings",
      waiverPolicy: "forbidden",
      objects: references,
      evidence: references.map((value) => `circuit-json:${value}`),
    });
    const result = commandResult({
      command: "fulmetry check",
      runId: "bounded-result",
      exitClassification: "failure",
      requestedDimensions: ["electrical"],
      statuses: statusSet({
        fabrication: assuranceStatus("fabrication", "not-run"),
        electrical: assuranceStatus("electrical", "failed", {
          diagnosticIds: [diagnostic.id],
        }),
        functional: assuranceStatus("functional", "not-run"),
        standards: assuranceStatus("standards", "not-run"),
        sourcing: sourcingStatus("unchecked"),
      }),
      diagnostics: [diagnostic],
    });

    expect(result.exitClassification).toBe("failure");
    expect(result.diagnostics[0]?.objects).toHaveLength(256);
    expect(result.diagnostics[0]?.omittedObjectCount).toBe(44);
    expect(result.diagnostics[0]?.omittedEvidenceCount).toBe(44);
  });

  test("keeps the command outcome distinct from all board status dimensions", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "not-run"),
      electrical: assuranceStatus("electrical", "not-run"),
      functional: assuranceStatus("functional", "unavailable"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });
    const result = commandResult({
      command: "fulmetry simulate power.testbench.ts",
      runId: "run-002",
      exitClassification: "unavailable",
      requestedDimensions: ["functional"],
      statuses,
    });

    expect(result.exitClassification).toBe("unavailable");
    expect(result.statuses.fabrication.state).toBe("not-run");
    expect(result.statuses.electrical.state).toBe("not-run");
  });

  test("compact output preserves non-passing dimensions and actionable findings", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "failed"),
      electrical: assuranceStatus("electrical", "passed"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });
    const result = commandResult({
      command: "fulmetry verify manufacturing",
      runId: "run-003",
      exitClassification: "failure",
      requestedDimensions: ["fabrication", "electrical"],
      statuses,
      diagnostics: [
        defineDiagnostic({
          id: diagnosticId("PCB_DRILL_001"),
          severity: "error",
          dimension: "fabrication",
          message: "Drill file is missing",
          waiverPolicy: "forbidden",
          nextCommand: "fulmetry explain PCB_DRILL_001",
        }),
      ],
    });

    const output = formatCompactResult(result);
    expect(output).toContain("FAILURE fulmetry verify manufacturing: 1 errors, 0 warnings");
    expect(output).toContain("fabrication: failed");
    expect(output).toContain("electrical: passed");
    expect(output).toContain("functional: not-run");
    expect(output).toContain("standards: not-run");
    expect(output).toContain("sourcing: unchecked");
    expect(output).toContain("Inspect: fulmetry explain PCB_DRILL_001");
  });

  test("rejects success when a requested status dimension failed", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "failed"),
      electrical: assuranceStatus("electrical", "failed"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });

    expect(() =>
      commandResult({
        command: "fulmetry verify manufacturing",
        runId: "run-false-pass",
        exitClassification: "success",
        requestedDimensions: ["fabrication", "electrical"],
        statuses,
      }),
    ).toThrow("cannot contain requested fabrication status failed");

    expect(() =>
      commandResult({
        command: "fulmetry verify manufacturing",
        runId: "run-warning-false-pass",
        exitClassification: "warning-only",
        requestedDimensions: ["fabrication", "electrical"],
        statuses,
      }),
    ).toThrow("cannot contain requested fabrication status failed");
  });

  test("requires warning-only for requested constrained sourcing", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "not-run"),
      electrical: assuranceStatus("electrical", "not-run"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("constrained"),
    });

    expect(() => commandResult({
      command: "fulmetry inspect",
      runId: "hidden-constrained-sourcing",
      exitClassification: "success",
      requestedDimensions: ["sourcing"],
      statuses,
    })).toThrow("cannot hide requested warning or waiver evidence");

    expect(commandResult({
      command: "fulmetry inspect",
      runId: "visible-constrained-sourcing",
      exitClassification: "warning-only",
      requestedDimensions: ["sourcing"],
      statuses,
    }).exitClassification).toBe("warning-only");
  });

  test("rejects a passing requested outcome that still contains an active error", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "passed"),
      electrical: assuranceStatus("electrical", "passed"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });
    const activeError = defineDiagnostic({
      id: diagnosticId("ERC_SHORT_002"),
      severity: "error",
      dimension: "electrical",
      message: "A short circuit was detected",
      waiverPolicy: "forbidden",
    });

    for (const exitClassification of ["success", "warning-only"] as const) {
      expect(() => commandResult({
        command: "fulmetry check",
        runId: `run-active-error-${exitClassification}`,
        exitClassification,
        requestedDimensions: ["electrical"],
        statuses,
        diagnostics: [activeError],
      })).toThrow("cannot contain active requested-dimension error ERC_SHORT_002");
    }
  });

  test("requires every status diagnostic id to resolve to unambiguous same-dimension evidence", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "failed", {
        diagnosticIds: ["PCB_CLEARANCE_004"],
      }),
      electrical: assuranceStatus("electrical", "not-run"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });
    const wrongDimension = defineDiagnostic({
      id: diagnosticId("PCB_CLEARANCE_004"),
      severity: "error",
      dimension: "electrical",
      message: "Wrongly attributed evidence",
      waiverPolicy: "forbidden",
    });

    expect(() => commandResult({
      command: "fulmetry check",
      runId: "run-missing-evidence",
      exitClassification: "failure",
      requestedDimensions: ["fabrication"],
      statuses,
    })).toThrow("without matching evidence in that dimension");
    expect(() => commandResult({
      command: "fulmetry check",
      runId: "run-wrong-dimension-evidence",
      exitClassification: "failure",
      requestedDimensions: ["fabrication"],
      statuses,
      diagnostics: [wrongDimension],
    })).toThrow("without matching evidence in that dimension");
    expect(commandResult({
      command: "fulmetry check",
      runId: "run-repeated-rule-occurrences",
      exitClassification: "failure",
      requestedDimensions: ["fabrication"],
      statuses,
      diagnostics: [
        defineDiagnostic({
          ...wrongDimension,
          dimension: "fabrication",
        }),
        defineDiagnostic({
          ...wrongDimension,
          dimension: "fabrication",
        }),
      ],
    }).diagnostics).toHaveLength(2);
    expect(() => commandResult({
      command: "fulmetry check",
      runId: "run-cross-dimension-rule-reuse",
      exitClassification: "failure",
      requestedDimensions: ["fabrication"],
      statuses,
      diagnostics: [
        wrongDimension,
        defineDiagnostic({ ...wrongDimension, dimension: "fabrication" }),
      ],
    })).toThrow("across status dimensions");
  });

  test("does not upgrade warnings or waivers to success at the result boundary", () => {
    const passed = statusSet({
      fabrication: assuranceStatus("fabrication", "passed"),
      electrical: assuranceStatus("electrical", "passed"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });
    const warning = defineDiagnostic({
      id: diagnosticId("ERC_UNUSED_PIN_002"),
      severity: "warning",
      dimension: "electrical",
      message: "A pin is unused",
      waiverPolicy: "allowed",
    });
    const waived = defineDiagnostic({
      id: diagnosticId("ERC_UNUSED_PIN_003"),
      severity: "error",
      dimension: "electrical",
      message: "A scoped electrical exception was accepted",
      waiverPolicy: "allowed",
      disposition: "waived",
      resolution: { scope: "U1.8", justification: "Reserved pin" },
    });

    for (const diagnostic of [warning, waived]) {
      expect(() => commandResult({
        command: "fulmetry check",
        runId: `run-hidden-${diagnostic.id}`,
        exitClassification: "success",
        requestedDimensions: ["electrical"],
        statuses: passed,
        diagnostics: [diagnostic],
      })).toThrow("cannot hide requested warning or waiver evidence");
    }
    expect(() => commandResult({
      command: "fulmetry check",
      runId: "run-empty-warning",
      exitClassification: "warning-only",
      requestedDimensions: ["electrical"],
      statuses: passed,
    })).toThrow("requires requested warning or waiver evidence");
  });

  test("requires passed-with-waivers status ids to name resolved waiver evidence", () => {
    const active = defineDiagnostic({
      id: diagnosticId("ERC_UNUSED_PIN_004"),
      severity: "warning",
      dimension: "electrical",
      message: "A pin is unused",
      waiverPolicy: "allowed",
    });
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "passed"),
      electrical: assuranceStatus("electrical", "passed-with-waivers", {
        diagnosticIds: [active.id],
      }),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });

    expect(() => commandResult({
      command: "fulmetry check",
      runId: "run-fake-waiver",
      exitClassification: "warning-only",
      requestedDimensions: ["electrical"],
      statuses,
      diagnostics: [active],
    })).toThrow("requires waived or suppressed evidence");
  });

  test("allows a successful inspection without claiming failed board statuses", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "failed"),
      electrical: assuranceStatus("electrical", "failed"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });

    const result = commandResult({
      command: "fulmetry inspect R12",
      runId: "run-inspect",
      exitClassification: "success",
      requestedDimensions: [],
      statuses,
    });

    expect(result.exitClassification).toBe("success");
    expect(result.statuses.fabrication.state).toBe("failed");
  });

  test("validates and deep-copies diagnostics at an untyped result boundary", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "failed"),
      electrical: assuranceStatus("electrical", "not-run"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    });
    const raw = {
      id: diagnosticId("PCB_CLEARANCE_003"),
      severity: "error" as const,
      dimension: "fabrication" as const,
      message: "Clearance is too small",
      waiverPolicy: "forbidden" as const,
      disposition: "active" as const,
      objects: ["R1.1"],
      sourceLocations: ["board.tsx:10:3"],
      measurement: { actual: "0.1 mm" },
    };
    const result = commandResult({
      command: "fulmetry check",
      runId: "run-copy",
      exitClassification: "failure",
      requestedDimensions: ["fabrication"],
      statuses,
      diagnostics: [raw],
    });
    raw.objects[0] = "mutated";
    raw.measurement.actual = "999 mm";
    expect(result.diagnostics[0]?.objects[0]).toBe("R1.1");
    expect(result.diagnostics[0]?.measurement?.actual).toBe("0.1 mm");

    expect(() =>
      commandResult({
        command: "fulmetry check",
        runId: "run-invalid",
        exitClassification: "failure",
        requestedDimensions: ["fabrication"],
        statuses,
        diagnostics: [{ ...raw, severity: "panic" as never }],
      }),
    ).toThrow("Unknown diagnostic severity");
  });
});
