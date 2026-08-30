// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "tscircuit";
import {
  glyphAdvanceRatio,
  glyphWidthRatio,
  letterSpacingRatio,
  lineAlphabet,
  spaceWidthRatio,
  strokeWidthRatio,
} from "@tscircuit/alphabet";
import { formatSI } from "format-si-prefix";
import {
  isDeterministicTemporaryComponentName,
  isStableAssemblyDesignator,
} from "../component-identity";
import { deriveAuthoritativeConnectivity } from "../authoritative-connectivity";
import {
  BASELINE_FABRICATION_PROFILE,
  isBaselineSupportedBoardMaterial,
} from "../profiles/baseline";

type SourceComponentElement = Extract<
  AnyCircuitElement,
  { type: "source_component" }
>;
type PcbComponentElement = Extract<AnyCircuitElement, { type: "pcb_component" }>;

const EXPECTED_SAFE_SUPPLIER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXPECTED_SAFE_PART_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:+/#@()-]{0,127}$/;
function isExpectedSafeOptionalPartIdentity(value: unknown): boolean {
  return value === undefined || value === "" ||
    (typeof value === "string" && EXPECTED_SAFE_PART_IDENTITY.test(value));
}

function expectedManufacturerPartNumber(value: unknown): string {
  return typeof value === "string" && EXPECTED_SAFE_PART_IDENTITY.test(value) ? value : "";
}

function expectedBomSupplierIdentity(
  supplierPartNumbers: unknown,
): Readonly<{
  supplier: string;
  partNumber: string;
  jlcpcbPartNumber: string;
}> | undefined {
  if (
    typeof supplierPartNumbers !== "object" ||
    supplierPartNumbers === null ||
    Array.isArray(supplierPartNumbers)
  ) return undefined;
  const entries = Object.entries(supplierPartNumbers as Record<string, unknown>);
  if (entries.length !== 1) return undefined;
  const entry = entries[0]!;
  const provider = entry[0];
  const partNumbers = entry[1];
  if (
    provider.trim() !== provider ||
    !EXPECTED_SAFE_SUPPLIER_NAME.test(provider) ||
    !Array.isArray(partNumbers) ||
    partNumbers.length !== 1
  ) return undefined;
  const partNumber = partNumbers[0];
  if (
    typeof partNumber !== "string" ||
    !EXPECTED_SAFE_PART_IDENTITY.test(partNumber)
  ) return undefined;
  const normalized = provider.toLowerCase();
  return {
    supplier: normalized === "jlcpcb"
      ? "JLCPCB"
      : normalized === "lcsc"
        ? "LCSC"
        : provider,
    partNumber,
    jlcpcbPartNumber: normalized === "jlcpcb" || normalized === "lcsc"
      ? partNumber
      : "",
  };
}

type PinnedFootprintPad = Readonly<{
  kind: "smt-rect" | "pth-circle";
  x: number;
  y: number;
  width: number;
  height: number;
  drill: number;
  pin: string;
}>;

const PINNED_FOOTPRINT_PAD_SIGNATURES: Readonly<Record<string, readonly PinnedFootprintPad[]>> =
  Object.freeze({
    res0603: Object.freeze([
      Object.freeze({ kind: "smt-rect", x: -0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "1" }),
      Object.freeze({ kind: "smt-rect", x: 0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "2" }),
    ]),
    "0603": Object.freeze([
      Object.freeze({ kind: "smt-rect", x: -0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "1" }),
      Object.freeze({ kind: "smt-rect", x: 0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "2" }),
    ]),
    "0603_color(green)": Object.freeze([
      Object.freeze({ kind: "smt-rect", x: -0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "1" }),
      Object.freeze({ kind: "smt-rect", x: 0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "2" }),
    ]),
    "0603_color(red)": Object.freeze([
      Object.freeze({ kind: "smt-rect", x: -0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "1" }),
      Object.freeze({ kind: "smt-rect", x: 0.825, y: 0, width: 0.8, height: 0.95, drill: 0, pin: "2" }),
    ]),
    "0805": Object.freeze([
      Object.freeze({ kind: "smt-rect", x: -0.9125, y: 0, width: 1.025, height: 1.4, drill: 0, pin: "1" }),
      Object.freeze({ kind: "smt-rect", x: 0.9125, y: 0, width: 1.025, height: 1.4, drill: 0, pin: "2" }),
    ]),
    pinrow2_nosquareplating: Object.freeze([
      Object.freeze({ kind: "pth-circle", x: -1.27, y: 0, width: 1.5, height: 1.5, drill: 1, pin: "1" }),
      Object.freeze({ kind: "pth-circle", x: 1.27, y: 0, width: 1.5, height: 1.5, drill: 1, pin: "2" }),
    ]),
  });

function roundedSignatureNumber(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function numericPinHint(element: { readonly port_hints?: readonly string[] | undefined }): string {
  const numericHints = [...new Set(
    element.port_hints?.filter((hint) => /^\d+$/.test(hint)) ?? [],
  )];
  return numericHints.length === 1 ? numericHints[0]! : "";
}

function padCenter(
  pad: Extract<AnyCircuitElement, { type: "pcb_smtpad" | "pcb_plated_hole" }>,
): Readonly<{ x: number; y: number }> | undefined {
  return "x" in pad && "y" in pad &&
      typeof pad.x === "number" && typeof pad.y === "number"
    ? { x: pad.x, y: pad.y }
    : undefined;
}

const PINNED_TWO_PIN_SEMANTIC_FTYPES = new Set([
  "simple_capacitor",
  "simple_diode",
  "simple_led",
  "simple_power_source",
  "simple_resistor",
]);

function semanticHintPinIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (["a", "anode", "pos", "left"].includes(normalized)) return "1";
  if (["k", "cathode", "neg", "right"].includes(normalized)) return "2";
  return undefined;
}

function consistentSourcePinIdentity(
  source: SourceComponentElement,
  sourcePort: Extract<AnyCircuitElement, { type: "source_port" }>,
): string {
  const pinNumber = String(sourcePort.pin_number ?? "").trim();
  if (!/^\d+$/.test(pinNumber)) return "";
  if (numericPinHint(sourcePort) !== pinNumber) return "";
  const pinNameIdentities = [sourcePort.name, ...(sourcePort.port_hints ?? [])]
    .flatMap((value) => {
      const match = /^pin(\d+)$/i.exec(value);
      return match === null ? [] : [match[1]!];
    });
  if (
    pinNameIdentities.length > 0 &&
    pinNameIdentities.some((identity) => identity !== pinNumber)
  ) return "";
  if (PINNED_TWO_PIN_SEMANTIC_FTYPES.has(source.ftype)) {
    const hints = new Set(sourcePort.port_hints ?? []);
    const semanticIdentities = [...hints]
      .map(semanticHintPinIdentity)
      .filter((identity): identity is string => identity !== undefined);
    if (semanticIdentities.some((identity) => identity !== pinNumber)) return "";
  }
  return pinNumber;
}

function serializedPadSignature(pads: readonly PinnedFootprintPad[]): string {
  return pads.map((pad) => [
    pad.kind,
    roundedSignatureNumber(pad.x),
    roundedSignatureNumber(pad.y),
    roundedSignatureNumber(pad.width),
    roundedSignatureNumber(pad.height),
    roundedSignatureNumber(pad.drill),
    pad.pin,
  ].join(":"))
    .sort()
    .join("|");
}

