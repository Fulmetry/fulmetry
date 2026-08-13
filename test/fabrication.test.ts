import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "@pcboo/pcboo/authoring";
import {
  MAX_FABRICATION_PAIRWISE_FEATURES,
  MAX_FABRICATION_LOGICAL_REFERENCES,
  assessCircuitFabrication,
  fabricationWorkloadOverflow,
} from "../src/fabrication";
import {
  assessBaselineGeometry,
  baselineGeometryWorkload,
} from "../src/fabrication-geometry";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import { manufacturingFixture } from "./fixtures/manufacturing";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";

function clone(elements: readonly AnyCircuitElement[]): AnyCircuitElement[] {
  return structuredClone(elements) as AnyCircuitElement[];
}

function codes(elements: readonly AnyCircuitElement[]): string[] {
  return assessCircuitFabrication(elements, BASELINE_FABRICATION_PROFILE)
    .diagnostics.map(({ id }) => String(id));
}

type ClearanceShape = "circle" | "rect" | "segment";

function geometryBoundaryBoard(): AnyCircuitElement {
  return {
    type: "pcb_board",
    pcb_board_id: "boundary-board",
    source_board_id: "boundary-source-board",
    center: { x: 0, y: 0 },
    width: 100,
    height: 100,
    thickness: 1.6,
    num_layers: 2,
    material: "fr4",
  } as AnyCircuitElement;
}

function boundaryCopperFeature(
  shape: ClearanceShape,
  id: string,
  x: number,
): AnyCircuitElement {
  if (shape === "circle") {
    return {
      type: "pcb_via",
      pcb_via_id: id,
      x,
      y: 0,
      hole_diameter: 0.2,
      outer_diameter: 1,
      from_layer: "top",
      to_layer: "bottom",
      layers: ["top"],
      source_net_id: `net-${id}`,
    } as AnyCircuitElement;
  }
  if (shape === "rect") {
    return {
      type: "pcb_smtpad",
      pcb_smtpad_id: id,
      pcb_port_id: `port-${id}`,
      x,
      y: 0,
      width: 1,
      height: 1,
      shape: "rect",
      layer: "top",
      is_covered_with_solder_mask: true,
    } as AnyCircuitElement;
  }
  return {
    type: "pcb_trace",
    pcb_trace_id: id,
    source_trace_id: `source-${id}`,
    route: [
      { route_type: "wire", x, y: -0.5, width: 0.2, layer: "top" },
      { route_type: "wire", x, y: 0.5, width: 0.2, layer: "top" },
    ],
  } as AnyCircuitElement;
}

function boundaryCenterDistance(left: ClearanceShape, right: ClearanceShape): number {
  const radius = (shape: ClearanceShape): number => shape === "segment" ? 0.1 : 0.5;
  return radius(left) + BASELINE_FABRICATION_PROFILE.minimumCopperClearanceMm + radius(right);
}

