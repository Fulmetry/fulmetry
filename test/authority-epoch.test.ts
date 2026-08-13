import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePathAuthorityEpoch,
  requireUnchangedPathAuthorityEpoch,
} from "../src/upgrade/authority-epoch";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcboo-authority-epoch-"));
  roots.push(root);
  const anchor = join(root, "compatibility.json");
  const implementation = join(root, "src");
  await mkdir(implementation);
  await writeFile(anchor, "accepted\n");
  await writeFile(join(implementation, "verifier.ts"), "export const version = 1\n");
  return { root, anchor, implementation };
}

describe("maintenance path authority epoch", () => {
  test("accepts unchanged regular files and directory trees", async () => {
    const value = await fixture();
    const epoch = await capturePathAuthorityEpoch([value.anchor, value.implementation]);
    await expect(requireUnchangedPathAuthorityEpoch(epoch)).resolves.toBeUndefined();
  });

  test("rejects anchor and nested implementation mutation", async () => {
    const value = await fixture();
    const epoch = await capturePathAuthorityEpoch([value.anchor, value.implementation]);
    await writeFile(value.anchor, "changed\n");
    await expect(requireUnchangedPathAuthorityEpoch(epoch)).rejects.toThrow("authority changed");
    await writeFile(value.anchor, "accepted\n");
    await writeFile(join(value.implementation, "verifier.ts"), "export const version = 2\n");
    await expect(requireUnchangedPathAuthorityEpoch(epoch)).rejects.toThrow("authority changed");
  });

  test("rejects final symlinks instead of following authority elsewhere", async () => {
    const value = await fixture();
    const link = join(value.root, "anchor-link");
    await symlink(value.anchor, link);
    await expect(capturePathAuthorityEpoch([link])).rejects.toThrow("regular file or directory");
  });
});
