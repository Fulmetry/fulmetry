import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "circuit-json";
import { Board, Circuit, PinHeader, Trace } from "tscircuit";
import { SemanticPcbTrace, defineRoutes, port, resolveSemanticPcbRoute } from "../src/routes";

const circuit = [
  { type: "pcb_board", pcb_board_id: "pcb_board_7", center: { x: 0, y: 0 }, width: 20, height: 20, thickness: 1.6, num_layers: 4, material: "fr4" },
  { type: "source_component", source_component_id: "source_component_9", name: "J1", ftype: "simple_connector" },
  { type: "source_component", source_component_id: "source_component_3", name: "U1", ftype: "simple_chip" },
  { type: "source_port", source_port_id: "source_port_8", source_component_id: "source_component_9", name: "DP", pin_number: 1, port_hints: ["DP", "pin1"] },
  { type: "source_port", source_port_id: "source_port_2", source_component_id: "source_component_3", name: "USB_DP", pin_number: 4, port_hints: ["USB_DP", "pin4"] },
  { type: "pcb_port", pcb_port_id: "pcb_port_20", source_port_id: "source_port_8", pcb_component_id: "pcb_component_1", x: -4, y: 1, layers: ["top"] },
  { type: "pcb_port", pcb_port_id: "pcb_port_10", source_port_id: "source_port_2", pcb_component_id: "pcb_component_2", x: 4, y: -1, layers: ["top"] },
  { type: "source_net", source_net_id: "source_net_5", name: "USB_DP", subcircuit_id: "subcircuit_1", member_source_group_ids: [], is_power: false, is_ground: false, is_positive_voltage_source: false },
  { type: "source_trace", source_trace_id: "source_trace_99", connected_source_net_ids: ["source_net_5"], connected_source_port_ids: ["source_port_2"], display_name: "U1.USB_DP to USB_DP" },
  { type: "source_trace", source_trace_id: "source_trace_42", connected_source_net_ids: ["source_net_5"], connected_source_port_ids: ["source_port_8"], display_name: "J1.DP to USB_DP" },
] as unknown as AnyCircuitElement[];

describe("semantic authored PCB routes", () => {
  test("renders board-level traces without null ownership and emits explicit vias", async () => {
    const rendered = new Circuit();
    const board = new Board({ width: "20mm", height: "15mm", layers: 4 });
    rendered.add(board);
    board.add(new PinHeader({ name: "J1", pinCount: 2, footprint: "pinrow2_nosquareplating" }));
    board.add(new Trace({ name: "GND1", from: ".J1 > .pin1", to: "net.GND" }));
    board.add(new Trace({ name: "GND2", from: ".J1 > .pin2", to: "net.GND" }));
    board.add(new SemanticPcbTrace({
      name: "ground-header",
      net: "GND",
      from: port("J1", 1),
      to: port("J1", 2),
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
        { route_type: "wire", x: -1, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: -1, y: 0, from_layer: "top", to_layer: "inner2", hole_diameter: 0.3, outer_diameter: 0.6 },
        { route_type: "wire", x: -1, y: 0, width: 0.2, layer: "inner2" },
        { route_type: "via", x: 1, y: 0, from_layer: "inner2", to_layer: "top", hole_diameter: 0.3, outer_diameter: 0.6 },
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
      ],
    }));
    await rendered.renderUntilSettled();
    const elements = rendered.getCircuitJson();
    const semantic = elements.find((element): element is Extract<
      AnyCircuitElement,
      { type: "pcb_trace" }
    > => element.type === "pcb_trace" && "connection_name" in element);
    expect(semantic).toMatchObject({
      type: "pcb_trace",
      connection_name: expect.stringMatching(/^source_net_/),
      connectsTo: expect.arrayContaining([expect.stringMatching(/^pcb_port_/)]),
    });
    expect(semantic).not.toHaveProperty("pcb_component_id");
    expect(elements.filter((element) =>
      element.type === "pcb_via" && element.pcb_trace_id === semantic?.pcb_trace_id
    )).toHaveLength(2);
  });

  test("resolves stable selectors, snaps endpoints, and materializes a four-layer via", () => {
    const resolved = resolveSemanticPcbRoute(circuit, {
      name: "usb-data-positive",
      net: "USB_DP",
      from: port("J1", "DP"),
      to: port("U1", 4),
      route: [
        { route_type: "wire", x: 999, y: 999, width: 0.2, layer: "top" },
        { route_type: "wire", x: 0, y: 1, width: 0.2, layer: "top" },
        { route_type: "via", x: 0, y: 1, from_layer: "inner2", to_layer: "top", hole_diameter: 0.3, outer_diameter: 0.6 },
        { route_type: "wire", x: 0, y: 1, width: 0.2, layer: "inner2" },
        { route_type: "via", x: 3, y: -1, from_layer: "inner2", to_layer: "top", hole_diameter: 0.3, outer_diameter: 0.6 },
        { route_type: "wire", x: 999, y: 999, width: 0.2, layer: "top" },
      ],
    });
    expect(resolved.sourceTraceId).toBe("source_trace_42");
    expect(resolved.sourceNetId).toBe("source_net_5");
    expect(resolved.connectsTo).toEqual(["pcb_port_20", "pcb_port_10"]);
    expect(resolved.route[0]).toMatchObject({ x: -4, y: 1, start_pcb_port_id: "pcb_port_20" });
    expect(resolved.route.at(-1)).toMatchObject({ x: 4, y: -1, end_pcb_port_id: "pcb_port_10" });
    expect(resolved.route[2]).toMatchObject({ from_layer: "top", to_layer: "inner2" });
    expect(resolved.vias.map((via) => via.layers)).toEqual([
      ["top", "inner1", "inner2", "bottom"],
      ["top", "inner1", "inner2", "bottom"],
    ]);
  });

  test("rejects ambiguous names, implicit via dimensions, and duplicate route identities", () => {
    expect(() => defineRoutes([
      {
        name: "dup", net: "USB_DP", from: port("J1", "DP"), to: port("U1", 4),
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
          { route_type: "wire", x: 1, y: 0, width: 0.2, layer: "top" },
        ],
      },
      {
        name: "dup", net: "USB_DP", from: port("J1", "DP"), to: port("U1", 4),
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
          { route_type: "wire", x: 1, y: 0, width: 0.2, layer: "top" },
        ],
      },
    ])).toThrow("duplicated");
    expect(() => resolveSemanticPcbRoute(circuit, {
      name: "implicit-via", net: "USB_DP", from: port("J1", "DP"), to: port("U1", 4),
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: 0, y: 0, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: 1, y: 0, width: 0.2, layer: "top" },
      ],
    })).toThrow("requires finite hole_diameter");
  });
});
