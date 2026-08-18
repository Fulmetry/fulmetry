// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  convertCircuitJsonToBomRows,
} from "circuit-json-to-bom-csv";
import {
  convertSoupToExcellonDrillCommandLayers,
  convertSoupToGerberCommands,
  stringifyExcellonDrill,
  stringifyGerberCommandLayers,
} from "circuit-json-to-gerber";
import { convertCircuitJsonToPickAndPlaceCsv } from "circuit-json-to-pnp-csv";
import type { AnyCircuitElement } from "tscircuit";
import { isStableAssemblyDesignator } from "../component-identity";
import { MANUFACTURING_PACKAGE_PINS } from "./identity";
import { requireSupportedBunRuntime } from "../runtime";

export const MANUFACTURING_ADAPTER_VERSIONS = Object.freeze({
  gerber: "circuit-json-to-gerber@0.0.90",
  bom: "circuit-json-to-bom-csv@0.0.14",
  pickAndPlace: "circuit-json-to-pnp-csv@0.0.9",
  independentParser: "gerber-parser@4.2.7",
});

export type ManufacturingArtifactKind =
  | "gerber"
  | "drill"
  | "bom"
  | "pick-and-place"
  | "metadata";

export interface ManufacturingFile {
  readonly path: string;
  readonly kind: ManufacturingArtifactKind;
  readonly content: string;
}

const SAFE_BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertOneSupportedBoard(circuitJson: AnyCircuitElement[]): 2 | 4 {
  const boards = circuitJson.filter((element) => element.type === "pcb_board");
  if (boards.length !== 1) {
    throw new Error(
      `PCBoo manufacturing export requires exactly one board; found ${boards.length}`,
    );
  }

  const layerCount = boards[0]?.num_layers;
  if (layerCount !== 2 && layerCount !== 4) {
    throw new Error(
      `PCBoo manufacturing verification currently supports 2 or 4 layers; found ${String(layerCount)}`,
    );
  }
  return layerCount;
}

function firstCsvField(line: string): string {
  if (!line.startsWith('"')) return line.split(",", 1)[0] ?? "";
  let value = "";
  for (let index = 1; index < line.length; index += 1) {
    const character = line[index]!;
    if (character !== '"') {
      value += character;
      continue;
    }
    if (line[index + 1] === '"') {
      value += '"';
      index += 1;
      continue;
    }
    return value;
  }
  throw new Error("Malformed quoted designator in pick-and-place CSV");
}

function omitDnpPlacements(
  content: string,
  circuitJson: AnyCircuitElement[],
): string {
  const sourceNames = new Map(
    circuitJson.flatMap((element) =>
      element.type === "source_component"
        ? [[element.source_component_id, element.name] as const]
        : []
    ),
  );
  const dnpDesignators = new Set(
    circuitJson.flatMap((element) =>
      element.type === "pcb_component" && element.do_not_place === true
        ? [sourceNames.get(element.source_component_id)]
        : []
    ).filter((name): name is string => typeof name === "string"),
  );
  if (dnpDesignators.size === 0 || content === "") return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const header = lines.shift() ?? "";
  const rows = lines.filter((line) => line !== "" && !dnpDesignators.has(firstCsvField(line)));
  return rows.length === 0 ? "" : [header, ...rows].join(newline) + newline;
}

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const STRICT_BOM_HEADERS = Object.freeze([
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
]);

const SAFE_BOM_SUPPLIER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_BOM_PART_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:+/#@()-]{0,127}$/;
function exportableManufacturerPartNumber(value: unknown): string {
  return typeof value === "string" && SAFE_BOM_PART_IDENTITY.test(value) ? value : "";
}

