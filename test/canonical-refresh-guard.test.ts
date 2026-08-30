import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  EXPECTED_TSCIRCUIT_CONTENT_SHA256,
  EXPECTED_TSCIRCUIT_VERSION,
} from "../src/engine-identity";
import {
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
} from "../src/project/lock";
import {
  parseTscircuitCompatibilityAnchor,
  parseTscircuitCompatibilityAnchorText,
  requireAcceptedEngineForCanonicalRefresh,
} from "../src/upgrade/refresh-guard";

const accepted = Object.freeze({
  version: "0.0.2261",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  contentSha256: "a".repeat(64),
});
const runtimeClosures = Object.freeze({
  "darwin-arm64": Object.freeze({ repository: "b".repeat(64), packedConsumer: "c".repeat(64) }),
});

describe("canonical golden refresh engine boundary", () => {
  test("permits maintenance only for the exact already-recorded engine", () => {
    expect(() => requireAcceptedEngineForCanonicalRefresh({
      fixtureName: "led-2layer",
      anchored: accepted,
      requested: { ...accepted },
    })).not.toThrow();
  });

  test.each(["version", "integrity", "contentSha256"] as const)(
    "blocks a coordinated %s change from using ordinary golden refresh",
    (field) => {
      const requested = { ...accepted, [field]: field === "contentSha256" ? "b".repeat(64) : "changed" };
      expect(() => requireAcceptedEngineForCanonicalRefresh({
        fixtureName: "plated-hole-4layer",
        anchored: accepted,
        requested,
      })).toThrow(/TSCIRCUIT_UPGRADE_REVIEW_REQUIRED.*plated-hole-4layer/u);
    },
  );

  test("does not treat a coordinated replacement manifest identity as the old-side authority", () => {
    const coordinatedReplacement = {
      version: "0.0.2262",
      integrity: "sha512-replacement",
      contentSha256: "b".repeat(64),
    };
    expect(() => requireAcceptedEngineForCanonicalRefresh({
      fixtureName: "led-2layer",
      anchored: accepted,
      requested: coordinatedReplacement,
    })).toThrow("accepted compatibility anchor");
  });

  test("parses the exact accepted anchor schema and rejects extra fields", () => {
    const anchor = parseTscircuitCompatibilityAnchor({
      schemaVersion: 3,
      accepted,
      runtimeClosures,
      acceptedUpgradeReview: null,
    });
    expect(anchor.accepted).toEqual(accepted);
    expect(Object.isFrozen(anchor.accepted)).toBeTrue();
    expect(() => parseTscircuitCompatibilityAnchor({
      schemaVersion: 3,
      accepted,
      runtimeClosures,
      acceptedUpgradeReview: null,
      bypass: true,
    })).toThrow("unexpected fields");
    expect(() => parseTscircuitCompatibilityAnchor({
      schemaVersion: 3,
      accepted: { ...accepted, version: "01.0.0" },
      runtimeClosures,
      acceptedUpgradeReview: null,
    })).toThrow("canonical semver");
    expect(() => parseTscircuitCompatibilityAnchor({
      schemaVersion: 3,
      accepted: { ...accepted, integrity: "sha512-not-canonical" },
      runtimeClosures,
      acceptedUpgradeReview: null,
    })).toThrow("canonical 64-byte");
    expect(() => parseTscircuitCompatibilityAnchor({
      schemaVersion: 3,
      accepted,
      runtimeClosures: {},
      acceptedUpgradeReview: null,
    })).toThrow("cover exactly darwin-arm64");
    expect(() => parseTscircuitCompatibilityAnchor({
      schemaVersion: 3,
      accepted,
      runtimeClosures: { ...runtimeClosures, "linux-x64": runtimeClosures["darwin-arm64"] },
      acceptedUpgradeReview: null,
    })).toThrow("cover exactly darwin-arm64");
  });

  test("rejects duplicate keys at every compatibility-anchor object level", () => {
    const sri = accepted.integrity;
    const cases = [
      `{"schemaVersion":3,"schemaVersion":3,"accepted":{"version":"0.0.2261","integrity":"${sri}","contentSha256":"${"a".repeat(64)}"},"runtimeClosures":${JSON.stringify(runtimeClosures)},"acceptedUpgradeReview":null}`,
      `{"schemaVersion":3,"accepted":{"version":"0.0.2261","version":"0.0.2261","integrity":"${sri}","contentSha256":"${"a".repeat(64)}"},"runtimeClosures":${JSON.stringify(runtimeClosures)},"acceptedUpgradeReview":null}`,
      `{"schemaVersion":3,"accepted":{"version":"0.0.2261","integrity":"${sri}","contentSha256":"${"a".repeat(64)}"},"runtimeClosures":${JSON.stringify(runtimeClosures)},"acceptedUpgradeReview":{"fromVersion":"0.0.2260","fromVersion":"0.0.2260","reportSha256":"${"b".repeat(64)}","runtimeEvidenceSha256":"${"c".repeat(64)}"}}`,
    ];
    for (const text of cases) {
      expect(() => parseTscircuitCompatibilityAnchorText(text)).toThrow("duplicate key");
    }
  });

  test("the checked-in anchor matches every accepted runtime identity constant", async () => {
    const anchor = parseTscircuitCompatibilityAnchor(
      await Bun.file(join(import.meta.dir, "..", "compatibility", "tscircuit.json")).json(),
    );
    expect(anchor.accepted).toEqual({
      version: EXPECTED_TSCIRCUIT_VERSION,
      integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
      contentSha256: EXPECTED_TSCIRCUIT_CONTENT_SHA256,
    });
    expect(anchor.accepted.version).toBe(SUPPORTED_TSCIRCUIT_VERSION);
    expect(anchor.runtimeClosures).toEqual({
      "darwin-arm64": {
        repository: "c91df9f11f9e273a472dde2e57dc847a139f688e55f893450b32c0a3e1338b11",
        packedConsumer: "66d63a9829bae38f4f8dd1ee35e6387eeb6c645fe05ec5b2aeeb3ea880bf46ab",
      },
    });
  });
});
