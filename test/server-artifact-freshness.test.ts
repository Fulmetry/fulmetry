import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureServerArtifactAuthority,
  verifyServerArtifactAuthority,
} from "../src/server/artifact-freshness";
import type { ArtifactReference } from "../src/result";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function digest(bytes: string, prefix = false): string {
  const value = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return prefix ? `sha256:${value}` : value;
}

async function fixture(): Promise<{
  projectRoot: string;
  runDirectory: string;
  references: readonly ArtifactReference[];
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "pcboo-server-artifacts-"));
  roots.push(projectRoot);
  const runDirectory = join(projectRoot, ".pcboo/runs/action");
  await mkdir(join(runDirectory, "nested"), { recursive: true });
  await Bun.write(join(runDirectory, "circuit.json"), "[]\n");
  await Bun.write(join(runDirectory, "nested/command-error.txt"), "failure\n");
  return {
    projectRoot,
    runDirectory,
    references: Object.freeze([
      Object.freeze({ kind: "circuit-json", path: ".pcboo/runs/action/circuit.json", digest: digest("[]\n") }),
      Object.freeze({ kind: "command-error", path: ".pcboo/runs/action/nested/command-error.txt", digest: digest("failure\n", true) }),
    ]),
  };
}

describe("server artifact freshness authority", () => {
  test("accepts bare and single-prefix SHA-256 references, including command-error evidence", async () => {
    const value = await fixture();
    const authority = await captureServerArtifactAuthority({ ...value, artifacts: value.references });
    await expect(verifyServerArtifactAuthority(authority, value.references)).resolves.toBeUndefined();
  });

  test("rejects missing, malformed, and double-prefix digests", async () => {
    const value = await fixture();
    for (const bad of [undefined, "abc", `sha256:sha256:${"a".repeat(64)}`, "A".repeat(64)]) {
      const { digest: _digest, ...referenceWithoutDigest } = value.references[0]!;
      const references: ArtifactReference[] = [bad === undefined
        ? referenceWithoutDigest
        : { ...referenceWithoutDigest, digest: bad }];
      await expect(captureServerArtifactAuthority({ ...value, artifacts: references }))
        .rejects.toThrow("requires a lowercase SHA-256 digest");
    }
  });

  test("rejects traversal, symlinks, non-regular entries, and added references", async () => {
    const value = await fixture();
    await expect(captureServerArtifactAuthority({
      ...value,
      artifacts: [{ kind: "escape", path: "../outside", digest: digest("outside") }],
    })).rejects.toThrow(/unsafe|outside/);

    if (process.platform !== "win32") {
      await symlink("circuit.json", join(value.runDirectory, "linked.json"));
      await expect(captureServerArtifactAuthority({
        ...value,
        artifacts: [{ kind: "linked", path: ".pcboo/runs/action/linked.json", digest: digest("[]\n") }],
      })).rejects.toThrow(/non-symlink|opened/);
    }

    await mkdir(join(value.runDirectory, "directory-artifact"));
    await expect(captureServerArtifactAuthority({
      ...value,
      artifacts: [{ kind: "directory", path: ".pcboo/runs/action/directory-artifact", digest: digest("") }],
    })).rejects.toThrow(/regular|opened/);

    const authority = await captureServerArtifactAuthority({ ...value, artifacts: value.references });
    await Bun.write(join(value.runDirectory, "extra.txt"), "extra\n");
    const extra = { kind: "extra", path: ".pcboo/runs/action/extra.txt", digest: digest("extra\n") };
    await expect(verifyServerArtifactAuthority(authority, [...value.references, extra]))
      .rejects.toThrow("reference set changed");
  });

  test("rejects byte and same-byte identity replacement after capture", async () => {
    for (const replacement of ["changed\n", "[]\n"]) {
      const value = await fixture();
      const authority = await captureServerArtifactAuthority({ ...value, artifacts: value.references });
      const path = join(value.runDirectory, "circuit.json");
      await rm(path);
      await Bun.write(path, replacement);
      await expect(verifyServerArtifactAuthority(authority, value.references)).rejects.toThrow(/stale|digest|identity/i);
    }
  });
});