function assemblyCsvCircuitJson(circuitJson: AnyCircuitElement[]): AnyCircuitElement[] {
  const excludedSourceIds = new Set(circuitJson.flatMap((element) =>
    element.type === "source_component" &&
      (element.ftype === "simple_test_point" || !isStableAssemblyDesignator(element.name))
      ? [element.source_component_id]
      : []
  ));
  if (excludedSourceIds.size === 0) return circuitJson;
  const excludedPcbIds = new Set(circuitJson.flatMap((element) =>
    element.type === "pcb_component" && excludedSourceIds.has(element.source_component_id)
      ? [element.pcb_component_id]
      : []
  ));
  return circuitJson.filter((element) => {
    if (
      "source_component_id" in element &&
      typeof element.source_component_id === "string" &&
      excludedSourceIds.has(element.source_component_id)
    ) return false;
    if (
      "pcb_component_id" in element &&
      typeof element.pcb_component_id === "string" &&
      excludedPcbIds.has(element.pcb_component_id)
    ) return false;
    return true;
  });
}

function exportableBomSupplierIdentity(
  supplierPartNumbers: unknown,
): Readonly<{
  supplier: string;
  partNumber: string;
  jlcpcbPartNumber: string;
}> | undefined {
  if (
    supplierPartNumbers === null ||
    typeof supplierPartNumbers !== "object" ||
    Array.isArray(supplierPartNumbers)
  ) return undefined;
  const providers = Object.entries(supplierPartNumbers as Record<string, unknown>);
  if (providers.length !== 1) return undefined;
  const [provider, values] = providers[0]!;
  if (
    provider !== provider.trim() ||
    !SAFE_BOM_SUPPLIER_NAME.test(provider) ||
    !Array.isArray(values) ||
    values.length !== 1
  ) return undefined;
  const partNumber = values[0];
  if (
    typeof partNumber !== "string" ||
    !SAFE_BOM_PART_IDENTITY.test(partNumber)
  ) return undefined;
  const normalizedProvider = provider.toLowerCase();
  const isJlcFamily = normalizedProvider === "jlcpcb" || normalizedProvider === "lcsc";
  return {
    supplier: normalizedProvider === "jlcpcb"
      ? "JLCPCB"
      : normalizedProvider === "lcsc"
        ? "LCSC"
        : provider,
    partNumber,
    jlcpcbPartNumber: isJlcFamily ? partNumber : "",
  };
}

