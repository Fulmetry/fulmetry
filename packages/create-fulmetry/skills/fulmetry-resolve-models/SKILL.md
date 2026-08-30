---
name: fulmetry-resolve-models
description: Resolve, vendor, license-check, bind, and verify realistic component 3D models for Fulmetry projects before any final browser preview. Use when selecting components, adding or changing footprints, fixing bounding boxes or generic cubes, preparing the assembled 3D view, or before starting bun run dev for a complete physical-board handoff.
---

# Fulmetry resolve models

Make the assembled view a verified consequence of the authored circuit. Do not use a generic cube, an unlicensed download, or a runtime-only remote URL as a substitute for a component model.

## Required workflow

1. Read `AGENTS.md`, `fulmetry.config.ts`, `fulmetry.lock`, the board entry, and the modules that define physical parts.
2. Run a fresh `bun run build --json`. Read its current Circuit JSON and enumerate every `pcb_component` and `cad_component` by `source_component_id`.
3. Run `bun .agents/skills/fulmetry-resolve-models/scripts/audit-cad-models.ts --circuit <current-circuit.json>`. Treat exit code 3 as an incomplete physical asset gate, not a warning to suppress.
4. For each unresolved or bounding-box part, identify its exact manufacturer part number, package variant, body dimensions, board side, orientation, and pin-one convention. A unique connector, switch, module, or electromechanical part requires the exact model; a verified package-equivalent parametric model is acceptable only for genuinely generic package bodies.
5. Search online using [resolution policy](references/resolution-policy.md). Prefer the manufacturer or an official library, check redistribution terms before downloading, and never scrape a source whose terms or access controls prohibit it.
6. Vendor the approved file under `models/` or `vendor/models/`, record its digest, source, version, license, attribution, license notice, and redistribution state in `fulmetry.lock.assets`, and retain the required notice. Runtime HTTP model dependencies are not a completion state.
7. Bind the vendored model in authored TypeScript with explicit units, origin, position offset, board-normal direction, rotation offset, and surface offset. Read [model contract](references/model-contract.md).
8. Rebuild and rerun the audit. Require zero missing links, zero `show_as_bounding_box` records, zero remote runtime model URLs, and zero unresolved provenance or license decisions for every applicable part.
9. Load `fulmetry-verify` for the independent physical-coverage check. Only after both gates pass may the workflow start `bun run dev` and open `/3d` in a browser.
10. In the browser, verify actual geometry, color/material where the source format supports it, scale, orientation, board side, seating height, pin-one alignment, and connector mating direction. If visual verification fails, stop the server, repair source, and repeat the gate.

## Preview gate

Do not open the browser as the first way to discover model coverage. Do not start `bun run dev` as the final handoff until this skill's audit and the applicable Fulmetry checks pass. An explicitly requested diagnostic preview is allowed only when labeled incomplete and must list every fallback model.

If no exact model can be legally obtained, report the exact part and licensing or availability blocker. Offer a reviewed package-equivalent model only when it preserves the relevant mechanical envelope and the user approves the limitation. Never generate plausible-looking geometry and call it the manufacturer's model.

## Boundaries

- Never edit `.fulmetry/`; it is evidence generated from authored source.
- Never infer electrical correctness, assembly clearance, or manufacturability from appearance.
- Never treat `show_as_bounding_box`, an unbound `pcb_component`, or an arbitrary cube as realistic 3D coverage.
- Never commit an asset with `redistribution: "unknown"` as a redistributable release artifact.
- Preserve attribution even when the license does not require prominent UI credit.
- Keep model acquisition bounded: download only the exact files needed by the current board.
