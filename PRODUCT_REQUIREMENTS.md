# PCBoo Product Requirements

**Document type:** Product requirements and quality contract

**Product:** PCBoo

**Status:** Initial product definition

## 1. Product summary

PCBoo is an MIT-licensed, open-source, agent-native framework for designing electronic circuits as code. It allows people to use their existing coding agents—such as Codex, Claude Code, Pi, or another tool-capable agent—to create, inspect, simulate, validate, and export circuit projects from a normal source-code repository.

PCBoo is not an AI model and does not require a PCB editor of its own. It supplies the deterministic circuit tools, project conventions, structured diagnostics, and manufacturing checks that a general coding agent needs to work as a circuit-design agent. TypeScript is the primary authoring language. A project is expected to use multiple composable files rather than one generated monolith.

PCBoo is built on tscircuit. Tscircuit supplies the circuit component model, TSX rendering pipeline, Circuit JSON generation, schematic and PCB representations, layout and routing capabilities, viewers, component machinery, and existing exporters. PCBoo consumes those capabilities through supported packages and narrow compatibility adapters rather than reimplementing or copying the tscircuit engine.

KiCad, ngspice, Gerber, drill, bill-of-materials, and assembly outputs are treated as interoperable tools and formats rather than as the product's source of truth.

The core promise is:

> A coding agent can build a circuit, receive exact machine-readable feedback, repair its work, and produce independently checked engineering artifacts without requiring a custom visual editor.

### 1.1 Relationship to tscircuit

PCBoo relates to tscircuit in approximately the way Next.js relates to React: tscircuit is the foundational circuit engine and component system, while PCBoo is an opinionated application framework around it.

```text
PCBoo project files
        ↓
PCBoo conventions, commands, tests, and adapters
        ↓
tscircuit compiler and circuit infrastructure
        ↓
Circuit JSON, schematic, PCB, layout, routing, and renders
        ↓
PCBoo verification, simulation, interoperability, and qualified exports
```

PCBoo must use upstream tscircuit packages wherever their contracts meet the product requirements. Compatibility logic belongs in a narrow tscircuit adapter. Temporary patches may be pinned or maintained in a narrowly scoped fork only when necessary, with fixes contributed upstream where practical. PCBoo must not create an incompatible circuit language merely to differentiate itself.

PCBoo exposes a curated, documented authoring surface from the `pcboo` package. Re-exported circuit components and types are the exact supported tscircuit implementations, not PCBoo wrappers or subclasses. A project may safely mix components imported from `pcboo` with components imported directly from supported tscircuit packages. PCBoo examples prefer `pcboo` imports; direct tscircuit imports remain the escape hatch for advanced or experimental upstream APIs and do not receive PCBoo's long-term compatibility guarantee.

Tscircuit already provides substantial overlapping functionality, including a CLI, development environment, viewers, registry, autorouting work, part integrations, and manufacturing exporters. PCBoo's value is therefore not a renamed tscircuit experience. PCBoo adds, hardens, or standardizes the following framework-level capabilities:

1. **Project scaffolding:** `bun create pcboo` creates a complete, conventional circuit application with configuration, Bun scripts, Bun tests, examples, and generated-output boundaries.
2. **Multi-file application conventions:** large circuits are organized into small TypeScript/TSX modules with predictable locations for board composition, constraints, models, tests, and integrations.
3. **Stable framework commands:** `pcboo dev`, `build`, `inspect`, `check`, `test`, `simulate`, and `export` form a consistent contract across projects and hide compatible dependency-level differences.
4. **Filesystem-first agent operation:** existing coding agents work through ordinary source files, shell commands, compact diagnostics, selectively requested JSON, images, and reports without requiring a PCBoo-specific agent runtime or chat interface.
5. **Machine-readable diagnostics:** electrical, spatial, routing, simulation, and export failures use stable identifiers, exact measurements, affected objects, layers, evidence, and source locations.
6. **Circuit testing as a first-class convention:** project-owned tests express connectivity, electrical behavior, layout intent, simulation assertions, and manufacturing expectations alongside source code.
7. **Independent manufacturing verification:** PCBoo does not trust exporter success alone; it reparses and reconciles emitted Gerber, drill, BOM, and placement artifacts against the authored circuit and configured layer stack.
8. **Multilayer regression coverage:** ordinary two- and four-layer boards with SMT, PTH, and through vias form the conservative mandatory baseline. Additional stack-ups and via technologies are enabled only when all relevant adapters declare and prove the required capabilities.
9. **Safe unsupported-feature handling:** lossy, unavailable, ambiguous, or unsupported constructs fail clearly in strict workflows instead of being silently dropped or presented as complete.
10. **Simulation orchestration:** named simulations, model provenance, ngspice execution, structured results, numeric assertions, timeouts, and convergence failures use the same project and test conventions.
11. **Qualified KiCad handoff:** KiCad export provides a documented escape hatch for specialist review and manual adjustment, with explicit mapping, lossiness, and overwrite protection.
12. **Exact spatial inspection:** agents can query objects, nets, distances, constraints, layers, lengths, via counts, and connectivity paths instead of reasoning from TSX coordinates or screenshots alone.
13. **Reproducible artifacts:** outputs record source state, configuration digest, dependency and adapter versions, model provenance, validation status, and content hashes.
14. **Per-project development server:** `pcboo dev` watches the project and serves a fixed, framework-owned inspection interface for schematics, PCB layers, simulations, diagnostics, and manufacturing reports. It is not a general web application router and does not edit the circuit.
15. **Replaceable integrations:** tscircuit, ngspice, KiCad, supplier search, Gerber validation, and manufacturer profiles are adapters behind shared PCBoo contracts rather than hard-coded alternate implementations. The public adapter contract remains experimental until several integrations prove it.
16. **Security and trust boundaries:** project source is trusted executable TypeScript, while subprocess invocation, model includes, generated paths, browser exposure, secrets, and third-party data receive explicit containment and adversarial testing.
17. **Honest readiness language:** PCBoo reports fabrication, electrical, functional, standards-evidence, and sourcing statuses separately and never turns automated evidence into a claim of certification.
18. **Cross-agent evaluations:** success is measured from resulting repository state and deterministic engineering checks rather than an agent's narrative claim that a task is complete.

These improvements are product requirements for the PCBoo layer. They are not claims that every underlying feature is absent from tscircuit; PCBoo may satisfy a requirement by configuring, composing, testing, or hardening an existing tscircuit capability.

## 2. Product principles

### 2.1 Agent-first, agent-independent

PCBoo exposes its capabilities through project files, a CLI, generated artifacts, and a per-project HTTP development server. No feature may require a particular model vendor or agent application. A human must be able to run every deterministic operation without an agent.

### 2.2 Code owns design intent

The authored TypeScript project is the primary design definition. Generated Circuit JSON, KiCad projects, simulation files, renders, reports, and manufacturing archives are derived artifacts. Generated output must not become an undocumented second source of truth.

### 2.3 Structured feedback precedes visual intuition

Agents receive exact coordinates, net relationships, measurements, rule identifiers, affected objects, and suggested investigation targets. Images and layer renders are supporting evidence. Neither agent vision nor human visual inspection is accepted as proof of electrical or manufacturing correctness.

### 2.4 Deterministic tools decide pass or fail

Electrical rules, geometric rules, simulations, connectivity checks, export validators, and policy gates determine outcomes. An LLM may explain or repair a failure but may not override a failed check by declaring the design safe.

### 2.5 Safe failure over plausible output

PCBoo must return an actionable non-passing status when it cannot establish correctness, and strict or verified operations must stop. Missing layers, unsupported constructs, ambiguous pin mappings, unavailable models, stale outputs, NaN coordinates, or incomplete routing may never be silently ignored. Draft artifacts may still be emitted for diagnosis only when they are unmistakably marked as unverified.

### 2.6 Interoperability is an escape hatch

Users can export to KiCad for specialist review, unsupported operations, or fine manual adjustment. This is a detached downstream handoff. PCBoo must describe mapping and lossiness clearly, but it does not synchronize later KiCad edits back to TypeScript or claim an automatic round trip.

