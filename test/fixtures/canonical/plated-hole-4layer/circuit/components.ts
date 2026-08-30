import { Battery, Hole, Led, PinHeader, Resistor, type Board } from "tscircuit";

export function addComponents(board: Board): void {
  board.add(new Battery({
    name: "B1", voltage: "5V", footprint: "pinrow2_nosquareplating",
    manufacturerPartNumber: "CANONICAL-BATTERY-2P",
    supplierPartNumbers: { jlcpcb: ["C124375"] },
    pcbX: -6.9, pcbY: -4,
  }));
  board.add(new Resistor({
    name: "R1", resistance: "10k", footprint: "0603",
    manufacturerPartNumber: "RC0603FR-0710KL",
    supplierPartNumbers: { jlcpcb: ["C25804"] }, pcbX: -3, pcbY: 2,
  }));
  board.add(new Led({
    name: "D1", footprint: "0603", supplierPartNumbers: { jlcpcb: ["C2286"] },
    manufacturerPartNumber: "LTST-C190KGKT",
    layer: "bottom", pcbX: 3, pcbY: 2, pcbRotation: 90,
  }));
  board.add(new PinHeader({
    name: "J1", pinCount: 2, footprint: "pinrow2_nosquareplating",
    manufacturerPartNumber: "M20-9990245",
    supplierPartNumbers: { jlcpcb: ["C124375"] }, pcbX: 0, pcbY: -2,
  }));
  board.add(new Hole({ name: "H1", shape: "circle", diameter: "2mm", pcbX: 6, pcbY: -4 }));
}
