import { describe, expect, test } from "bun:test";
import {
  assessSimulationResult,
  MAX_SIMULATION_MODELS,
  parseSimulationDefinition,
  parseSimulationResultEvidence,
  simulationDefinitionDigest,
} from "../src/simulation";
import { assessQualifiedSimulationResult } from "../src/simulation/result";

function definition() {
  return parseSimulationDefinition({
    schemaVersion: 1,
    name: "divider",
    region: { componentIds: ["R1", "R2"], netIds: ["VIN", "VOUT", "GND"] },
    models: [{ id: "resistors", device: { kind: "primitive", name: "resistor" }, bindings: [{ componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } }, { componentId: "R2", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } }], path: "models/r.mod", source: "project", digest: `sha256:${"b".repeat(64)}`, license: "CC0-1.0", redistribution: "allowed" }],
    stimuli: [{ kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND", unit: "V", dcValue: 5, ac: null, transient: null }],
    solver: { engine: "ngspice" },
    analysis: { kind: "operating-point" },
    assertions: [{ expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 2.5, absoluteTolerance: 0.001, relativeTolerance: 0.001 }],
    timeoutMs: 5_000,
  });
}

function evidence(overrides: Record<string, unknown> = {}) {
  const current = definition();
  return {
    schemaVersion: 2,
    definitionDigest: simulationDefinitionDigest(current),
    circuitDigest: `sha256:${"1".repeat(64)}`,
    netlistDigest: `sha256:${"c".repeat(64)}`,
    qualificationSha256: `sha256:${"9".repeat(64)}`,
    modelDigests: { resistors: `sha256:${"b".repeat(64)}` },
    adapter: { name: "pcboo-ngspice", version: "2", primitiveSemantics: "ngspice-built-in-rcl", modelFileUse: "provenance-only-not-included-for-built-in-rcl" },
    tool: { name: "ngspice", version: "44.2", executableSha256: "d".repeat(64) },
    execution: { exitCode: 0, timedOut: false, stdoutSha256: `sha256:${"e".repeat(64)}`, stderrSha256: `sha256:${"f".repeat(64)}`, rawOutputSha256: `sha256:${"a".repeat(64)}` },
    solverStatus: "converged",
    analysisKind: "operating-point",
    axis: null,
    vectors: [{ name: "v(VOUT)", unit: "V", samples: [2.5005] }],
    ...overrides,
  };
}
function binding() {
  return {
    circuitDigest: `sha256:${"1".repeat(64)}`,
    netlistDigest: `sha256:${"c".repeat(64)}`,
    qualificationSha256: `sha256:${"9".repeat(64)}`,
    modelDigests: { resistors: `sha256:${"b".repeat(64)}` },
    adapterVersion: "2",
    tool: { version: "44.2", executableSha256: "d".repeat(64) },
    stdoutSha256: `sha256:${"e".repeat(64)}`,
    stderrSha256: `sha256:${"f".repeat(64)}`,
    rawOutputSha256: `sha256:${"a".repeat(64)}`,
  };
}