### 2.7 Reproducibility is part of correctness

The same source, configuration, dependency lockfile, and tool versions must produce semantically equivalent results. Every report and manufacturing package records the versions and inputs used to create it.

PCBoo projects are executable Bun programs, not sandboxed documents. Development commands run only trusted project source. A verified build sanitizes undeclared environment input, disables PCBoo-managed network access, evaluates the design in two fresh processes, and compares normalized circuit and artifact digests. This detects ordinary nondeterminism but is not a security boundary against malicious source.

### 2.8 Readiness is composable

PCBoo reports independent statuses for fabrication validity, electrical checks, functional validation, standards or pre-compliance evidence, and sourcing availability. It must not collapse those dimensions into one ambiguous readiness badge. Passing fabrication checks does not prove that a circuit functions, and passing a standards profile is not certification.

### 2.9 Credit and licensing are product behavior

PCBoo is distributed under the MIT License. Its README and architecture documentation credit tscircuit prominently without implying endorsement or official affiliation. Required copyright and license notices are preserved in source and distributions. Bundled code and vendored assets include a generated `THIRD_PARTY_NOTICES.md` and machine-readable license provenance. User-authored circuit projects and ordinary generated manufacturing outputs are not required to adopt PCBoo's license merely because PCBoo produced them.

### 2.10 Privacy is local by default

PCBoo collects no telemetry by default. A future diagnostics program may exist only as an explicit opt-in and may not collect circuit source, layouts, component choices, manufacturing artifacts, credentials, or proprietary model data.

## 3. Intended users

- Software developers building electronics with an existing coding agent.
- Electrical engineers who want reusable, reviewable circuit modules.
- Open-source hardware maintainers who need reproducible design and manufacturing outputs.
- Small product teams that want automated checks before specialist review or fabrication.
- Agent and EDA researchers who need a deterministic environment for evaluating circuit-design agents.

PCBoo must remain useful to an experienced engineer while making failures understandable to a developer with limited EDA experience. It must not imply that tool usage removes the need for qualified engineering review in safety-critical, high-voltage, RF, high-speed, medical, automotive, aerospace, or regulated designs.

## 4. Product boundaries

PCBoo includes:

- A Bun-required TypeScript project runtime and project conventions on Apple Silicon macOS. Linux, Windows, and Intel macOS are future explorations rather than initial release targets.
- Composable circuit modules and explicit physical constraints.
- Adapters for tscircuit and Circuit JSON.
- A local HTTP server for results and artifacts.
- Electrical, spatial, connectivity, simulation, and export checks.
- Structured circuit inspection and rendered views.
- ngspice execution through a separately installed executable.
- KiCad project export and validation adapters.
- Gerber, drill, BOM, and pick-and-place verification.
- Versioned reports with evidence and provenance.

PCBoo does not include:

- A foundation model or proprietary agent runtime.
- A required MCP server or agent-specific protocol.
- A full interactive schematic or PCB editor.
- A promise that arbitrary generated hardware is safe or functional.
- Regulatory certification or approval by a standards body.
- Fabrication ordering or purchasing without separate, explicit user action.
- Automatic redistribution rights for third-party symbols, footprints, 3D models, datasheets, or SPICE models.
- Guaranteed lossless round-trip editing between TypeScript and every external EDA format.
- Guaranteed Node.js runtime compatibility. Compatibility that happens to work is incidental unless declared by a later product contract.
- Automatic installation of KiCad, ngspice, or other external executables.
- A security sandbox for untrusted TypeScript projects.

Deferred explorations are recorded separately in `FUTURE_EXPLORATIONS.md`. They are not release commitments or implicit current requirements.

## 5. Project model

### 5.1 Repository structure

A PCBoo project supports many small, composable files. A representative project is:

```text
project/
  pcboo.config.ts
  pcboo.lock
  circuit/
    board.tsx
    constraints.ts
    power/
      usb-c-input.tsx
      regulator.tsx
    controller/
      mcu.tsx
    interfaces/
      sensors.tsx
  models/
    manifest.json
  vendor/                 # optional, intentionally committed assets
  tests/
    connectivity.test.ts
    power.test.ts
    manufacturing.test.ts
  .pcboo/
```

The layout is conventional rather than mandatory. A project has exactly one board and one deterministic assembly definition. Configuration identifies the entry circuit, output directory, selected rule profiles, simulation models, export adapters, and manufacturing target. Multi-board products, named assembly variants, and product-level Bun workspace composition are deferred subjects rather than implicit behavior in the initial project model.

`pcboo.config.ts` is typed TypeScript whose resolved value must be serializable and deterministic. It defines project behavior, not hidden circuit state. Circuit source owns components, values, connectivity, stack-up, placement, routing, geometry, and other design intent. Named profiles own external manufacturer, simulation, or standards requirements. `pcboo.lock` is generated and records exact dependency, profile, and asset resolutions; it never invents design intent. Environment variables are limited to credentials and local tool locations and may not change connectivity, geometry, parts, or manufacturing output in a verified build.

Source, configuration, tests, `pcboo.lock`, waivers, and intentionally vendored assets are expected to be committed. `.pcboo/` caches and routine generated output are ignored. A configured output root is exclusively PCBoo-owned and cannot contain authored project inputs; PCBoo rejects an existing mixed-ownership root before excluding it from discovery or authority hashing. The conventional `.pcboo/` namespaces are reserved by specification, while a fresh custom output root receives an exact nonce-bearing PCBoo ownership marker whose canonical counterpart remains outside that excluded root and inside project authority hashing. Later use is rejected if either counterpart, their bounded namespaces, or their exact binding is missing, invalid, or replaced. A release bundle is exported deliberately to a user-selected location for archival or commit.

### 5.2 Circuit modules

A circuit module can define:

- Logical ports and nets.
- Component values and explicitly selected manufacturer or supplier identities.
- Schematic representation.
- Footprints and pin mappings.
- A local physical coordinate system.
- Relative placement and routing constraints.
- Required electrical and simulation tests.
- Manufacturing and assembly metadata.

Instances may override documented parameters without modifying the module. An instance override must remain visible in source and in the generated provenance report.

Manufactured components require explicit stable names such as `R12`, `U3`, or `J1` before a verified production bundle can be created. Deterministic temporary names are permitted during development with prominent warnings. Generated components, pads, traces, nets, and other entities retain a hierarchical instance path and the nearest honest source provenance. Synthetic entities are labeled as generated when no exact authored source location exists.

### 5.3 Physical constraints

PCBoo favors relational intent over unexplained absolute coordinates. Supported constraint concepts include proximity, alignment, orientation, board-edge attachment, same-side placement, keep-out regions, local grouping, trace class, via class, maximum route length, matched length, and differential-pair relationships.

Absolute position and rotation remain available for explicit mechanical requirements and fine adjustment. Every resolved object exposes both its authored constraints and generated coordinates.

### 5.4 Generated artifacts

Generated files are written only beneath `.pcboo/` or another explicitly configured output directory. Cached immutable dependencies and assets live beneath `.pcboo/cache/`. `pcboo vendor` may copy redistributable locked assets into a committed `vendor/` directory while preserving their licenses and provenance. Network access may refresh advisory metadata or retrieve a missing asset only when the asset is pinned by immutable version or content digest. `--offline` blocks all PCBoo-managed network access. No network response may alter the circuit digest without a source or lockfile change.

An artifact manifest records:

- Artifact type and relative path.
- Content digest.
- Source revision or dirty-tree state.
- Configuration digest.
- Tool and adapter versions.
- Informational generation timestamp, excluded from normalized semantic and artifact-input digests.
- Validation status.
- Known lossiness or unsupported features.
- Source and lockfile digests.
- External executable versions and capability declarations.
- Active profiles, waivers, and verification results.
- Explicit board revision.

Stale artifacts must be detectable and must not be presented as current.