describe("baseline fabrication profile", () => {
  test("accepts only the board substrate qualified by the active profile", async () => {
    for (const material of ["", "mystery-substrate"]) {
      const fixture = clone(await manufacturingFixture(4));
      const board = fixture.find((element) => element.type === "pcb_board");
      if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
      (board as unknown as { material: string }).material = material;

      const assessment = assessCircuitFabrication(
        fixture,
        BASELINE_FABRICATION_PROFILE,
      );
      expect(assessment.status.state, JSON.stringify(material)).toBe("failed");
      expect(assessment.diagnostics, JSON.stringify(material)).toContainEqual(
        expect.objectContaining({
          id: "FAB_BOARD_MATERIAL_001",
          waiverPolicy: "forbidden",
          objects: [`${board.pcb_board_id}.material:${JSON.stringify(material)}`],
          evidence: expect.arrayContaining([
            `profile:${BASELINE_FABRICATION_PROFILE.digest}`,
            "supported-board-materials:fr4",
          ]),
        }),
      );
    }

    const qualified = clone(await manufacturingFixture(4));
    const board = qualified.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
    expect(board.material).toBe("fr4");
    const assessment = assessCircuitFabrication(
      qualified,
      BASELINE_FABRICATION_PROFILE,
    );
    expect(assessment.status.state).toBe("passed");
    expect(assessment.diagnostics.map(({ id }) => String(id)))
      .not.toContain("FAB_BOARD_MATERIAL_001");
  });

  test("requires a finite strictly positive physical board thickness", async () => {
    for (const thickness of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fixture = clone(await manufacturingFixture(4));
      const board = fixture.find((element) => element.type === "pcb_board");
      if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
      board.thickness = thickness;

      const assessment = assessCircuitFabrication(
        fixture,
        BASELINE_FABRICATION_PROFILE,
      );
      expect(assessment.status.state, String(thickness)).toBe("failed");
      expect(assessment.diagnostics, String(thickness)).toContainEqual(
        expect.objectContaining({
          id: "FAB_DIMENSION_001",
          waiverPolicy: "forbidden",
          objects: expect.arrayContaining([board.pcb_board_id]),
        }),
      );
    }

    const positive = clone(await manufacturingFixture(4));
    const board = positive.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
    board.thickness = 0.001;
    expect(codes(positive)).not.toContain("FAB_DIMENSION_001");
  });

  test("fails before geometry work when the qualified feature envelope is exceeded", async () => {
    const components = Array.from(
      { length: MAX_FABRICATION_PAIRWISE_FEATURES + 1 },
      (_, index) => ({
        type: "pcb_component",
        pcb_component_id: `resource-component-${index}`,
        source_component_id: `resource-source-${index}`,
        width: 1,
        height: 1,
        center: { x: index, y: 0 },
        rotation: 0,
        layer: "top",
      }),
    ) as AnyCircuitElement[];

    const assessment = assessCircuitFabrication(
      components,
      BASELINE_FABRICATION_PROFILE,
    );

    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics).toHaveLength(1);
    expect(assessment.diagnostics[0]).toMatchObject({
      id: "FAB_RESOURCE_LIMIT_001",
      waiverPolicy: "forbidden",
      objects: [
        `pairwise-features:${MAX_FABRICATION_PAIRWISE_FEATURES + 1}:limit:${MAX_FABRICATION_PAIRWISE_FEATURES}:excess:1`,
      ],
    });
  });

  test("bounds retained pair findings without allowing an overlap pass", async () => {
    const fixture = clone(await manufacturingFixture(2));
    const board = fixture.find((element) => element.type === "pcb_board");
    const pad = fixture.find((element) => element.type === "pcb_smtpad");
    if (board?.type !== "pcb_board" || pad?.type !== "pcb_smtpad") {
      throw new Error("Board or SMT pad fixture missing");
    }
    const pads = Array.from({ length: 300 }, (_, index) => ({
      ...pad,
      pcb_smtpad_id: `overlap-pad-${index}`,
      pcb_port_id: `overlap-port-${index}`,
    }));

    const geometry = assessBaselineGeometry(
      [board, ...pads] as AnyCircuitElement[],
      BASELINE_FABRICATION_PROFILE,
    );

    expect(geometry.copperClearance).toHaveLength(256);
    expect(geometry.copperClearance.some((finding) =>
      finding.includes("additional-findings-omitted-at-least")
    )).toBe(true);
  });

  test("counts emitted wire geometry exactly and enforces route and layer boundaries", () => {
    const wireRoute = Array.from({ length: 2_050 }, (_, index) => ({
      route_type: "wire",
      x: index,
      y: 0,
      width: 0.2,
      layer: "top",
    }));
    const trace = {
      type: "pcb_trace",
      pcb_trace_id: "counted-trace",
      route: wireRoute,
    } as AnyCircuitElement;
    expect(baselineGeometryWorkload([trace]).copperFeatures).toBe(2_049);
    expect(fabricationWorkloadOverflow([trace])).toEqual([]);

    const routeBoundary = {
      ...trace,
      route: Array.from({ length: 8_192 }, () => ({ route_type: "via" })),
    } as AnyCircuitElement;
    expect(fabricationWorkloadOverflow([routeBoundary])).toEqual([]);
    const routeOver = {
      ...routeBoundary,
      route: [...(routeBoundary as Extract<AnyCircuitElement, { type: "pcb_trace" }>).route, {
        route_type: "via",
      }],
    } as AnyCircuitElement;
    expect(fabricationWorkloadOverflow([routeOver])).toContain(
      "route-points:8193:limit:8192:excess:1",
    );

    const layerBoundary = {
      type: "pcb_port",
      pcb_port_id: "layer-boundary",
      layers: Array.from({ length: 8_192 }, () => "top"),
    } as AnyCircuitElement;
    expect(fabricationWorkloadOverflow([layerBoundary])).toEqual([]);
    (layerBoundary as unknown as { layers: string[] }).layers.push("top");
    expect(fabricationWorkloadOverflow([layerBoundary])).toContain(
      "layer-references:8193:limit:8192:excess:1",
    );

    const logicalOver = {
      type: "source_trace",
      source_trace_id: "logical-over",
      connected_source_port_ids: Array.from(
        { length: MAX_FABRICATION_LOGICAL_REFERENCES + 1 },
        (_, index) => `source-port-${index}`,
      ),
      connected_source_net_ids: [],
    } as AnyCircuitElement;
    expect(fabricationWorkloadOverflow([logicalOver])).toContain(
      "logical-references:8193:limit:8192:excess:1",
    );
  });

  test("warns prominently when a manufactured component still has a temporary compiler name", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "D1",
    );
    if (source?.type !== "source_component") throw new Error("D1 source fixture missing");
    source.name = "unnamed_led1";

    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.find(
      ({ id }) => String(id) === "FAB_TEMPORARY_COMPONENT_NAME_001",
    )).toMatchObject({
      severity: "warning",
      waiverPolicy: "forbidden",
      objects: ["pcb_component_1.reference"],
    });
  });

  test("is required before dimensional checks can be called fabrication-passing", async () => {
    const assessment = assessCircuitFabrication(await manufacturingFixture(2));
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain(
      "FAB_PROFILE_REQUIRED_001",
    );
  });

  test("fails zero or multiple boards with an explicit non-waivable board-count rule", async () => {
    const fixture = clone(await manufacturingFixture(2));
    const withoutBoard = fixture.filter((element) => element.type !== "pcb_board");
    const board = fixture.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
    for (const candidate of [withoutBoard, [...fixture, { ...board, pcb_board_id: "pcb_board_2" }]]) {
      const assessment = assessCircuitFabrication(candidate as AnyCircuitElement[], BASELINE_FABRICATION_PROFILE);
      expect(assessment.status.state).toBe("failed");
      const diagnostic = assessment.diagnostics.find(({ id }) => String(id) === "FAB_BOARD_COUNT_001");
      expect(diagnostic?.waiverPolicy).toBe("forbidden");
    }
  });

  test("fails duplicate or detached authored source-board definitions", async () => {
    const fixture = clone(await manufacturingFixture(2));
    const sourceBoard = fixture.find((element) => element.type === "source_board");
    if (sourceBoard?.type !== "source_board") throw new Error("Fixture source board missing");
    const board = fixture.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture PCB board missing");
    const candidates = [
      [...fixture, { ...sourceBoard, source_board_id: "source_board_duplicate" }],
      fixture.map((element) => element.type === "pcb_board"
        ? { ...element, source_board_id: "source_board_detached" }
        : element),
    ];
    for (const candidate of candidates) {
      const assessment = assessCircuitFabrication(
        candidate as AnyCircuitElement[],
        BASELINE_FABRICATION_PROFILE,
      );
      expect(assessment.status.state).toBe("failed");
      const diagnostic = assessment.diagnostics.find(
        ({ id }) => String(id) === "FAB_BOARD_STRUCTURE_001",
      );
      expect(diagnostic?.waiverPolicy).toBe("forbidden");
    }
  });

  test("fails orphaned or multiply mapped authored components", async () => {
    const orphaned = clone(await manufacturingFixture(2));
    const source = orphaned.find(
      (element) => element.type === "source_component" && element.name === "D1",
    );
    if (source?.type !== "source_component") throw new Error("D1 source fixture missing");
    orphaned.push({
      ...source,
      source_component_id: "source_component_orphan",
      name: "D_ORPHAN",
    });

    const duplicated = clone(await manufacturingFixture(2));
    const pcb = duplicated.find(
      (element) => element.type === "pcb_component" &&
        element.source_component_id === source.source_component_id,
    );
    if (pcb?.type !== "pcb_component") throw new Error("D1 PCB fixture missing");
    duplicated.push({ ...pcb, pcb_component_id: "pcb_component_duplicate" });

    for (const candidate of [orphaned, duplicated]) {
      const assessment = assessCircuitFabrication(candidate, BASELINE_FABRICATION_PROFILE);
      expect(assessment.status.state).toBe("failed");
      expect(assessment.diagnostics).toContainEqual(expect.objectContaining({
        id: "FAB_COMPONENT_MAPPING_001",
        waiverPolicy: "forbidden",
      }));
    }
  });

  test("fails physical component pins whose authored source-port authority disappeared", async () => {
    const removed = new Set(["source_port_1", "source_port_3"]);
    const attacked = (await manufacturingFixture(4)).filter((element) =>
      !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
      !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "source_port" && removed.has(element.source_port_id)) &&
      !(element.type === "schematic_port" && removed.has(element.source_port_id))
    );
    const assessment = assessCircuitFabrication(attacked, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.find(({ id }) => id === "FAB_CONNECTIVITY_001")?.objects)
      .toEqual(expect.arrayContaining([
        "pcb_port_1:source-port-count:0",
        "pcb_port_3:source-port-count:0",
      ]));
  });

  test("reports a manufactured element's primary id rather than a foreign reference id", async () => {
    const fixture = clone(await manufacturingFixture(2));
    const traceIndex = fixture.findIndex((element) => element.type === "pcb_trace");
    const trace = fixture[traceIndex];
    if (trace?.type !== "pcb_trace") throw new Error("Fixture trace missing");
    const route = structuredClone(trace.route);
    const wire = route.find((point) => point.route_type === "wire");
    if (wire?.route_type !== "wire") throw new Error("Fixture wire missing");
    wire.width = 0;
    const {
      type: _type,
      source_trace_id: _sourceTraceId,
      pcb_trace_id: _pcbTraceId,
      route: _route,
      ...traceFields
    } = trace;
    fixture[traceIndex] = {
      type: "pcb_trace",
      source_trace_id: trace.source_trace_id,
      pcb_trace_id: trace.pcb_trace_id,
      ...traceFields,
      route,
    } as AnyCircuitElement;
    const diagnostic = assessCircuitFabrication(fixture, BASELINE_FABRICATION_PROFILE)
      .diagnostics.find(({ id }) => String(id) === "FAB_DIMENSION_001");
    expect(diagnostic?.objects).toContain(trace.pcb_trace_id);
    expect(diagnostic?.objects).not.toContain(trace.source_trace_id);
  });

  test.each([
    [0.149, "failed"],
    [0.15, "passed"],
    [0.151, "passed"],
  ] as const)("checks trace width boundary at %f mm", async (width, state) => {
    const circuitJson = clone(await manufacturingFixture(2));
    for (const sourceTrace of circuitJson.filter((element) => element.type === "source_trace")) {
      sourceTrace.min_trace_thickness = 0.1;
    }
    for (const trace of circuitJson.filter((element) => element.type === "pcb_trace")) {
      for (const point of trace.route) {
        if (point.route_type === "wire") point.width = width;
      }
    }
    expect(assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE).status.state)
      .toBe(state);
  });

  test.each([
    [0.20000001, "failed"],
    [0.2, "passed"],
    [0.19999999, "passed"],
  ] as const)("checks authored minimum trace thickness boundary at %f mm", async (minimum, state) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const sourceTrace = circuitJson.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    if (sourceTrace?.type !== "source_trace") throw new Error("Fixture source trace missing");
    sourceTrace.min_trace_thickness = minimum;
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe(state);
    expect(assessment.diagnostics.map(({ id }) => String(id)).includes("FAB_ROUTE_CONSTRAINT_001"))
      .toBe(state === "failed");
  });

  test.each([
    [-0.00000001, "failed"],
    [0, "passed"],
    [0.00000001, "passed"],
  ] as const)("checks authored maximum trace length boundary offset at %f mm", async (offset, state) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const sourceTrace = circuitJson.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    const pcbTrace = circuitJson.find(
      (element) => element.type === "pcb_trace" && element.source_trace_id === "source_trace_2",
    );
    const board = circuitJson.find((element) => element.type === "pcb_board");
    if (
      sourceTrace?.type !== "source_trace" ||
      pcbTrace?.type !== "pcb_trace" ||
      board?.type !== "pcb_board"
    ) {
      throw new Error("Fixture trace constraint authority missing");
    }
    let measuredLength = 0;
    for (let index = 0; index < pcbTrace.route.length - 1; index += 1) {
      const start = pcbTrace.route[index]!;
      const end = pcbTrace.route[index + 1]!;
      if (!("x" in start) || !("x" in end)) throw new Error("Fixture route is not measurable");
      measuredLength += Math.hypot(end.x - start.x, end.y - start.y);
    }
    measuredLength += pcbTrace.route.filter((point) => point.route_type === "via").length *
      board.thickness;
    sourceTrace.max_length = measuredLength + offset;
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe(state);
    expect(assessment.diagnostics.map(({ id }) => String(id)).includes("FAB_ROUTE_CONSTRAINT_001"))
      .toBe(state === "failed");
  });

  test.each([
    ["standalone-via", 0.19999999, "failed"],
    ["standalone-via", 0.2, "passed"],
    ["standalone-via", 0.20000001, "passed"],
    ["plated-hole", 0.19999999, "failed"],
    ["plated-hole", 0.2, "passed"],
    ["plated-hole", 0.20000001, "passed"],
    ["non-plated-hole", 0.19999999, "failed"],
    ["non-plated-hole", 0.2, "passed"],
    ["non-plated-hole", 0.20000001, "passed"],
    ["route-via", 0.19999999, "failed"],
    ["route-via", 0.2, "passed"],
    ["route-via", 0.20000001, "passed"],
  ] as const)("checks %s minimum-drill boundary at %f mm", async (kind, diameter, state) => {
    const circuitJson = clone(await manufacturingFixture(2));
    if (kind === "standalone-via") {
      const via = circuitJson.find((element) => element.type === "pcb_via");
      if (via?.type !== "pcb_via") throw new Error("Fixture standalone via missing");
      via.hole_diameter = diameter;
      via.outer_diameter = 0.4;
    } else if (kind === "plated-hole") {
      const hole = circuitJson.find(
        (element) => element.type === "pcb_plated_hole" && element.shape === "circle",
      );
      if (hole?.type !== "pcb_plated_hole" || hole.shape !== "circle") {
        throw new Error("Fixture plated hole missing");
      }
      hole.hole_diameter = diameter;
    } else if (kind === "non-plated-hole") {
      const hole = circuitJson.find(
        (element) => element.type === "pcb_hole" && element.hole_shape === "circle",
      );
      if (hole?.type !== "pcb_hole" || hole.hole_shape !== "circle") {
        throw new Error("Fixture non-plated hole missing");
      }
      hole.hole_diameter = diameter;
    } else {
      const trace = circuitJson.find(
        (element) => element.type === "pcb_trace" &&
          element.route.some((point) => point.route_type === "via"),
      );
      if (trace?.type !== "pcb_trace") throw new Error("Fixture route via missing");
      const routeVia = trace.route.find((point) => point.route_type === "via");
      if (routeVia?.route_type !== "via") throw new Error("Fixture route via missing");
      routeVia.hole_diameter = diameter;
      routeVia.outer_diameter = 0.4;
    }
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe(state);
    expect(assessment.diagnostics.some(({ id }) => id === "FAB_PROFILE_MINIMUM_001"))
      .toBe(state === "failed");
  });

  test("fails invalid constraints and remains incomplete when constrained geometry is unmeasurable", async () => {
    const invalid = clone(await manufacturingFixture(2));
    const invalidSource = invalid.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    if (invalidSource?.type !== "source_trace") throw new Error("Fixture source trace missing");
    invalidSource.min_trace_thickness = 0;
    invalidSource.max_length = Number.NaN;
    expect(codes(invalid)).toContain("FAB_ROUTE_CONSTRAINT_001");

    const unmeasurable = clone(await manufacturingFixture(2));
    const constrained = unmeasurable.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    const physical = unmeasurable.find(
      (element) => element.type === "pcb_trace" && element.source_trace_id === "source_trace_2",
    );
    if (constrained?.type !== "source_trace" || physical?.type !== "pcb_trace") {
      throw new Error("Fixture trace constraint authority missing");
    }
    constrained.max_length = 100;
    physical.route = physical.route.slice(0, 1);
    expect(codes(unmeasurable)).toContain("FAB_ROUTE_CONSTRAINT_UNSUPPORTED_001");
  });

  test("does not qualify maximum length through a laterally displaced through-pad transition", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const sourceTrace = circuitJson.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_0",
    );
    const pcbTrace = circuitJson.find(
      (element) => element.type === "pcb_trace" && element.pcb_trace_id === "source_net_0_0",
    );
    const holes = circuitJson.filter((element) => element.type === "pcb_plated_hole")
      .sort((left, right) => left.x - right.x);
    if (
      sourceTrace?.type !== "source_trace" ||
      pcbTrace?.type !== "pcb_trace" ||
      holes.length !== 2
    ) throw new Error("Fixture through-pad route authority missing");
    const start = holes[0]!;
    const end = holes[1]!;
    sourceTrace.max_length = 100;
    pcbTrace.route = [
      {
        route_type: "wire",
        x: start.x,
        y: start.y,
        width: 0.2,
        layer: "top",
        start_pcb_port_id: start.pcb_port_id,
      },
      {
        route_type: "through_pad",
        start: { x: start.x, y: start.y },
        end: { x: start.x + 0.7, y: start.y },
        width: 0.2,
        start_layer: "top",
        end_layer: "bottom",
        pcb_plated_hole_id: start.pcb_plated_hole_id,
      },
      {
        route_type: "wire",
        x: start.x + 0.7,
        y: start.y,
        width: 0.2,
        layer: "bottom",
      },
      {
        route_type: "wire",
        x: end.x,
        y: end.y,
        width: 0.2,
        layer: "bottom",
        end_pcb_port_id: end.pcb_port_id,
      },
    ];
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics).toContainEqual(expect.objectContaining({
      id: "FAB_ROUTE_CONSTRAINT_UNSUPPORTED_001",
      waiverPolicy: "forbidden",
    }));
  });

  test.each([
    [0.399, "failed"],
    [0.4, "passed"],
    [0.401, "passed"],
  ] as const)("checks annular-ring boundary with %f mm outer diameter", async (outer, state) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const via = circuitJson.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_0",
    );
    if (via?.type !== "pcb_via") throw new Error("Fixture standalone via missing");
    via.hole_diameter = 0.3;
    via.outer_diameter = outer;
    expect(assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE).status.state)
      .toBe(state);
  });

  test.each([
    [1.099, "failed"],
    [1.1, "passed"],
    [1.101, "passed"],
  ] as const)("checks copper-clearance boundary at center spacing %f mm", async (x, state) => {
    const full = clone(await manufacturingFixture(2));
    const board = full.find((element) => element.type === "pcb_board");
    const sourceBoard = full.find((element) => element.type === "source_board");
    const via = full.find((element) => element.type === "pcb_via");
    if (
      sourceBoard?.type !== "source_board" ||
      board?.type !== "pcb_board" ||
      via?.type !== "pcb_via"
    ) {
      throw new Error("Fixture source board, PCB board, or via missing");
    }
    const isolatedVia = (id: string, centerX: number): AnyCircuitElement => {
      const value = {
        ...via,
        pcb_via_id: id,
        x: centerX,
        y: 0,
        hole_diameter: 0.3,
        outer_diameter: 0.9,
      } as unknown as Record<string, unknown>;
      delete value.pcb_trace_id;
      delete value.subcircuit_connectivity_map_key;
      return value as unknown as AnyCircuitElement;
    };
    const circuitJson = [
      sourceBoard,
      board,
      isolatedVia("clearance_a", 0),
      isolatedVia("clearance_b", x),
    ];
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe(state);
    if (state === "failed") expect(codes(circuitJson)).toContain("FAB_COPPER_CLEARANCE_001");
  });

  test.each([
    ["circle", "circle"],
    ["circle", "rect"],
    ["circle", "segment"],
    ["rect", "rect"],
    ["rect", "segment"],
    ["segment", "segment"],
  ] as const)("checks %s-to-%s copper-clearance immediately below, at, and above tolerance", (left, right) => {
    const exact = boundaryCenterDistance(left, right);
    for (const [offset, violates] of [[-2e-9, true], [0, false], [2e-9, false]] as const) {
      const assessment = assessBaselineGeometry([
        geometryBoundaryBoard(),
        boundaryCopperFeature(left, "left", 0),
        boundaryCopperFeature(right, "right", exact + offset),
      ], BASELINE_FABRICATION_PROFILE);
      expect(assessment.copperClearance.length > 0, `${left}/${right} offset ${offset}`)
        .toBe(violates);
    }
  });

  test.each([
    ["circle", 0.5],
    ["rect", 0.5],
    ["segment", 0.1],
  ] as const)("checks %s copper-to-edge immediately below, at, and above tolerance", (shape, radius) => {
    const exactX = 50 - radius - BASELINE_FABRICATION_PROFILE.minimumCopperEdgeClearanceMm;
    for (const [offset, violates] of [[2e-9, true], [0, false], [-2e-9, false]] as const) {
      const assessment = assessBaselineGeometry([
        geometryBoundaryBoard(),
        boundaryCopperFeature(shape, "edge-feature", exactX + offset),
      ], BASELINE_FABRICATION_PROFILE);
      expect(assessment.edgeClearance.length > 0, `${shape} offset ${offset}`).toBe(violates);
    }
  });

  test("checks a mechanical hole immediately below, at, and above edge clearance", () => {
    const exactX = 50 - 0.5 - BASELINE_FABRICATION_PROFILE.minimumCopperEdgeClearanceMm;
    for (const [offset, violates] of [[2e-9, true], [0, false], [-2e-9, false]] as const) {
      const hole = {
        type: "pcb_hole",
        pcb_hole_id: "edge-hole",
        x: exactX + offset,
        y: 0,
        hole_shape: "circle",
        hole_diameter: 1,
      } as AnyCircuitElement;
      const assessment = assessBaselineGeometry(
        [geometryBoundaryBoard(), hole],
        BASELINE_FABRICATION_PROFILE,
      );
      expect(assessment.edgeClearance.length > 0, `hole offset ${offset}`).toBe(violates);
    }
  });

  test.each([
    [9.651, "failed"],
    [9.65, "passed"],
    [9.649, "passed"],
  ] as const)("checks copper-to-edge boundary at x=%f mm", async (x, state) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const via = circuitJson.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_0",
    );
    if (via?.type !== "pcb_via") throw new Error("Fixture standalone via missing");
    via.x = x;
    via.y = -4;
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe(state);
    if (state === "failed") expect(codes(circuitJson)).toContain("FAB_BOARD_EDGE_001");
  });

  test.each([
    [0.899, true],
    [0.9, false],
    [0.901, false],
  ] as const)("checks same-net mask-sliver boundary at pad spacing %f mm", async (spacing, violatesMaskSliver) => {
    const circuitJson = clone(await manufacturingFixture(2)).filter((element) => [
      "source_board",
      "pcb_board",
      "source_port",
      "pcb_port",
      "pcb_smtpad",
    ].includes(element.type));
    const pads = circuitJson.filter(
      (element) => element.type === "pcb_smtpad" && element.shape === "rect",
    ).slice(0, 2);
    const ports = circuitJson.filter((element) => element.type === "source_port").slice(0, 2);
    if (pads.length !== 2 || ports.length !== 2) throw new Error("Fixture pad pair missing");
    delete pads[0]!.pcb_component_id;
    delete pads[1]!.pcb_component_id;
    const selectedPcbPortIds = new Set(pads.map((pad) => pad.pcb_port_id));
    const selectedSourcePortIds = new Set(ports.map((port) => port.source_port_id));
    circuitJson.splice(0, circuitJson.length, ...circuitJson.filter((element) =>
      element.type === "source_board" || element.type === "pcb_board" ||
      pads.includes(element as typeof pads[number]) ||
      (element.type === "pcb_port" && selectedPcbPortIds.has(element.pcb_port_id)) ||
      (element.type === "source_port" && selectedSourcePortIds.has(element.source_port_id))
    ));
    pads[0]!.x = 0;
    pads[0]!.y = 0;
    pads[1]!.x = spacing;
    pads[1]!.y = 0;
    circuitJson.push({
      type: "source_trace",
      source_trace_id: "mask_boundary_net",
      connected_source_port_ids: [ports[0]!.source_port_id, ports[1]!.source_port_id],
      connected_source_net_ids: [],
    } as AnyCircuitElement);
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.diagnostics.some(
      ({ id }) => String(id) === "FAB_MASK_SLIVER_001",
    )).toBe(violatesMaskSliver);
  });

  test("rejects a same-layer cross-net short even when trace endpoints still land on pads", async () => {
    const circuitJson = clone(await manufacturingFixture(4));
    const trace = circuitJson.find(
      (element) => element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0",
    );
    if (trace?.type !== "pcb_trace") throw new Error("Fixture trace missing");
    const attackedPoint = trace.route.find(
      (point) => point.route_type === "wire" && point.layer === "bottom" &&
        point.x === 0 && point.y === 1.175,
    );
    if (attackedPoint?.route_type !== "wire") throw new Error("Fixture attack point missing");
    attackedPoint.x = 6;
    attackedPoint.y = 6;
    expect(codes(circuitJson)).toContain("FAB_COPPER_CLEARANCE_001");
  });

  test("does not let a coordinated logical-key collision hide a cross-net short", async () => {
    const circuitJson = clone(await manufacturingFixture(4));
    const physical = circuitJson.find(
      (element) => element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0",
    );
    const attackedPoint = physical?.type === "pcb_trace"
      ? physical.route.find(
        (point) => point.route_type === "wire" && point.layer === "bottom" &&
          point.x === 0 && point.y === 1.175,
      )
      : undefined;
    const left = circuitJson.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    const right = circuitJson.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_3",
    );
    if (
      attackedPoint?.route_type !== "wire" || left?.type !== "source_trace" ||
      right?.type !== "source_trace"
    ) throw new Error("Fixture collision attack records missing");
    attackedPoint.x = 6;
    attackedPoint.y = 6;
    const collidedKey = left.subcircuit_connectivity_map_key;
    right.subcircuit_connectivity_map_key = collidedKey;
    for (const element of circuitJson) {
      if (element.type === "source_port" && right.connected_source_port_ids.includes(element.source_port_id)) {
        element.subcircuit_connectivity_map_key = collidedKey;
      }
      if (element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_1") {
        element.subcircuit_connectivity_map_key = collidedKey;
      }
    }
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("failed");
    const diagnosticIds = assessment.diagnostics.map(({ id }) => String(id));
    expect(diagnosticIds).toContain("FAB_NET_IDENTITY_001");
    expect(diagnosticIds).toContain("FAB_COPPER_CLEARANCE_001");

    const withoutProfile = assessCircuitFabrication(circuitJson);
    expect(withoutProfile.status.state).toBe("failed");
    const identity = withoutProfile.diagnostics.find(
      ({ id }) => String(id) === "FAB_NET_IDENTITY_001",
    );
    expect(identity?.evidence).toContainEqual(expect.stringContaining("circuit-json:"));
  });

  test("rejects removal of a complete logical and physical connection", async () => {
    const circuitJson = (await manufacturingFixture(4)).filter(
      (element) =>
        !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
        !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
        !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0"),
    );
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("failed");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain("FAB_CONNECTIVITY_001");
  });

  test("rejects a zero-port bridge that aliases distinct named nets", async () => {
    const circuitJson = clone(await manufacturingFixture(4));
    const original = circuitJson.find((element) => element.type === "source_net");
    if (original?.type !== "source_net") throw new Error("Fixture source net missing");
    circuitJson.push(
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
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("failed");
    const identity = assessment.diagnostics.find(
      ({ id }) => String(id) === "FAB_NET_IDENTITY_001",
    );
    expect(identity?.objects).toContain(
      "source_trace_zero_port_bridge:multiple-source-nets:source_net_0,source_net_hostile_alias",
    );
  });

  test("rejects a partial via span under the full-stack baseline profile", async () => {
    const circuitJson = clone(await manufacturingFixture(4));
    const via = circuitJson.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_1",
    );
    if (via?.type !== "pcb_via") throw new Error("Fixture routed via missing");
    via.from_layer = "top";
    via.to_layer = "inner1";
    via.layers = ["top", "inner1"];
    expect(codes(circuitJson)).toContain("FAB_DIMENSION_001");
  });

  test("does not let a spoofed via net key conceal a cross-net short", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const standalone = circuitJson.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_0",
    );
    const routed = circuitJson.find(
      (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_1",
    );
    const owner = routed?.type === "pcb_via"
      ? circuitJson.find((element) =>
        element.type === "pcb_trace" && element.pcb_trace_id === routed.pcb_trace_id
      )
      : undefined;
    const logical = owner?.type === "pcb_trace"
      ? circuitJson.find((element) =>
        element.type === "source_trace" && element.source_trace_id === owner.source_trace_id
      )
      : undefined;
    if (standalone?.type !== "pcb_via" || routed?.type !== "pcb_via" || logical?.type !== "source_trace") {
      throw new Error("Fixture via net identities missing");
    }
    standalone.x = routed.x;
    standalone.y = routed.y;
    standalone.subcircuit_connectivity_map_key = logical.subcircuit_connectivity_map_key;
    expect(codes(circuitJson)).toContain("FAB_NET_IDENTITY_001");
  });

  test("rejects copper features on layers outside the declared stack", async () => {
    const padAttack = clone(await manufacturingFixture(2));
    const pad = padAttack.find((element) => element.type === "pcb_smtpad");
    if (pad?.type !== "pcb_smtpad") throw new Error("Fixture pad missing");
    pad.layer = "inner1";
    expect(codes(padAttack)).toContain("FAB_DIMENSION_001");

    const pthAttack = clone(await manufacturingFixture(2));
    const pth = pthAttack.find((element) => element.type === "pcb_plated_hole");
    if (pth?.type !== "pcb_plated_hole") throw new Error("Fixture PTH missing");
    pth.layers = ["inner1"];
    expect(codes(pthAttack)).toContain("FAB_DIMENSION_001");
  });

  test("fails closed on an explicit PCB keep-out until keep-out routing is independently qualified", () => {
    const keepout = {
      type: "pcb_keepout",
      pcb_keepout_id: "keepout-1",
      layer: "top",
      shape: "rect",
      center: { x: 0, y: 0 },
      width: 2,
      height: 2,
    } as unknown as AnyCircuitElement;
    const assessment = assessBaselineGeometry(
      [geometryBoundaryBoard(), keepout],
      BASELINE_FABRICATION_PROFILE,
    );
    expect(assessment.unsupported).toContain("keepout-1:pcb_keepout");
  });

  test("uses expanded solder-mask openings when checking mask slivers", async () => {
    const circuitJson = clone(await manufacturingFixture(2)).filter((element) => [
      "pcb_board",
      "source_port",
      "pcb_port",
      "pcb_smtpad",
    ].includes(element.type));
    const pads = circuitJson.filter(
      (element) => element.type === "pcb_smtpad" && element.shape === "rect",
    ).slice(0, 2);
    const ports = circuitJson.filter((element) => element.type === "source_port").slice(0, 2);
    if (pads.length !== 2 || ports.length !== 2) throw new Error("Fixture pad pair missing");
    pads[0]!.x = 0;
    pads[1]!.x = 1.05;
    pads[0]!.soldermask_margin = 0.1;
    pads[1]!.soldermask_margin = 0.1;
    ports[1]!.subcircuit_connectivity_map_key = ports[0]!.subcircuit_connectivity_map_key;
    expect(codes(circuitJson)).toContain("FAB_MASK_SLIVER_001");
  });

  test("uses asymmetric solder-mask margins when checking mask slivers", async () => {
    const circuitJson = clone(await manufacturingFixture(2)).filter((element) => [
      "pcb_board",
      "source_port",
      "pcb_port",
      "pcb_smtpad",
    ].includes(element.type));
    const pads = circuitJson.filter(
      (element) => element.type === "pcb_smtpad" && element.shape === "rect",
    ).slice(0, 2);
    const ports = circuitJson.filter((element) => element.type === "source_port").slice(0, 2);
    if (pads.length !== 2 || ports.length !== 2) throw new Error("Fixture pad pair missing");
    pads[0]!.x = 0;
    pads[1]!.x = 1;
    pads[0]!.soldermask_margin_right = 0.15;
    ports[1]!.subcircuit_connectivity_map_key = ports[0]!.subcircuit_connectivity_map_key;
    expect(codes(circuitJson)).toContain("FAB_MASK_SLIVER_001");
  });

  test.each([
    [8.499, false],
    [8.5, false],
    [8.501, true],
  ] as const)("checks courtyard-to-edge boundary at x=%f", async (x, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const courtyard = circuitJson.find((element) => element.type === "pcb_courtyard_rect");
    if (courtyard?.type !== "pcb_courtyard_rect") throw new Error("Fixture courtyard missing");
    courtyard.center = { x, y: 0 };
    courtyard.width = 3;
    courtyard.height = 2;
    expect(codes(circuitJson).includes("FAB_COURTYARD_EDGE_001")).toBe(violates);
  });

  test.each([
    [-2e-9, true],
    [0, false],
    [2e-9, false],
  ] as const)("checks component-to-board containment boundary at offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const board = circuitJson.find((element) => element.type === "pcb_board");
    const component = circuitJson.find((element) => element.type === "pcb_component");
    if (
      board?.type !== "pcb_board" || typeof board.width !== "number" ||
      component?.type !== "pcb_component"
    ) {
      throw new Error("Fixture board or component missing");
    }
    component.center = {
      x: board.center.x + board.width / 2 - component.width / 2 - offset,
      y: board.center.y,
    };
    expect(codes(circuitJson).includes("FAB_COMPONENT_PLACEMENT_001")).toBe(violates);
  });

  test.each([
    [-2e-9, true],
    [0, false],
    [2e-9, false],
  ] as const)("checks component-body overlap boundary at offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const components = circuitJson.filter((element) => element.type === "pcb_component");
    if (components.length < 2) throw new Error("Fixture component pair missing");
    for (const component of components.slice(2)) component.do_not_place = true;
    const left = components[0]!;
    const right = components[1]!;
    left.layer = right.layer = "top";
    left.center = { x: -5, y: 4 };
    right.center = {
      x: left.center.x + left.width / 2 + right.width / 2 + offset,
      y: left.center.y,
    };
    expect(codes(circuitJson).includes("FAB_COMPONENT_OVERLAP_001")).toBe(violates);
  });

  test.each([
    [-2e-9, true],
    [0, false],
    [2e-9, false],
  ] as const)("checks courtyard overlap boundary at offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const courtyards = circuitJson.filter((element) => element.type === "pcb_courtyard_rect");
    if (courtyards.length < 2) throw new Error("Fixture courtyard pair missing");
    const left = courtyards[0]!;
    const right = courtyards[1]!;
    left.layer = right.layer = "top";
    left.ccw_rotation = right.ccw_rotation = 0;
    left.center = { x: -5, y: 4 };
    right.center = {
      x: left.center.x + left.width / 2 + right.width / 2 + offset,
      y: left.center.y,
    };
    expect(codes(circuitJson).includes("FAB_COURTYARD_OVERLAP_001")).toBe(violates);
  });

  test.each([
    [-2e-9, false],
    [0, false],
    [2e-9, true],
  ] as const)("checks courtyard-owner containment boundary at offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const courtyard = circuitJson.find((element) => element.type === "pcb_courtyard_rect");
    const component = circuitJson.find((element) =>
      element.type === "pcb_component" &&
      element.pcb_component_id === courtyard?.pcb_component_id
    );
    if (courtyard?.type !== "pcb_courtyard_rect" || component?.type !== "pcb_component") {
      throw new Error("Fixture courtyard owner missing");
    }
    component.center = { x: 0, y: 0 };
    courtyard.center = {
      x: (courtyard.width - component.width) / 2 + offset,
      y: 0,
    };
    expect(codes(circuitJson).includes("FAB_COURTYARD_INTEGRITY_001")).toBe(violates);
  });

  test.each([
    [-4e-9, false],
    [0, false],
    [4e-9, true],
  ] as const)("checks paste-to-pad containment boundary at width offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const aperture = circuitJson.find((element) =>
      element.type === "pcb_solder_paste" && element.shape === "rect" &&
      element.pcb_smtpad_id !== undefined
    );
    if (aperture?.type !== "pcb_solder_paste" || aperture.shape !== "rect") {
      throw new Error("Fixture rectangular paste aperture missing");
    }
    const pad = circuitJson.find((element) =>
      element.type === "pcb_smtpad" && element.shape === "rect" &&
      element.pcb_smtpad_id === aperture.pcb_smtpad_id
    );
    if (pad?.type !== "pcb_smtpad" || pad.shape !== "rect") {
      throw new Error("Fixture rectangular paste parent missing");
    }
    aperture.x = pad.x;
    aperture.y = pad.y;
    aperture.width = pad.width + offset;
    aperture.height = pad.height;
    expect(codes(circuitJson).includes("FAB_PASTE_APERTURE_001")).toBe(violates);
  });

  test.each([
    [-2e-9, false],
    [0, false],
    [2e-9, true],
  ] as const)("checks SMT-pad owner containment boundary at offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const pad = circuitJson.find((element) =>
      element.type === "pcb_smtpad" && element.shape === "rect" &&
      element.pcb_component_id !== null && element.pcb_component_id !== undefined
    );
    if (pad?.type !== "pcb_smtpad" || pad.shape !== "rect") {
      throw new Error("Fixture owned SMT pad missing");
    }
    const courtyard = circuitJson.find((element) =>
      element.type === "pcb_courtyard_rect" &&
      element.pcb_component_id === pad.pcb_component_id
    );
    if (courtyard?.type !== "pcb_courtyard_rect") {
      throw new Error("Fixture SMT owner courtyard missing");
    }
    pad.x = courtyard.center.x + courtyard.width / 2 - pad.width / 2 + offset;
    pad.y = courtyard.center.y;
    const aperture = circuitJson.find((element) =>
      element.type === "pcb_solder_paste" && element.pcb_smtpad_id === pad.pcb_smtpad_id
    );
    if (aperture?.type === "pcb_solder_paste") {
      aperture.x = pad.x;
      aperture.y = pad.y;
    }
    expect(codes(circuitJson).includes("FAB_PAD_OWNER_INTEGRITY_001")).toBe(violates);
  });

  test.each([
    [-2e-9, false],
    [0, false],
    [2e-9, true],
  ] as const)("checks plated-hole owner containment boundary at offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const hole = circuitJson.find((element) =>
      element.type === "pcb_plated_hole" && element.shape === "circle" &&
      element.pcb_component_id !== null && element.pcb_component_id !== undefined
    );
    if (hole?.type !== "pcb_plated_hole" || hole.shape !== "circle") {
      throw new Error("Fixture owned plated hole missing");
    }
    const courtyard = circuitJson.find((element) =>
      element.type === "pcb_courtyard_rect" &&
      element.pcb_component_id === hole.pcb_component_id
    );
    if (courtyard?.type !== "pcb_courtyard_rect") {
      throw new Error("Fixture plated-hole owner courtyard missing");
    }
    hole.x = courtyard.center.x + courtyard.width / 2 - hole.outer_diameter / 2 + offset;
    hole.y = courtyard.center.y;
    expect(codes(circuitJson).includes("FAB_PAD_OWNER_INTEGRITY_001")).toBe(violates);
  });

  test.each([
    [-2e-9, false],
    [0, false],
    [2e-9, true],
  ] as const)("checks NPTH owner containment boundary at offset %f mm", async (offset, violates) => {
    const circuitJson = clone(await manufacturingFixture(2));
    const hole = circuitJson.find((element) =>
      element.type === "pcb_hole" && element.hole_shape === "circle"
    );
    if (hole?.type !== "pcb_hole" || hole.hole_shape !== "circle") {
      throw new Error("Fixture circular NPTH missing");
    }
    const courtyard = circuitJson.find((element) =>
      element.type === "pcb_courtyard_rect" &&
      element.width >= hole.hole_diameter && element.height >= hole.hole_diameter
    );
    if (courtyard?.type !== "pcb_courtyard_rect") {
      throw new Error("Fixture NPTH owner courtyard missing");
    }
    const component = circuitJson.find((element) =>
      element.type === "pcb_component" &&
      element.pcb_component_id === courtyard.pcb_component_id
    );
    if (component?.type !== "pcb_component") {
      throw new Error("Fixture NPTH owner component missing");
    }
    hole.pcb_component_id = component.pcb_component_id;
    hole.x = courtyard.center.x + courtyard.width / 2 - hole.hole_diameter / 2 + offset;
    hole.y = courtyard.center.y;
    expect(codes(circuitJson).includes("FAB_PAD_OWNER_INTEGRITY_001")).toBe(violates);
  });

  test("rejects an orphan paste aperture with fabricated owner identities", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    circuitJson.push({
      type: "pcb_solder_paste",
      pcb_solder_paste_id: "pcb_solder_paste_orphan",
      pcb_smtpad_id: "pcb_smtpad_missing",
      pcb_component_id: "pcb_component_missing",
      layer: "top",
      shape: "rect",
      x: 8,
      y: 0,
      width: 1,
      height: 1,
    } as AnyCircuitElement);
    expect(codes(circuitJson)).toContain("FAB_PASTE_APERTURE_001");
  });

  test("rejects displaced, oversized, and wrong-side paste apertures", async () => {
    for (const attack of ["displaced", "oversized", "wrong-side"] as const) {
      const circuitJson = clone(await manufacturingFixture(2));
      const aperture = circuitJson.find(
        (element) => element.type === "pcb_solder_paste" && element.pcb_smtpad_id !== undefined,
      );
      if (aperture?.type !== "pcb_solder_paste" || aperture.shape !== "rect") {
        throw new Error("Fixture rectangular SMT paste aperture missing");
      }
      if (attack === "displaced") aperture.x += 0.05;
      if (attack === "oversized") aperture.width += 1;
      if (attack === "wrong-side") aperture.layer = aperture.layer === "top" ? "bottom" : "top";
      expect(codes(circuitJson)).toContain("FAB_PASTE_APERTURE_001");
    }
  });

  test("rejects duplicate paste identities before one record can borrow another's geometry", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const index = circuitJson.findIndex(
      (element) => element.type === "pcb_solder_paste" && element.pcb_smtpad_id !== undefined,
    );
    const aperture = circuitJson[index];
    if (aperture?.type !== "pcb_solder_paste") throw new Error("Fixture SMT paste missing");
    circuitJson.splice(index, 0, { ...aperture, x: aperture.x + 0.2 });
    expect(codes(circuitJson)).toContain("FAB_GEOMETRY_IDENTITY_001");
  });

  test("requires one explicit paste aperture for every populated SMT pad", async () => {
    const circuitJson = clone(await manufacturingFixture(2)).filter(
      (element) => element.type !== "pcb_solder_paste" || element.pcb_smtpad_id === undefined,
    );
    expect(codes(circuitJson)).toContain("FAB_PASTE_COMPLETENESS_001");
  });

  test("fails closed for ownerless SMT copper or fiducials without authenticated primitive identity", async () => {
    for (const owner of [null, undefined] as const) {
      const circuitJson = clone(await manufacturingFixture(2));
      circuitJson.push({
        type: "pcb_smtpad",
        pcb_smtpad_id: `pcb_smtpad_owner_${String(owner)}`,
        ...(owner === undefined ? {} : { pcb_component_id: owner }),
        layer: "top",
        shape: "circle",
        x: 0,
        y: 5,
        radius: 0.5,
        soldermask_margin: 0.5,
        is_covered_with_solder_mask: true,
      } as unknown as AnyCircuitElement);
      const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
      expect(assessment.diagnostics.map(({ id }) => String(id))).not.toContain(
        "FAB_PASTE_COMPLETENESS_001",
      );
      expect(assessment.diagnostics.find(({ id }) => id === "FAB_PAD_OWNER_INTEGRITY_001")?.objects)
        .toContain(`pcb_smtpad_owner_${String(owner)}:owner-missing`);
      expect(deriveManufacturingExpectation({ boardName: "control", circuitJson }).unsupported)
        .toContainEqual(expect.stringContaining("ownerless SMT pad or fiducial"));
    }
  });

  test("fails closed for ownerless plated copper that is neither a component pin nor a via", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    circuitJson.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "pcb_plated_hole_orphan",
      shape: "circle",
      x: 0,
      y: 5,
      hole_diameter: 0.6,
      outer_diameter: 1,
      layers: ["top", "bottom"],
      is_covered_with_solder_mask: false,
      subcircuit_id: "subcircuit_source_group_0",
    } as unknown as AnyCircuitElement);
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.diagnostics.find(({ id }) => id === "FAB_PAD_OWNER_INTEGRITY_001")?.objects)
      .toContain("pcb_plated_hole_orphan:owner-missing");
    expect(deriveManufacturingExpectation({ boardName: "control", circuitJson }).unsupported)
      .toContainEqual(expect.stringContaining("ownerless plated copper"));
  });

  test("binds every owned SMT pad and PCB port to its component assembly side", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const component = circuitJson.find(
      (element) => element.type === "pcb_component" && element.layer === "bottom",
    );
    if (component?.type !== "pcb_component") throw new Error("Bottom component missing");
    const pad = circuitJson.find(
      (element) => element.type === "pcb_smtpad" &&
        element.shape === "rect" &&
        element.pcb_component_id === component.pcb_component_id,
    );
    if (pad?.type !== "pcb_smtpad" || pad.shape !== "rect") {
      throw new Error("Bottom rectangular SMT pad missing");
    }
    pad.layer = "top";
    const port = circuitJson.find(
      (element) => element.type === "pcb_port" && element.pcb_port_id === pad.pcb_port_id,
    );
    if (port?.type !== "pcb_port") throw new Error("Bottom SMT port missing");
    port.layers = ["top"];
    expect(codes(circuitJson)).toContain("FAB_PAD_OWNER_INTEGRITY_001");
  });

  test("keeps owned SMT pad geometry inside its resolved component courtyard", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const component = circuitJson.find(
      (element) => element.type === "pcb_component" && element.layer === "bottom",
    );
    if (component?.type !== "pcb_component") throw new Error("Bottom component missing");
    const pad = circuitJson.find(
      (element) => element.type === "pcb_smtpad" &&
        element.shape === "rect" &&
        element.pcb_component_id === component.pcb_component_id,
    );
    if (pad?.type !== "pcb_smtpad" || pad.shape !== "rect") {
      throw new Error("Bottom rectangular SMT pad missing");
    }
    pad.x += 1;
    expect(codes(circuitJson)).toContain("FAB_PAD_OWNER_INTEGRITY_001");
  });

  test("keeps owned plated-hole geometry inside its resolved component courtyard", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const hole = circuitJson.find(
      (element) => element.type === "pcb_plated_hole" &&
        element.pcb_plated_hole_id === "pcb_plated_hole_1",
    );
    if (hole?.type !== "pcb_plated_hole" || hole.shape !== "circle") {
      throw new Error("Owned circular plated hole missing");
    }
    hole.x += 3;
    expect(codes(circuitJson)).toContain("FAB_PAD_OWNER_INTEGRITY_001");
  });

  test("keeps component-owned NPTH geometry inside its resolved component courtyard", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const hole = circuitJson.find((element) => element.type === "pcb_hole");
    const component = circuitJson.find((element) =>
      element.type === "pcb_component" && element.pcb_component_id === "pcb_component_2"
    );
    if (hole?.type !== "pcb_hole" || component?.type !== "pcb_component") {
      throw new Error("NPTH or target component missing");
    }
    hole.pcb_component_id = component.pcb_component_id;
    expect(codes(circuitJson)).toContain("FAB_PAD_OWNER_INTEGRITY_001");
  });

  test("requires explicit courtyards to have one same-side owner and contain its body", async () => {
    for (const attack of ["orphan", "wrong-side", "displaced"] as const) {
      const circuitJson = clone(await manufacturingFixture(2));
      const courtyard = circuitJson.find((element) => element.type === "pcb_courtyard_rect");
      if (courtyard?.type !== "pcb_courtyard_rect") throw new Error("Fixture courtyard missing");
      if (attack === "orphan") courtyard.pcb_component_id = "pcb_component_missing";
      if (attack === "wrong-side") courtyard.layer = courtyard.layer === "top" ? "bottom" : "top";
      if (attack === "displaced") courtyard.center = { x: 5, y: 0 };
      expect(codes(circuitJson)).toContain("FAB_COURTYARD_INTEGRITY_001");
    }
  });

  test("detects component-body overlap even when explicit courtyards are moved apart", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const components = circuitJson.filter((element) => element.type === "pcb_component").slice(0, 2);
    const courtyards = circuitJson.filter((element) => element.type === "pcb_courtyard_rect").slice(0, 2);
    if (components.length !== 2 || courtyards.length !== 2) throw new Error("Fixture bodies missing");
    components[0]!.center = components[1]!.center = { x: 0, y: 0 };
    components[0]!.layer = components[1]!.layer = "top";
    components[0]!.obstructs_within_bounds = components[1]!.obstructs_within_bounds = false;
    courtyards[0]!.center = { x: -6, y: 0 };
    courtyards[1]!.center = { x: 6, y: 0 };
    expect(codes(circuitJson)).toContain("FAB_COMPONENT_OVERLAP_001");
  });

  test("rejects non-finite uniform and per-side solder-mask margins", async () => {
    for (const attack of ["uniform-nan", "uniform-infinity", "side-nan"] as const) {
      const circuitJson = clone(await manufacturingFixture(2));
      const pad = circuitJson.find(
        (element) => element.type === "pcb_smtpad" && element.shape === "rect",
      );
      if (pad?.type !== "pcb_smtpad" || pad.shape !== "rect") {
        throw new Error("Fixture rectangular SMT pad missing");
      }
      if (attack === "uniform-nan") pad.soldermask_margin = Number.NaN;
      if (attack === "uniform-infinity") pad.soldermask_margin = Number.POSITIVE_INFINITY;
      if (attack === "side-nan") pad.soldermask_margin_right = Number.NaN;
      expect(codes(circuitJson)).toContain("FAB_DIMENSION_001");
    }
  });

  test("rejects non-positive component and courtyard dimensions", async () => {
    const componentAttack = clone(await manufacturingFixture(2));
    const component = componentAttack.find((element) => element.type === "pcb_component");
    if (component?.type !== "pcb_component") throw new Error("Fixture component missing");
    component.width = -1;
    expect(codes(componentAttack)).toContain("FAB_DIMENSION_001");

    const courtyardAttack = clone(await manufacturingFixture(2));
    const courtyard = courtyardAttack.find((element) => element.type === "pcb_courtyard_rect");
    if (courtyard?.type !== "pcb_courtyard_rect") throw new Error("Fixture courtyard missing");
    courtyard.height = -1;
    expect(codes(courtyardAttack)).toContain("FAB_DIMENSION_001");
  });

  test("fails closed on non-orthogonal rotated pad and paste geometry", async () => {
    const fixture = clone(await manufacturingFixture(2));
    const sourceBoard = fixture.find((element) => element.type === "source_board");
    const board = fixture.find((element) => element.type === "pcb_board");
    const pad = fixture.find((element) => element.type === "pcb_smtpad" && element.shape === "rect");
    const aperture = fixture.find(
      (element) => element.type === "pcb_solder_paste" && element.pcb_smtpad_id === pad?.pcb_smtpad_id,
    );
    if (sourceBoard?.type !== "source_board" || board?.type !== "pcb_board" ||
      pad?.type !== "pcb_smtpad" || pad.shape !== "rect" ||
      aperture?.type !== "pcb_solder_paste" || aperture.shape !== "rect") {
      throw new Error("Fixture rotated geometry inputs missing");
    }
    const rotatedPad = { ...pad, shape: "rotated_rect", ccw_rotation: 45 } as AnyCircuitElement;
    const rotatedPaste = {
      ...aperture,
      shape: "rotated_rect",
      ccw_rotation: 45,
    } as AnyCircuitElement;
    delete (rotatedPad as unknown as Record<string, unknown>).pcb_component_id;
    delete (rotatedPad as unknown as Record<string, unknown>).pcb_port_id;
    delete (rotatedPaste as unknown as Record<string, unknown>).pcb_component_id;
    delete (rotatedPaste as unknown as Record<string, unknown>).pcb_smtpad_id;
    const assessment = assessCircuitFabrication(
      [sourceBoard, board, rotatedPad, rotatedPaste],
      BASELINE_FABRICATION_PROFILE,
    );
    expect(assessment.status.state).not.toBe("passed");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain(
      "FAB_GEOMETRY_UNSUPPORTED_001",
    );
  });

  test("does not reinterpret a custom board outline as a verified rectangle", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const board = circuitJson.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
    Object.assign(board, {
      shape: "polygon",
      outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    });
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain(
      "FAB_GEOMETRY_UNSUPPORTED_001",
    );
  });

  test("fails closed on unsupported courtyard outline geometry", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const courtyard = circuitJson.find((element) => element.type === "pcb_courtyard_rect");
    if (courtyard?.type !== "pcb_courtyard_rect") throw new Error("Fixture courtyard missing");
    const record = courtyard as unknown as Record<string, unknown>;
    record.type = "pcb_courtyard_outline";
    record.pcb_courtyard_outline_id = record.pcb_courtyard_rect_id;
    delete record.pcb_courtyard_rect_id;
    record.outline = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }];
    expect(assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE).status.state)
      .toBe("incomplete");
  });

  test("rejects overlapping rectangular courtyards on the same side", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    const courtyards = circuitJson.filter((element) => element.type === "pcb_courtyard_rect");
    if (courtyards.length < 2) throw new Error("Fixture courtyards missing");
    courtyards[0]!.center = { x: 0, y: 0 };
    courtyards[1]!.center = { x: 1, y: 1 };
    courtyards[0]!.width = courtyards[1]!.width = 5;
    courtyards[0]!.height = courtyards[1]!.height = 5;
    courtyards[0]!.layer = courtyards[1]!.layer = "top";
    expect(codes(circuitJson)).toContain("FAB_COURTYARD_OVERLAP_001");
  });

  test("uses component bounds when emitted courtyards are absent", async () => {
    const circuitJson = clone(await manufacturingFixture(2)).filter(
      (element) => element.type !== "pcb_courtyard_rect",
    );
    const components = circuitJson.filter((element) => element.type === "pcb_component");
    if (components.length < 2) throw new Error("Fixture components missing");
    components[0]!.center = { x: 0, y: 0 };
    components[1]!.center = { x: 0, y: 0 };
    components[0]!.layer = components[1]!.layer = "top";
    expect(codes(circuitJson)).toContain("FAB_COURTYARD_OVERLAP_001");
  });

  test("fails closed on every unimplemented PCB geometry record", async () => {
    const circuitJson = clone(await manufacturingFixture(2));
    circuitJson.push({
      type: "pcb_copper_pour",
      pcb_copper_pour_id: "hostile_pour",
      layer: "top",
      source_net_id: "source_net_0",
      shape: "rect",
      center: { x: 0, y: 0 },
      width: 30,
      height: 30,
    } as unknown as AnyCircuitElement);
    const assessment = assessCircuitFabrication(circuitJson, BASELINE_FABRICATION_PROFILE);
    expect(assessment.status.state).toBe("incomplete");
    expect(assessment.diagnostics.map(({ id }) => String(id))).toContain(
      "FAB_GEOMETRY_UNSUPPORTED_001",
    );
  });
});
