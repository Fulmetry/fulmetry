---
name: fulmetry-best-practices
description: Route Fulmetry circuit work through the correct design, diagnosis, verification, and manufacturing procedures. Use for any Fulmetry project task when the right focused skill is unclear, when orienting in a generated project, or when coordinating a multi-step circuit change without weakening evidence or human approval gates.
---

# Fulmetry best practices

Treat the repository as the authoring interface and Fulmetry results as evidence. Fulmetry is not an agent runtime, and a plausible visual result is not proof that a circuit has passed.

Treat a request to create, build, or design a circuit or board as a request for a complete logical and physical design unless the user explicitly limits the deliverable to a schematic, logical topology, or exploratory draft. Never silently downgrade a complete-board request because footprints, models, placement, routing, or verification require more work.

## Orient before editing

1. Read `AGENTS.md`, `fulmetry.config.ts`, `fulmetry.lock`, and `package.json`.
2. Inspect the relevant files under `circuit/`, `tests/`, `simulations/`, `models/`, `vendor/`, and `waivers/` when those directories exist.
3. Check the working tree and preserve changes you did not make.
4. Read [project orientation](references/project-orientation.md) for the source and generated-output boundaries.
5. Read [status semantics](references/status-semantics.md) before interpreting a result.

## Route the task

- Load `fulmetry-design` for circuit architecture, composition, parts, footprints, placement, constraints, or routing.
- Load `fulmetry-diagnose` for a failed command, diagnostic code, unexpected status, or focused repair.
- Load `fulmetry-verify` for connectivity tests, simulations, requirement evidence, or an independent audit.
- Load `fulmetry-manufacturing` for Gerbers, drill, BOM, placement, KiCad handoff, artifact verification, or production-gate questions.
- Load `fulmetry-resolve-models` for online model acquisition, provenance, licensing, CAD binding, bounding-box repair, or any final 3D browser preview.

Load only the focused skill and references needed for the current task.

For an end-to-end board request, keep `fulmetry-design` active through component resolution, placement, routing, physical-completeness inspection, verification, and preview startup. Use the other focused skills when that workflow reaches their evidence boundary.

## Preserve authority

- Edit authored files; never edit `.fulmetry/` output.
- Import Fulmetry authoring primitives from `fulmetry` unless the project intentionally uses the equivalent supported `tscircuit` imports.
- Run `bun run build --json` after circuit-source changes.
- Run the checks that correspond to the claim; never derive one status dimension from another.
- Do not launch the local server as the final handoff until the design skill's completion gate passes. An explicitly requested diagnostic preview of incomplete work must remain visibly labeled incomplete.
- Cite the exact command, exit code or classification, report path, source digest, and unresolved findings.
- Stop for the decisions in [safety and human gates](references/safety-and-human-gates.md).

For delegated work, use the role boundaries in [roles](references/roles.md). Treat them as workflow contracts, not permissions unless the current agent host enforces them.