function matchesPinnedFootprintPadSignature(
  footprint: string,
  component: PcbComponentElement,
  pads: readonly Extract<AnyCircuitElement, { type: "pcb_smtpad" | "pcb_plated_hole" }>[],
): boolean {
  const expected = PINNED_FOOTPRINT_PAD_SIGNATURES[footprint];
  if (expected === undefined || expected.length !== pads.length) return false;
  const actual: PinnedFootprintPad[] = [];
  for (const pad of pads) {
    if (pad.type === "pcb_smtpad") {
      if (pad.shape !== "rect") return false;
      actual.push({
        kind: "smt-rect",
        x: pad.x - component.center.x,
        y: pad.y - component.center.y,
        width: pad.width,
        height: pad.height,
        drill: 0,
        pin: numericPinHint(pad),
      });
    } else {
      if (pad.shape !== "circle") return false;
      actual.push({
        kind: "pth-circle",
        x: pad.x - component.center.x,
        y: pad.y - component.center.y,
        width: pad.outer_diameter,
        height: pad.outer_diameter,
        drill: pad.hole_diameter,
        pin: numericPinHint(pad),
      });
    }
  }
  const actualSignature = serializedPadSignature(actual);
  const rotation = ((component.rotation % 360) + 360) % 360;
  const transform = rotation === 0
    ? (pad: PinnedFootprintPad) => ({ ...pad, x: pad.x, y: pad.y })
    : rotation === 90
      ? (pad: PinnedFootprintPad) => ({ ...pad, x: pad.y, y: -pad.x, width: pad.height, height: pad.width })
      : rotation === 180
        ? (pad: PinnedFootprintPad) => ({ ...pad, x: -pad.x, y: -pad.y })
        : rotation === 270
          ? (pad: PinnedFootprintPad) => ({ ...pad, x: -pad.y, y: pad.x, width: pad.height, height: pad.width })
          : undefined;
  return transform !== undefined &&
    serializedPadSignature(expected.map(transform)) === actualSignature;
}

function matchesSourceBoundCustomFootprintPadSignature(
  source: SourceComponentElement,
  component: PcbComponentElement,
  pads: readonly Extract<AnyCircuitElement, { type: "pcb_smtpad" | "pcb_plated_hole" }>[],
): boolean {
  if (
    pads.length === 0 || pads.length > 512 ||
    !isExpectedSafeOptionalPartIdentity(source.manufacturer_part_number) ||
    source.manufacturer_part_number === undefined ||
    !Number.isFinite(component.center.x) || !Number.isFinite(component.center.y) ||
    !Number.isFinite(component.rotation)
  ) return false;
  const signatures = pads.flatMap((pad): string[] => {
    const pin = numericPinHint(pad);
    if (pad.type === "pcb_smtpad") {
      if (
        (pad.shape !== "rect" && pad.shape !== "circle") ||
        ![pad.x, pad.y].every(Number.isFinite)
      ) return [];
      const x = roundedSignatureNumber(pad.x - component.center.x);
      const y = roundedSignatureNumber(pad.y - component.center.y);
      const width = pad.shape === "circle" ? pad.radius * 2 : pad.width;
      const height = pad.shape === "circle" ? pad.radius * 2 : pad.height;
      if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
      return [["smt", pad.shape, x, y, roundedSignatureNumber(width),
        roundedSignatureNumber(height), pin].join(":")];
    }
    const x = roundedSignatureNumber(pad.x - component.center.x);
    const y = roundedSignatureNumber(pad.y - component.center.y);
    if (pad.shape === "circle") {
      if (
        ![pad.outer_diameter, pad.hole_diameter, pad.x, pad.y].every(Number.isFinite) ||
        pad.hole_diameter <= 0 || pad.outer_diameter <= pad.hole_diameter
      ) return [];
      return [["pth", "circle", x, y, roundedSignatureNumber(pad.outer_diameter),
        roundedSignatureNumber(pad.hole_diameter), pin].join(":")];
    }
    if (
      pad.shape !== "pill_hole_with_rect_pad" &&
      pad.shape !== "rotated_pill_hole_with_rect_pad"
    ) return [];
    if (
      ![pad.rect_pad_width, pad.rect_pad_height, pad.hole_width, pad.hole_height, pad.x, pad.y]
        .every(Number.isFinite) ||
      pad.hole_width <= 0 || pad.hole_height <= 0 ||
      pad.rect_pad_width <= pad.hole_width || pad.rect_pad_height <= pad.hole_height
    ) return [];
    return [["pth", pad.shape, x, y, roundedSignatureNumber(pad.rect_pad_width),
      roundedSignatureNumber(pad.rect_pad_height), roundedSignatureNumber(pad.hole_width),
      roundedSignatureNumber(pad.hole_height), pin].join(":")];
  });
  return signatures.length === pads.length && new Set(signatures).size === signatures.length;
}

export interface ExpectedPoint {
  readonly x: number;
  readonly y: number;
  readonly source: string;
}

export interface ExpectedFlash extends ExpectedPoint {
  readonly shape: "circle" | "rect";
  readonly dimensions: readonly number[];
}

export interface ExpectedSegment {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly width: number;
  readonly source: string;
}

export interface ExpectedDrillHit extends ExpectedPoint {
  readonly diameter: number;
  /** Routed-slot centerline. Absent for an ordinary circular drill hit. */
  readonly slot?: Readonly<{
    readonly startX: number;
    readonly startY: number;
    readonly endX: number;
    readonly endY: number;
  }>;
}

function platedSlotGeometry(element: Extract<AnyCircuitElement, { type: "pcb_plated_hole" }>): Readonly<{
  drill: ExpectedDrillHit;
  padWidth: number;
  padHeight: number;
}> | undefined {
  if (
    element.shape !== "pill_hole_with_rect_pad" &&
    element.shape !== "rotated_pill_hole_with_rect_pad"
  ) return undefined;
  const holeWidth = element.hole_width;
  const holeHeight = element.hole_height;
  const padWidth = element.rect_pad_width;
  const padHeight = element.rect_pad_height;
  if (![holeWidth, holeHeight, padWidth, padHeight, element.x, element.y].every(Number.isFinite)) {
    return undefined;
  }
  const diameter = Math.min(holeWidth, holeHeight);
  const halfTravel = (Math.max(holeWidth, holeHeight) - diameter) / 2;
  const vertical = holeHeight >= holeWidth;
  const rotatedShape = element.shape === "rotated_pill_hole_with_rect_pad";
  const authoredRotation = "ccw_rotation" in element &&
      typeof element.ccw_rotation === "number"
    ? element.ccw_rotation
    : 0;
  const rotation = ((authoredRotation + (rotatedShape ? 90 : 0)) * Math.PI) / 180;
  const dx = vertical ? 0 : halfTravel;
  const dy = vertical ? halfTravel : 0;
  const rx = dx * Math.cos(rotation) - dy * Math.sin(rotation);
  const ry = dx * Math.sin(rotation) + dy * Math.cos(rotation);
  return Object.freeze({
    drill: Object.freeze({
      x: element.x,
      y: element.y,
      diameter,
      source: element.pcb_plated_hole_id,
      slot: Object.freeze({
        startX: element.x - rx,
        startY: element.y - ry,
        endX: element.x + rx,
        endY: element.y + ry,
      }),
    }),
    padWidth: rotatedShape ? padHeight : padWidth,
    padHeight: rotatedShape ? padWidth : padHeight,
  });
}

export interface ExpectedPlacement extends ExpectedPoint {
  readonly designator: string;
  readonly layer: "top" | "bottom";
  readonly rotation: number;
}

export interface ExpectedBomRow {
  readonly columns: Readonly<Record<string, string>>;
}

export interface ExpectedAssemblyAuthority {
  readonly sourceComponentId: string;
  readonly pcbComponentId: string;
  readonly designator: string;
  readonly role: "assembled" | "test-point";
  readonly dnp: boolean;
  readonly bomRequired: boolean;
  readonly placementRequired: boolean;
  readonly padSources: readonly string[];
}

