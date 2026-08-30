// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import * as adapter from "../src/simulation/ngspice";
import { authenticateFunctionalSimulationAuthority } from "../src/simulation/ngspice";

describe("functional simulation authority boundary", () => {
  test("ships no callable minting primitive and rejects caller-constructed evidence", () => {
    expect(Object.keys(adapter)).not.toContain("issueFunctionalSimulationAuthority");
    const digest = "0".repeat(64);
    const circuitDigest = `sha256:${digest}`;
    const forged = Object.freeze({
      inputSnapshotDigest: digest,
      evidence: Object.freeze({ circuitDigest, forged: true }),
    });
    expect(authenticateFunctionalSimulationAuthority(forged as never, {
      circuitDigest,
      inputSnapshot: { schemaVersion: 1, digest, inputs: [] },
    })).toBeUndefined();
  });

  test("WeakSet prototype poisoning cannot observe issuance or authenticate a forged authority", () => {
    const originalHas = WeakSet.prototype.has;
    const originalAdd = WeakSet.prototype.add;
    let leakedRegistry: WeakSet<object> | undefined;
    try {
      WeakSet.prototype.has = (() => true) as typeof WeakSet.prototype.has;
      WeakSet.prototype.add = function(value: object) {
        leakedRegistry = this;
        return originalAdd.call(this, value);
      };
      expect(authenticateFunctionalSimulationAuthority({} as never, {
        circuitDigest: `sha256:${"1".repeat(64)}`,
        inputSnapshot: { schemaVersion: 1, digest: "2".repeat(64), inputs: [] },
      })).toBeUndefined();
      expect(leakedRegistry).toBeUndefined();
    } finally {
      WeakSet.prototype.has = originalHas;
      WeakSet.prototype.add = originalAdd;
    }
  });
});
