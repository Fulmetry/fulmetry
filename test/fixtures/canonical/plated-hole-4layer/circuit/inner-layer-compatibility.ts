import type { AnyCircuitElement } from "tscircuit";

type PlatedHole = Extract<AnyCircuitElement, { type: "pcb_plated_hole" }>;

/**
 * Authored fixture intent for inner-layer GND copper between J1 pins.
 * The accepted tscircuit surface has no qualified direct inner-trace authoring primitive,
 * so this narrowly scoped compatibility shim appends Circuit JSON after render.
 * Remove it when the pinned upstream exposes deterministic authored inner-layer
 * routing with equivalent source provenance and manufacturing bytes.
 */
export const INNER_LAYER_GND_INTENT = Object.freeze({
  component: "J1",
  fromPin: "pin1",
  toPin: "pin2",
  net: "GND",
  layers: ["inner1", "inner2"] as const,
  widthMm: 0.2,
  viaXsMm: [-0.4, 0.4] as const,
  viaHoleDiameterMm: 0.2,
  viaOuterDiameterMm: 0.3,
});

export function applyInnerLayerCompatibilityShim(circuitJson: AnyCircuitElement[]): void {
  const sourceComponent = circuitJson.find((element) =>
    element.type === "source_component" && element.name === INNER_LAYER_GND_INTENT.component
  );
  const ground = circuitJson.find((element) =>
    element.type === "source_net" && element.name === INNER_LAYER_GND_INTENT.net
  );
  if (sourceComponent?.type !== "source_component" || ground?.type !== "source_net") {
    throw new Error("Canonical inner-layer intent could not resolve J1 or GND");
  }
  const pcbComponent = circuitJson.find((element) =>
    element.type === "pcb_component" && element.source_component_id === sourceComponent.source_component_id
  );
  if (pcbComponent?.type !== "pcb_component") {
    throw new Error("Canonical inner-layer intent could not resolve J1 PCB identity");
  }
  const holes = circuitJson.filter((element): element is PlatedHole =>
    element.type === "pcb_plated_hole" && element.pcb_component_id === pcbComponent.pcb_component_id
  ).sort((left, right) => left.x - right.x);
  if (holes.length !== 2) throw new Error("Canonical J1 must resolve to exactly two plated holes");
  const groundTrace = circuitJson.find((element) =>
    element.type === "pcb_trace" && element.route.some((point) =>
      point.route_type === "wire" &&
      (point.start_pcb_port_id === holes[0]!.pcb_port_id || point.end_pcb_port_id === holes[1]!.pcb_port_id)
    )
  );
  if (groundTrace?.type !== "pcb_trace") {
    throw new Error("Canonical inner-layer intent could not resolve the manufactured GND trace");
  }
  const ownerSourceTrace = circuitJson.find((element) =>
    element.type === "source_trace" && element.source_trace_id === groundTrace.source_trace_id
  );
  if (ownerSourceTrace?.type !== "source_trace" ||
    !ownerSourceTrace.connected_source_net_ids.includes(ground.source_net_id)) {
    throw new Error("Canonical manufactured GND trace lacks authoritative GND provenance");
  }
  const start = holes[0]!;
  const end = holes[1]!;
  const [firstViaX, secondViaX] = INNER_LAYER_GND_INTENT.viaXsMm;
  const y = start.y;
  groundTrace.route = [
    { route_type: "wire", x: start.x, y, width: INNER_LAYER_GND_INTENT.widthMm, layer: "top", start_pcb_port_id: start.pcb_port_id },
    { route_type: "wire", x: firstViaX, y, width: INNER_LAYER_GND_INTENT.widthMm, layer: "top" },
    { route_type: "via", x: firstViaX, y, from_layer: "top", to_layer: "bottom" },
    { route_type: "wire", x: firstViaX, y, width: INNER_LAYER_GND_INTENT.widthMm, layer: "bottom" },
    { route_type: "wire", x: secondViaX, y, width: INNER_LAYER_GND_INTENT.widthMm, layer: "bottom" },
    { route_type: "via", x: secondViaX, y, from_layer: "bottom", to_layer: "top" },
    { route_type: "wire", x: secondViaX, y, width: INNER_LAYER_GND_INTENT.widthMm, layer: "top" },
    { route_type: "wire", x: end.x, y, width: INNER_LAYER_GND_INTENT.widthMm, layer: "top", end_pcb_port_id: end.pcb_port_id },
  ];
  groundTrace.trace_length = Math.abs(end.x - start.x) + Math.abs(secondViaX - firstViaX);
  for (const [index, x] of INNER_LAYER_GND_INTENT.viaXsMm.entries()) {
    circuitJson.push({
      type: "pcb_via",
      pcb_via_id: `pcb_via_canonical_ground_${index + 1}`,
      pcb_trace_id: groundTrace.pcb_trace_id,
      source_net_id: ground.source_net_id,
      x, y,
      hole_diameter: INNER_LAYER_GND_INTENT.viaHoleDiameterMm,
      outer_diameter: INNER_LAYER_GND_INTENT.viaOuterDiameterMm,
      layers: ["top", "inner1", "inner2", "bottom"],
      from_layer: index === 0 ? "top" : "bottom",
      to_layer: index === 0 ? "bottom" : "top",
      subcircuit_id: ground.subcircuit_id,
      subcircuit_connectivity_map_key: ownerSourceTrace.subcircuit_connectivity_map_key,
    } as AnyCircuitElement);
  }
  for (const [index, layer] of INNER_LAYER_GND_INTENT.layers.entries()) {
    circuitJson.push({
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_canonical_inner_${index + 1}`,
      source_trace_id: groundTrace.source_trace_id,
      subcircuit_id: ground.subcircuit_id,
      route: [
        { route_type: "wire", x: start.x, y: start.y, width: INNER_LAYER_GND_INTENT.widthMm, layer, start_pcb_port_id: start.pcb_port_id },
        { route_type: "wire", x: firstViaX, y, width: INNER_LAYER_GND_INTENT.widthMm, layer },
        { route_type: "wire", x: secondViaX, y, width: INNER_LAYER_GND_INTENT.widthMm, layer },
        { route_type: "wire", x: end.x, y: end.y, width: INNER_LAYER_GND_INTENT.widthMm, layer, end_pcb_port_id: end.pcb_port_id },
      ],
      trace_length: Math.hypot(end.x - start.x, end.y - start.y),
    } as AnyCircuitElement);
  }
}
