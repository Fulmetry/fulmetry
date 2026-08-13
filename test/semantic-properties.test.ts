// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capacitance,
  current,
  frequency,
  inductance,
  length,
  resistance,
  rotation,
  time,
  voltage,
} from "circuit-json";
import type { AnyCircuitElement } from "tscircuit";
import {
  Board,
  Capacitor,
  Circuit,
  Crystal,
  CurrentSource,
  Hole,
  Inductor,
  Led,
  PinHeader,
  Resistor,
  Trace,
  VoltageSource,
} from "@pcboo/pcboo/authoring";
import { deriveAuthoritativeConnectivity } from "../src/authoritative-connectivity";
import { canonicalCircuitJson } from "../src/circuit-json";
import { assessCircuitElectrical } from "../src/electrical";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import { verifyManufacturingDirectory } from "../src/manufacturing/verify";
import {
  formatQuantity,
  normalizeCircuitQuantityValues,
  parseQuantity,
  quantityValuesEqual,
  supportedQuantityUnits,
  type UnitQuantity,
} from "../src/units";
import { propertySeed, runSeededProperty } from "./support/seeded-property";

type Declaration = "resistor" | "led" | "header";

interface UnitPropertyCase {
  readonly quantity: UnitQuantity;
  readonly unit: string;
  readonly magnitude: number;
  readonly exponent: number;
  readonly negative: boolean;
}

interface ReorderPropertyCase {
  readonly order: readonly Declaration[];
}

const roots: string[] = [];
const BASE_ORDER = Object.freeze(["resistor", "led", "header"] as const);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ORACLE_SCALE_TO_BASE: Readonly<Record<UnitQuantity, Readonly<Record<string, number>>>> =
  Object.freeze({
    length: Object.freeze({ mm: 1, cm: 10, m: 1_000, in: 25.4, mil: 0.0254 }),
    angle: Object.freeze({ deg: 1, rad: 180 / Math.PI }),
    resistance: Object.freeze({ ohm: 1, "Ω": 1, kohm: 1_000, "kΩ": 1_000, Mohm: 1_000_000, "MΩ": 1_000_000 }),
    capacitance: Object.freeze({ pF: 1e-12, nF: 1e-9, uF: 1e-6, "µF": 1e-6, mF: 1e-3, F: 1 }),
    inductance: Object.freeze({ nH: 1e-9, uH: 1e-6, "µH": 1e-6, mH: 1e-3, H: 1 }),
    voltage: Object.freeze({ uV: 1e-6, "µV": 1e-6, mV: 1e-3, V: 1, kV: 1_000 }),
    current: Object.freeze({ uA: 1e-6, "µA": 1e-6, mA: 1e-3, A: 1 }),
    frequency: Object.freeze({ Hz: 1, kHz: 1_000, MHz: 1_000_000, GHz: 1_000_000_000 }),
    time: Object.freeze({ ns: 1e-6, us: 1e-3, ms: 1, s: 1_000 }),
  });

const UPSTREAM_UNIT_PARSERS = Object.freeze({
  length,
  angle: rotation,
  resistance,
  capacitance,
  inductance,
  voltage,
  current,
  frequency,
  time,
});

const UNIT_REPRESENTATIONS = Object.freeze(
  (Object.entries(ORACLE_SCALE_TO_BASE) as Array<
    [UnitQuantity, Readonly<Record<string, number>>]
  >).flatMap(([quantity, scales]) =>
    Object.keys(scales).sort().map((unit) => Object.freeze({ quantity, unit })),
  ),
);

function unitCases(
  random: { integer(minimum: number, maximum: number): number },
  caseIndex: number,
): UnitPropertyCase {
  const representation = UNIT_REPRESENTATIONS[caseIndex % UNIT_REPRESENTATIONS.length]!;
  return Object.freeze({
    ...representation,
    magnitude: random.integer(1, 999_999),
    exponent: random.integer(-6, 6),
    negative: random.integer(0, 1) === 1,
  });
}

