# Online model resolution policy

## Source priority

Use the first source that provides an exact, reviewable match and usable terms:

1. component manufacturer's product page or official CAD portal;
2. the component manufacturer's documented GitHub or EDA library;
3. an official open-source EDA library with a traceable package/model mapping;
4. a distributor or CAD aggregator only when its terms allow the intended local use and redistribution.

Treat search-result snippets as discovery, not evidence. Open the source page and record the exact URL, part number, package revision, download date or upstream version, and license or terms page. Do not assume that a freely downloadable CAD file is open source or redistributable.

## Match criteria

Before accepting a model, reconcile:

- exact manufacturer part number and package suffix;
- body width, length, height, pitch, pin count, mounting posts, tabs, slots, and connector overhang;
- pin-one or contact-one orientation and mating direction;
- model units and coordinate system;
- footprint land pattern and drill geometry;
- source revision and file digest.

Generic passives may share a package-equivalent parametric model when the package code and dimensions match. Unique connectors, jacks, switches, modules, displays, microphones, speakers, and controls do not qualify for a generic-box substitution.

## License decision

Record the license exactly as published. If the source gives no license or unclear redistribution terms, set redistribution to `unknown`, keep the asset out of redistributable bundles, and report the blocker. If redistribution is prohibited, do not commit the model to a public project.

PCBoo's current production promotion policy may be narrower than local-use licensing. Passing this resolution workflow does not override the production promotion gate or third-party terms.

## Storage

Use deterministic, descriptive paths such as `models/manufacturer/mpn/revision/model.glb`. Prefer GLB when an authoritative GLB is available because it preserves materials in the browser. STL is acceptable for geometry-only sources; OBJ should retain its associated material files. Keep the authoritative source format when useful, but bind a format the PCBoo viewer actually consumes.

Do not make the final view depend on a third-party host remaining online. Vendor approved assets, hash them with SHA-256, and bind project-local URLs.
