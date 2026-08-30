// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import { defineDiagnostic, diagnosticId, type Diagnostic } from "./diagnostics";
import { assuranceStatus, type AssuranceStatus } from "./status";
import {
  resolveFabricationProfile,
  type ActiveFabricationProfile,
} from "./profiles/baseline";
import {
  assessBaselineGeometry,
  baselineGeometryWorkload,
} from "./fabrication-geometry";
import { deriveAuthoritativeConnectivity } from "./authoritative-connectivity";
import { isDeterministicTemporaryComponentName } from "./component-identity";

const DIMENSION_EPSILON_MM = 1e-9;
export const MAX_FABRICATION_CIRCUIT_ELEMENTS = 8_000;
export const MAX_FABRICATION_ROUTE_POINTS = 8_192;
export const MAX_FABRICATION_LAYER_REFERENCES = 8_192;
export const MAX_FABRICATION_PAIRWISE_FEATURES = 4_096;
export const MAX_FABRICATION_ROUTED_TRACES = 4_096;
export const MAX_FABRICATION_LOGICAL_REFERENCES = 8_192;
const WAIVABLE_FABRICATION_RULES = new Set([
  "FAB_PROFILE_MINIMUM_001",
  "FAB_ROUTE_CONSTRAINT_001",
  "FAB_COPPER_CLEARANCE_001",
  "FAB_BOARD_EDGE_001",
  "FAB_MASK_SLIVER_001",
  "FAB_COMPONENT_PLACEMENT_001",
  "FAB_COMPONENT_OVERLAP_001",
  "FAB_COURTYARD_OVERLAP_001",
  "FAB_COURTYARD_EDGE_001",
]);

function belowMinimum(actual: number, required: number): boolean {
  return actual + DIMENSION_EPSILON_MM < required;
}

function aboveMaximum(actual: number, required: number): boolean {
  return actual > required + DIMENSION_EPSILON_MM;
}

type PcbTrace = Extract<AnyCircuitElement, { type: "pcb_trace" }>;
type RoutePoint = PcbTrace["route"][number];

function routePointCoordinate(
  point: RoutePoint,
  adjacentLayer: string | undefined,
): Readonly<{ x: number; y: number }> | undefined {
  if (point.route_type === "wire" || point.route_type === "via") {
    return Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: point.x, y: point.y }
      : undefined;
  }
  if (point.route_type !== "through_pad") return undefined;
  const candidate = adjacentLayer === point.start_layer
    ? point.start
    : adjacentLayer === point.end_layer
      ? point.end
      : point.start.x === point.end.x && point.start.y === point.end.y
        ? point.start
        : undefined;
  return candidate !== undefined && Number.isFinite(candidate.x) && Number.isFinite(candidate.y)
    ? candidate
    : undefined;
}

function independentlyMeasuredTraceLength(
  trace: PcbTrace,
  boardThickness: number | undefined,
): number | undefined {
  if (trace.route.length < 2) return undefined;
  if (trace.route.some((point) =>
    point.route_type === "through_pad" &&
    (point.start.x !== point.end.x || point.start.y !== point.end.y)
  )) return undefined;
  let length = 0;
  for (let index = 0; index < trace.route.length - 1; index += 1) {
    const start = trace.route[index]!;
    const end = trace.route[index + 1]!;
    const adjacentLayer = start.route_type === "wire"
      ? start.layer
      : end.route_type === "wire"
        ? end.layer
        : undefined;
    const startCoordinate = routePointCoordinate(start, adjacentLayer);
    const endCoordinate = routePointCoordinate(end, adjacentLayer);
    if (startCoordinate === undefined || endCoordinate === undefined) return undefined;
    length += Math.hypot(
      endCoordinate.x - startCoordinate.x,
      endCoordinate.y - startCoordinate.y,
    );
  }
  for (const point of trace.route) {
    const crossesBoard = point.route_type === "via"
      ? point.from_layer !== point.to_layer
      : point.route_type === "through_pad"
        ? point.start_layer !== point.end_layer
        : false;
    if (!crossesBoard) continue;
    if (boardThickness === undefined) return undefined;
    length += boardThickness;
  }
  return Number.isFinite(length) ? length : undefined;
}

export interface FabricationAssessment {
  readonly status: AssuranceStatus<"fabrication">;
  readonly diagnostics: readonly Diagnostic[];
}

