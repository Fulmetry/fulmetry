import { describe, expect, test } from "bun:test";
import {
  Board,
  Circuit,
  Resistor,
  Trace,
  type AnyCircuitElement,
} from "pcboo/authoring";
import { DIAGNOSTIC_REFERENCE_LIMIT } from "../src/diagnostics";
import { assessCircuitElectrical } from "../src/electrical";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";
import { manufacturingFixture } from "./fixtures/manufacturing";

function cloneCircuitJson(elements: readonly AnyCircuitElement[]): AnyCircuitElement[] {
  return structuredClone(elements) as AnyCircuitElement[];
}

function connectivityCodes(elements: readonly AnyCircuitElement[]): readonly string[] {
  return assessCircuitElectrical(elements).diagnostics.map(({ id }) => id);
}

async function sourceNetFixture(): Promise<AnyCircuitElement[]> {
  const circuit = new Circuit();
  const board = new Board({ width: "20mm", height: "15mm" });
  circuit.add(board);
  board.add(new Resistor({ name: "R1", resistance: "1k", footprint: "0603", pcbX: -3, pcbY: 0 }));
  board.add(new Resistor({ name: "R2", resistance: "2k", footprint: "0603", pcbX: 3, pcbY: 0 }));
  for (const [name, from, to] of [
    ["T1", ".R1 > .pin1", "net.VCC"],
    ["T2", ".R2 > .pin1", "net.VCC"],
    ["T3", ".R1 > .pin2", "net.GND"],
    ["T4", ".R2 > .pin2", "net.GND"],
  ] as const) board.add(new Trace({ name, from, to }));
  await circuit.renderUntilSettled();
  return circuit.getCircuitJson();
}

