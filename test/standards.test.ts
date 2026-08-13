import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import {
  deriveManufacturingExpectation,
  manufacturingExpectationSha256,
} from "../src/manufacturing/expectation";
import { verifyManufacturingDirectory } from "../src/manufacturing/verify";
import { assessCircuitFabrication } from "../src/fabrication";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import { assuranceStatus } from "../src/status";
import { assessBaselinePreCompliance } from "../src/standards";
import { loadDeclaredWaivers } from "../src/waivers";
import { manufacturingFixture } from "./fixtures/manufacturing";

const roots: string[] = [];

async function emittedVerification(circuitJson: Awaited<ReturnType<typeof manufacturingFixture>>) {
  const parent = await mkdtemp(join(tmpdir(), "pcboo-standards-"));
  roots.push(parent);
  const root = join(parent, "manufacturing");
  await emitDraftManufacturingDirectory({
    targetDirectory: root,
    files: await exportManufacturingFiles({ boardName: "standards", circuitJson }),
  });
  const verification = await verifyManufacturingDirectory({
    root,
    expectation: deriveManufacturingExpectation({ boardName: "standards", circuitJson }),
    circuitJson,
  });
  return { root, verification };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded built-in pre-compliance evidence", () => {
  test("rejects empty structural lookalikes that claim independent verification passed", async () => {
    const circuitJson = await manufacturingFixture(2);
    const assessment = assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: {
        passed: true,
        parser: "gerber-parser@4.2.7",
        expectation: { boardName: "forged", sha256: "0".repeat(64) },
        findings: [],
        artifacts: [],
      },
    });

    expect(assessment.status.state).toBe("failed");
    expect(assessment.evidence).toMatchObject({
      outcome: "profile-failed",
      evidence: {
        verificationAuthority: "untrusted-input",
        expectationBinding: "untrusted",
        independentParser: "unverified",
        independentlyParsedManufacturingArtifacts: "failed",
      },
    });
    expect(assessment.evidence.findings.map(({ code }) => code)).toContain(
      "INDEPENDENT_MANUFACTURING_EVIDENCE_UNAUTHENTICATED",
    );
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain(
      "STD_PROFILE_MANUFACTURING_EVIDENCE_UNAUTHENTICATED_001",
    );
  });

  test("rejects copied or internally modified verifier results without issuer identity", async () => {
    const circuitJson = await manufacturingFixture(2);
    const { verification } = await emittedVerification(circuitJson);
    expect(verification.passed).toBeTrue();
    const copied = {
      ...structuredClone(verification),
      artifacts: verification.artifacts.slice(1),
    };

    const assessment = assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: copied,
    });

    expect(assessment.status.state).toBe("failed");
    expect(assessment.evidence.evidence.verificationAuthority).toBe("untrusted-input");
    expect(assessment.evidence.evidence.independentlyParsedManufacturingArtifacts).toBe("failed");
  });

  test("rejects replaying an authentic passing verifier result against another board", async () => {
    const twoLayer = await manufacturingFixture(2);
    const fourLayer = await manufacturingFixture(4);
    const { verification } = await emittedVerification(twoLayer);

    const assessment = assessBaselinePreCompliance({
      circuitJson: fourLayer,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
    });

    expect(assessment.status.state).toBe("failed");
    expect(assessment.evidence.evidence).toMatchObject({
      verificationAuthority: "pcboo-verifier-issued",
      expectationBinding: "mismatched",
      independentlyParsedManufacturingArtifacts: "failed",
    });
    expect(assessment.evidence.findings.map(({ code }) => code)).toContain(
      "INDEPENDENT_MANUFACTURING_EVIDENCE_SOURCE_MISMATCH",
    );
  });

  test("snapshots expectation identity before caller mutation during verification", async () => {
    const twoLayer = await manufacturingFixture(2);
    const fourLayer = await manufacturingFixture(4);
    const parent = await mkdtemp(join(tmpdir(), "pcboo-standards-snapshot-"));
    roots.push(parent);
    const root = join(parent, "manufacturing");
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "snapshot", circuitJson: twoLayer }),
    });
    const mutableExpectation = structuredClone(
      deriveManufacturingExpectation({ boardName: "snapshot", circuitJson: twoLayer }),
    );
    const initialExpectationSha256 = manufacturingExpectationSha256(mutableExpectation);
    const replacement = deriveManufacturingExpectation({
      boardName: "snapshot",
      circuitJson: fourLayer,
    });
    const verification = await verifyManufacturingDirectory({
      root,
      expectation: mutableExpectation,
      circuitJson: twoLayer,
      beforeFinalArtifactSnapshot: async () => {
        Object.assign(mutableExpectation, structuredClone(replacement));
      },
    });

    expect(verification.passed).toBeTrue();
    expect(verification.expectation.sha256).toBe(initialExpectationSha256);
    expect(verification.expectation.sha256).not.toBe(manufacturingExpectationSha256(replacement));
    const assessment = assessBaselinePreCompliance({
      circuitJson: fourLayer,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
    });
    expect(assessment.status.state).toBe("failed");
    expect(assessment.evidence.evidence.expectationBinding).toBe("mismatched");
  });

  test("does not trust post-import WeakSet prototype poisoning", async () => {
    const circuitJson = await manufacturingFixture(2);
    const originalHas = WeakSet.prototype.has;
    try {
      WeakSet.prototype.has = () => true;
      const assessment = assessBaselinePreCompliance({
        circuitJson,
        activeProfile: BASELINE_FABRICATION_PROFILE,
        manufacturingVerification: {
          passed: true,
          parser: "gerber-parser@4.2.7",
          expectation: { boardName: "forged", sha256: "0".repeat(64) },
          findings: [],
          artifacts: [],
        },
      });
      expect(assessment.status.state).toBe("failed");
      expect(assessment.evidence.evidence.verificationAuthority).toBe("untrusted-input");
    } finally {
      WeakSet.prototype.has = originalHas;
    }
  });

  test("records a deterministic profile pass without claiming certification", async () => {
    const circuitJson = await manufacturingFixture(4);
    const { verification } = await emittedVerification(circuitJson);
    expect(verification.passed).toBeTrue();

    const first = assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
    });
    const second = assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
    });

    expect(first.status).toMatchObject({ dimension: "standards", state: "passed" });
    expect(first.evidence).toEqual(second.evidence);
    expect(first.evidence).toMatchObject({
      kind: "pre-compliance-evidence",
      claim: "checked-against-profile",
      certification: "not-certification",
      outcome: "profile-passed",
      profile: {
        name: BASELINE_FABRICATION_PROFILE.name,
        version: BASELINE_FABRICATION_PROFILE.version,
        digest: BASELINE_FABRICATION_PROFILE.digest,
        source: BASELINE_FABRICATION_PROFILE.source,
      },
      evidence: {
        verificationAuthority: "pcboo-verifier-issued",
        expectationBinding: "matched",
        independentParser: "gerber-parser@4.2.7",
        sourceProfileRules: "passed",
        independentlyParsedManufacturingArtifacts: "passed",
      },
    });
    expect(first.evidence.disclaimer).toContain("not certification");
    expect(first.evidence.findings).toEqual([]);
    expect(first.evidence.evidence.boundedArtifactSet.length).toBeGreaterThan(10);

    const otherCircuitJson = await manufacturingFixture(2);
    const other = await emittedVerification(otherCircuitJson);
    const otherAssessment = assessBaselinePreCompliance({
      circuitJson: otherCircuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: other.verification,
    });
    expect(otherAssessment.status.state).toBe("passed");
    expect(
      otherAssessment.evidence.evidence.independentManufacturingVerificationSha256,
    ).not.toBe(first.evidence.evidence.independentManufacturingVerificationSha256);
    expect(otherAssessment.evidence.evidence.boundedArtifactSet).not.toEqual(
      first.evidence.evidence.boundedArtifactSet,
    );
  });

  test("keeps source-rule waivers explicit in the top-level standards status", async () => {
    const circuitJson = structuredClone(await manufacturingFixture(2));
    for (const sourceTrace of circuitJson.filter((element) => element.type === "source_trace")) {
      sourceTrace.min_trace_thickness = 0.1;
    }
    const trace = circuitJson.find((element) => element.type === "pcb_trace");
    if (trace?.type !== "pcb_trace") throw new Error("Fixture trace missing");
    for (const point of trace.route) {
      if (point.route_type === "wire") point.width = 0.149;
    }
    const source = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    const minimum = source.diagnostics.find(({ id }) => id === "FAB_PROFILE_MINIMUM_001");
    if (minimum === undefined || minimum.objects.length === 0) {
      throw new Error("Fixture minimum-width diagnostic missing");
    }
    const waiverRoot = await mkdtemp(join(tmpdir(), "pcboo-standards-waiver-"));
    roots.push(waiverRoot);
    const waiverPath = "waivers/fabrication.json";
    const waiverBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      waivers: minimum.objects.map((scope) => ({
        diagnosticId: minimum.id,
        dimension: "fabrication",
        scope,
        justification: "Reviewed exact trace occurrence",
      })),
    })}\n`);
    await Bun.write(join(waiverRoot, waiverPath), waiverBytes);
    const declarations = await loadDeclaredWaivers(waiverRoot, {
      schemaVersion: 1,
      digest: "test-snapshot",
      inputs: [{
        path: waiverPath,
        role: "waiver",
        size: waiverBytes.byteLength,
        sha256: new Bun.CryptoHasher("sha256").update(waiverBytes).digest("hex"),
      }],
    });
    const { verification } = await emittedVerification(circuitJson);

    const assessment = assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
      sourceWaivers: {
        declarations,
        evaluationDate: "2026-08-13",
      },
    });

    expect(assessment.status).toMatchObject({
      dimension: "standards",
      state: "passed-with-waivers",
      diagnosticIds: ["STD_PROFILE_SOURCE_RULES_WAIVED_001"],
    });
    expect(assessment.diagnostics).toContainEqual(expect.objectContaining({
      id: "STD_PROFILE_SOURCE_RULES_WAIVED_001",
      dimension: "standards",
      disposition: "waived",
    }));
    expect(assessment.evidence.outcome).toBe("profile-passed-with-waivers");

    expect(() => assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
      sourceWaivers: {
        declarations: structuredClone(declarations),
        evaluationDate: "2026-08-13",
      },
    })).toThrow("must come from PCBoo's source-controlled waiver loader");
  });

  test("fails when an independently parsed artifact is corrupted after export", async () => {
    const circuitJson = await manufacturingFixture(4);
    const { root } = await emittedVerification(circuitJson);
    await Bun.write(join(root, "gerbers/standards-In1_Cu.gbr"), "");
    const verification = await verifyManufacturingDirectory({
      root,
      expectation: deriveManufacturingExpectation({ boardName: "standards", circuitJson }),
      circuitJson,
    });
    expect(verification.passed).toBeFalse();

    const assessment = assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
    });
    expect(assessment.status.state).toBe("failed");
    expect(assessment.evidence.outcome).toBe("profile-failed");
    expect(assessment.evidence.findings.map(({ code }) => code)).toContain(
      "INDEPENDENT_MANUFACTURING_EVIDENCE_FAILED",
    );
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain(
      "STD_PROFILE_MANUFACTURING_EVIDENCE_FAILED_001",
    );
  });

  test("recomputes failed source rules and ignores a forged legacy source assessment", async () => {
    const circuitJson = structuredClone(await manufacturingFixture(2));
    const trace = circuitJson.find((element) => element.type === "pcb_trace");
    if (trace?.type !== "pcb_trace") throw new Error("Fixture trace missing");
    for (const point of trace.route) {
      if (point.route_type === "wire") point.width = 0.1;
    }
    const { verification } = await emittedVerification(circuitJson);
    expect(verification.passed).toBeTrue();

    const assessment = assessBaselinePreCompliance({
      circuitJson,
      activeProfile: BASELINE_FABRICATION_PROFILE,
      manufacturingVerification: verification,
      sourceAssessment: {
        status: assuranceStatus("fabrication", "passed"),
        diagnostics: [],
      },
    } as Parameters<typeof assessBaselinePreCompliance>[0]);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.evidence.evidence).toMatchObject({
      sourceProfileRules: "failed",
      independentlyParsedManufacturingArtifacts: "passed",
    });
    expect(assessment.evidence.findings.map(({ code }) => code)).toEqual([
      "PROFILE_SOURCE_RULES_FAILED",
    ]);
  });

  test("reports unavailable instead of claiming a check when no profile is active", async () => {
    const circuitJson = await manufacturingFixture(2);
    const { verification } = await emittedVerification(circuitJson);
    const assessment = assessBaselinePreCompliance({
      circuitJson,
      manufacturingVerification: verification,
    });

    expect(assessment.status.state).toBe("unavailable");
    expect(assessment.evidence).toMatchObject({
      claim: "not-checked-profile-unavailable",
      outcome: "profile-unavailable",
      profile: { selection: "not-selected" },
      evidence: { sourceProfileRules: "not-run" },
    });
    expect(assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "STD_PROFILE_UNAVAILABLE_001",
    ]);
  });
});
