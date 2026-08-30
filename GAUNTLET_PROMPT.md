# Fulmetry Engineering Gauntlet Prompt

This is a deliberate engineering adaptation of the game-oriented Gauntlet Loop. It preserves the relentless builder-versus-independent-critic method while making deterministic evidence, rather than visual taste, the primary oracle.

Copy the prompt below into a fresh Codex task from the Fulmetry repository. The human remains the brake.

```text
Run the Gauntlet Loop on Fulmetry in /Users/alok/projects/fulmetry. This is an explicit non-game use of the method. Use /goal for the persistent objective. Do not merely compose a plan or restate this prompt: inspect the repository, implement the product, run the evidence, criticize the result independently, repair it, and continue until I stop you.

I want you to build Fulmetry at the quality level of a mature, widely adopted developer framework such as Next.js, on top of tscircuit as its circuit engine, with the verification discipline expected from a trustworthy compiler and EDA manufacturing toolchain. Its initial Apple Silicon macOS product should be exceptionally clear, deterministic, composable, agent-friendly, and honest about what it has and has not proven. Every part must be production-grade, from Bun project scaffolding and multi-file TypeScript authoring to circuit inspection, simulations, independent manufacturing verification, detached KiCad handoff, provenance, licensing, security, and documentation.

Fan out independent builder agents across genuinely separable workstreams. Give each workstream a separate critic that did not implement it. Critics must be harsh, evidence-driven, and actively try to falsify the builder's claims. A builder saying that code looks correct, a test file existing, a screenshot looking plausible, tscircuit returning success, or an exporter producing files is not verification. If a critic cannot reproduce a claim from a clean checkout with exact commands and inspectable artifacts, the claim fails and the builder continues.

Do not stop after one successful cycle. Continue comparing Fulmetry against its authoritative requirements and the relevant mature references. For developer experience, compare against the clarity and predictability of established Bun/TypeScript frameworks. For circuit semantics, compare Fulmetry output with the pinned upstream tscircuit engine. For manufacturing artifacts, use independent parsers and reconciliations rather than trusting the code that wrote them. For engineering correctness, objective evidence overrides aesthetic or narrative judgment. Use blind A/B comparison only where it is meaningful—for example, unlabeled CLI transcripts or inspection responses judged for clarity and actionability—not as a substitute for electrical, geometric, simulation, or manufacturing oracles. The human is the brake; keep improving until I stop you.

AUTHORITATIVE CONTRACT

1. Read PRODUCT_REQUIREMENTS.md completely before changing code. It is the primary product and quality contract.
2. Read FUTURE_EXPLORATIONS.md completely. Its contents are explicitly deferred and must not silently enter the current scope.
3. Read README.md and LICENSE. Preserve Fulmetry's MIT license, tscircuit credit, third-party notices, and the statement that Fulmetry is independent and not officially endorsed by tscircuit.
4. Inspect the actual repository, dependency graph, installed tools, and current test state. Do not assume that a documented capability exists.
5. Preserve unrelated user changes. Do not commit, push, publish packages, install external EDA applications, or make external state changes unless I explicitly request them.

PRODUCT BOUNDARY THAT MUST SURVIVE EVERY ROUND

- Fulmetry is a Bun-required TypeScript framework around tscircuit, analogous in layering—not feature identity—to Next.js around React.
- tscircuit remains the circuit authoring and compiler foundation. Fulmetry adds conventions, stable commands, inspection, testing, verification, interoperability, provenance, and a fixed local browser interface.
- Fulmetry is agent-first but agent-independent. It does not contain its own model, chat product, or required MCP server.
- Each project has one board and one deterministic assembly definition. Multi-board workspaces and named assembly variants are deferred.
- The browser is interactive for inspection, measurement, layer control, checks, and simulations, but never edits circuit source, configuration, placement, or routing.
- Fulmetry reports fabrication, electrical, functional, standards-evidence, and sourcing statuses independently. Never collapse them into one ambiguous ready state.
- Draft artifacts may be produced for diagnosis. A verified production bundle is blocked by every required failure, unsupported capability, unavailable required check, or artifact-integrity error.
- The conservative mandatory manufacturing baseline is ordinary two- and four-layer boards with SMT, PTH, and through vias. Advanced technologies are supported only when every relevant adapter proves the capability.
- Project source is trusted executable TypeScript, not a security sandbox. Reproducibility checks must not be described as protection from malicious code.
- No telemetry is collected by default.

FAN-OUT WORKSTREAMS

Divide work only where agents can proceed independently without editing the same files. At minimum, repeatedly audit these concerns:

- Bun scaffolding, project discovery, configuration, lockfile, cache, vendoring, and offline behavior.
- Curated `fulmetry` authoring exports, exact tscircuit implementation identity, Circuit JSON compatibility, and explicit upgrades.
- Compact CLI diagnostics, focused inspection commands, versioned JSON reports, exit classifications, and artifact paths.
- Fixed localhost development server and non-authoring schematic, PCB, layer, diagnostic, simulation, and artifact views.
- Stable component identities, hierarchical source provenance, connectivity inspection, ERC, DRC, placement, and routing rules.
- Explicit simulation test benches, model provenance, solver adapters, numeric assertions, and honest incomplete/unavailable states.
- Gerber, drill, BOM, pick-and-place, stack-up, draft export, and verified-bundle generation.
- Detached KiCad export, lossiness reporting, supported-version parsing, and overwrite protection.
- Part locking, sourcing freshness, immutable asset resolution, no automatic substitution, licenses, and redistributable vendoring.
- Security, privacy, subprocess handling, path containment, atomic publication, cancellation, performance, and platform compatibility.
- Documentation, examples, agent-system evaluations, attribution, and third-party notices.

THE LOOP FOR EVERY WORKSTREAM

1. Establish the current baseline with exact commands and retain the relevant output paths. Distinguish missing implementation from failing implementation and unavailable external tools.
2. Select the highest-risk unsatisfied requirement, prioritizing false passes and artifact-integrity defects over cosmetic improvements.
3. Add or strengthen a test that would fail for the defect. For critical verification gates, prove test sensitivity with an existing negative fixture, a minimal reproducer, or a controlled temporary mutation. Never damage the real working tree merely to demonstrate a mutation.
4. Implement the smallest coherent production change that satisfies the requirement without bypassing tscircuit or broadening scope into a deferred feature.
5. Run focused tests, then the relevant integration and canonical fixtures, then the broadest affordable suite.
6. Hand the changed work and raw evidence to a separate critic. The critic must inspect the diff, rerun commands from a clean process, examine generated artifacts, challenge capability and status claims, and search for false positives, stale files, hidden skips, platform assumptions, and license problems.
7. If the critic finds a reproducible weakness, return it to the builder with the exact command, expected result, observed result, affected requirement, and minimal evidence. Repair it and repeat.
8. A passing round closes only that finding. Select the next highest-risk requirement and continue. Do not ask whether to continue.

MANDATORY VERIFICATION GAUNTLET

A. Upstream identity and compatibility

- Prove that every curated authoring export from `fulmetry` is the exact supported tscircuit implementation, not a wrapper, subclass, or duplicate engine instance.
- Compile fixtures that mix `fulmetry` and direct tscircuit imports and verify semantic equivalence of normalized Circuit JSON.
- Pin the exact supported tscircuit version in `fulmetry.lock` and test incompatible versions, schema changes, changed defaults, and duplicate installations.
- An upgrade must show semantic and artifact digest changes before the lockfile is accepted.

B. Project determinism and filesystem ownership

- Prove one-board and one-assembly enforcement, multi-file composition, stable discovery from descendant directories, and paths with spaces and non-ASCII characters.
- Prove that design intent comes from source, project behavior from `fulmetry.config.ts`, external requirements from named profiles, resolutions from `fulmetry.lock`, and only secrets or local tool paths from the environment.
- Run verified builds twice in fresh processes with sanitized undeclared environment input. Compare normalized circuit and artifact digests and fail actionable nondeterminism fixtures.
- Prove that source, config, tests, lockfile, waivers, and intentional vendoring are distinct from ignored `.fulmetry/` cache and ordinary output.
- Prove `--offline` blocks Fulmetry-managed network access and that network refresh cannot alter the circuit digest without a source or lockfile change.

C. Diagnostics and agent usability

- Default CLI output must be concise and contain stable rule IDs, exact source locations, affected objects, measurements, status dimensions, and a focused next command.
- Full detail must live in a bounded `.fulmetry/runs/<run-id>/` report. `--json` must conform to a versioned schema and communicate the same outcome as text.
- Verify filtering and inspection by component, pad, net, layer, region, rule, and status without forcing the agent to load an entire report.
- Test all exit classifications, including failure, warning-only, unavailable, incomplete, cancelled, and unsupported.
- A blind DX critic may compare unlabeled transcripts with mature CLI tools, but cannot override objective correctness.

D. Electrical, spatial, and provenance correctness

- Verify connectivity, required pins, shorts, conflicting drivers when metadata permits, dangling traces, port resolution, footprint pin mapping, PTH barrels, vias, and net identity across every transformation.
- Exercise every geometric rule immediately below, exactly at, and immediately above its tolerance.
- Require explicit stable manufactured-component names before verified release; allow deterministic temporary names only with warnings during development.
- Trace generated components, pads, nets, traces, vias, and diagnostics to a hierarchical instance path and the nearest honest source location. Mark synthetic entities as generated.
- Router success is invalid if any required net is unresolved, any route crosses a different net on the same layer, or any segment violates board or keep-out constraints.

E. Manufacturing verification—the highest-risk gate

- Test the actual emitted Gerber, drill, BOM, and pick-and-place files, not only internal objects or screenshots.
- Use an independent parser or validator that does not share the exporter's transformation logic. Reconcile parsed artifacts back to the authored circuit and configured stack.
- Maintain canonical two-layer and four-layer fixtures with SMT, PTH, and through vias. The four-layer fixture must prove top, inner1, inner2, and bottom copper; correct through-hole and via connectivity; outer-only mask and paste behavior; plated and non-plated drill data; registration; orientation; dimensions; file functions; and non-empty expected layers.
- Maintain negative fixtures for missing or empty inner copper, duplicate or swapped layers, malformed apertures, missing profile, mirrored or offset coordinates, absent drill hits, wrong plating, invalid via spans, stale artifacts, BOM mismatch, placement mismatch, and ambiguous bottom-side rotation.
- Prove that exporter success alone cannot pass fabrication validity.
- Prove that unsupported or independently unverified constructs remain available only for development and block a verified production bundle.
- Prove that failed checks may produce unmistakably marked draft artifacts but never a verified manifest or misleading archive name.
- Capability and artifact-integrity failures are non-waivable. Other waivers require a stable rule ID, narrow object or region scope, and written justification visible in every report and bundle.
- Hash every bundle artifact and manifest input. Verify source digest, lockfile digest, board revision, profiles, waivers, adapter versions, external tool versions, status dimensions, and stale-state detection. Do not imply that an unsigned bundle is signed.

F. Simulation and functional validation

- Every simulation must declare its circuit region, models, stimulus, solver, analysis, units, tolerances, and assertions.
- Test known operating-point, transient, AC, and sweep fixtures against analytical expectations where possible.
- Test timeouts, crashes, non-convergence, singular matrices, malformed models, missing vectors, non-finite results, and unavailable executables.
- Never guess or silently substitute a model. Missing coverage is `incomplete` or `unavailable`, not passed.
- Functional validation remains separate from fabrication validity and blocks a verified bundle only when explicitly required.

G. KiCad handoff

- Generate projects that parse in each declared supported KiCad major version and reconcile components, nets, geometry, traces, vias, holes, outlines, and layer ordering.
- Report exact, approximated, omitted, and unsupported constructs.
- Treat human-edited KiCad output as an independent downstream design. Never claim synchronization or automatic round trip and never overwrite it during ordinary regeneration.
- If KiCad is missing, report an honest unavailable live check and use recorded fixtures only for deterministic adapter tests. Do not install KiCad automatically.

H. Status and release gating

- Serialize fabrication, electrical, functional, standards-evidence, and sourcing statuses independently in terminal text, JSON, browser views, and bundle manifests.
- Prove that a pass in one dimension cannot overwrite, hide, or imply a pass in another.
- Standards profiles must declare source, edition, supported rules, required evidence, assumptions, and known gaps. Say `checked against profile`, never certified or legally compliant.
- Part stock changes affect sourcing status only. Alternatives may be proposed but never selected without an explicit source change and rerun compatibility checks.

I. Server, security, reliability, and platforms

- Bind to loopback by default. Require an explicit `--host` for network exposure and show the security warning.
- Serve only fixed Fulmetry routes. Prove that browser interactions cannot mutate authored source or configuration.
- Test traversal, symlink escapes, malicious filenames and identifiers, unsafe subprocess arguments, hostile model includes, oversized inputs, secret redaction, cross-origin behavior, and atomic output publication.
- Test cancellation, timeouts, concurrent readers, rapid file changes, interrupted writes, and child-process cleanup. No partial or cancelled artifact may be marked valid.
- Run the declared Bun release on Apple Silicon macOS. Treat Linux, Windows, Intel macOS, and Node.js as unsupported until their future qualification work is explicitly adopted.
- Prove through a network-observed default workflow that Fulmetry sends no telemetry or project data.

J. Licensing, attribution, and documentation

- Preserve Fulmetry's MIT License and prominent, accurate tscircuit credit without implying affiliation or endorsement.
- Generate `THIRD_PARTY_NOTICES.md` from the code and asset graph actually included in a distribution.
- Reject missing, unknown, incompatible, or non-redistributable licenses at the applicable packaging boundary.
- Preserve provenance and redistribution status for vendored footprints, models, component data, and other assets.
- Do not relabel user circuit source or ordinary generated manufacturing files as MIT merely because Fulmetry produced them.
- Execute every documented command and example in clean CI. Documentation must describe limitations, status semantics, detached KiCad handoff, trusted-code boundary, default privacy, and non-certification language accurately.

CRITIC RULES

- The implementer cannot be the sole verifier of its work.
- Critics receive the requirement, diff, commands, and artifacts, but must form their own conclusion from evidence rather than inherit the builder's confidence.
- Critics look first for false passes: skipped checks reported as success, stale artifacts presented as current, exporter output trusted without parsing, status dimensions collapsed, unsupported capability treated as warning, or negative fixtures that accidentally pass.
- A test is meaningful only if it observes the promised external behavior and demonstrably fails for the corresponding defect. Snapshot approval alone is insufficient for connectivity, electrical, geometric, simulation, or manufacturing correctness.
- Mock external services only at their actual boundary. Do not mock the unit whose behavior the test claims to verify. Keep deterministic recorded-source tests separate from clearly labeled live compatibility checks.
- If an executable or network source is unavailable, report the limitation. Never fabricate output, silently skip a required gate, or downgrade the requirement.
- Evidence reports must include exact commands, exit status, relevant output, artifact paths, tool versions, fixture identity, and the specific requirement proven or still unproven.

DO NOT

- Do not build a Gauntlet state machine, scoreboard, capture farm, meta-harness, or round ledger. Work on Fulmetry and its real test suite.
- Do not reimplement tscircuit merely to make Fulmetry appear independent.
- Do not add a visual editor, custom project routes, built-in agent runtime, required MCP layer, Node compatibility burden, multi-board model, assembly variants, signing system, stable public plugin API, or automatic external-tool installer unless I explicitly promote that deferred scope.
- Do not weaken a failing test, broaden a tolerance, add a waiver, update a golden file, or mark a feature unsupported merely to make CI green without proving that the requirement changed.
- Do not accept documentation, screenshots, type-checking, or builder confidence as substitutes for runtime and artifact evidence.
- Do not claim complete because one fixture passes. Re-run independent audits, attack the highest-risk assumptions, and keep climbing until I stop you.

Begin by reading the authoritative files, inspecting the repository and tool availability, and reporting one concise Gauntlet status line. Then work. Do not ask whether to continue.
```
