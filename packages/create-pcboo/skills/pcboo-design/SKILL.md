---
name: pcboo-design
description: Create or edit complete PCBoo circuits as composable TypeScript, including architecture, component and model resolution, footprints, layer-count and stack-up selection, board constraints, placement feedback, routing, physical-readiness checks, verification, and final browser preview. Use when asked to create, build, or design a circuit or board from components, add or move parts and nets, select footprints or CAD models from verified information, implement physical layout, or finish an incomplete PCBoo design.
---

# PCBoo design

Create an explicit, reviewable circuit from known requirements. Unless the user explicitly requests a schematic, logical-only prototype, or incomplete exploration, `create a circuit` means completing both the logical circuit and its physical PCB representation. Do not guess electrical or mechanical values that affect safety or function, and do not call unresolved work done.

## Design workflow

1. Read `AGENTS.md`, `pcboo.config.ts`, `pcboo.lock`, the board entry, and relevant component modules.
2. Classify the requested deliverable as complete physical board or explicitly limited logical/draft work. Record the requested behavior, interfaces, rails, mechanics, constraints, acceptance checks, assumptions, and unresolved decisions.
3. Resolve every selected component's pin, package, footprint, realistic CAD model when requested, and provenance contract. Read [component contracts](references/component-contracts.md) and load `pcboo-resolve-models` for model acquisition, licensing, binding, and its pre-preview audit. Search authoritative sources and vendor reviewed assets when necessary; omission is a blocker, not completion.
4. Implement small named modules and one board composition. Read [composition](references/composition.md).
5. Choose and record the layer count, every layer's intended role, reference-plane continuity, and the evidence that justifies the cost and complexity. Read [layer count and stack-up](references/layer-count-and-stackup.md). A non-empty inner layer is not proof of a ground or power plane.
6. Encode the board outline, stack, placement, constraints, semantic authored traces, explicit vias, mechanical-pad intent, and physical model bindings in source. Read [physical design](references/physical-design.md), including its clearance and routing-congestion escalation rules. For a requested move or alignment, apply [placement feedback](references/placement-feedback.md).
7. Run `bun run build --json` after each coherent source change and inspect the current Circuit JSON rather than relying on the visual render.
8. Apply [completion and preview](references/completion-and-preview.md). For a complete-board request, require zero unresolved footprints, routed physical connectivity, required model coverage, zero unsupported manufacturing constructs, and no placeholder geometry before claiming completion.
9. Run `bun run check --json`, `bun run test --json`, and the focused verification or manufacturing commands required by the design. Load `pcboo-verify` for the independent evidence pass.
10. Only after the completion gate and `pcboo-resolve-models` audit pass, start `bun run dev`, wait for readiness, open the relevant browser routes, and visually verify that the schematic, PCB, traces, footprints, and 3D models match the current artifact.
11. Keep the server running for the user and report its URL, source digest, evidence, and any claims that remain outside the requested scope.

## Boundaries

- Never edit `.pcboo/`.
- Preserve stable, unique component and trace names.
- Keep electrical topology changes separate from layout-only repairs.
- Keep fixed mechanical datums distinct from movable placement. Never infer that a connector, antenna, microphone aperture, control, mounting feature, or enclosure datum may move.
- Do not silently substitute parts, packages, footprints, models, or voltage domains.
- Do not leave routing disabled without complete authored semantic routes, omit physical assets, accept bounding-box models, or show an incomplete board as the final result unless the user explicitly requested a limited draft.
- Do not start the server as a completion handoff when the physical-readiness gate fails. A diagnostic preview is allowed only when explicitly requested and labeled incomplete.
- Do not treat successful compilation or an attractive browser render as electrical, fabrication, or functional passage.