describe("simulation result evidence", () => {
  test("keeps internally valid recorded evidence incomplete until a qualified runner exists", () => {
    const assessment = assessSimulationResult(definition(), evidence(), binding());
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "SIM_EXECUTION_ADAPTER_UNAVAILABLE_001",
    ]);
  });

  test("fails missing vectors, unit mismatch, bad values, and analysis mismatch", () => {
    for (const result of [
      evidence({ vectors: [] }),
      evidence({ vectors: [{ name: "v(VOUT)", unit: "A", samples: [2.5] }] }),
      evidence({ vectors: [{ name: "v(VOUT)", unit: "V", samples: [3] }] }),
      evidence({ analysisKind: "transient", vectors: [{ name: "v(VOUT)", unit: "V", samples: [2.5] }] }),
    ]) expect(assessSimulationResult(definition(), result, binding()).status.state).toBe("failed");
  });

  test("fails a finite-input assertion whose derived tolerance or difference overflows", () => {
    const baseline = definition();
    const overflowDefinition = {
      ...baseline,
      assertions: [{
        ...baseline.assertions[0]!,
        expected: 1e200,
        absoluteTolerance: 0,
        relativeTolerance: 1e200,
      }],
    } as typeof baseline;
    const overflowEvidence = evidence({
      definitionDigest: simulationDefinitionDigest(overflowDefinition),
      vectors: [{ name: "v(VOUT)", unit: "V", samples: [-1e200] }],
    });
    const assessment = assessQualifiedSimulationResult(overflowDefinition, overflowEvidence, binding());
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_ASSERTION_FAILED_001");
  });

  test("rejects non-finite, empty, duplicate, and unknown result data", () => {
    expect(() => parseSimulationResultEvidence(evidence({ analysisKind: "ac", vectors: [{ name: "v(out)", unit: "V", samples: [Number.NaN] }] }))).toThrow("finite");
    expect(() => parseSimulationResultEvidence(evidence({ analysisKind: "ac", vectors: [{ name: "v(out)", unit: "V", samples: [] }] }))).toThrow("non-empty");
    expect(() => parseSimulationResultEvidence(evidence({ analysisKind: "ac", vectors: [{ name: "x", unit: "V", samples: [1] }, { name: "x", unit: "V", samples: [2] }] }))).toThrow("duplicate");
    expect(() => parseSimulationResultEvidence(evidence({ analysisKind: "ac", vectors: [{ name: "v(out)", unit: "V", samples: [1] }, { name: "V(OUT)", unit: "V", samples: [2] }] }))).toThrow("duplicate");
    expect(() => parseSimulationResultEvidence({ ...evidence({ analysisKind: "ac", vectors: [] }), trusted: true })).toThrow("unknown field");
    expect(() => parseSimulationResultEvidence(evidence({
      modelDigests: Object.fromEntries(Array.from(
        { length: MAX_SIMULATION_MODELS + 1 },
        (_, index) => [`model_${index}`, `sha256:${"a".repeat(64)}`],
      )),
    }))).toThrow(`modelDigests exceeds ${MAX_SIMULATION_MODELS} entries`);
  });

  test("marks missing model coverage incomplete without evaluating solver output", () => {
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    raw.models = [];
    const incomplete = parseSimulationDefinition(raw);
    const assessment = assessSimulationResult(incomplete, { malformed: true }, binding());
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "SIM_MODEL_COVERAGE_INCOMPLETE_001",
    ]);
  });

  test("bounds missing-model detail while preserving the exact omitted occurrence count", () => {
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    (raw.region as Record<string, unknown>).componentIds = Array.from({ length: 300 }, (_, index) => `R${index}`);
    raw.models = [];
    const assessment = assessSimulationResult(parseSimulationDefinition(raw), { malformed: true }, binding());
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics[0]?.objects).toHaveLength(256);
    expect(assessment.diagnostics[0]?.omittedObjectCount).toBe(44);
    expect(assessment.diagnostics[0]?.message).toContain("…(+284)");
  });

  test("parses complex AC samples and evaluates magnitude projections", () => {
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    raw.analysis = { kind: "ac", scale: "decade", startHz: 10, stopHz: 1_000, points: 10 };
    (raw.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    raw.assertions = [{ expression: { kind: "vector", operand: { vector: "v(out)", projection: "magnitude", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 5, absoluteTolerance: 0.0001, relativeTolerance: 0 }];
    const acDefinition = parseSimulationDefinition(raw);
    const frequencies = Array.from({ length: 21 }, (_, index) => 10 * 10 ** (index / 10));
    const assessment = assessSimulationResult(acDefinition, evidence({
      definitionDigest: simulationDefinitionDigest(acDefinition),
      analysisKind: "ac",
      axis: { name: "frequency", unit: "Hz", values: frequencies },
      vectors: [{ name: "v(out)", unit: "V", samples: frequencies.map(() => ({ real: 3, imaginary: 4 })) }],
    }), binding());
    expect(assessment.status.state).toBe("incomplete");
  });

  test("evaluates magnitude and phase projections from one physical AC vector", () => {
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    raw.analysis = { kind: "ac", scale: "linear", startHz: 10, stopHz: 20, points: 2 };
    (raw.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    raw.assertions = [
      { expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "magnitude", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 5, absoluteTolerance: 0, relativeTolerance: 0 },
      { expression: { kind: "vector", operand: { vector: "v(vout)", projection: "phase-degrees", unit: "deg" } }, sample: { kind: "last" }, unit: "deg", expected: 53.13010235415598, absoluteTolerance: 1e-9, relativeTolerance: 0 },
    ];
    const acDefinition = parseSimulationDefinition(raw);
    const assessment = assessSimulationResult(acDefinition, evidence({
      definitionDigest: simulationDefinitionDigest(acDefinition),
      analysisKind: "ac",
      axis: { name: "frequency", unit: "Hz", values: [10, 20] },
      vectors: [{ name: "v(VOUT)", unit: "V", samples: [{ real: 3, imaginary: 4 }, { real: 3, imaginary: 4 }] }],
    }), binding());
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "SIM_EXECUTION_ADAPTER_UNAVAILABLE_001",
    ]);
  });

  test("caches repeated assertion projections instead of rescanning every sample", () => {
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    raw.analysis = { kind: "ac", scale: "linear", startHz: 1, stopHz: 100, points: 100 };
    (raw.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    const assertion = {
      expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "magnitude", unit: "V" } },
      sample: { kind: "minimum" },
      unit: "V",
      expected: 5,
      absoluteTolerance: 0,
      relativeTolerance: 0,
    };
    raw.assertions = Array.from({ length: 256 }, () => structuredClone(assertion));
    const repeated = parseSimulationDefinition(raw);
    const axis = Array.from({ length: 100 }, (_, index) => index + 1);
    const originalHypot = Math.hypot;
    let projections = 0;
    try {
      Math.hypot = ((...values: number[]) => {
        projections += 1;
        return originalHypot(...values);
      }) as typeof Math.hypot;
      const assessment = assessQualifiedSimulationResult(repeated, evidence({
        definitionDigest: simulationDefinitionDigest(repeated),
        analysisKind: "ac",
        axis: { name: "frequency", unit: "Hz", values: axis },
        vectors: [{ name: "v(VOUT)", unit: "V", samples: axis.map(() => ({ real: 3, imaginary: 4 })) }],
      }), binding());
      expect(assessment.status.state).toBe("passed");
      expect(projections).toBe(100);
    } finally {
      Math.hypot = originalHypot;
    }
  });

  test("fails replayed definitions and unsuccessful process evidence", () => {
    expect(assessSimulationResult(definition(), evidence({ definitionDigest: `sha256:${"0".repeat(64)}` }), binding()).status.state).toBe("failed");
    expect(assessSimulationResult(definition(), evidence({ execution: { exitCode: 9, timedOut: false, stdoutSha256: `sha256:${"e".repeat(64)}`, stderrSha256: `sha256:${"f".repeat(64)}`, rawOutputSha256: `sha256:${"a".repeat(64)}` } }), binding()).status.state).toBe("failed");
    expect(assessSimulationResult(definition(), evidence({ execution: { exitCode: 0, timedOut: true, stdoutSha256: `sha256:${"e".repeat(64)}`, stderrSha256: `sha256:${"f".repeat(64)}`, rawOutputSha256: `sha256:${"a".repeat(64)}` } }), binding()).status.state).toBe("failed");
  });

  test("fails forged bindings and undersampled sweeps", () => {
    expect(assessSimulationResult(definition(), evidence(), { ...binding(), netlistDigest: `sha256:${"9".repeat(64)}` }).status.state).toBe("failed");
    expect(assessSimulationResult(definition(), evidence(), { ...binding(), rawOutputSha256: `sha256:${"9".repeat(64)}` }).status.state).toBe("failed");
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    raw.analysis = { kind: "ac", scale: "decade", startHz: 1, stopHz: 1_000_000_000, points: 100 };
    (raw.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    raw.assertions = [{ expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "magnitude", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 1, absoluteTolerance: 0, relativeTolerance: 0 }];
    const huge = parseSimulationDefinition(raw);
    const forged = evidence({ definitionDigest: simulationDefinitionDigest(huge), analysisKind: "ac", axis: { name: "frequency", unit: "Hz", values: [1] }, vectors: [{ name: "v(VOUT)", unit: "V", samples: [{ real: 1, imaginary: 0 }] }] });
    expect(assessSimulationResult(huge, forged, binding()).status.state).toBe("failed");
    expect(assessSimulationResult(definition(), evidence({ modelDigests: {} }), { ...binding(), modelDigests: {} }).status.state).toBe("failed");
  });

  test("rejects oversized sample sets without spread or stack overflow", () => {
    expect(() => parseSimulationResultEvidence(evidence({
      vectors: [{ name: "v(VOUT)", unit: "V", samples: Array.from({ length: 200_001 }, () => 1) }],
    }))).toThrow("exceeds 200000");
  });

  test("rejects forged axis identity, endpoints, and sparse transient coverage", () => {
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    raw.analysis = { kind: "transient", stepSeconds: 0.00001, startSeconds: 0, stopSeconds: 1 };
    (raw.stimuli as Record<string, unknown>[])[0]!.transient = { kind: "pulse", initialValue: 0, pulsedValue: 5, delaySeconds: 0, riseSeconds: 0, fallSeconds: 0, widthSeconds: 0.5, periodSeconds: 1 };
    raw.assertions = [{ expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 2.5, absoluteTolerance: 0.001, relativeTolerance: 0 }];
    const transient = parseSimulationDefinition(raw);
    const forged = evidence({
      definitionDigest: simulationDefinitionDigest(transient),
      analysisKind: "transient",
      axis: { name: "not-time", unit: "s", values: [0.99999, 1e100] },
      vectors: [{ name: "v(VOUT)", unit: "V", samples: [0, 2.5] }],
    });
    const assessment = assessSimulationResult(transient, forged, binding());
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_VECTOR_COVERAGE_INVALID_001");

    const largeTimeRaw = structuredClone(raw) as Record<string, unknown>;
    largeTimeRaw.analysis = {
      kind: "transient",
      stepSeconds: 0.1,
      startSeconds: 1_000_000_000,
      stopSeconds: 1_000_000_001,
    };
    const largeTime = parseSimulationDefinition(largeTimeRaw);
    const oneSample = evidence({
      definitionDigest: simulationDefinitionDigest(largeTime),
      analysisKind: "transient",
      axis: { name: "time", unit: "s", values: [1_000_000_000] },
      vectors: [{ name: "v(VOUT)", unit: "V", samples: [2.5] }],
    });
    const qualified = assessQualifiedSimulationResult(largeTime, oneSample, binding());
    expect(qualified.status.state).toBe("failed");
    expect(qualified.diagnostics.map(({ id }) => String(id)))
      .toContain("SIM_VECTOR_COVERAGE_INVALID_001");

    const largeOffsetAxis = Array.from(
      { length: 11 },
      (_, index) => 1_000_000_000 + index * 0.1,
    );
    const sufficientlySampled = assessQualifiedSimulationResult(largeTime, evidence({
      definitionDigest: simulationDefinitionDigest(largeTime),
      analysisKind: "transient",
      axis: { name: "time", unit: "s", values: largeOffsetAxis },
      vectors: [{ name: "v(VOUT)", unit: "V", samples: largeOffsetAxis.map(() => 2.5) }],
    }), binding());
    expect(sufficientlySampled.status.state).toBe("passed");
    expect(sufficientlySampled.diagnostics).toEqual([]);

    const sparse = evidence({
      definitionDigest: simulationDefinitionDigest(largeTime),
      analysisKind: "transient",
      axis: {
        name: "time",
        unit: "s",
        values: [1_000_000_000, 1_000_000_000.5, 1_000_000_001],
      },
      vectors: [{ name: "v(VOUT)", unit: "V", samples: [2.5, 2.5, 2.5] }],
    });
    const originalGetFloat64 = DataView.prototype.getFloat64;
    try {
      DataView.prototype.getFloat64 = (() => Number.MAX_VALUE) as typeof DataView.prototype.getFloat64;
      const poisoned = assessQualifiedSimulationResult(largeTime, sparse, binding());
      expect(poisoned.status.state).toBe("failed");
      expect(poisoned.diagnostics.map(({ id }) => String(id)))
        .toContain("SIM_VECTOR_COVERAGE_INVALID_001");
    } finally {
      DataView.prototype.getFloat64 = originalGetFloat64;
    }
  });

  test("requires every declared DC and AC axis point", () => {
    const dcRaw = structuredClone(definition()) as unknown as Record<string, unknown>;
    dcRaw.analysis = { kind: "dc-sweep", sourceId: "VIN", start: 0, stop: 1, step: 0.25, unit: "V" };
    const dc = parseSimulationDefinition(dcRaw);
    const dcAssessment = assessSimulationResult(dc, evidence({
      definitionDigest: simulationDefinitionDigest(dc), analysisKind: "dc-sweep",
      axis: { name: "VIN", unit: "V", values: [0, 0.25, 0.6, 0.75, 1] },
      vectors: [{ name: "v(VOUT)", unit: "V", samples: [2.5, 2.5, 2.5, 2.5, 2.5] }],
    }), binding());
    expect(dcAssessment.status.state).toBe("failed");

    const acRaw = structuredClone(definition()) as unknown as Record<string, unknown>;
    acRaw.analysis = { kind: "ac", scale: "linear", startHz: 10, stopHz: 40, points: 4 };
    (acRaw.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    const ac = parseSimulationDefinition(acRaw);
    const acAssessment = assessSimulationResult(ac, evidence({
      definitionDigest: simulationDefinitionDigest(ac), analysisKind: "ac",
      axis: { name: "frequency", unit: "Hz", values: [10, 15, 30, 40] },
      vectors: [{ name: "v(VOUT)", unit: "V", samples: [2.5, 2.5, 2.5, 2.5] }],
    }), binding());
    expect(acAssessment.status.state).toBe("failed");
  });

  test("evaluates derived assertions at an explicit axis coordinate", () => {
    const raw = structuredClone(definition()) as unknown as Record<string, unknown>;
    raw.analysis = { kind: "transient", stepSeconds: 0.5, startSeconds: 0, stopSeconds: 1 };
    (raw.stimuli as Record<string, unknown>[])[0]!.transient = { kind: "pwl", points: [{ timeSeconds: 0, value: 0 }, { timeSeconds: 1, value: 5 }] };
    raw.assertions = [{
      expression: {
        kind: "ratio",
        left: { vector: "v(VOUT)", projection: "value", unit: "V" },
        right: { vector: "v(VIN)", projection: "value", unit: "V" },
      },
      sample: { kind: "at", axisValue: 0.5, axisUnit: "s", axisTolerance: 0, interpolation: "exact" },
      unit: "1",
      expected: 0.5,
      absoluteTolerance: 0.0001,
      relativeTolerance: 0,
    }];
    const derived = parseSimulationDefinition(raw);
    const assessment = assessSimulationResult(derived, evidence({
      definitionDigest: simulationDefinitionDigest(derived),
      analysisKind: "transient",
      axis: { name: "time", unit: "s", values: [0, 0.5, 1] },
      vectors: [
        { name: "v(VOUT)", unit: "V", samples: [0.5, 2.5, 5] },
        { name: "v(VIN)", unit: "V", samples: [1, 5, 5] },
      ],
    }), binding());
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toEqual(["SIM_EXECUTION_ADAPTER_UNAVAILABLE_001"]);
  });
});
