import { describe, expect, test } from "bun:test";
import * as pcboo from "pcboo/authoring";
import * as upstream from "tscircuit";

const CURATED_AUTHORING_VALUES = [
  "Battery",
  "Board",
  "Bus",
  "Capacitor",
  "Chip",
  "Circuit",
  "Connector",
  "Constraint",
  "CopperPour",
  "Crystal",
  "CurrentSource",
  "Cutout",
  "DifferentialPair",
  "Diode",
  "DrcCheck",
  "Footprint",
  "Fuse",
  "Group",
  "Hole",
  "Inductor",
  "Jumper",
  "Keepout",
  "Led",
  "Mosfet",
  "Net",
  "NetLabel",
  "OpAmp",
  "Panel",
  "PcbTrace",
  "PcbVia",
  "PinHeader",
  "PlatedHole",
  "Potentiometer",
  "PowerSource",
  "Project",
  "PushButton",
  "Resistor",
  "SmtPad",
  "SolderJumper",
  "Subcircuit",
  "Switch",
  "TestPoint",
  "Trace",
  "Transistor",
  "Via",
  "VoltageSource",
  "createElement",
  "sel",
] as const;

describe("upstream authoring identity", () => {
  test("curated PCBoo values are the exact upstream references", () => {
    for (const name of CURATED_AUTHORING_VALUES) {
      expect(pcboo[name]).toBe(upstream[name]);
    }
  });

  test("instances cross the PCBoo and tscircuit import boundary", () => {
    const board = new pcboo.Board({ width: "10mm", height: "10mm" });
    const resistor = new upstream.Resistor({
      name: "R1",
      resistance: "10k",
      footprint: "0402",
    });

    expect(board).toBeInstanceOf(upstream.Board);
    expect(resistor).toBeInstanceOf(pcboo.Resistor);
    expect(Object.getPrototypeOf(board)).toBe(upstream.Board.prototype);
  });

  test("mixed imports render the same Circuit JSON as either source alone", async () => {
    const build = async (
      CircuitClass: typeof upstream.Circuit,
      BoardClass: typeof upstream.Board,
      ResistorClass: typeof upstream.Resistor,
      LedClass: typeof upstream.Led,
      TraceClass: typeof upstream.Trace,
    ) => {
      const circuit = new CircuitClass();
      const board = new BoardClass({ width: "10mm", height: "10mm" });
      circuit.add(board);
      board.add(
        new ResistorClass({
          name: "R1",
          resistance: "10k",
          footprint: "0402",
          pcbX: -2,
        }),
      );
      board.add(
        new LedClass({ name: "LED1", footprint: "0402", pcbX: 2 }),
      );
      board.add(
        new TraceClass({
          name: "R1_TO_LED1",
          from: ".R1 > .pin1",
          to: ".LED1 > .anode",
        }),
      );
      await circuit.renderUntilSettled();
      return circuit.getCircuitJson();
    };

    const upstreamOnly = await build(
      upstream.Circuit,
      upstream.Board,
      upstream.Resistor,
      upstream.Led,
      upstream.Trace,
    );
    const pcbooOnly = await build(
      pcboo.Circuit,
      pcboo.Board,
      pcboo.Resistor,
      pcboo.Led,
      pcboo.Trace,
    );
    const mixed = await build(
      pcboo.Circuit,
      upstream.Board,
      pcboo.Resistor,
      upstream.Led,
      pcboo.Trace,
    );

    expect(pcbooOnly).toEqual(upstreamOnly);
    expect(mixed).toEqual(upstreamOnly);
  });
});