describe("electrical evidence assessment", () => {
  test("uses an emitted error record's primary identity rather than a foreign reference", () => {
    const assessment = assessCircuitElectrical([{
      type: "pcb_trace_error",
      source_trace_id: "source_trace_foreign",
      pcb_trace_error_id: "pcb_trace_error_primary",
      message: "fixture error",
    } as unknown as AnyCircuitElement]);
    expect(assessment.diagnostics[0]?.objects).toEqual(["pcb_trace_error_primary"]);
  });

  test("passes the canonical electrically connected fixture", async () => {
    const assessment = assessCircuitElectrical(await manufacturingFixture(4));
    expect(assessment.status.state).toBe("passed");
    expect(assessment.diagnostics).toEqual([]);
  });

  test("rejects conflicting schema-level drivers on one authoritative logical net", async () => {
    const pushPullConflict = cloneCircuitJson(await manufacturingFixture(2));
    const pushPullPorts = pushPullConflict.filter(
      (element) => element.type === "source_port" &&
        ["source_port_0", "source_port_2"].includes(element.source_port_id),
    );
    expect(pushPullPorts).toHaveLength(2);
    for (const [index, port] of pushPullPorts.entries()) {
      if (port.type !== "source_port") throw new Error("Fixture source port missing");
      port.provides_power = true;
      port.is_using_push_pull = true;
      port.provides_voltage = index === 0 ? 3.3 : 5;
    }
    const activeAssessment = assessCircuitElectrical(pushPullConflict);
    expect(activeAssessment.status.state).toBe("failed");
    expect(activeAssessment.diagnostics.find(
      ({ id }) => id === "ELECTRICAL_DRIVER_CONFLICT_001",
    )?.objects).toEqual(expect.arrayContaining([
      expect.stringContaining("push-pull:source_port_0,source_port_2"),
      expect.stringContaining("provided-voltage:source_port_0=3.3V,source_port_2=5V"),
    ]));

    const stringVoltageConflict = cloneCircuitJson(await manufacturingFixture(2));
    const stringPorts = stringVoltageConflict.filter(
      (element) => element.type === "source_port" &&
        ["source_port_0", "source_port_2"].includes(element.source_port_id),
    );
    for (const [index, port] of stringPorts.entries()) {
      if (port.type !== "source_port") throw new Error("Fixture source port missing");
      port.provides_power = true;
      port.provides_voltage = index === 0 ? "3.3V" : "5V";
    }
    expect(connectivityCodes(stringVoltageConflict)).toContain("ELECTRICAL_DRIVER_CONFLICT_001");

    const voltageOnlyConflict = cloneCircuitJson(await manufacturingFixture(2));
    const voltageOnlyPorts = voltageOnlyConflict.filter(
      (element) => element.type === "source_port" &&
        ["source_port_0", "source_port_2"].includes(element.source_port_id),
    );
    for (const [index, port] of voltageOnlyPorts.entries()) {
      if (port.type !== "source_port") throw new Error("Fixture source port missing");
      port.provides_voltage = index === 0 ? "3.3V" : "5V";
    }
    expect(connectivityCodes(voltageOnlyConflict)).toContain("ELECTRICAL_DRIVER_CONFLICT_001");

    const equivalentVoltageControl = cloneCircuitJson(await manufacturingFixture(2));
    const equivalentPorts = equivalentVoltageControl.filter(
      (element) => element.type === "source_port" &&
        ["source_port_0", "source_port_2"].includes(element.source_port_id),
    );
    for (const [index, port] of equivalentPorts.entries()) {
      if (port.type !== "source_port") throw new Error("Fixture source port missing");
      port.provides_power = true;
      port.provides_voltage = index === 0 ? "3.3V" : "3300mV";
    }
    expect(connectivityCodes(equivalentVoltageControl)).not
      .toContain("ELECTRICAL_DRIVER_CONFLICT_001");

    const zeroVoltGroundControl = cloneCircuitJson(await manufacturingFixture(2));
    const zeroVoltPort = zeroVoltGroundControl.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    const groundReferencePort = zeroVoltGroundControl.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (zeroVoltPort?.type !== "source_port" || groundReferencePort?.type !== "source_port") {
      throw new Error("Fixture source ports missing");
    }
    zeroVoltPort.provides_voltage = "0V";
    groundReferencePort.provides_ground = true;
    expect(connectivityCodes(zeroVoltGroundControl)).not
      .toContain("ELECTRICAL_DRIVER_CONFLICT_001");

    const unknownVoltage = cloneCircuitJson(await manufacturingFixture(2));
    const unknownPort = unknownVoltage.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    if (unknownPort?.type !== "source_port") throw new Error("Fixture source port missing");
    unknownPort.provides_power = true;
    unknownPort.provides_voltage = "3V3";
    const unknownAssessment = assessCircuitElectrical(unknownVoltage);
    expect(unknownAssessment.status.state).toBe("incomplete");
    expect(connectivityCodes(unknownVoltage)).toContain(
      "ELECTRICAL_DRIVER_METADATA_UNSUPPORTED_001",
    );

    const mixedDriverConflict = cloneCircuitJson(await manufacturingFixture(2));
    const pushPullPort = mixedDriverConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    const openDrainPort = mixedDriverConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (pushPullPort?.type !== "source_port" || openDrainPort?.type !== "source_port") {
      throw new Error("Fixture source ports missing");
    }
    pushPullPort.is_using_push_pull = true;
    openDrainPort.is_using_open_drain = true;
    expect(assessCircuitElectrical(mixedDriverConflict).diagnostics.find(
      ({ id }) => id === "ELECTRICAL_DRIVER_CONFLICT_001",
    )?.objects).toContainEqual(expect.stringContaining("mixed-push-pull-open-drain"));

    const powerGroundConflict = cloneCircuitJson(await manufacturingFixture(2));
    const powerPort = powerGroundConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    const groundPort = powerGroundConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (powerPort?.type !== "source_port" || groundPort?.type !== "source_port") {
      throw new Error("Fixture source ports missing");
    }
    powerPort.provides_power = true;
    powerPort.provides_voltage = "5V";
    groundPort.provides_ground = true;
    expect(assessCircuitElectrical(powerGroundConflict).diagnostics.find(
      ({ id }) => id === "ELECTRICAL_DRIVER_CONFLICT_001",
    )?.objects).toContainEqual(expect.stringContaining("power-ground"));

    const activeFixedConflict = cloneCircuitJson(await manufacturingFixture(2));
    const activePort = activeFixedConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    const fixedPort = activeFixedConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (activePort?.type !== "source_port" || fixedPort?.type !== "source_port") {
      throw new Error("Fixture source ports missing");
    }
    activePort.is_using_push_pull = true;
    fixedPort.provides_power = true;
    fixedPort.provides_voltage = "5V";
    expect(assessCircuitElectrical(activeFixedConflict).diagnostics.find(
      ({ id }) => id === "ELECTRICAL_DRIVER_CONFLICT_001",
    )?.objects).toContainEqual(expect.stringContaining("push-pull-fixed-provider"));

    const openDrainFixedConflict = cloneCircuitJson(await manufacturingFixture(2));
    const openDrainOutput = openDrainFixedConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    const fixedHigh = openDrainFixedConflict.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (openDrainOutput?.type !== "source_port" || fixedHigh?.type !== "source_port") {
      throw new Error("Fixture source ports missing");
    }
    openDrainOutput.is_using_open_drain = true;
    fixedHigh.provides_power = true;
    fixedHigh.provides_voltage = "5V";
    expect(assessCircuitElectrical(openDrainFixedConflict).diagnostics.find(
      ({ id }) => id === "ELECTRICAL_DRIVER_CONFLICT_001",
    )?.objects).toContainEqual(expect.stringContaining("open-drain-power-provider"));

    const openDrainControl = cloneCircuitJson(await manufacturingFixture(2));
    for (const port of openDrainControl) {
      if (
        port.type === "source_port" &&
        ["source_port_0", "source_port_2"].includes(port.source_port_id)
      ) port.is_using_open_drain = true;
    }
    expect(assessCircuitElectrical(openDrainControl).status.state).toBe("passed");
  });

  test("marks distinct unknown-voltage power providers incomplete", async () => {
    const unknownProviders = cloneCircuitJson(await manufacturingFixture(2));
    const providerPorts = unknownProviders.filter(
      (element): element is Extract<AnyCircuitElement, { type: "source_port" }> => element.type === "source_port" &&
        ["source_port_0", "source_port_2"].includes(element.source_port_id),
    );
    expect(providerPorts).toHaveLength(2);
    expect(new Set(providerPorts.map(({ source_component_id }) => source_component_id)).size)
      .toBe(2);
    for (const port of providerPorts) {
      if (port.type !== "source_port") throw new Error("Fixture source port missing");
      port.provides_power = true;
      delete port.provides_voltage;
    }

    const unknownAssessment = assessCircuitElectrical(unknownProviders);
    expect(unknownAssessment.status.state).toBe("incomplete");
    expect(unknownAssessment.diagnostics.find(
      ({ id }) => id === "ELECTRICAL_DRIVER_METADATA_UNSUPPORTED_001",
    )?.objects).toContainEqual(
      expect.stringContaining("multiple-power-providers-without-comparable-voltage"),
    );

    const qualifiedEqualProviders = cloneCircuitJson(unknownProviders);
    for (const [index, port] of qualifiedEqualProviders.filter(
      (element) => element.type === "source_port" &&
        ["source_port_0", "source_port_2"].includes(element.source_port_id),
    ).entries()) {
      if (port.type !== "source_port") throw new Error("Fixture source port missing");
      port.provides_voltage = index === 0 ? "3.3V" : "3300mV";
    }
    expect(assessCircuitElectrical(qualifiedEqualProviders).status.state).toBe("passed");
  });

  test("enforces schema-level pin connection and supply obligations", async () => {
    const wrongGround = cloneCircuitJson(await manufacturingFixture(2));
    const fiveVolt = wrongGround.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    const requiresGround = wrongGround.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (fiveVolt?.type !== "source_port" || requiresGround?.type !== "source_port") {
      throw new Error("Fixture source ports missing");
    }
    fiveVolt.provides_voltage = "5V";
    requiresGround.requires_ground = true;
    expect(assessCircuitElectrical(wrongGround).diagnostics.find(
      ({ id }) => id === "ELECTRICAL_PIN_OBLIGATION_001",
    )?.objects).toContainEqual(expect.stringContaining("source_port_2:requires-ground"));

    const suppliedVoltage = cloneCircuitJson(await manufacturingFixture(2));
    const provider = suppliedVoltage.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_0",
    );
    const consumer = suppliedVoltage.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (provider?.type !== "source_port" || consumer?.type !== "source_port") {
      throw new Error("Fixture source ports missing");
    }
    provider.provides_voltage = "3.3V";
    consumer.requires_power = true;
    consumer.requires_voltage = "3300mV";
    expect(assessCircuitElectrical(suppliedVoltage).status.state).toBe("passed");

    consumer.requires_voltage = "5V";
    expect(connectivityCodes(suppliedVoltage)).toContain("ELECTRICAL_PIN_OBLIGATION_001");
    consumer.requires_voltage = "3V3";
    const unsupported = assessCircuitElectrical(suppliedVoltage);
    expect(unsupported.status.state).toBe("incomplete");
    expect(connectivityCodes(suppliedVoltage)).toContain("ELECTRICAL_PIN_METADATA_UNSUPPORTED_001");

    const isolated = cloneCircuitJson(await manufacturingFixture(2));
    const isolatedPort = isolated.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (isolatedPort?.type !== "source_port") throw new Error("Fixture source port missing");
    isolatedPort.must_be_connected = true;
    isolatedPort.requires_power = true;
    isolatedPort.requires_voltage = "3.3V";
    const internalPeerId = "source_port_3";
    const withoutItsConnections = isolated.filter((element) =>
      !(element.type === "source_trace" &&
        element.connected_source_port_ids.some((id) =>
          id === isolatedPort.source_port_id || id === internalPeerId
        )) &&
      !(element.type === "source_component_internal_connection" &&
        element.source_port_ids.includes(isolatedPort.source_port_id))
    );
    if (typeof isolatedPort.source_component_id !== "string") {
      throw new Error("Fixture source port lacks component identity");
    }
    withoutItsConnections.push({
      type: "source_component_internal_connection",
      source_component_internal_connection_id: "floating_internal_connection",
      source_component_id: isolatedPort.source_component_id,
      source_port_ids: [internalPeerId, isolatedPort.source_port_id],
    });
    expect(assessCircuitElectrical(withoutItsConnections).diagnostics.find(
      ({ id }) => id === "ELECTRICAL_PIN_OBLIGATION_001",
    )?.objects).toEqual(expect.arrayContaining([
      "source_port_2:must-be-connected",
      expect.stringContaining("source_port_2:requires-power:"),
      expect.stringContaining("source_port_2:requires-voltage:3.3V:"),
    ]));

    isolatedPort.must_be_connected = false;
    isolatedPort.requires_power = false;
    delete isolatedPort.requires_voltage;
    isolatedPort.do_not_connect = true;
    expect(assessCircuitElectrical(withoutItsConnections).diagnostics.find(
      ({ id }) => id === "ELECTRICAL_PIN_OBLIGATION_001",
    )?.objects ?? []).not.toContainEqual(expect.stringContaining("source_port_2:do-not-connect"));

    const crossComponent = cloneCircuitJson(await manufacturingFixture(2));
    const crossComponentVictim = crossComponent.find(
      (element) => element.type === "source_port" && element.source_port_id === "source_port_2",
    );
    if (
      crossComponentVictim?.type !== "source_port" ||
      typeof crossComponentVictim.source_component_id !== "string"
    ) throw new Error("Fixture cross-component victim missing");
    crossComponentVictim.must_be_connected = true;
    const attacked = crossComponent.filter((element) =>
      !(element.type === "source_trace" &&
        element.connected_source_port_ids.includes(crossComponentVictim.source_port_id))
    );
    attacked.push({
      type: "source_component_internal_connection",
      source_component_internal_connection_id: "cross_component_internal_connection",
      source_component_id: crossComponentVictim.source_component_id,
      source_port_ids: [crossComponentVictim.source_port_id, "source_port_4"],
    });
    const crossComponentAssessment = assessCircuitElectrical(attacked);
    expect(crossComponentAssessment.diagnostics.find(
      ({ id }) => id === "ELECTRICAL_PIN_OBLIGATION_001",
    )?.objects).toContain("source_port_2:must-be-connected");
    expect(crossComponentAssessment.diagnostics.find(
      ({ id }) => id === "ELECTRICAL_CONNECTIVITY_001",
    )?.objects).toContain(
      "cross_component_internal_connection:internal-port-owner-mismatch",
    );
  });

  test("matches large multi-component provider and consumer sets without quadratic ownership scans", async () => {
    const fixture = cloneCircuitJson(await manufacturingFixture(2));
    const sourceComponent = fixture.find((element) => element.type === "source_component");
    const template = fixture.find(
      (element) => element.type === "source_port" &&
        element.source_component_id === sourceComponent?.source_component_id,
    );
    const traceTemplate = fixture.find((element) => element.type === "source_trace");
    if (
      sourceComponent?.type !== "source_component" || template?.type !== "source_port" ||
      traceTemplate?.type !== "source_trace"
    ) {
      throw new Error("Fixture source component, port, or trace missing");
    }
    const circuitJson: AnyCircuitElement[] = [];
    const portIds: string[] = [];
    // 3,500 components + 3,500 ports + one trace stays below the 8,000-element
    // regression budget while exercising both ownership and voltage indexes.
    for (let index = 0; index < 3_500; index += 1) {
      const source_component_id = `voltage_scale_component_${index}`;
      const source_port_id = `voltage_scale_${index}`;
      portIds.push(source_port_id);
      circuitJson.push({
        ...sourceComponent,
        source_component_id,
        name: `VS${index}`,
      });
      circuitJson.push({
        ...template,
        source_port_id,
        source_component_id,
        ...(index % 2 === 0
          ? { provides_voltage: "3.3V", is_using_push_pull: true }
          : { requires_voltage: "5V" }),
      });
    }
    circuitJson.push({
      ...traceTemplate,
      source_trace_id: "voltage_scale_trace",
      connected_source_port_ids: portIds,
      connected_source_net_ids: [],
    });
    const started = performance.now();
    const assessment = assessCircuitElectrical(circuitJson);
    const obligation = assessment.diagnostics.find(
      ({ id }) => id === "ELECTRICAL_PIN_OBLIGATION_001",
    );
    expect(obligation?.objects).toHaveLength(DIAGNOSTIC_REFERENCE_LIMIT);
    expect(obligation?.evidence).toHaveLength(DIAGNOSTIC_REFERENCE_LIMIT);
    expect(obligation?.omittedObjectCount).toBe(1_750 - DIAGNOSTIC_REFERENCE_LIMIT);
    expect(obligation?.omittedEvidenceCount).toBe(1_750 - DIAGNOSTIC_REFERENCE_LIMIT);
    const driverConflict = assessment.diagnostics.find(
      ({ id }) => id === "ELECTRICAL_DRIVER_CONFLICT_001",
    );
    const pushPullConflict = driverConflict?.objects.find((item) => item.includes(":push-pull:"));
    expect(pushPullConflict).toContain("…(+1734)");
    expect(pushPullConflict?.length).toBeLessThan(4_096);
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 8_000);

  test("bounds arbitrary emitted diagnostic classes at the exported assessment boundary", () => {
    const attacked = Array.from({ length: 80 }, (_, index) => ({
      type: `adversarial_${index}_error`,
      [`adversarial_${index}_error_id`]: `adversarial_error_${index}`,
      message: `adversarial ${index}`,
    })) as unknown as AnyCircuitElement[];
    const assessment = assessCircuitElectrical(attacked);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics).toHaveLength(65);
    expect(assessment.diagnostics.at(-1)).toMatchObject({
      id: "ELECTRICAL_EMITTED_CLASS_OVERFLOW_001",
      severity: "error",
      objects: ["circuit-json:emitted-diagnostic-overflow:16"],
    });
  });

  test("counts omitted repeated finding occurrences without retaining them", async () => {
    const fixture = cloneCircuitJson(await manufacturingFixture(2));
    const component = fixture.find((element) => element.type === "source_component");
    const port = fixture.find((element) => element.type === "source_port");
    if (component?.type !== "source_component" || port?.type !== "source_port") {
      throw new Error("Fixture source component or port missing");
    }
    const duplicatedPorts = Array.from({ length: 300 }, () => ({
      ...port,
      source_port_id: "repeated_required_port",
      source_component_id: component.source_component_id,
      must_be_connected: true,
    }));
    const assessment = assessCircuitElectrical([component, ...duplicatedPorts]);
    const obligation = assessment.diagnostics.find(
      ({ id }) => id === "ELECTRICAL_PIN_OBLIGATION_001",
    );
    expect(obligation?.objects).toHaveLength(DIAGNOSTIC_REFERENCE_LIMIT);
    expect(new Set(obligation?.objects)).toEqual(new Set(["repeated_required_port:must-be-connected"]));
    expect(obligation?.omittedObjectCount).toBe(44);
    expect(obligation?.omittedEvidenceCount).toBe(44);
  });

  test("rejects a logical trace whose manufactured PCB trace was deleted", async () => {
    const attacked = (await manufacturingFixture(4)).filter(
      (element) => element.type !== "pcb_trace" || element.pcb_trace_id !== "pcb_trace_0",
    );
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("rejects deletion of both a logical connection and all of its physical evidence", async () => {
    const attacked = (await manufacturingFixture(4)).filter(
      (element) =>
        !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
        !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
        !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0"),
    );
    const assessment = assessCircuitElectrical(attacked);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.find(({ id }) => id === "ELECTRICAL_CONNECTIVITY_001")?.objects)
      .toContainEqual(expect.stringContaining("manufactured-port-has-no-logical-group"));
  });

  test("rejects deletion of source-pin authority while physical pads remain", async () => {
    const removed = new Set(["source_port_1", "source_port_3"]);
    const attacked = (await manufacturingFixture(4)).filter((element) =>
      !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
      !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "source_port" && removed.has(element.source_port_id)) &&
      !(element.type === "schematic_port" && removed.has(element.source_port_id))
    );
    const assessment = assessCircuitElectrical(attacked);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.find(({ id }) => id === "ELECTRICAL_CONNECTIVITY_001")?.objects)
      .toEqual(expect.arrayContaining([
        "pcb_port_1:source-port-count:0",
        "pcb_port_3:source-port-count:0",
      ]));
  });

  test("rejects a coordinated connectivity-key collision across distinct logical endpoints", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const left = attacked.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    const right = attacked.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_3",
    );
    if (left?.type !== "source_trace" || right?.type !== "source_trace") {
      throw new Error("Fixture logical connections missing");
    }
    const key = left.subcircuit_connectivity_map_key;
    right.subcircuit_connectivity_map_key = key;
    for (const element of attacked) {
      if (element.type === "source_port" && right.connected_source_port_ids.includes(element.source_port_id)) {
        element.subcircuit_connectivity_map_key = key;
      }
      if (element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_1") {
        element.subcircuit_connectivity_map_key = key;
      }
    }
    const assessment = assessCircuitElectrical(attacked);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.find(({ id }) => id === "ELECTRICAL_CONNECTIVITY_001")?.objects)
      .toContainEqual(expect.stringContaining("connectivity-key-collision"));
  });

  test("rejects a zero-port logical bridge between two named nets", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const original = attacked.find((element) => element.type === "source_net");
    if (original?.type !== "source_net") throw new Error("Fixture source net missing");
    attacked.push(
      {
        ...original,
        source_net_id: "source_net_hostile_alias",
        name: "HOSTILE_ALIAS",
        subcircuit_connectivity_map_key: "hostile-distinct-key",
      },
      {
        type: "source_trace",
        source_trace_id: "source_trace_zero_port_bridge",
        connected_source_port_ids: [],
        connected_source_net_ids: [original.source_net_id, "source_net_hostile_alias"],
      } as AnyCircuitElement,
    );
    const assessment = assessCircuitElectrical(attacked);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.find(({ id }) => id === "ELECTRICAL_CONNECTIVITY_001")?.objects)
      .toContain(
        "source_trace_zero_port_bridge:multiple-source-nets:source_net_0,source_net_hostile_alias",
      );
  });

  test("rejects a trace endpoint moved away from its assigned pad", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const trace = attacked.find(
      (element) => element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0",
    );
    if (trace?.type !== "pcb_trace" || trace.route[0]?.route_type !== "wire") {
      throw new Error("Fixture PCB trace endpoint missing");
    }
    trace.route[0].x += 1;
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("rejects an orphaned routed via", async () => {
    const attacked = (await manufacturingFixture(4)).filter(
      (element) => element.type !== "pcb_trace" || element.pcb_trace_id !== "pcb_trace_0",
    );
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("rejects a remote physical via that merely claims a trace owner", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const via = attacked.find((element) => element.type === "pcb_via" && element.pcb_trace_id);
    if (via?.type !== "pcb_via") throw new Error("Fixture routed via missing");
    attacked.push({ ...via, pcb_via_id: "pcb_via_remote_attack", x: via.x + 5, y: via.y + 5 });
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
    expect(deriveManufacturingExpectation({ boardName: "attack", circuitJson: attacked }).unsupported)
      .toContainEqual(expect.stringContaining("owner-route transition"));
  });

  test("rejects a through-pad route that references no physical PTH", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const trace = attacked.find((element) => element.type === "pcb_trace");
    if (trace?.type !== "pcb_trace" || trace.route[0]?.route_type !== "wire") {
      throw new Error("Fixture trace missing");
    }
    const wire = trace.route[0];
    trace.route.splice(1, 0, {
      route_type: "through_pad",
      start: { x: wire.x, y: wire.y },
      end: { x: wire.x, y: wire.y },
      width: wire.width,
      start_layer: wire.layer,
      end_layer: wire.layer === "top" ? "bottom" : "top",
      pcb_plated_hole_id: "nonexistent",
    });
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
    expect(deriveManufacturingExpectation({ boardName: "attack", circuitJson: attacked }).unsupported)
      .toContainEqual(expect.stringContaining("does not resolve to exactly one plated through-hole"));
  });

  test("rejects a physical via whose span contradicts its routed transition", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const via = attacked.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_1",
    );
    if (via?.type !== "pcb_via") throw new Error("Fixture routed via missing");
    via.from_layer = "top";
    via.to_layer = "inner1";
    via.layers = ["top", "inner1"];
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("rejects a via whose spoofed net key contradicts source-net ownership", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(2));
    const standalone = attacked.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_0",
    );
    const routed = attacked.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_1",
    );
    const owner = routed?.type === "pcb_via"
      ? attacked.find((element) =>
        element.type === "pcb_trace" && element.pcb_trace_id === routed.pcb_trace_id
      )
      : undefined;
    const logical = owner?.type === "pcb_trace"
      ? attacked.find((element) =>
        element.type === "source_trace" && element.source_trace_id === owner.source_trace_id
      )
      : undefined;
    if (standalone?.type !== "pcb_via" || routed?.type !== "pcb_via" || logical?.type !== "source_trace") {
      throw new Error("Fixture via net identities missing");
    }
    standalone.x = routed.x;
    standalone.y = routed.y;
    standalone.subcircuit_connectivity_map_key = logical.subcircuit_connectivity_map_key;
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("rejects logical ports that have no manufactured endpoint", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const sourceTrace = attacked.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_0",
    );
    if (sourceTrace?.type !== "source_trace") {
      throw new Error("Fixture source trace missing");
    }
    const thirdPort = attacked.find(
      (element) => element.type === "source_port" &&
        !sourceTrace.connected_source_port_ids.includes(element.source_port_id),
    );
    if (thirdPort?.type !== "source_port") {
      throw new Error("Fixture third port missing");
    }
    sourceTrace.connected_source_port_ids.push(thirdPort.source_port_id);
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("rejects a net-connected PTH moved away from its routed port", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    const pth = attacked.find((element) => element.type === "pcb_plated_hole");
    if (pth?.type !== "pcb_plated_hole" || typeof pth.pcb_port_id !== "string") {
      throw new Error("Fixture connected PTH missing");
    }
    expect(pth.layers).toEqual(["top", "bottom", "inner1", "inner2"]);
    pth.x += 1;
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("treats emitted electrical warnings as incomplete", async () => {
    const attacked = cloneCircuitJson(await manufacturingFixture(4));
    attacked.push({
      type: "source_pin_missing_trace_warning",
      source_pin_missing_trace_warning_id: "source_pin_missing_trace_warning_test",
      warning_type: "source_pin_missing_trace_warning",
      source_component_id: "source_component_0",
      source_port_id: "source_port_0",
      message: "A source port is missing a trace",
    });
    expect(assessCircuitElectrical(attacked).status.state).toBe("incomplete");
  });

  test("proves ordinary VCC/GND fanout by grouped net graph coverage", async () => {
    const circuitJson = await sourceNetFixture();
    expect(assessCircuitElectrical(circuitJson).status.state).toBe("passed");

    const attacked = circuitJson.filter(
      (element) => element.type !== "pcb_trace" || element.pcb_trace_id !== "source_net_0_0",
    );
    expect(connectivityCodes(attacked)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });

  test("does not join disconnected net branches through unvalidated endpoint metadata", async () => {
    const circuitJson = cloneCircuitJson(await sourceNetFixture());
    const index = circuitJson.findIndex(
      (element) => element.type === "pcb_trace" && element.pcb_trace_id === "source_net_0_0",
    );
    const original = circuitJson[index];
    if (original?.type !== "pcb_trace") throw new Error("Fixture VCC trace missing");
    const first = original.route[0];
    const last = original.route.at(-1);
    if (first?.route_type !== "wire" || last?.route_type !== "wire") {
      throw new Error("Fixture VCC endpoints missing");
    }
    const isolated = (
      id: string,
      point: typeof first,
      pcbPortId: string,
    ): AnyCircuitElement => ({
      ...original,
      pcb_trace_id: id,
      route: [
        { ...point, start_pcb_port_id: pcbPortId, end_pcb_port_id: "ghost_shared" },
        { ...point, start_pcb_port_id: undefined, end_pcb_port_id: pcbPortId },
      ],
    });
    circuitJson.splice(
      index,
      1,
      isolated("hostile_branch_a", first, first.start_pcb_port_id!),
      isolated("hostile_branch_b", last, last.end_pcb_port_id!),
    );
    expect(connectivityCodes(circuitJson)).toContain("ELECTRICAL_CONNECTIVITY_001");
  });
});
