// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import {
  Board,
  Circuit,
  PinHeader,
  Resistor,
  Trace,
  type AnyCircuitElement,
} from "fulmetry/authoring";

/** A small, manufactured voltage divider shared by live simulation and release evidence. */
export async function liveFunctionalFixture(): Promise<AnyCircuitElement[]> {
  const circuit = new Circuit();
  const board = new Board({ width: "30mm", height: "15mm", layers: 2 });
  circuit.add(board);
  board.add(new PinHeader({
    name: "J1",
    pinCount: 2,
    footprint: "pinrow2_nosquareplating",
    manufacturerPartNumber: "M20-9990245",
    supplierPartNumbers: { jlcpcb: ["C124375"] },
    pcbX: -10,
    pcbY: 0,
  }));
  board.add(new Resistor({
    name: "R1",
    resistance: "10k",
    footprint: "0603",
    manufacturerPartNumber: "RC0603FR-0710KL",
    supplierPartNumbers: { jlcpcb: ["C25804"] },
    pcbX: -3,
    pcbY: 2,
  }));
  board.add(new Resistor({
    name: "R2",
    resistance: "10k",
    footprint: "0603",
    manufacturerPartNumber: "RC0603FR-0710KL",
    supplierPartNumbers: { jlcpcb: ["C25804"] },
    pcbX: 4,
    pcbY: 2,
  }));
  board.add(new Trace({ name: "J1_VIN", from: ".J1 > .pin1", to: "net.VIN", width: "0.2mm" }));
  board.add(new Trace({ name: "R1_VIN", from: ".R1 > .pin1", to: "net.VIN", width: "0.2mm" }));
  board.add(new Trace({ name: "R1_VOUT", from: ".R1 > .pin2", to: "net.VOUT", width: "0.2mm" }));
  board.add(new Trace({ name: "R2_VOUT", from: ".R2 > .pin1", to: "net.VOUT", width: "0.2mm" }));
  board.add(new Trace({ name: "R2_GND", from: ".R2 > .pin2", to: "net.GND", width: "0.2mm" }));
  board.add(new Trace({ name: "J1_GND", from: ".J1 > .pin2", to: "net.GND", width: "0.2mm" }));
  await circuit.renderUntilSettled();
  const circuitJson = circuit.getCircuitJson();
  const errors = circuitJson.filter((element) =>
    element.type.includes("error") || element.type.includes("warning")
  );
  if (errors.length > 0) {
    throw new Error(`Live functional fixture must be clean: ${JSON.stringify(errors)}`);
  }
  return circuitJson;
}
