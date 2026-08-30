# create-fulmetry

Create a Fulmetry project with `bun create fulmetry my-board`.

The generated repository uses normal TypeScript files, Bun tests, a deterministic Fulmetry lockfile, project-local Agent Skills for Codex, Cursor, Claude Code, and compatible agents, and no telemetry. Skills are copied from the same `create-fulmetry` release so they work without a second installer and match the generated framework version. Pass `--no-skills` to omit them.

Existing projects can install the latest public Fulmetry skills separately with `bunx --bun skills@latest add Fulmetry/fulmetry --copy`. The equivalent Node package-runner command is `npx skills@latest add Fulmetry/fulmetry --copy`. Use copy mode because Fulmetry intentionally rejects symlinks inside authoritative project input.

Fulmetry remains experimental; manufacturing output must pass its explicit verification gates before production use.
