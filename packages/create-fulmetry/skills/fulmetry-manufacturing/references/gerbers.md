# Draft Gerbers and manufacturing verification

Create explicitly draft output with:

```sh
bun run export:gerbers --json
```

This command intentionally leaves fabrication incomplete and exits nonzero until separate verification runs. Preserve that behavior; do not wrap it into a false success.

Independently verify an exact generated set with:

```sh
bun run fulmetry verify manufacturing --json
```

Review the report's layer inventory, apertures, geometry, circular and G85 routed-slot drill hits, plating, board outline, component placement, BOM rows, coordinates, source snapshot, and per-file digests. For four-layer boards, require correctly identified, non-empty inner copper, annular copper for every full-stack via and plated slot, and the intended copper-layer order. Reject duplicate drills caused by representing one via both as a route point and a physical record.

A syntactically valid Gerber set does not establish topology, simulation behavior, sourcing availability, standards certification, or safety. Preserve those as separate status dimensions and evidence.
