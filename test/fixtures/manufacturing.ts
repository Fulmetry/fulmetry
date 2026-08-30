import {
  Board,
  Circuit,
  Hole,
  Led,
  PinHeader,
  Resistor,
  Trace,
  type AnyCircuitElement,
} from "fulmetry/authoring";

export async function manufacturingFixture(
  layers: 2 | 4,
): Promise<AnyCircuitElement[]> {
  const circuit = new Circuit();
  const board = new Board({ width: "20mm", height: "15mm", layers });
  circuit.add(board);

  board.add(
    new Resistor({
      name: "R1",
      resistance: "10k",
      footprint: "0603",
      manufacturerPartNumber: "RC0603FR-0710KL",
      supplierPartNumbers: { jlcpcb: ["C25804"] },
      pcbX: -3,
      pcbY: 2,
    }),
  );
  board.add(
    new Led({
      name: "D1",
      footprint: "0603",
      manufacturerPartNumber: "LTST-C190KGKT",
      supplierPartNumbers: { jlcpcb: ["C2286"] },
      layer: "bottom",
      pcbX: 3,
      pcbY: 2,
      pcbRotation: 90,
    }),
  );
  board.add(new PinHeader({
    name: "J1",
    pinCount: 2,
    footprint: "pinrow2_nosquareplating",
    manufacturerPartNumber: "M20-9990245",
    supplierPartNumbers: { jlcpcb: ["C124375"] },
    pcbX: 0,
    pcbY: -2,
  }));
  board.add(
    new Hole({
      name: "H1",
      shape: "circle",
      diameter: "2mm",
      pcbX: 6,
      pcbY: -4,
    }),
  );
  board.add(new Trace({ name: "GND1", from: ".J1 > .pin1", to: "net.GND", width: "0.2mm" }));
  board.add(new Trace({ name: "GND2", from: ".J1 > .pin2", to: "net.GND", width: "0.2mm" }));

  board.add(
    new Trace({
      name: "N1",
      from: ".R1 > .pin2",
      to: ".D1 > .pin2",
      width: "0.2mm",
      pcbPath: [
        { x: 3, y: -2 },
        { x: 3, y: -2, via: true, fromLayer: "top", toLayer: "bottom" },
        { x: 3, y: -2 },
        { x: 3, y: -0.825 },
      ],
    }),
  );
  board.add(
    new Trace({
      name: "N2",
      from: ".R1 > .pin1",
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
    }),
  );

  await circuit.renderUntilSettled();
  const circuitJson = circuit.getCircuitJson();
  if (layers === 4) {
    const ground = circuitJson.find(
      (element) => element.type === "source_net" && element.name === "GND",
    );
    const headerHoles = circuitJson.filter(
      (element): element is Extract<AnyCircuitElement, { type: "pcb_plated_hole" }> =>
        element.type === "pcb_plated_hole" &&
        element.pcb_component_id === "pcb_component_2",
    ).sort((a, b) => a.x - b.x);
    if (ground?.type !== "source_net" || headerHoles.length !== 2) {
      throw new Error("Four-layer fixture requires the GND net and two header PTHs");
    }
    for (const [index, layer] of ["inner1", "inner2"].entries()) {
      const start = headerHoles[0]!;
      const end = headerHoles[1]!;
      circuitJson.push({
        type: "pcb_trace",
        pcb_trace_id: `pcb_trace_fulmetry_inner_${index + 1}`,
        source_trace_id: "source_trace_0",
        subcircuit_id: ground.subcircuit_id,
        route: [
          {
            route_type: "wire",
            x: start.x,
            y: start.y,
            width: 0.2,
            layer,
            start_pcb_port_id: start.pcb_port_id,
          },
          {
            route_type: "wire",
            x: end.x,
            y: end.y,
            width: 0.2,
            layer,
            end_pcb_port_id: end.pcb_port_id,
          },
        ],
        trace_length: Math.hypot(end.x - start.x, end.y - start.y),
      } as AnyCircuitElement);
    }
  }
  const errors = circuitJson.filter(
    (element) => element.type.includes("error") || element.type.includes("warning"),
  );
  if (errors.length > 0) {
    throw new Error(`Manufacturing fixture must be electrically clean: ${JSON.stringify(errors)}`);
  }
  return circuitJson;
}
