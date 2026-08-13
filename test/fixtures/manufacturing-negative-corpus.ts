import type { ManufacturingFindingCode } from "../../src/manufacturing/verify";

export const MANUFACTURING_NEGATIVE_CORPUS = {
  missing_inner_copper: {
    mutation: "remove a required inner-copper Gerber",
    expectedCodes: ["MANUFACTURING_FILE_MISSING"],
  },
  empty_inner_copper: {
    mutation: "empty or remove every draw from required inner copper",
    expectedCodes: ["MANUFACTURING_FILE_EMPTY", "GERBER_NO_OPERATIONS", "GERBER_TRACE_MISMATCH"],
  },
  duplicate_or_swapped_layers: {
    mutation: "copy or swap copper-layer bytes and contradict layer semantics",
    expectedCodes: ["GERBER_FILE_FUNCTION_MISMATCH"],
  },
  malformed_aperture: {
    mutation: "malform, remove, duplicate, or prematurely use an aperture",
    expectedCodes: ["GERBER_PARSE_ERROR", "GERBER_PARSE_WARNING", "GERBER_STATE_UNSUPPORTED"],
  },
  missing_profile: {
    mutation: "remove or open the board-profile Gerber",
    expectedCodes: ["MANUFACTURING_FILE_MISSING", "GERBER_PROFILE_MISMATCH"],
  },
  mirrored_or_offset_coordinates: {
    mutation: "mirror or translate authored Gerber geometry",
    expectedCodes: ["GERBER_FEATURE_MISMATCH"],
  },
  absent_drill_hits: {
    mutation: "delete or terminate before required drill hits",
    expectedCodes: ["DRILL_HIT_MISMATCH", "DRILL_PARSE_ERROR"],
  },
  wrong_plating: {
    mutation: "change plated file or tool attributes to non-plated",
    expectedCodes: ["DRILL_FILE_FUNCTION_MISMATCH"],
  },
  invalid_via_span: {
    mutation: "author a partial-stack via",
    expectedCodes: ["MANUFACTURING_UNSUPPORTED"],
  },
  stale_artifact: {
    mutation: "add, substitute, or change an artifact outside the bound snapshot",
    expectedCodes: ["MANUFACTURING_FILE_UNEXPECTED", "MANUFACTURING_FILE_SYMLINK", "MANUFACTURING_ARTIFACT_CHANGED"],
  },
  bom_mismatch: {
    mutation: "change BOM membership, values, quantities, or supplier identity",
    expectedCodes: ["BOM_MISMATCH"],
  },
  placement_mismatch: {
    mutation: "change placement membership, coordinates, headers, or rotation",
    expectedCodes: ["PLACEMENT_MISMATCH"],
  },
  ambiguous_bottom_rotation: {
    mutation: "remove or contradict the declared bottom-side placement convention",
    expectedCodes: ["FABRICATION_METADATA_MISMATCH"],
  },
} as const satisfies Record<string, {
  readonly mutation: string;
  readonly expectedCodes: readonly ManufacturingFindingCode[];
}>;

export type ManufacturingNegativeCaseId = keyof typeof MANUFACTURING_NEGATIVE_CORPUS;

/** Exhaustive diagnostic contract; values are stable direct-regression test IDs. */
export const MANUFACTURING_FINDING_CODE_DIRECT_TEST = {
  MANUFACTURING_UNSUPPORTED: "partial-stack-via",
  MANUFACTURING_FILE_MISSING: "missing-inner-and-profile-files",
  MANUFACTURING_FILE_UNEXPECTED: "stale-extra-artifact",
  MANUFACTURING_FILE_EMPTY: "empty-inner-copper",
  MANUFACTURING_FILE_SYMLINK: "symlink-substitution",
  MANUFACTURING_INPUT_LIMIT: "oversized-or-overbroad-artifact-input",
  GERBER_PARSE_ERROR: "early-gerber-terminator",
  GERBER_PARSE_WARNING: "pinned-malformed-aperture-warning",
  GERBER_FILE_FUNCTION_MISMATCH: "copied-or-swapped-copper-function",
  GERBER_POLARITY_MISMATCH: "clear-polarity-copper",
  GERBER_STEP_REPEAT_UNSUPPORTED: "gerber-step-repeat",
  GERBER_STATE_UNSUPPORTED: "duplicate-aperture-state",
  GERBER_NO_OPERATIONS: "deleted-copper-draws",
  GERBER_FEATURE_MISSING: "deleted-required-flash",
  GERBER_FEATURE_MISMATCH: "translated-flash",
  GERBER_TRACE_MISMATCH: "mirrored-or-deleted-trace",
  GERBER_PROFILE_MISMATCH: "open-crossing-profile",
  DRILL_PARSE_ERROR: "early-drill-terminator",
  DRILL_FILE_FUNCTION_MISMATCH: "wrong-plating-function",
  DRILL_HIT_MISMATCH: "absent-drill-hit",
  DRILL_STATE_UNSUPPORTED: "unsupported-drill-state",
  BOM_MISMATCH: "bom-divergence",
  PLACEMENT_MISMATCH: "placement-divergence",
  FABRICATION_METADATA_MISMATCH: "bottom-side-metadata",
  MANUFACTURING_ARTIFACT_CHANGED: "snapshot-or-membership-change",
} as const satisfies Record<ManufacturingFindingCode, string>;