Artifact manifests are a bounded trust boundary, not an invitation to load an output tree into memory. A manifest may describe at most 128 regular-file artifacts, each relative path may contain at most eight segments and 4,096 characters, each artifact may contain at most 64 MiB, and the declared and observed aggregate may contain at most 256 MiB. Kinds are limited to 256 characters. Manifest creation and verification preflight entry counts and file metadata before reading payloads, hash files sequentially through no-follow stable handles, retain only a fixed-size streaming buffer, and reject identity, size, path, or timestamp changes. A limit violation is an explicit nonpassing integrity result and cannot be truncated into success.

Verified bundles are content-addressed and include hashes for every artifact and manifest input. Cryptographic signing is not required initially and must not be implied by the word "verified." A verified bundle requires an explicit conservative `boardRevision` identifier in source-controlled `pcboo.config.ts`; the draft artifact manifest must repeat that exact authenticated value, and the verified manifest derives its revision from the resolved configuration rather than caller metadata. PCBoo warns when that revision is absent from board silkscreen. Git remains the history system rather than a PCBoo-specific revision database.

The public persisted-bundle verifier requires the out-of-band manifest digest returned by publication as its trust authority, reads the committed `pcboo.verified-manifest.json`, authenticates it against that digest, re-derives the semantic type of every manufacturing artifact from its path, reconstructs and verifies any generated `THIRD_PARTY_NOTICES.md` linkage, hashes every recorded file, and rejects missing, extra, symlinked, or special filesystem entries. A digest read from the bundle itself is not authoritative. The generic draft artifact verifier is not a substitute for this complete published-bundle verification.

Promotion and publication accept cancellation as authoritative. Cancellation is checked before evaluation, after each long asynchronous qualification boundary, between artifact transfers, after test hooks, and before the final synchronous validity phase. A cancellation before the validity rename rejects and may retain only an explicitly incomplete recovery directory; it never creates the verified-manifest filename. At the final synchronous boundary, PCBoo records the device, inode, size, modification time, and change time of every hashed committed artifact, draft authority file, and build input, then revalidates all identities after the final exact-tree scan and immediately before the atomic incomplete-token-to-verified-manifest rename. A same-byte inode replacement is therefore still rejected.

## 6. User-facing capabilities

### 6.1 Command-line interface

Projects are created with `bun create pcboo`. The primary framework command is `pcboo`, normally invoked through Bun scripts. Compact compiler-style diagnostics are the default interface for humans and coding agents. A versioned JSON result is available on demand and is also written as the durable detailed report.

```text
pcboo dev
pcboo build
pcboo inspect
pcboo check
pcboo test
pcboo simulate
pcboo export kicad
pcboo export gerbers
pcboo verify manufacturing
```

Every command must:

- Exit nonzero when its requested operation fails.
- Keep default output concise and identify stable diagnostic IDs, affected objects, exact source locations, important measurements, and focused follow-up commands.
- Support versioned `--json` output when a complete structured result is requested.
- Write large or repeated detail to `.pcboo/runs/<run-id>/` and reference it rather than flooding agent context.
- Identify the project and configuration used.
- Distinguish errors, warnings, skipped checks, and unavailable checks.
- Avoid modifying authored source unless explicitly invoked as a fixing operation.
- Never report success when required checks were skipped.

`pcboo build` performs deterministic compilation and fast structural validation. ERC, DRC, user tests, simulations, standards profiles, and manufacturing verification remain separately composable operations. Project-authored tests are ordinary Bun `.test.ts` or `.test.tsx` files using PCBoo assertion helpers; PCBoo does not introduce a YAML, JSON, or proprietary test DSL.

JSON Lines may be exposed for genuinely streaming operations, and SARIF may be exported for compatible CI analysis systems. Neither is the default agent format. HTML is the browser presentation format, not the automation contract. New token-oriented serializations may be benchmarked later but are not part of the initial compatibility promise.

External executables are detected, version-checked, and invoked only when explicitly requested by the relevant command or browser interaction. PCBoo reports installation guidance but does not download or install those tools automatically. Missing tools produce an honest `unavailable` status for the affected operation rather than changing unrelated build validity.

Each PCBoo release declares an exact supported tscircuit version, recorded in `pcboo.lock`. An explicit upgrade operation resolves the new version, runs compatibility checks, reports semantic circuit and artifact changes, and updates the lockfile only after acceptance. PCBoo must prevent multiple incompatible tscircuit instances from breaking the identity of its curated re-exports.

The accepted compatibility authority separately pins the runtime-resolved module closure for the repository/candidate-lock installation and for a clean packed-consumer installation on each qualified platform. A real upgrade review requires both already-installed candidate profiles, executes no installer or network operation, binds both closure digests into the reviewed snapshot, and re-authenticates both before acceptance publication. Identical package-owned tscircuit bytes with a different hoisted, nested, ambient, optional, or aliased runtime dependency topology are a different engine identity and must fail closed.

Runtime closure authority covers every package-owned file in the complete installed production, present optional, and resolved-peer dependency closure rooted at tscircuit; it does not infer completeness from static import syntax. It binds the exact consumer-resolved public entrypoint, package-instance topology, Bun version, platform, and architecture. Clean packed-consumer qualification must prove a physically separate install root containing the packed PCBoo package and direct tscircuit dependency. Initial acceptance requires one canonical, self-digested Apple Silicon macOS evidence record from the same baseline, candidate tuple, Bun version, and fingerprint implementation, and replaces the macOS runtime pins atomically.

The maintainer-only acceptance transaction treats candidate execution as non-authoritative. Intended PCBoo source transformations are constructed and hashed before candidate code runs; all non-output repository gate inputs remain byte-identical through fixture preparation; reviewed canonical fixture inputs, normalized semantics, manufacturing files, and exact inventories are rebound afterward; and the complete staged gate tree remains unchanged through typechecking and tests. Typechecking uses a separately version- and content-pinned TypeScript compiler rather than a compiler supplied by the candidate dependency tree. The candidate must expose one unambiguous ordered root declaration authority, with no `typings` or `typesVersions` alternative, and that declaration must itself directly re-export PCBoo's required Circuit JSON types. Mutated staged inputs, forged ambient declarations, a counterfeit compiler, or a decoy declaration entry can never become acceptance evidence.

The initial Apple Silicon macOS release keeps candidate-executing tscircuit review and acceptance disabled because it does not yet have an authoritative descendant boundary for a candidate-supplied external double-fork. Bun `--no-orphans`, process groups, sampled ancestry, and inherited environment tokens are insufficient authorities. A future native macOS broker must kill and report the native/external double-fork regression before this maintainer transaction may launch a candidate. Until then, the accepted tscircuit version is fixed. The complete `.test.ts` and `.test.tsx` inventory is discovered recursively from required `test/` and optional `tests/` roots so clean checkouts do not depend on untracked empty directories.

### 6.2 Local HTTP server

`pcboo dev` runs on the project folder and serves a fixed, framework-owned inspection application. Projects cannot define custom pages or routes in the initial product. Expected framework routes include:

```text
/
/api/project
/api/circuit
/api/inspect
/api/checks
/api/simulations
/api/artifacts
/schematic
/pcb
/pcb/layers/:layer
/checks
/simulations/:name
/manufacturing
```

The server is local-only by default. Binding to a non-loopback interface requires explicit configuration and a visible security warning. HTTPS may be enabled, but the project must not claim transport security when serving plain HTTP.

The browser may pan, zoom, filter layers, measure geometry, select objects, copy source references, and request builds, checks, or simulations. It may create derived reports and artifacts, but it may not edit or silently rewrite circuit source, configuration, placement, or routing.

### 6.3 Filesystem and coding-agent interface

PCBoo projects are ordinary repositories. Coding agents use the same interface as developers: they read and edit authored TypeScript files, invoke Bun scripts or the `pcboo` CLI, inspect compact command output, and selectively read generated JSON, images, reports, and exports beneath `.pcboo/`.

The filesystem contract must be stable and documented. It includes a project manifest, compiled Circuit JSON, check reports, simulation results, renders, exports, manufacturing reports, and an artifact manifest. Large results are referenced by relative path rather than embedded in terminal output.

