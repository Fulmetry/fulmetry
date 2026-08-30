# Fulmetry

**Build circuits with your coding agent.**

[![npm — fulmetry](https://img.shields.io/npm/v/fulmetry?label=%40fulmetry%2Ffulmetry)](https://www.npmjs.com/package/fulmetry)
[![npm — create-fulmetry](https://img.shields.io/npm/v/create-fulmetry?label=create-fulmetry)](https://www.npmjs.com/package/create-fulmetry)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-lightgrey)](#requirements)

Fulmetry is an experimental, Bun-first framework for authoring one circuit board as a set of composable TypeScript files. **The repository is the interface:** an agent or a human edits ordinary source, runs a small set of deterministic commands, reads concise diagnostics or versioned JSON, and opens a local inspection server in the browser.

It is designed for coding agents. Codex, Claude Code, Cursor, or any filesystem-capable agent can compose a board, run the commands, read the results, and repair its own work — no proprietary chat surface or visual editor required. Humans stay in the loop through the inspection workspace and can hand off to KiCad when manual CAD adjustment is the right tool.

> Fulmetry is an independent open-source project built on [tscircuit](https://github.com/tscircuit/tscircuit). It reuses the supported tscircuit implementation directly for authoring and compilation. It is **not** an official tscircuit product and does not imply endorsement by or affiliation with tscircuit Inc.

---

## Requirements

The initial release authority is deliberately narrow. Anything outside this matrix is unsupported.

| Requirement | Supported value |
| --- | --- |
| Operating system | macOS |
| Architecture | Apple Silicon (`arm64`) |
| Runtime | Bun `1.3.14` exactly |
| Circuit engine | the tscircuit version pinned by Fulmetry |

Unsupported Bun versions fail closed with `FULMETRY_RUNTIME_UNSUPPORTED_BUN_001` **before** any project evaluation, external-tool execution, generated-output publication, or authoritative readiness evidence.

## Quick start

Create a new project and build it:

```sh
bun create fulmetry my-board
cd my-board
bun run build
```

`bun create fulmetry` runs the published [`create-fulmetry`](https://www.npmjs.com/package/create-fulmetry) package, which scaffolds a normal single-package repository (and installs its dependencies for you):

- a multi-file circuit under `circuit/`;
- `fulmetry.config.ts` — resolved project configuration;
- deterministic `fulmetry.lock` authority;
- Bun tests;
- a coding-agent guide (`AGENTS.md`);
- version-matched, project-local **Agent Skills** (see below);
- scripts for build, check, inspection, simulation, and export.

The scaffold refuses to overwrite any existing path. Pass `--no-skills` to omit the skills. The framework itself is published as [`fulmetry`](https://www.npmjs.com/package/fulmetry) and is added to generated projects for you.

## Agent Skills

Fulmetry ships a catalog of [Agent Skills](https://www.anthropic.com/news/skills) that teach a coding agent the correct Fulmetry procedures — how to design a complete board, diagnose a failing check, verify a claim, and produce manufacturing evidence without weakening a gate or skipping a human approval. Generated projects include a version-matched copy under `.agents/skills/` and `.claude/skills/`.

| Skill | Purpose |
| --- | --- |
| `fulmetry-best-practices` | Router skill — orient in a project and route work to the right procedure. |
| `fulmetry-design` | Create or edit complete circuits: architecture, footprints, stack-up, placement, routing. |
| `fulmetry-schematic-layout` | Make schematics readable with authored logical coordinates and collision checks. |
| `fulmetry-resolve-models` | Resolve, vendor, license-check, and bind realistic component 3D models. |
| `fulmetry-diagnose` | Repair one build, electrical, fabrication, test, simulation, KiCad, or manufacturing finding. |
| `fulmetry-verify` | Prove requirements with tests, Circuit JSON checks, qualified simulations, and evidence review. |
| `fulmetry-manufacturing` | Generate and independently verify Gerber/drill/BOM/placement artifacts and KiCad handoffs. |

Add the public catalog to an existing project separately:

```sh
bunx --bun skills@latest add Fulmetry/fulmetry --copy
# Node equivalent:
npx skills@latest add Fulmetry/fulmetry --copy
```

Use **copy mode** — Fulmetry intentionally rejects symlinks inside authoritative project input.

## Commands

Run inside a project containing `fulmetry.config.ts` and `fulmetry.lock`. Every finite command accepts `--json` for machine-readable output and `--offline` to assert the local network policy.

```sh
bun run fulmetry help
bun run fulmetry build --json          # compile twice, emit normalized Circuit JSON
bun run fulmetry check --json          # electrical + baseline fabrication evidence
bun run fulmetry test --json           # discover and run *.test.ts / *.test.tsx
bun run fulmetry simulate --json       # named ngspice testbenches
bun run fulmetry inspect --status fabrication --json
bun run fulmetry dev --port 0 --json   # local React inspection workspace
bun run fulmetry export kicad --json           # detached, validated KiCad handoff
bun run fulmetry export gerbers --offline --json  # non-overwriting draft artifacts
bun run fulmetry verify manufacturing --json      # independently reconciled artifact evidence
bun run test                                      # repository qualification suite
```

Autorouting via [Freerouting](https://github.com/freerouting/freerouting) (bring your own JAR, pinned by digest):

```sh
bun run fulmetry route freerouting --jar /absolute/path/freerouting.jar --jar-sha256 <sha256> --json
bun run fulmetry route promote .fulmetry/runs/<run-id>/candidate.ses \
  --output circuit/routes --via-hole-mm 0.30 --via-outer-mm 0.60 --json
```

Every finite command creates a fresh `.fulmetry/runs/<run-id>/` directory and writes its complete `report.json` there.

## The inspection workspace

`bun run fulmetry dev` binds to `127.0.0.1` and serves a responsive, Bun-built React workspace. It watches project source, configuration, and lock data; publishes successful rebuilds atomically; and retains the last good circuit while marking its evidence stale when a rebuild fails.

The workspace includes a project overview, tscircuit-backed schematic and PCB SVG views, layer filtering, selection, visual measurement, a locally rendered **3D assembly**, independent check and simulation evidence, manufacturing outputs, and a searchable Circuit JSON explorer.

- Loopback-only, same-origin, per-process-token actions can run `build`, `check`, and named `simulate`. They may write derived `.fulmetry` outputs but never edit authored circuit source or configuration.
- The 3D assembly is an approximation from available board, pad, trace, hole, and component geometry. It downloads no remote models and is **not** mechanical or manufacturing authority.
- A non-loopback `--host` is explicit, prints a visible exposure warning, and disables browser-triggered actions.
- Bounded `/api/inspect` geometry and connectivity results remain the authoritative automation interface.

---

## Statuses are deliberately separate

Every result preserves independent **`fabrication`**, **`electrical`**, **`functional`**, **`standards`**, and **`sourcing`** statuses. Passing fabrication never implies a passing simulation, current stock, or standards evidence. Unavailable and incomplete work stays visible in compact text, JSON, browser data, and verified bundle manifests.

> "Checked against a profile" is evidence about implemented rules. It is **not** certification, legal compliance advice, or a guarantee that a board is safe to manufacture.

**Draft vs. verified.** `export gerbers` compiles twice and writes only a fresh, non-overwriting `manufacturing-draft/` directory plus a per-file input snapshot and manifest. It always leaves fabrication `incomplete` and exits nonzero, directing callers to the separate verifier. `verify manufacturing` emits an unmistakably draft Gerber/drill/BOM/placement set, independently re-parses its exact captured bytes, and produces bounded pre-compliance evidence. Only the promotion path can construct a *verified* manifest, and verification of a published bundle requires the `manifestSha256` returned out of band by publication — a digest read from the bundle itself is not a trust authority.

**Waivers.** Scoped waivers live in source-controlled `waivers/*.json` files. A declaration identifies one active waiver-eligible rule occurrence by its exact status dimension and object/region scope, includes a written justification, and optionally an expiry date. Capability, connectivity, ownership, identity, unsupported-construct, resource-limit, and artifact-integrity findings remain non-waivable. Source-only `check` remains `incomplete` even after valid waivers; `passed-with-waivers` remains explicit in the fabrication status and report. `warning-only` is available only after the emitted manufacturing files pass independent verification.

## Trust, privacy, and generated output

- **No telemetry.** Fulmetry performs no telemetry or project-data upload by default. The implemented commands do not install external tools or contact supplier services. Fulmetry never installs KiCad or ngspice for you.
- **Offline is honest.** Every durable result records whether the network policy was `default` or `offline`. This release has no Fulmetry-managed network-backed resolver, so both policies do the same local work and preserve the same circuit identity. `--offline` is a policy assertion, not an OS sandbox — trusted circuit source can still initiate its own network access.
- **Trusted-but-bounded source.** Project evaluation runs trusted executable TypeScript. Finite evidence commands bind every regular project file outside `.git`, `node_modules`, and the configured output directory, and reject ambient runtime-I/O globals, clocks, randomness, and evaluator escape hatches in verified source (while keeping deterministic `Math` for geometry). Verified circuit modules may import only explicit named symbols from Fulmetry's authoring facade (or the identical pinned tscircuit authoring set).
- **Contained child processes:** authoritative project tests may not import or reference subprocess APIs. For launched external tools, operational cleanup uses macOS Seatbelt to deny direct child creation and parent signaling, but does not claim to sandbox a malicious executable. If the required OS cleanup mechanism is unavailable, Fulmetry reports process containment unavailable without launching the selected executable.
- **Observed privacy evidence.** The release qualification, on the declared Apple Silicon macOS platform, preloads a sensitivity-checked runtime egress observer, and a nested-Bun canary proves the observer is injected into Fulmetry's fresh configuration/evaluation processes. The named `node:net`, DNS, fetch, and UDP canaries independently prove those client surfaces are instrumented. The observed workflow compiles through the real pinned tscircuit authoring graph, proves multiple fresh child processes joined observation, and requires zero socket, DNS, HTTP, WebSocket, or UDP client attempts. This is evidence about the exercised Fulmetry workflow, not malicious trusted project code or native code issuing raw system calls outside the runtime APIs.
- **Not a malware sandbox.** Fulmetry's repeat-build and whole-project input checks detect ordinary undeclared inputs and nondeterminism. They are not a sandbox for hostile source and do not replace operating-system isolation. Generated files and third-party models remain adversarial inputs at their parsing boundaries.
- **Your work stays yours.** Circuit source and ordinary generated manufacturing files remain your work; Fulmetry's MIT license is not applied to them merely because Fulmetry processed them.

## Current limitations

Fulmetry is experimental. Manufacturing output must pass its explicit verification gates before any production use.

- **Manufacturing scope.** Verified manufacturing currently supports one rectangular two- or four-layer board, component-owned SMT, circular or straight routed-slot component-owned PTH, NPTH, full-stack through vias, and axis-aligned rectangular copper keepouts. Ownerless SMT pads and fiducials remain unsupported; unsupported or unreconciled geometry blocks verified promotion.
- **Simulation.** Named `simulations/<name>.testbench.ts` definitions, model-provenance checks, R/C/L netlist generation, bounded direct ngspice execution, and independent numeric assertions exist. ngspice majors 42–47 are *detection candidates* — each captured executable must pass Fulmetry-owned analytical cases before a run may report functional `passed`. A host with no executable, unavailable process containment, or failed qualification reports `unavailable`/`incomplete`, never passed.
- **KiCad.** `export kicad` produces a deterministic, detached `.kicad_sch`/`.kicad_pcb`/`.kicad_pro` handoff and reconciles it against the baseline. KiCad 10 is the initial live-supported major (KiCad 9 is detection-only), invoked only for the official signed app at `/Applications/KiCad/KiCad.app` after identity and version checks. This is a handoff, not certification or an automatic round trip.
- **Sourcing & standards.** Supplier search and authenticated provider evidence are unimplemented. A self-authored selection record proves selection integrity only — never package compatibility or supplier availability. Standards profiles beyond the local fabrication baseline are unimplemented.
- **Maintainer tscircuit upgrade** (see below) is disabled on this macOS release; the accepted tscircuit version is fixed until a qualified native macOS descendant broker exists. This does not affect ordinary project authoring or inspection.
- Content-addressed verified manifests are explicitly **unsigned**.

<details>
<summary><strong>Advanced: the dormant maintainer tscircuit upgrade transaction</strong></summary>

Fulmetry pins one exact tscircuit version. Advancing it is a maintainer-only, two-stage transaction (`upgrade:tscircuit review` → `accept:tscircuit accept`) that authenticates the complete declared package closure rooted at tscircuit — not a static-import approximation — across a repository profile and a physically separate clean packed-consumer, binds exact lock and package identities, and re-runs the curated two-/four-layer qualification.

It performs **no** install, resolution, or network fetch, and never intentionally mutates `node_modules`. Acceptance requires the exact canonical report, its reviewed SHA-256, digest-bound runtime evidence, and `--accept-reviewed-upgrade`; it requalifies twice and independently regenerates every canonical fixture.

**On the initial macOS release this path is disabled**, because Bun descendant tracking and process groups cannot authoritatively contain an external double-fork. The syntax is retained as a fail-closed future interface and refuses to launch candidate code until a kernel-owned descendant-cleanup broker is qualified. See the source under `src/upgrade/` and `scripts/*-tscircuit-upgrade.ts`.

</details>

---

## Documentation

- [Getting started](./docs/getting-started.mdx) — environment, scaffold, and first build.
- [Product requirements](./PRODUCT_REQUIREMENTS.md) — the target product.
- [Future explorations](./FUTURE_EXPLORATIONS.md) — deferred ideas.
- [Engineering Gauntlet](./GAUNTLET_PROMPT.md) — the adversarial verification standard Fulmetry is built to survive.
- Full docs: [docs.page/Fulmetry/fulmetry](https://docs.page/Fulmetry/fulmetry)

## License and attribution

Fulmetry is available under the [MIT License](./LICENSE). Direct distribution dependencies and their license evidence are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). tscircuit, incorporated dependencies, third-party data, models, footprints, and other assets retain their respective copyright and license terms.
