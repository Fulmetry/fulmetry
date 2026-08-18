# Focused inspection

Start from the diagnostic's suggested command. Useful forms include:

```sh
bun run inspect -- --status electrical --rule <DIAGNOSTIC_ID> --json
bun run inspect -- --status fabrication --rule <DIAGNOSTIC_ID> --json
bun run inspect -- <component-or-net> --json
```

The local server's `/api/inspect` endpoint can query bounded geometry and connectivity while `bun run dev` is active, but CLI report evidence remains the durable record.

For a missing or misleading browser view, count the current artifact's `source_trace`, `schematic_trace`, `pcb_trace`, `pcb_via`, `pcb_missing_footprint_error`, `pcb_component`, pad or hole, and `cad_component` records. Inspect CAD model fields and `show_as_bounding_box`. Then read the viewer implementation or supported-format contract. A renderer cannot display physical traces or models that the artifact does not contain, and a generic renderer can still hide valid model data.

Inspect only the relevant component, net, pad, layer, rule, or region. Trace the finding back to authored TypeScript, configuration, lock data, tests, simulations, models, vendor data, or waiver declarations. Generated object IDs may change; prefer stable source names and diagnostic identities.

After a patch, first repeat the focused inspection or failing command. Then run the broader command that owns the affected status and any related Bun tests. A disappearing message is insufficient if the requested dimension remains non-passing or the test is insensitive.
