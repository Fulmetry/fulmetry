---
name: pcboo-verify
description: Verify PCBoo logical and physical circuit requirements with ordinary Bun tests, fresh Circuit JSON inventory checks, qualified simulations, deterministic command results, sensitivity checks, and independent evidence review. Use when adding tests or simulations, proving topology, footprint and route coverage, realistic-model coverage, numerical behavior, auditing a claimed fix or completed board, or deciding what a PCBoo result actually establishes.
---

# PCBoo verify

Define the claim narrowly, choose evidence that could falsify it, and retain the exact result bound to current source.

## Verification workflow

1. Translate each requirement into a verification method and expected status dimension.
2. Use [connectivity tests](references/connectivity-tests.md) for logical topology and regressions.
3. Use [simulation](references/simulation.md) only when a qualified model, explicit region, stimulus, analysis, units, tolerances, and numerical assertions exist.
4. For a completed physical-board claim, independently inspect the fresh Circuit JSON for component-to-footprint coverage, electrical versus explicit `pcboo:mechanical` pads, circular and slotted holes, intentional placement, exact layer count and ordered layer roles, required plane continuity, rectangular keepout layer coverage and copper exclusion, semantic `pcb_trace` endpoint coverage, one explicit full-stack via per transition, missing-footprint errors, placeholder CAD records, and model formats consumed by the viewer.
5. Run `bun run build --json`, followed by `bun run check --json`, `bun run test --json`, `bun run pcboo verify manufacturing --json`, and the other commands relevant to the claim. For a KiCad claim, also run `bun run pcboo export kicad --json` and require semantic reconciliation.
6. Prove important negative tests are sensitive by introducing a controlled defect in isolated work, observing failure, and restoring the source.
7. Re-run the final commands from clean or fresh context when the risk warrants independence.
8. Return an [evidence handoff](references/evidence-handoff.md). Start the server only after handing the passing evidence back to the design workflow.

## Integrity rules

- Do not infer functional passage from build, visual render, ERC, DRC, or valid Gerber syntax.
- Do not accept a physical-completion claim with missing footprints, routing disabled without complete authored routes, required logical connections but zero PCB traces or non-endpoint-complete PCB traces, null trace owners, duplicate or incomplete vias, unresolved 0.20 mm clearance findings, placeholder-only requested 3D models, or a viewer that ignores the emitted model format.
- Do not infer a reference or power plane from layer count, non-empty inner copper, scattered traces, or valid Gerber syntax. If a required copper pour cannot be independently reconciled, keep the physical claim incomplete or unsupported.
- Do not infer certification from a standards-profile result.
- Do not accept focused, skipped, todo, zero-case, timed-out, or subprocess-capable tests as authoritative passage.
- Do not claim simulation passage when a model, solver, containment boundary, or assertion is missing or unavailable.
- Do not repair production circuit source while acting as its independent critic.
