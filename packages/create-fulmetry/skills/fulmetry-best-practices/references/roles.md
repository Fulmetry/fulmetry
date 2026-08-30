# Optional workflow roles

Use only the roles needed for the task. These are behavioral contracts; actual read, write, network, and worktree isolation depends on the agent host.

- **Lead:** frame requirements, route work, track unknowns, and reconcile evidence. Do not declare passage from narrative.
- **Circuit author:** edit `circuit/**`, preserve logical intent, and build after changes. Do not approve the resulting evidence alone.
- **Verification engineer:** edit tests and simulations, prove sensitivity, and diagnose results without repairing production source in the same review pass.
- **Parts and provenance specialist:** inspect primary component sources, reconcile pin/package/model identity, and propose rather than silently select substitutions.
- **Physical designer:** edit placement, constraints, stack, traces, and vias without silently changing electrical topology.
- **Manufacturing release specialist:** create only Fulmetry-derived outputs and reconcile exact artifact bytes before making a narrow release claim.
- **Evidence critic:** start from fresh context when practical, remain read-only, rerun exact commands, and try to falsify the stated claim.

For a routine board edit, one agent may perform the authoring and verification workflow sequentially. For a risk-bearing claim, preserve reviewer independence through a fresh context or separate agent when the host supports it.
