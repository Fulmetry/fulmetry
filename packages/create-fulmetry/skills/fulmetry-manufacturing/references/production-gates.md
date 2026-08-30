# Production gates

Before any production promotion, reconcile all requirements against current, digest-bound evidence:

- source, configuration, lock, board revision, and accepted tscircuit identities;
- electrical, fabrication, functional, standards, and sourcing statuses independently;
- every active diagnostic and explicit waiver;
- exact Gerber, drill, BOM, placement, and manifest inventories and digests;
- component, footprint, model, and vendored-asset provenance;
- redistribution permission and required bundle-local attribution;
- required simulations and sensitivity-proven tests;
- unsupported or lossy KiCad mappings that affect intent;
- explicit human approvals for substitutions, waivers, and release.

Reject stale evidence after any authored input changes. A production claim is blocked when a required dimension is failed, incomplete, unavailable, unsupported, unchecked, stale, or outside Fulmetry's qualified surface.

Fulmetry pre-compliance results are not regulatory certification, legal advice, fabrication guarantees, or proof that a design is safe. Production publication and fabrication ordering remain explicit human actions.
