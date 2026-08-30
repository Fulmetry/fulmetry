# Component contracts

Before using a new real component, reconcile:

1. Manufacturer part number and datasheet revision or source.
2. Recommended operating conditions and relevant absolute maximums.
3. Pin names, numbers, polarity, power pins, exposed pads, and no-connect rules.
4. Package name, dimensions, orientation mark, and footprint pad numbering.
5. Symbol-pin to footprint-pad mapping.
6. Required external components, decoupling, protection, termination, and layout guidance.
7. Simulation model source, pin mapping, license, digest, and redistribution permission when simulation is required.
8. Vendored asset source, version, license/notice, attribution, and digest when manufacturing redistribution is intended.

## Resolution workflow

1. Start from the exact manufacturer part number selected by the design, not a visually similar package or supplier search result.
2. Read the current manufacturer datasheet and package drawing. Use an official manufacturer model or library asset when available; otherwise compare a third-party asset against the primary drawing and license.
3. Reconcile symbol pins, logical names, footprint pad numbers, exposed pads, orientation, and no-connect rules before attaching the footprint.
4. Attach a realistic CAD model when the requested deliverable includes 3D inspection. Record its source, license, digest, units, origin, rotation, and board-normal direction. A bounding box is a visible unresolved state, not a realistic model.
5. If no trusted exact asset exists, create and vendor a reviewed footprint or model from the primary drawing with provenance metadata. Do not silently omit it and continue toward a completion claim.
6. Build and inspect the generated `source_component`, `pcb_component`, pads, and `cad_component` records for the named part before resolving the next ambiguous family.

Exhaust authoritative sources and supported asset formats before stopping. Stop on ambiguity that remains after this workflow and return the exact unresolved decision to the user. A consistent symbol and footprint generated from the same mistaken source is not independent proof of a correct pin map.

Treat recorded supplier identifiers as selection records, not proof of current stock, lifecycle, price, package compatibility, or authorized substitution.

## Electrical metadata and rail provenance

Prefer the semantic primitive that matches the device (`Switch`, `PushButton`,
`Inductor`, and so on) when it can preserve the exact pin map and footprint. Use
`Chip` for a passive or protection device only when tscircuit has no accurate
primitive. In that case, make the exception explicit: give it an unambiguous
display name, mark required terminals with `mustBeConnected`, and describe real
ground behavior without inventing a supply pin. Never set `requiresPower` merely
to silence a warning on an unpowered ferrite bead, switch, ESD array, or TVS
array.

For every powered IC, declare its actual supply and ground pins with
`pinAttributes`. Model the complete rail provenance as well as consumers:

- an input connector or source provides the incoming voltage and ground;
- protection, e-fuse, regulator, switch, and ferrite boundaries declare the
  power they require and the power they provide on the output side;
- the regulated output establishes the voltage consumed by downstream ICs;
- no-connect pins use `noConnect` or `doNotConnect` instead of being omitted.

After adding these contracts, run `fulmetry check` and treat
`ELECTRICAL_PIN_OBLIGATION_001` as evidence of a broken or incomplete provider
chain. Repair the chain; do not remove correct consumer requirements.
