import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSimulationDirectoryIdentity,
  SIMULATION_ARTIFACT_FILE_BYTES_LIMIT,
  SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT,
  verifyExactSimulationArtifacts,
} from "../src/simulation/exact-output";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("exact simulation output authority", () => {
  test("captures the exact root/models tree and rejects an unexpected broad subtree without entering it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-simulation-output-")); roots.push(root);
    await mkdir(join(root, "models"));
    await Bun.write(join(root, "input.cir"), "deck\n");
    await Bun.write(join(root, "models", "r.model"), "model\n");
    const identity = await captureSimulationDirectoryIdentity(root);
    const expected = [
      { path: "input.cir", size: 5, sha256: sha256("deck\n") },
      { path: "models/r.model", size: 6, sha256: sha256("model\n") },
    ];
    await expect(verifyExactSimulationArtifacts({ rootIdentity: identity, expected })).resolves.toBeUndefined();
    await expect(verifyExactSimulationArtifacts({
      rootIdentity: identity,
      expected,
      beforeFinalRevalidation: async () => {
        await Bun.write(join(root, "input.cir"), "evil\n");
      },
    })).rejects.toThrow(/input\.cir.*(bytes changed|changed after initial capture)/);
    await Bun.write(join(root, "input.cir"), "deck\n");
    await expect(verifyExactSimulationArtifacts({
      rootIdentity: identity,
      expected,
      beforeFinalRevalidation: async () => {
        await Bun.write(join(root, "late-extra"), "unexpected\n");
      },
    })).rejects.toThrow("artifact set mismatch (unexpected: late-extra)");
    await rm(join(root, "late-extra"));
    let firstFinalPath: string | undefined;
    await expect(verifyExactSimulationArtifacts({
      rootIdentity: identity,
      expected,
      beforeFileCapture: async (phase, path) => {
        if (phase !== "final") return;
        if (firstFinalPath === undefined) {
          firstFinalPath = path;
          return;
        }
        const replacement = firstFinalPath === "input.cir" ? "evil\n" : "evil!\n";
        await Bun.write(join(root, ...firstFinalPath.split("/")), replacement);
      },
    })).rejects.toThrow(/changed after (initial|final) capture/);
    await Bun.write(join(root, "input.cir"), "deck\n");
    await Bun.write(join(root, "models", "r.model"), "model\n");

    await mkdir(join(root, "unexpected", "deep"), { recursive: true });
    for (let index = 0; index < 1_024; index += 1) await mkdir(join(root, "unexpected", `branch-${index}`));
    await expect(verifyExactSimulationArtifacts({ rootIdentity: identity, expected }))
      .rejects.toThrow("artifact set mismatch (unexpected: unexpected)");
  });

  test("rejects oversized sparse files and a same-path replacement root", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-simulation-limit-")); roots.push(root);
    const path = join(root, "result.raw");
    await Bun.write(path, "raw\n");
    const identity = await captureSimulationDirectoryIdentity(root);
    const expected = [{ path: "result.raw", size: 4, sha256: sha256("raw\n") }];
    await truncate(path, SIMULATION_ARTIFACT_FILE_BYTES_LIMIT + 1);
    await expect(verifyExactSimulationArtifacts({ rootIdentity: identity, expected }))
      .rejects.toThrow(`exceeds ${SIMULATION_ARTIFACT_FILE_BYTES_LIMIT} bytes`);

    const aggregate = Array.from({ length: 5 }, (_, index) => ({
      path: `artifact-${index}`,
      size: Math.floor(SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT / 4),
      sha256: "0".repeat(64),
    }));
    await expect(verifyExactSimulationArtifacts({ rootIdentity: identity, expected: aggregate }))
      .rejects.toThrow(`exceed ${SIMULATION_ARTIFACT_TOTAL_BYTES_LIMIT} aggregate bytes`);

    const moved = `${root}-moved`; roots.push(moved);
    await rename(root, moved);
    await mkdir(root);
    await Bun.write(join(root, "result.raw"), "raw\n");
    await expect(verifyExactSimulationArtifacts({ rootIdentity: identity, expected }))
      .rejects.toThrow("root identity changed");
  });

  test("does not accept changed bytes through Map prototype poisoning", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-simulation-map-")); roots.push(root);
    await Bun.write(join(root, "result.raw"), "evil");
    const identity = await captureSimulationDirectoryIdentity(root);
    const originalGet = Map.prototype.get;
    let error: unknown;
    try {
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (key === "result.raw") return { path: "result.raw", size: 4, sha256: sha256("evil") };
        return Reflect.apply(originalGet, this, [key]);
      } as typeof Map.prototype.get;
      await verifyExactSimulationArtifacts({
        rootIdentity: identity,
        expected: [{ path: "result.raw", size: 4, sha256: sha256("good") }],
      });
    } catch (caught) {
      error = caught;
    } finally {
      Map.prototype.get = originalGet;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("bytes changed");
  });
});
