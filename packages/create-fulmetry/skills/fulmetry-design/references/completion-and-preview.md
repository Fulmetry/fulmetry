# Completion and preview

Apply this gate whenever the user asked to create, build, finish, or show a circuit or PCB rather than an explicitly limited logical draft.

## Fresh artifact gate

Run `bun run build --json` and read the emitted report and its current Circuit JSON artifact. Require all of the following before calling the physical design complete:

- exactly one intended board with the approved outline, revision, layer count, and ordered layer-role contract;
- every selected physical component has a reconciled footprint, nonzero geometry, pads or holes, intentional position, and orientation;
- the schematic is organized into legible functional regions or sheets without component, pin-name, or net-label collisions at its normal inspection scale;
- zero `pcb_missing_footprint_error` records and no unresolved physical-asset diagnostics;
- required logical connections have physical `pcb_trace` routes with widths, layers, and vias where applicable; logical connectivity with zero PCB traces is incomplete;
- routing is enabled, or deliberately disabled only because complete authored `SemanticPcbTrace` routes cover every required logical connection;
- every route endpoint resolves to its intended pad, every layer transition has one explicit full-stack via, and no trace has a null component owner;
- realistic-3D requests have a model-backed `cad_component` for every applicable part, no `show_as_bounding_box` fallback, and a viewer that actually consumes the emitted model format; load `fulmetry-resolve-models` and require its current Circuit JSON audit to pass before browser startup;
- no component collisions, off-board placements, malformed vias, unconnected required pads, or unexplained coincident defaults;
- every required reference or power plane is represented and independently verified as continuous; non-empty inner copper or a ground trace mesh is not a plane;
- `bun run check --json` reports no electrical-connectivity or fabrication-clearance failures, and `bun run fulmetry verify manufacturing --json` reports no unsupported geometry or artifact mismatch;
- the artifact inventory and source digest match the source being handed off.

If any item fails, continue the design workflow or report a precise blocker. Do not hide the finding, remove an error overlay, or substitute generic geometry merely to make the browser look complete.

## Evidence gate

Run `bun run check --json` and `bun run test --json`, then any required simulation, standards, sourcing, or manufacturing verification. Read the durable reports and keep their status dimensions separate. A successful build is necessary but not sufficient.

## Server handoff

Only after the applicable fresh-artifact and evidence gates pass:

1. Stop or replace only the stale server instance for this exact project and port.
2. Start `bun run dev` on an available loopback port and wait for its readiness message.
3. Open the server in the user's browser and inspect the schematic, PCB, and 3D routes.
4. Confirm visually that traces, pads, footprints, component positions, and requested realistic models are present and correspond to the current Circuit JSON.
5. Leave the server running and report the URL, source digest, verification reports, and any explicitly out-of-scope assurance dimensions.

If the user explicitly asks to preview an incomplete design for diagnosis, label it as incomplete in the handoff and list the failed gate items. Never present that diagnostic preview as the finished circuit.
