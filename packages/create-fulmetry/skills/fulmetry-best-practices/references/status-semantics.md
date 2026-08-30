# Status semantics

Fulmetry preserves five independent dimensions:

- `fabrication`: geometry, physical rules, and independently reconciled manufacturing artifacts.
- `electrical`: connectivity and electrical-rule evidence.
- `functional`: Bun tests and qualified named simulations.
- `standards`: checks against an identified local profile; never certification or legal compliance.
- `sourcing`: recorded selection and provider evidence, with different state names from assurance dimensions.

Assurance states are `not-run`, `passed`, `passed-with-waivers`, `failed`, `incomplete`, and `unavailable`. Sourcing states are `available`, `constrained`, `unavailable`, `stale`, and `unchecked`.

Interpret them literally:

- `failed` means evidence found a defect.
- `incomplete` means the requested proof is not complete.
- `unavailable` means a required capability or trusted external tool was unavailable.
- `passed-with-waivers` is not equivalent to an unqualified pass.
- `unchecked` sourcing says nothing about present stock or suitability.

Also inspect `exitClassification`, `requestedDimensions`, diagnostics, artifact references, and project/source digests. A successful `build` has no requested assurance dimension and therefore does not make the board ready.
