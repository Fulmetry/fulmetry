# Placement feedback

Translate visual feedback into an unambiguous authored constraint before editing.

## Feedback packet

Identify the component by reference, display name, and manufacturer part number. Capture its current board-centred top-view coordinates, rotation, side, and placement policy. Use `+X` right, `-X` left, `+Y` up, and degrees counter-clockwise unless the project declares another convention.

Accept three useful forms:

- relative: move U4 4 mm left and 2 mm up, preserving rotation;
- absolute: place J2 at x=42 mm, y=8 mm, rotation=90 degrees;
- constraint-based: align SW1 with SW2 and SW3, retain 2 mm edge clearance, and keep J2 fixed.

Clarify camera-relative words such as left, behind, or closer when the board coordinate meaning is ambiguous. Preserve an explicit user instruction as authored design intent rather than a transient generated-output edit.

## Fixed and movable placement

Classify connectors, mounting features, antenna regions, microphone apertures, displays, controls, test access, enclosure openings, and other mechanical datums as fixed or approval-required. Classify ordinary passives as movable only within their electrical and assembly constraints. Record undeclared policy as unresolved; do not guess.

Move functional clusters coherently: decoupling stays near its supply pin, protection stays near the entry point, matched or differential paths preserve their constraints, and associated filters retain their ordering and return paths.

## Change impact

Treat a move as placement plus route repair. Determine affected pads, traces, vias, keepouts, courtyards, models, edge clearances, and enclosure relationships. With fixed authored routes, reroute every affected net; changing only `pcbX` or `pcbY` is incomplete.

After the edit, rebuild and verify component position and rotation, collisions, edge and keepout clearance, route endpoints, widths, vias, return paths, electrical connectivity, fabrication rules, manufacturing artifacts, and 2D/3D appearance. Report the before/after coordinates and every fixed datum preserved.