PCBoo does not require MCP. An optional external package may expose PCBoo's existing library or CLI operations through MCP for agent hosts that lack normal shell access, but no PCBoo capability, business rule, or test may exist only behind that adapter.

### 6.4 Circuit inspection

Inspection responses are structured and stable enough for an agent to reason about spatial and electrical relationships. Queries support:

- Component, pad, pin, trace, via, hole, net, and layer lookup.
- Bounding boxes, coordinates, rotation, and side.
- Nearest objects and measured distances.
- Connectivity paths and unconnected endpoints.
- Constraint source and resolved value.
- Trace length, via count, and layer transitions.
- Violations affecting an object or region.
- Links to hierarchical component instances and the nearest honest source locations.

### 6.5 Visualization

PCBoo renders schematics, complete PCBs, individual layers, 3D views when available, and manufacturing layers. Rendering is read-only in the initial product definition. Renders must label their source revision and validation state. A visually pleasing render may not hide errors or replace exact diagnostics.

### 6.6 Simulation

PCBoo generates standard SPICE-compatible inputs and invokes a separately installed ngspice executable. PCBoo does not attempt to infer a trustworthy whole-board simulation. Each simulation is an explicit test bench that selects a circuit region, models, stimulus, solver, analysis, and assertions. Supported result forms include operating point, DC sweep, AC analysis, transient analysis, and explicitly configured derived assertions.

Missing models, unsupported components, or unavailable solvers produce `incomplete` or `unavailable` functional-validation status. PCBoo must not guess a model, silently replace electrical behavior, or count a skipped simulation as passed.

Every model has provenance metadata describing its source, version or digest, license status, and redistribution status. A model with unknown redistribution rights may be used locally when legally obtained, but it must not be included in a published package by default.

### 6.7 Part discovery

PCBoo may use tscircuit's JLCPCB/LCSC-oriented search and other configured sources. Search results clearly separate:

- Manufacturer identity.
- Supplier identity and supplier part number.
- Package and footprint compatibility.
- Stock and price freshness.
- Lifecycle status when known.
- Datasheet source.
- Simulation-model availability.
- Source-specific licensing restrictions.

Search results are advisory and time-sensitive. Source code explicitly selects and locks the intended manufacturer or supplier part; PCBoo never performs an automatic substitution. The lockfile records the selected asset resolution, source, immutable digest, retrieval time, and package mapping.

Availability is a separate sourcing status such as `available`, `constrained`, `unavailable`, `stale`, or `unchecked`. It may warn or fail a separately requested sourcing policy, but stock changes do not change compilation, connectivity, or the circuit digest. PCBoo may propose alternatives, but using one requires an explicit source edit followed by the applicable electrical, footprint, and manufacturing checks.

### 6.8 KiCad interoperability

PCBoo exports `.kicad_sch`, `.kicad_pcb`, and project metadata through a replaceable adapter. The export report states which constructs were mapped exactly, approximated, omitted, or unsupported. Export is a detached downstream handoff: after a human edits the KiCad project, PCBoo makes no synchronization or round-trip claim and does not import those edits back into TypeScript automatically. PCBoo never overwrites a human-modified KiCad destination as part of ordinary regeneration.

KiCad is treated as a separately installed application unless a distributor deliberately bundles it and complies with its license. PCBoo avoids linking KiCad GPL implementation code into a differently licensed combined application without explicit legal review.

### 6.9 Manufacturing output

PCBoo produces and verifies, when applicable:

- One copper image for every copper layer.
- Top and bottom solder-mask images.
- Top and bottom paste images when assembly requires them.
- Silkscreen images.
- Board outline/profile.
- Plated and non-plated drill/rout data.
- BOM with stable references and manufacturer/supplier identities.
- Pick-and-place data with side, rotation, and coordinates.
- Layer-stack and fabrication metadata.
- An artifact manifest and verification report.

Manufacturing verification is independent of the exporter. A successful export alone is insufficient to declare a package ready.

Development and debugging may produce prominently marked draft manufacturing artifacts even when checks fail. PCBoo refuses to create a verified production bundle until the active fabrication capability and integrity requirements pass. Constructs generated by tscircuit but not independently understood by PCBoo may remain usable during development with prominent diagnostics; manufacturing verification fails until an independent verifier declares support.

The mandatory fabrication baseline is an ordinary two- or four-layer board using SMT, PTH, and through vias. Six-layer boards, blind or buried vias, and other advanced technologies are supported only when the compiler, router, exporter, independent parser, rule profile, and selected manufacturing adapter all declare and prove the necessary capability. Unsupported capability is never waivable.

### 6.10 Standards-oriented checks

PCBoo can run versioned design-rule profiles derived from publicly usable rules, user-provided rules, or manufacturer capabilities. Each profile declares its jurisdiction or manufacturer, standard edition, supported rules, required evidence, assumptions, and known gaps. Results identify the exact profile version and immutable digest.

PCBoo must use language such as “checked against profile” or “pre-compliance evidence.” It must never state that a board is certified, approved, or legally compliant solely because automated checks pass.

## 7. Diagnostics and result model

Every diagnostic contains, where applicable:

```json
{
  "id": "PCB_CLEARANCE_001",
  "severity": "error",
  "message": "Copper clearance is below the active rule",
  "objects": ["trace.T1", "pad.U1.4"],
  "measurement": { "actual": "0.12mm", "required": ">=0.20mm" },
  "layers": ["top"],
  "sourceLocations": ["circuit/controller/mcu.tsx:42"],
  "profile": "manufacturer.example-4layer@2026-08",
  "evidence": [".pcboo/checks/PCB_CLEARANCE_001.png"]
}
```

Diagnostic identifiers are stable. Human wording may improve without breaking integrations. Suppressions require an explicit source-controlled justification, scope, and optional expiry. Reports list all suppressions prominently.

Diagnostic object, source-location, and evidence arrays are bounded to 256 reference occurrences each in every terminal, JSON, browser, and persisted-report representation; an individual reference is limited to 4,096 characters and a message to 8,192 characters. When additional entries or message characters exist, the diagnostic carries explicit `omittedObjectCount`, `omittedSourceLocationCount`, `omittedEvidenceCount`, or `omittedMessageCharacterCount` fields and concise text reports disclose those omissions. The electrical assessor additionally collapses excess runtime diagnostic classes into one explicit non-passing overflow diagnostic. Bounding detail must never remove the diagnostic, change its severity or status dimension, or turn a non-passing result into a pass; focused inspection remains the path to narrower detail.

Waivers identify the rule, affected component, net, or region, and written justification. Missing verifier capability and artifact-integrity failures cannot be waived. Diagnostic reports expose source provenance, status dimension, tool capability, and a focused inspection or explanation command where applicable.

PCBoo's result model has independent, composable status dimensions:

- **Fabrication validity:** whether the declared manufacturing artifacts satisfy supported geometric, layer, drill, registration, BOM, and placement checks.
- **Electrical status:** ERC, connectivity, and declared electrical-rule outcomes.
- **Functional validation:** explicit tests and simulations, including incomplete or unavailable model coverage.
- **Standards evidence:** results and gaps for each selected pre-compliance profile.
- **Sourcing availability:** advisory freshness and availability of explicitly locked parts.

No status inherits success from another, and no aggregate presentation may hide `failed`, `incomplete`, `unavailable`, or waived findings.

## 8. Test and verification expectations

Testing is a product capability and a release contract. PCBoo is unacceptable if it generates convincing output without proving that the output corresponds to the authored circuit.

### 8.1 Testing principles

1. Exact checks are preferred over snapshots alone.
2. Every fixed defect receives a regression fixture that fails before the fix.
3. Positive and negative cases are equally important.
4. Tests must exercise produced files, not only internal objects.
5. Exporters are checked by independent readers or validators where practical.
6. Images are used for visual regression, not as the sole electrical oracle.
7. Tests explicitly distinguish unsupported, skipped, warning, and passing states.
8. No required test may silently become optional because an external executable is missing.
9. Network-dependent tests use recorded fixtures for deterministic CI and separate live freshness checks.
10. Manufacturing fixtures are retained as immutable golden examples with reviewable changes.
11. An offline project-test or simulation pass requires qualified macOS process-level network containment; until that exists, `pcboo test --offline` must not launch trusted test code, named `pcboo simulate --offline` must not evaluate its testbench or launch the solver, and functional validation remains incomplete. Raw simulation and model inputs remain digest-bound without executing them.

