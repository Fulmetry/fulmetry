import { describe, expect, test } from "bun:test";
import {
  requireRuntimeEvidencePackageIdentity,
  RUNTIME_EVIDENCE_PACKAGE_PINS,
} from "../src/evidence-identity";

describe("runtime evidence package identity", () => {
  test("binds every validator dependency to exact installed implementation bytes", async () => {
    const identities = await requireRuntimeEvidencePackageIdentity();
    expect(identities).toEqual(RUNTIME_EVIDENCE_PACKAGE_PINS);
    expect(Object.keys(identities).sort()).toEqual([
      "alphabet",
      "circuitJsonSchema",
      "sourceGraphParser",
      "valueFormatter",
    ]);
  });
});
