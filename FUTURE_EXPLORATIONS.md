# PCBoo Future Explorations

This document records promising ideas that are intentionally outside PCBoo's current product requirements. Entries here are subjects for later evaluation, not committed features or roadmap promises.

## Linux, Windows, and Intel macOS support

The initial release supports Apple Silicon macOS only. Future platform work may add Linux, Windows, and Intel macOS after each target independently passes the full command, package, privacy, ngspice, filesystem, cancellation, and runtime-closure qualification suites. A multi-platform tscircuit upgrade must collect one canonical raw evidence record per supported target, bind every record to the same baseline, candidate, Bun version, semantic review, and fingerprint implementation, and accept all runtime closures atomically. Platform expansion must not weaken fail-closed behavior or infer one platform's runtime closure from another platform's package installation.

## Restricted project evaluator

Evaluate whether verified and production commands should execute authoring modules in an operating-system sandbox or capability-restricted worker. The current release binds every regular in-project file and statically rejects known ambient runtime-I/O and evaluator escape hatches, but trusted executable TypeScript is not a security sandbox. A restricted evaluator is the durable way to exclude external filesystem, environment, process, and network inputs from production evidence.

## CLI-to-promotion candidate workflow

Unify `export gerbers`, `verify manufacturing`, and production promotion around one canonical artifact-root layout, then add a typed adapter (and eventually a CLI command) that converts a completed verification run into a promotion candidate without inferring board revision, required statuses, or waivers. Until that exists, the promotion library requires explicit caller-supplied authority and should not be presented as a seamless CLI workflow.

## Multi-board products with Bun workspaces

PCBoo initially supports exactly one board target per project. This keeps commands, diagnostics, artifacts, verification status, and agent context unambiguous.

A future version may use Bun workspaces to compose several independent PCBoo projects into one physical product while allowing them to share TypeScript circuit components, footprints, models, rule profiles, and other libraries.

An illustrative workspace could look like this:

```text
device/
├── packages/shared-circuits/
├── main-board/
├── power-board/
└── test-fixture/
```

The evaluation should determine:

- Whether ordinary Bun workspace conventions are sufficient or PCBoo needs additional workspace metadata.
- Whether every board keeps its own `pcboo.lock`, configuration, verification status, and release bundle.
- How shared components and assets preserve versioning, provenance, and license information.
- Whether PCBoo should eventually provide aggregate commands and a product-level inspection view.
- How artifacts are named and isolated so output from one board cannot be mistaken for another.
- Whether cross-board connector, cable, harness, power-budget, and interface checks belong in PCBoo.
- How failures in one board affect product-level status without obscuring each board's independent status.

Assembly variants, panelization, and revision-management systems must be evaluated separately. They should not be modeled as additional boards merely to reuse a multi-board mechanism. This does not change the current requirement that every verified bundle carry an explicit board revision identifier.

## Named assembly variants

The initial project model has one deterministic assembly. A future evaluation may consider named population variants that share board geometry while changing fitted or do-not-fit components and producing distinct BOM and pick-and-place artifacts. Any design must keep each variant's digest, verification statuses, sourcing state, and release bundle impossible to confuse with another variant.

## Token-efficient agent result formats

Compact compiler-style text is the initial agent interface and versioned JSON is the canonical detailed result. Token-Oriented Object Notation (TOON), ONTO, and other emerging serializations may be benchmarked against representative PCBoo reports. Evaluation must measure token count, cross-model comprehension, exact round-trip fidelity, parser maturity, schema evolution, error recovery, and the context required to teach an agent the format. No new serialization should displace JSON merely because it is smaller on one fixture.

## Strong execution isolation

PCBoo initially treats a project as trusted executable TypeScript and uses sanitized inputs plus repeated fresh-process builds to detect ordinary nondeterminism. Containers or operating-system sandboxes may later provide an explicit high-isolation mode. Evaluation must account for macOS, Linux, and Windows behavior, Bun compatibility, filesystem access, network blocking, external EDA tools, performance, and the difference between reproducibility and protection from malicious code.

## Reparented-process containment

For trusted executable operation, PCBoo denies direct child creation and parent signaling on macOS, requires delegated cgroup-v2 kill membership on Linux, and uses kill-on-close Job membership with an exclusive broker result handle on Windows. These operational boundaries are not hostile-code sandboxes: LaunchServices/XPC brokerage, Mach task controls, same-token broker attacks, and deliberate migration from delegated membership remain outside their guarantee. Evaluate a deny-default native-qualified macOS broker, a narrowly mounted PID/user namespace broker on Linux, and a restricted-token or AppContainer broker on Windows, with native brokered-launch, parent-signal, membership-escape, handle-duplication, and double-fork regressions.