### 8.2 Unit tests

Unit tests cover:

- Unit parsing and conversion across millimetres, inches, mils, degrees, resistance, capacitance, inductance, voltage, current, frequency, and time.
- Coordinate transforms, rotation, mirroring, nested local coordinates, and side changes.
- Bounding boxes, distance calculations, intersections, clearances, and board-edge relationships.
- Net identity, aliasing, port resolution, and connectivity traversal.
- Layer naming, ordering, stack indexing, and valid layer-function combinations.
- Constraint parsing, precedence, conflict reporting, and deterministic resolution.
- Diagnostic serialization and stable identifiers.
- Artifact hashing, stale detection, and path containment.
- Model and part provenance parsing.
- CLI exit-code selection and structured output.

Boundary values, zero values, negative values, very small values, very large values, malformed units, NaN, infinity, and rounding-sensitive cases must be included.

### 8.3 Property and metamorphic tests

Geometry and conversion code must use generated cases to establish invariants:

- Converting units to another representation and back preserves value within declared tolerance.
- Rotating by 360 degrees preserves geometry.
- Translating an entire valid design preserves internal distances and connectivity.
- Mirroring twice preserves the original geometry.
- Reordering source declarations that are semantically unordered does not change the circuit.
- Renaming a component consistently changes identifiers but not electrical behavior.
- Rendering or exporting twice from identical inputs produces equivalent normalized output.

Randomized failures record their seed and minimal counterexample.

### 8.4 Project-loading tests

PCBoo must test:

- A minimal valid project.
- Multi-file imports and deeply nested reusable modules.
- TypeScript and TSX compilation errors with source locations.
- Missing configuration, entry points, dependencies, or lockfiles.
- Circular imports and duplicate component identities.
- Paths containing spaces and non-ASCII characters.
- Running from the project root and from a descendant directory.
- Dirty working trees and stale generated output.
- Attempts to write generated files outside the configured output directory.
- More than one board entry point or assembly definition produces an actionable unsupported-project error.
- `pcboo.config.ts` resolves to serializable deterministic configuration.
- Design-affecting environment-variable reads fail verified-build policy while credentials and declared local tool paths remain usable.
- Source-controlled inputs, `pcboo.lock`, waivers, and vendored assets are distinguished from ignored caches and routine generated output.
- Every scaffolded project uses Bun scripts and standard Bun `.test.ts` or `.test.tsx` tests.

### 8.5 Tscircuit foundation and adapter tests

PCBoo tests its boundary with tscircuit explicitly:

- Every canonical fixture compiles through the supported upstream tscircuit packages rather than a duplicate PCBoo compiler.
- Direct tscircuit output and PCBoo-wrapped output are semantically equivalent before PCBoo adds reports, verification, or qualified exports.
- Every curated export from `pcboo` has the same implementation and type identity as its supported tscircuit export, and mixed import styles compile into one circuit without duplicate engine instances.
- Experimental upstream symbols remain direct-import escape hatches and are not accidentally added to PCBoo's stable surface.
- The adapter validates the Circuit JSON schema and rejects unknown incompatible schema versions.
- Supported tscircuit versions are pinned in CI and declared in project diagnostics and artifact manifests.
- Unsupported or known-incompatible versions fail with an actionable compatibility error.
- Upstream deprecations, renamed fields, changed defaults, and altered layer semantics are detected by fixtures rather than silently normalized.
- A PCBoo compatibility shim has focused tests identifying the exact upstream behavior it adapts.
- A temporary downstream patch has a regression test, upstream issue or contribution reference when available, and an observable removal condition.
- Updating tscircuit cannot change normalized connectivity, layer count, board dimensions, or manufacturing outputs without an intentional golden-fixture review.
- An explicit tscircuit upgrade reports changed normalized circuit or artifact digests before updating `pcboo.lock`.
- PCBoo does not intercept a working upstream capability merely to produce a different implementation with the same purpose.

### 8.6 Electrical connectivity tests

Tests assert:

- Every declared connection resolves to an existing compatible port.
- Required pins are connected or explicitly marked intentionally unconnected.
- Power and ground nets are not accidentally shorted.
- Conflicting output drivers are detected where pin metadata permits.
- Multiple power providers owned by distinct components require comparable, parseable voltage declarations; missing or uninterpretable compatibility evidence leaves electrical status incomplete, while explicitly equivalent voltages remain admissible.
- Unconnected trace endpoints and isolated copper are reported.
- Net identity survives TypeScript-to-Circuit-JSON-to-export transformations.
- Pin numbers and names remain mapped to the correct footprint pads.
- Through-hole barrels and vias connect exactly the intended copper layers.
- Connectivity reports identify a path between requested endpoints or explain the break.

Negative fixtures include swapped pins, duplicate references, missing grounds, accidental shorts, dangling traces, mismatched symbol/footprint pin counts, and ambiguous port hints.

Verified-bundle fixtures also prove that every manufactured component has an explicit stable name. Loops, nested modules, and reusable components preserve a hierarchical instance path and nearest source provenance for generated components, nets, pads, traces, and violations.

### 8.7 Spatial and design-rule tests

Tests cover at least:

- Copper-to-copper clearance on the same and adjacent objects.
- Copper, component, hole, and courtyard clearance to the board edge.
- Pad-to-pad, trace-to-pad, trace-to-trace, via-to-trace, and via-to-via clearance.
- Minimum trace width, annular ring, drill size, slot dimensions, and mask sliver.
- Solder-mask expansion and paste apertures on appropriate outer layers only.
- Component overlap, courtyard overlap, keep-outs, and height restrictions when data exists.
- Board outline closure, self-intersection, internal cut-outs, and valid profiles.
- Components placed outside the board.
- Relational placement constraints and explicit tolerance boundaries.
- Differential-pair spacing and length mismatch when configured.
- Maximum length and via-count constraints.

Every rule is tested immediately below, exactly at, and immediately above its boundary tolerance.

The initial independently qualified fabrication evaluator accepts at most 8,000 Circuit JSON elements, 8,192 aggregate physical route points, 8,192 aggregate layer references, 8,192 aggregate logical-connectivity member references, 4,096 routed traces, and 4,096 actually emitted features in any pairwise geometry domain. These are fabrication-verification limits, not compiler success claims. Cheap element, route, layer, logical-reference, and trace limits are checked by collection length before emitted geometry or connectivity sets are built; exceeding one produces one non-waivable `FAB_RESOURCE_LIMIT_001` failure with the exact observed count, limit, and excess, and geometry evaluation does not begin. Within the envelope, pairwise rule evaluation retains at most 255 distinct detailed violations plus an explicit omitted-at-least marker; the presence of omitted detail remains a failure and can never become a pass. Component ownership and logical-net-to-physical-trace lookup use indexed mappings, route measurements are computed once per logical net, and physical trace segments are computed once per trace rather than rebuilt inside pair checks.

### 8.8 Routing tests

Routing verification tests assert:

- Every required net is fully routed or explicitly exempted.
- Traces do not cross different nets on the same copper layer.
- A route never reports success while containing a geometric or electrical short.
- Vias use allowed spans and drill classes.
- Route segments remain within the board and outside keep-outs.
- Route endpoints terminate on the intended pads or vias.
- Re-running a deterministic router with identical inputs yields equivalent routing.
- Router failure returns unresolved nets and congestion evidence rather than partial success.

The suite includes narrow channels, dense pads, unavoidable-routing cases, same-layer crossing traps, multilayer escapes, and intentionally impossible boards.

### 8.9 Simulation tests

Simulation tests include:

