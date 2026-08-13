import { describe, expect, test } from "bun:test";
import {
  MAX_SIMULATION_ASSERTIONS,
  MAX_SIMULATION_MODEL_BINDINGS,
  MAX_SIMULATION_MODELS,
  MAX_SIMULATION_PWL_POINTS,
  MAX_SIMULATION_REGION_COMPONENTS,
  MAX_SIMULATION_SAMPLES_PER_VECTOR,
  MAX_SIMULATION_TOTAL_SAMPLES,
  MAX_SIMULATION_VECTORS,
  parseSimulationDefinition,
} from "../src/simulation";
import * as simulationApi from "../src/simulation";
import { SIMULATION_ARTIFACT_ENTRY_LIMIT } from "../src/simulation/exact-output";

function definition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "divider operating point",
    region: { componentIds: ["R1", "R2"], netIds: ["VIN", "VOUT", "GND"] },
    models: [{
      id: "resistor-built-in",
      device: { kind: "primitive", name: "resistor" },
      bindings: [
        { componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
        { componentId: "R2", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
      ],
      path: "models/resistor.spice",
      source: "project",
      digest: `sha256:${"a".repeat(64)}`,
      license: "CC0-1.0",
      redistribution: "allowed",
    }],
    stimuli: [{
      kind: "voltage",
      sourceId: "VIN",
      positiveNode: "VIN",
      negativeNode: "GND",
      unit: "V",
      dcValue: 5,
      ac: null,
      transient: null,
    }],
    solver: { engine: "ngspice" },
    analysis: { kind: "operating-point" },
    assertions: [{
      expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } },
      sample: { kind: "last" },
      unit: "V",
      expected: 2.5,
      absoluteTolerance: 0.001,
      relativeTolerance: 0.001,
    }],
    timeoutMs: 5_000,
  };
}

