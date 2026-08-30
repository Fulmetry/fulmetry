---
name: fulmetry-manufacturing
description: Generate, inspect, and independently verify Fulmetry manufacturing artifacts and detached KiCad handoffs. Use for Gerber, drill, BOM, pick-and-place, layer-stack, four-layer inner-copper, KiCad export, artifact provenance, waiver review, or production-release questions.
---

# Fulmetry manufacturing

Keep draft export, independent artifact verification, standards evidence, and human production approval separate.

## Workflow

1. Confirm a clean current source digest, explicit board revision, intended layer count, ordered layer roles, and every required plane or mixed-layer region.
2. Run `bun run build --json`, `bun run check --json`, and relevant tests or simulations.
3. For diagnostic manufacturing files, follow [draft Gerbers](references/gerbers.md).
4. Run `bun run fulmetry verify manufacturing --json` to generate and independently reconcile the exact emitted Gerber, plated routed-slot drill, via, BOM, and placement bytes. Require every authored rectangular layer keepout to pass the independent copper-intersection check before treating the board as fabrication-ready.
   Do not promote a plane claim when `pcb_copper_pour` or equivalent zone geometry remains unsupported by reconciliation; non-empty inner copper is not plane continuity.
5. For editable downstream CAD, follow [KiCad handoff](references/kicad-handoff.md) and require semantic reconciliation to pass before calling the handoff exact.
6. Apply the [production gates](references/production-gates.md) before making any release claim.
7. Report each status dimension, waiver, limitation, artifact digest, and human decision separately.

## Boundaries

- Do not edit or overwrite `.fulmetry/` artifacts.
- Do not call draft output verified or production-ready.
- Do not infer function from Gerber validity or fabrication from a schematic.
- Do not call profile evidence certification or legal compliance.
- Do not order, publish, promote, substitute, or waive without explicit human authorization.
