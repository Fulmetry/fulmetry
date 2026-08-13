import { describe, expect, test } from "bun:test";
import {
  canonicalTscircuitUpgradeReportJson,
  createTscircuitUpgradeAcceptanceBinding,
  createTscircuitUpgradeReview,
  requireAcceptedTscircuitUpgrade,
  tscircuitUpgradeFileSetSha256,
  tscircuitUpgradeReportSha256,
} from "../src/upstream-upgrade";

const digest = (character: string): string => character.repeat(64);
const sri = (byte: number): string => `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
const EXPECTED_FIXTURES = Object.freeze(["board"] as const);
const REVIEW_AUTHORITY = Object.freeze({
  reviewImplementationSha256: digest("c"),
  baselineAnchorSha256: digest("d"),
  bunVersion: "1.3.14",
});

function qualification() {
  return {
    curatedExportIdentity: "passed",
    mixedImportSemanticEquivalence: "passed",
    deterministicDoubleEvaluation: "passed",
    circuitJsonSchemaValidation: "passed",
    independentManufacturingVerification: "passed",
  } as const;
}

function file(path: string, character: string, size = 10): { path: string; size: number; sha256: string } {
  return { path, size, sha256: digest(character) };
}

function fileSet(files: readonly { path: string; size: number; sha256: string }[]) {
  return { files: [...files], setSha256: tscircuitUpgradeFileSetSha256(files) };
}

function fixture(
  name: string,
  options: {
    semantic?: string;
    inputs?: readonly { path: string; size: number; sha256: string }[];
    manufacturing?: readonly { path: string; size: number; sha256: string }[];
  } = {},
) {
  const inputs = options.inputs ?? [file("circuit/board.tsx", "1"), file("pcboo.lock", "2")];
  const manufacturing = options.manufacturing ?? [
    file("board-F_Cu.gbr", "3", 30),
    file("board.drl", "4", 40),
  ];
  return {
    name,
    inputs: fileSet(inputs),
    semanticSha256: digest(options.semantic ?? "5"),
    manufacturing: fileSet(manufacturing),
  };
}

function snapshot(
  version: string,
  fixtures = [fixture("board")],
  contentCharacter = "6",
) {
  return {
    schemaVersion: 2,
    engine: {
      version,
      integrity: version === "0.0.2261" ? sri(1) : sri(2),
      contentSha256: digest(contentCharacter),
      dependencyLockSha256: version === "0.0.2261" ? digest("e") : digest("f"),
      runtimePlatform: "darwin-arm64",
      runtimeClosureSha256: version === "0.0.2261" ? digest("a") : digest("b"),
      packedConsumerRuntimeClosureSha256: version === "0.0.2261" ? digest("c") : digest("d"),
    },
    qualification: qualification(),
    fixtures,
  };
}

function candidateSnapshot() {
  return snapshot("0.0.2262", [fixture("board", {
    semantic: "7",
    inputs: [file("circuit/board.tsx", "8"), file("pcboo.lock", "2")],
    manufacturing: [file("board-B_Cu.gbr", "9", 31), file("board-F_Cu.gbr", "a", 32)],
  })], "b");
}

describe("tscircuit upgrade review", () => {
  test("reports exact engine identities and per-fixture semantic, input, and artifact deltas", () => {
    const report = createTscircuitUpgradeReview(snapshot("0.0.2261"), candidateSnapshot(), {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    });

    expect(report.baseline.engine).toEqual(expect.objectContaining({
      version: "0.0.2261",
      contentSha256: digest("6"),
      integrity: sri(1),
      identitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
    expect(report.candidate.engine.version).toBe("0.0.2262");
    expect(report.outcome).toBe("changes-require-review");
    expect(report.expectedFixtureNames).toEqual(EXPECTED_FIXTURES);
    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]).toEqual(expect.objectContaining({
      name: "board",
      status: "changed",
      semantic: {
        baselineSha256: digest("5"),
        candidateSha256: digest("7"),
        changed: true,
      },
    }));
    expect(report.fixtures[0]?.inputs.changed).toEqual([
      {
        path: "circuit/board.tsx",
        baseline: { size: 10, sha256: digest("1") },
        candidate: { size: 10, sha256: digest("8") },
      },
    ]);
    expect(report.fixtures[0]?.manufacturing.added.map(({ path }) => path)).toEqual(["board-B_Cu.gbr"]);
    expect(report.fixtures[0]?.manufacturing.removed.map(({ path }) => path)).toEqual(["board.drl"]);
    expect(report.fixtures[0]?.manufacturing.changed.map(({ path }) => path)).toEqual(["board-F_Cu.gbr"]);
    expect(report.reportSha256).toBe(tscircuitUpgradeReportSha256(report));
  });

  test("rejects coordinated pin and golden changes until the exact report is bound", () => {
    const baseline = snapshot("0.0.2261");
    const candidate = candidateSnapshot();
    const report = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    });

    expect(() => requireAcceptedTscircuitUpgrade({
      baseline,
      candidate,
      report,
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow(
      "acceptance binding is required",
    );

    expect(() => createTscircuitUpgradeAcceptanceBinding(report, {
      reviewedReportSha256: digest("f"),
    })).toThrow("does not match");
    const binding = createTscircuitUpgradeAcceptanceBinding(report, {
      reviewedReportSha256: report.reportSha256,
    });
    expect(() => requireAcceptedTscircuitUpgrade({
      baseline,
      candidate,
      report,
      binding,
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow("explicit reviewedReportSha256 is required");
    expect(() => requireAcceptedTscircuitUpgrade({
      baseline,
      candidate,
      report,
      binding,
      reviewedReportSha256: digest("f"),
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow("reviewedReportSha256 does not match");
    expect(requireAcceptedTscircuitUpgrade({
      baseline,
      candidate,
      report,
      binding,
      reviewedReportSha256: report.reportSha256,
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toEqual(report);
  });

  test("rejects a stale report and binding after any candidate engine, input, or artifact identity changes", () => {
    const baseline = snapshot("0.0.2261");
    const candidate = candidateSnapshot();
    const originalReport = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    });
    const staleBinding = createTscircuitUpgradeAcceptanceBinding(originalReport, {
      reviewedReportSha256: originalReport.reportSha256,
    });

    const changedEngine = structuredClone(candidate);
    changedEngine.engine.version = "0.0.2263";

    const changedInput = structuredClone(candidate);
    changedInput.fixtures[0]!.inputs.files[0]!.sha256 = digest("c");
    changedInput.fixtures[0]!.inputs.setSha256 = tscircuitUpgradeFileSetSha256(
      changedInput.fixtures[0]!.inputs.files,
    );

    const changedArtifact = structuredClone(candidate);
    changedArtifact.fixtures[0]!.manufacturing.files[0]!.size += 1;
    changedArtifact.fixtures[0]!.manufacturing.setSha256 = tscircuitUpgradeFileSetSha256(
      changedArtifact.fixtures[0]!.manufacturing.files,
    );

    for (const changedCandidate of [changedEngine, changedInput, changedArtifact]) {
      expect(() => requireAcceptedTscircuitUpgrade({
        baseline,
        candidate: changedCandidate,
        report: originalReport,
        binding: staleBinding,
        reviewedReportSha256: originalReport.reportSha256,
        expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      })).toThrow("does not match the exact baseline and candidate snapshots");

      const freshReport = createTscircuitUpgradeReview(baseline, changedCandidate, {
        expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      });
      expect(() => requireAcceptedTscircuitUpgrade({
        baseline,
        candidate: changedCandidate,
        report: freshReport,
        binding: staleBinding,
        reviewedReportSha256: freshReport.reportSha256,
        expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      })).toThrow("acceptance binding is stale");
    }
  });

  test("rejects report tampering even when an attacker recomputes the report digest", () => {
    const baseline = snapshot("0.0.2261");
    const candidate = candidateSnapshot();
    const report = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    });
    const binding = createTscircuitUpgradeAcceptanceBinding(report, {
      reviewedReportSha256: report.reportSha256,
    });
    const tampered = structuredClone(report) as unknown as {
      fixtures: Array<{ semantic: { candidateSha256: string } }>;
      reportSha256: string;
    };
    tampered.fixtures[0]!.semantic.candidateSha256 = digest("d");

    expect(() => requireAcceptedTscircuitUpgrade({
      baseline,
      candidate,
      report: tampered,
      binding,
      reviewedReportSha256: report.reportSha256,
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    }))
      .toThrow("report digest does not match");

    tampered.reportSha256 = tscircuitUpgradeReportSha256(tampered);
    expect(() => requireAcceptedTscircuitUpgrade({
      baseline,
      candidate,
      report: tampered,
      binding,
      reviewedReportSha256: tampered.reportSha256,
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    }))
      .toThrow("does not match the exact baseline and candidate snapshots");
  });

  test("rejects duplicate fixture names and duplicate paths before comparison", () => {
    const baseline = snapshot("0.0.2261");
    const duplicateFixture = snapshot("0.0.2262", [fixture("board"), fixture("board")], "b");
    expect(() => createTscircuitUpgradeReview(baseline, duplicateFixture, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow("duplicate fixture board");

    const repeated = [file("board-F_Cu.gbr", "1"), file("board-F_Cu.gbr", "2")];
    const duplicatePath = snapshot("0.0.2262", [fixture("board", { manufacturing: repeated })], "b");
    expect(() => createTscircuitUpgradeReview(baseline, duplicatePath, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow(
      "duplicate path board-F_Cu.gbr",
    );
  });

  test("rejects traversal and non-canonical paths in input or artifact evidence", () => {
    const baseline = snapshot("0.0.2261");
    const traversalInput = snapshot("0.0.2262", [fixture("board", {
      inputs: [file("../outside.tsx", "1")],
    })], "b");
    expect(() => createTscircuitUpgradeReview(baseline, traversalInput, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow("must not traverse");

    const windowsArtifact = snapshot("0.0.2262", [fixture("board", {
      manufacturing: [file("manufacturing\\board.gbr", "1")],
    })], "b");
    expect(() => createTscircuitUpgradeReview(baseline, windowsArtifact, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow(
      "must be a canonical relative path",
    );
  });

  test("normalizes fixture and file order into byte-identical reports", () => {
    const alpha = fixture("alpha", {
      inputs: [file("z.tsx", "1"), file("a.tsx", "2")],
      manufacturing: [file("z.gbr", "3"), file("a.gbr", "4")],
    });
    const beta = fixture("beta", {
      inputs: [file("y.tsx", "5"), file("b.tsx", "6")],
      manufacturing: [file("y.gbr", "a"), file("b.gbr", "b")],
    });
    const ordered = snapshot("0.0.2261", [alpha, beta]);
    const shuffled = structuredClone(ordered);
    shuffled.fixtures.reverse();
    for (const item of shuffled.fixtures) {
      item.inputs.files.reverse();
      item.manufacturing.files.reverse();
    }

    const candidate = snapshot("0.0.2262", [structuredClone(alpha), structuredClone(beta)], "b");
    const expectedFixtureNames = ["alpha", "beta"];
    const first = createTscircuitUpgradeReview(ordered, candidate, { expectedFixtureNames, ...REVIEW_AUTHORITY });
    const second = createTscircuitUpgradeReview(shuffled, candidate, { expectedFixtureNames, ...REVIEW_AUTHORITY });
    expect(second).toEqual(first);
    expect(canonicalTscircuitUpgradeReportJson(second)).toBe(canonicalTscircuitUpgradeReportJson(first));
  });

  test("fails closed when a declared file-set digest does not match its records", () => {
    const candidate = candidateSnapshot();
    candidate.fixtures[0]!.manufacturing.setSha256 = digest("f");
    expect(() => createTscircuitUpgradeReview(snapshot("0.0.2261"), candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow(
      "setSha256 does not match its file records",
    );
  });

  test("requires the exact explicit fixture inventory on both sides", () => {
    const baseline = snapshot("0.0.2261");
    const candidate = candidateSnapshot();
    expect(() => createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: ["board", "plated-hole-4layer"],
      ...REVIEW_AUTHORITY,
    })).toThrow("missing: plated-hole-4layer");
    expect(() => createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: ["different-board"],
      ...REVIEW_AUTHORITY,
    })).toThrow(/missing: different-board.*extra: board/u);
    expect(() => createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: ["board", "board"],
      ...REVIEW_AUTHORITY,
    })).toThrow("duplicate fixture board");
  });

  test("requires every exact qualification to be literal passed", () => {
    const baseline = snapshot("0.0.2261");
    const missing = structuredClone(candidateSnapshot()) as Record<string, any>;
    delete missing.qualification.curatedExportIdentity;
    expect(() => createTscircuitUpgradeReview(baseline, missing, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow("qualification fields must be exactly");

    const failed = structuredClone(candidateSnapshot()) as Record<string, any>;
    failed.qualification.independentManufacturingVerification = "failed";
    expect(() => createTscircuitUpgradeReview(baseline, failed, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow("independentManufacturingVerification must be literal passed");

    const extra = structuredClone(candidateSnapshot()) as Record<string, any>;
    extra.qualification.unreviewedCheck = "passed";
    expect(() => createTscircuitUpgradeReview(baseline, extra, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    })).toThrow("qualification fields must be exactly");
  });

  test("rejects non-canonical semver, malformed SRI, and ASCII controls in paths", () => {
    for (const version of ["01.2.3", "1.2.3-..", "1.2.3-alpha."]) {
      const candidate = candidateSnapshot();
      candidate.engine.version = version;
      expect(() => createTscircuitUpgradeReview(snapshot("0.0.2261"), candidate, {
        expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      }), version).toThrow("exact semantic version");
    }

    const canonical = Buffer.alloc(64).toString("base64");
    const nonCanonical = `${canonical.slice(0, -3)}B==`;
    for (const integrity of ["sha512-YQ==", `sha512-${nonCanonical}`, "sha512-not_base64!"]) {
      const candidate = candidateSnapshot();
      candidate.engine.integrity = integrity;
      expect(() => createTscircuitUpgradeReview(snapshot("0.0.2261"), candidate, {
        expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      }), integrity).toThrow(/canonical|64-byte/u);
    }

    for (const control of ["\n", "\t", "\u007f"]) {
      const candidate = snapshot("0.0.2262", [fixture("board", {
        inputs: [file(`circuit/${control}board.tsx`, "1")],
      })], "b");
      expect(() => createTscircuitUpgradeReview(snapshot("0.0.2261"), candidate, {
        expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      })).toThrow("canonical relative path");
    }
  });

  test("reports no-change only when the complete snapshots are identical", () => {
    const baseline = snapshot("0.0.2261");
    const report = createTscircuitUpgradeReview(baseline, structuredClone(baseline), {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    });
    expect(report.outcome).toBe("no-change");
    expect(report.fixtures.map(({ status }) => status)).toEqual(["unchanged"]);
    expect(Object.isFrozen(report.expectedFixtureNames)).toBeTrue();
    expect(Object.isFrozen(report.baseline.qualification)).toBeTrue();

    const engineOnlyChange = snapshot("0.0.2262", structuredClone(baseline.fixtures), "6");
    expect(createTscircuitUpgradeReview(baseline, engineOnlyChange, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    }).outcome).toBe("changes-require-review");
  });

  test("binds dependency lock, review implementation, baseline anchor, and Bun runtime into report identity", () => {
    const baseline = snapshot("0.0.2261");
    const candidate = candidateSnapshot();
    const original = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    });
    const changedLock = structuredClone(candidate);
    changedLock.engine.dependencyLockSha256 = digest("9");
    const lockReport = createTscircuitUpgradeReview(baseline, changedLock, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
    });
    const implementationReport = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      reviewImplementationSha256: digest("a"),
    });
    const anchorReport = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      baselineAnchorSha256: digest("b"),
    });
    const runtimeReport = createTscircuitUpgradeReview(baseline, candidate, {
      expectedFixtureNames: EXPECTED_FIXTURES,
      ...REVIEW_AUTHORITY,
      bunVersion: "1.3.15",
    });

    expect(new Set([
      original.reportSha256,
      lockReport.reportSha256,
      implementationReport.reportSha256,
      anchorReport.reportSha256,
      runtimeReport.reportSha256,
    ]).size).toBe(5);
    expect(original.reviewImplementationSha256).toBe(REVIEW_AUTHORITY.reviewImplementationSha256);
    expect(original.baselineAnchorSha256).toBe(REVIEW_AUTHORITY.baselineAnchorSha256);
    expect(original.bunVersion).toBe(REVIEW_AUTHORITY.bunVersion);
  });
});
