// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { defineDiagnostic, diagnosticId } from "../src/diagnostics";
import { assuranceStatus, statusSet, unassessedStatusSet } from "../src/status";
import { applyDeclaredWaivers, type DeclaredWaiver } from "../src/waivers";

function declaration(
  scope: string,
  overrides: Partial<DeclaredWaiver> = {},
): Readonly<DeclaredWaiver> {
  return Object.freeze({
    diagnosticId: "FAB_COMPONENT_OVERLAP_001",
    dimension: "fabrication",
    scope,
    justification: "A fabricator reviewed this exact occurrence.",
    declarationPath: "waivers/fabrication.json",
    declarationIndex: scope === "component-a" ? 0 : 1,
    ...overrides,
  });
}

function fixture(waiverPolicy: "allowed" | "forbidden" = "allowed") {
  const diagnostic = defineDiagnostic({
    id: diagnosticId("FAB_COMPONENT_OVERLAP_001"),
    severity: "error",
    dimension: "fabrication",
    message: "Component bodies overlap",
    waiverPolicy,
    objects: ["component-a", "component-b"],
    sourceLocations: ["circuit/board.ts:10:3"],
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_COMPONENT_OVERLAP_001",
  });
  return {
    diagnostic,
    statuses: statusSet({
      ...unassessedStatusSet(),
      fabrication: assuranceStatus("fabrication", "failed", {
        diagnosticIds: [diagnostic.id],
      }),
    }),
  };
}

describe("source-controlled waiver application", () => {
  test("requires every occurrence before changing a failed dimension to passed-with-waivers", () => {
    const { diagnostic, statuses } = fixture();
    const partial = applyDeclaredWaivers({
      diagnostics: [diagnostic],
      statuses,
      declarations: [declaration("component-a")],
      evaluationDate: "2026-08-12",
    });
    expect(partial.statuses.fabrication.state).toBe("failed");
    expect(partial.diagnostics.map(({ disposition, objects }) => [disposition, objects])).toEqual([
      ["waived", ["component-a"]],
      ["active", ["component-b"]],
    ]);

    const complete = applyDeclaredWaivers({
      diagnostics: [diagnostic],
      statuses,
      declarations: [declaration("component-a"), declaration("component-b")],
      evaluationDate: "2026-08-12",
    });
    expect(complete.statuses.fabrication.state).toBe("passed-with-waivers");
    expect(complete.diagnostics.every(({ disposition }) => disposition === "waived")).toBeTrue();
  });

  test("rejects non-waivable, expired, and non-matching declarations", () => {
    const forbidden = fixture("forbidden");
    expect(() => applyDeclaredWaivers({
      diagnostics: [forbidden.diagnostic],
      statuses: forbidden.statuses,
      declarations: [declaration("component-a")],
      evaluationDate: "2026-08-12",
    })).toThrow("targets a non-waivable diagnostic");

    const allowed = fixture();
    expect(() => applyDeclaredWaivers({
      diagnostics: [allowed.diagnostic],
      statuses: allowed.statuses,
      declarations: [declaration("component-a", { expiresAt: "2026-08-11" })],
      evaluationDate: "2026-08-12",
    })).toThrow("expired on 2026-08-11");
    expect(() => applyDeclaredWaivers({
      diagnostics: [allowed.diagnostic],
      statuses: allowed.statuses,
      declarations: [declaration("component-missing")],
      evaluationDate: "2026-08-12",
    })).toThrow("does not match one active diagnostic occurrence");
  });
});