function shrinkUnitCase(value: UnitPropertyCase): readonly UnitPropertyCase[] {
  return Object.freeze([
    { ...value, magnitude: 1 },
    { ...value, exponent: 0 },
    { ...value, negative: false },
  ]);
}

function shuffledOrder(
  random: { integer(minimum: number, maximum: number): number },
): readonly Declaration[] {
  const order = [...BASE_ORDER];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = random.integer(0, index);
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  if (order.every((item, index) => item === BASE_ORDER[index])) {
    order.push(order.shift()!);
  }
  return Object.freeze(order);
}

function shrinkReorderCase(value: ReorderPropertyCase): readonly ReorderPropertyCase[] {
  const reversed = Object.freeze([...BASE_ORDER].reverse()) as readonly Declaration[];
  return value.order.join(",") === reversed.join(",")
    ? []
    : [Object.freeze({ order: reversed })];
}

async function authoredFixture(options: {
  readonly order: readonly Declaration[];
  readonly resistorName?: string;
  readonly resistorValue?: string;
  readonly staleResistorSelector?: boolean;
  readonly changedEndpoint?: boolean;
}): Promise<AnyCircuitElement[]> {
  const resistorName = options.resistorName ?? "R1";
  const circuit = new Circuit();
  const board = new Board({ width: "20mm", height: "15mm", layers: 2 });
  circuit.add(board);
  const components = {
    resistor: new Resistor({
      name: resistorName,
      resistance: options.resistorValue ?? "10kohm",
      footprint: "0603",
      supplierPartNumbers: { jlcpcb: ["C25804"] },
      pcbX: -3,
      pcbY: 2,
    }),
    led: new Led({
      name: "D1",
      footprint: "0603",
      supplierPartNumbers: { jlcpcb: ["C2286"] },
      layer: "bottom",
      pcbX: 3,
      pcbY: 2,
      pcbRotation: 90,
    }),
    header: new PinHeader({
      name: "J1",
      pinCount: 2,
      footprint: "pinrow2_nosquareplating",
      supplierPartNumbers: { jlcpcb: ["C124375"] },
      pcbX: 0,
      pcbY: -2,
    }),
  };
  for (const declaration of options.order) board.add(components[declaration]);
  board.add(new Hole({ name: "H1", shape: "circle", diameter: "2mm", pcbX: 6, pcbY: -4 }));
  board.add(new Trace({ name: "GND1", from: ".J1 > .pin1", to: "net.GND", width: "0.2mm" }));
  board.add(new Trace({ name: "GND2", from: ".J1 > .pin2", to: "net.GND", width: "0.2mm" }));
  const resistorSelector = options.staleResistorSelector ? "R1" : resistorName;
  board.add(new Trace({
    name: "N1",
    from: `.${resistorSelector} > .pin2`,
    to: options.changedEndpoint ? ".D1 > .pin1" : ".D1 > .pin2",
    width: "0.2mm",
    pcbPath: [
      { x: 3, y: -2 },
      { x: 3, y: -2, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: 3, y: -2 },
      { x: 3, y: -0.825 },
    ],
  }));
  board.add(new Trace({
    name: "N2",
    from: `.${resistorSelector} > .pin1`,
    to: ".D1 > .pin1",
    width: "0.2mm",
    pcbPath: [
      { x: -3, y: 3 },
      { x: -3, y: 3, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: -3, y: 3 },
      { x: -3, y: 4 },
      { x: 9, y: 4 },
      { x: 9, y: 0.825 },
    ],
  }));
  await circuit.renderUntilSettled();
  return normalizeCircuitQuantityValues(circuit.getCircuitJson());
}

function emittedDiagnostics(circuitJson: readonly AnyCircuitElement[]): readonly AnyCircuitElement[] {
  return circuitJson.filter((element) =>
    element.type.endsWith("_error") || element.type.endsWith("_warning")
  );
}

