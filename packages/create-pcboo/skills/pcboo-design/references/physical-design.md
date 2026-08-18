# Physical design

Translate mechanical and electrical intent into source-controlled board geometry, placement, constraints, traces, and vias.

## Before placement

- Confirm outline, layer count and ordered layer roles, board revision, connector edges, mounting holes, keep-outs, height limits, and fixed mechanical coordinates. Apply [layer count and stack-up](layer-count-and-stackup.md); copper presence is not plane continuity.
- Prefer axis-aligned rectangular copper keepouts with explicit board-layer lists when that expresses the intent; PCBoo independently checks those regions. Treat other keepout shapes as unsupported until a profile explicitly qualifies them.
- Confirm voltage/current classes, sensitive analog regions, return paths, differential or timing constraints, and thermal needs.
- Keep logical topology stable unless an electrical change is separately reviewed.

## Placement and routing

- Place fixed mechanical parts first, then power/protection, critical signal paths, and remaining components.
- Keep decoupling and protection elements near the pins or entry points they protect.
- Give every physical component an intentional position and orientation; packed or coincident defaults are not final placement.
- Use explicit trace widths, via transitions, and named constraints where supported.
- Route every required logical connection. A design with logical or schematic traces but zero `pcb_trace` records is unrouted, even when the board and components render.
- Prefer `defineRoute`/`defineRoutes` plus `SemanticPcbTrace` for durable source routes. Split routes by net across small modules and compose them through one route index.
- `routingDisabled: true` is valid only when every required connection is replaced by complete authored semantic routes. It must never mean an unrouted board.
- Mark electrically unconnected support or shell pads explicitly with the `pcboo:mechanical` port hint. Never use that marker to hide an electrical pin.
- Require every layer change to have one explicit full-stack physical via record bound to its owning trace. A route transition is metadata; it must not produce a second drill.
- If mechanics prevent routing, stop with the unresolved mechanical inputs instead of presenting the draft as finished.
- Prefer small coherent edits. Inspect the relevant component, pad, net, layer, rule, or region after a diagnostic.
- For human-directed movement or alignment, apply [placement feedback](placement-feedback.md), preserve fixed datums, and reroute every affected authored route.
- For four-layer designs, explicitly verify the intended copper-layer order and non-empty inner copper in emitted manufacturing evidence.

## Clearance and routing congestion

- Treat `0.20 mm` as a conservative general copper-clearance default for ordinary boards, not as a universal rule for every geometry.
- Keep general clearance at `0.20 mm` where practical. Use a qualified fabrication profile's typed or locally scoped rule for fine-pitch SMD breakout, commonly `0.15 mm`; use `0.10 mm` only when the selected fabricator, copper weight, component geometry, and project requirements explicitly support it. Do not lower the whole board merely to escape one fine-pitch package.
- Keep distinct manufacturing constraints distinct. Pad-to-track, pad-to-pad, via-to-track, plated-hole-to-track, copper-to-edge, slot, keepout, and assembly-spacing limits are not interchangeable with general copper clearance.
- Diagnose a failed or poor router candidate before changing geometry. Inspect unrouted-net count, clearance findings, conflict locations, escape paths, placement density, fixed mechanics, and whether the router actually modeled the selected rule classes. A timeout or router completion message alone is not evidence that the board is too small.
- Resolve congestion in this order: correct invalid or over-broad rule modeling; apply only profile-qualified local fine-pitch rules; improve placement and orientation while preserving mechanical and electrical intent; then enlarge the board outline when routing channels remain genuinely insufficient.
- Never resize an outline constrained by an enclosure, connector datum, mounting pattern, or explicit user dimension without approval. When the outline is flexible, enlarge only the congested axis or region in a small, documented increment, preserve fixed mechanical coordinates, redistribute movable parts, and compare fresh before/after routing and DRC evidence. Prefer the smallest outline that passes rather than an arbitrary large board.
- After any rule, placement, or outline change, rebuild from authored source and rerun electrical connectivity, physical connectivity, clearance, keepout, board-edge, footprint, and manufacturing-profile checks. Treat a fully routed result with clearance violations as failed.

## Router candidates

Use the bounded Freerouting adapter only to propose geometry. It requires an explicitly selected, SHA-256-pinned Freerouting JAR and Java 25:

```sh
bun run pcboo route freerouting --jar /absolute/path/freerouting.jar --jar-sha256 <sha256> --clearance-mm 0.20 --json
```

Review the candidate and promote it into a new source directory with explicit via sizes:

```sh
bun run pcboo route promote .pcboo/runs/<run-id>/candidate-circuit.json --output circuit/routes --via-hole-mm 0.30 --via-outer-mm 0.60 --json
```

Promotion is the only routing command allowed to author source, refuses overwrite, and generates stable component/port/net selectors. Rebuild and run fabrication clearance checks after promotion. Never treat a router completion message as DRC passage.

## Physical artifact inspection

After each build, inspect the current Circuit JSON for missing-footprint errors, zero-size component geometry, coincident placement, absent pads, absent routes, null trace owners, duplicate drills, malformed or incomplete via transitions, placeholder CAD records, and model URL or asset fields that the selected viewer cannot consume. Compare counts against the intended component and connection inventory; do not infer coverage from a board screenshot.

After each coherent change, run `bun run build --json`. Run `bun run check --json` before claiming electrical or physical adequacy. Use the browser for orientation and measurement assistance; use structured inspection and command evidence for exact claims.
