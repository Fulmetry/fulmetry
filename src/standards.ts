// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import { canonicalCircuitJson } from "./circuit-json";
import { defineDiagnostic, diagnosticId, type Diagnostic } from "./diagnostics";
import { assessCircuitFabrication } from "./fabrication";
import {
  isVerifierIssuedManufacturingVerification,
  type ManufacturingVerification,
} from "./manufacturing/verify";
import {
  deriveManufacturingExpectation,
  manufacturingExpectationSha256,
} from "./manufacturing/expectation";
import {
  BASELINE_FABRICATION_PROFILE,
  resolveFabricationProfile,
  type ActiveFabricationProfile,
} from "./profiles/baseline";
import {
  assuranceStatus,
  sourcingStatus,
  statusSet,
  type AssuranceStatus,
} from "./status";
import {
  applyDeclaredWaivers,
  isLoadedDeclaredWaiverSet,
  type DeclaredWaiver,
} from "./waivers";

export const PRE_COMPLIANCE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const PRE_COMPLIANCE_METHOD = "pcboo-baseline-pre-compliance@1" as const;

export interface PreComplianceFinding {
  readonly code:
    | "PROFILE_UNAVAILABLE"
    | "PROFILE_SOURCE_RULES_FAILED"
    | "INDEPENDENT_MANUFACTURING_EVIDENCE_UNAUTHENTICATED"
    | "INDEPENDENT_MANUFACTURING_EVIDENCE_SOURCE_MISMATCH"
    | "INDEPENDENT_MANUFACTURING_EVIDENCE_FAILED";
  readonly message: string;
  readonly sourceDiagnosticIds: readonly string[];
  readonly manufacturingFindingCodes: readonly string[];
}

/**
 * Machine-readable evidence for a bounded profile check. This deliberately has
 * no `compliant`, `approved`, or `certified` outcome.
 */
export interface PreComplianceEvidence {
  readonly schemaVersion: typeof PRE_COMPLIANCE_EVIDENCE_SCHEMA_VERSION;
  readonly kind: "pre-compliance-evidence";
  readonly method: typeof PRE_COMPLIANCE_METHOD;
  readonly claim: "checked-against-profile" | "not-checked-profile-unavailable";
  readonly certification: "not-certification";
  readonly outcome:
    | "profile-passed"
    | "profile-passed-with-waivers"
    | "profile-failed"
    | "profile-unavailable";
  readonly profile: {
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    readonly jurisdiction: string;
    readonly source: string;
    readonly edition: string;
    readonly selection: "active" | "not-selected";
  };
  readonly checkedRules: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly assumptions: readonly string[];
  readonly knownGaps: readonly string[];
  readonly evidence: {
    readonly canonicalCircuitJsonSha256: string;
    readonly boundedArtifactSetSha256: string;
    readonly independentManufacturingVerificationSha256: string;
    readonly verificationAuthority: "pcboo-verifier-issued" | "untrusted-input";
    readonly expectationBinding: "matched" | "mismatched" | "untrusted";
    readonly independentParser: ManufacturingVerification["parser"] | "unverified";
    readonly boundedArtifactSet: ManufacturingVerification["artifacts"];
    readonly sourceProfileRules: "passed" | "passed-with-waivers" | "failed" | "not-run";
    readonly independentlyParsedManufacturingArtifacts: "passed" | "failed";
  };
  readonly findings: readonly PreComplianceFinding[];
  readonly disclaimer: "Pre-compliance evidence only; not certification, approval, or a claim of legal compliance.";
}

