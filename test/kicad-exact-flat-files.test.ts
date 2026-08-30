import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureExactFlatKicadFiles,
  KICAD_ARTIFACT_FILE_BYTES_LIMIT,
  KICAD_ARTIFACT_TOTAL_BYTES_LIMIT,
} from "../src/kicad/exact-flat-files";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function directoryIdentity(path: string) {
  const entry = await lstat(path);
  return { realpath: await realpath(path), dev: entry.dev, ino: entry.ino };
}

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("exact flat KiCad artifact authority", () => {
  test("captures the exact direct manifest and rejects an unexpected subtree without descending", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-kicad-flat-")); roots.push(root);
    await Bun.write(join(root, "board.kicad_pcb"), "board\n");
    const identity = await directoryIdentity(root);
    const expected = [{ path: "board.kicad_pcb", size: 6, sha256: sha256("board\n") }];
    await expect(captureExactFlatKicadFiles({ root, expected, rootIdentity: identity, label: "KiCad test" }))
      .resolves.toEqual(expected);

    await mkdir(join(root, "unexpected", "deep", "deeper"), { recursive: true });
    for (let index = 0; index < 1_024; index += 1) {
      await mkdir(join(root, "unexpected", `branch-${index}`));
    }
    await expect(captureExactFlatKicadFiles({ root, expected, rootIdentity: identity, label: "KiCad test" }))
      .rejects.toThrow("artifact set mismatch (unexpected: unexpected)");
  });

  test("rejects an oversized sparse replacement and aggregate manifest before payload reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-kicad-flat-limit-")); roots.push(root);
    const path = join(root, "board.kicad_pcb");
    await Bun.write(path, "board\n");
    const identity = await directoryIdentity(root);
    await truncate(path, KICAD_ARTIFACT_FILE_BYTES_LIMIT + 1);
    await expect(captureExactFlatKicadFiles({
      root,
      expected: [{ path: "board.kicad_pcb", size: 6, sha256: sha256("board\n") }],
      rootIdentity: identity,
      label: "KiCad test",
    })).rejects.toThrow(`exceeds ${KICAD_ARTIFACT_FILE_BYTES_LIMIT} bytes`);

    const aggregate = Array.from({ length: 5 }, (_, index) => ({
      path: `artifact-${index}`,
      size: Math.floor(KICAD_ARTIFACT_TOTAL_BYTES_LIMIT / 4),
      sha256: "0".repeat(64),
    }));
    await expect(captureExactFlatKicadFiles({ root, expected: aggregate, rootIdentity: identity, label: "KiCad test" }))
      .rejects.toThrow(`exceeds ${KICAD_ARTIFACT_TOTAL_BYTES_LIMIT} aggregate bytes`);
  });

  test("cannot replace authenticated expectations through Map prototype poisoning", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-kicad-flat-map-")); roots.push(root);
    const path = join(root, "board.kicad_pcb");
    await Bun.write(path, "evil");
    const identity = await directoryIdentity(root);
    const originalGet = Map.prototype.get;
    let error: unknown;
    try {
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (key === "board.kicad_pcb") {
          return { path: "board.kicad_pcb", size: 4, sha256: sha256("evil") };
        }
        return Reflect.apply(originalGet, this, [key]);
      } as typeof Map.prototype.get;
      await captureExactFlatKicadFiles({
        root,
        expected: [{ path: "board.kicad_pcb", size: 4, sha256: sha256("good") }],
        rootIdentity: identity,
        label: "KiCad test",
      });
    } catch (caught) {
      error = caught;
    } finally {
      Map.prototype.get = originalGet;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("bytes changed and no longer match authenticated evidence");
  });
});