function renamed(name: string, alphaMap: Readonly<Record<string, string>>): string {
  return alphaMap[name] ?? name;
}

function componentSignature(
  circuitJson: readonly AnyCircuitElement[],
  alphaMap: Readonly<Record<string, string>> = {},
): string {
  const pcbBySource = new Map(circuitJson.flatMap((element) =>
    element.type === "pcb_component"
      ? [[element.source_component_id, element] as const]
      : []
  ));
  const cadBySource = new Map(circuitJson.flatMap((element) =>
    element.type === "cad_component"
      ? [[element.source_component_id, element] as const]
      : []
  ));
  const fields = [
    "resistance", "capacitance", "inductance", "voltage", "current", "frequency",
  ] as const;
  return JSON.stringify(circuitJson.flatMap((element) => {
    if (element.type !== "source_component") return [];
    const pcb = pcbBySource.get(element.source_component_id);
    const cad = cadBySource.get(element.source_component_id);
    const values = Object.fromEntries(fields.flatMap((field) =>
      field in element ? [[field, (element as unknown as Record<string, unknown>)[field]]] : []
    ));
    return [{
      name: renamed(element.name, alphaMap),
      ftype: element.ftype,
      values,
      footprint: cad?.footprinter_string ?? null,
      placement: pcb === undefined ? null : {
        center: pcb.center,
        layer: pcb.layer,
        rotation: pcb.rotation,
      },
    }];
  }).sort((left, right) => left.name.localeCompare(right.name)));
}

