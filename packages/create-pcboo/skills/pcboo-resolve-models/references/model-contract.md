# Authored model contract

Each applicable physical component must produce one `cad_component` linked through the same `source_component_id` and `pcb_component_id` as its footprint.

The authored component should declare `cadModel` using a reviewed local asset and explicit transforms. Use fields supported by the pinned tscircuit version, including the appropriate URL field plus `modelUnitToMmScale`, `modelBoardNormalDirection`, `rotationOffset`, `positionOffset`, `pcbRotationOffset`, and `zOffsetFromSurface` when needed.

The resulting Circuit JSON must satisfy all of these conditions:

- `show_as_bounding_box` is absent or false;
- the model has a supported model URL or a qualified package-equivalent `footprinter_string`;
- direct model URLs are project-local rather than `http:`, `https:`, or protocol-relative URLs;
- position and rotation values are finite;
- the model is attached to the intended PCB component;
- the emitted format is consumed by PCBoo's assembled viewer.

Treat the source footprint as electrical and manufacturing geometry and the CAD model as assembly visualization. Aligning a model does not repair an incorrect land pattern, slot, courtyard, or keepout.

After the structural audit, visually compare the model against the footprint and datasheet. Check body envelope, board seating, underside/topside placement, pin one, overhang, mating direction, and adjacent-part clearance. Record any intentionally accepted package-equivalent limitation in authored project documentation.
