# Layer count and stack-up

Choose the fewest layers that satisfy routing, return-path, power-integrity, thermal, EMI, mechanical, and fabrication requirements. Do not choose from autorouter success alone.

## Decision sequence

1. Record fixed mechanics, board area, package density, escape requirements, voltage/current classes, edge rates, controlled-impedance needs, RF regions, mixed-signal boundaries, and the selected fabricator's qualified stack-ups.
2. Start with two layers only when the design can remain routed while preserving a broad, low-impedance ground return and all required clearances. Typical candidates are sparse, low-speed boards without demanding RF, memory, or EMI constraints.
3. Prefer four layers when a continuous reference plane, denser escape, mixed-signal return control, USB or other fast edges, an RF module, switching power containment, or improved EMI behavior materially reduces risk. A common intent is top signals/components, inner-1 solid ground, inner-2 power plus qualified slow signals, and bottom signals/ground fill.
4. Escalate to six or more layers only for evidence-backed needs such as dense BGA escape, several uninterrupted reference planes, high-speed memory, multiple power domains, or a qualified impedance stack that four layers cannot satisfy.
5. Compare cost, availability, via construction, copper weight, dielectric thickness, impedance tolerance, routability, return paths, and EMI risk. Record why the rejected lower layer count was insufficient.

## Authored contract

Keep the layer count and an ordered role for every copper layer in authored constraints. Mark each role as signal, reference plane, power plane, mixed, or intentionally unused. Record which signals reference which plane and where layer transitions require nearby return vias.

Treat these as incomplete:

- an inner layer that is merely non-empty when the requirement is a continuous plane;
- a ground trace mesh presented as equivalent to a ground plane;
- a split or perforated reference under a critical signal without reviewed return-path evidence;
- a copper pour that PCBoo can render or export but cannot independently reconcile;
- adding layers only because one router candidate timed out.

If the required plane, pour, impedance, or stack-up cannot be represented and independently verified, report `unsupported` or `incomplete`. Offer a detached KiCad handoff as a downstream workflow, but do not call that edited artifact synchronized with PCBoo evidence.

## Verification

Lock the approved layer count and ordered roles in ordinary project tests. Inspect fresh Circuit JSON and manufacturing bytes for exact copper-layer order, required non-empty layers, intended plane or pour records, keepout intersections, and via transitions. Verify plane continuity or return paths with a capability qualified for that claim; Gerber syntax and copper presence alone are insufficient.
