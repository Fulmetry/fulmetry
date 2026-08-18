# KiCad handoff

Create a detached handoff with:

```sh
bun run pcboo export kicad --json
```

Treat the output as a new downstream artifact, not a synchronized round trip. Inspect the result for exact, lossy, unsupported, or unreconciled mappings. Require independent reconciliation of custom and built-in footprint identity, pad geometry, oval plated-slot drills, trace layers, and exactly one emitted via per source physical via. PCBoo's exact baseline remains narrower than all KiCad constructs.

Never overwrite a human-edited KiCad project with a regenerated handoff. Choose a fresh destination or preserve the human-edited copy outside PCBoo's disposable run output.

When live KiCad validation is available, require the supported signed application and accept its returned violations or interoperability failures honestly. Missing, unsupported, unsigned, relocated, changed, timed-out, or semantically divergent tools cannot produce a qualified result.

After manual KiCad changes, the KiCad files are a separate source branch of the design unless a future reviewed import path proves otherwise. Do not claim those edits automatically changed the PCBoo TypeScript source.
