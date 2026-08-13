import { describe, expect, test } from "bun:test";
import {
  canonicalTscircuitRuntimeEvidenceJson,
  createTscircuitRuntimeEvidence,
  parseTscircuitRuntimeEvidence,
  parseTscircuitRuntimeEvidenceText,
} from "../src/upgrade/runtime-evidence";

const hash = (character: string) => character.repeat(64);
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function evidence() {
  return createTscircuitRuntimeEvidence({
    candidate: { version: "1.2.3", integrity, contentSha256: hash("a") },
    baselineAnchorSha256: hash("b"),
    semanticReportSha256: hash("7"),
    bunVersion: "1.3.14",
    platform: "darwin-arm64",
    implementationSha256: hash("c"),
    profiles: {
      repository: { closureSha256: hash("d"), lockSha256: hash("e") },
      packedConsumer: {
        closureSha256: hash("f"), lockSha256: hash("1"), manifestSha256: hash("2"),
        packedPcbooContentSha256: hash("3"), projectPcbooLockSha256: hash("4"),
        singleEngineResolutionSha256: hash("5"), pcbooTarballSha256: hash("6"),
        pcbooTarballIntegrity: `sha512-${Buffer.alloc(64, 6).toString("base64")}`,
        contractVersion: 2,
      },
    },
  });
}

describe("macOS tscircuit runtime evidence", () => {
  test("round-trips one canonical self-digested Apple Silicon record", () => {
    const value = evidence();
    const text = canonicalTscircuitRuntimeEvidenceJson(value);
    expect(parseTscircuitRuntimeEvidenceText(text)).toEqual(value);
    expect(value.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects unsupported platforms, tampering, extra fields, and non-canonical bytes", () => {
    const value = evidence();
    expect(() => createTscircuitRuntimeEvidence({ ...value, platform: "linux-x64" as "darwin-arm64" }))
      .toThrow("Unsupported runtime evidence platform");
    expect(() => parseTscircuitRuntimeEvidence({ ...value, evidenceSha256: hash("9") }))
      .toThrow("self-digest");
    expect(() => parseTscircuitRuntimeEvidence({ ...value, surprise: true })).toThrow("unexpected fields");
    const text = canonicalTscircuitRuntimeEvidenceJson(value);
    expect(() => parseTscircuitRuntimeEvidenceText(` ${text}`)).toThrow("canonical JSON");
    expect(() => parseTscircuitRuntimeEvidenceText(text.replace(
      '"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1',
    ))).toThrow("duplicate key");
  });
});
