// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessCircuitElectrical } from "../src/electrical";
import { assessCircuitFabrication } from "../src/fabrication";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import { verifyManufacturingDirectory } from "../src/manufacturing/verify";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import { parseSimulationDefinition } from "../src/simulation/definition";
import { generateNgspiceNetlist } from "../src/simulation/ngspice";
import { liveFunctionalFixture } from "./fixtures/live-functional";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true })
)));

describe("live functional release fixture", () => {
  test("is independently electrically and manufacturably valid before a real solver is added", async () => {
    const circuitJson = await liveFunctionalFixture();
    expect(assessCircuitElectrical(circuitJson).status.state).toBe("passed");
    expect(assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE).status.state)
      .toBe("passed");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pcboo-live-functional-fixture-"));
    roots.push(temporaryRoot);
    const root = join(temporaryRoot, "manufacturing");
    const files = await exportManufacturingFiles({ boardName: "live-divider", circuitJson });
    await emitDraftManufacturingDirectory({ targetDirectory: root, files });
    const verification = await verifyManufacturingDirectory({
      root,
      expectation: deriveManufacturingExpectation({ boardName: "live-divider", circuitJson }),
      circuitJson,
    });
    expect(verification.passed, JSON.stringify(verification.findings, null, 2)).toBeTrue();
    expect(verification.findings).toEqual([]);

    const definition = parseSimulationDefinition({
      schemaVersion: 1,
      name: "divider",
      region: {
        componentIds: ["source_component_1", "source_component_2"],
        netIds: ["VIN", "VOUT", "GND"],
      },
      models: [{
        id: "resistors", device: { kind: "primitive", name: "resistor" },
        bindings: [
          { componentId: "source_component_1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
          { componentId: "source_component_2", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
        ],
        path: "simulations/resistors.model", source: "PCBoo fixture",
        digest: `sha256:${"0".repeat(64)}`, license: "CC0-1.0", redistribution: "allowed",
      }],
      stimuli: [{
        kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND",
        unit: "V", dcValue: 5, ac: null, transient: null,
      }],
      solver: { engine: "ngspice" }, analysis: { kind: "operating-point" },
      assertions: [{
        expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } },
        sample: { kind: "last" }, unit: "V", expected: 2.5,
        absoluteTolerance: 0.001, relativeTolerance: 0,
      }],
      timeoutMs: 5_000,
    });
    const netlist = generateNgspiceNetlist({
      definition,
      circuitJson,
      modelPaths: { resistors: "models/resistors.model" },
    });
    expect(netlist).toContain("source_component_1 VIN VOUT 10000");
    expect(netlist).toContain("source_component_2 VOUT 0 10000");
  });
});