- Detection and version reporting for ngspice.
- Netlist generation with correct node names, values, models, and analysis commands.
- A resistor-divider operating-point assertion.
- RC transient charge and discharge assertions.
- RLC or active-filter AC response assertions.
- A regulator or power-startup transient fixture when suitable models are available.
- Parameter sweep and tolerance-bound assertions.
- Simulator timeout, non-convergence, singular matrix, missing model, invalid model, and crashed-process handling.
- Parsing of scientific notation, complex AC values, stepped analyses, and empty outputs.
- Explicit units and numeric tolerances in every assertion.
- Selected logical nets must map injectively into the solver's identifier rules; distinct nets that collide under ngspice's case-insensitive node identity, including multiple ground aliases, are invalid rather than silently shorted.
- Explicit test-bench scope, stimulus, solver, model set, and assertions.
- Incomplete coverage when any selected component lacks a required model.
- Rejection of silently guessed or automatically substituted models.
- Parse-time cardinality limits for simulation regions, models, model bindings, stimuli, PWL points, assertions, requested vectors, model-digest evidence, and solver sample counts. The initial limits admit at most 4,096 selected components, 4,096 selected nets, 250 model records (leaving entries for five framework-owned files and the models directory), 4,096 aggregate model bindings, 256 stimuli, 4,096 PWL points per stimulus, 256 assertions, 256 physical result vectors, 200,000 samples per vector, and 250,000 aggregate vector samples. A declared analysis that cannot fit the bounded result schema is invalid rather than runnable-but-impossible.
- Simulation model artifacts are preflighted before a run directory is created, are limited to 16 MiB per file and 64 MiB across the model copies named by one run, and identical path/digest inputs are read once. ngspice raw output is capped at 8 MiB, probe streams at 1 MiB each during execution, and a configured ngspice executable at 64 MiB before hashing or capture. Every executable, model, and raw-output read uses a no-follow stable file handle, enforces its byte ceiling during capture, and rejects path, identity, size, or timestamp changes.
- Repeated assertions reuse bounded projection work. Late cancellation remains authoritative after solver exit, removes the unpublished simulation directory, and cannot return artifact or evidence references. Evidence and aggregate artifact sizes are checked before evidence publication.

A simulation passes only when the simulator exits successfully, expected result vectors exist, values are finite, all declared assertions pass, and the exact captured executable has passed PCBoo's same-run behavioral qualification. Qualification consists of framework-owned operating-point, transient, AC magnitude/phase, and DC-sweep cases with fixed analytical oracles; it is bounded by per-case and aggregate deadlines, output limits, exact-tree validation, cancellation, process containment, and executable identity checks before and after cases. Generated and qualification decks require ASCII raw output and the solver is invoked with `-n` so user initialization files cannot alter behavior. The serialized qualification report is evidence, not reusable authority. A version string, one canned result, persisted JSON, or caller-authored passing status cannot grant a pass. Missing ngspice causes a clear `unavailable` functional-validation result for a required simulation, not a pass or silent skip. It does not invalidate unrelated compilation or fabrication status.

When functional validation is explicitly required for a production bundle, promotion accepts only same-process authority issued after qualified execution and final exact-artifact verification, bound to the current Circuit JSON digest and the complete source/config/test/profile/waiver/lock/vendor snapshot. The verified manifest records the simulation definition, model, adapter, executable, qualification, stream, raw-output, circuit, and input-snapshot identities. Persisted evidence remains independently inspectable but cannot mint or replay runtime authority.

### 8.10 Gerber and drill tests

Manufacturing tests exercise the actual emitted files. Required baseline fixtures include two- and four-copper-layer boards using SMT, PTH, and through vias. Six-layer and advanced-via fixtures become release requirements only for adapters that declare those capabilities.

For every fixture, tests assert:

- Exactly one correctly identified copper file exists per copper layer.
- Inner layers contain copper only unless a separately supported fabrication function is explicit.
- Solder mask and paste are emitted only for applicable outer sides.
- Board profile exists, is closed, uses the common coordinate system, and has expected dimensions.
- Plated and non-plated drill data are distinct and contain expected tools and coordinates.
- Through holes retain copper pads on every electrically intended layer.
- Vias connect intended inner planes or traces after export.
- No expected layer is empty, missing, duplicated, mirrored, scaled, or offset.
- All layers share registration and orientation.
- File functions, polarities, units, and coordinate formats are explicit and valid.
- Rendered output bounds agree with source geometry within declared tolerance.
- An independent parser can load every produced file without error.

The four-layer regression board must contain a plated through-hole spanning top, inner1, inner2, and bottom. It must prove that copper is present on all intended layers, mask openings are present only on the outer sides, drill data is present, and export does not request an inner solder-mask or paste layer.

Additional negative fixtures include missing profiles, truncated files, zero-byte layers, duplicate layer functions, mismatched coordinates, unsupported via spans, malformed apertures, and intentionally removed inner copper.

Tests prove that a failed check may emit only clearly marked draft artifacts and that the same project cannot emit a verified production bundle. A tscircuit construct without an independent PCBoo verifier is usable only in development and blocks fabrication verification. Capability and artifact-integrity failures remain non-waivable.

Independent manufacturing verification temporarily limits the captured package to 64 MiB aggregate (with the same 64 MiB per-file ceiling) until one-file-at-a-time authenticated spooling replaces package-wide retained Buffers. Text artifacts admit at most 250,000 logical lines; the Gerber/Excellon parser admits 25,000 records per file, 125,000 records per package, 1,024 warnings per file, and 65,536 total warning characters per file. Parser record strings, tool parameters, and warning messages are independently bounded. Parser work is fed in bounded chunks and terminates on a limit rather than continuing after a finding. Reconciliation admits at most 4,096 flashes, segments, drill hits, BOM rows, or placements per collection. CSV admits at most 4,096 rows, 64 fields per row, 16,384 characters per field, and 65,536 characters per row. Caller-owned expectations are converted into a newly allocated, exact-schema snapshot of bounded primitives before hashing; unknown or nested caller properties are never cloned. Raw parser records are released after one compact geometry summary is produced, and duplicate BOM or placement rows consume distinct matches. Additional artifact paths are count- and length-bounded before iteration. Every violation is `MANUFACTURING_INPUT_LIMIT`, remains nonpassing, and cannot be waived into a verified bundle.

Verified-bundle tests also assert that every file matches its manifest digest, source and lockfile digests are present, external tool and profile versions are recorded, and an explicit board revision is present. Absence of that revision from silkscreen produces the required warning. No unsigned bundle is described as cryptographically signed. Manifest-boundary regressions use sparse files to prove that a 129th entry, a 64 MiB-plus-one-byte artifact, and a declared or observed manifest aggregate above 256 MiB fail during metadata preflight without artifact payload reads. Manufacturing-verifier regressions separately enforce its tighter 64 MiB captured-package ceiling. Ordinary manifests must remain byte-identical and valid under sequential streaming verification.

### 8.11 BOM and pick-and-place tests

Tests assert:

- Every fitted component appears exactly once in the BOM.
- Explicit do-not-fit components are represented according to the selected output profile.
- Reference, quantity, value, manufacturer, manufacturer part number, supplier, supplier part number, and package are not conflated.
- Grouping does not combine electrically or mechanically incompatible parts.
- Pick-and-place includes every assembled surface-mount part exactly once.
- Side, rotation, origin, units, and coordinate convention are explicit.
- Bottom-side transformations are correct.
- BOM and placement references agree with each other and with the board.
- Missing sourcing identity or ambiguous rotation blocks a verified production bundle when the selected manufacturing profile requires assembly data.

### 8.12 KiCad interoperability tests

Tests generate KiCad projects and validate:

- Files parse successfully in each supported KiCad major version.
- Component references, values, symbols, footprints, nets, traces, vias, holes, outlines, and copper layers survive export.
- Four-layer ordering and names are correct.
- Dimensions and coordinates agree with source geometry.
- A KiCad ERC/DRC invocation, when supported by the installed version, produces parseable results.
- Unsupported constructs appear in the export report and cause strict-mode failure.
- Human-modified destination files are not overwritten by ordinary regeneration.
- A modified KiCad handoff is reported as an independent downstream design with no source synchronization or automatic TypeScript round trip.

