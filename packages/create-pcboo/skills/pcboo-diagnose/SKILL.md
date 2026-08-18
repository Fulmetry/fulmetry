---
name: pcboo-diagnose
description: Diagnose and repair one PCBoo build, electrical, fabrication, test, simulation, inspection, preview, KiCad, or manufacturing finding. Use when a PCBoo command fails, returns incomplete, unavailable, or unsupported, emits a stable diagnostic code, when browser geometry differs from Circuit JSON, or when traces, footprints, pads, layer roles, placement, component-move feedback, or realistic 3D models are absent or incorrect.
---

# PCBoo diagnose

Repair one evidence-backed finding without weakening a check or broadening scope.

## Procedure

1. Capture the exact command, exit classification, diagnostic ID, status dimension, report path, and current source digest.
2. Classify the result as a source defect, unsupported construct, missing requirement, unavailable capability, or external-tool failure.
3. Read [diagnostic interpretation](references/diagnostics.md). For routing failures or excessive clearance findings, apply its congestion decision tree before loosening a rule or resizing the board.
4. Run the narrowest applicable inspection from [focused inspection](references/focused-inspection.md).
5. For a browser or geometry mismatch, compare the current Circuit JSON inventory with the renderer's supported element and model fields. Distinguish absent design data from unsupported or incorrect visualization.
6. For a placement request, capture the named component's current coordinates, rotation, side, identity, and fixed/movable policy. Apply the design skill's placement-feedback contract and include all affected routes and mechanical datums in the repair scope.
7. Identify the source-owned cause. Never edit `.pcboo/` output.
8. Add or strengthen a regression test when the failure can be made sensitivity-proven.
9. Make the smallest coherent authored-source change.
10. Run the focused command, then `bun run build --json`, the relevant integration check, and the broad affordable suite.
11. Reopen the browser only after the owning design or verification gate passes, then compare the visible result with the same artifact digest.
12. Report the exact evidence and unresolved items. Use `pcboo-verify` for an independent audit.

## Stop conditions

Stop instead of repairing when the finding depends on an unknown requirement, ambiguous pin or footprint mapping, missing trusted model, unsupported PCBoo capability, unapproved external-tool installation, part substitution, waiver, or production approval.

Do not loosen tolerances merely to pass, suppress a diagnostic, collapse distinct nets, replace a part, or call `incomplete`, `unavailable`, or `unsupported` work passed.