export const MANUFACTURING_BOM_HEADERS = Object.freeze([
  "Designator",
  "Quantity",
  "Comment",
  "Value",
  "Footprint",
  "Manufacturer",
  "Manufacturer Part Number",
  "Supplier",
  "Supplier Part Number",
  "JLCPCB Part #",
] as const);

export interface ExpectedUnsupportedDetail {
  readonly message: string;
  readonly objects: readonly string[];
  readonly measurement?: Readonly<{
    readonly actual: string;
    readonly required?: string;
  }>;
}

export interface ManufacturingExpectation {
  readonly boardName: string;
  readonly layerCount: 2 | 4;
  readonly board: {
    readonly centerX: number;
    readonly centerY: number;
    readonly width: number;
    readonly height: number;
    readonly thickness: number;
    readonly material: string;
  };
  readonly flashes: Readonly<Record<string, readonly ExpectedFlash[]>>;
  readonly copperSegments: Readonly<Record<string, readonly ExpectedSegment[]>>;
  readonly silkscreenSegments: Readonly<Record<string, readonly ExpectedSegment[]>>;
  /** Circuit-derived authority for baseline full-stack plated holes and vias. */
  readonly platedThroughSources: readonly string[];
  readonly platedDrills: readonly ExpectedDrillHit[];
  readonly nonPlatedDrills: readonly ExpectedDrillHit[];
  /** Circuit-derived ownership and assembly requirements for every physical component. */
  readonly assemblyAuthority: readonly ExpectedAssemblyAuthority[];
  readonly bomRows: readonly ExpectedBomRow[];
  readonly bomHeaders: readonly string[];
  readonly placements: readonly ExpectedPlacement[];
  readonly unsupported: readonly string[];
  readonly unsupportedDetails?: readonly ExpectedUnsupportedDetail[];
}

function canonicalExpectationValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Manufacturing expectation contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalExpectationValue);
  if (typeof value !== "object") {
    throw new TypeError(`Manufacturing expectation contains non-JSON ${typeof value}`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalExpectationValue(item)]),
  );
}

/** Content identity binding an independent verifier result to its exact expectation. */
export function manufacturingExpectationSha256(
  expectation: ManufacturingExpectation,
): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonicalExpectationValue(expectation)))
    .digest("hex");
}

function flash(
  point: ExpectedPoint,
  shape: "circle" | "rect",
  ...dimensions: number[]
): ExpectedFlash {
  return { ...point, shape, dimensions };
}

function layerFile(layer: string, layerCount: 2 | 4): string | undefined {
  if (layer === "top") return "F_Cu";
  if (layer === "bottom") return "B_Cu";
  if (layerCount === 4 && layer === "inner1") return "In1_Cu";
  if (layerCount === 4 && layer === "inner2") return "In2_Cu";
  return undefined;
}

function rotatePoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
  degrees: number,
): { x: number; y: number } {
  if (degrees === 0) return point;
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
}

function textAdvance(character: string, fontSize: number): number {
  if (character === " ") return fontSize * spaceWidthRatio;
  return fontSize * (glyphAdvanceRatio[character] ?? glyphWidthRatio);
}