Golden KiCad files are normalized before comparison to exclude timestamps, generated identifiers, or ordering that has no semantic meaning.

### 8.13 Part-search and model tests

Recorded-source tests cover search, filtering, ranking, cache behavior, unit normalization, package mapping, and unavailable fields. Live checks separately verify that configured sources remain reachable and that their schemas have not changed unexpectedly.

Tests assert that:

- A supplier result is never represented as a manufacturer identity.
- Stock and price include retrieval time and source.
- Stale cached data is visibly marked.
- Footprint compatibility requires a known mapping rather than name similarity alone.
- SPICE model availability is independent of footprint availability.
- Model files retain a digest and license/redistribution state.
- Restricted or unknown-license assets are excluded from redistributable packages by default.
- A locked part is never changed because newer availability metadata suggests a substitute.
- Availability changes update only the separate sourcing status and do not change the circuit digest.
- Proposed substitutes require an explicit source edit and subsequent compatibility checks.
- `--offline` blocks PCBoo-managed network access while allowing builds from complete immutable caches or vendored assets; it is not an operating-system sandbox for trusted executable project code.
- Network refresh cannot replace a footprint, model, or other asset unless source or `pcboo.lock` changes to a new immutable version or digest.
- `pcboo vendor` preserves authorship, license, source, and content digest for each redistributed asset.

### 8.14 HTTP server tests

Server tests cover:

- Loopback-only binding by default.
- Port selection and collision reporting.
- Correct content types, status codes, caching rules, and JSON schemas.
- Project rebuilds after relevant file changes.
- No rebuild loop from generated-file changes.
- Atomic result publication so clients never observe half-written builds.
- Concurrent readers during rebuild.
- Malformed identifiers, unknown routes, large queries, and cancellation.
- No path traversal or arbitrary file reads through artifact routes.
- Accurate reporting of HTTP versus HTTPS.
- Graceful shutdown without corrupting artifacts.
- Only fixed PCBoo routes are served; a project cannot add custom application pages or handlers.
- Pan, zoom, measurement, layer filtering, selection, source-reference copying, checks, and simulations work without modifying authored source or configuration.
- Network binding requires an explicit `--host` or equivalent setting and emits the declared security warning.

### 8.15 Filesystem and CLI contract tests

Filesystem and CLI conformance tests assert:

- Command help, arguments, exit codes, JSON schemas, and output paths remain stable within the declared compatibility policy.
- Every operation can run from package scripts and from the direct `pcboo` command.
- Compact default diagnostics and versioned JSON communicate the same outcome, stable finding IDs, source locations, measurements, and status dimensions.
- Default output remains bounded and points to `.pcboo/runs/<run-id>/` for full detail.
- Filtering and focused inspection commands retrieve individual findings, objects, nets, or status dimensions without requiring an entire report in agent context.
- JSON Lines is used only for declared streaming contracts and optional SARIF validates against the supported SARIF schema.
- Large data is written to bounded artifact files and referenced by relative path.
- Unknown objects and invalid arguments produce typed, actionable errors.
- Read-only commands do not modify authored files.
- Generated output remains contained beneath `.pcboo/` or the configured output root.
- Cancellation and timeout propagate to subprocesses.
- Concurrent commands cannot publish a partially written or falsely valid artifact.
- A clean coding-agent environment with only filesystem and shell access can discover, build, inspect, check, simulate, render, and export a fixture project end to end.
- `pcboo build` performs compilation and fast structural validation without falsely implying that ERC, DRC, simulation, standards, or fabrication verification ran.
- Missing external executables are detected with versions or installation guidance and are never installed automatically.
- Fabrication, electrical, functional, standards-evidence, and sourcing statuses serialize independently and cannot overwrite or imply one another.
- A failed, incomplete, unavailable, or waived status remains visible in terminal, JSON, browser, and bundle-manifest presentations.
- Scoped waivers require a stable rule ID, affected object or region, and written justification; capability and artifact-integrity failures reject waiver attempts.

### 8.16 Agent-system evaluations

Agent evaluations measure the complete environment rather than accepting persuasive text. Each evaluation begins from a fixed repository and a natural-language request. Success is determined by repository state and deterministic checks.

Evaluation tasks include:

- Add a component and connect it to the correct existing nets.
- Replace a part without changing incompatible footprint or voltage constraints.
- Move a connector to a specified board edge while preserving required nearby components.
- Diagnose and repair an ERC failure.
- Diagnose and repair a DRC clearance failure.
- Repair a failed simulation assertion.
- Produce a valid four-layer manufacturing archive.
- Explain an unsupported export without fabricating a success claim.
- Export to KiCad after an adjustment request.

An evaluation fails if the agent edits generated files instead of source, suppresses a rule without justification, changes the requested behavior, leaves required tests skipped, or claims success while a deterministic gate fails.

Agent evaluations are run across more than one compatible agent when practical. PCBoo correctness may not depend on a particular model's hidden prompt behavior.

### 8.17 Security tests

Security tests include:

- Path traversal and symlink escapes from project and output roots.
- Shell metacharacters in filenames, component names, model paths, and configuration values.
- Command arguments passed without unsafe shell interpolation.
- Malicious SPICE include paths and recursive includes.
- Oversized or adversarial Circuit JSON and Gerber inputs.
- Server exposure and cross-origin behavior.
- Secret redaction from logs, reports, and agent responses.
- Dependency and lockfile integrity checks.
- Untrusted project hooks disabled by default or clearly authorized.
- Denial-of-service limits for render, route, parse, simulation, and inspection requests.
- Sanitization of undeclared environment input during verified builds.
- Two fresh-process evaluations with normalized digest comparison and a deterministic failure fixture.
- Clear warnings that executing a project runs trusted TypeScript with the user's permissions.
- A network-observed default workflow proving that PCBoo emits no telemetry or project data.

PCBoo treats project repositories, project tests, and explicitly selected local tool executables as trusted executable code once the user invokes a build, test, simulation, or development command. Merely discovering or displaying project metadata must not execute them. Process supervision must prevent the direct child and signal behavior covered by its declared OS mechanism, but it is not described as a sandbox against an executable that intentionally attacks PCBoo or brokers work through system services. Third-party models, data files, tool output, and generated formats remain adversarial parser inputs. Reproducibility and process-cleanup checks are not described as protection against malicious project or executable code.

### 8.18 Performance and reliability tests

Performance fixtures define small, medium, and large boards with recorded component, pad, trace, and layer counts. Measurements include cold build, incremental rebuild, inspection query, rendering, DRC, export, and peak memory.

Performance regressions are reported against versioned baselines. Limits must be expressed per fixture and environment rather than as unsupported universal promises. Long-running operations expose progress and support cancellation. Cancellation must terminate child processes and leave no artifact marked valid.

Memory-intensive qualification gates run as separate, serial process invocations rather than sharing one test worker: full TypeScript analysis, packed-package end-to-end verification, production-promotion fixtures, maximum-size artifact hashing, dense manufacturing-parser fixtures, and every cold full-closure CLI integration scenario are measured independently. CLI integration runs one named case per fresh process and reconciles its syntax-derived inventory against Bun's exact JUnit case, file, skip, and failure records; empty, focused, unexpectedly skipped, unselected, or zero-match execution cannot pass. Every process and aggregate gate has a finite internal deadline. Each top-level gate records peak resident memory and swap activity. On macOS, CI records its orphan cleanup as best effort and rejects descendants that remain in the dedicated process group, were observed through ancestry sampling, or retain the inherited containment token after completion or cancellation. It does not claim to detect a detached descendant that exits the sampled ancestry path and deliberately or accidentally removes that token; universal orphan rejection requires a qualified kernel-owned scope and must fail closed when asserted. No adversarial Circuit JSON fixture may exceed the compiler and verifier's declared 8,000-element envelope merely to create memory pressure; larger-input behavior is exercised through cheap preflight rejection. A passing aggregate run must never depend on concurrently retaining several maximum-size fixtures.

Stress tests cover repeated rebuilds, rapid file changes, simultaneous filesystem and HTTP readers, failed subprocesses, and interrupted writes.

