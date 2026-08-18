// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type { CircuitElement } from "../types";

export interface SelectionIdentifiers {
  readonly type?: string | null;
  readonly layer?: string | null;
  readonly pad?: string | null;
  readonly pcbComponentId?: string | null;
  readonly sourceComponentId?: string | null;
  readonly schematicComponentId?: string | null;
}

export interface ComponentFeedbackSelection extends Record<string, unknown> {
  readonly type: string;
  readonly reference?: string;
  readonly description?: string;
  readonly manufacturerPartNumber?: string;
  readonly xMm?: number;
  readonly yMm?: number;
  readonly rotationDeg?: number;
  readonly side?: string;
  readonly movementPolicy: string;
}

export interface ComponentPlacementChange {
  readonly reference: string;
  readonly description?: string;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly rotationDeg?: number;
  readonly side?: string;
  readonly movementPolicy: string;
}

export function canCopyComponentMoveFeedback(selection: ComponentFeedbackSelection | null | undefined): selection is ComponentFeedbackSelection & { reference: string; xMm: number; yMm: number } {
  return selection !== null
    && selection !== undefined
    && typeof selection.reference === "string"
    && selection.reference.length > 0
    && typeof selection.xMm === "number"
    && Number.isFinite(selection.xMm)
    && typeof selection.yMm === "number"
    && Number.isFinite(selection.yMm);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function center(element: CircuitElement | undefined): { x?: number; y?: number } {
  const value = element?.center;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const x = number(record.x);
  const y = number(record.y);
  return { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
}

export function resolveComponentFeedbackSelection(
  circuit: readonly CircuitElement[],
  identifiers: SelectionIdentifiers,
): ComponentFeedbackSelection {
  const schematic = identifiers.schematicComponentId === undefined || identifiers.schematicComponentId === null
    ? undefined
    : circuit.find((element) => element.schematic_component_id === identifiers.schematicComponentId);
  const directPcbId = identifiers.pcbComponentId ?? string(schematic?.pcb_component_id);
  const pcb = directPcbId === undefined || directPcbId === null
    ? undefined
    : circuit.find((element) => element.type === "pcb_component" && element.pcb_component_id === directPcbId);
  const sourceId = identifiers.sourceComponentId ?? string(pcb?.source_component_id) ?? string(schematic?.source_component_id);
  const padReference = string(identifiers.pad)?.split(".", 1)[0];
  const source = sourceId === undefined || sourceId === null
    ? circuit.find((element) => element.type === "source_component" && string(element.name) === padReference)
    : circuit.find((element) => element.type === "source_component" && element.source_component_id === sourceId);
  const resolvedSourceId = sourceId ?? string(source?.source_component_id);
  const fallbackPcb = pcb ?? (sourceId === undefined || sourceId === null
    ? (resolvedSourceId === undefined ? undefined : circuit.find((element) => element.type === "pcb_component" && element.source_component_id === resolvedSourceId))
    : circuit.find((element) => element.type === "pcb_component" && element.source_component_id === sourceId));
  const at = center(fallbackPcb);
  const movementPolicy = string(source?.placement_policy) ?? string(fallbackPcb?.placement_policy) ?? "not declared";
  return Object.freeze({
    type: identifiers.type ?? string(schematic?.type) ?? string(fallbackPcb?.type) ?? "unknown",
    ...(string(source?.name) === undefined ? {} : { reference: string(source?.name)! }),
    ...(string(source?.display_name) === undefined ? {} : { description: string(source?.display_name)! }),
    ...(string(source?.manufacturer_part_number) === undefined ? {} : { manufacturerPartNumber: string(source?.manufacturer_part_number)! }),
    ...(at.x === undefined ? {} : { xMm: at.x }),
    ...(at.y === undefined ? {} : { yMm: at.y }),
    ...(number(fallbackPcb?.rotation) === undefined ? {} : { rotationDeg: number(fallbackPcb?.rotation)! }),
    ...(string(fallbackPcb?.layer) === undefined ? {} : { side: string(fallbackPcb?.layer)! }),
    ...(identifiers.layer === undefined || identifiers.layer === null ? {} : { selectedLayer: identifiers.layer }),
    ...(identifiers.pad === undefined || identifiers.pad === null ? {} : { pad: identifiers.pad }),
    movementPolicy,
  });
}

export function componentMoveFeedbackPrompt(selection: ComponentFeedbackSelection): string {
  const identity = [selection.reference, selection.description, selection.manufacturerPartNumber]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" — ") || "the selected component";
  const position = selection.xMm === undefined || selection.yMm === undefined
    ? "Current board coordinates are unavailable."
    : `Current position: x=${selection.xMm} mm, y=${selection.yMm} mm, rotation=${selection.rotationDeg ?? "unknown"}°, side=${selection.side ?? "unknown"}.`;
  return [
    `Move ${identity}.`,
    position,
    `Movement policy: ${string(selection.movementPolicy) ?? "not declared"}.`,
    "Requested change: [describe a relative, absolute, or alignment constraint].",
    "Preserve fixed mechanical datums and the electrical intent of nearby parts. Move constrained companion parts when required, reroute every affected authored trace and via, then rebuild and rerun connectivity, clearance, manufacturing, and 2D/3D visual checks. Report before/after coordinates and any unresolved conflict.",
  ].join("\n");
}

function coordinate(value: number): string {
  return Number(value.toFixed(3)).toString();
}

export function componentPlacementChangesPrompt(changes: readonly ComponentPlacementChange[]): string {
  const lines = changes.map((change) => {
    const identity = change.description === undefined ? change.reference : `${change.reference} — ${change.description}`;
    return `- ${identity}: from x=${coordinate(change.fromX)} mm, y=${coordinate(change.fromY)} mm to x=${coordinate(change.toX)} mm, y=${coordinate(change.toY)} mm (delta x=${coordinate(change.toX - change.fromX)} mm, delta y=${coordinate(change.toY - change.fromY)} mm), rotation=${change.rotationDeg ?? "unchanged"}°, side=${change.side ?? "unchanged"}, movement policy=${change.movementPolicy || "not declared"}.`;
  });
  return [
    `Apply these ${changes.length} PCB component placement change${changes.length === 1 ? "" : "s"}:`,
    ...lines,
    "Treat these as exact board-coordinate targets. Preserve fixed mechanical datums and electrical intent, move constrained companion parts when required, and reroute every affected authored trace and via. Rebuild and rerun connectivity, clearance, manufacturing, and 2D/3D visual checks. Report the applied before/after coordinates and any unresolved conflict.",
  ].join("\n");
}
