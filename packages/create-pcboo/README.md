# create-pcboo

Create a PCBoo project with `bun create pcboo my-board`.

The generated repository uses normal TypeScript files, Bun tests, a deterministic PCBoo lockfile, project-local Agent Skills for Codex, Cursor, Claude Code, and compatible agents, and no telemetry. Skills are copied from the same `create-pcboo` release so they work without a second installer and match the generated framework version. Pass `--no-skills` to omit them.

Existing projects can install the latest public PCBoo skills separately with `bunx --bun skills@latest add pcboo-dev/pcboo --copy`. The equivalent Node package-runner command is `npx skills@latest add pcboo-dev/pcboo --copy`. Use copy mode because PCBoo intentionally rejects symlinks inside authoritative project input.

PCBoo remains experimental; manufacturing output must pass its explicit verification gates before production use.