### 8.19 Platform and version compatibility tests

Supported releases are tested with the declared Bun version on Apple Silicon macOS. PCBoo's effectful and authoritative public boundaries fail closed before project evaluation or output publication when the running Bun version, operating system, or architecture is outside that declared set. Tests cover macOS path, executable-discovery, line-ending, case-sensitivity, process-signaling, and archive behavior. Node.js compatibility is neither a release gate nor a supported-runtime claim.

Adapters declare supported tscircuit, Circuit JSON, ngspice, and KiCad version ranges. Unsupported versions produce a clear compatibility diagnostic. CI uses pinned versions; a separate compatibility job exercises the newest supported versions.

### 8.20 Documentation tests

- Every documented command is exercised in CI.
- Example projects build and run their declared checks.
- JSON and CLI examples conform to current schemas and exit-code behavior.
- Links to generated routes and artifacts resolve.
- Installation instructions are verified in a clean environment.
- Safety and certification limitations appear in manufacturing and standards documentation.
- Attribution documentation, `THIRD_PARTY_NOTICES.md`, and asset provenance remain complete and do not imply tscircuit endorsement.
- Documentation states that telemetry is disabled by default and accurately describes any future opt-in boundary.

### 8.21 Licensing, attribution, and provenance tests

Tests and packaging checks assert:

- PCBoo source distributions contain the complete MIT License and correct PCBoo copyright notice.
- README and architecture documentation credit tscircuit without claiming official status, affiliation, or endorsement.
- Distributions that bundle or substantially incorporate tscircuit code preserve the applicable tscircuit copyright and MIT permission notice.
- `THIRD_PARTY_NOTICES.md` is generated from the actual bundled dependency and asset graph and cannot silently omit an incorporated item.
- Packages with missing, unknown, or incompatible code licenses fail the applicable redistributable-package gate.
- Vendored footprints, models, component data, and other assets retain author, source, license, redistribution status, version, and content digest.
- Restricted or unknown-rights assets remain local-only by default and cannot enter a public or redistributable bundle accidentally.
- Circuit source, Gerbers, drill files, BOMs, and other ordinary user outputs are not relabeled as MIT-licensed merely because PCBoo generated them.

The normal `pcboo` and `create-pcboo` package lifecycle runs a fail-closed prepack check. It accepts only the explicitly qualified package-file inventory, exact complete PCBoo MIT license bytes, and an exact generated notice. The `pcboo` boundary recursively accepts only bounded regular TypeScript files under `src`, requires every one to carry the reviewed PCBoo copyright and MIT SPDX headers, rejects unqualified third-party directories and non-TypeScript assets, and reconciles every detected bare package import plus every direct runtime, optional, and peer dependency declaration to the exact qualified notice graph. `create-pcboo` likewise rejects installable dependencies in any of those fields until an explicit notice policy qualifies them. The boundary rejects silently bundled dependencies, reads metadata, source, and license evidence through bounded stable regular-file handles, and binds every installed direct package to reviewed content SHA-256 before checking its complete license-obligation evidence. This check validates local evidence only and never downloads or repairs it.

## 9. Canonical verification fixtures

PCBoo maintains a compact set of reviewable reference projects:

1. **Minimal:** one resistor and explicit ports; validates project loading and units.
2. **LED board:** source, resistor, LED, connector, and two-layer PCB; validates basic ERC, DRC, BOM, and Gerber output.
3. **Divider simulation:** resistor divider with operating-point assertions.
4. **RC transient:** known time constant with waveform assertions.
5. **Regulated MCU board:** power input, regulator, decoupling, MCU, programming header, and connectors.
6. **Four-layer plated-hole board:** signal/plane stack, through vias, inner-plane connections, PTH connector, mask, and drills.
7. **Advanced capability board:** a six-layer or advanced-via fixture used only by adapters that explicitly declare the corresponding capabilities.
8. **Bottom assembly board:** bottom-side parts with rotation and pick-and-place assertions.
9. **Mechanical board:** cut-outs, mounting holes, edge connector, keep-outs, and enclosure constraints.
10. **Invalid corpus:** isolated failures for every stable diagnostic identifier.

Each valid fixture includes authored expectations for connectivity, dimensions, layer count, key coordinates, route properties, simulation values where applicable, and the exact required manufacturing file set.

## 10. Status and verified-production-bundle contract

PCBoo does not expose one universal "ready" state. Every run and bundle reports fabrication validity, electrical status, functional validation, standards evidence, and sourcing availability separately.

Fabrication validity may pass only when:

- The source project compiles and the one-board, one-assembly definition is structurally valid.
- The active manufacturing technology is within the proven capability intersection of the compiler, router, exporter, independent parser, rule profile, and manufacturing adapter.
- Every manufactured component has an explicit stable name, resolved footprint, pad mapping, and assembly identity as required.
- Required spatial and routing checks pass, subject only to documented, scoped waivers.
- Gerber and drill files pass independent parsing, registration, layer-count, layer-order, and content reconciliation.
- BOM and pick-and-place data reconcile with the board.
- Artifact provenance is complete, content hashes match, the board revision is explicit, and artifacts are not stale.
- No required fabrication check is skipped, unavailable, or unsupported.

A verified production bundle additionally requires required electrical and connectivity checks to pass. Functional simulations, standards profiles, and sourcing policies block that bundle only when the project explicitly declares them required; their independent statuses always remain visible. A missing or failed required dimension can never be hidden by a passing fabrication status.

Failed projects may export draft files for diagnosis. Draft archives and reports are visibly marked, cannot contain a verified manifest, and cannot be mistaken for a verified production bundle through naming or browser presentation.

The bundle reports every warning, waiver, tool version, capability, profile, status, known gap, and content digest. It means only that the declared automated gates passed. It does not guarantee fabrication yield, functionality, regulatory compliance, fitness for purpose, or safety, and it is not a cryptographic signature or certification.

## 11. Release quality contract

A PCBoo release is acceptable only when:

- Unit, property, integration, fixture, filesystem, CLI, and HTTP suites pass on supported platforms.
- Canonical two- and four-layer baseline fixtures pass manufacturing verification on every supported platform.
- Every adapter advertising six-layer, blind-via, buried-via, or another advanced capability passes the corresponding independent capability fixtures; releases may omit capabilities they do not advertise.
- No known regression can produce a false successful manufacturing result.
- New or changed output formats have independent parser coverage.
- Required examples and documentation commands pass from a clean checkout.
- Dependency licenses and bundled assets are inventoried.
- Required tscircuit attribution and all other third-party notices are present in source and bundled distributions.
- Known limitations are machine-readable and documented.
- Test results identify exact dependency and adapter versions.
- The supported Bun release passes on Apple Silicon macOS; Linux, Windows, Intel macOS, and Node.js are not treated as supported runtimes.
- Default telemetry remains absent and no test or feature silently transmits project data.

A release must be blocked by a false pass in connectivity, DRC, simulation assertion, layer generation, drill generation, BOM reconciliation, or artifact freshness. A loud false negative may be triaged; a false positive affecting electrical or manufacturing correctness is release-critical.

## 12. Success criteria

PCBoo succeeds when a user can point an existing coding agent at a normal multi-file TypeScript repository and the agent can:

1. Understand the project through stable files, documented commands, compact diagnostics, and selectively requested versioned reports.
2. Create or modify a circuit without relying on a proprietary editor.
3. Query exact electrical and spatial state.
4. Iterate against deterministic failures.
5. Run named simulations and tests.
6. Produce inspectable schematic, PCB, and layer renders.
7. Export a clearly qualified KiCad project.
8. Produce a draft package for diagnosis or a clearly distinguished verified production bundle that passes independent fabrication checks.
9. Read separate electrical, fabrication, functional, standards, and sourcing statuses without mistaking one for another.
10. Explain remaining warnings, assumptions, unsupported features, waivers, and evidence honestly.

The defining product outcome is not that an agent can generate circuit-shaped code. It is that PCBoo can distinguish a verified result from a plausible but unsafe one.
