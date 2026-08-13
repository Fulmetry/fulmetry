import { describe, expect, test } from "bun:test";
import { defineDiagnostic, diagnosticId } from "../src/diagnostics";
import { diagnosticObjectMatchesTarget } from "../src/diagnostic-object-selector";
import {
  inspectableElements,
  logicalConnectivityPath,
  physicalConnectivityPath,
  relationPath,
  unconnectedManufacturedEndpointIds,
} from "../src/server/inspection";

function routedNetFixture(): Array<Record<string, unknown>> {
  return [
    { type: "pcb_board", pcb_board_id: "BOARD", thickness: 1.6, num_layers: 2 },
    { type: "source_component", source_component_id: "SC1", name: "U1", ftype: "simple_chip" },
    { type: "source_component", source_component_id: "SC2", name: "U2", ftype: "simple_chip" },
    { type: "pcb_component", pcb_component_id: "PC1", source_component_id: "SC1" },
    { type: "pcb_component", pcb_component_id: "PC2", source_component_id: "SC2" },
    { type: "source_port", source_port_id: "SP1", source_component_id: "SC1" },
    { type: "source_port", source_port_id: "SP2", source_component_id: "SC2" },
    { type: "source_trace", source_trace_id: "ST", connected_source_port_ids: ["SP1", "SP2"], connected_source_net_ids: [] },
    { type: "pcb_port", pcb_port_id: "PP1", pcb_component_id: "PC1", source_port_id: "SP1", x: 0, y: 0, layers: ["top"] },
    { type: "pcb_port", pcb_port_id: "PP2", pcb_component_id: "PC2", source_port_id: "SP2", x: 10, y: 0, layers: ["top"] },
    { type: "pcb_smtpad", pcb_smtpad_id: "PAD1", pcb_component_id: "PC1", pcb_port_id: "PP1", x: 0, y: 0, width: 1, height: 1, shape: "rect", layer: "top" },
    { type: "pcb_smtpad", pcb_smtpad_id: "PAD2", pcb_component_id: "PC2", pcb_port_id: "PP2", x: 10, y: 0, width: 1, height: 1, shape: "rect", layer: "top" },
  ];
}

function directTrace(): Record<string, unknown> {
  return {
    type: "pcb_trace",
    pcb_trace_id: "PT",
    source_trace_id: "ST",
    trace_length: 999,
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "PP1" },
      { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "top", end_pcb_port_id: "PP2" },
    ],
  };
}

