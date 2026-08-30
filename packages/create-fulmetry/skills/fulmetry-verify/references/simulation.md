# Simulation

Use a named `simulations/<name>.testbench.ts` only when functional behavior needs numerical evidence.

Define explicitly:

- the component and net region, including a ground reference;
- model identities, model-to-component pin maps, parameters, source, digest, license, and redistribution state;
- voltage or current stimuli;
- operating-point, DC sweep, AC, or transient analysis;
- requested vectors, sample selection, units, expected values, and absolute and relative tolerances;
- a bounded timeout.

Run:

```sh
bun run fulmetry simulate <name> --json
```

Fulmetry qualifies the captured ngspice executable before using it for a passing result. Missing tools, failed qualification, absent trusted models, incomplete regions, or unsupported containment remain `unavailable` or `incomplete`.

Simulation supports only the declared model and analysis surface. It is evidence for the stated assertions, not proof of every operating corner, parasitic effect, thermal condition, tolerance distribution, or manufactured-board behavior.
