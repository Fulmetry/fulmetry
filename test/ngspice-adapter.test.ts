import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SIMULATION_MODEL_ARTIFACT_BYTES, parseSimulationDefinition, simulationDefinitionDigest } from "../src/simulation";
import { generateNgspiceNetlist, parseNgspiceAsciiRaw, runQualifiedNgspice } from "../src/simulation/ngspice";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function sha256(text: string | Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
}

function rawDefinition(modelDigest = `sha256:${"a".repeat(64)}`): Record<string, unknown> {
  return {
    schemaVersion: 1, name: "divider",
    region: { componentIds: ["R1", "R2"], netIds: ["VIN", "VOUT", "GND"] },
    models: [{
      id: "resistors", device: { kind: "primitive", name: "resistor" },
      bindings: [
        { componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
        { componentId: "R2", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } },
      ],
      path: "models/resistors.model", source: "test fixture", digest: modelDigest,
      license: "CC0-1.0", redistribution: "allowed",
    }],
    stimuli: [{ kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND", unit: "V", dcValue: 5, ac: null, transient: null }],
    solver: { engine: "ngspice" }, analysis: { kind: "operating-point" },
    assertions: [{ expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 2.5, absoluteTolerance: 0.001, relativeTolerance: 0 }],
    timeoutMs: 1_000,
  };
}

function dividerDcSweepDefinition(
  modelDigest: string,
  r2Resistance = "10k",
): Record<string, unknown> {
  const raw = rawDefinition(modelDigest);
  raw.name = "divider-dc-sweep";
  ((raw.models as any[])[0].bindings[1].parameters as Record<string, unknown>).resistance = r2Resistance;
  (raw.stimuli as Record<string, unknown>[])[0]!.dcValue = 1;
  raw.analysis = { kind: "dc-sweep", sourceId: "VIN", start: 1, stop: 5, step: 1, unit: "V" };
  const at = (axisValue: number) => ({
    kind: "at", axisValue, axisUnit: "V", axisTolerance: 1e-12, interpolation: "exact",
  });
  const operand = (vector: "v(VIN)" | "v(VOUT)") => ({ vector, projection: "value", unit: "V" });
  raw.assertions = [
    { expression: { kind: "vector", operand: operand("v(VOUT)") }, sample: at(1), unit: "V", expected: 0.5, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
    { expression: { kind: "vector", operand: operand("v(VOUT)") }, sample: at(3), unit: "V", expected: 1.5, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
    { expression: { kind: "ratio", left: operand("v(VOUT)"), right: operand("v(VIN)") }, sample: at(1), unit: "1", expected: 0.5, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
    { expression: { kind: "ratio", left: operand("v(VOUT)"), right: operand("v(VIN)") }, sample: at(5), unit: "1", expected: 0.5, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
  ];
  return raw;
}

function circuitJson(r2Resistance = 10_000): any[] {
  return [
    { type: "source_component", source_component_id: "R1", name: "R1", ftype: "simple_resistor", resistance: 10_000 },
    { type: "source_component", source_component_id: "R2", name: "R2", ftype: "simple_resistor", resistance: r2Resistance },
    { type: "source_port", source_port_id: "R1.1", source_component_id: "R1", name: "pin1", pin_number: 1 },
    { type: "source_port", source_port_id: "R1.2", source_component_id: "R1", name: "pin2", pin_number: 2 },
    { type: "source_port", source_port_id: "R2.1", source_component_id: "R2", name: "pin1", pin_number: 1 },
    { type: "source_port", source_port_id: "R2.2", source_component_id: "R2", name: "pin2", pin_number: 2 },
    { type: "source_net", source_net_id: "net-vin", name: "VIN", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-vout", name: "VOUT", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-gnd", name: "GND", member_source_group_ids: [] },
    { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["R1.1"], connected_source_net_ids: ["net-vin"] },
    { type: "source_trace", source_trace_id: "t2", connected_source_port_ids: ["R1.2", "R2.1"], connected_source_net_ids: ["net-vout"] },
    { type: "source_trace", source_trace_id: "t3", connected_source_port_ids: ["R2.2"], connected_source_net_ids: ["net-gnd"] },
  ];
}

const RC_MODEL_BYTES = Object.freeze({
  resistor: "* PCBoo built-in resistor provenance fixture\n",
  capacitor: "* PCBoo built-in capacitor provenance fixture\n",
  inductor: "* PCBoo built-in inductor provenance fixture\n",
});

function rcTransientDefinition(options: {
  readonly resistorDigest: string;
  readonly capacitorDigest: string;
  readonly capacitance?: string;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "rc-pulse-response",
    region: { componentIds: ["R1", "C1"], netIds: ["VIN", "VOUT", "GND"] },
    models: [
      {
        id: "rc-resistor",
        device: { kind: "primitive", name: "resistor" },
        bindings: [{ componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "1k" } }],
        path: "models/rc-resistor.model",
        source: "PCBoo analytical RC fixture",
        digest: options.resistorDigest,
        license: "CC0-1.0",
        redistribution: "allowed",
      },
      {
        id: "rc-capacitor",
        device: { kind: "primitive", name: "capacitor" },
        bindings: [{ componentId: "C1", pinMap: { "1": "1", "2": "2" }, parameters: { capacitance: options.capacitance ?? "1u" } }],
        path: "models/rc-capacitor.model",
        source: "PCBoo analytical RC fixture",
        digest: options.capacitorDigest,
        license: "CC0-1.0",
        redistribution: "allowed",
      },
    ],
    stimuli: [{
      kind: "voltage",
      sourceId: "VIN",
      positiveNode: "VIN",
      negativeNode: "GND",
      unit: "V",
      dcValue: 0,
      ac: null,
      transient: {
        kind: "pulse",
        initialValue: 0,
        pulsedValue: 5,
        delaySeconds: 0,
        riseSeconds: 0,
        fallSeconds: 0,
        widthSeconds: 0.006,
        periodSeconds: 0.012,
      },
    }],
    solver: { engine: "ngspice" },
    analysis: { kind: "transient", stepSeconds: 0.001, startSeconds: 0, stopSeconds: 0.011 },
    assertions: [
      // 1 kOhm * 1 uF = 1 ms. These are fixed closed-form oracle values,
      // deliberately separate from the recorded solver-output fixture below.
      { expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "at", axisValue: 0.001, axisUnit: "s", axisTolerance: 1e-12, interpolation: "exact" }, unit: "V", expected: 3.16060279414, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "at", axisValue: 0.005, axisUnit: "s", axisTolerance: 1e-12, interpolation: "exact" }, unit: "V", expected: 4.966310265, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "at", axisValue: 0.007, axisUnit: "s", axisTolerance: 1e-12, interpolation: "exact" }, unit: "V", expected: 1.83483779603, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "value", unit: "V" } }, sample: { kind: "at", axisValue: 0.011, axisUnit: "s", axisTolerance: 1e-12, interpolation: "exact" }, unit: "V", expected: 0.0336062264915, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
    ],
    timeoutMs: 1_000,
  };
}

function rcCircuitJson(capacitance = 1e-6, resistance = 1_000): any[] {
  return [
    { type: "source_component", source_component_id: "R1", name: "R1", ftype: "simple_resistor", resistance },
    { type: "source_component", source_component_id: "C1", name: "C1", ftype: "simple_capacitor", capacitance },
    { type: "source_port", source_port_id: "R1.1", source_component_id: "R1", name: "pin1", pin_number: 1 },
    { type: "source_port", source_port_id: "R1.2", source_component_id: "R1", name: "pin2", pin_number: 2 },
    { type: "source_port", source_port_id: "C1.1", source_component_id: "C1", name: "pin1", pin_number: 1 },
    { type: "source_port", source_port_id: "C1.2", source_component_id: "C1", name: "pin2", pin_number: 2 },
    { type: "source_net", source_net_id: "net-vin", name: "VIN", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-vout", name: "VOUT", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-gnd", name: "GND", member_source_group_ids: [] },
    { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["R1.1"], connected_source_net_ids: ["net-vin"] },
    { type: "source_trace", source_trace_id: "t2", connected_source_port_ids: ["R1.2", "C1.1"], connected_source_net_ids: ["net-vout"] },
    { type: "source_trace", source_trace_id: "t3", connected_source_port_ids: ["C1.2"], connected_source_net_ids: ["net-gnd"] },
  ];
}

const RC_ONE_MILLISECOND_SAMPLES = Object.freeze([
  0, 3.16060279414, 4.32332358382, 4.75106465816,
  4.90842180556, 4.966310265, 4.98760623912, 1.83483779603,
  0.674999103044, 0.248318292819, 0.0913511947949, 0.0336062264915,
]);

const RC_TEN_MILLISECOND_DEFECT_SAMPLES = Object.freeze([
  0, 0.47581290982, 0.90634623461, 1.29590889659,
  1.64839976982, 1.96734670144, 2.25594181953, 2.04126057122,
  1.8470089448, 1.67124280471, 1.51220302432, 1.36829788007,
]);

function transientRaw(samples: readonly number[]): string {
  if (samples.length !== 12) throw new Error("RC transient fixture must contain exactly 12 points");
  return [
    "Title: PCBoo analytical RC fixture",
    "Date: ignored",
    "Plotname: Transient Analysis",
    "Flags: real",
    "No. Variables: 2",
    `No. Points: ${samples.length}`,
    "Variables:",
    "  0 time time",
    "  1 v(vout) voltage",
    "Values:",
    ...samples.flatMap((sample, index) => [`${index} ${index / 1_000}`, `  ${sample}`]),
    "",
  ].join("\n");
}

const RC_AC_RESISTANCE = 1_591.5494309189535;

function rcAcDefinition(options: {
  readonly resistorDigest: string;
  readonly capacitorDigest: string;
  readonly capacitance?: string;
}): Record<string, unknown> {
  const at = (axisValue: number) => ({
    kind: "at", axisValue, axisUnit: "Hz", axisTolerance: 1e-9, interpolation: "exact",
  });
  const vector = (projection: "magnitude" | "phase-degrees", unit: "V" | "deg") => ({
    kind: "vector", operand: { vector: "v(VOUT)", projection, unit },
  });
  return {
    schemaVersion: 1,
    name: "rc-low-pass-ac",
    region: { componentIds: ["R1", "C1"], netIds: ["VIN", "VOUT", "GND"] },
    models: [
      {
        id: "rc-resistor",
        device: { kind: "primitive", name: "resistor" },
        bindings: [{ componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: String(RC_AC_RESISTANCE) } }],
        path: "models/rc-resistor.model",
        source: "PCBoo analytical AC fixture",
        digest: options.resistorDigest,
        license: "CC0-1.0",
        redistribution: "allowed",
      },
      {
        id: "rc-capacitor",
        device: { kind: "primitive", name: "capacitor" },
        bindings: [{ componentId: "C1", pinMap: { "1": "1", "2": "2" }, parameters: { capacitance: options.capacitance ?? "1u" } }],
        path: "models/rc-capacitor.model",
        source: "PCBoo analytical AC fixture",
        digest: options.capacitorDigest,
        license: "CC0-1.0",
        redistribution: "allowed",
      },
    ],
    stimuli: [{
      kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND",
      unit: "V", dcValue: 0, ac: { magnitude: 1, phaseDegrees: 0 }, transient: null,
    }],
    solver: { engine: "ngspice" },
    analysis: { kind: "ac", scale: "decade", startHz: 10, stopHz: 1_000, points: 1 },
    assertions: [
      // R is chosen so 1/(2*pi*R*C) = 100 Hz for C=1 uF.
      { expression: vector("magnitude", "V"), sample: at(10), unit: "V", expected: 0.99503719021, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: vector("magnitude", "V"), sample: at(100), unit: "V", expected: 0.707106781187, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: vector("phase-degrees", "deg"), sample: at(100), unit: "deg", expected: -45, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: vector("magnitude", "V"), sample: at(1_000), unit: "V", expected: 0.099503719021, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
    ],
    timeoutMs: 1_000,
  };
}

const RC_AC_100_HZ_CUTOFF_SAMPLES = Object.freeze([
  Object.freeze({ real: 0.990099009901, imaginary: -0.0990099009901 }),
  Object.freeze({ real: 0.5, imaginary: -0.5 }),
  Object.freeze({ real: 0.00990099009901, imaginary: -0.0990099009901 }),
]);

const RC_AC_10_HZ_CUTOFF_DEFECT_SAMPLES = Object.freeze([
  Object.freeze({ real: 0.5, imaginary: -0.5 }),
  Object.freeze({ real: 0.00990099009901, imaginary: -0.0990099009901 }),
  Object.freeze({ real: 0.000099990001, imaginary: -0.00999900009999 }),
]);

function acRaw(samples: readonly Readonly<{ real: number; imaginary: number }>[]): string {
  if (samples.length !== 3) throw new Error("RC AC fixture must contain exactly three decade points");
  const frequencies = [10, 100, 1_000] as const;
  return [
    "Title: PCBoo analytical AC fixture",
    "Date: ignored",
    "Plotname: AC Analysis",
    "Flags: complex",
    "No. Variables: 2",
    `No. Points: ${samples.length}`,
    "Variables:",
    "  0 frequency frequency",
    "  1 v(vout) voltage",
    "Values:",
    ...samples.flatMap((sample, index) => [
      `${index} ${frequencies[index]},0`,
      `  ${sample.real},${sample.imaginary}`,
    ]),
    "",
  ].join("\n");
}

const RLC_RESONANT_FREQUENCY_HZ = 1_591.5494309189535;
const RLC_AC_FREQUENCIES = Object.freeze([
  RLC_RESONANT_FREQUENCY_HZ / 10,
  RLC_RESONANT_FREQUENCY_HZ,
  RLC_RESONANT_FREQUENCY_HZ * 10,
]);

function rlcAcDefinition(options: {
  readonly resistorDigest: string;
  readonly capacitorDigest: string;
  readonly inductorDigest: string;
  readonly resistance?: string;
}): Record<string, unknown> {
  const at = (axisValue: number) => ({
    kind: "at", axisValue, axisUnit: "Hz", axisTolerance: 1e-9, interpolation: "exact",
  });
  const vector = (projection: "magnitude" | "phase-degrees", unit: "V" | "deg") => ({
    kind: "vector", operand: { vector: "v(VOUT)", projection, unit },
  });
  return {
    schemaVersion: 1,
    name: "series-rlc-capacitor-response",
    region: { componentIds: ["R1", "L1", "C1"], netIds: ["VIN", "N1", "VOUT", "GND"] },
    models: [
      {
        id: "rlc-resistor", device: { kind: "primitive", name: "resistor" },
        bindings: [{ componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: options.resistance ?? "10" } }],
        path: "models/rlc-resistor.model", source: "PCBoo analytical RLC fixture",
        digest: options.resistorDigest, license: "CC0-1.0", redistribution: "allowed",
      },
      {
        id: "rlc-inductor", device: { kind: "primitive", name: "inductor" },
        bindings: [{ componentId: "L1", pinMap: { "1": "1", "2": "2" }, parameters: { inductance: "10m" } }],
        path: "models/rlc-inductor.model", source: "PCBoo analytical RLC fixture",
        digest: options.inductorDigest, license: "CC0-1.0", redistribution: "allowed",
      },
      {
        id: "rlc-capacitor", device: { kind: "primitive", name: "capacitor" },
        bindings: [{ componentId: "C1", pinMap: { "1": "1", "2": "2" }, parameters: { capacitance: "1u" } }],
        path: "models/rlc-capacitor.model", source: "PCBoo analytical RLC fixture",
        digest: options.capacitorDigest, license: "CC0-1.0", redistribution: "allowed",
      },
    ],
    stimuli: [{
      kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND",
      unit: "V", dcValue: 0, ac: { magnitude: 1, phaseDegrees: 0 }, transient: null,
    }],
    solver: { engine: "ngspice" },
    analysis: {
      kind: "ac", scale: "decade", startHz: RLC_AC_FREQUENCIES[0],
      stopHz: RLC_AC_FREQUENCIES[2], points: 1,
    },
    assertions: [
      // L=10 mH and C=1 uF give f0=1591.5494309 Hz. With R=10 ohm,
      // Q=sqrt(L/C)/R=10 and the capacitor voltage has 10 V/V gain at f0.
      { expression: vector("magnitude", "V"), sample: at(RLC_AC_FREQUENCIES[0]!), unit: "V", expected: 1.010049483536, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: vector("magnitude", "V"), sample: at(RLC_AC_FREQUENCIES[1]!), unit: "V", expected: 10, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: vector("phase-degrees", "deg"), sample: at(RLC_AC_FREQUENCIES[1]!), unit: "deg", expected: -90, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
      { expression: vector("magnitude", "V"), sample: at(RLC_AC_FREQUENCIES[2]!), unit: "V", expected: 0.0101004948354, absoluteTolerance: 1e-9, relativeTolerance: 1e-9 },
    ],
    timeoutMs: 1_000,
  };
}

function rlcCircuitJson(resistance = 10): any[] {
  return [
    { type: "source_component", source_component_id: "R1", name: "R1", ftype: "simple_resistor", resistance },
    { type: "source_component", source_component_id: "L1", name: "L1", ftype: "simple_inductor", inductance: 0.01 },
    { type: "source_component", source_component_id: "C1", name: "C1", ftype: "simple_capacitor", capacitance: 1e-6 },
    ...["R1", "L1", "C1"].flatMap((id) => [
      { type: "source_port", source_port_id: `${id}.1`, source_component_id: id, name: "pin1", pin_number: 1 },
      { type: "source_port", source_port_id: `${id}.2`, source_component_id: id, name: "pin2", pin_number: 2 },
    ]),
    { type: "source_net", source_net_id: "net-vin", name: "VIN", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-n1", name: "N1", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-vout", name: "VOUT", member_source_group_ids: [] },
    { type: "source_net", source_net_id: "net-gnd", name: "GND", member_source_group_ids: [] },
    { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["R1.1"], connected_source_net_ids: ["net-vin"] },
    { type: "source_trace", source_trace_id: "t2", connected_source_port_ids: ["R1.2", "L1.1"], connected_source_net_ids: ["net-n1"] },
    { type: "source_trace", source_trace_id: "t3", connected_source_port_ids: ["L1.2", "C1.1"], connected_source_net_ids: ["net-vout"] },
    { type: "source_trace", source_trace_id: "t4", connected_source_port_ids: ["C1.2"], connected_source_net_ids: ["net-gnd"] },
  ];
}

const RLC_Q10_SAMPLES = Object.freeze([
  Object.freeze({ real: 1.0099979596000817, imaginary: -0.010201999591920016 }),
  Object.freeze({ real: 0, imaginary: -9.999999999999998 }),
  Object.freeze({ real: -0.010099979596000817, imaginary: -0.00010201999591920016 }),
]);

const RLC_Q1_DEFECT_SAMPLES = Object.freeze([
  Object.freeze({ real: 0.9998990001009999, imaginary: -0.100999899000101 }),
  Object.freeze({ real: 0, imaginary: -1 }),
  Object.freeze({ real: -0.009998990001009999, imaginary: -0.00100999899000101 }),
]);

function rlcAcRaw(samples: readonly Readonly<{ real: number; imaginary: number }>[]): string {
  if (samples.length !== RLC_AC_FREQUENCIES.length) throw new Error("RLC AC fixture point count changed");
  return [
    "Title: PCBoo analytical RLC fixture", "Date: ignored", "Plotname: AC Analysis", "Flags: complex",
    "No. Variables: 2", `No. Points: ${samples.length}`, "Variables:",
    "  0 frequency frequency", "  1 v(vout) voltage", "Values:",
    ...samples.flatMap((sample, index) => [
      `${index} ${RLC_AC_FREQUENCIES[index]},0`, `  ${sample.real},${sample.imaginary}`,
    ]),
    "",
  ].join("\n");
}

function operatingPointRaw(value = "2.5000"): string {
  return [
    "Title: PCBoo fixture", "Date: ignored", "Plotname: Operating Point", "Flags: real",
    "No. Variables: 1", "No. Points: 1", "Variables:", "  0 v(vout) voltage",
    "Values:", `0 ${value}`, "",
  ].join("\n");
}

const DIVIDER_DC_AXIS = Object.freeze([1, 2, 3, 4, 5]);
const DIVIDER_HALF_SAMPLES = Object.freeze([0.5, 1, 1.5, 2, 2.5]);
const DIVIDER_TWO_THIRDS_DEFECT_SAMPLES = Object.freeze([
  0.666666666666667, 1.33333333333333, 2, 2.66666666666667, 3.33333333333333,
]);

function dcSweepRaw(voutSamples: readonly number[]): string {
  if (voutSamples.length !== DIVIDER_DC_AXIS.length) throw new Error("DC sweep fixture point count changed");
  return [
    "Title: PCBoo analytical divider sweep", "Date: ignored",
    "Plotname: DC transfer characteristic", "Flags: real",
    "No. Variables: 3", `No. Points: ${voutSamples.length}`, "Variables:",
    "  0 v-sweep voltage", "  1 v(vin) voltage", "  2 v(vout) voltage", "Values:",
    ...voutSamples.flatMap((vout, index) => [
      `${index} ${DIVIDER_DC_AXIS[index]}`, `  ${DIVIDER_DC_AXIS[index]}`, `  ${vout}`,
    ]),
    "",
  ].join("\n");
}

async function fakeNgspice(root: string, raw = operatingPointRaw(), mode: "ok" | "timeout" | "crash" | "fatal" | "extra" | "tool-extra" | "raw-symlink" | "delayed" | "child" = "ok"): Promise<string> {
  const executable = join(root, "fake-ngspice");
  const script = mode === "timeout"
    ? `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('ngspice-44');process.exit(0)}await new Promise(()=>{})\n`
    : mode === "child"
      ? `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('ngspice-44');process.exit(0)}try{const child=Bun.spawn({cmd:[process.execPath,'-e','await new Promise(()=>{})'],stdin:'ignore',stdout:'ignore',stderr:'ignore'});await Bun.write(${JSON.stringify(join(root, "child.pid"))},String(child.pid))}catch{await Bun.write(${JSON.stringify(join(root, "child.pid"))},'blocked')}await new Promise(()=>{})\n`
    : `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('ngspice-44');process.exit(0)}${mode === "crash" ? "process.exit(9)" : mode === "raw-symlink" ? "const {symlink}=await import('node:fs/promises');const i=process.argv.indexOf('-r');await symlink('input.cir',process.argv[i+1]);" : `const i=process.argv.indexOf('-r');${mode === "delayed" ? "await Bun.sleep(100);" : ""}await Bun.write(process.argv[i+1],${JSON.stringify(raw)});${mode === "fatal" ? "console.error('singular matrix');" : ""}${mode === "extra" ? "const {mkdir}=await import('node:fs/promises');await mkdir('models/nested');await Bun.write('models/nested/extra','spoof');" : ""}${mode === "tool-extra" ? "await Bun.write('tool/unexpected','keep');" : ""}`}\n`;
  await Bun.write(executable, script);
  await chmod(executable, 0o700);
  return executable;
}

describe("qualified ngspice adapter", () => {
  test("checks an analytical RC charge/discharge response through bounded execution and preserves electrical failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-rc-")); roots.push(root);
    await mkdir(join(root, "models"));
    await Bun.write(join(root, "models/rc-resistor.model"), RC_MODEL_BYTES.resistor);
    await Bun.write(join(root, "models/rc-capacitor.model"), RC_MODEL_BYTES.capacitor);
    const digests = {
      resistorDigest: sha256(RC_MODEL_BYTES.resistor),
      capacitorDigest: sha256(RC_MODEL_BYTES.capacitor),
    };

    const nominalDefinition = parseSimulationDefinition(rcTransientDefinition(digests));
    const nominalDeck = generateNgspiceNetlist({
      definition: nominalDefinition,
      circuitJson: rcCircuitJson(),
      modelPaths: { "rc-resistor": "models/rc-resistor.model", "rc-capacitor": "models/rc-capacitor.model" },
    });
    expect(nominalDeck).toContain("R1 VIN VOUT 1000");
    expect(nominalDeck).toContain("C1 VOUT 0 0.000001");
    expect(nominalDeck).toContain("VIN VIN 0 DC 0 PULSE(0 5 0 0 0 0.006 0.012)");
    expect(nominalDeck).toContain(".tran 0.001 0.011 0");

    const nominalOutputRoot = join(root, "output-nominal");
    const nominalRunDirectory = join(nominalOutputRoot, "run");
    await mkdir(nominalRunDirectory, { recursive: true });
    const nominalRaw = transientRaw(RC_ONE_MILLISECOND_SAMPLES);
    const nominal = await runQualifiedNgspice({
      projectRoot: root,
      outputRoot: nominalOutputRoot,
      runDirectory: nominalRunDirectory,
      definition: nominalDefinition,
      circuitJson: rcCircuitJson(),
      executable: await fakeNgspice(root, nominalRaw),
    });
    // The electrical assertions passed, but the fake executable is correctly
    // barred from becoming release evidence by the empty live identity matrix.
    expect(nominal.assessment.status.state).toBe("incomplete");
    expect(nominal.assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001",
    ]);
    expect(nominal.evidence).toMatchObject({
      solverStatus: "converged",
      analysisKind: "transient",
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(nominalRaw) },
    });

    const defectiveDefinition = parseSimulationDefinition(rcTransientDefinition({ ...digests, capacitance: "10u" }));
    const defectiveDeck = generateNgspiceNetlist({
      definition: defectiveDefinition,
      circuitJson: rcCircuitJson(10e-6),
      modelPaths: { "rc-resistor": "models/rc-resistor.model", "rc-capacitor": "models/rc-capacitor.model" },
    });
    expect(defectiveDeck).toContain("C1 VOUT 0 0.00001");
    const defectiveOutputRoot = join(root, "output-defective");
    const defectiveRunDirectory = join(defectiveOutputRoot, "run");
    await mkdir(defectiveRunDirectory, { recursive: true });
    const defectiveRaw = transientRaw(RC_TEN_MILLISECOND_DEFECT_SAMPLES);
    const defective = await runQualifiedNgspice({
      projectRoot: root,
      outputRoot: defectiveOutputRoot,
      runDirectory: defectiveRunDirectory,
      definition: defectiveDefinition,
      circuitJson: rcCircuitJson(10e-6),
      executable: await fakeNgspice(root, defectiveRaw),
    });
    expect(defective.evidence).toMatchObject({
      solverStatus: "converged",
      analysisKind: "transient",
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(defectiveRaw) },
    });
    expect(defective.assessment.status.state).toBe("failed");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_ASSERTION_FAILED_001");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).not.toContain("SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001");
    expect(defective.artifacts.map(({ path }) => path)).toContain("simulation/evidence.json");
  });

  test("checks an analytical RC AC response and rejects a shifted cutoff despite valid solver evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-ac-")); roots.push(root);
    await mkdir(join(root, "models"));
    await Bun.write(join(root, "models/rc-resistor.model"), RC_MODEL_BYTES.resistor);
    await Bun.write(join(root, "models/rc-capacitor.model"), RC_MODEL_BYTES.capacitor);
    const digests = {
      resistorDigest: sha256(RC_MODEL_BYTES.resistor),
      capacitorDigest: sha256(RC_MODEL_BYTES.capacitor),
    };

    const nominalDefinition = parseSimulationDefinition(rcAcDefinition(digests));
    const nominalCircuit = rcCircuitJson(1e-6, RC_AC_RESISTANCE);
    const nominalDeck = generateNgspiceNetlist({
      definition: nominalDefinition,
      circuitJson: nominalCircuit,
      modelPaths: { "rc-resistor": "models/rc-resistor.model", "rc-capacitor": "models/rc-capacitor.model" },
    });
    expect(nominalDeck).toContain(`R1 VIN VOUT ${RC_AC_RESISTANCE}`);
    expect(nominalDeck).toContain("C1 VOUT 0 0.000001");
    expect(nominalDeck).toContain("VIN VIN 0 DC 0 AC 1 0");
    expect(nominalDeck.match(/^\.save v\(VOUT\)$/gmu)).toHaveLength(1);
    expect(nominalDeck).toContain(".ac dec 1 10 1000");

    const nominalOutputRoot = join(root, "output-nominal");
    const nominalRunDirectory = join(nominalOutputRoot, "run");
    await mkdir(nominalRunDirectory, { recursive: true });
    const nominalRaw = acRaw(RC_AC_100_HZ_CUTOFF_SAMPLES);
    const nominal = await runQualifiedNgspice({
      projectRoot: root,
      outputRoot: nominalOutputRoot,
      runDirectory: nominalRunDirectory,
      definition: nominalDefinition,
      circuitJson: nominalCircuit,
      executable: await fakeNgspice(root, nominalRaw),
    });
    expect(nominal.assessment.status.state).toBe("incomplete");
    expect(nominal.assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001",
    ]);
    expect(nominal.evidence).toMatchObject({
      solverStatus: "converged",
      analysisKind: "ac",
      axis: { name: "frequency", unit: "Hz", values: [10, 100, 1_000] },
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(nominalRaw) },
    });

    const defectiveDefinition = parseSimulationDefinition(rcAcDefinition({ ...digests, capacitance: "10u" }));
    const defectiveCircuit = rcCircuitJson(10e-6, RC_AC_RESISTANCE);
    const defectiveDeck = generateNgspiceNetlist({
      definition: defectiveDefinition,
      circuitJson: defectiveCircuit,
      modelPaths: { "rc-resistor": "models/rc-resistor.model", "rc-capacitor": "models/rc-capacitor.model" },
    });
    expect(defectiveDeck).toContain("C1 VOUT 0 0.00001");
    const defectiveOutputRoot = join(root, "output-defective");
    const defectiveRunDirectory = join(defectiveOutputRoot, "run");
    await mkdir(defectiveRunDirectory, { recursive: true });
    const defectiveRaw = acRaw(RC_AC_10_HZ_CUTOFF_DEFECT_SAMPLES);
    const defective = await runQualifiedNgspice({
      projectRoot: root,
      outputRoot: defectiveOutputRoot,
      runDirectory: defectiveRunDirectory,
      definition: defectiveDefinition,
      circuitJson: defectiveCircuit,
      executable: await fakeNgspice(root, defectiveRaw),
    });
    expect(defective.evidence).toMatchObject({
      solverStatus: "converged",
      analysisKind: "ac",
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(defectiveRaw) },
    });
    expect(defective.assessment.status.state).toBe("failed");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_ASSERTION_FAILED_001");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).not.toContain("SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001");
  });

  test("checks an analytical resonant RLC response and rejects a Q-changing mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-rlc-")); roots.push(root);
    await mkdir(join(root, "models"));
    await Bun.write(join(root, "models/rlc-resistor.model"), RC_MODEL_BYTES.resistor);
    await Bun.write(join(root, "models/rlc-inductor.model"), RC_MODEL_BYTES.inductor);
    await Bun.write(join(root, "models/rlc-capacitor.model"), RC_MODEL_BYTES.capacitor);
    const digests = {
      resistorDigest: sha256(RC_MODEL_BYTES.resistor),
      inductorDigest: sha256(RC_MODEL_BYTES.inductor),
      capacitorDigest: sha256(RC_MODEL_BYTES.capacitor),
    };

    const nominalDefinition = parseSimulationDefinition(rlcAcDefinition(digests));
    const nominalCircuit = rlcCircuitJson();
    const nominalDeck = generateNgspiceNetlist({
      definition: nominalDefinition,
      circuitJson: nominalCircuit,
      modelPaths: {
        "rlc-resistor": "models/rlc-resistor.model", "rlc-inductor": "models/rlc-inductor.model",
        "rlc-capacitor": "models/rlc-capacitor.model",
      },
    });
    expect(nominalDeck).toContain("R1 VIN N1 10");
    expect(nominalDeck).toContain("L1 N1 VOUT 0.01");
    expect(nominalDeck).toContain("C1 VOUT 0 0.000001");
    expect(nominalDeck).toContain("VIN VIN 0 DC 0 AC 1 0");
    expect(nominalDeck).toContain(`.ac dec 1 ${RLC_AC_FREQUENCIES[0]} ${RLC_AC_FREQUENCIES[2]}`);

    const nominalOutputRoot = join(root, "output-nominal");
    const nominalRunDirectory = join(nominalOutputRoot, "run");
    await mkdir(nominalRunDirectory, { recursive: true });
    const nominalRaw = rlcAcRaw(RLC_Q10_SAMPLES);
    const nominal = await runQualifiedNgspice({
      projectRoot: root, outputRoot: nominalOutputRoot, runDirectory: nominalRunDirectory,
      definition: nominalDefinition, circuitJson: nominalCircuit,
      executable: await fakeNgspice(root, nominalRaw),
    });
    expect(nominal.assessment.status.state).toBe("incomplete");
    expect(nominal.assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001",
    ]);
    expect(nominal.evidence).toMatchObject({
      solverStatus: "converged", analysisKind: "ac",
      axis: { name: "frequency", unit: "Hz", values: RLC_AC_FREQUENCIES },
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(nominalRaw) },
    });

    const defectiveDefinition = parseSimulationDefinition(rlcAcDefinition({ ...digests, resistance: "100" }));
    const defectiveCircuit = rlcCircuitJson(100);
    const defectiveDeck = generateNgspiceNetlist({
      definition: defectiveDefinition,
      circuitJson: defectiveCircuit,
      modelPaths: {
        "rlc-resistor": "models/rlc-resistor.model", "rlc-inductor": "models/rlc-inductor.model",
        "rlc-capacitor": "models/rlc-capacitor.model",
      },
    });
    expect(defectiveDeck).toContain("R1 VIN N1 100");
    const defectiveOutputRoot = join(root, "output-defective");
    const defectiveRunDirectory = join(defectiveOutputRoot, "run");
    await mkdir(defectiveRunDirectory, { recursive: true });
    const defectiveRaw = rlcAcRaw(RLC_Q1_DEFECT_SAMPLES);
    const defective = await runQualifiedNgspice({
      projectRoot: root, outputRoot: defectiveOutputRoot, runDirectory: defectiveRunDirectory,
      definition: defectiveDefinition, circuitJson: defectiveCircuit,
      executable: await fakeNgspice(root, defectiveRaw),
    });
    expect(defective.evidence).toMatchObject({
      solverStatus: "converged", analysisKind: "ac",
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(defectiveRaw) },
    });
    expect(defective.assessment.status.state).toBe("failed");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_ASSERTION_FAILED_001");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).not.toContain("SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001");
  });

  test("checks an analytical divider DC sweep and rejects a ratio mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-dc-")); roots.push(root);
    await mkdir(join(root, "models"));
    const model = "* PCBoo built-in divider provenance fixture\n";
    await Bun.write(join(root, "models/resistors.model"), model);
    const modelDigest = sha256(model);

    const nominalDefinition = parseSimulationDefinition(dividerDcSweepDefinition(modelDigest));
    const nominalDeck = generateNgspiceNetlist({
      definition: nominalDefinition,
      circuitJson: circuitJson(),
      modelPaths: { resistors: "models/resistors.model" },
    });
    expect(nominalDeck).toContain("R1 VIN VOUT 10000");
    expect(nominalDeck).toContain("R2 VOUT 0 10000");
    expect(nominalDeck).toContain("VIN VIN 0 DC 1");
    expect(nominalDeck).toContain(".save v(VIN) v(VOUT)");
    expect(nominalDeck).toContain(".dc VIN 1 5 1");

    const nominalOutputRoot = join(root, "output-nominal");
    const nominalRunDirectory = join(nominalOutputRoot, "run");
    await mkdir(nominalRunDirectory, { recursive: true });
    const nominalRaw = dcSweepRaw(DIVIDER_HALF_SAMPLES);
    const nominal = await runQualifiedNgspice({
      projectRoot: root, outputRoot: nominalOutputRoot, runDirectory: nominalRunDirectory,
      definition: nominalDefinition, circuitJson: circuitJson(),
      executable: await fakeNgspice(root, nominalRaw),
    });
    expect(nominal.assessment.status.state).toBe("incomplete");
    expect(nominal.assessment.diagnostics.map(({ id }) => String(id))).toEqual([
      "SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001",
    ]);
    expect(nominal.evidence).toMatchObject({
      solverStatus: "converged", analysisKind: "dc-sweep",
      axis: { name: "VIN", unit: "V", values: DIVIDER_DC_AXIS },
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(nominalRaw) },
    });

    const defectiveDefinition = parseSimulationDefinition(dividerDcSweepDefinition(modelDigest, "20k"));
    const defectiveCircuit = circuitJson(20_000);
    const defectiveDeck = generateNgspiceNetlist({
      definition: defectiveDefinition,
      circuitJson: defectiveCircuit,
      modelPaths: { resistors: "models/resistors.model" },
    });
    expect(defectiveDeck).toContain("R2 VOUT 0 20000");
    const defectiveOutputRoot = join(root, "output-defective");
    const defectiveRunDirectory = join(defectiveOutputRoot, "run");
    await mkdir(defectiveRunDirectory, { recursive: true });
    const defectiveRaw = dcSweepRaw(DIVIDER_TWO_THIRDS_DEFECT_SAMPLES);
    const defective = await runQualifiedNgspice({
      projectRoot: root, outputRoot: defectiveOutputRoot, runDirectory: defectiveRunDirectory,
      definition: defectiveDefinition, circuitJson: defectiveCircuit,
      executable: await fakeNgspice(root, defectiveRaw),
    });
    expect(defective.evidence).toMatchObject({
      solverStatus: "converged", analysisKind: "dc-sweep",
      execution: { exitCode: 0, timedOut: false, rawOutputSha256: sha256(defectiveRaw) },
    });
    expect(defective.assessment.status.state).toBe("failed");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_ASSERTION_FAILED_001");
    expect(defective.assessment.diagnostics.map(({ id }) => String(id))).not.toContain("SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001");
  });

  test("generates a bounded explicit-region deck without a shell or inferred whole-board content", () => {
    const definition = parseSimulationDefinition(rawDefinition());
    const deck = generateNgspiceNetlist({ definition, circuitJson: circuitJson(), modelPaths: { resistors: "models/resistors.model" } });
    expect(deck).toContain("R1 VIN VOUT 10000");
    expect(deck).toContain("R2 VOUT 0 10000");
    expect(deck).toContain("VIN VIN 0 DC 5");
    expect(deck).toContain(".options filetype=ascii");
    expect(deck).toContain(".save v(VOUT)");
    expect(deck).toContain(".op\n.end");
    expect(deck).not.toContain(".control");
    expect(deck).not.toContain(".include");
  });

  test("rejects distinct selected nets that collapse case-insensitively in ngspice", () => {
    const hostileDefinition = structuredClone(rawDefinition());
    (hostileDefinition.region as { netIds: string[] }).netIds = ["VIN", "vin", "VOUT", "GND"];
    const hostileCircuit = circuitJson();
    hostileCircuit.push({
      type: "source_net",
      source_net_id: "net-vin-lower",
      name: "vin",
      member_source_group_ids: [],
    });

    expect(() => generateNgspiceNetlist({
      definition: parseSimulationDefinition(hostileDefinition),
      circuitJson: hostileCircuit,
      modelPaths: { resistors: "models/resistors.model" },
    })).toThrow("case-insensitively duplicated SPICE node");
  });

  test("rejects testbench primitive values that do not match authoritative Circuit JSON", () => {
    const definition = parseSimulationDefinition(rawDefinition());
    const changed = circuitJson();
    changed[0].resistance = 1_000;
    expect(() => generateNgspiceNetlist({ definition, circuitJson: changed, modelPaths: { resistors: "models/resistors.model" } })).toThrow("does not match authored");
    const extra = structuredClone(rawDefinition());
    ((extra.models as any[])[0].bindings[0].parameters as Record<string, unknown>).temperature = 25;
    expect(() => generateNgspiceNetlist({ definition: parseSimulationDefinition(extra), circuitJson: circuitJson(), modelPaths: { resistors: "models/resistors.model" } })).toThrow("exactly the resistance parameter");
  });

  test("parses exact generated ASCII vectors and rejects spoofed, missing, duplicate, malformed, and non-finite data", () => {
    const definition = parseSimulationDefinition(rawDefinition());
    const parsed = parseNgspiceAsciiRaw(new TextEncoder().encode(operatingPointRaw()), definition);
    expect(parsed.vectors[0]).toMatchObject({ name: "v(VOUT)", unit: "V", samples: [2.5] });
    for (const hostile of [
      operatingPointRaw("NaN"),
      operatingPointRaw().replace("v(vout)", "v(other)"),
      operatingPointRaw().replace("No. Variables: 1", "No. Variables: 2").replace("Values:", "  1 v(vout) voltage\nValues:").replace("0 2.5000", "0 2.5000\n  2.5000"),
      operatingPointRaw().replace("0 2.5000", "1 2.5000"),
      `${operatingPointRaw()}0 999\n`,
      operatingPointRaw().replace("Values:", "Binary:"),
    ]) expect(() => parseNgspiceAsciiRaw(new TextEncoder().encode(hostile), definition)).toThrow();
  });

  test("derives raw evidence units from ngspice vector type even for a forged structural definition", () => {
    const definition = parseSimulationDefinition(rawDefinition());
    const assertion = definition.assertions[0]!;
    const forged = {
      ...definition,
      assertions: [{
        ...assertion,
        expression: {
          kind: "vector" as const,
          operand: { ...assertion.expression.kind === "vector" ? assertion.expression.operand : assertion.expression.left, unit: "A" as const },
        },
        unit: "A",
      }],
    };
    const parsed = parseNgspiceAsciiRaw(new TextEncoder().encode(operatingPointRaw()), forged);
    expect(parsed.vectors[0]?.unit).toBe("V");
  });

  test("saves a physical vector once when assertions use both magnitude and phase", () => {
    const raw = rawDefinition();
    raw.analysis = { kind: "ac", scale: "linear", startHz: 10, stopHz: 20, points: 2 };
    (raw.stimuli as Record<string, unknown>[])[0]!.ac = { magnitude: 1, phaseDegrees: 0 };
    raw.assertions = [
      { expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "magnitude", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 1, absoluteTolerance: 0.01, relativeTolerance: 0 },
      { expression: { kind: "vector", operand: { vector: "v(VOUT)", projection: "phase-degrees", unit: "deg" } }, sample: { kind: "last" }, unit: "deg", expected: 0, absoluteTolerance: 0.1, relativeTolerance: 0 },
    ];
    const deck = generateNgspiceNetlist({
      definition: parseSimulationDefinition(raw),
      circuitJson: circuitJson(),
      modelPaths: { resistors: "models/resistors.model" },
    });
    expect(deck.match(/^\.save v\(VOUT\)$/gmu)).toHaveLength(1);
  });

  test("binds tool, circuit, netlist, models, stdio, and raw bytes before passing numeric assertions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run"); await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
    const definition = parseSimulationDefinition(rawDefinition(sha256(model)));
    const executable = await fakeNgspice(root);
    const result = await runQualifiedNgspice({ projectRoot: root, outputRoot, runDirectory, definition, circuitJson: circuitJson(), executable });
    expect(result.assessment.status.state).toBe("incomplete");
    expect(result.assessment.diagnostics.map(({ id }) => String(id))).toEqual(["SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001"]);
    expect(result.evidence?.tool).toMatchObject({ name: "ngspice", version: "44" });
    expect(result.evidence?.execution.rawOutputSha256).toBe(sha256(operatingPointRaw()));
    expect(result.artifacts.map(({ path }) => path)).toEqual([
      "simulation/input.cir", "simulation/result.raw", "simulation/stdout.bin", "simulation/stderr.bin",
      "simulation/qualification.json", "simulation/models/resistors.model", "simulation/evidence.json",
    ]);
    expect(result.evidence?.schemaVersion).toBe(2);
    expect(result.evidence?.qualificationSha256).toBe(
      sha256(await Bun.file(join(runDirectory, "simulation/qualification.json")).bytes()),
    );
  });

  test("fails process crashes and timeouts and never treats output absence as a skip", async () => {
    for (const mode of ["crash", "timeout", "fatal"] as const) {
      const root = await mkdtemp(join(tmpdir(), `pcboo-ngspice-${mode}-`)); roots.push(root);
      const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run"); await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
      const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
      const raw = rawDefinition(sha256(model)); raw.timeoutMs = 50;
      const result = await runQualifiedNgspice({ projectRoot: root, outputRoot, runDirectory, definition: parseSimulationDefinition(raw), circuitJson: circuitJson(), executable: await fakeNgspice(root, operatingPointRaw(), mode) });
      expect(result.assessment.status.state).toBe("failed");
      expect(result.assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_EXECUTION_FAILED_001");
    }
  });

  test("keeps unqualified component models incomplete instead of silently substituting behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-unsupported-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run"); await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture D\n"; await Bun.write(join(root, "models/resistors.model"), model);
    const raw = rawDefinition(sha256(model));
    (raw.models as any[])[0].device = { kind: "primitive", name: "diode" };
    const result = await runQualifiedNgspice({ projectRoot: root, outputRoot, runDirectory, definition: parseSimulationDefinition(raw), circuitJson: circuitJson(), executable: await fakeNgspice(root) });
    expect(result.assessment.status.state).toBe("incomplete");
    expect(result.assessment.diagnostics.map(({ id }) => String(id))).toContain("SIM_NETLIST_UNSUPPORTED_001");
  });

  test("rejects aggregate model artifacts before creating a simulation directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-model-budget-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
    await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const modelPath = join(root, "models/shared.model");
    await Bun.write(modelPath, "");
    await truncate(modelPath, Math.floor(MAX_SIMULATION_MODEL_ARTIFACT_BYTES / 5) + 1);
    const raw = rawDefinition(`sha256:${"a".repeat(64)}`);
    const componentIds = Array.from({ length: 5 }, (_, index) => `R${index}`);
    (raw.region as Record<string, unknown>).componentIds = componentIds;
    raw.models = componentIds.map((componentId, index) => ({
      id: `model_${index}`,
      device: { kind: "primitive", name: "resistor" },
      bindings: [{ componentId, pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } }],
      path: "models/shared.model",
      source: "test fixture",
      digest: `sha256:${"a".repeat(64)}`,
      license: "CC0-1.0",
      redistribution: "allowed",
    }));
    const result = await runQualifiedNgspice({
      projectRoot: root,
      outputRoot,
      runDirectory,
      definition: parseSimulationDefinition(raw),
      circuitJson: circuitJson(),
      executable: await fakeNgspice(root),
    });
    expect(result.assessment.status.state).toBe("failed");
    expect(result.assessment.diagnostics.map(({ id }) => String(id))).toEqual(["SIM_MODEL_ASSET_INVALID_001"]);
    expect(await Bun.file(join(runDirectory, "simulation")).exists()).toBeFalse();
  });

  test("rejects raw symlinks and recursive extra artifacts before publishing evidence", async () => {
    if (process.platform === "win32") return;
    for (const mode of ["raw-symlink", "extra", "tool-extra"] as const) {
      const root = await mkdtemp(join(tmpdir(), `pcboo-ngspice-${mode}-`)); roots.push(root);
      const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
      await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
      const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
      const result = await runQualifiedNgspice({ projectRoot: root, outputRoot, runDirectory, definition: parseSimulationDefinition(rawDefinition(sha256(model))), circuitJson: circuitJson(), executable: await fakeNgspice(root, operatingPointRaw(), mode) });
      expect(result.assessment.status.state).toBe("failed");
      expect(await Bun.file(join(runDirectory, "simulation/evidence.json")).exists()).toBeFalse();
      if (mode === "tool-extra") {
        expect(await Bun.file(join(runDirectory, "simulation/tool/unexpected")).text()).toBe("keep");
      }
    }
  });

  test("rejects final simulation byte and root replacement without publishing artifact references", async () => {
    for (const attack of ["bytes", "root"] as const) {
      const root = await mkdtemp(join(tmpdir(), `pcboo-ngspice-final-${attack}-`)); roots.push(root);
      const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
      await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
      const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
      const result = await runQualifiedNgspice({
        projectRoot: root,
        outputRoot,
        runDirectory,
        definition: parseSimulationDefinition(rawDefinition(sha256(model))),
        circuitJson: circuitJson(),
        executable: await fakeNgspice(root),
        beforeArtifactPublication: async (directory) => {
          if (attack === "bytes") {
            await Bun.write(join(directory, "input.cir"), "changed\n");
          } else {
            await rename(directory, `${directory}-moved`);
            await mkdir(directory);
          }
        },
      });
      expect(result.assessment.status.state, attack).toBe("failed");
      expect(result.assessment.diagnostics.map(({ id }) => String(id)), attack).toEqual(["SIM_OUTPUT_INVALID_001"]);
      expect(result.artifacts, attack).toEqual([]);
      expect(result.evidence, attack).toBeUndefined();
    }
  });

  test("treats ordinary failure prose containing cancelled as a failed simulation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-cancelled-prose-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
    await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
    const result = await runQualifiedNgspice({
      projectRoot: root,
      outputRoot,
      runDirectory,
      definition: parseSimulationDefinition(rawDefinition(sha256(model))),
      circuitJson: circuitJson(),
      executable: await fakeNgspice(root),
      beforeArtifactPublication: () => {
        throw new Error("validation failed: cancelled flag was false");
      },
    });
    expect(result.assessment.status.state).toBe("failed");
    expect(result.assessment.diagnostics.map(({ id }) => String(id))).toEqual(["SIM_OUTPUT_INVALID_001"]);
    expect(result.assessment.diagnostics[0]?.message).toContain("cancelled flag was false");
    expect(result.artifacts).toEqual([]);
    expect(result.evidence).toBeUndefined();
  });

  test("honors cancellation after solver exit and removes unpublished simulation evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-late-cancel-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
    await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
    const controller = new AbortController();
    await expect(runQualifiedNgspice({
      projectRoot: root,
      outputRoot,
      runDirectory,
      definition: parseSimulationDefinition(rawDefinition(sha256(model))),
      circuitJson: circuitJson(),
      executable: await fakeNgspice(root),
      signal: controller.signal,
      beforeArtifactPublication: () => controller.abort(),
    })).rejects.toThrow("cancelled");
    expect(await Bun.file(join(runDirectory, "simulation/evidence.json")).exists()).toBeFalse();
    expect(await Bun.file(join(runDirectory, "simulation")).exists()).toBeFalse();
  });

  test("binds delayed solver evidence to immutable entry snapshots despite caller mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-snapshot-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
    await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
    const mutableDefinition = rawDefinition(sha256(model));
    const originalDefinition = parseSimulationDefinition(structuredClone(mutableDefinition));
    const mutableCircuit = circuitJson();
    const pending = runQualifiedNgspice({ projectRoot: root, outputRoot, runDirectory, definition: mutableDefinition as any, circuitJson: mutableCircuit, executable: await fakeNgspice(root, operatingPointRaw(), "delayed") });
    ((mutableDefinition.models as any[])[0].bindings[0].parameters as any).resistance = "1k";
    mutableCircuit[0].resistance = 1_000;
    const result = await pending;
    expect(result.assessment.status.state).toBe("incomplete");
    expect(result.evidence?.definitionDigest).toBe(simulationDefinitionDigest(originalDefinition));
    expect(await Bun.file(join(runDirectory, "simulation/input.cir")).text()).toContain("R1 VIN VOUT 10000");
  });

  test("kills solver descendants at the timeout boundary", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-child-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
    await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
    const raw = rawDefinition(sha256(model)); raw.timeoutMs = 100;
    const result = await runQualifiedNgspice({ projectRoot: root, outputRoot, runDirectory, definition: parseSimulationDefinition(raw), circuitJson: circuitJson(), executable: await fakeNgspice(root, operatingPointRaw(), "child") });
    expect(result.assessment.status.state).toBe("failed");
    const identity = await Bun.file(join(root, "child.pid")).text();
    if (identity === "blocked") return;
    const childPid = Number(identity);
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try { process.kill(childPid, 0); await Bun.sleep(20); } catch { alive = false; }
    }
    expect(alive).toBeFalse();
  });

  test("uses captured model bytes when the project model changes during solver execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-model-snapshot-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
    await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture R\n"; const sourceModel = join(root, "models/resistors.model"); await Bun.write(sourceModel, model);
    const pending = runQualifiedNgspice({ projectRoot: root, outputRoot, runDirectory, definition: parseSimulationDefinition(rawDefinition(sha256(model))), circuitJson: circuitJson(), executable: await fakeNgspice(root, operatingPointRaw(), "delayed") });
    const captured = join(runDirectory, "simulation/models/resistors.model");
    for (let attempt = 0; attempt < 100 && !await Bun.file(captured).exists(); attempt += 1) await Bun.sleep(5);
    await Bun.write(sourceModel, ".model changed R\n");
    const result = await pending;
    expect(result.assessment.status.state).toBe("incomplete");
    expect(await Bun.file(captured).text()).toBe(model);
    expect(result.evidence?.modelDigests.resistors).toBe(sha256(model));
  });

  test("keeps issued qualification authority fail-closed under WeakSet prototype poisoning", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-set-poison-")); roots.push(root);
    const outputRoot = join(root, "output"); const runDirectory = join(outputRoot, "run");
    await mkdir(join(root, "models")); await mkdir(runDirectory, { recursive: true });
    const model = ".model fixture R\n"; await Bun.write(join(root, "models/resistors.model"), model);
    const original = WeakSet.prototype.has;
    const result = await runQualifiedNgspice({
      projectRoot: root, outputRoot, runDirectory,
      definition: parseSimulationDefinition(rawDefinition(sha256(model))), circuitJson: circuitJson(),
      executable: await fakeNgspice(root),
      beforeQualificationCheck: () => {
        WeakSet.prototype.has = (() => true) as typeof WeakSet.prototype.has;
        queueMicrotask(() => { WeakSet.prototype.has = original; });
      },
    });
    expect(result.assessment.status.state).toBe("incomplete");
    expect(result.assessment.diagnostics.map(({ id }) => String(id))).toEqual(["SIM_NGSPICE_LIVE_QUALIFICATION_UNAVAILABLE_001"]);
  });
});