function strictBomCsv(
  rows: Awaited<ReturnType<typeof convertCircuitJsonToBomRows>>,
  circuitJson: AnyCircuitElement[],
): string {
  if (rows.length === 0) return "";
  const sourceByName = new Map(circuitJson.flatMap((element) =>
    element.type === "source_component" && typeof element.name === "string"
      ? [[element.name, element] as const]
      : []
  ));
  const dnpNames = new Set(circuitJson.flatMap((element) => {
    if (element.type !== "pcb_component" || element.do_not_place !== true) return [];
    const source = circuitJson.find((candidate) =>
      candidate.type === "source_component" &&
      candidate.source_component_id === element.source_component_id
    );
    return source?.type === "source_component" && typeof source.name === "string"
      ? [source.name]
      : [];
  }));
  const lines = [STRICT_BOM_HEADERS.map(csvField).join(",")];
  for (const row of rows) {
    const source = sourceByName.get(row.designator);
    const dnp = dnpNames.has(row.designator);
    const supplierNumbers = Object.values(row.supplier_part_number_columns ?? {});
    const value = supplierNumbers.includes(row.value) && row.comment === "" ? "" : row.value;
    const supplierIdentity = dnp
      ? undefined
      : exportableBomSupplierIdentity(source?.supplier_part_numbers);
    lines.push([
      row.designator,
      "1",
      row.comment,
      value,
      row.footprint,
      "",
      exportableManufacturerPartNumber(source?.manufacturer_part_number),
      supplierIdentity?.supplier ?? "",
      supplierIdentity?.partNumber ?? "",
      supplierIdentity?.jlcpcbPartNumber ?? "",
    ].map(csvField).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function fabricationMetadata(
  boardName: string,
  circuitJson: AnyCircuitElement[],
  layerCount: 2 | 4,
): string {
  const board = circuitJson.find((element) => element.type === "pcb_board");
  if (board?.type !== "pcb_board") throw new Error("Manufacturing metadata requires one board");
  return `${JSON.stringify({
    schemaVersion: 1,
    boardName,
    units: "mm",
    board: {
      center: board.center,
      width: board.width,
      height: board.height,
      thickness: board.thickness,
      material: board.material,
    },
    layerStack: layerCount === 4
      ? ["top", "inner1", "inner2", "bottom"]
      : ["top", "bottom"],
    coordinates: {
      origin: "pcb-board-center",
      xAxis: "right",
      yAxis: "up",
    },
    placement: {
      units: "mm",
      coordinates: "absolute-board",
      rotation: "counterclockwise-degrees",
      bottomSide: "as-authored-not-mirrored",
    },
  }, null, 2)}\n`;
}

/** Remove exporter wall-clock fields while retaining all manufacturing data. */
export function canonicalizeManufacturingText(content: string): string {
  return content
    .replace(
      /^(%TF\.GenerationSoftware,tscircuit,circuit-json-to-gerber,)[^*]+(\*%)$/gm,
      `$1${MANUFACTURING_PACKAGE_PINS.gerber.version}$2`,
    )
    .replace(/^%TF\.CreationDate,[^\r\n]*\r?\n/gm, "")
    .replace(/^G04 Created by tscircuit \(builder\) date [^\r\n]*\r?\n/gm, "")
    .replace(/^; DRILL file \{tscircuit\} date [^\r\n]*\r?\n/gm, "")
    .replace(/^; #@! TF\.CreationDate,[^\r\n]*\r?\n/gm, "")
    .replaceAll("\r\n", "\n");
}

/**
 * circuit-json-to-gerber 0.0.90 crashes when a plated hole includes an inner
 * layer because it unconditionally requests that inner layer's solder-mask
 * file. Express inner annular copper as Gerber-only features while retaining
 * the original PTH on the two outer layers. The untouched Circuit JSON remains
 * authoritative for drill, BOM, PnP, and manufacturing reconciliation.
 * Drill/BOM/PnP conversion always receives the untouched Circuit JSON.
 */
function gerberCompatibleCircuitJson(
  circuitJson: AnyCircuitElement[],
  layerCount: 2 | 4,
): AnyCircuitElement[] {
  if (layerCount === 2) return circuitJson;

  const compatible: AnyCircuitElement[] = [];
  for (const element of circuitJson) {
    if (element.type !== "pcb_plated_hole") {
      compatible.push(element);
      continue;
    }
    const rectSlot = element.shape === "pill_hole_with_rect_pad" ||
      element.shape === "rotated_pill_hole_with_rect_pad";
    if (element.shape !== "circle" && !rectSlot) {
      throw new Error(
        `Four-layer Gerber export does not yet safely support ${element.shape} plated hole ${element.pcb_plated_hole_id}`,
      );
    }

    compatible.push(element.shape === "rotated_pill_hole_with_rect_pad"
      ? {
          ...element,
          layers: ["top", "bottom"],
          rect_pad_width: element.rect_pad_height,
          rect_pad_height: element.rect_pad_width,
        } as AnyCircuitElement
      : { ...element, layers: ["top", "bottom"] });
    if (rectSlot) {
      for (const layer of ["inner1", "inner2"] as const) {
        compatible.push({
          type: "pcb_smtpad",
          pcb_smtpad_id: `pcboo_inner_pad_${layer}_${element.pcb_plated_hole_id}`,
          pcb_component_id: element.pcb_component_id,
          pcb_port_id: element.pcb_port_id,
          x: element.x,
          y: element.y,
          shape: "rect",
          width: element.shape === "rotated_pill_hole_with_rect_pad"
            ? element.rect_pad_height
            : element.rect_pad_width,
          height: element.shape === "rotated_pill_hole_with_rect_pad"
            ? element.rect_pad_width
            : element.rect_pad_height,
          layer,
          is_covered_with_solder_mask: true,
          subcircuit_id: element.subcircuit_id,
          pcb_group_id: element.pcb_group_id,
        } as AnyCircuitElement);
      }
    } else {
      compatible.push({
        type: "pcb_via",
        pcb_via_id: `pcboo_inner_pad_${element.pcb_plated_hole_id}`,
        x: element.x,
        y: element.y,
        hole_diameter: element.hole_diameter,
        outer_diameter: element.outer_diameter,
        layers: ["inner1", "inner2"],
        from_layer: "inner1",
        to_layer: "inner2",
        subcircuit_id: element.subcircuit_id,
        pcb_group_id: element.pcb_group_id,
      } as AnyCircuitElement);
    }
  }
  return compatible;
}

/**
 * The pinned exporter also derives drills from dimensioned via route points.
 * PCBoo authored routes intentionally materialize explicit pcb_via records, so
 * leaving both representations dimensioned would duplicate the same physical
 * drill. Keep route transition coordinates/layers and let the explicit record
 * be the sole manufacturing geometry authority.
 */
function explicitViaCompatibleCircuitJson(
  circuitJson: AnyCircuitElement[],
): AnyCircuitElement[] {
  const explicit = new Set(circuitJson.flatMap((element) =>
    element.type === "pcb_via" && typeof element.pcb_trace_id === "string"
      ? [`${element.pcb_trace_id}:${element.x}:${element.y}`]
      : []
  ));
  return circuitJson.map((element) => {
    if (element.type !== "pcb_trace") return element;
    let changed = false;
    const route = element.route.map((point) => {
      if (
        point.route_type !== "via" ||
        !explicit.has(`${element.pcb_trace_id}:${point.x}:${point.y}`)
      ) return point;
      changed = true;
      const { hole_diameter: _hole, outer_diameter: _outer, ...transition } = point;
      return transition;
    });
    return changed ? { ...element, route } as AnyCircuitElement : element;
  });
}

function gerberCoordinate(value: number): string {
  const scaled = Math.round(value * 1_000_000);
  return scaled < 0 ? `-${Math.abs(scaled)}` : String(scaled);
}

/**
 * circuit-json-to-gerber@0.0.90 declares rectangular apertures for inner-layer
 * PTH annuli but omits their flashes. Add only those missing flashes to the
 * pinned adapter's output. The independent verifier still reconciles every
 * coordinate and aperture dimension against the untouched authored geometry.
 */
function addInnerPlatedSlotFlashes(
  content: string,
  circuitJson: AnyCircuitElement[],
  layer: "inner1" | "inner2",
): string {
  const slots = circuitJson.filter((element): element is Extract<
    AnyCircuitElement,
    {
      type: "pcb_plated_hole";
      shape: "pill_hole_with_rect_pad" | "rotated_pill_hole_with_rect_pad";
    }
  > =>
    element.type === "pcb_plated_hole" &&
    (element.shape === "pill_hole_with_rect_pad" ||
      element.shape === "rotated_pill_hole_with_rect_pad") &&
    element.layers.includes(layer)
  );
  if (slots.length === 0) return content;

  const apertures = new Map<string, number>();
  let highestCode = 9;
  for (const match of content.matchAll(/^%ADD(\d+)R,([0-9.]+)X([0-9.]+)\*%$/gmu)) {
    const code = Number(match[1]);
    highestCode = Math.max(highestCode, code);
    apertures.set(`${Number(match[2]).toFixed(6)}x${Number(match[3]).toFixed(6)}`, code);
  }
  for (const match of content.matchAll(/^%ADD(\d+)/gmu)) {
    highestCode = Math.max(highestCode, Number(match[1]));
  }

  const declarations: string[] = [];
  const flashes: string[] = [];
  for (const slot of slots) {
    const rotated = slot.shape === "rotated_pill_hole_with_rect_pad";
    const width = rotated ? slot.rect_pad_height : slot.rect_pad_width;
    const height = rotated ? slot.rect_pad_width : slot.rect_pad_height;
    const key = `${width.toFixed(6)}x${height.toFixed(6)}`;
    let code = apertures.get(key);
    if (code === undefined) {
      code = ++highestCode;
      apertures.set(key, code);
      declarations.push(`%ADD${code}R,${width.toFixed(6)}X${height.toFixed(6)}*%`);
    }
    flashes.push(
      `D${code}*\nX${gerberCoordinate(slot.x)}Y${gerberCoordinate(slot.y)}D03*`,
    );
  }

  let result = content;
  if (declarations.length > 0) {
    result = result.replace("%TD*%", `${declarations.join("\n")}\n%TD*%`);
  }
  return result.replace(/M02\*\s*$/u, `${flashes.join("\n")}\nM02*\n`);
}

export async function exportManufacturingFiles(options: {
  readonly boardName: string;
  readonly circuitJson: AnyCircuitElement[];
}): Promise<readonly ManufacturingFile[]> {
  requireSupportedBunRuntime();
  if (!SAFE_BOARD_NAME.test(options.boardName)) {
    throw new Error(
      `Unsafe board name ${JSON.stringify(options.boardName)}; use letters, digits, dot, underscore, or hyphen`,
    );
  }
  const layerCount = assertOneSupportedBoard(options.circuitJson);
  const adapterCircuitJson = explicitViaCompatibleCircuitJson(options.circuitJson);

  const gerberLayers = stringifyGerberCommandLayers(
    convertSoupToGerberCommands(
      gerberCompatibleCircuitJson(adapterCircuitJson, layerCount),
    ),
  );
  if (layerCount === 4) {
    for (const [layer, file] of [
      ["inner1", "In1_Cu"],
      ["inner2", "In2_Cu"],
    ] as const) {
      const content = gerberLayers[file];
      if (content !== undefined) {
        gerberLayers[file] = addInnerPlatedSlotFlashes(content, adapterCircuitJson, layer);
      }
    }
  }
  const drillLayers = convertSoupToExcellonDrillCommandLayers({
    circuitJson: adapterCircuitJson,
  });
  const assemblyCircuitJson = assemblyCsvCircuitJson(options.circuitJson);
  const bomRows = await convertCircuitJsonToBomRows({ circuitJson: assemblyCircuitJson });
  const bom = strictBomCsv(bomRows, assemblyCircuitJson);
  const pickAndPlace = omitDnpPlacements(
    convertCircuitJsonToPickAndPlaceCsv(assemblyCircuitJson),
    assemblyCircuitJson,
  );

  const files: ManufacturingFile[] = [];
  for (const [layer, content] of Object.entries(gerberLayers).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    files.push(
      Object.freeze({
        path: `gerbers/${options.boardName}-${layer}.gbr`,
        kind: "gerber" as const,
        content: canonicalizeManufacturingText(content),
      }),
    );
  }
  for (const [name, commands] of Object.entries(drillLayers).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    files.push(
      Object.freeze({
        path: `drills/${name}`,
        kind: "drill" as const,
        content: canonicalizeManufacturingText(stringifyExcellonDrill(commands)),
      }),
    );
  }
  files.push(
    Object.freeze({ path: "assembly/bom.csv", kind: "bom" as const, content: bom }),
    Object.freeze({
      path: "assembly/positions.csv",
      kind: "pick-and-place" as const,
      content: pickAndPlace,
    }),
    Object.freeze({
      path: "fabrication/metadata.json",
      kind: "metadata" as const,
      content: fabricationMetadata(options.boardName, options.circuitJson, layerCount),
    }),
  );

  return Object.freeze(files);
}

export async function emitDraftManufacturingDirectory(options: {
  readonly targetDirectory: string;
  readonly files: readonly ManufacturingFile[];
}): Promise<readonly string[]> {
  requireSupportedBunRuntime();
  try {
    await access(options.targetDirectory);
    throw new Error(`Refusing to overwrite existing run output: ${options.targetDirectory}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }

  const parent = dirname(options.targetDirectory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".pcboo-stage-"));

  try {
    for (const file of options.files) {
      const target = join(staging, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, file.content);
    }
    await rename(staging, options.targetDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze(options.files.map((file) => file.path));
}
