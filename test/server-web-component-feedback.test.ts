// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { canCopyComponentMoveFeedback, componentMoveFeedbackPrompt, componentPlacementChangesPrompt, resolveComponentFeedbackSelection } from "../src/server/web/lib/component-feedback";

test("component feedback resolves human identity and authored board placement", () => {
  const circuit = [
    { type: "source_component", source_component_id: "source_u4", name: "U4", display_name: "Stereo audio DAC", manufacturer_part_number: "PCM5100APWR" },
    { type: "schematic_component", schematic_component_id: "schematic_u4", source_component_id: "source_u4" },
    { type: "pcb_component", pcb_component_id: "pcb_u4", source_component_id: "source_u4", center: { x: 21, y: -10 }, rotation: 90, layer: "top", placement_policy: "movable-with-cluster" },
  ];
  const selection = resolveComponentFeedbackSelection(circuit, {
    type: "schematic_component",
    schematicComponentId: "schematic_u4",
  });
  expect(selection).toMatchObject({
    reference: "U4",
    description: "Stereo audio DAC",
    manufacturerPartNumber: "PCM5100APWR",
    xMm: 21,
    yMm: -10,
    rotationDeg: 90,
    side: "top",
    movementPolicy: "movable-with-cluster",
  });
  const prompt = componentMoveFeedbackPrompt(selection);
  expect(prompt).toContain("Move U4 — Stereo audio DAC — PCM5100APWR");
  expect(prompt).toContain("x=21 mm, y=-10 mm, rotation=90°");
  expect(prompt).toContain("reroute every affected authored trace and via");
  expect(canCopyComponentMoveFeedback(selection)).toBe(true);
});

test("move feedback refuses non-component drawing objects and never emits undefined policy", () => {
  const selection = resolveComponentFeedbackSelection([], { type: "pcb_trace" });
  expect(canCopyComponentMoveFeedback(selection)).toBe(false);
  expect(componentMoveFeedbackPrompt(selection)).toContain("Movement policy: not declared.");
  expect(componentMoveFeedbackPrompt(selection)).not.toContain("undefined");
});

test("PCB renderer pad names resolve back to their owning component", () => {
  const circuit = [
    { type: "source_component", source_component_id: "source_j1", name: "J1", display_name: "USB-C connector" },
    { type: "pcb_component", pcb_component_id: "pcb_j1", source_component_id: "source_j1", center: { x: -42, y: 3.5 }, rotation: 0, layer: "top" },
  ];
  const selection = resolveComponentFeedbackSelection(circuit, { type: "pcb_smtpad", pad: "J1.GND_A1_B12" });
  expect(selection).toMatchObject({ reference: "J1", xMm: -42, yMm: 3.5, pad: "J1.GND_A1_B12" });
  expect(canCopyComponentMoveFeedback(selection)).toBe(true);
});

test("placement feedback prompt records exact before, after, and delta coordinates", () => {
  const prompt = componentPlacementChangesPrompt([{ reference: "J1", description: "USB-C connector", fromX: -42, fromY: 3.5, toX: -40.25, toY: 5, rotationDeg: 0, side: "top", movementPolicy: "fixed-edge" }]);
  expect(prompt).toContain("from x=-42 mm, y=3.5 mm to x=-40.25 mm, y=5 mm");
  expect(prompt).toContain("delta x=1.75 mm, delta y=1.5 mm");
  expect(prompt).toContain("reroute every affected authored trace and via");
});