export function deriveManufacturingExpectation(options: {
  readonly boardName: string;
  readonly circuitJson: AnyCircuitElement[];
}): Readonly<ManufacturingExpectation> {
  const boards = options.circuitJson.filter((element) => element.type === "pcb_board");
  if (boards.length !== 1) {
    throw new Error(`Manufacturing expectation requires exactly one board; found ${boards.length}`);
  }
  const board = boards[0]!;
  if (board.num_layers !== 2 && board.num_layers !== 4) {
    throw new Error(`Manufacturing expectation supports 2 or 4 layers; found ${board.num_layers}`);
  }
  const layerCount = board.num_layers;
  if (typeof board.width !== "number" || typeof board.height !== "number") {
    throw new Error(
      "Only rectangular boards with explicit width and height are independently verified",
    );
  }
  const copperLayers = [
    "F_Cu",
    ...(layerCount === 4 ? ["In1_Cu", "In2_Cu"] : []),
    "B_Cu",
  ];
  const flashes: Record<string, ExpectedFlash[]> = Object.fromEntries(
    [
      ...copperLayers,
      "F_Mask",
      "B_Mask",
      "F_Paste",
      "B_Paste",
    ].map(
      (layer) => [layer, []],
    ),
  );
  const copperSegments: Record<string, ExpectedSegment[]> = Object.fromEntries(
    copperLayers.map((layer) => [layer, []]),
  );
  const silkscreenSegments: Record<string, ExpectedSegment[]> = {
    F_SilkScreen: [],
    B_SilkScreen: [],
  };
  const platedDrills: ExpectedDrillHit[] = [];
  const nonPlatedDrills: ExpectedDrillHit[] = [];
  const unsupported: string[] = [];
  const unsupportedDetails: ExpectedUnsupportedDetail[] = [];
  if (!isBaselineSupportedBoardMaterial(board.material)) {
    const message = `${board.pcb_board_id}: board material ${JSON.stringify(board.material)} is outside the baseline manufacturing capability`;
    unsupported.push(message);
    unsupportedDetails.push({
      message,
      objects: [`${board.pcb_board_id}.material`],
      measurement: {
        actual: JSON.stringify(board.material),
        required: BASELINE_FABRICATION_PROFILE.supportedBoardMaterials.join(" or "),
      },
    });
  }
  if (!Number.isFinite(board.thickness)) {
    throw new Error(
      `${board.pcb_board_id}: board thickness must be a finite positive millimetre value`,
    );
  }
  if (board.thickness <= 0) {
    const message = `${board.pcb_board_id}: board thickness must be strictly positive`;
    unsupported.push(message);
    unsupportedDetails.push({
      message,
      objects: [board.pcb_board_id],
      measurement: {
        actual: `${board.thickness}mm`,
        required: "> 0mm",
      },
    });
  }
  const sourceBoards = options.circuitJson.filter((element) => element.type === "source_board");
  const manufacturedSourceBoardId = (
    board as unknown as { source_board_id?: unknown }
  ).source_board_id;
  if (
    sourceBoards.length !== 1 ||
    sourceBoards[0]?.source_board_id !== manufacturedSourceBoardId
  ) {
    unsupported.push(
      `${board.pcb_board_id}: exactly one authored source board must map to the manufactured board`,
    );
  }
  if (board.outline !== undefined && board.outline.length > 0) {
    unsupported.push(
      `${board.pcb_board_id}: custom board outlines are not yet independently topology-verified`,
    );
  }

  for (const element of options.circuitJson) {
    if (
      element.type === "pcb_copper_pour" ||
      element.type === "pcb_copper_text" ||
      element.type === "pcb_cutout" ||
      element.type === "pcb_panel"
    ) {
      unsupported.push(
        `${"pcb_copper_pour_id" in element
          ? element.pcb_copper_pour_id
          : "pcb_copper_text_id" in element
            ? element.pcb_copper_text_id
            : "pcb_cutout_id" in element
              ? element.pcb_cutout_id
              : element.pcb_panel_id}: ${element.type} is not yet independently reconciled`,
      );
      continue;
    }
    if (element.type === "pcb_silkscreen_path") {
      const file = element.layer === "top" ? "F_SilkScreen" :
        element.layer === "bottom" ? "B_SilkScreen" : undefined;
      if (file === undefined || typeof element.stroke_width !== "number") {
        unsupported.push(
          `${element.pcb_silkscreen_path_id}: unsupported silkscreen path layer or stroke width`,
        );
        continue;
      }
      for (let index = 0; index < element.route.length - 1; index += 1) {
        const start = element.route[index]!;
        const end = element.route[index + 1]!;
        silkscreenSegments[file]!.push({
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          width: element.stroke_width,
          source: element.pcb_silkscreen_path_id,
        });
      }
      continue;
    }
    if (element.type === "pcb_silkscreen_text") {
      const file = element.layer === "top" ? "F_SilkScreen" :
        element.layer === "bottom" ? "B_SilkScreen" : undefined;
      if (
        file === undefined || element.font !== "tscircuit2024" ||
        element.is_knockout === true
      ) {
        unsupported.push(
          `${element.pcb_silkscreen_text_id}: only non-knockout tscircuit2024 outer-layer text is independently verified`,
        );
        continue;
      }
      const capHeight = element.font_size * 0.7;
      const spacing = element.font_size * letterSpacingRatio;
      const textWidth = [...element.text].reduce(
        (width, character) => width + textAdvance(character, element.font_size),
        Math.max(0, element.text.length - 1) * spacing,
      );
      const alignment = element.anchor_alignment ?? "center";
      let anchoredX = element.anchor_position.x;
      let anchoredY = element.anchor_position.y;
      if (alignment === "top_center") anchoredX -= textWidth / 2;
      else if (alignment === "top_right") anchoredX -= textWidth;
      else if (alignment === "center_right") anchoredY -= capHeight / 2;
      else if (alignment === "center_left") {
        anchoredX -= textWidth;
        anchoredY -= capHeight / 2;
      } else if (alignment === "bottom_left") anchoredY -= capHeight;
      else if (alignment === "bottom_center") {
        anchoredX -= textWidth / 2;
        anchoredY -= capHeight;
      } else if (alignment === "bottom_right") {
        anchoredX -= textWidth;
        anchoredY -= capHeight;
      } else if (alignment !== "top_left") {
        anchoredX -= textWidth / 2;
        anchoredY -= capHeight / 2;
      }
      const center = { x: anchoredX + textWidth / 2, y: anchoredY + capHeight / 2 };
      const mirrored = element.is_mirrored ?? element.layer === "bottom";
      const rotation = mirrored ? -(element.ccw_rotation ?? 0) : element.ccw_rotation ?? 0;
      const transform = (point: { x: number; y: number }) => {
        const rotated = rotatePoint(point, center, rotation);
        return mirrored ? { x: center.x * 2 - rotated.x, y: rotated.y } : rotated;
      };
      for (const character of element.text) {
        if (character !== " ") {
          for (const line of lineAlphabet[character] ?? []) {
            const start = transform({
              x: anchoredX + line.x1 * capHeight,
              y: anchoredY + line.y1 * capHeight,
            });
            const end = transform({
              x: anchoredX + line.x2 * capHeight,
              y: anchoredY + line.y2 * capHeight,
            });
            silkscreenSegments[file]!.push({
              startX: start.x,
              startY: start.y,
              endX: end.x,
              endY: end.y,
              width: element.font_size * strokeWidthRatio,
              source: element.pcb_silkscreen_text_id,
            });
          }
        }
        anchoredX += textAdvance(character, element.font_size) + spacing;
      }
      continue;
    }
    if (element.type.startsWith("pcb_silkscreen")) {
      unsupported.push(`${element.type}: silkscreen construct is not independently reconciled`);
      continue;
    }
    if (element.type === "pcb_smtpad") {
      if (element.pcb_component_id === null || element.pcb_component_id === undefined) {
        unsupported.push(
          `${element.pcb_smtpad_id}: ownerless SMT pad or fiducial mask semantics are not independently reconciled`,
        );
      }
      if (element.shape !== "circle" && element.shape !== "rect") {
        unsupported.push(
          `${element.pcb_smtpad_id}: ${element.shape} SMT pads are not yet independently reconciled`,
        );
        continue;
      }
      const file = layerFile(element.layer, layerCount);
      if (file === undefined) {
        unsupported.push(`${element.pcb_smtpad_id}: SMT pad uses unsupported layer ${element.layer}`);
      } else {
        const point = { x: element.x, y: element.y, source: element.pcb_smtpad_id };
        const dimensions = element.shape === "circle"
          ? [element.radius * 2]
          : [element.width, element.height];
        flashes[file]!.push(flash(point, element.shape, ...dimensions));
        if (element.is_covered_with_solder_mask !== true &&
          (element.layer === "top" || element.layer === "bottom")) {
          const margin = element.soldermask_margin ?? 0;
          const mask = element.layer === "top" ? "F_Mask" : "B_Mask";
          const hasPerSideMargin = element.shape === "rect" && [
            element.soldermask_margin_left,
            element.soldermask_margin_top,
            element.soldermask_margin_right,
            element.soldermask_margin_bottom,
          ].some((value) => value !== undefined);
          if (element.shape === "rect" && hasPerSideMargin) {
            const left = element.soldermask_margin_left ?? margin;
            const top = element.soldermask_margin_top ?? margin;
            const right = element.soldermask_margin_right ?? margin;
            const bottom = element.soldermask_margin_bottom ?? margin;
            const asymmetric = new Set([left, top, right, bottom]).size > 1;
            unsupported.push(
              `${element.pcb_smtpad_id}: ${asymmetric ? "asymmetric" : "per-side"} solder-mask margins are not supported by the pinned Gerber adapter`,
            );
            flashes[mask]!.push(flash(
              {
                ...point,
                x: point.x + (right - left) / 2,
                y: point.y + (top - bottom) / 2,
              },
              "rect",
              element.width + left + right,
              element.height + top + bottom,
            ));
            continue;
          }
          flashes[mask]!.push(
            flash(
              point,
              element.shape,
              ...dimensions.map((dimension) => dimension + margin * 2),
            ),
          );
        }
      }
    } else if (element.type === "pcb_plated_hole") {
      if (element.pcb_component_id === null || element.pcb_component_id === undefined) {
        unsupported.push(
          `${element.pcb_plated_hole_id}: ownerless plated copper is not an authenticated component pin or via`,
        );
      }
      const slot = platedSlotGeometry(element);
      const circle = element.shape === "circle" ? element : undefined;
      if (circle === undefined && slot === undefined) {
        unsupported.push(
          `${element.pcb_plated_hole_id}: plated-hole shape is not independently verified`,
        );
        continue;
      }
      platedDrills.push(slot?.drill ?? {
        x: element.x,
        y: element.y,
        diameter: circle!.hole_diameter,
        source: element.pcb_plated_hole_id,
      });
      for (const layer of element.layers) {
        const file = layerFile(layer, layerCount);
        if (file === undefined) {
          unsupported.push(`${element.pcb_plated_hole_id}: plated hole uses unsupported layer ${layer}`);
        } else {
          flashes[file]!.push(slot === undefined
            ? flash(
                { x: element.x, y: element.y, source: element.pcb_plated_hole_id },
                "circle",
                circle!.outer_diameter,
              )
            : flash(
                { x: element.x, y: element.y, source: element.pcb_plated_hole_id },
                "rect",
                slot.padWidth,
                slot.padHeight,
              ));
        }
      }
      if (element.is_covered_with_solder_mask !== true) {
        const margin = element.soldermask_margin ?? 0;
        for (const mask of ["F_Mask", "B_Mask"]) {
          flashes[mask]!.push(slot === undefined
            ? flash(
                { x: element.x, y: element.y, source: element.pcb_plated_hole_id },
                "circle",
                circle!.outer_diameter + margin * 2,
              )
            : flash(
                { x: element.x, y: element.y, source: element.pcb_plated_hole_id },
                "rect",
                slot.padWidth + margin * 2,
                slot.padHeight + margin * 2,
              ));
        }
      }
    } else if (element.type === "pcb_via") {
      if (typeof element.pcb_trace_id === "string") {
        const owners = options.circuitJson.filter((candidate) =>
          candidate.type === "pcb_trace" && candidate.pcb_trace_id === element.pcb_trace_id
        );
        const routeMatches = owners.flatMap((owner) => owner.type === "pcb_trace"
          ? owner.route.filter((point) =>
            point.route_type === "via" && point.x === element.x && point.y === element.y &&
            element.layers.includes(point.from_layer) &&
            element.layers.includes(point.to_layer)
          )
          : []);
        if (owners.length !== 1 || routeMatches.length !== 1) {
          unsupported.push(
            `${element.pcb_via_id}: physical via does not resolve to exactly one owner-route transition`,
          );
          continue;
        }
      }
      const expectedLayers: readonly string[] = layerCount === 2
        ? ["top", "bottom"]
        : ["top", "inner1", "inner2", "bottom"];
      const actualLayerSet = new Set<string>(element.layers);
      if (
        new Set([element.from_layer, element.to_layer]).size !== 2 ||
        ![element.from_layer, element.to_layer].includes("top") ||
        ![element.from_layer, element.to_layer].includes("bottom") ||
        actualLayerSet.size !== expectedLayers.length ||
        expectedLayers.some((layer) => !actualLayerSet.has(layer))
      ) {
        unsupported.push(
          `${element.pcb_via_id}: only full-stack through vias are independently verified`,
        );
        continue;
      }
      platedDrills.push({
        x: element.x,
        y: element.y,
        diameter: element.hole_diameter,
        source: element.pcb_via_id,
      });
      for (const layer of element.layers) {
        const file = layerFile(layer, layerCount);
        if (file !== undefined) {
          flashes[file]!.push(
            flash(
              { x: element.x, y: element.y, source: element.pcb_via_id },
              "circle",
              element.outer_diameter,
            ),
          );
        }
      }
      if (element.is_tented === false) {
        for (const mask of ["F_Mask", "B_Mask"]) {
          flashes[mask]!.push(
            flash(
              { x: element.x, y: element.y, source: element.pcb_via_id },
              "circle",
              element.outer_diameter,
            ),
          );
        }
      }
    } else if (element.type === "pcb_hole") {
      if (element.hole_shape !== "circle") {
        unsupported.push(
          `${element.pcb_hole_id}: only circular non-plated holes are independently verified`,
        );
        continue;
      }
      nonPlatedDrills.push({
        x: element.x,
        y: element.y,
        diameter: element.hole_diameter,
        source: element.pcb_hole_id,
      });
      if (element.is_covered_with_solder_mask !== true) {
        const margin = element.soldermask_margin ?? 0;
        for (const mask of ["F_Mask", "B_Mask"]) {
          flashes[mask]!.push(
            flash(
              { x: element.x, y: element.y, source: element.pcb_hole_id },
              "circle",
              element.hole_diameter + margin * 2,
            ),
          );
        }
      }
    } else if (element.type === "pcb_solder_paste") {
      if (element.shape !== "circle" && element.shape !== "rect") {
        unsupported.push(
          `${element.pcb_solder_paste_id}: ${element.shape} solder paste is not independently reconciled`,
        );
        continue;
      }
      const paste = element.layer === "top" ? "F_Paste" :
        element.layer === "bottom" ? "B_Paste" : undefined;
      if (paste !== undefined) {
        flashes[paste]!.push(
          element.shape === "circle"
            ? flash(
                { x: element.x, y: element.y, source: element.pcb_solder_paste_id },
                "circle",
                element.radius * 2,
              )
            : flash(
                { x: element.x, y: element.y, source: element.pcb_solder_paste_id },
                "rect",
                element.width,
                element.height,
              ),
        );
      } else {
        unsupported.push(`${element.pcb_solder_paste_id}: solder paste uses unsupported layer ${element.layer}`);
      }
    } else if (element.type === "pcb_trace") {
      for (const [index, point] of element.route.entries()) {
        if (point.route_type !== "through_pad") continue;
        const matchingPads = point.pcb_plated_hole_id === undefined
          ? []
          : options.circuitJson.filter((candidate) =>
            candidate.type === "pcb_plated_hole" &&
            candidate.pcb_plated_hole_id === point.pcb_plated_hole_id
          );
        if (point.pcb_smtpad_id !== undefined || matchingPads.length !== 1) {
          unsupported.push(
            `${element.pcb_trace_id}.through_pad.${index}: route does not resolve to exactly one plated through-hole`,
          );
        }
      }
      for (const [index, point] of element.route.entries()) {
        if (point.route_type !== "via") continue;
        const source = `${element.pcb_trace_id}.via.${index}`;
        const matchingPhysicalVias = options.circuitJson.filter(
          (candidate) =>
            candidate.type === "pcb_via" &&
            candidate.pcb_trace_id === element.pcb_trace_id &&
            candidate.x === point.x && candidate.y === point.y &&
            candidate.layers.includes(point.from_layer) &&
            candidate.layers.includes(point.to_layer),
        );
        if (matchingPhysicalVias.length > 1) {
          unsupported.push(`${source}: routed via resolves to multiple physical vias`);
          continue;
        }
        if (matchingPhysicalVias.length === 1) {
          // The matching pcb_via is the physical manufacturing record and is
          // independently reconciled by the pcb_via branch.
          continue;
        }
        if (
          typeof point.hole_diameter !== "number" ||
          typeof point.outer_diameter !== "number"
        ) {
          unsupported.push(`${source}: routed via lacks explicit hole and outer diameters`);
          continue;
        }
        if (
          new Set([point.from_layer, point.to_layer]).size !== 2 ||
          ![point.from_layer, point.to_layer].includes("top") ||
          ![point.from_layer, point.to_layer].includes("bottom")
        ) {
          unsupported.push(
            `${source}: only top-to-bottom routed through vias are independently verified`,
          );
          continue;
        }
        platedDrills.push({
          x: point.x,
          y: point.y,
          diameter: point.hole_diameter,
          source,
        });
        for (const layer of [point.from_layer, point.to_layer]) {
          const file = layerFile(layer, layerCount)!;
          flashes[file]!.push(
            flash(
              { x: point.x, y: point.y, source },
              "circle",
              point.outer_diameter,
            ),
          );
        }
      }
      for (let index = 0; index < element.route.length - 1; index += 1) {
        const start = element.route[index]!;
        const end = element.route[index + 1]!;
        let segment:
          | { startX: number; startY: number; endX: number; endY: number; width: number; layer: string }
          | undefined;
        if (start.route_type === "wire") {
          const endPoint = end.route_type === "wire" || end.route_type === "via"
            ? end
            : start.layer === end.start_layer ? end.start : end.end;
          segment = {
            startX: start.x,
            startY: start.y,
            endX: endPoint.x,
            endY: endPoint.y,
            width: start.width,
            layer: start.layer,
          };
        } else if (start.route_type === "via" && end.route_type === "wire") {
          segment = {
            startX: start.x,
            startY: start.y,
            endX: end.x,
            endY: end.y,
            width: end.width,
            layer: end.layer,
          };
        } else if (start.route_type === "through_pad" && end.route_type === "wire") {
          const startPoint = start.end_layer === end.layer
            ? start.end
            : start.start_layer === end.layer
              ? start.start
              : undefined;
          if (startPoint !== undefined) {
            segment = {
              startX: startPoint.x,
              startY: startPoint.y,
              endX: end.x,
              endY: end.y,
              width: end.width,
              layer: end.layer,
            };
          }
        }
        if (segment === undefined) continue;
        const file = layerFile(segment.layer, layerCount);
        if (file === undefined) {
          unsupported.push(
            `${element.pcb_trace_id}: trace uses unsupported layer ${segment.layer}`,
          );
          continue;
        }
        copperSegments[file]!.push({
          startX: segment.startX,
          startY: segment.startY,
          endX: segment.endX,
          endY: segment.endY,
          width: segment.width,
          source: element.pcb_trace_id,
        });
      }
    }
  }

  const sourceComponents = new Map(
    options.circuitJson
      .filter(
        (element): element is SourceComponentElement =>
          element.type === "source_component",
      )
      .map((element) => [element.source_component_id, element] as const),
  );
  const sourceNames = new Map(
    [...sourceComponents].map(([id, component]) => [id, component.name] as const),
  );
  const infrastructureSourceIds = new Set(
    options.circuitJson.flatMap((element) =>
      element.type === "source_manually_placed_via"
        ? [element.source_manually_placed_via_id]
        : []
    ),
  );
  const pcbComponents = options.circuitJson.filter(
    (element): element is PcbComponentElement => element.type === "pcb_component",
  );
  const cadComponents = options.circuitJson.filter(
    (element) => element.type === "cad_component",
  );
  const pcbPorts = options.circuitJson.filter(
    (element) => element.type === "pcb_port",
  );
  const sourcePorts = options.circuitJson.filter(
    (element) => element.type === "source_port",
  );
  const schematicPorts = options.circuitJson.filter(
    (element) => element.type === "schematic_port",
  );
  const componentPads = options.circuitJson.filter(
    (element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
  );
  unsupported.push(
    ...deriveAuthoritativeConnectivity(options.circuitJson).pinAuthorityFailures.map(
      (failure) => `${failure}: component pin authority is not bijective`,
    ),
  );
  const componentCourtyards = options.circuitJson.filter(
    (element) => element.type === "pcb_courtyard_rect",
  );
  const componentHoles = options.circuitJson
    .filter(
      (element): element is Extract<AnyCircuitElement, { type: "pcb_hole" }> =>
        element.type === "pcb_hole",
    )
    .filter((element) =>
      element.pcb_component_id !== null && element.pcb_component_id !== undefined
    );
  for (const hole of componentHoles) {
    const ownerCount = pcbComponents.filter((component) =>
      component.pcb_component_id === hole.pcb_component_id
    ).length;
    if (ownerCount !== 1) {
      unsupported.push(`${hole.pcb_hole_id}: component-owned NPTH has ${ownerCount} owners`);
    }
  }
  const usedDesignators = new Set<string>();
  for (const source of sourceComponents.values()) {
    const matches = pcbComponents.filter((component) =>
      component.source_component_id === source.source_component_id
    );
    if (matches.length !== 1) {
      unsupported.push(
        `${source.source_component_id}: authored component resolves to ${matches.length} manufactured PCB components`,
      );
    }
  }
  for (const component of pcbComponents) {
    if (infrastructureSourceIds.has(component.source_component_id)) continue;
    const source = sourceComponents.get(component.source_component_id);
    if (source === undefined) {
      unsupported.push(
        `${component.pcb_component_id}: assembly source component ${component.source_component_id} is unresolved`,
      );
      continue;
    }
    const testPoint = source.ftype === "simple_test_point";
    const designator = source.name?.trim();
    if (!designator) {
      unsupported.push(`${component.pcb_component_id}: assembly designator is blank`);
    } else if (source.name !== designator) {
      unsupported.push(
        `${component.pcb_component_id}: assembly designator must be a conservative ASCII reference ending in a positive integer with no leading or trailing whitespace`,
      );
    } else if (isDeterministicTemporaryComponentName(designator)) {
      unsupported.push(
        `${component.pcb_component_id}: deterministic temporary designator ${designator} must be replaced by an explicit stable manufactured-component name`,
      );
    } else if (!isStableAssemblyDesignator(designator)) {
      unsupported.push(
        `${component.pcb_component_id}: assembly designator must be a conservative ASCII reference ending in a positive integer`,
      );
    } else if (usedDesignators.has(designator)) {
      unsupported.push(`${component.pcb_component_id}: duplicate assembly designator ${designator}`);
    } else {
      usedDesignators.add(designator);
    }

    if (testPoint) continue;

    const padsForComponent = componentPads.filter(
      (pad) => pad.pcb_component_id === component.pcb_component_id,
    );
    const matchingCad = cadComponents.filter(
      (candidate) => candidate.pcb_component_id === component.pcb_component_id,
    );
    if (matchingCad.length !== 1) {
      unsupported.push(
        `${component.pcb_component_id}: assembly footprint must resolve to exactly one CAD component`,
      );
    } else {
      const cad = matchingCad[0]!;
      const cadAnchorWithinComponent =
        Number.isFinite(cad.position.x) && Number.isFinite(cad.position.y) &&
        Math.abs(cad.position.x - component.center.x) <= component.width / 2 + 1e-9 &&
        Math.abs(cad.position.y - component.center.y) <= component.height / 2 + 1e-9;
      if (
        cad.source_component_id !== component.source_component_id ||
        !cadAnchorWithinComponent
      ) unsupported.push(
        `${component.pcb_component_id}: CAD identity or anchor lies outside its PCB component bounds`,
      );
      const footprinter = cad.footprinter_string?.trim() ?? "";
      const pinned = footprinter in PINNED_FOOTPRINT_PAD_SIGNATURES;
      if (
        pinned
          ? !matchesPinnedFootprintPadSignature(footprinter, component, padsForComponent)
          : footprinter !== "" ||
            !matchesSourceBoundCustomFootprintPadSignature(source, component, padsForComponent)
      ) {
        unsupported.push(
          `${component.pcb_component_id}: CAD footprint is not qualified by a pinned or source-bound emitted pad signature`,
        );
      }
    }

    if (!isExpectedSafeOptionalPartIdentity(source.manufacturer_part_number)) {
      unsupported.push(
        `${component.pcb_component_id}: manufacturing component ${source.name ?? source.source_component_id} manufacturer part identity is not a conservative printable ASCII token`,
      );
    }

    const supplierEntries = Object.entries(source.supplier_part_numbers ?? {});
    const supplierIdentity = expectedBomSupplierIdentity(source.supplier_part_numbers);
    if (component.do_not_place === true) {
      if (supplierEntries.length > 0 && supplierIdentity === undefined) {
        unsupported.push(
          `${component.pcb_component_id}: DNP manufacturing component ${source.name ?? source.source_component_id} has an explicit supplier identity that cannot be represented safely and unambiguously`,
        );
      }
      continue;
    }

    if (source.manufacturer_part_number === undefined) {
      unsupported.push(
        `${component.pcb_component_id}: populated manufacturing component ${source.name ?? source.source_component_id} has no explicit manufacturer part identity`,
      );
    }
    if (supplierEntries.length > 0 && supplierIdentity === undefined) {
      unsupported.push(
        `${component.pcb_component_id}: populated manufacturing component ${source.name ?? source.source_component_id} supplier identity cannot be represented unambiguously in one BOM row`,
      );
    }

    const portsForSource = sourcePorts.filter(
      (port) => port.source_component_id === source.source_component_id,
    );
    const portsForComponent = pcbPorts.filter(
      (port) => port.pcb_component_id === component.pcb_component_id,
    );
    const declaredCourtyards = componentCourtyards.filter((courtyard) =>
      courtyard.pcb_component_id === component.pcb_component_id
    );
    let resolvedCourtyard = {
      x: component.center.x,
      y: component.center.y,
      halfWidth: component.width / 2,
      halfHeight: component.height / 2,
    };
    if (declaredCourtyards.length === 1) {
      const courtyard = declaredCourtyards[0]!;
      const rotation = ((courtyard.ccw_rotation ?? 0) % 360 + 360) % 360;
      if (rotation % 90 !== 0) {
        unsupported.push(
          `${courtyard.pcb_courtyard_rect_id}: non-orthogonal courtyard cannot qualify pad containment`,
        );
      } else {
        const swapsAxes = rotation === 90 || rotation === 270;
        resolvedCourtyard = {
          x: courtyard.center.x,
          y: courtyard.center.y,
          halfWidth: (swapsAxes ? courtyard.height : courtyard.width) / 2,
          halfHeight: (swapsAxes ? courtyard.width : courtyard.height) / 2,
        };
      }
    } else if (declaredCourtyards.length > 1) {
      unsupported.push(
        `${component.pcb_component_id}: multiple courtyards cannot qualify pad containment`,
      );
    }
    for (const hole of componentHoles.filter((candidate) =>
      candidate.pcb_component_id === component.pcb_component_id
    )) {
      if (hole.hole_shape !== "circle") {
        unsupported.push(
          `${hole.pcb_hole_id}: non-circular component-owned NPTH cannot qualify courtyard containment`,
        );
        continue;
      }
      const radius = hole.hole_diameter / 2;
      if (
        Math.abs(hole.x - resolvedCourtyard.x) + radius >
          resolvedCourtyard.halfWidth + 1e-9 ||
        Math.abs(hole.y - resolvedCourtyard.y) + radius >
          resolvedCourtyard.halfHeight + 1e-9
      ) unsupported.push(
        `${hole.pcb_hole_id}: component-owned NPTH lies outside its owner courtyard`,
      );
    }
    for (const pad of padsForComponent) {
      if (pad.type === "pcb_plated_hole") {
        const slot = platedSlotGeometry(pad);
        const circle = pad.shape === "circle" ? pad : undefined;
        if (circle === undefined && slot === undefined) {
          unsupported.push(
            `${pad.pcb_plated_hole_id}: ${pad.shape} plated hole cannot qualify courtyard containment`,
          );
          continue;
        }
        const halfWidth = slot?.padWidth !== undefined ? slot.padWidth / 2 : circle!.outer_diameter / 2;
        const halfHeight = slot?.padHeight !== undefined ? slot.padHeight / 2 : circle!.outer_diameter / 2;
        if (
          Math.abs(pad.x - resolvedCourtyard.x) + halfWidth >
            resolvedCourtyard.halfWidth + 1e-9 ||
          Math.abs(pad.y - resolvedCourtyard.y) + halfHeight >
            resolvedCourtyard.halfHeight + 1e-9
        ) unsupported.push(
          `${pad.pcb_plated_hole_id}: plated-hole pad lies outside its owner courtyard`,
        );
        if (pad.port_hints?.includes("fulmetry:mechanical") === true) continue;
        if (pad.pcb_port_id === undefined) {
          unsupported.push(`${pad.pcb_plated_hole_id}: plated-hole pad has no owning PCB port`);
          continue;
        }
        const matchingPorts = portsForComponent.filter((port) =>
          port.pcb_port_id === pad.pcb_port_id
        );
        const padLayers = new Set<string>(pad.layers);
        const portLayers = matchingPorts.length === 1
          ? new Set<string>(matchingPorts[0]!.layers)
          : new Set<string>();
        if (
          matchingPorts.length !== 1 || padLayers.size !== pad.layers.length ||
          portLayers.size !== matchingPorts[0]!.layers.length ||
          padLayers.size !== portLayers.size ||
          [...padLayers].some((layer) => !portLayers.has(layer))
        ) unsupported.push(
          `${pad.pcb_plated_hole_id}: plated-hole layers do not match exactly one owning PCB port`,
        );
        continue;
      }
      if (pad.shape !== "circle" && pad.shape !== "rect") {
        unsupported.push(
          `${pad.pcb_smtpad_id}: ${pad.shape} SMT pad cannot qualify courtyard containment`,
        );
        continue;
      }
      if (pad.layer !== component.layer) {
        unsupported.push(
          `${pad.pcb_smtpad_id}: SMT pad side ${pad.layer} contradicts component side ${component.layer}`,
        );
      }
      const halfWidth = pad.shape === "circle" ? pad.radius : pad.width / 2;
      const halfHeight = pad.shape === "circle" ? pad.radius : pad.height / 2;
      if (
        Math.abs(pad.x - resolvedCourtyard.x) + halfWidth >
          resolvedCourtyard.halfWidth + 1e-9 ||
        Math.abs(pad.y - resolvedCourtyard.y) + halfHeight >
          resolvedCourtyard.halfHeight + 1e-9
      ) unsupported.push(
        `${pad.pcb_smtpad_id}: SMT pad lies outside its owner courtyard`,
      );
      if (
        pad.port_hints?.includes("fulmetry:mechanical") !== true &&
        pad.pcb_port_id !== undefined
      ) {
        const matchingPorts = portsForComponent.filter((port) =>
          port.pcb_port_id === pad.pcb_port_id
        );
        if (
          matchingPorts.length !== 1 || matchingPorts[0]!.layers.length !== 1 ||
          matchingPorts[0]!.layers[0] !== pad.layer
        ) unsupported.push(
          `${pad.pcb_smtpad_id}: SMT pad side does not match exactly one owning PCB port`,
        );
      }
    }
    if (portsForSource.length === 0 || padsForComponent.length === 0) {
      unsupported.push(
        `${component.pcb_component_id}: assembly pad mapping is empty`,
      );
      continue;
    }
    for (const sourcePort of portsForSource) {
      const matchingPorts = portsForComponent.filter(
        (port) => port.source_port_id === sourcePort.source_port_id,
      );
      if (matchingPorts.length !== 1) {
        unsupported.push(
          `${component.pcb_component_id}: source port ${sourcePort.source_port_id} does not resolve to exactly one PCB port`,
        );
        continue;
      }
      const pcbPortId = matchingPorts[0]!.pcb_port_id;
      const mappedPads = padsForComponent.filter(
        (pad) => "pcb_port_id" in pad && pad.pcb_port_id === pcbPortId,
      );
      if (mappedPads.length === 0) {
        unsupported.push(
          `${component.pcb_component_id}: PCB port ${pcbPortId} has no manufactured pad`,
        );
        continue;
      }
      const pcbPort = matchingPorts[0]!;
      if (
        !Number.isFinite(pcbPort.x) || !Number.isFinite(pcbPort.y) ||
        mappedPads.some((pad) => {
          const center = padCenter(pad);
          return center === undefined ||
            Math.abs(center.x - pcbPort.x) > 1e-9 ||
            Math.abs(center.y - pcbPort.y) > 1e-9;
        })
      ) {
        const message = `${component.pcb_component_id}: PCB port ${pcbPortId} does not coincide with every mapped manufactured pad center`;
        unsupported.push(message);
        const centers = mappedPads.flatMap((pad) => {
          const center = padCenter(pad);
          return center === undefined ? [] : [`(${center.x}mm, ${center.y}mm)`];
        });
        unsupportedDetails.push({
          message,
          objects: [component.pcb_component_id, pcbPortId],
          measurement: {
            actual: `(${pcbPort.x}mm, ${pcbPort.y}mm)`,
            required: centers.length === 0
              ? "a finite mapped pad center"
              : `exactly ${[...new Set(centers)].sort().join(" and ")}`,
          },
        });
      }
      const sourcePin = consistentSourcePinIdentity(source, sourcePort);
      const mappedPinHints = mappedPads.map(numericPinHint);
      if (!sourcePin) {
        unsupported.push(
          `${component.pcb_component_id}: source port ${sourcePort.source_port_id} has inconsistent pin_number, numeric hint, pin name, or qualified semantic identity`,
        );
        continue;
      }
      const matchingSchematicPorts = schematicPorts.filter(
        (port) => port.source_port_id === sourcePort.source_port_id,
      );
      const schematicPort = matchingSchematicPorts[0];
      const schematicPin = String(schematicPort?.pin_number ?? "").trim();
      const schematicSemanticPin = semanticHintPinIdentity(schematicPort?.display_pin_label);
      if (
        matchingSchematicPorts.length !== 1 || schematicPin !== sourcePin ||
        (PINNED_TWO_PIN_SEMANTIC_FTYPES.has(source.ftype) &&
          schematicSemanticPin !== sourcePin)
      ) {
        unsupported.push(
          `${component.pcb_component_id}: schematic port identity for ${sourcePort.source_port_id} contradicts source pin ${sourcePin}`,
        );
      }
      if (mappedPinHints.some((pinHint) => !pinHint || pinHint !== sourcePin)) {
        unsupported.push(
          `${component.pcb_component_id}: source port ${sourcePort.source_port_id} pin ${sourcePin} does not map exclusively to footprint pad ${sourcePin}`,
        );
      }
    }
  }
  const placements: ExpectedPlacement[] = options.circuitJson
    .filter(
      (element): element is PcbComponentElement =>
        element.type === "pcb_component" &&
        element.do_not_place !== true &&
        sourceComponents.get(element.source_component_id)?.ftype !== "simple_test_point" &&
        isStableAssemblyDesignator(
          sourceNames.get(element.source_component_id) ?? "",
        ),
    )
    .flatMap((element): ExpectedPlacement[] => {
      if (element.layer !== "top" && element.layer !== "bottom") {
        unsupported.push(
          `${element.pcb_component_id}: assembly placement on ${element.layer} is unsupported`,
        );
        return [];
      }
      return [{
        designator: sourceNames.get(element.source_component_id)!,
        x: element.center.x,
        y: element.center.y,
        layer: element.layer,
        rotation: element.rotation,
        source: element.pcb_component_id,
      }];
    })
    .sort((a, b) => a.designator.localeCompare(b.designator));

  const cadFootprints = new Map(
    cadComponents
      .map((element) => [element.pcb_component_id, element.footprinter_string ?? ""]),
  );
  const bomRows: ExpectedBomRow[] = options.circuitJson
    .filter((element): element is PcbComponentElement => element.type === "pcb_component")
    .flatMap((component): ExpectedBomRow[] => {
      const source = sourceComponents.get(component.source_component_id);
      if (
        source === undefined ||
        source.ftype === "simple_test_point" ||
        !isStableAssemblyDesignator(source.name ?? "")
      ) return [];
      const value = source.ftype === "simple_resistor"
        ? formatSI(source.resistance)
        : source.ftype === "simple_capacitor"
          ? formatSI(source.capacitance)
          : "";
      const supplierIdentity = component.do_not_place === true
        ? undefined
        : expectedBomSupplierIdentity(source.supplier_part_numbers);
      const footprint = cadFootprints.get(component.pcb_component_id) ?? "";
      return [{
        columns: {
          Designator: source.name ?? component.pcb_component_id,
          Quantity: "1",
          Comment: component.do_not_place === true ? "DNP" : value,
          Value: component.do_not_place === true ? "DNP" : value,
          Footprint: footprint,
          Manufacturer: "",
          "Manufacturer Part Number": expectedManufacturerPartNumber(
            source.manufacturer_part_number,
          ),
          Supplier: supplierIdentity?.supplier ?? "",
          "Supplier Part Number": supplierIdentity?.partNumber ?? "",
          "JLCPCB Part #": supplierIdentity?.jlcpcbPartNumber ?? "",
        },
      }];
    })
    .sort((a, b) =>
      a.columns.Designator!.localeCompare(b.columns.Designator!)
    );
  const assemblyAuthority: ExpectedAssemblyAuthority[] = pcbComponents
    .filter((component) => !infrastructureSourceIds.has(component.source_component_id))
    .flatMap((component): ExpectedAssemblyAuthority[] => {
      const source = sourceComponents.get(component.source_component_id);
      const designator = source?.name ?? "";
      if (source === undefined || !isStableAssemblyDesignator(designator)) return [];
      const role = source.ftype === "simple_test_point" ? "test-point" : "assembled";
      const dnp = component.do_not_place === true;
      const padSources = componentPads
        .filter((pad) => pad.pcb_component_id === component.pcb_component_id)
        .map((pad) => pad.type === "pcb_smtpad" ? pad.pcb_smtpad_id : pad.pcb_plated_hole_id)
        .sort();
      return [{
        sourceComponentId: source.source_component_id,
        pcbComponentId: component.pcb_component_id,
        designator,
        role,
        dnp,
        bomRequired: role === "assembled",
        placementRequired: role === "assembled" && !dnp,
        padSources,
      }];
    })
    .sort((a, b) => a.designator.localeCompare(b.designator));
  const bomHeaders = [...MANUFACTURING_BOM_HEADERS];

  const freezePoints = <T extends ExpectedPoint>(points: T[]): readonly Readonly<T>[] =>
    Object.freeze(points.map((point) => {
      const slot = (point as unknown as { slot?: ExpectedDrillHit["slot"] }).slot;
      return Object.freeze({
        ...point,
        ...(slot === undefined ? {} : { slot: Object.freeze({ ...slot }) }),
      }) as Readonly<T>;
    }));

  return Object.freeze({
    boardName: options.boardName,
    layerCount,
    board: Object.freeze({
      centerX: board.center.x,
      centerY: board.center.y,
      width: board.width,
      height: board.height,
      thickness: board.thickness,
      material: board.material,
    }),
    flashes: Object.freeze(
      Object.fromEntries(
        Object.entries(flashes).map(([layer, points]) => [
          layer,
          Object.freeze(points.map((point) =>
            Object.freeze({
              ...point,
              dimensions: Object.freeze([...point.dimensions]),
            })
          )),
        ]),
      ),
    ),
    copperSegments: Object.freeze(
      Object.fromEntries(
        Object.entries(copperSegments).map(([layer, segments]) => [
          layer,
          Object.freeze(segments.map((segment) => Object.freeze({ ...segment }))),
        ]),
      ),
    ),
    silkscreenSegments: Object.freeze(
      Object.fromEntries(
        Object.entries(silkscreenSegments).map(([layer, segments]) => [
          layer,
          Object.freeze(segments.map((segment) => Object.freeze({ ...segment }))),
        ]),
      ),
    ),
    platedThroughSources: Object.freeze(
      [...new Set(platedDrills.map(({ source }) => source))].sort(),
    ),
    platedDrills: freezePoints(platedDrills) as readonly ExpectedDrillHit[],
    nonPlatedDrills: freezePoints(nonPlatedDrills) as readonly ExpectedDrillHit[],
    assemblyAuthority: Object.freeze(
      assemblyAuthority.map((component) => Object.freeze({
        ...component,
        padSources: Object.freeze([...component.padSources]),
      })),
    ),
    bomRows: Object.freeze(
      bomRows.map((row) =>
        Object.freeze({ columns: Object.freeze({ ...row.columns }) })
      ),
    ),
    bomHeaders: Object.freeze(bomHeaders),
    placements: Object.freeze(
      placements.map((placement) => Object.freeze({ ...placement })),
    ),
    unsupported: Object.freeze([...unsupported]),
    ...(unsupportedDetails.length === 0
      ? {}
      : {
          unsupportedDetails: Object.freeze(unsupportedDetails.map((detail) => Object.freeze({
            ...detail,
            objects: Object.freeze([...detail.objects]),
            ...(detail.measurement === undefined
              ? {}
              : { measurement: Object.freeze({ ...detail.measurement }) }),
          }))),
        }),
  });
}
