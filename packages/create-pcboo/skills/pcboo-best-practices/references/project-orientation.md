# Project orientation

## Authored inputs

- `circuit/**/*.ts`: logical and physical circuit source.
- `pcboo.config.ts`: entry, generated-output location, active profiles, and board revision.
- `pcboo.lock`: accepted tscircuit, adapter, profile, asset, and sourcing identities.
- `tests/**/*.test.ts` or `.test.tsx`: ordinary Bun tests run through PCBoo's bounded test command.
- `simulations/*.testbench.ts`: named simulation definitions.
- `models/` and `vendor/`: intentionally vendored, provenance-sensitive inputs.
- `waivers/*.json`: explicit source-controlled waiver declarations.

Read only relevant modules. Prefer small named circuit modules over one large board file, and keep one composed board as the project root.

## Derived output

`.pcboo/` is disposable command output. Do not hand-edit it or cite a report without checking that its project and source digests match the current tree.

Each finite command creates `.pcboo/runs/<run-id>/report.json`. Use `--json` for stable automation output and use `pcboo inspect` when the terminal result lacks the needed local detail.

## Normal command surface

```sh
bun run build --json
bun run check --json
bun run test --json
bun run inspect -- --status electrical --json
bun run pcboo simulate <name> --json
bun run pcboo export kicad --json
bun run export:gerbers --json
bun run pcboo verify manufacturing --json
```

The generated package scripts cover common commands. Use `bun run pcboo ...` for subcommands without a dedicated script.