The maintainer-only tscircuit review/acceptance transaction is stricter than ordinary trusted executable operation: it currently refuses candidate launch on macOS and undelegated Linux because a candidate-supplied external executable can double-fork and escape Bun/process-group tracking. A future macOS implementation may enable this transaction only after a native broker proves kernel-owned membership, cleanup after parent exit, and an empty scope against external double-fork plus `setsid()` fixtures. It must not restore macOS availability by downgrading the claim to polling, ancestry sampling, inherited environment markers, or Bun-only child tracking.

Repository CI supervision is a separate operational boundary. Its POSIX process-group, sampled-ancestry, Bun `--no-orphans`, and inherited-token checks catch cooperative and observable descendants but cannot prove ownership of a daemon that both escapes before sampling and sanitizes its environment. Evaluate kernel-owned CI membership (delegated cgroup v2/systemd scopes on Linux and a qualified macOS equivalent); only that mode may restore an unconditional orphan-rejection requirement.

Windows Job Objects remain useful operational cleanup boundaries for the trusted executables PCBoo runs today but are not security boundaries for a hostile same-token target. A future hostile-code or high-isolation mode requires a restricted-token or AppContainer broker with narrowly granted read/write paths and native adversarial handle-duplication and parent-termination regressions.

## Cryptographic release signing

Initial verified bundles are content-addressed but unsigned. A future signing design may add signatures over the immutable bundle manifest without changing artifact semantics. The evaluation must cover local developer keys, hardware-backed keys, CI identities, key rotation, revocation, verification UX, and provenance standards while keeping signing distinct from electrical correctness or regulatory certification.

## Stable third-party adapter API

Initial integration contracts are modular and capability-declared but experimental. A stable public adapter API may be defined after first-party tscircuit, simulation, KiCad, independent manufacturing-validation, viewer, supplier, and standards-profile integrations demonstrate which concepts are genuinely shared. Stability must not freeze accidental implementation details or allow an adapter to claim capabilities it cannot prove with conformance fixtures.

## Managed external-tool installation

PCBoo initially detects separately installed tools and provides guidance. A future explicit installer may be evaluated for selected external executables. Any such feature must verify source provenance, versions, platform compatibility, checksums or signatures, license obligations, user consent, update behavior, and removal without silently downloading executables during ordinary builds.

## Incremental inspection-server input authority

The initial inspection server deliberately revalidates two stable project-input generations before a ready response. This closes false-ready races when a file is created or changed while the server is hashing inputs, including changes that an operating-system watcher does not report. Independent QA measured approximately 47–109 ms of request overhead on a synthetic 32 MiB, 256-file project.

A future optimization may cache or incrementally maintain input authority only if it preserves the same fail-closed guarantee. Evaluation should include watcher loss, pre-existing empty directories, file creation during hashing, in-place mutation, rename and symlink replacement, output-directory exclusions, rapid supersession, watcher overflow, and platform behavior on macOS, Linux, and Windows. A faster implementation must never return `state: ready` with a digest from an older observable project generation.

## Deterministic mid-read filesystem race harness

Stable project and manufacturing reads compare descriptor identity, size, modification and change times, byte count, lexical path resolution, and the final directory inventory. Checked-in tests cover mutations before and after snapshots plus root, file, and intermediate-directory symlink substitution. A future filesystem test adapter may add deterministic hooks inside the descriptor read window so inode replacement, in-place writes, parent-directory replacement, and truncation can be replayed at exact byte offsets on macOS, Linux, and Windows without adding production hooks or timing-dependent tests.

## Lower-peak TypeScript qualification

The current whole-repository `bunx tsc --noEmit` gate was observed at approximately 1.24 GiB peak resident memory on the macOS development fixture, despite completing successfully. Future test-orchestration work should evaluate sequential source, script, and test compiler projects or TypeScript project references that lower peak memory without omitting cross-surface type errors. Any replacement must prove that it covers the same files and compiler options, remains deterministic on macOS, Linux, and Windows, and fails controlled type defects in every partition. Compiler, packed-package, production-promotion, dense-parser, and maximum-artifact gates should remain separate serial processes with recorded peak RSS rather than being co-resident in one worker.