describe("simulation definition", () => {
  test("accepts one explicit, provenance-bound testbench", () => {
    const parsed = parseSimulationDefinition(definition());
    expect(parsed.analysis.kind).toBe("operating-point");
    expect(parsed.models[0]?.redistribution).toBe("allowed");
    expect(Object.isFrozen(parsed.assertions)).toBeTrue();
  });

  test("keeps the model ceiling within the exact run artifact-entry budget", () => {
    expect(MAX_SIMULATION_MODELS + 5 + 1).toBe(SIMULATION_ARTIFACT_ENTRY_LIMIT);
  });

  test("rejects unknown fields, guessed models, unsafe paths, and missing assertions", () => {
    expect(() => parseSimulationDefinition({ ...definition(), surprise: true })).toThrow("unknown field");
    const noDigest = structuredClone(definition());
    (noDigest.models as Record<string, unknown>[])[0]!.digest = "latest";
    expect(() => parseSimulationDefinition(noDigest)).toThrow("must be sha256");
    const escaped = structuredClone(definition());
    (escaped.models as Record<string, unknown>[])[0]!.path = "../secret.mod";
    expect(() => parseSimulationDefinition(escaped)).toThrow("within the project");
    expect(() => parseSimulationDefinition({ ...definition(), assertions: [] })).toThrow(
      "at least one numeric assertion",
    );
  });

  test("rejects non-finite values, invalid units, tolerances, and analysis ranges", () => {
    const nonFinite = structuredClone(definition());
    (nonFinite.stimuli as Record<string, unknown>[])[0]!.dcValue = Number.NaN;
    expect(() => parseSimulationDefinition(nonFinite)).toThrow("must be finite");
    const wrongUnit = structuredClone(definition());
    (wrongUnit.stimuli as Record<string, unknown>[])[0]!.unit = "A";
    expect(() => parseSimulationDefinition(wrongUnit)).toThrow("must be V");
    const negativeTolerance = structuredClone(definition());
    (negativeTolerance.assertions as Record<string, unknown>[])[0]!.absoluteTolerance = -1;
    expect(() => parseSimulationDefinition(negativeTolerance)).toThrow("cannot be negative");
    const overflowingTolerance = structuredClone(definition());
    Object.assign((overflowingTolerance.assertions as Record<string, unknown>[])[0]!, {
      expected: 1e200,
      absoluteTolerance: 0,
      relativeTolerance: 1e200,
    });
    expect(() => parseSimulationDefinition(overflowingTolerance)).toThrow("derived tolerance must be finite");
    expect(() => parseSimulationDefinition({
      ...definition(),
      analysis: { kind: "dc-sweep", sourceId: "VIN", start: 5, stop: 0, step: 1, unit: "V" },
    })).toThrow("stop must exceed");
  });

  test("rejects transient steps that absolute timestamps cannot represent faithfully", () => {
    const transientStimulus = {
      kind: "pulse",
      initialValue: 0,
      pulsedValue: 5,
      delaySeconds: 0,
      riseSeconds: 1e-9,
      fallSeconds: 1e-9,
      widthSeconds: 0.1,
      periodSeconds: 1,
    };
    const unrepresentable = structuredClone(definition());
    (unrepresentable.stimuli as Record<string, unknown>[])[0]!.transient = transientStimulus;
    unrepresentable.analysis = {
      kind: "transient",
      startSeconds: 1_000_000_000,
      stopSeconds: 1_000_000_000 + 7 * 2 ** -23,
      stepSeconds: 1e-8,
    };
    expect(() => parseSimulationDefinition(unrepresentable)).toThrow(
      "stepSeconds is too small for absolute timestamp precision",
    );

    const representable = structuredClone(unrepresentable);
    representable.analysis = {
      kind: "transient",
      startSeconds: 1_000_000_000,
      stopSeconds: 1_000_000_001,
      stepSeconds: 0.1,
    };
    expect(parseSimulationDefinition(representable).analysis).toEqual({
      kind: "transient",
      startSeconds: 1_000_000_000,
      stopSeconds: 1_000_000_001,
      stepSeconds: 0.1,
    });

    const picosecond = structuredClone(unrepresentable);
    picosecond.analysis = {
      kind: "transient",
      startSeconds: 0,
      stopSeconds: 1e-9,
      stepSeconds: 1e-12,
    };
    expect(parseSimulationDefinition(picosecond).analysis).toEqual({
      kind: "transient",
      startSeconds: 0,
      stopSeconds: 1e-9,
      stepSeconds: 1e-12,
    });
  });

  test("derives vector units from selector semantics instead of trusting caller labels", () => {
    const attacks = [
      { vector: "v(VOUT)", projection: "value", supplied: "A", required: "V" },
      { vector: "i(VIN)", projection: "magnitude", supplied: "V", required: "A" },
      { vector: "v(VOUT)", projection: "phase-degrees", supplied: "V", required: "deg" },
    ] as const;
    for (const attack of attacks) {
      const raw = structuredClone(definition());
      const assertion = (raw.assertions as Record<string, unknown>[])[0]!;
      assertion.expression = {
        kind: "vector",
        operand: { vector: attack.vector, projection: attack.projection, unit: attack.supplied },
      };
      assertion.unit = attack.supplied;
      expect(() => parseSimulationDefinition(raw)).toThrow(`must be ${attack.required}`);
    }
  });

  test("does not expose the adapter-only qualified assessor from the package API", () => {
    expect("assessQualifiedSimulationResult" in simulationApi).toBeFalse();
  });

  test("requires explicit models, source modes, sweep bindings, and assertion coordinates", () => {
    const undeclaredSweep = structuredClone(definition());
    undeclaredSweep.analysis = { kind: "dc-sweep", sourceId: "NOT_DECLARED", start: 0, stop: 1, step: 0.1, unit: "bananas" };
    expect(() => parseSimulationDefinition(undeclaredSweep)).toThrow("must match a declared stimulus");

    const ac = structuredClone(definition());
    ac.analysis = { kind: "ac", scale: "linear", startHz: 10, stopHz: 100, points: 10 };
    expect(() => parseSimulationDefinition(ac)).toThrow("explicit AC stimulus");

    const transient = structuredClone(definition());
    transient.analysis = { kind: "transient", stepSeconds: 0.001, startSeconds: 0, stopSeconds: 1 };
    expect(() => parseSimulationDefinition(transient)).toThrow("explicit transient stimulus");

    const unsafeBinding = structuredClone(definition());
    ((unsafeBinding.models as Record<string, unknown>[])[0]!.bindings as Record<string, unknown>[])[0]!.pinMap = {};
    expect(() => parseSimulationDefinition(unsafeBinding)).toThrow("cannot be empty");
  });

  test("rejects control characters and deck syntax in every interpolatable field", () => {
    const attacks: Array<(raw: Record<string, unknown>) => void> = [
      (raw) => {
        const model = (raw.models as Record<string, unknown>[])[0]!;
        model.device = { kind: "subcircuit", name: "Unsafe\n.control" };
      },
      (raw) => {
        const binding = ((raw.models as Record<string, unknown>[])[0]!.bindings as Record<string, unknown>[])[0]!;
        binding.parameters = { resistance: "10k\n.include outside" };
      },
      (raw) => {
        const binding = ((raw.models as Record<string, unknown>[])[0]!.bindings as Record<string, unknown>[])[0]!;
        binding.pinMap = { "1": "1\nshell" };
      },
      (raw) => {
        (raw.stimuli as Record<string, unknown>[])[0]!.sourceId = "VIN\n.control";
      },
      (raw) => {
        const assertion = (raw.assertions as Record<string, unknown>[])[0]!;
        assertion.expression = { kind: "vector", operand: { vector: "v(VOUT) extra", projection: "value", unit: "V" } };
      },
    ];
    for (const attack of attacks) {
      const raw = structuredClone(definition());
      attack(raw);
      expect(() => parseSimulationDefinition(raw)).toThrow();
    }
  });

  test("rejects oversized simulation collections before they can amplify parsing or diagnostics", () => {
    const oversizedRegion = structuredClone(definition());
    (oversizedRegion.region as Record<string, unknown>).componentIds = Array.from(
      { length: MAX_SIMULATION_REGION_COMPONENTS + 1 },
      (_, index) => `R${index}`,
    );
    expect(() => parseSimulationDefinition(oversizedRegion)).toThrow(
      `region.componentIds exceeds ${MAX_SIMULATION_REGION_COMPONENTS} entries`,
    );

    const oversizedModels = structuredClone(definition());
    oversizedModels.models = Array.from(
      { length: MAX_SIMULATION_MODELS + 1 },
      () => (structuredClone((definition().models as unknown[])[0])),
    );
    expect(() => parseSimulationDefinition(oversizedModels)).toThrow(
      `models exceeds ${MAX_SIMULATION_MODELS} entries`,
    );

    const oversizedBindings = structuredClone(definition());
    (oversizedBindings.models as Record<string, unknown>[])[0]!.bindings = Array.from(
      { length: MAX_SIMULATION_MODEL_BINDINGS + 1 },
      () => ({ componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } }),
    );
    expect(() => parseSimulationDefinition(oversizedBindings)).toThrow(
      `bindings exceeds ${MAX_SIMULATION_MODEL_BINDINGS} entries`,
    );

    const oversizedAssertions = structuredClone(definition());
    oversizedAssertions.assertions = Array.from(
      { length: MAX_SIMULATION_ASSERTIONS + 1 },
      () => structuredClone((definition().assertions as unknown[])[0]),
    );
    expect(() => parseSimulationDefinition(oversizedAssertions)).toThrow(
      `assertions exceeds ${MAX_SIMULATION_ASSERTIONS} entries`,
    );

    const oversizedPwl = structuredClone(definition());
    (oversizedPwl.stimuli as Record<string, unknown>[])[0]!.transient = {
      kind: "pwl",
      points: Array.from(
        { length: MAX_SIMULATION_PWL_POINTS + 1 },
        (_, index) => ({ timeSeconds: index, value: 0 }),
      ),
    };
    expect(() => parseSimulationDefinition(oversizedPwl)).toThrow(
      `points exceeds ${MAX_SIMULATION_PWL_POINTS} entries`,
    );
  });

  test("rejects analyses and assertion sets that the bounded result schema cannot represent", () => {
    const oversizedAnalysis = structuredClone(definition());
    oversizedAnalysis.analysis = {
      kind: "ac",
      scale: "linear",
      startHz: 1,
      stopHz: MAX_SIMULATION_SAMPLES_PER_VECTOR + 1,
      points: MAX_SIMULATION_SAMPLES_PER_VECTOR + 1,
    };
    (oversizedAnalysis.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    expect(() => parseSimulationDefinition(oversizedAnalysis)).toThrow(
      `more than ${MAX_SIMULATION_SAMPLES_PER_VECTOR} samples`,
    );

    const tooManyVectors = structuredClone(definition());
    tooManyVectors.assertions = Array.from(
      { length: MAX_SIMULATION_VECTORS / 2 + 1 },
      (_, index) => ({
        expression: {
          kind: "difference",
          left: { vector: `v(L${index})`, projection: "value", unit: "V" },
          right: { vector: `v(R${index})`, projection: "value", unit: "V" },
        },
        sample: { kind: "last" },
        unit: "V",
        expected: 0,
        absoluteTolerance: 0,
        relativeTolerance: 0,
      }),
    );
    expect(() => parseSimulationDefinition(tooManyVectors)).toThrow(
      `more than ${MAX_SIMULATION_VECTORS} physical vectors`,
    );

    const tooManyTotalSamples = structuredClone(definition());
    tooManyTotalSamples.analysis = {
      kind: "ac",
      scale: "linear",
      startHz: 1,
      stopHz: MAX_SIMULATION_SAMPLES_PER_VECTOR,
      points: MAX_SIMULATION_SAMPLES_PER_VECTOR,
    };
    (tooManyTotalSamples.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    tooManyTotalSamples.assertions = [{
      expression: {
        kind: "difference",
        left: { vector: "v(VOUT)", projection: "value", unit: "V" },
        right: { vector: "v(VIN)", projection: "value", unit: "V" },
      },
      sample: { kind: "last" },
      unit: "V",
      expected: 0,
      absoluteTolerance: 0,
      relativeTolerance: 0,
    }];
    expect(() => parseSimulationDefinition(tooManyTotalSamples)).toThrow(
      `more than ${MAX_SIMULATION_TOTAL_SAMPLES} total samples`,
    );
  });
});
