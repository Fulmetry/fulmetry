import { Trace, type Board } from "tscircuit";

export function addRouting(board: Board): void {
  // pcbPath points are source-component local coordinates in this pinned engine;
  // authored intent is endpoints/layer transitions/via count, while reviewed
  // emitted coordinates are recorded separately in expectation.json.
  board.add(new Trace({ name: "GND1", from: ".J1 > .pin1", to: "net.GND", width: "0.2mm" }));
  board.add(new Trace({ name: "GND2", from: ".J1 > .pin2", to: "net.GND", width: "0.2mm" }));
  board.add(new Trace({
    name: "LED_DRIVE", from: ".R1 > .pin2", to: ".D1 > .pin1", width: "0.2mm",
    pcbPath: [
      { x: 3, y: 0 },
      { x: 3, y: 0, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: 3, y: 0 }, { x: 3, y: 1.5 }, { x: 6, y: 1.5 }, { x: 6, y: 0.825 },
    ],
  }));
  board.add(new Trace({
    name: "LED_RETURN", from: ".D1 > .pin2", to: ".B1 > .pin2", width: "0.2mm",
    pcbPath: [
      { x: -2, y: 2 },
      { x: -2, y: 2, via: true, fromLayer: "bottom", toLayer: "top" },
      { x: -2, y: 2 }, { x: -2, y: -0.5 }, { x: -8, y: -0.5 },
      { x: -8, y: 8.73 }, { x: -6, y: 8.73 },
    ],
  }));
  board.add(new Trace({ name: "LED_SUPPLY", from: ".B1 > .pin1", to: ".R1 > .pin1", width: "0.2mm" }));
}