function positive(...values: unknown[]): boolean {
  return values.every(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

function finiteWhenPresent(...values: unknown[]): boolean {
  return values.every((value) => value === undefined ||
    (typeof value === "number" && Number.isFinite(value)));
}

function elementId(element: AnyCircuitElement): string {
  const record = element as unknown as Record<string, unknown>;
  const primary = record[`${element.type}_id`];
  return typeof primary === "string" ? primary : element.type;
}

/** @internal Cheap resource preflight shared with adversarial boundary tests. */
export function fabricationWorkloadOverflow(
  circuitJson: readonly AnyCircuitElement[],
): readonly string[] {
  let routePoints = 0;
  let layerReferences = 0;
  let routedTraces = 0;
  let logicalReferences = 0;
  for (const element of circuitJson) {
    if (element.type === "pcb_trace") {
      routedTraces += 1;
      routePoints += element.route.length;
    }
    if (element.type === "source_trace") {
      logicalReferences += element.connected_source_port_ids.length +
        element.connected_source_net_ids.length;
    } else if (element.type === "source_component_internal_connection") {
      logicalReferences += element.source_port_ids.length;
    }
    if (element.type === "pcb_plated_hole" || element.type === "pcb_via") {
      layerReferences += element.layers.length;
    }
    const layers = (element as unknown as { layers?: unknown }).layers;
    if (
      Array.isArray(layers) &&
      element.type !== "pcb_plated_hole" && element.type !== "pcb_via"
    ) layerReferences += layers.length;
  }
  const cheapOverflows = [
    ...(circuitJson.length > MAX_FABRICATION_CIRCUIT_ELEMENTS
      ? [`circuit-elements:${circuitJson.length}:limit:${MAX_FABRICATION_CIRCUIT_ELEMENTS}:excess:${circuitJson.length - MAX_FABRICATION_CIRCUIT_ELEMENTS}`]
      : []),
    ...(routePoints > MAX_FABRICATION_ROUTE_POINTS
      ? [`route-points:${routePoints}:limit:${MAX_FABRICATION_ROUTE_POINTS}:excess:${routePoints - MAX_FABRICATION_ROUTE_POINTS}`]
      : []),
    ...(layerReferences > MAX_FABRICATION_LAYER_REFERENCES
      ? [`layer-references:${layerReferences}:limit:${MAX_FABRICATION_LAYER_REFERENCES}:excess:${layerReferences - MAX_FABRICATION_LAYER_REFERENCES}`]
      : []),
    ...(routedTraces > MAX_FABRICATION_ROUTED_TRACES
      ? [`routed-traces:${routedTraces}:limit:${MAX_FABRICATION_ROUTED_TRACES}:excess:${routedTraces - MAX_FABRICATION_ROUTED_TRACES}`]
      : []),
    ...(logicalReferences > MAX_FABRICATION_LOGICAL_REFERENCES
      ? [`logical-references:${logicalReferences}:limit:${MAX_FABRICATION_LOGICAL_REFERENCES}:excess:${logicalReferences - MAX_FABRICATION_LOGICAL_REFERENCES}`]
      : []),
  ];
  if (cheapOverflows.length > 0) return Object.freeze(cheapOverflows);
  const pairwiseFeatures = baselineGeometryWorkload(circuitJson).pairwiseFeatures;
  return Object.freeze([
    ...(pairwiseFeatures > MAX_FABRICATION_PAIRWISE_FEATURES
      ? [`pairwise-features:${pairwiseFeatures}:limit:${MAX_FABRICATION_PAIRWISE_FEATURES}:excess:${pairwiseFeatures - MAX_FABRICATION_PAIRWISE_FEATURES}`]
      : []),
  ]);
}

/** Conservative built-in dimensional DRC; named profiles add tighter rules later. */
export function assessCircuitFabrication(
  circuitJson: readonly AnyCircuitElement[],
  activeProfile?: ActiveFabricationProfile,
): Readonly<FabricationAssessment> {
  const workloadOverflow = fabricationWorkloadOverflow(circuitJson);
  if (workloadOverflow.length > 0) {
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_RESOURCE_LIMIT_001"),
      severity: "error",
      dimension: "fabrication",
      message: "Circuit JSON exceeds the independently qualified fabrication work envelope; geometry evaluation was not started",
      waiverPolicy: "forbidden",
      objects: workloadOverflow,
      sourceLocations: [],
      evidence: workloadOverflow.map((item) => `circuit-json:${item}`),
      nextCommand: "fulmetry inspect --status fabrication --rule FAB_RESOURCE_LIMIT_001",
    });
    return Object.freeze({
      status: assuranceStatus("fabrication", "failed", {
        diagnosticIds: [diagnostic.id],
        summary: "Fabrication verification exceeded its qualified resource envelope",
      }),
      diagnostics: Object.freeze([diagnostic]),
    });
  }
  const invalid: string[] = [];
  const belowProfileMinimum: string[] = [];
  const routeConstraintFailures: string[] = [];
  const routeConstraintUnsupported: string[] = [];
  const profile = activeProfile === undefined
    ? undefined
    : resolveFabricationProfile(activeProfile);
  const authoritativeConnectivity = deriveAuthoritativeConnectivity(circuitJson);
  const sourceComponentRecords = circuitJson.filter(
    (element) => element.type === "source_component",
  );
  const sourceComponents = new Map(sourceComponentRecords.map((element) =>
    [element.source_component_id, element] as const
  ));
  const pcbComponents = circuitJson.filter((element) => element.type === "pcb_component");
  const pcbTraces = circuitJson.filter((element): element is PcbTrace =>
    element.type === "pcb_trace"
  );
  const sourceComponentCounts = new Map<string, number>();
  const pcbComponentCounts = new Map<string, number>();
  for (const source of sourceComponentRecords) {
    sourceComponentCounts.set(
      source.source_component_id,
      (sourceComponentCounts.get(source.source_component_id) ?? 0) + 1,
    );
  }
  for (const component of pcbComponents) {
    pcbComponentCounts.set(
      component.source_component_id,
      (pcbComponentCounts.get(component.source_component_id) ?? 0) + 1,
    );
  }
  const componentMappingFailures = [
    ...sourceComponentRecords.flatMap((source) => {
      const count = pcbComponentCounts.get(source.source_component_id) ?? 0;
      return count === 1
        ? []
        : [`${source.source_component_id}:pcb-component-count:${count}`];
    }),
    ...pcbComponents.flatMap((component) => {
      const count = sourceComponentCounts.get(component.source_component_id) ?? 0;
      return count === 1
        ? []
        : [`${component.pcb_component_id}:source-component-count:${count}`];
    }),
  ];
  const temporaryManufacturedNames = circuitJson.flatMap((element) => {
    if (element.type !== "pcb_component") return [];
    const source = sourceComponents.get(element.source_component_id);
    return isDeterministicTemporaryComponentName(source?.name)
      ? [`${element.pcb_component_id}.reference`]
      : [];
  });
  const boards = circuitJson.filter((element) => element.type === "pcb_board");
  const unsupportedBoardMaterials = profile === undefined
    ? []
    : boards.flatMap((board) =>
        profile.supportedBoardMaterials.some((material) => material === board.material)
          ? []
          : [`${board.pcb_board_id}.material:${JSON.stringify(board.material)}`]
      );
  if (boards.length !== 1) invalid.push(`pcb-board-count:${boards.length}`);
  const sourceBoards = circuitJson.filter((element) => element.type === "source_board");
  const manufacturedSourceBoardId = boards.length === 1
    ? (boards[0] as unknown as { source_board_id?: unknown }).source_board_id
    : undefined;
  const sourceBoardStructureValid = sourceBoards.length === 1 && boards.length === 1 &&
    sourceBoards[0]!.source_board_id === manufacturedSourceBoardId;
  const expectedThroughLayers = boards.length === 1 && boards[0]!.num_layers === 4
    ? ["top", "inner1", "inner2", "bottom"]
    : ["top", "bottom"];
  const boardThickness = boards.length === 1 && positive(boards[0]!.thickness)
    ? boards[0]!.thickness
    : undefined;
  const pcbTracesByLogicalNet = new Map<string, PcbTrace[]>();
  for (const trace of pcbTraces) {
    const logicalNet = authoritativeConnectivity.netForPcbTraceId(trace.pcb_trace_id);
    if (logicalNet === undefined) continue;
    const traces = pcbTracesByLogicalNet.get(logicalNet) ?? [];
    traces.push(trace);
    pcbTracesByLogicalNet.set(logicalNet, traces);
  }
  const routeMeasurementsByLogicalNet = new Map<string, Readonly<{
    minimumWire?: { traceId: string; width: number };
    hasWire: boolean;
    length?: number;
  }>>();
  for (const [logicalNet, physicalTraces] of pcbTracesByLogicalNet) {
    let minimumWire: { traceId: string; width: number } | undefined;
    for (const trace of physicalTraces) {
      for (const point of trace.route) {
        if (point.route_type !== "wire") continue;
        if (minimumWire === undefined || point.width < minimumWire.width) {
          minimumWire = { traceId: trace.pcb_trace_id, width: point.width };
        }
      }
    }
    const lengths = physicalTraces.map((trace) =>
      independentlyMeasuredTraceLength(trace, boardThickness)
    );
    routeMeasurementsByLogicalNet.set(logicalNet, Object.freeze({
      ...(minimumWire === undefined ? {} : { minimumWire }),
      hasWire: minimumWire !== undefined,
      ...(lengths.some((length) => length === undefined)
        ? {}
        : { length: (lengths as number[]).reduce((sum, length) => sum + length, 0) }),
    }));
  }
  for (const sourceTrace of circuitJson.filter((element) => element.type === "source_trace")) {
    const minimum = sourceTrace.min_trace_thickness;
    const maximum = sourceTrace.max_length;
    if (minimum === undefined && maximum === undefined) continue;
    if (minimum !== undefined && !positive(minimum)) {
      routeConstraintFailures.push(`${sourceTrace.source_trace_id}:minimum-width:invalid`);
    }
    if (maximum !== undefined && !positive(maximum)) {
      routeConstraintFailures.push(`${sourceTrace.source_trace_id}:maximum-length:invalid`);
    }
    if (
      (minimum !== undefined && !positive(minimum)) ||
      (maximum !== undefined && !positive(maximum))
    ) continue;
    const logicalNet = authoritativeConnectivity.netForSourceTraceId(
      sourceTrace.source_trace_id,
    );
    const physicalTraces = logicalNet === undefined
      ? []
      : (pcbTracesByLogicalNet.get(logicalNet) ?? []);
    if (physicalTraces.length === 0) {
      routeConstraintUnsupported.push(`${sourceTrace.source_trace_id}:no-physical-trace`);
      continue;
    }
    const measurement = routeMeasurementsByLogicalNet.get(logicalNet!);
    if (minimum !== undefined) {
      if (measurement?.hasWire !== true || measurement.minimumWire === undefined) {
        routeConstraintUnsupported.push(`${sourceTrace.source_trace_id}:no-measurable-wire`);
      } else if (belowMinimum(measurement.minimumWire.width, minimum)) {
        routeConstraintFailures.push(
          `${sourceTrace.source_trace_id}:${measurement.minimumWire.traceId}:minimum-width:${measurement.minimumWire.width}:required:${minimum}`,
        );
      }
    }
    if (maximum !== undefined) {
      if (measurement?.length === undefined) {
        routeConstraintUnsupported.push(`${sourceTrace.source_trace_id}:length-unmeasurable`);
      } else if (aboveMaximum(measurement.length, maximum)) {
        routeConstraintFailures.push(
          `${sourceTrace.source_trace_id}:length:${measurement.length}:maximum:${maximum}`,
        );
      }
    }
  }
  for (const element of circuitJson) {
    let valid = true;
    if (element.type === "pcb_board") {
      valid = positive(element.width, element.height, element.thickness) &&
        Number.isFinite(element.center.x) && Number.isFinite(element.center.y) &&
        (element.num_layers === 2 || element.num_layers === 4);
    } else if (element.type === "pcb_component") {
      valid = positive(element.width, element.height) &&
        Number.isFinite(element.center.x) && Number.isFinite(element.center.y) &&
        Number.isFinite(element.rotation) &&
        (element.layer === "top" || element.layer === "bottom");
    } else if (element.type === "pcb_courtyard_rect") {
      valid = positive(element.width, element.height) &&
        Number.isFinite(element.center.x) && Number.isFinite(element.center.y) &&
        (element.ccw_rotation === undefined || Number.isFinite(element.ccw_rotation)) &&
        (element.layer === "top" || element.layer === "bottom");
    } else if (element.type === "pcb_via") {
      const actualLayers = new Set<string>(element.layers);
      valid = positive(element.hole_diameter, element.outer_diameter) &&
        element.outer_diameter > element.hole_diameter &&
        new Set([element.from_layer, element.to_layer]).size === 2 &&
        [element.from_layer, element.to_layer].includes("top") &&
        [element.from_layer, element.to_layer].includes("bottom") &&
        actualLayers.size === expectedThroughLayers.length &&
        expectedThroughLayers.every((layer) => actualLayers.has(layer));
      if (
        valid && profile !== undefined &&
        (belowMinimum(element.hole_diameter, profile.minimumDrillMm) ||
          belowMinimum((element.outer_diameter - element.hole_diameter) / 2,
            profile.minimumAnnularRingMm)
      )) belowProfileMinimum.push(elementId(element));
    } else if (element.type === "pcb_plated_hole" && element.shape === "circle") {
      const platedLayers = new Set<string>(element.layers);
      valid = positive(element.hole_diameter, element.outer_diameter) &&
        element.outer_diameter > element.hole_diameter &&
        platedLayers.size === expectedThroughLayers.length &&
        expectedThroughLayers.every((layer) => platedLayers.has(layer)) &&
        finiteWhenPresent(element.soldermask_margin) &&
        element.outer_diameter / 2 + (element.soldermask_margin ?? 0) > 0;
      if (
        valid && profile !== undefined &&
        (belowMinimum(element.hole_diameter, profile.minimumDrillMm) ||
          belowMinimum((element.outer_diameter - element.hole_diameter) / 2,
            profile.minimumAnnularRingMm)
      )) belowProfileMinimum.push(elementId(element));
    } else if (
      element.type === "pcb_plated_hole" &&
      (element.shape === "pill_hole_with_rect_pad" ||
        element.shape === "rotated_pill_hole_with_rect_pad")
    ) {
      const platedLayers = new Set<string>(element.layers);
      valid = positive(
        element.hole_width,
        element.hole_height,
        element.rect_pad_width,
        element.rect_pad_height,
      ) && element.rect_pad_width > element.hole_width &&
        element.rect_pad_height > element.hole_height &&
        platedLayers.size === expectedThroughLayers.length &&
        expectedThroughLayers.every((layer) => platedLayers.has(layer)) &&
        finiteWhenPresent(
          element.soldermask_margin,
          "ccw_rotation" in element ? element.ccw_rotation : undefined,
        ) &&
        Math.min(element.rect_pad_width, element.rect_pad_height) / 2 +
          (element.soldermask_margin ?? 0) > 0;
      if (
        valid && profile !== undefined &&
        (belowMinimum(Math.min(element.hole_width, element.hole_height), profile.minimumDrillMm) ||
          belowMinimum((element.rect_pad_width - element.hole_width) / 2, profile.minimumAnnularRingMm) ||
          belowMinimum((element.rect_pad_height - element.hole_height) / 2, profile.minimumAnnularRingMm))
      ) belowProfileMinimum.push(elementId(element));
    } else if (element.type === "pcb_hole" && element.hole_shape === "circle") {
      valid = positive(element.hole_diameter) &&
        finiteWhenPresent(element.soldermask_margin) &&
        element.hole_diameter / 2 + (element.soldermask_margin ?? 0) > 0;
      if (
        valid && profile !== undefined &&
        belowMinimum(element.hole_diameter, profile.minimumDrillMm)
      ) belowProfileMinimum.push(elementId(element));
    } else if (element.type === "pcb_smtpad") {
      const maskMargins = element as typeof element & {
        soldermask_margin_left?: number;
        soldermask_margin_top?: number;
        soldermask_margin_right?: number;
        soldermask_margin_bottom?: number;
      };
      const margin = element.soldermask_margin ?? 0;
      valid = (element.layer === "top" || element.layer === "bottom") &&
        finiteWhenPresent(
          element.soldermask_margin,
          maskMargins.soldermask_margin_left,
          maskMargins.soldermask_margin_top,
          maskMargins.soldermask_margin_right,
          maskMargins.soldermask_margin_bottom,
          element.solderpaste_margin,
        ) &&
        (element.shape === "circle"
        ? positive(element.radius) &&
          (element.is_covered_with_solder_mask === true || element.radius + margin > 0)
        : element.shape === "rect"
          ? positive(element.width, element.height) &&
            (element.is_covered_with_solder_mask === true || (
              element.width + (maskMargins.soldermask_margin_left ?? margin) +
                  (maskMargins.soldermask_margin_right ?? margin) > 0 &&
              element.height + (maskMargins.soldermask_margin_top ?? margin) +
                  (maskMargins.soldermask_margin_bottom ?? margin) > 0
            ))
          : true);
    } else if (element.type === "pcb_solder_paste") {
      valid = element.shape === "circle"
        ? positive(element.radius)
        : element.shape === "rect"
          ? positive(element.width, element.height)
          : true;
    } else if (element.type === "pcb_trace") {
      valid = element.route.every((point) => {
        if (point.route_type === "through_pad") {
          return positive(point.width) &&
            [point.start.x, point.start.y, point.end.x, point.end.y].every(
              (value) => Number.isFinite(value),
            );
        }
        if (!(Number.isFinite(point.x) && Number.isFinite(point.y))) return false;
        if (point.route_type === "wire") {
          if (!expectedThroughLayers.includes(point.layer)) return false;
          if (
            positive(point.width) && profile !== undefined &&
            belowMinimum(point.width, profile.minimumTraceWidthMm)
          ) belowProfileMinimum.push(`${elementId(element)}:route:${point.x},${point.y}`);
          return positive(point.width);
        }
        if (point.route_type === "via") {
          const dimensions = [point.hole_diameter, point.outer_diameter];
          const dimensionsValid = expectedThroughLayers.includes(point.from_layer) &&
            expectedThroughLayers.includes(point.to_layer) &&
            (dimensions.every((value) => value === undefined) ||
              (positive(...dimensions) && point.outer_diameter! > point.hole_diameter!));
          if (
            dimensionsValid && profile !== undefined &&
            point.hole_diameter !== undefined && point.outer_diameter !== undefined &&
            (belowMinimum(point.hole_diameter, profile.minimumDrillMm) ||
              belowMinimum((point.outer_diameter - point.hole_diameter) / 2,
                profile.minimumAnnularRingMm)
          )) belowProfileMinimum.push(`${elementId(element)}:via:${point.x},${point.y}`);
          return dimensionsValid;
        }
        return true;
      });
    }
    if (!valid) invalid.push(elementId(element));
  }

  const diagnostics: Readonly<Diagnostic>[] = [];
  if (boards.length !== 1) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_BOARD_COUNT_001"),
    severity: "error",
    dimension: "fabrication",
    message: `Fulmetry requires exactly one manufactured board; Circuit JSON contains ${boards.length}`,
    waiverPolicy: "forbidden",
    objects: [`pcb-board-count:${boards.length}`],
    sourceLocations: [],
    evidence: [`circuit-json:pcb_board:${boards.length}`],
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_BOARD_COUNT_001",
  }));
  if (!sourceBoardStructureValid) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_BOARD_STRUCTURE_001"),
    severity: "error",
    dimension: "fabrication",
    message: "Fulmetry requires exactly one authored source board mapped to the one manufactured PCB board",
    waiverPolicy: "forbidden",
    objects: [
      ...sourceBoards.map(({ source_board_id }) => source_board_id),
      ...boards.map(({ pcb_board_id }) => pcb_board_id),
    ],
    sourceLocations: [],
    evidence: [
      `circuit-json:source_board:${sourceBoards.length}`,
      `circuit-json:pcb_board:${boards.length}`,
    ],
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_BOARD_STRUCTURE_001",
  }));
  if (unsupportedBoardMaterials.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_BOARD_MATERIAL_001"),
    severity: "error",
    dimension: "fabrication",
    message: `Board substrate material is outside ${profile!.name}@${profile!.version}'s qualified capability`,
    waiverPolicy: "forbidden",
    objects: unsupportedBoardMaterials,
    sourceLocations: [],
    evidence: [
      `profile:${profile!.digest}`,
      `supported-board-materials:${profile!.supportedBoardMaterials.join(",")}`,
    ],
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_BOARD_MATERIAL_001",
  }));
  if (componentMappingFailures.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_COMPONENT_MAPPING_001"),
    severity: "error",
    dimension: "fabrication",
    message: "Every authored source component must resolve to exactly one manufactured PCB component, and every PCB component must resolve back to exactly one source component",
    waiverPolicy: "forbidden",
    objects: componentMappingFailures,
    sourceLocations: [],
    evidence: componentMappingFailures.map((object) => `circuit-json:${object}`),
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_COMPONENT_MAPPING_001",
  }));
  if (invalid.length > 0) diagnostics.push(defineDiagnostic({
      id: diagnosticId("FAB_DIMENSION_001"),
      severity: "error",
      dimension: "fabrication",
      message: "Manufactured geometry has non-positive dimensions, an impossible annular ring, unsupported layer count, or unsupported via span",
      waiverPolicy: "forbidden",
      objects: invalid,
      sourceLocations: [],
      evidence: invalid.map((id) => `circuit-json:${id}`),
      nextCommand: "fulmetry inspect --status fabrication --rule FAB_DIMENSION_001",
    }));
  if (belowProfileMinimum.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_PROFILE_MINIMUM_001"),
    severity: "error",
    dimension: "fabrication",
    message: `Geometry is below ${profile!.name}@${profile!.version} minimum trace, drill, or annular-ring rules`,
    waiverPolicy: "allowed",
    objects: [...new Set(belowProfileMinimum)].sort(),
    sourceLocations: [],
    evidence: [`profile:${profile!.digest}`],
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_PROFILE_MINIMUM_001",
  }));
  if (routeConstraintFailures.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_ROUTE_CONSTRAINT_001"),
    severity: "error",
    dimension: "fabrication",
    message: "Physical routing violates an authored minimum-width or maximum-length constraint",
    waiverPolicy: "allowed",
    objects: [...new Set(routeConstraintFailures)].sort(),
    sourceLocations: [],
    evidence: routeConstraintFailures.map((object) => `circuit-json:${object}`),
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_ROUTE_CONSTRAINT_001",
  }));
  if (routeConstraintUnsupported.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_ROUTE_CONSTRAINT_UNSUPPORTED_001"),
    severity: "warning",
    dimension: "fabrication",
    message: "An authored routing constraint cannot be measured against exactly mapped physical route geometry",
    waiverPolicy: "forbidden",
    objects: [...new Set(routeConstraintUnsupported)].sort(),
    sourceLocations: [],
    evidence: routeConstraintUnsupported.map((object) => `circuit-json:${object}`),
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_ROUTE_CONSTRAINT_UNSUPPORTED_001",
  }));
  if (temporaryManufacturedNames.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_TEMPORARY_COMPONENT_NAME_001"),
    severity: "warning",
    dimension: "fabrication",
    message: "Deterministic temporary component names are allowed during development but must be replaced before manufacturing verification",
    waiverPolicy: "forbidden",
    objects: temporaryManufacturedNames,
    sourceLocations: [],
    evidence: temporaryManufacturedNames.map((object) => `circuit-json:${object}`),
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_TEMPORARY_COMPONENT_NAME_001",
  }));
  const geometry = profile === undefined
    ? undefined
    : assessBaselineGeometry(circuitJson, profile, authoritativeConnectivity);
  if (authoritativeConnectivity.connectivityFailures.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_CONNECTIVITY_001"),
    severity: "error",
    dimension: "fabrication",
    message: "Manufactured ports do not form the complete declared physical connectivity graph",
    waiverPolicy: "forbidden",
    objects: authoritativeConnectivity.connectivityFailures,
    sourceLocations: [],
    evidence: authoritativeConnectivity.connectivityFailures.map((item) => `circuit-json:${item}`),
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_CONNECTIVITY_001",
  }));
  if (authoritativeConnectivity.unsupported.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_CONNECTIVITY_UNSUPPORTED_001"),
    severity: "warning",
    dimension: "fabrication",
    message: "One or more logical connectivity constructs lack qualified physical proof",
    waiverPolicy: "forbidden",
    objects: authoritativeConnectivity.unsupported,
    sourceLocations: [],
    evidence: authoritativeConnectivity.unsupported.map((item) => `circuit-json:${item}`),
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_CONNECTIVITY_UNSUPPORTED_001",
  }));
  const netIdentityFailures = [
    ...authoritativeConnectivity.netIdentityFailures,
    ...(geometry?.netIdentity ?? []),
  ];
  for (const [id, message, objects] of [
    ["FAB_COPPER_CLEARANCE_001", "Different-net copper is below the active profile clearance", geometry?.copperClearance],
    ["FAB_BOARD_EDGE_001", "Copper or a mechanical hole is below the active profile board-edge clearance", geometry?.edgeClearance],
    ["FAB_MASK_SLIVER_001", "Solder-mask web is below the active profile minimum", geometry?.maskSliver],
    ["FAB_COMPONENT_PLACEMENT_001", "A manufactured component is outside the board profile", geometry?.componentPlacement],
    ["FAB_COMPONENT_OVERLAP_001", "Manufactured component bodies overlap on the same assembly side", geometry?.componentOverlap],
    ["FAB_COURTYARD_OVERLAP_001", "Component courtyards overlap on the same assembly side", geometry?.courtyardOverlap],
    ["FAB_COURTYARD_EDGE_001", "A component courtyard extends beyond the board profile", geometry?.courtyardEdge],
    ["FAB_COURTYARD_INTEGRITY_001", "A courtyard lacks one same-side owner or does not contain its component body", geometry?.courtyardIntegrity],
    ["FAB_PASTE_APERTURE_001", "A paste aperture has no unique aligned containing pad on the same side", geometry?.pasteAperture],
    ["FAB_PASTE_COMPLETENESS_001", "A populated SMT pad lacks exactly one explicit paste aperture", geometry?.pasteCompleteness],
    ["FAB_PAD_OWNER_INTEGRITY_001", "An owned pad or mechanical hole contradicts its component, courtyard, or PCB port", geometry?.padOwnerIntegrity],
    ["FAB_GEOMETRY_IDENTITY_001", "Manufactured geometry reuses a primary identity", geometry?.geometryIdentity],
    ["FAB_NET_IDENTITY_001", "Copper net identity fields alias or contradict authoritative logical ownership", netIdentityFailures],
    ["FAB_KEEPOUT_001", "Copper intersects an authored rectangular layer keepout", geometry?.keepoutViolations],
  ] as const) {
    if (objects !== undefined && objects.length > 0) diagnostics.push(defineDiagnostic({
      id: diagnosticId(id),
      severity: "error",
      dimension: "fabrication",
      message,
      waiverPolicy: WAIVABLE_FABRICATION_RULES.has(id) ? "allowed" : "forbidden",
      objects,
      sourceLocations: [],
      evidence: profile === undefined
        ? objects.map((object) => `circuit-json:${object}`)
        : [`profile:${profile.digest}`],
      nextCommand: `fulmetry inspect --status fabrication --rule ${id}`,
    }));
  }
  if (geometry !== undefined && geometry.unsupported.length > 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_GEOMETRY_UNSUPPORTED_001"),
    severity: "warning",
    dimension: "fabrication",
    message: "The active profile has no independent geometry evaluator for one or more constructs",
    waiverPolicy: "forbidden",
    objects: geometry.unsupported,
    sourceLocations: [],
    evidence: [`profile:${profile!.digest}`],
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_GEOMETRY_UNSUPPORTED_001",
  }));
  if (profile === undefined && invalid.length === 0) diagnostics.push(defineDiagnostic({
    id: diagnosticId("FAB_PROFILE_REQUIRED_001"),
    severity: "warning",
    dimension: "fabrication",
    message: "Fabrication verification requires an active, immutable rule profile",
    waiverPolicy: "forbidden",
    objects: [],
    sourceLocations: [],
    evidence: [],
    nextCommand: "fulmetry inspect --status fabrication --rule FAB_PROFILE_REQUIRED_001",
  }));
  const hasGeometryFailure = geometry !== undefined && (
    geometry.copperClearance.length > 0 || geometry.edgeClearance.length > 0 ||
    geometry.maskSliver.length > 0 || geometry.componentPlacement.length > 0 ||
    geometry.componentOverlap.length > 0 || geometry.courtyardOverlap.length > 0 ||
    geometry.courtyardEdge.length > 0 || geometry.courtyardIntegrity.length > 0 ||
    geometry.pasteAperture.length > 0 || geometry.pasteCompleteness.length > 0 ||
    geometry.padOwnerIntegrity.length > 0 || geometry.geometryIdentity.length > 0 ||
    geometry.netIdentity.length > 0 || geometry.keepoutViolations.length > 0
  );
  const hasConnectivityFailure = authoritativeConnectivity.connectivityFailures.length > 0 ||
    authoritativeConnectivity.netIdentityFailures.length > 0;
  const state = invalid.length > 0 || !sourceBoardStructureValid ||
      componentMappingFailures.length > 0 ||
      unsupportedBoardMaterials.length > 0 ||
      belowProfileMinimum.length > 0 || hasGeometryFailure ||
      routeConstraintFailures.length > 0 || hasConnectivityFailure
    ? "failed"
    : profile === undefined || (geometry?.unsupported.length ?? 0) > 0 ||
        authoritativeConnectivity.unsupported.length > 0 || temporaryManufacturedNames.length > 0
        || routeConstraintUnsupported.length > 0
      ? "incomplete"
      : "passed";
  return Object.freeze({
    status: assuranceStatus("fabrication", state, {
      diagnosticIds: diagnostics.map(({ id }) => id),
      summary: state === "passed"
        ? `Checked against profile ${profile!.name}@${profile!.version}`
        : state === "incomplete"
          ? "Fabrication verification is incomplete"
          : `${invalid.length + belowProfileMinimum.length + componentMappingFailures.length + unsupportedBoardMaterials.length + (sourceBoardStructureValid ? 0 : 1)} fabrication rule violation(s)`,
    }),
    diagnostics: Object.freeze(diagnostics),
  });
}
