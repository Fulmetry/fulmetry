# Circuit composition

Prefer a shallow composition tree with one board root:

```text
circuit/
  board.ts
  constraints.ts
  components/
  interfaces/
  power/
```

Use ordinary TypeScript functions to add cohesive blocks to a `Board`. Keep values, names, footprints, and intentional coordinates visible near the component declaration unless a shared, typed contract improves clarity.

For a large circuit, make the schematic readable as authored evidence: group power, controller, sensing, and output functions; assign intentional schematic coordinates or bounded functional sheets when automatic placement produces collisions; and keep net and pin labels legible at a normal fit-to-view scale. Browser label toggles are inspection aids, not a substitute for a non-overlapping authored schematic.

Import supported primitives from `fulmetry`. Direct supported `tscircuit` imports are equivalent, but Fulmetry-named imports make project intent clearer.

Preserve these invariants:

- exactly one composed board;
- stable unique names for components, traces, nets, and constraints;
- named nets for important rails and interfaces;
- explicit units for electrical and physical quantities where the API accepts them;
- small files that an agent can inspect without loading the whole design;
- tests that assert topology rather than incidental generated identifiers.

Do not hide required inputs in runtime clocks, randomness, environment variables, dynamic imports, remote fetches, or generated-output edits. Verified source must remain deterministic.
