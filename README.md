# PCBoo

**Build circuits with your coding agent.**

[![npm — @pcboo/pcboo](https://img.shields.io/npm/v/@pcboo/pcboo?label=%40pcboo%2Fpcboo)](https://www.npmjs.com/package/@pcboo/pcboo)
[![npm — create-pcboo](https://img.shields.io/npm/v/create-pcboo?label=create-pcboo)](https://www.npmjs.com/package/create-pcboo)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)](#requirements)

PCBoo is an experimental, Bun-first framework for authoring one circuit board as a set of composable TypeScript files. **The repository is the interface:** an agent or a human edits ordinary source, runs a small set of deterministic commands, reads concise diagnostics or versioned JSON, and opens a local inspection server in the browser.

It is designed for coding agents. Codex, Claude Code, Cursor, or any filesystem-capable agent can compose a board, run the commands, read the results, and repair its own work — no proprietary chat surface or visual editor required. Humans stay in the loop through the inspection workspace and can hand off to KiCad when manual CAD adjustment is the right tool.

> PCBoo is an independent open-source project built on [tscircuit](https://github.com/tscircuit/tscircuit). It reuses the supported tscircuit implementation directly for authoring and compilation. It is **not** an official tscircuit product and does not imply endorsement by or affiliation with tscircuit Inc.

---

## Requirements

The initial release authority is deliberately narrow. Anything outside this matrix is unsupported.

| Requirement | Supported value |
| --- | --- |
| Operating system | macOS |
| Architecture | Apple Silicon (`arm64`) |
| Runtime | Bun `1.3.14` exactly |
| Circuit engine | the tscircuit version pinned by PCBoo |

Unsupported Bun versions fail closed with `PCBOO_RUNTIME_UNSUPPORTED_BUN_001` **before** any project evaluation, external-tool execution, generated-output publication, or authoritative readiness evidence.

## Quick start

Create a new project and build it:

```sh
bun create pcboo my-board
cd my-board
bun run build
```

`bun create pcboo` runs the published [`create-pcboo`](https://www.npmjs.com/package/create-pcboo) package, which scaffolds a normal single-package repository (and installs its dependencies for you):

- a multi-file circuit under `circuit/`;
- `pcboo.config.ts` — resolved project configuration;
- deterministic `pcboo.lock` authority;
- Bun tests;
- a coding-agent guide (`AGENTS.md`);
- version-matched, project-local **Agent Skills** (see below);
- scripts for build, check, inspection, simulation, and export.

The scaffold refuses to overwrite any existing path. Pass `--no-skills` to omit the skills. The framework itself is published as [`@pcboo/pcboo`](https://www.npmjs.com/package/@pcboo/pcboo) and is added to generated projects for you.

## Agent Skills

PCBoo ships a catalog of [Agent Skills](https://www.anthropic.com/news/skills) that teach a coding agent the correct PCBoo procedures — how to design a complete board, diagnose a failing check, verify a claim, and produce manufacturing evidence without weakening a gate or skipping a human approval. Generated projects include a version-matched copy under `.agents/skills/` and `.claude/skills/`.

| Skill | Purpose |
| --- | --- |
| `pcboo-best-practices` | Router skill — orient in a project and route work to the right procedure. |
| `pcboo-design` | Create or edit complete circuits: architecture, footprints, stack-up, placement, routing. |
| `pcboo-schematic-layout` | Make schematics readable with authored logical coordinates and collision checks. |
| `pcboo-resolve-models` | Resolve, vendor, license-check, and bind realistic component 3D models. |
| `pcboo-diagnose` | Repair one build, electrical, fabrication, test, simulation, KiCad, or manufacturing finding. |
| `pcboo-verify` | Prove requirements with tests, Circuit JSON checks, qualified simulations, and evidence review. |
| `pcboo-manufacturing` | Generate and independently verify Gerber/drill/BOM/placement artifacts and KiCad handoffs. |

Add the public catalog to an existing project separately:

```sh
bunx --bun skills@latest add pcboo-dev/pcboo --copy
# Node equivalent:
npx skills@latest add pcboo-dev/pcboo --copy
```

Use **copy mode** — PCBoo intentionally rejects symlinks inside authoritative project input.

## Commands

Run inside a project containing `pcboo.config.ts` and `pcboo.lock`. Every finite command accepts `--json` for machine-readable output and `--offline` to assert the local network policy.

```sh
bun run pcboo help
bun run pcboo build --json          # compile twice, emit normalized Circuit JSON
bun run pcboo check --json          # electrical + baseline fabrication evidence
bun run pcboo test --json           # discover and run *.test.ts / *.test.tsx
bun run pcboo simulate --json       # named ngspice testbenches
bun run pcboo inspect --status fabrication --json
bun run pcboo dev --port 0 --json   # local React inspection workspace
bun run pcboo export kicad --json           # detached, validated KiCad handoff
bun run pcboo export gerbers --offline --json  # non-overwriting draft artifacts
bun run pcboo verify manufacturing --json      # independently reconciled artifact evidence
```

Autorouting via [Freerouting](https://github.com/freerouting/freerouting) (bring your own JAR, pinned by digest):

```sh
bun run pcboo route freerouting --jar /absolute/path/freerouting.jar --jar-sha256 <sha256> --json
bun run pcboo route promote .pcboo/runs/<run-id>/candidate.ses \
  --output circuit/routes --via-hole-mm 0.30 --via-outer-mm 0.60 --json
```

Every finite command creates a fresh `.pcboo/runs/<run-id>/` directory and writes its complete `report.json` there.

## The inspection workspace

`bun run pcboo dev` binds to `127.0.0.1` and serves a responsive, Bun-built React workspace. It watches project source, configuration, and lock data; publishes successful rebuilds atomically; and retains the last good circuit while marking its evidence stale when a rebuild fails.

The workspace includes a project overview, tscircuit-backed schematic and PCB SVG views, layer filtering, selection, visual measurement, a locally rendered **3D assembly**, independent check and simulation evidence, manufacturing outputs, and a searchable Circuit JSON explorer.

- Loopback-only, same-origin, per-process-token actions can run `build`, `check`, and named `simulate`. They may write derived `.pcboo` outputs but never edit authored circuit source or configuration.
- The 3D assembly is an approximation from available board, pad, trace, hole, and component geometry. It downloads no remote models and is **not** mechanical or manufacturing authority.
- A non-loopback `--host` is explicit, prints a visible exposure warning, and disables browser-triggered actions.
- Bounded `/api/inspect` geometry and connectivity results remain the authoritative automation interface.

---

## Statuses are deliberately separate

Every result preserves independent **`fabrication`**, **`electrical`**, **`functional`**, **`standards`**, and **`sourcing`** statuses. Passing fabrication never implies a passing simulation, current stock, or standards evidence. Unavailable and incomplete work stays visible in compact text, JSON, browser data, and verified bundle manifests.

> "Checked against a profile" is evidence about implemented rules. It is **not** certification, legal compliance advice, or a guarantee that a board is safe to manufacture.

**Draft vs. verified.** `export gerbers` compiles twice and writes only a fresh, non-overwriting `manufacturing-draft/` directory plus a per-file input snapshot and manifest. It always leaves fabrication `incomplete` and exits nonzero, directing callers to the separate verifier. `verify manufacturing` emits an unmistakably draft Gerber/drill/BOM/placement set, independently re-parses its exact captured bytes, and produces bounded pre-compliance evidence. Only the promotion path can construct a *verified* manifest, and verification of a published bundle requires the `manifestSha256` returned out of band by publication — a digest read from the bundle itself is not a trust authority.

**Waivers.** Scoped waivers live in source-controlled `waivers/*.json`. A declaration identifies one active waiver-eligible rule occurrence by its exact status dimension and object/region scope, includes a written justification, and optionally an expiry date. Capability, connectivity, ownership, identity, unsupported-construct, resource-limit, and artifact-integrity findings are **non-waivable**. Source-only `check` stays `incomplete` even after valid waivers; `passed-with-waivers` remains explicit in the fabrication status and report.

## Trust, privacy, and generated output

- **No telemetry.** PCBoo performs no telemetry or project-data upload by default. The implemented commands do not install external tools or contact supplier services. PCBoo never installs KiCad or ngspice for you.
- **Offline is honest.** Every durable result records whether the network policy was `default` or `offline`. This release has no PCBoo-managed network-backed resolver, so both policies do the same local work and preserve the same circuit identity. `--offline` is a policy assertion, not an OS sandbox — trusted circuit source can still initiate its own network access.
- **Trusted-but-bounded source.** Project evaluation runs trusted executable TypeScript. Finite evidence commands bind every regular project file outside `.git`, `node_modules`, and the configured output directory, and reject ambient runtime-I/O globals, clocks, randomness, and evaluator escape hatches in verified source (while keeping deterministic `Math` for geometry). Verified circuit modules may import only explicit named symbols from PCBoo's authoring facade (or the identical pinned tscircuit authoring set).
- **Not a malware sandbox.** PCBoo's repeat-build and whole-project input checks detect ordinary undeclared inputs and nondeterminism. They are not a sandbox for hostile source and do not replace operating-system isolation. Generated files and third-party models remain adversarial inputs at their parsing boundaries.
- **Your work stays yours.** Circuit source and ordinary generated manufacturing files remain your work; PCBoo's MIT license is not applied to them merely because PCBoo processed them.

## Current limitations

PCBoo is experimental. Manufacturing output must pass its explicit verification gates before any production use.

- **Manufacturing scope.** Verified manufacturing currently supports one rectangular two- or four-layer board, component-owned SMT, circular or straight routed-slot component-owned PTH, NPTH, full-stack through vias, and axis-aligned rectangular copper keepouts. Ownerless SMT pads and fiducials remain unsupported; unsupported or unreconciled geometry blocks verified promotion.
- **Simulation.** Named `simulations/<name>.testbench.ts` definitions, model-provenance checks, R/C/L netlist generation, bounded direct ngspice execution, and independent numeric assertions exist. ngspice majors 42–47 are *detection candidates* — each captured executable must pass PCBoo-owned analytical cases before a run may report functional `passed`. A host with no executable, unavailable process containment, or failed qualification reports `unavailable`/`incomplete`, never passed.
- **KiCad.** `export kicad` produces a deterministic, detached `.kicad_sch`/`.kicad_pcb`/`.kicad_pro` handoff and reconciles it against the baseline. KiCad 10 is the initial live-supported major (KiCad 9 is detection-only), invoked only for the official signed app at `/Applications/KiCad/KiCad.app` after identity and version checks. This is a handoff, not certification or an automatic round trip.
- **Sourcing & standards.** Supplier search and authenticated provider evidence are unimplemented. A self-authored selection record proves selection integrity only — never package compatibility or supplier availability. Standards profiles beyond the local fabrication baseline are unimplemented.
- **Maintainer tscircuit upgrade** (see below) is disabled on this macOS release; the accepted tscircuit version is fixed until a qualified native macOS descendant broker exists. This does not affect ordinary project authoring or inspection.
- Content-addressed verified manifests are explicitly **unsigned**.

<details>
<summary><strong>Advanced: the dormant maintainer tscircuit upgrade transaction</strong></summary>

PCBoo pins one exact tscircuit version. Advancing it is a maintainer-only, two-stage transaction (`upgrade:tscircuit review` → `accept:tscircuit accept`) that authenticates the complete declared package closure rooted at tscircuit — not a static-import approximation — across a repository profile and a physically separate clean packed-consumer, binds exact lock and package identities, and re-runs the curated two-/four-layer qualification.

It performs **no** install, resolution, or network fetch, and never intentionally mutates `node_modules`. Acceptance requires the exact canonical report, its reviewed SHA-256, digest-bound runtime evidence, and `--accept-reviewed-upgrade`; it requalifies twice and independently regenerates every canonical fixture.

**On the initial macOS release this path is disabled**, because Bun descendant tracking and process groups cannot authoritatively contain an external double-fork. The syntax is retained as a fail-closed future interface and refuses to launch candidate code until a kernel-owned descendant-cleanup broker is qualified. See the source under `src/upgrade/` and `scripts/*-tscircuit-upgrade.ts`.

</details>

---

## Documentation

- [Getting started](./docs/getting-started.mdx) — environment, scaffold, and first build.
- [Product requirements](./PRODUCT_REQUIREMENTS.md) — the target product.
- [Future explorations](./FUTURE_EXPLORATIONS.md) — deferred ideas.
- [Engineering Gauntlet](./GAUNTLET_PROMPT.md) — the adversarial verification standard PCBoo is built to survive.
- Full docs: [docs.page/pcboo-dev/pcboo](https://docs.page/pcboo-dev/pcboo)

## License and attribution

PCBoo is available under the [MIT License](./LICENSE). Direct distribution dependencies and their license evidence are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). tscircuit, incorporated dependencies, third-party data, models, footprints, and other assets retain their respective copyright and license terms.
