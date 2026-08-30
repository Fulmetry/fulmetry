import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBuildInputSnapshot,
  refreshBuildInputSnapshot,
} from "../src/artifacts/inputs";

const roots: string[] = [];

async function project() {
  const root = await mkdtemp(join(tmpdir(), "fulmetry-inputs-"));
  roots.push(root);
  await mkdir(join(root, "circuits", "démo board"), { recursive: true });
  await Bun.write(join(root, "circuits", "démo board", "board.tsx"), "export const Board = 1\n");
  await Bun.write(join(root, "fulmetry.config.ts"), "export default {}\n");
  await Bun.write(join(root, "fulmetry.lock"), "version = 1\n");
  return root;
}

const descriptors = [
  { path: "circuits/démo board/board.tsx", role: "source" as const },
  { path: "fulmetry.config.ts", role: "config" as const },
  { path: "fulmetry.lock", role: "lockfile" as const },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("build input snapshots", () => {
  test("hashes role-separated inputs deterministically through Unicode paths", async () => {
    const root = await project();
    const first = await createBuildInputSnapshot({ projectRoot: root, inputs: descriptors });
    const second = await createBuildInputSnapshot({
      projectRoot: root,
      inputs: [...descriptors].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.inputs.map(({ role }) => role).sort()).toEqual([
      "config",
      "lockfile",
      "source",
    ]);
  });

  test("detects stale source, config, and lockfile bytes", async () => {
    const root = await project();
    const snapshot = await createBuildInputSnapshot({ projectRoot: root, inputs: descriptors });
    await Bun.write(join(root, "fulmetry.config.ts"), "export default { changed: true }\n");

    const refreshed = await refreshBuildInputSnapshot(root, snapshot);
    expect(refreshed.digest).not.toBe(snapshot.digest);
  });

  test("requires distinct source, config, and lockfile ownership", async () => {
    const root = await project();
    await expect(
      createBuildInputSnapshot({
        projectRoot: root,
        inputs: descriptors.filter(({ role }) => role !== "config"),
      }),
    ).rejects.toThrow("fulmetry.config.ts as its sole config");
    await Bun.write(join(root, "decoy-config.ts"), "export default {}\n");
    await expect(
      createBuildInputSnapshot({
        projectRoot: root,
        inputs: descriptors.map((descriptor) => descriptor.role === "config"
          ? { path: "decoy-config.ts", role: "config" as const }
          : descriptor),
      }),
    ).rejects.toThrow("fulmetry.config.ts as its sole config");
    await Bun.write(join(root, "decoy.lock"), "version = 1\n");
    await expect(
      createBuildInputSnapshot({
        projectRoot: root,
        inputs: descriptors.map((descriptor) => descriptor.role === "lockfile"
          ? { path: "decoy.lock", role: "lockfile" as const }
          : descriptor),
      }),
    ).rejects.toThrow("fulmetry.lock as its sole lockfile");
    await expect(
      createBuildInputSnapshot({
        projectRoot: root,
        inputs: [...descriptors, descriptors[0]!],
      }),
    ).rejects.toThrow("duplicate input descriptors");
  });

  test("rejects path traversal, symlinks, and oversized input", async () => {
    const root = await project();
    const outside = join(root, "outside.tsx");
    await Bun.write(outside, "outside\n");
    await symlink(outside, join(root, "linked.tsx"));

    await expect(
      createBuildInputSnapshot({
        projectRoot: root,
        inputs: [...descriptors.slice(1), { path: "../outside.tsx", role: "source" }],
      }),
    ).rejects.toThrow("contained relative path");
    await expect(
      createBuildInputSnapshot({
        projectRoot: root,
        inputs: [...descriptors.slice(1), { path: "linked.tsx", role: "source" }],
      }),
    ).rejects.toThrow("non-symlink");
    await expect(
      createBuildInputSnapshot({
        projectRoot: root,
        inputs: descriptors,
        maximumInputBytes: 2,
      }),
    ).rejects.toThrow("exceeds 2 bytes");
  });
});
