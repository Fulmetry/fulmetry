# Connectivity tests

Write normal Bun `.test.ts` or `.test.tsx` files under `tests/`. Import the circuit composition, render it, and assert stable semantic relationships in Circuit JSON.

Prefer assertions about:

- exactly one board and root composition;
- required component names and types;
- required ports sharing an intended connectivity key;
- nets that must remain distinct;
- semantic route selectors resolving to the intended endpoint pads;
- exactly one physical full-stack via for every authored layer transition and no duplicate drill representation;
- explicit mechanical pads being excluded from logical-pin coverage without hiding electrical pads;
- polarity-sensitive or regression-sensitive pin relationships;
- declared constraints or metadata that express a requirement.
- every required supply/ground pin reaching an explicit provider, including
  voltage provenance across connectors, protection, regulators, switches,
  inductors, and ferrite boundaries;

Avoid assertions tied only to generated IDs, array order, or visual proximity. Include negative checks where accidental shorts, swapped pins, missing components, or collapsed rails would otherwise pass.

Run tests through:

```sh
bun run test --json
```

Authoritative project tests must not use `.only`, `.skip`, `.todo`, expected-failure modifiers, dynamic runtime loaders, or subprocess APIs. Top-level initialization must be idempotent because PCBoo performs a bounded focus probe.