function connectivityPartition(
  circuitJson: readonly AnyCircuitElement[],
  alphaMap: Readonly<Record<string, string>> = {},
  requireValid = true,
): string {
  const authority = deriveAuthoritativeConnectivity(circuitJson);
  if (requireValid) {
    expect(authority.connectivityFailures).toEqual([]);
    expect(authority.pinAuthorityFailures).toEqual([]);
    expect(authority.netIdentityFailures).toEqual([]);
    expect(authority.unsupported).toEqual([]);
  }
  const componentNames = new Map(circuitJson.flatMap((element) =>
    element.type === "source_component"
      ? [[element.source_component_id, renamed(element.name, alphaMap)] as const]
      : []
  ));
  const groups = new Map<string, string[]>();
  for (const port of circuitJson) {
    if (port.type !== "source_port") continue;
    const net = authority.netForSourcePortId(port.source_port_id) ?? `unconnected:${port.source_port_id}`;
    const componentName = port.source_component_id === undefined
      ? "?"
      : componentNames.get(port.source_component_id) ?? "?";
    const label = `${componentName}.${String(port.pin_number ?? port.name)}`;
    const members = groups.get(net) ?? [];
    members.push(label);
    groups.set(net, members);
  }
  const namesByNet = new Map<string, Array<Readonly<{
    name: string;
    isGround: boolean;
    isPower: boolean;
    isPositiveVoltageSource: boolean;
  }>>>();
  for (const net of circuitJson) {
    if (net.type !== "source_net") continue;
    const identity = authority.netForSourceNetId(net.source_net_id);
    if (identity === undefined) continue;
    const names = namesByNet.get(identity) ?? [];
    names.push(Object.freeze({
      name: `net.${net.name}`,
      isGround: net.is_ground ?? false,
      isPower: net.is_power ?? false,
      isPositiveVoltageSource: net.is_positive_voltage_source ?? false,
    }));
    namesByNet.set(identity, names);
  }
  return JSON.stringify([...groups]
    .map(([identity, members]) => ({
      names: [...(namesByNet.get(identity) ?? [])].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
      members: members.sort(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function stableBehavior(value: unknown, alphaMap: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableBehavior(item, alphaMap));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "source")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => {
      if ((key === "designator" || key === "Designator") && typeof item === "string") {
        return [key, renamed(item, alphaMap)];
      }
      return [key, stableBehavior(item, alphaMap)];
    }));
}

function sortedBehaviorCollection(
  values: readonly unknown[],
  alphaMap: Readonly<Record<string, string>>,
): readonly unknown[] {
  return values.map((item) => stableBehavior(item, alphaMap)).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function sortedBehaviorLayers(
  layers: Readonly<Record<string, readonly unknown[]>>,
  alphaMap: Readonly<Record<string, string>>,
): Readonly<Record<string, readonly unknown[]>> {
  return Object.fromEntries(Object.entries(layers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([layer, values]) => [layer, sortedBehaviorCollection(values, alphaMap)]));
}

function assemblyBehavior(
  expectation: ReturnType<typeof deriveManufacturingExpectation>,
  alphaMap: Readonly<Record<string, string>>,
): readonly unknown[] {
  const padFeatures = (source: string): readonly unknown[] => sortedBehaviorCollection([
    ...Object.entries(expectation.flashes).flatMap(([layer, flashes]) =>
      flashes
        .filter((flash) => flash.source === source)
        .map((flash) => ({ kind: "flash", layer, feature: flash }))
    ),
    ...expectation.platedDrills
      .filter((drill) => drill.source === source)
      .map((drill) => ({ kind: "plated-drill", feature: drill })),
  ], alphaMap);

  return expectation.assemblyAuthority
    .map(({
      sourceComponentId: _sourceComponentId,
      pcbComponentId: _pcbComponentId,
      designator,
      padSources,
      ...requirements
    }) => ({
      ...requirements,
      designator: renamed(designator, alphaMap),
      pads: padSources
        .map((source) => padFeatures(source))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function manufacturingBehavior(
  expectation: ReturnType<typeof deriveManufacturingExpectation>,
  alphaMap: Readonly<Record<string, string>> = {},
  options: Readonly<{
    includeSilkscreen?: boolean;
    omitSilkscreenSources?: ReadonlySet<string>;
  }> = {},
): string {
  const silkscreen = Object.fromEntries(Object.entries(expectation.silkscreenSegments)
    .map(([layer, segments]) => [
      layer,
      segments.filter(({ source }) => !options.omitSilkscreenSources?.has(source)),
    ]));
  return JSON.stringify({
    layerCount: expectation.layerCount,
    board: stableBehavior(expectation.board, alphaMap),
    flashes: sortedBehaviorLayers(expectation.flashes, alphaMap),
    copperSegments: sortedBehaviorLayers(expectation.copperSegments, alphaMap),
    ...(options.includeSilkscreen || options.omitSilkscreenSources !== undefined
      ? { silkscreenSegments: sortedBehaviorLayers(silkscreen, alphaMap) }
      : {}),
    platedThroughSources: stableBehavior(expectation.platedThroughSources, alphaMap),
    platedDrills: sortedBehaviorCollection(expectation.platedDrills, alphaMap),
    nonPlatedDrills: sortedBehaviorCollection(expectation.nonPlatedDrills, alphaMap),
    assemblyAuthority: assemblyBehavior(expectation, alphaMap),
    bomRows: sortedBehaviorCollection(expectation.bomRows, alphaMap),
    placements: sortedBehaviorCollection(expectation.placements, alphaMap),
    unsupported: [...expectation.unsupported].sort(),
  });
}

function referenceSilkscreenSources(
  circuitJson: readonly AnyCircuitElement[],
  componentName: string,
): ReadonlySet<string> {
  const sourceComponentIds = new Set(circuitJson.flatMap((element) =>
    element.type === "source_component" && element.name === componentName
      ? [element.source_component_id]
      : []
  ));
  const pcbComponentIds = new Set(circuitJson.flatMap((element) =>
    element.type === "pcb_component" && sourceComponentIds.has(element.source_component_id)
      ? [element.pcb_component_id]
      : []
  ));
  return new Set(circuitJson.flatMap((element) =>
    element.type === "pcb_silkscreen_text" &&
      pcbComponentIds.has(element.pcb_component_id) && element.text === componentName
      ? [element.pcb_silkscreen_text_id]
      : []
  ));
}

async function exportAndVerify(circuitJson: AnyCircuitElement[], label: string) {
  const parent = await mkdtemp(join(tmpdir(), `pcboo-semantic-${label}-`));
  roots.push(parent);
  try {
    const root = join(parent, "manufacturing");
    const expectation = deriveManufacturingExpectation({ boardName: "semantic", circuitJson });
    expect(expectation.unsupported).toEqual([]);
    const files = await exportManufacturingFiles({ boardName: "semantic", circuitJson });
    await emitDraftManufacturingDirectory({ targetDirectory: root, files });
    const result = await verifyManufacturingDirectory({ root, expectation, circuitJson });
    expect(result.passed).toBeTrue();
    expect(result.findings).toEqual([]);
    return {
      expectation,
      paths: files.map(({ path, kind }) => ({ path, kind })),
    };
  } finally {
    await rm(parent, { recursive: true, force: true });
    const index = roots.indexOf(parent);
    if (index >= 0) roots.splice(index, 1);
  }
}

function expectElectricalPass(circuitJson: readonly AnyCircuitElement[]): void {
  const electrical = assessCircuitElectrical(circuitJson);
  expect(electrical.status.state).toBe("passed");
  expect(electrical.diagnostics).toEqual([]);
}

describe("seeded unit and source-semantic properties", () => {
  test("round-trips every supported representation against independent factors and upstream schemas", async () => {
    for (const [quantity, scales] of Object.entries(ORACLE_SCALE_TO_BASE) as Array<
      [UnitQuantity, Readonly<Record<string, number>>]
    >) {
      expect(supportedQuantityUnits(quantity).join("\0"))
        .toBe(Object.keys(scales).sort().join("\0"));
    }
    const seed = propertySeed(process.env.PCBOO_PROPERTY_SEED, 0x554e_4954);
    await runSeededProperty({
      name: "unit-representation-round-trip",
      seed,
      replayFile: "test/semantic-properties.test.ts",
      cases: UNIT_REPRESENTATIONS.length,
      generate: unitCases,
      shrink: shrinkUnitCase,
      check: (propertyCase) => {
        const represented = propertyCase.magnitude * 10 ** propertyCase.exponent *
          (propertyCase.negative ? -1 : 1);
        const expectedBase = represented *
          ORACLE_SCALE_TO_BASE[propertyCase.quantity][propertyCase.unit]!;
        const formatted = formatQuantity(
          propertyCase.quantity,
          expectedBase,
          propertyCase.unit as never,
        );
        const parsed = parseQuantity(propertyCase.quantity, formatted);
        const upstream = Number(UPSTREAM_UNIT_PARSERS[propertyCase.quantity].parse(formatted));
        expect(quantityValuesEqual(parsed, expectedBase)).toBeTrue();
        expect(quantityValuesEqual(upstream, expectedBase)).toBeTrue();
        const canonical = formatQuantity(
          propertyCase.quantity,
          parsed,
          ({ length: "mm", angle: "deg", resistance: "ohm", capacitance: "F",
            inductance: "H", voltage: "V", current: "A", frequency: "Hz", time: "ms" }
          )[propertyCase.quantity] as never,
        );
        expect(quantityValuesEqual(parseQuantity(propertyCase.quantity, canonical), expectedBase))
          .toBeTrue();
      },
    });
    expect(parseQuantity("length", "1in")).toBe(25.4);
    expect(parseQuantity("length", "100mil")).toBe(2.54);
    expect(parseQuantity("time", "1s")).toBe(1_000);
    expect(parseQuantity("angle", `${Math.PI}rad`)).toBeCloseTo(180, 12);
    expect(() => parseQuantity("length", "1mm trailing")).toThrow();
    expect(() => parseQuantity("voltage", "NaNV")).toThrow();
    expect(() => formatQuantity("current", Number.POSITIVE_INFINITY, "A")).toThrow();
  });

  test("normalizes every authoring unit class into numeric Circuit JSON", async () => {
    const circuit = new Circuit();
    const board = new Board({ width: "1in", height: "1000mil", layers: 2 });
    circuit.add(board);
    board.add(new Resistor({ name: "RUNIT", resistance: "2kohm" }));
    board.add(new Capacitor({ name: "CUNIT", capacitance: "3nF" }));
    board.add(new Inductor({ name: "LUNIT", inductance: "4mH" }));
    board.add(new VoltageSource({
      name: "VUNIT", voltage: "5mV", frequency: "6kHz", phase: "1rad", pulseDelay: "7us",
    }));
    board.add(new CurrentSource({ name: "IUNIT", current: "8mA" }));
    board.add(new Crystal({ name: "YUNIT", frequency: "9MHz", loadCapacitance: "10pF" }));
    await circuit.renderUntilSettled();
    const raw = circuit.getCircuitJson();
    expect(raw.find((element) =>
      element.type === "source_component" && element.name === "LUNIT"
    )).toMatchObject({ inductance: "4mH" });
    const normalized = normalizeCircuitQuantityValues(raw);
    const source = (name: string) => normalized.find((element) =>
      element.type === "source_component" && element.name === name
    ) as Record<string, unknown> | undefined;
    expect(normalized.find((element) => element.type === "pcb_board")).toMatchObject({
      width: 25.4,
      height: 25.4,
    });
    expect(source("RUNIT")).toMatchObject({ resistance: 2_000 });
    expect(source("CUNIT")).toMatchObject({ capacitance: 3e-9 });
    expect(source("LUNIT")).toMatchObject({ inductance: 0.004 });
    expect(source("VUNIT")).toMatchObject({
      voltage: 0.005,
      frequency: 6_000,
      phase: 180 / Math.PI,
      pulse_delay: 0.007,
    });
    expect(source("IUNIT")).toMatchObject({ current: 0.008 });
    expect(source("YUNIT")).toMatchObject({ frequency: 9_000_000, load_capacitance: 1e-11 });
  });

  test("generated declaration permutations preserve named behavior and verified manufacturing", async () => {
    const baselineCircuit = await authoredFixture({ order: BASE_ORDER });
    expect(emittedDiagnostics(baselineCircuit)).toEqual([]);
    expectElectricalPass(baselineCircuit);
    const baselineComponents = componentSignature(baselineCircuit);
    const baselineConnectivity = connectivityPartition(baselineCircuit);
    const baselineManufacturing = await exportAndVerify(baselineCircuit, "reorder-baseline");
    const baselineBehavior = manufacturingBehavior(
      baselineManufacturing.expectation,
      {},
      { includeSilkscreen: true },
    );

    const seed = propertySeed(process.env.PCBOO_PROPERTY_SEED, 0x4f52_4445);
    await runSeededProperty({
      name: "unordered-declaration-invariance",
      seed,
      replayFile: "test/semantic-properties.test.ts",
      cases: 4,
      generate: (random) => Object.freeze({ order: shuffledOrder(random) }),
      shrink: shrinkReorderCase,
      check: async (propertyCase, caseIndex) => {
        const reordered = await authoredFixture({ order: propertyCase.order });
        expect(emittedDiagnostics(reordered)).toEqual([]);
        expectElectricalPass(reordered);
        expect(componentSignature(reordered)).toBe(baselineComponents);
        expect(connectivityPartition(reordered)).toBe(baselineConnectivity);
        const manufacturing = await exportAndVerify(reordered, `reorder-${caseIndex}`);
        expect(manufacturingBehavior(
          manufacturing.expectation,
          {},
          { includeSilkscreen: true },
        )).toBe(baselineBehavior);
        expect(manufacturing.paths).toEqual(baselineManufacturing.paths);
      },
    });
  }, 60_000);

  test("connectivity comparison detects a same-shape endpoint mutation", async () => {
    const baseline = await authoredFixture({ order: BASE_ORDER });
    const changed = await authoredFixture({ order: BASE_ORDER, changedEndpoint: true });
    expect(componentSignature(changed)).toBe(componentSignature(baseline));
    const changedAuthority = deriveAuthoritativeConnectivity(changed);
    expect(changedAuthority.connectivityFailures).toContain(
      "source_port_3:manufactured-port-has-no-logical-group",
    );
    expect(connectivityPartition(changed, {}, false)).not.toBe(connectivityPartition(baseline));
    expect(assessCircuitElectrical(changed).status.state).not.toBe("passed");

    const renamedNet = structuredClone(baseline);
    const ground = renamedNet.find((element) =>
      element.type === "source_net" && element.name === "GND"
    );
    if (ground?.type !== "source_net") throw new Error("GND negative-control fixture missing");
    ground.name = "VCC";
    expect(componentSignature(renamedNet)).toBe(componentSignature(baseline));
    expect(connectivityPartition(renamedNet)).not.toBe(connectivityPartition(baseline));

    const changedFlags = structuredClone(baseline);
    const changedGround = changedFlags.find((element) =>
      element.type === "source_net" && element.name === "GND"
    );
    if (changedGround?.type !== "source_net") throw new Error("GND flag fixture missing");
    changedGround.is_ground = false;
    changedGround.is_power = true;
    expect(componentSignature(changedFlags)).toBe(componentSignature(baseline));
    expect(connectivityPartition(changedFlags)).not.toBe(connectivityPartition(baseline));
  });

  test("manufacturing comparison preserves ordered pad dimensions and reorder silkscreen", async () => {
    const circuitJson = await authoredFixture({ order: BASE_ORDER });
    const expectation = deriveManufacturingExpectation({ boardName: "semantic", circuitJson });
    const baseline = manufacturingBehavior(expectation, {}, { includeSilkscreen: true });

    const dimensionMutation = structuredClone(expectation) as unknown as {
      flashes: Record<string, Array<{ dimensions: number[] }>>;
    };
    const rectangular = Object.values(dimensionMutation.flashes).flat().find(
      ({ dimensions }) => dimensions.length === 2 && dimensions[0] !== dimensions[1],
    );
    if (rectangular === undefined) throw new Error("Rectangular flash negative-control fixture missing");
    rectangular.dimensions = [rectangular.dimensions[1]!, rectangular.dimensions[0]!];
    expect(manufacturingBehavior(
      dimensionMutation as unknown as ReturnType<typeof deriveManufacturingExpectation>,
      {},
      { includeSilkscreen: true },
    )).not.toBe(baseline);

    const silkscreenMutation = structuredClone(expectation) as unknown as {
      silkscreenSegments: Record<string, Array<{ startX: number }>>;
    };
    const segment = Object.values(silkscreenMutation.silkscreenSegments).flat()[0];
    if (segment === undefined) throw new Error("Silkscreen negative-control fixture missing");
    segment.startX += 0.1;
    expect(manufacturingBehavior(
      silkscreenMutation as unknown as ReturnType<typeof deriveManufacturingExpectation>,
      {},
      { includeSilkscreen: true },
    )).not.toBe(baseline);

    const ownershipMutation = structuredClone(expectation) as unknown as {
      assemblyAuthority: Array<{ padSources: string[] }>;
    };
    const owners = ownershipMutation.assemblyAuthority.filter(({ padSources }) =>
      padSources.length > 0
    );
    if (owners.length < 2) throw new Error("Assembly ownership negative-control fixture missing");
    const firstPad = owners[0]!.padSources[0]!;
    owners[0]!.padSources[0] = owners[1]!.padSources[0]!;
    owners[1]!.padSources[0] = firstPad;
    expect(manufacturingBehavior(
      ownershipMutation as unknown as ReturnType<typeof deriveManufacturingExpectation>,
      {},
      { includeSilkscreen: true },
    )).not.toBe(baseline);
  });

  test("consistent alpha-renaming changes identifiers but preserves electrical and manufacturing behavior", async () => {
    const baseline = await authoredFixture({ order: BASE_ORDER });
    const renamedCircuit = await authoredFixture({ order: BASE_ORDER, resistorName: "R7" });
    expect(emittedDiagnostics(renamedCircuit)).toEqual([]);
    expectElectricalPass(baseline);
    expectElectricalPass(renamedCircuit);
    expect(canonicalCircuitJson(renamedCircuit)).not.toBe(canonicalCircuitJson(baseline));
    expect(baseline.filter((element) =>
      element.type === "source_component" && element.name === "R1"
    )).toHaveLength(1);
    expect(renamedCircuit.filter((element) =>
      element.type === "source_component" && element.name === "R7"
    )).toHaveLength(1);
    const inverse = { R7: "R1" } as const;
    expect(componentSignature(renamedCircuit, inverse)).toBe(componentSignature(baseline));
    expect(connectivityPartition(renamedCircuit, inverse)).toBe(connectivityPartition(baseline));
    const [baselineManufacturing, renamedManufacturing] = await Promise.all([
      exportAndVerify(baseline, "rename-baseline"),
      exportAndVerify(renamedCircuit, "rename-r7"),
    ]);
    const baselineReferenceSources = referenceSilkscreenSources(baseline, "R1");
    const renamedReferenceSources = referenceSilkscreenSources(renamedCircuit, "R7");
    expect([...baselineReferenceSources]).toHaveLength(1);
    expect([...renamedReferenceSources]).toHaveLength(1);
    expect(manufacturingBehavior(renamedManufacturing.expectation, inverse, {
      omitSilkscreenSources: renamedReferenceSources,
    })).toBe(
      manufacturingBehavior(baselineManufacturing.expectation, {}, {
        omitSilkscreenSources: baselineReferenceSources,
      }),
    );
    expect(renamedManufacturing.expectation.bomRows.some(({ columns }) =>
      columns.Designator === "R7"
    )).toBeTrue();
    expect(renamedManufacturing.expectation.placements.some(({ designator }) =>
      designator === "R7"
    )).toBeTrue();

    const unrelatedSilkscreenMutation = structuredClone(renamedManufacturing.expectation) as unknown as {
      silkscreenSegments: Record<string, Array<{ source: string; startX: number }>>;
    };
    const unaffectedSegment = Object.values(unrelatedSilkscreenMutation.silkscreenSegments)
      .flat()
      .find(({ source }) => !renamedReferenceSources.has(source));
    if (unaffectedSegment === undefined) throw new Error("Unaffected silkscreen fixture missing");
    unaffectedSegment.startX += 0.1;
    expect(manufacturingBehavior(
      unrelatedSilkscreenMutation as unknown as ReturnType<typeof deriveManufacturingExpectation>,
      inverse,
      { omitSilkscreenSources: renamedReferenceSources },
    )).not.toBe(manufacturingBehavior(
      baselineManufacturing.expectation,
      {},
      { omitSilkscreenSources: baselineReferenceSources },
    ));

    const changedValue = await authoredFixture({
      order: BASE_ORDER,
      resistorName: "R7",
      resistorValue: "11kohm",
    });
    expect(componentSignature(changedValue, inverse)).not.toBe(componentSignature(baseline));

    const staleSelector = await authoredFixture({
      order: BASE_ORDER,
      resistorName: "R7",
      staleResistorSelector: true,
    });
    expect(emittedDiagnostics(staleSelector).length).toBeGreaterThan(0);
    expect(assessCircuitElectrical(staleSelector).status.state).not.toBe("passed");
  }, 60_000);
});
