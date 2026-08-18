import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "circuit-json";
import { parseDsnToDsnJson, type DsnSession } from "dsn-converter";
import { createFreeroutingDsn, restoreFreeroutingSessionLayers } from "../src/routing/freerouting";
import { manufacturingFixture } from "./fixtures/manufacturing";

describe("bounded Freerouting adapter", () => {
  test("exports an exact four-layer stack and converts millimetres to DSN micrometres", async () => {
    const fixture = await manufacturingFixture(4);
    fixture.push({
      type: "pcb_keepout",
      shape: "rect",
      pcb_keepout_id: "pcb_keepout_antenna",
      center: { x: 2, y: 3 },
      width: 4,
      height: 6,
      layers: ["top", "inner1", "inner2", "bottom"],
    });
    const artifact = createFreeroutingDsn(fixture, { clearanceMm: 0.2 });
    expect(artifact.layerNames).toEqual(["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
    expect(artifact.clearanceDsnUnits).toBe(200);
    const parsed = parseDsnToDsnJson(artifact.dsn);
    if (!parsed.is_dsn_pcb) throw new Error("Expected PCB DSN");
    expect(parsed.structure.rule.clearances[0]?.value).toBe(200);
    expect(parsed.network.classes[0]?.rule.clearances[0]?.value).toBe(200);
    expect(artifact.exportedKeepouts).toBe(4);
    expect(artifact.dsn).toContain('(keepout "pcb_keepout_antenna:In1.Cu"');
    expect(artifact.dsn).toContain("(rect In1.Cu 0 0 4000 6000)");
  });

  test("rejects unsafe work sizes and invalid manufacturing clearances before tool execution", async () => {
    const fixture = await manufacturingFixture(2);
    expect(() => createFreeroutingDsn(fixture, { clearanceMm: 0 })).toThrow("positive and finite");
    expect(() => createFreeroutingDsn(fixture, { clearanceMm: 0.2, maxElements: 1 }))
      .toThrow("limit is 1");
  });

  test("removes existing routes and conservatively bounds unsupported rectangular-pad slots", async () => {
    const fixture = await manufacturingFixture(4);
    const existingRoutingElements = fixture.filter((element) =>
      element.type === "pcb_trace" || element.type === "pcb_via"
    ).length;
    const hole = fixture.find((element) => element.type === "pcb_plated_hole");
    if (hole?.type !== "pcb_plated_hole") throw new Error("Fixture PTH missing");
    const mutable = hole as unknown as Record<string, unknown>;
    delete mutable.hole_diameter;
    delete mutable.outer_diameter;
    Object.assign(mutable, {
      shape: "rotated_pill_hole_with_rect_pad",
      hole_width: 0.6,
      hole_height: 1.2,
      rect_pad_width: 1.1,
      rect_pad_height: 1.8,
    });
    fixture.push({
      type: "pcb_trace",
      pcb_trace_id: "pcb_trace_existing",
      source_trace_id: "source_trace_0",
      route: [],
    });

    const artifact = createFreeroutingDsn(fixture, { clearanceMm: 0.2 });
    expect(artifact.removedExistingRoutingElements).toBe(existingRoutingElements + 1);
    expect(artifact.approximatedSlottedHoles).toBe(1);
    expect(artifact.dsn).not.toContain("pcb_trace_existing");
    expect(artifact.dsn).toContain("Round[A]Pad_1341.640786499874_2109.5023109728986_um");
    expect(artifact.dsn).toContain("(wiring\n  )");
  });

  test("restores inner copper layers and via transitions from four-layer sessions", () => {
    const converted = [
      {
        type: "pcb_trace",
        pcb_trace_id: "pcb_trace_POWER_0",
        source_trace_id: "source_trace_0",
        route: [
          { route_type: "wire", x: 1, y: 2, width: 0.2, layer: "bottom" },
          { route_type: "via", x: 3, y: 2, from_layer: "bottom", to_layer: "bottom" },
        ],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "pcb_trace_POWER_1",
        source_trace_id: "source_trace_0",
        route: [{ route_type: "wire", x: 3, y: 2, width: 0.2, layer: "bottom" }],
      },
      {
        type: "pcb_via",
        pcb_via_id: "pcb_via_POWER_30000_20000",
        pcb_trace_id: "pcb_trace_POWER",
        x: 3,
        y: 2,
        hole_diameter: 0.3,
        outer_diameter: 0.6,
        layers: ["top", "bottom"],
        from_layer: "bottom",
        to_layer: "bottom",
      },
    ] as unknown as AnyCircuitElement[];
    const session = {
      routes: {
        network_out: {
          nets: [{
            name: "POWER",
            wires: [
              { path: { layer: "In1.Cu", width: 1500, coordinates: [10000, 20000, 30000, 20000] } },
              { path: { layer: "In2.Cu", width: 1500, coordinates: [30000, 20000, 40000, 20000] } },
            ],
            vias: [{ padstack: "Via[0-3]_600:300_um", x: 30000, y: 20000 }],
          }],
        },
      },
    } as unknown as DsnSession;

    const restored = restoreFreeroutingSessionLayers(converted, session);
    const traces = restored.filter((element) => element.type === "pcb_trace");
    expect(traces[0]?.route[0]).toMatchObject({ layer: "inner1" });
    expect(traces[0]?.route[1]).toMatchObject({ from_layer: "inner1", to_layer: "inner2" });
    expect(traces[1]?.route[0]).toMatchObject({ layer: "inner2" });
    expect(restored.find((element) => element.type === "pcb_via")).toMatchObject({
      from_layer: "inner1",
      to_layer: "inner2",
      layers: ["inner1", "inner2"],
    });
  });
});
