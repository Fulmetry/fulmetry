// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FRESH_PACKAGE_ENTRY_TIMEOUT_MS,
  resolveTscircuitEntryFresh,
} from "../src/internal/fresh-package-entry";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.skipIf(process.platform === "win32")(
  "fresh resolver ignores consumer bunfig preloads",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-safe-resolver-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    const marker = join(root, "preload-ran");
    await mkdir(join(root, "node_modules"));
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(packageRoot, "index.js"), "export default 1;\n");
    await symlink(packageRoot, join(root, "node_modules", "tscircuit"));
    await writeFile(join(root, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed");\n`);
    await writeFile(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');

    expect(await resolveTscircuitEntryFresh(root)).toBe(await realpath(join(packageRoot, "index.js")));
    await expect(access(marker)).rejects.toThrow();
  },
);

test("keeps fresh resolution bounded with headroom for loaded CI hosts", () => {
  expect(FRESH_PACKAGE_ENTRY_TIMEOUT_MS).toBe(15_000);
  expect(FRESH_PACKAGE_ENTRY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
});
