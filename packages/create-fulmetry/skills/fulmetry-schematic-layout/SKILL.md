---
name: fulmetry-schematic-layout
description: Clean, organize, and verify Fulmetry schematics with authored logical coordinates, functional zones, progressive label disclosure, and machine-checkable collision gates. Use when a schematic is crowded, symbols or labels overlap, a large IC is unreadable, the fit-to-canvas view is confusing, or a Fulmetry circuit needs deterministic schematic-layout checks without changing PCB placement or electrical topology.
---

# Fulmetry schematic layout

Make the schematic readable in source and prove that the improvement survives a rebuild. Treat schematic composition as a separate authored design layer; never reuse PCB coordinates as logical coordinates.

## Workflow

1. Read the circuit entry, every component module, the placement source, and existing tests. Count schematic components, ports, traces, labels, and functional subsystems from fresh Circuit JSON.
2. Preserve the electrical topology and every `pcbX`, `pcbY`, `pcbRotation`, authored PCB trace, via, footprint, model, and mechanical datum. A schematic-only repair may change only `schX`, `schY`, `schRotation`, supported schematic symbol properties, grouping, and schematic-view presentation.
3. Add explicit schematic coordinates for every visible component. Arrange functional zones in reading order—normally source/input at left, processing in the centre, outputs at right, and support parts adjacent to the device they serve. Keep the coordinates in a named schematic-layout map or similarly isolated source section.
4. Give large symbols enough `schWidth` and `schHeight` for their pin count and label lengths. At the Fulmetry engine pinned to tscircuit 0.0.2261, `schPinArrangement` must use numeric pin identifiers; label strings are emitted unchanged and rejected by the qualified Circuit JSON validator. The engine fixes base pin spacing at 0.2 units, so use symmetric `schPinStyle` top/bottom margins on densely pinned left/right sides and prove the rendered port spacing from Circuit JSON.
5. Prefer local net labels and short functional connections over long crossing wires. Never rename electrical nets merely to improve appearance. For a very large design, propose multiple logical sheets or groups instead of compressing everything into one overview, but do not invent multi-sheet semantics unsupported by the current viewer.
6. Make overview and detail modes distinct. The fit view must default to net labels, pin names, and pin numbers hidden; users may reveal them after zooming. This presentation rule does not excuse overlapping component bodies or an incoherent functional flow.
7. Add or update Bun tests that render the circuit and require:
   - every source component has one schematic component with finite authored coordinates;
   - no two schematic-component bounding boxes overlap after a 0.25 schematic-unit margin;
   - the overall bounds are finite and intentionally landscape or portrait, not an accidental outlier;
   - high-pin-count symbols have an explicitly reviewed width and height;
   - schematic-only changes leave PCB component coordinates and electrical connectivity unchanged.
8. Run `bun run build`, the focused Bun tests, `bun run check`, and the project's verification gates. Inspect fresh Circuit JSON rather than a stale browser snapshot.
9. Start or refresh `bun run dev`, open `/schematic`, verify fit view and zoomed detail, and capture any remaining label collision or wire ambiguity as a named unresolved issue. Do not call a schematic clean solely because the build passed.

## KiCad boundary

Use `kicad-cli sch erc` and schematic exports only after a valid KiCad schematic exists and interoperability is in scope. KiCad CLI provides validation and export commands, not automatic schematic placement or cleanup, so it is not a substitute for authored Fulmetry schematic coordinates and legibility tests.

## Completion report

Report the functional zones, component count, overlap-gate result, any visibility defaults, the before/after PCB-coordinate comparison, build/check/test results, browser URL, and unresolved renderer or engine limitations.
