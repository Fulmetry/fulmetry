import { describe, expect, test } from "bun:test";
import {
  assuranceStatus,
  isAssurancePassing,
  sourcingStatus,
  statusSet,
  unassessedStatusSet,
} from "../src/status";

describe("independent status dimensions", () => {
  test("starts every assurance dimension unassessed and sourcing unchecked", () => {
    expect(unassessedStatusSet()).toEqual({
      fabrication: {
        dimension: "fabrication",
        state: "not-run",
        diagnosticIds: [],
      },
      electrical: {
        dimension: "electrical",
        state: "not-run",
        diagnosticIds: [],
      },
      functional: {
        dimension: "functional",
        state: "not-run",
        diagnosticIds: [],
      },
      standards: {
        dimension: "standards",
        state: "not-run",
        diagnosticIds: [],
      },
      sourcing: {
        dimension: "sourcing",
        state: "unchecked",
        diagnosticIds: [],
      },
    });
  });

  test("does not infer fabrication failure from unavailable functionality or sourcing", () => {
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "passed"),
      electrical: assuranceStatus("electrical", "passed"),
      functional: assuranceStatus("functional", "unavailable", {
        diagnosticIds: ["SIM_TOOL_001"],
      }),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unavailable", {
        diagnosticIds: ["PART_STOCK_001"],
      }),
    });

    expect(statuses.fabrication.state).toBe("passed");
    expect(statuses.functional.state).toBe("unavailable");
    expect(statuses.sourcing.state).toBe("unavailable");
  });

  test("keeps passed-with-waivers visible while recognizing dimension-level passage", () => {
    const status = assuranceStatus("electrical", "passed-with-waivers", {
      diagnosticIds: ["ERC_UNUSED_PIN_001"],
    });

    expect(isAssurancePassing(status)).toBe(true);
    expect(status.state).toBe("passed-with-waivers");
    expect(JSON.stringify(status)).toContain("passed-with-waivers");
  });

  test("rejects waiver passage without corresponding diagnostic evidence", () => {
    expect(() =>
      assuranceStatus("fabrication", "passed-with-waivers"),
    ).toThrow("requires at least one waived diagnostic identifier");
  });

  test("rejects invented runtime states", () => {
    expect(() =>
      assuranceStatus("fabrication", "certified" as never),
    ).toThrow("Unknown assurance state");
    expect(() => sourcingStatus("in-stock-forever" as never)).toThrow(
      "Unknown sourcing state",
    );
  });

  test("rejects a status placed in the wrong dimension slot at an untyped boundary", () => {
    const malformed = {
      ...unassessedStatusSet(),
      fabrication: assuranceStatus("electrical", "passed"),
    };

    expect(() => statusSet(malformed as never)).toThrow(
      'Status slot "fabrication" contains "electrical"',
    );
  });

  test("copies diagnostic identifiers so caller mutation cannot change status evidence", () => {
    const ids = ["PCB_CLEARANCE_001"];
    const status = assuranceStatus("fabrication", "failed", {
      diagnosticIds: ids,
    });
    ids.push("PCB_DRILL_002");

    expect(status.diagnosticIds).toEqual(["PCB_CLEARANCE_001"]);
  });

  test("deduplicates stable rule ids while occurrence diagnostics remain separate", () => {
    expect(assuranceStatus("fabrication", "failed", {
      diagnosticIds: ["PCB_CLEARANCE_001", "PCB_CLEARANCE_001"],
    }).diagnosticIds).toEqual(["PCB_CLEARANCE_001"]);
    expect(sourcingStatus("constrained", {
      diagnosticIds: ["PART_STOCK_001", "PART_STOCK_001"],
    }).diagnosticIds).toEqual(["PART_STOCK_001"]);
  });

  test("deep-copies statuses crossing an untyped boundary", () => {
    const fabrication = {
      dimension: "fabrication",
      state: "failed",
      diagnosticIds: ["PCB_CLEARANCE_001"],
    };
    const statuses = statusSet({
      ...unassessedStatusSet(),
      fabrication,
    } as never);

    fabrication.state = "passed";
    fabrication.diagnosticIds.push("PCB_DRILL_001");

    expect(statuses.fabrication.state).toBe("failed");
    expect(statuses.fabrication.diagnosticIds).toEqual(["PCB_CLEARANCE_001"]);
  });
});
