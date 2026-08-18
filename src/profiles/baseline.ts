// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
export const BASELINE_FABRICATION_PROFILE = Object.freeze({
  name: "pcboo-baseline-2-4layer",
  version: "1.6.0",
  digest: "sha256:e58d733810e286fc52996496939c66153533537e2deff6fba17e3fe437a72ca4",
  jurisdiction: "generic PCB fabrication",
  manufacturer: "manufacturer-neutral",
  source: "PCBoo conservative built-in rules",
  edition: "2026-08",
  supportedRules: Object.freeze([
    "positive-dimensions",
    "board-material",
    "layer-count",
    "minimum-trace-width",
    "minimum-drill",
    "minimum-plated-slot",
    "minimum-annular-ring",
    "same-layer-copper-clearance",
    "rectangular-layer-copper-keepout",
    "copper-and-hole-edge-clearance",
    "mask-sliver",
    "component-inside-board",
    "component-overlap",
    "courtyard-inside-board",
    "courtyard-owner-containment",
    "courtyard-overlap",
    "paste-aperture-pad-reconciliation",
    "required-populated-smt-paste",
    "smt-pad-owner-side-integrity",
    "owned-smt-plated-hole-and-npth-courtyard-containment",
    "pinned-or-source-bound-cad-footprint-pad-signature-and-placement-orientation",
    "unique-manufactured-identities",
    "manufacturer-part-identity-with-optional-supplier-identity",
    "rectangular-outline",
  ]),
  requiredEvidence: Object.freeze([
    "canonical-circuit-json",
    "independently-parsed-gerber",
    "independently-parsed-excellon",
  ]),
  assumptions: Object.freeze([
    "one rectangular board",
    "two or four copper layers",
    "FR-4 board substrate",
    "circular or straight routed-slot PTH, circular NPTH, and through vias",
    "rectangular or circular SMT pads",
    "linear trace segments",
    "axis-aligned rectangular copper keepouts on declared board layers",
    "outer-layer solder mask",
    "paste apertures centered within exactly one containing pad on the same side",
  ]),
  knownGaps: Object.freeze([
    "non-rectangular or out-of-board keepouts, non-plated slots, cutouts, arcs, non-orthogonal courtyards, and nonstandard pad shapes are rejected as unsupported",
    "per-side solder-mask margins are evaluated by DRC but rejected by production reconciliation until the pinned Gerber adapter preserves them",
    "populated SMT pads require an explicit paste aperture; an authored no-paste escape hatch is not yet qualified by this profile",
    "custom footprint pad signatures are geometry- and source-digest-bound; datasheet correctness still requires project review and provenance evidence",
    "supplier catalog identities are optional; the BOM remains manufacturer-part authoritative and live sourcing is a separate status dimension",
    "routing is accepted only from authored Circuit JSON; the bounded Freerouting adapter produces candidates that remain non-authoritative until explicitly promoted into semantic source routes",
    "inner-layer copper is reconciled geometrically, but planes, pours, blind vias, buried vias, and impedance are unsupported",
    "the baseline checks fabrication geometry and artifact agreement, not assembly process capability, yield, SI, EMC, safety, or regulatory compliance",
    "rendered browser views are not verification evidence and are not used to determine fabrication passage",
  ]),
  supportedBoardMaterials: Object.freeze(["fr4"]),
  minimumTraceWidthMm: 0.15,
  minimumDrillMm: 0.2,
  minimumAnnularRingMm: 0.05,
  minimumCopperClearanceMm: 0.2,
  minimumCopperEdgeClearanceMm: 0.2,
  minimumMaskSliverMm: 0.1,
} as const);

export type BaselineFabricationProfile = typeof BASELINE_FABRICATION_PROFILE;

export function isBaselineSupportedBoardMaterial(value: unknown): value is "fr4" {
  return typeof value === "string" &&
    BASELINE_FABRICATION_PROFILE.supportedBoardMaterials.some(
      (material) => material === value,
    );
}

export interface ActiveFabricationProfile {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

export function baselineFabricationProfileDigest(): string {
  const { digest: _declaredDigest, ...content } = BASELINE_FABRICATION_PROFILE;
  return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(content)).digest("hex")}`;
}

export function resolveFabricationProfile(
  active: ActiveFabricationProfile,
): BaselineFabricationProfile {
  if (baselineFabricationProfileDigest() !== BASELINE_FABRICATION_PROFILE.digest) {
    throw new Error("Built-in fabrication profile content does not match its immutable digest");
  }
  if (
    active.name !== BASELINE_FABRICATION_PROFILE.name ||
    active.version !== BASELINE_FABRICATION_PROFILE.version ||
    active.digest !== BASELINE_FABRICATION_PROFILE.digest
  ) {
    throw new Error(
      `Unsupported fabrication profile ${active.name}@${active.version} (${active.digest})`,
    );
  }
  return BASELINE_FABRICATION_PROFILE;
}