describe("agent-facing circuit inspection", () => {
  test("matches exact internal diagnostic selector heads without prefix collisions", () => {
    expect(diagnosticObjectMatchesTarget(
      "source_trace_2:length:12:maximum:10",
      "source_trace_2",
    )).toBeTrue();
    expect(diagnosticObjectMatchesTarget(
      "source_trace_2:length:12:maximum:10",
      "source_trace_20",
    )).toBeFalse();
    for (const invalid of [
      "source_trace_2:",
      "source_trace_2::length",
      "source_trace_2:length 12",
      "source.trace_2:length:12",
    ]) {
      expect(diagnosticObjectMatchesTarget(invalid, "source_trace_2"), invalid).toBeFalse();
    }
    const [trace] = inspectableElements([{
      type: "source_trace",
      source_trace_id: "source_trace_2",
      connected_source_port_ids: [],
      connected_source_net_ids: [],
    }, {
      type: "source_trace",
      source_trace_id: "source_trace_20",
      connected_source_port_ids: [],
      connected_source_net_ids: [],
    }], [defineDiagnostic({
      id: diagnosticId("FAB_ROUTE_CONSTRAINT_001"),
      severity: "error",
      dimension: "fabrication",
      message: "route violates maximum length",
      waiverPolicy: "forbidden",
      objects: ["source_trace_2:length:12:maximum:10"],
      sourceLocations: ["circuit/board.ts:42:3"],
    })]);
    expect(trace).toMatchObject({
      id: "source_trace_2",
      violations: ["FAB_ROUTE_CONSTRAINT_001"],
      sourceLocations: ["circuit/board.ts:42:3"],
    });
    const collision = inspectableElements([{
      type: "source_trace",
      source_trace_id: "source_trace_20",
      connected_source_port_ids: [],
      connected_source_net_ids: [],
    }], [defineDiagnostic({
      id: diagnosticId("FAB_ROUTE_CONSTRAINT_001"),
      severity: "error",
      dimension: "fabrication",
      message: "route violates maximum length",
      waiverPolicy: "forbidden",
      objects: ["source_trace_2:length:12:maximum:10"],
      sourceLocations: ["circuit/board.ts:42:3"],
    })])[0];
    expect(collision?.violations).toEqual([]);
    expect(collision?.sourceLocations).toEqual([]);
  });

  test("uses each Circuit JSON type's own primary ID instead of a foreign reference", () => {
    const [pad] = inspectableElements([{
      type: "pcb_smtpad",
      pcb_component_id: "pcb_component_1",
      pcb_port_id: "pcb_port_1",
      pcb_smtpad_id: "pcb_smtpad_1",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      layer: "top",
    }], []);
    expect(pad?.id).toBe("pcb_smtpad_1");
    expect(pad?.relatedObjectIds).toContain("pcb_component_1");
  });

  test("separates structural ownership paths from proven electrical paths", () => {
    const elements = inspectableElements([
      { type: "pcb_component", pcb_component_id: "C" },
      { type: "pcb_smtpad", pcb_smtpad_id: "P1", pcb_component_id: "C", pcb_port_id: "PORT1", x: 0, y: 0, width: 1, height: 1, shape: "rect", layer: "top" },
      { type: "pcb_smtpad", pcb_smtpad_id: "P2", pcb_component_id: "C", pcb_port_id: "PORT2", x: 1, y: 0, width: 1, height: 1, shape: "rect", layer: "top" },
      { type: "pcb_port", pcb_port_id: "PORT1", pcb_component_id: "C", source_port_id: "SOURCE1", x: 0, y: 0, layers: ["top"] },
      { type: "pcb_port", pcb_port_id: "PORT2", pcb_component_id: "C", source_port_id: "SOURCE2", x: 1, y: 0, layers: ["top"] },
      { type: "source_port", source_port_id: "SOURCE1", source_component_id: "SC" },
      { type: "source_port", source_port_id: "SOURCE2", source_component_id: "SC" },
    ], []);
    expect(relationPath(elements, "P1", "P2")).toEqual(["P1", "C", "P2"]);
    expect(logicalConnectivityPath(elements, "P1", "SOURCE1")).toEqual(["P1", "PORT1", "SOURCE1"]);
    expect(logicalConnectivityPath(elements, "P1", "P2")).toBeUndefined();
  });

  test("does not turn a remote pad reference into manufactured connectivity", () => {
    const elements = inspectableElements([
      { type: "pcb_smtpad", pcb_smtpad_id: "PAD", pcb_port_id: "PORT", x: 100, y: 100, width: 1, height: 1, shape: "rect", layer: "top" },
      { type: "pcb_port", pcb_port_id: "PORT", source_port_id: "SOURCE", x: 0, y: 0, layers: ["top"] },
      { type: "source_port", source_port_id: "SOURCE" },
    ], []);
    expect(logicalConnectivityPath(elements, "PAD", "SOURCE")).toBeUndefined();
    expect(relationPath(elements, "PAD", "SOURCE")).toEqual(["PAD", "PORT", "SOURCE"]);
  });

  test("rotates rectangular bounds before region and distance calculations", () => {
    const [component] = inspectableElements([{
      type: "pcb_component",
      pcb_component_id: "ROTATED",
      center: { x: 0, y: 0 },
      width: 4,
      height: 1,
      rotation: 90,
    }], []);
    expect(component?.bounds?.minX).toBeCloseTo(-0.5, 10);
    expect(component?.bounds?.maxX).toBeCloseTo(0.5, 10);
    expect(component?.bounds?.minY).toBeCloseTo(-2, 10);
    expect(component?.bounds?.maxY).toBeCloseTo(2, 10);
  });

  test("does not use a rotated pad's axis-aligned bounds as copper containment", () => {
    const elements = inspectableElements([
      { type: "pcb_smtpad", pcb_smtpad_id: "PAD", pcb_port_id: "PORT", x: 0, y: 0, width: 4, height: 1, shape: "rect", rotation: 45, layer: "top" },
      { type: "pcb_port", pcb_port_id: "PORT", source_port_id: "SOURCE", x: 1.5, y: 1.5, layers: ["top"] },
      { type: "source_port", source_port_id: "SOURCE" },
    ], []);
    expect(logicalConnectivityPath(elements, "PAD", "SOURCE")).toBeUndefined();
  });

  test("reports logical intent without claiming an entirely unrouted net is physical", () => {
    const elements = inspectableElements(routedNetFixture(), []);
    expect(logicalConnectivityPath(elements, "PAD1", "PAD2")).toEqual([
      "PAD1", "PP1", "SP1", "ST", "SP2", "PP2", "PAD2",
    ]);
    expect(physicalConnectivityPath(elements, "PAD1", "PAD2")).toBeUndefined();
    expect(unconnectedManufacturedEndpointIds(elements, "PAD1", "PAD2"))
      .toEqual(["PAD1", "PAD2"]);
  });

  test("proves a same-net route only when both copper endpoints land on pads", () => {
    const routed = inspectableElements([...routedNetFixture(), directTrace()], []);
    expect(physicalConnectivityPath(routed, "PAD1", "PAD2"))
      .toEqual(["PAD1", "PP1", "PT", "PP2", "PAD2"]);
    expect(unconnectedManufacturedEndpointIds(routed, "PAD1", "PAD2")).toEqual([]);
    expect(routed.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "proven",
      unit: "mm",
      lengthMm: 10,
      viaCount: 0,
      transitions: [],
    });

    const remoteTrace = directTrace();
    (remoteTrace.route as Array<Record<string, unknown>>)[1] = {
      route_type: "wire", x: 20, y: 0, width: 0.2, layer: "top", end_pcb_port_id: "PP2",
    };
    const remote = inspectableElements([...routedNetFixture(), remoteTrace], []);
    expect(physicalConnectivityPath(remote, "PAD1", "PAD2")).toBeUndefined();
    expect(unconnectedManufacturedEndpointIds(remote, "PAD1", "PAD2"))
      .toEqual(["PAD1", "PAD2"]);

    const duplicatePadFixture = routedNetFixture();
    duplicatePadFixture.push({
      ...duplicatePadFixture.find((element) => element.pcb_smtpad_id === "PAD1")!,
      pcb_smtpad_id: "PAD1_DUPLICATE",
    });
    const ambiguousEndpoint = inspectableElements(
      [...duplicatePadFixture, directTrace()],
      [],
    );
    expect(physicalConnectivityPath(ambiguousEndpoint, "PAD1", "PAD2")).toBeUndefined();
  });

  test("rejects wrong-net traces and layer changes without a validated via", () => {
    const wrongNetTrace = { ...directTrace(), source_trace_id: "ST_OTHER" };
    const wrongNet = inspectableElements([
      ...routedNetFixture(),
      { type: "source_port", source_port_id: "SP3" },
      { type: "source_port", source_port_id: "SP4" },
      { type: "source_trace", source_trace_id: "ST_OTHER", connected_source_port_ids: ["SP3", "SP4"], connected_source_net_ids: [] },
      wrongNetTrace,
    ], []);
    expect(physicalConnectivityPath(wrongNet, "PAD1", "PAD2")).toBeUndefined();

    const brokenLayerTrace = {
      ...directTrace(),
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "PP1" },
        { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "bottom", end_pcb_port_id: "PP2" },
      ],
    };
    const brokenLayer = inspectableElements([...routedNetFixture(), brokenLayerTrace], []);
    expect(physicalConnectivityPath(brokenLayer, "PAD1", "PAD2")).toBeUndefined();
  });

  test("rejects contradictory pad, PCB-port, and source ownership mappings", () => {
    const padOwnerFixture = routedNetFixture();
    padOwnerFixture.find((element) => element.pcb_smtpad_id === "PAD1")!
      .pcb_component_id = "PC2";
    const padOwner = inspectableElements([...padOwnerFixture, directTrace()], []);
    expect(physicalConnectivityPath(padOwner, "PAD1", "PAD2")).toBeUndefined();
    expect(unconnectedManufacturedEndpointIds(padOwner, "PAD1", "PAD2"))
      .toEqual(["PAD1", "PAD2"]);

    const portOwnerFixture = routedNetFixture();
    portOwnerFixture.find((element) => element.pcb_port_id === "PP1")!
      .pcb_component_id = "PC2";
    portOwnerFixture.find((element) => element.pcb_smtpad_id === "PAD1")!
      .pcb_component_id = "PC2";
    const portOwner = inspectableElements([...portOwnerFixture, directTrace()], []);
    expect(physicalConnectivityPath(portOwner, "PAD1", "PAD2")).toBeUndefined();

    const endpointTrace = directTrace();
    (endpointTrace.route as Array<Record<string, unknown>>)[0] = {
      route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top",
      start_pcb_port_id: "PP2",
    };
    const contradictoryEndpoint = inspectableElements(
      [...routedNetFixture(), endpointTrace],
      [],
    );
    expect(physicalConnectivityPath(contradictoryEndpoint, "PAD1", "PAD2"))
      .toBeUndefined();
  });

  test("requires an exact manufactured via record for a multilayer route", () => {
    const fixture = routedNetFixture();
    const pp2 = fixture.find((element) => element.pcb_port_id === "PP2")!;
    pp2.layers = ["bottom"];
    const pad2 = fixture.find((element) => element.pcb_smtpad_id === "PAD2")!;
    pad2.layer = "bottom";
    const trace = {
      ...directTrace(),
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "PP1" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: 5, y: 0, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "bottom", end_pcb_port_id: "PP2" },
      ],
    };
    const missing = inspectableElements([...fixture, trace], []);
    expect(physicalConnectivityPath(missing, "PAD1", "PAD2")).toBeUndefined();
    expect(missing.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "route lacks exact same-net endpoint, segment, or manufactured-via proof",
    });

    const wrongVia = {
      type: "pcb_via", pcb_via_id: "V", pcb_trace_id: "PT", x: 5, y: 0,
      from_layer: "top", to_layer: "inner1", layers: ["top", "inner1"],
      hole_diameter: 0.2, outer_diameter: 0.3,
    };
    const invalid = inspectableElements([...fixture, trace, wrongVia], []);
    expect(physicalConnectivityPath(invalid, "PAD1", "PAD2")).toBeUndefined();

    const nonManufacturableVia = {
      ...wrongVia,
      to_layer: "bottom",
      layers: ["top", "bottom"],
      hole_diameter: 0,
    };
    const zeroDiameter = inspectableElements([...fixture, trace, nonManufacturableVia], []);
    expect(physicalConnectivityPath(zeroDiameter, "PAD1", "PAD2")).toBeUndefined();

    const exactVia = {
      type: "pcb_via", pcb_via_id: "V", pcb_trace_id: "PT", x: 5, y: 0,
      from_layer: "top", to_layer: "bottom", layers: ["top", "bottom"],
      hole_diameter: 0.2, outer_diameter: 0.3,
    };
    const routed = inspectableElements([...fixture, trace, exactVia], []);
    expect(physicalConnectivityPath(routed, "PAD1", "PAD2"))
      .toEqual(["PAD1", "PP1", "PT", "PP2", "PAD2"]);
    expect(unconnectedManufacturedEndpointIds(routed, "PAD1", "PAD2")).toEqual([]);
    expect(routed.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "proven",
      unit: "mm",
      lengthMm: 11.6,
      viaCount: 1,
      transitions: [{
        viaId: "V",
        x: 5,
        y: 0,
        fromLayer: "top",
        toLayer: "bottom",
      }],
    });

    const extraOwnedVia = {
      ...exactVia,
      pcb_via_id: "V_EXTRA",
      x: 6,
    };
    const extra = inspectableElements([...fixture, trace, exactVia, extraOwnedVia], []);
    expect(extra.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "route lacks exact same-net endpoint, segment, or manufactured-via proof",
    });
    expect(physicalConnectivityPath(extra, "PAD1", "PAD2")).toBeUndefined();

    const missingBoard = inspectableElements([
      ...fixture.filter((element) => element.type !== "pcb_board"),
      trace,
      exactVia,
    ], []);
    expect(missingBoard.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "trace length requires one positive-thickness PCB board with a supported 2- or 4-layer stack",
    });
    const ambiguousBoard = inspectableElements([
      ...fixture,
      { type: "pcb_board", pcb_board_id: "BOARD_2", thickness: 1.6 },
      trace,
      exactVia,
    ], []);
    expect(ambiguousBoard.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "trace length requires one positive-thickness PCB board with a supported 2- or 4-layer stack",
    });
  });

  test("never proves full-board length or connectivity for partial via spans", () => {
    const fixtureFor = (lastLayer: string) => {
      const fixture = routedNetFixture();
      fixture.find((element) => element.type === "pcb_board")!.num_layers = 4;
      fixture.find((element) => element.pcb_port_id === "PP2")!.layers = [lastLayer];
      fixture.find((element) => element.pcb_smtpad_id === "PAD2")!.layer = lastLayer;
      return fixture;
    };
    const via = (
      id: string,
      x: number,
      fromLayer: string,
      toLayer: string,
    ) => ({
      type: "pcb_via", pcb_via_id: id, pcb_trace_id: "PT", x, y: 0,
      from_layer: fromLayer, to_layer: toLayer,
      layers: ["top", "inner1", "inner2", "bottom"],
      hole_diameter: 0.2, outer_diameter: 0.3,
    });

    const fullFixture = fixtureFor("bottom");
    const fullTrace = {
      ...directTrace(),
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "PP1" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: 5, y: 0, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "bottom", end_pcb_port_id: "PP2" },
      ],
    };
    const incompleteLayerSet = inspectableElements([
      ...fullFixture,
      fullTrace,
      { ...via("V_INCOMPLETE", 5, "top", "bottom"), layers: ["top", "bottom"] },
    ], []);
    expect(incompleteLayerSet.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "trace length requires every transition to use a qualified full-stack through via",
    });
    expect(physicalConnectivityPath(incompleteLayerSet, "PAD1", "PAD2")).toBeUndefined();
    const full = inspectableElements([...fullFixture, fullTrace, via("V", 5, "top", "bottom")], []);
    expect(full.find(({ id }) => id === "PT")?.traceMeasurement).toMatchObject({
      state: "proven", lengthMm: 11.6, viaCount: 1,
    });
    expect(physicalConnectivityPath(full, "PAD1", "PAD2")).toBeDefined();

    const partialFixture = fixtureFor("inner1");
    partialFixture.find((element) => element.pcb_port_id === "PP2")!.layers =
      ["top", "inner1", "inner2", "bottom"];
    const partialEndpoint = partialFixture.find((element) => element.pcb_smtpad_id === "PAD2")!;
    partialEndpoint.type = "pcb_plated_hole";
    partialEndpoint.pcb_plated_hole_id = partialEndpoint.pcb_smtpad_id;
    delete partialEndpoint.pcb_smtpad_id;
    delete partialEndpoint.layer;
    delete partialEndpoint.width;
    delete partialEndpoint.height;
    partialEndpoint.outer_diameter = 1;
    partialEndpoint.hole_diameter = 0.5;
    partialEndpoint.layers = ["top", "inner1", "inner2", "bottom"];
    partialEndpoint.shape = "circle";
    const partialTrace = {
      ...directTrace(),
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "PP1" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: 5, y: 0, from_layer: "top", to_layer: "inner1" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "inner1" },
        { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "inner1", end_pcb_port_id: "PP2" },
      ],
    };
    const partial = inspectableElements([
      ...partialFixture,
      partialTrace,
      via("V_PARTIAL", 5, "top", "inner1"),
    ], []);
    expect(partial.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "trace length requires every transition to use a qualified full-stack through via",
    });
    expect(physicalConnectivityPath(partial, "PAD1", "PAD2")).toBeUndefined();

    const twoSpanFixture = fixtureFor("bottom");
    const twoSpanTrace = {
      ...directTrace(),
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "PP1" },
        { route_type: "wire", x: 3, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: 3, y: 0, from_layer: "top", to_layer: "inner1" },
        { route_type: "wire", x: 3, y: 0, width: 0.2, layer: "inner1" },
        { route_type: "wire", x: 7, y: 0, width: 0.2, layer: "inner1" },
        { route_type: "via", x: 7, y: 0, from_layer: "inner1", to_layer: "bottom" },
        { route_type: "wire", x: 7, y: 0, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "bottom", end_pcb_port_id: "PP2" },
      ],
    };
    const twoSpan = inspectableElements([
      ...twoSpanFixture,
      twoSpanTrace,
      via("V_PARTIAL_1", 3, "top", "inner1"),
      via("V_PARTIAL_2", 7, "inner1", "bottom"),
    ], []);
    expect(twoSpan.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "trace length requires every transition to use a qualified full-stack through via",
    });
    expect(physicalConnectivityPath(twoSpan, "PAD1", "PAD2")).toBeUndefined();
  });

  test("requires a distinct manufactured via record for every route transition", () => {
    const fixture = routedNetFixture();
    fixture.find((element) => element.type === "pcb_board")!.num_layers = 4;
    fixture.find((element) => element.pcb_port_id === "PP2")!.layers = ["bottom"];
    fixture.find((element) => element.pcb_smtpad_id === "PAD2")!.layer = "bottom";
    const wire = (x: number, layer: string, endpoint: "start" | "end" | undefined = undefined) => ({
      route_type: "wire", x, y: 0, width: 0.2, layer,
      ...(endpoint === "start" ? { start_pcb_port_id: "PP1" } : {}),
      ...(endpoint === "end" ? { end_pcb_port_id: "PP2" } : {}),
    });
    const routeVia = (x: number, from_layer: string, to_layer: string) => ({
      route_type: "via", x, y: 0, from_layer, to_layer,
    });
    const manufacturedVia = (id: string, x: number, from_layer: string, to_layer: string) => ({
      type: "pcb_via", pcb_via_id: id, pcb_trace_id: "PT", x, y: 0,
      from_layer, to_layer, layers: ["top", "inner1", "inner2", "bottom"],
      hole_diameter: 0.2, outer_diameter: 0.3,
    });
    const sharedPrefix = [
      wire(0, "top", "start"), wire(2, "top"), routeVia(2, "top", "bottom"),
      wire(2, "bottom"), wire(5, "bottom"), routeVia(5, "bottom", "top"),
      wire(5, "top"),
    ];
    const vias = [
      manufacturedVia("V1", 2, "top", "bottom"),
      manufacturedVia("V2", 5, "bottom", "top"),
    ];
    const distinctTrace = {
      ...directTrace(),
      route: [
        ...sharedPrefix,
        wire(7, "top"), routeVia(7, "top", "bottom"),
        wire(7, "bottom"), wire(10, "bottom", "end"),
      ],
    };
    const distinct = inspectableElements([
      ...fixture,
      distinctTrace,
      ...vias,
      manufacturedVia("V3", 7, "top", "bottom"),
    ], []);
    expect(distinct.find(({ id }) => id === "PT")?.traceMeasurement).toMatchObject({
      state: "proven",
      lengthMm: 14.8,
      viaCount: 3,
      transitions: [{ viaId: "V1" }, { viaId: "V2" }, { viaId: "V3" }],
    });
    expect(physicalConnectivityPath(distinct, "PAD1", "PAD2")).toBeDefined();

    const reusedTrace = {
      ...directTrace(),
      route: [
        ...sharedPrefix,
        wire(2, "top"), routeVia(2, "top", "bottom"),
        wire(2, "bottom"), wire(10, "bottom", "end"),
      ],
    };
    const reused = inspectableElements([...fixture, reusedTrace, ...vias], []);
    expect(reused.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "route lacks exact same-net endpoint, segment, or manufactured-via proof",
    });
    expect(physicalConnectivityPath(reused, "PAD1", "PAD2")).toBeUndefined();
  });

  test("requires every proven wire and endpoint layer to exist in the board stack", () => {
    const sameLayerFixture = (
      numLayers: 2 | 4,
      layer: string,
      endpointTechnology: "smt" | "pth" = "smt",
    ) => {
      const fixture = routedNetFixture();
      fixture.find((element) => element.type === "pcb_board")!.num_layers = numLayers;
      for (const portId of ["PP1", "PP2"]) {
        fixture.find((element) => element.pcb_port_id === portId)!.layers =
          endpointTechnology === "pth"
            ? ["top", "inner1", "inner2", "bottom"]
            : [layer];
      }
      for (const padId of ["PAD1", "PAD2"]) {
        const pad = fixture.find((element) => element.pcb_smtpad_id === padId)!;
        if (endpointTechnology === "smt") {
          pad.layer = layer;
        } else {
          pad.type = "pcb_plated_hole";
          pad.pcb_plated_hole_id = pad.pcb_smtpad_id;
          delete pad.pcb_smtpad_id;
          delete pad.layer;
          delete pad.width;
          delete pad.height;
          pad.outer_diameter = 1;
          pad.hole_diameter = 0.5;
          pad.layers = ["top", "inner1", "inner2", "bottom"];
          pad.shape = "circle";
        }
      }
      const trace = directTrace();
      for (const entry of trace.route as Array<Record<string, unknown>>) entry.layer = layer;
      return [...fixture, trace];
    };
    const invalidInner = inspectableElements(sameLayerFixture(2, "inner1"), []);
    expect(invalidInner.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "invalid",
      unit: "mm",
      reason: "route lacks exact same-net endpoint, segment, or manufactured-via proof",
    });
    expect(physicalConnectivityPath(invalidInner, "PAD1", "PAD2")).toBeUndefined();
    const invalidFourLayerSmt = inspectableElements(sameLayerFixture(4, "inner1"), []);
    expect(invalidFourLayerSmt.find(({ id }) => id === "PT")?.traceMeasurement?.state)
      .toBe("invalid");
    expect(physicalConnectivityPath(invalidFourLayerSmt, "PAD1", "PAD2")).toBeUndefined();

    for (const layers of [2, 4] as const) {
      const arbitrary = inspectableElements(sameLayerFixture(layers, "signal42"), []);
      expect(arbitrary.find(({ id }) => id === "PT")?.traceMeasurement?.state).toBe("invalid");
      expect(physicalConnectivityPath(arbitrary, "PAD1", "PAD2")).toBeUndefined();
    }

    const validInner = inspectableElements(sameLayerFixture(4, "inner1", "pth"), []);
    expect(validInner.find(({ id }) => id === "PT")?.traceMeasurement).toEqual({
      state: "proven",
      unit: "mm",
      lengthMm: 10,
      viaCount: 0,
      transitions: [],
    });
    expect(physicalConnectivityPath(validInner, "PAD1", "PAD2")).toBeDefined();

    for (const [holeDiameter, outerDiameter] of [[0, 1], [2, 1]] as const) {
      const malformedFixture = sameLayerFixture(4, "inner1", "pth");
      const malformedPad = malformedFixture.find((element) =>
        element.pcb_plated_hole_id === "PAD1"
      )!;
      malformedPad.hole_diameter = holeDiameter;
      malformedPad.outer_diameter = outerDiameter;
      const malformed = inspectableElements(malformedFixture, []);
      expect(malformed.find(({ id }) => id === "PAD1")?.manufacturedPinMapping?.state)
        .toBe("invalid");
      expect(malformed.find(({ id }) => id === "PT")?.traceMeasurement?.state)
        .toBe("invalid");
      expect(physicalConnectivityPath(malformed, "PAD1", "PAD2")).toBeUndefined();
    }
  });
});