export interface PreComplianceAssessment {
  readonly status: AssuranceStatus<"standards">;
  readonly diagnostics: readonly Diagnostic[];
  readonly evidence: PreComplianceEvidence;
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sortedManufacturingFindings(
  verification: ManufacturingVerification,
): ManufacturingVerification["findings"] {
  return Object.freeze([...verification.findings].sort((left, right) => {
    const leftKey = `${left.path ?? ""}\0${left.code}\0${left.message}`;
    const rightKey = `${right.path ?? ""}\0${right.code}\0${right.message}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }));
}

/**
 * Runs PCBoo's conservative manufacturer-neutral baseline as a bounded
 * pre-compliance check. It consumes independently parsed manufacturing
 * evidence and never represents the outcome as certification.
 */
export function assessBaselinePreCompliance(options: {
  readonly circuitJson: readonly AnyCircuitElement[];
  readonly activeProfile?: ActiveFabricationProfile;
  readonly manufacturingVerification: ManufacturingVerification;
  /** Exact source-controlled waiver declarations already bound by the caller's input snapshot. */
  readonly sourceWaivers?: {
    readonly declarations: readonly Readonly<DeclaredWaiver>[];
    readonly evaluationDate: string;
  };
}): Readonly<PreComplianceAssessment> {
  const profile = options.activeProfile === undefined
    ? BASELINE_FABRICATION_PROFILE
    : resolveFabricationProfile(options.activeProfile);
  let source: ReturnType<typeof assessCircuitFabrication> | undefined;
  if (options.activeProfile !== undefined) {
    const assessed = assessCircuitFabrication(options.circuitJson, options.activeProfile);
    if (options.sourceWaivers === undefined) {
      source = assessed;
    } else {
      if (!isLoadedDeclaredWaiverSet(options.sourceWaivers.declarations)) {
        throw new TypeError(
          "Pre-compliance source waivers must come from PCBoo's source-controlled waiver loader",
        );
      }
      const applied = applyDeclaredWaivers({
        diagnostics: assessed.diagnostics,
        statuses: statusSet({
          fabrication: assessed.status,
          electrical: assuranceStatus("electrical", "not-run"),
          functional: assuranceStatus("functional", "not-run"),
          standards: assuranceStatus("standards", "not-run"),
          sourcing: sourcingStatus("unchecked"),
        }),
        declarations: options.sourceWaivers.declarations.filter(
          ({ dimension }) => dimension === "fabrication",
        ),
        evaluationDate: options.sourceWaivers.evaluationDate,
      });
      source = Object.freeze({
        status: applied.statuses.fabrication,
        diagnostics: Object.freeze(
          applied.diagnostics.filter(({ dimension }) => dimension === "fabrication"),
        ),
      });
    }
  }
  const manufacturingFindings = sortedManufacturingFindings(
    options.manufacturingVerification,
  );
  const verifierIssued = isVerifierIssuedManufacturingVerification(
    options.manufacturingVerification,
  );
  let recomputedExpectationSha256: string | undefined;
  if (verifierIssued) {
    try {
      recomputedExpectationSha256 = manufacturingExpectationSha256(
        deriveManufacturingExpectation({
          boardName: options.manufacturingVerification.expectation.boardName,
          circuitJson: [...options.circuitJson],
        }),
      );
    } catch {
      // Source-profile diagnostics describe invalid source geometry. A result
      // that cannot be rebound to an expectation cannot support a pass.
    }
  }
  const expectationBound = verifierIssued &&
    recomputedExpectationSha256 === options.manufacturingVerification.expectation.sha256;
  const manufacturingPassed = expectationBound && options.manufacturingVerification.passed;
  const findings: PreComplianceFinding[] = [];
  const diagnostics: Diagnostic[] = [];

  if (source === undefined) {
    const id = diagnosticId("STD_PROFILE_UNAVAILABLE_001");
    findings.push(Object.freeze({
      code: "PROFILE_UNAVAILABLE" as const,
      message: "The immutable PCBoo baseline profile is not active in project configuration and lock evidence",
      sourceDiagnosticIds: Object.freeze([]),
      manufacturingFindingCodes: Object.freeze([]),
    }));
    diagnostics.push(defineDiagnostic({
      id,
      severity: "error",
      dimension: "standards",
      message: "Pre-compliance evidence is unavailable because the immutable PCBoo baseline profile is not active",
      waiverPolicy: "forbidden",
      objects: [],
      sourceLocations: [],
      profile: `${profile.name}@${profile.version}`,
      evidence: [`profile-digest:${profile.digest}`, "profile-selection:not-selected"],
      nextCommand: "pcboo verify manufacturing",
    }));
  } else if (
    source.status.state !== "passed" && source.status.state !== "passed-with-waivers"
  ) {
    const id = diagnosticId("STD_PROFILE_SOURCE_RULES_FAILED_001");
    findings.push(Object.freeze({
      code: "PROFILE_SOURCE_RULES_FAILED" as const,
      message: "Canonical Circuit JSON did not pass every supported rule in the locked baseline profile",
      sourceDiagnosticIds: Object.freeze(source.diagnostics.map(({ id }) => String(id)).sort()),
      manufacturingFindingCodes: Object.freeze([]),
    }));
    diagnostics.push(defineDiagnostic({
      id,
      severity: "error",
      dimension: "standards",
      message: "Pre-compliance evidence failed because canonical Circuit JSON did not pass the locked baseline profile",
      waiverPolicy: "forbidden",
      objects: [],
      sourceLocations: [],
      profile: `${profile.name}@${profile.version}`,
      evidence: [
        `profile-digest:${profile.digest}`,
        ...source.diagnostics.map(({ id }) => `source-diagnostic:${id}`),
      ],
      nextCommand: "pcboo verify manufacturing",
    }));
  } else if (source.status.state === "passed-with-waivers") {
    const waivedSourceDiagnostics = source.diagnostics.filter((diagnostic) =>
      source.status.diagnosticIds.includes(diagnostic.id) && diagnostic.disposition === "waived"
    );
    const id = diagnosticId("STD_PROFILE_SOURCE_RULES_WAIVED_001");
    diagnostics.push(defineDiagnostic({
      id,
      severity: "warning",
      dimension: "standards",
      message: "The locked baseline profile passed only with explicit source-rule waivers",
      waiverPolicy: "allowed",
      disposition: "waived",
      objects: waivedSourceDiagnostics.flatMap(({ resolution }) =>
        resolution === undefined ? [] : [resolution.scope]
      ),
      sourceLocations: waivedSourceDiagnostics.flatMap(({ sourceLocations }) => sourceLocations),
      profile: `${profile.name}@${profile.version}`,
      evidence: [
        `profile-digest:${profile.digest}`,
        ...waivedSourceDiagnostics.map(({ id: sourceId }) => `source-waiver:${sourceId}`),
      ],
      resolution: {
        scope: `${profile.name}@${profile.version}`,
        justification: "This standards outcome inherits the authenticated source-controlled fabrication waivers listed in its evidence.",
      },
      nextCommand: "Review the source-controlled fabrication waiver declarations",
    }));
  }

  if (!verifierIssued) {
    const id = diagnosticId("STD_PROFILE_MANUFACTURING_EVIDENCE_UNAUTHENTICATED_001");
    findings.push(Object.freeze({
      code: "INDEPENDENT_MANUFACTURING_EVIDENCE_UNAUTHENTICATED" as const,
      message: "Manufacturing evidence was not issued by PCBoo's independent directory verifier",
      sourceDiagnosticIds: Object.freeze([]),
      manufacturingFindingCodes: Object.freeze([]),
    }));
    diagnostics.push(defineDiagnostic({
      id,
      severity: "error",
      dimension: "standards",
      message: "Pre-compliance evidence failed because the supplied manufacturing result has no PCBoo verifier authority",
      waiverPolicy: "forbidden",
      objects: [],
      sourceLocations: [],
      profile: `${profile.name}@${profile.version}`,
      evidence: [`profile-digest:${profile.digest}`, "manufacturing-verification-authority:untrusted-input"],
      nextCommand: "pcboo verify manufacturing",
    }));
  } else if (!expectationBound) {
    const id = diagnosticId("STD_PROFILE_MANUFACTURING_EVIDENCE_SOURCE_MISMATCH_001");
    findings.push(Object.freeze({
      code: "INDEPENDENT_MANUFACTURING_EVIDENCE_SOURCE_MISMATCH" as const,
      message: "Verifier-issued manufacturing evidence does not match the current Circuit JSON manufacturing expectation",
      sourceDiagnosticIds: Object.freeze([]),
      manufacturingFindingCodes: Object.freeze([]),
    }));
    diagnostics.push(defineDiagnostic({
      id,
      severity: "error",
      dimension: "standards",
      message: "Pre-compliance evidence failed because independently parsed artifacts were verified against a different source expectation",
      waiverPolicy: "forbidden",
      objects: [],
      sourceLocations: [],
      profile: `${profile.name}@${profile.version}`,
      evidence: [
        `profile-digest:${profile.digest}`,
        `verification-expectation:${options.manufacturingVerification.expectation.sha256}`,
        `source-expectation:${recomputedExpectationSha256 ?? "unavailable"}`,
      ],
      nextCommand: "pcboo verify manufacturing",
    }));
  } else if (!options.manufacturingVerification.passed) {
    const id = diagnosticId("STD_PROFILE_MANUFACTURING_EVIDENCE_FAILED_001");
    findings.push(Object.freeze({
      code: "INDEPENDENT_MANUFACTURING_EVIDENCE_FAILED" as const,
      message: "Emitted manufacturing artifacts did not pass independent Gerber, Excellon, BOM, placement, and metadata verification",
      sourceDiagnosticIds: Object.freeze([]),
      manufacturingFindingCodes: Object.freeze(
        manufacturingFindings.map(({ code }) => code),
      ),
    }));
    diagnostics.push(defineDiagnostic({
      id,
      severity: "error",
      dimension: "standards",
      message: "Pre-compliance evidence failed because emitted manufacturing artifacts did not pass independent verification",
      waiverPolicy: "forbidden",
      objects: Object.freeze(
        manufacturingFindings.flatMap(({ path }) => path === undefined ? [] : [path]),
      ),
      sourceLocations: [],
      profile: `${profile.name}@${profile.version}`,
      evidence: [
        `profile-digest:${profile.digest}`,
        `independent-parser:${options.manufacturingVerification.parser}`,
        ...manufacturingFindings.map(({ code }) => `manufacturing-finding:${code}`),
      ],
      nextCommand: "pcboo verify manufacturing",
    }));
  }

  const profileAvailable = source !== undefined;
  const passed = profileAvailable && findings.length === 0;
  const evidence: PreComplianceEvidence = Object.freeze({
    schemaVersion: PRE_COMPLIANCE_EVIDENCE_SCHEMA_VERSION,
    kind: "pre-compliance-evidence" as const,
    method: PRE_COMPLIANCE_METHOD,
    claim: profileAvailable
      ? "checked-against-profile" as const
      : "not-checked-profile-unavailable" as const,
    certification: "not-certification" as const,
    outcome: !profileAvailable
      ? "profile-unavailable" as const
      : !passed
        ? "profile-failed" as const
        : source?.status.state === "passed-with-waivers"
          ? "profile-passed-with-waivers" as const
          : "profile-passed" as const,
    profile: Object.freeze({
      name: profile.name,
      version: profile.version,
      digest: profile.digest,
      jurisdiction: profile.jurisdiction,
      source: profile.source,
      edition: profile.edition,
      selection: profileAvailable ? "active" as const : "not-selected" as const,
    }),
    checkedRules: profile.supportedRules,
    requiredEvidence: profile.requiredEvidence,
    assumptions: profile.assumptions,
    knownGaps: profile.knownGaps,
    evidence: Object.freeze({
      canonicalCircuitJsonSha256: sha256(canonicalCircuitJson(options.circuitJson)),
      boundedArtifactSetSha256: sha256(JSON.stringify(
        options.manufacturingVerification.artifacts,
      )),
      independentManufacturingVerificationSha256: sha256(JSON.stringify({
        verificationAuthority: verifierIssued ? "pcboo-verifier-issued" : "untrusted-input",
        expectation: verifierIssued ? options.manufacturingVerification.expectation : undefined,
        parser: options.manufacturingVerification.parser,
        passed: options.manufacturingVerification.passed,
        findings: manufacturingFindings,
        artifacts: options.manufacturingVerification.artifacts,
      })),
      verificationAuthority: verifierIssued
        ? "pcboo-verifier-issued" as const
        : "untrusted-input" as const,
      expectationBinding: !verifierIssued
        ? "untrusted" as const
        : expectationBound ? "matched" as const : "mismatched" as const,
      independentParser: verifierIssued
        ? options.manufacturingVerification.parser
        : "unverified" as const,
      boundedArtifactSet: options.manufacturingVerification.artifacts,
      sourceProfileRules: source === undefined
        ? "not-run" as const
        : source.status.state === "passed"
          ? "passed" as const
          : source.status.state === "passed-with-waivers"
            ? "passed-with-waivers" as const
            : "failed" as const,
      independentlyParsedManufacturingArtifacts:
        manufacturingPassed ? "passed" as const : "failed" as const,
    }),
    findings: Object.freeze(findings),
    disclaimer: "Pre-compliance evidence only; not certification, approval, or a claim of legal compliance." as const,
  });

  return Object.freeze({
    status: assuranceStatus(
      "standards",
      !profileAvailable
        ? "unavailable"
        : !passed
          ? "failed"
          : source?.status.state === "passed-with-waivers"
            ? "passed-with-waivers"
            : "passed",
      {
      diagnosticIds: source?.status.state === "passed-with-waivers"
        ? diagnostics
          .filter(({ id }) => id === "STD_PROFILE_SOURCE_RULES_WAIVED_001")
          .map(({ id }) => id)
        : diagnostics.map(({ id }) => id),
      summary: !profileAvailable
        ? "Pre-compliance profile evidence unavailable; no profile check was claimed"
        : !passed
          ? "The locked PCBoo baseline pre-compliance profile check failed"
          : source?.status.state === "passed-with-waivers"
            ? "Checked against the locked PCBoo baseline profile with explicit source-rule waivers; pre-compliance evidence only, not certification"
            : "Checked against the locked PCBoo baseline profile; pre-compliance evidence only, not certification",
      },
    ),
    diagnostics: Object.freeze(diagnostics),
    evidence,
  });
}
