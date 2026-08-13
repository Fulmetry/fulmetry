import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SIMULATION_MODEL_ARTIFACT_BYTES,
  MAX_SIMULATION_MODEL_BYTES,
  parseSimulationDefinition,
  verifySimulationModelAssets,
} from "../src/simulation";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

function raw(digest: string, license = "CC0-1.0") {
  return {
    schemaVersion: 1,
    name: "asset",
    region: { componentIds: ["R1"], netIds: ["VIN", "GND"] },
    models: [{ id: "r", device: { kind: "primitive", name: "resistor" }, bindings: [{ componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "1k" } }], path: "models/r.mod", source: "fixture", digest, license, redistribution: "allowed" }],
    stimuli: [{ kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND", unit: "V", dcValue: 1, ac: null, transient: null }],
    solver: { engine: "ngspice" },
    analysis: { kind: "operating-point" },
    assertions: [{ expression: { kind: "vector", operand: { vector: "v(VIN)", projection: "value", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 1, absoluteTolerance: 0, relativeTolerance: 0 }],
    timeoutMs: 1000,
  };
}

describe("simulation model assets", () => {
  test("binds local model bytes and rejects mutation, symlinks, and unknown licenses", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-model-"));
    roots.push(root);
    await mkdir(join(root, "models"));
    const bytes = ".model R R\n";
    await Bun.write(join(root, "models/r.mod"), bytes);
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    const definition = parseSimulationDefinition(raw(digest));
    expect((await verifySimulationModelAssets({ projectRoot: root, definition }))[0]?.digest).toBe(digest);

    await Bun.write(join(root, "models/r.mod"), ".model R changed\n");
    await expect(verifySimulationModelAssets({ projectRoot: root, definition })).rejects.toThrow("does not match");

    await rm(join(root, "models/r.mod"));
    await Bun.write(join(root, "outside.mod"), bytes);
    await symlink(join(root, "outside.mod"), join(root, "models/r.mod"));
    await expect(verifySimulationModelAssets({ projectRoot: root, definition })).rejects.toThrow("non-symlinked");

    const invalidLicense = parseSimulationDefinition(raw(digest, "made-up-license"));
    await expect(verifySimulationModelAssets({ projectRoot: root, definition: invalidLicense })).rejects.toThrow("unknown license");
  });

  test("rejects recursive file access and ngspice control escapes even when digest-correct", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-hostile-model-"));
    roots.push(root);
    await mkdir(join(root, "models"));
    for (const bytes of [
      ".include ../../.ssh/id_rsa\n.model R R\n",
      ".control\nshell echo compromised\n.endc\n",
      ".pre_osdi /tmp/hostile.so\n",
    ]) {
      await Bun.write(join(root, "models/r.mod"), bytes);
      const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
      const definition = parseSimulationDefinition(raw(digest));
      await expect(verifySimulationModelAssets({ projectRoot: root, definition })).rejects.toThrow("forbidden");
    }
  });

  test("rejects aggregate model-copy amplification before reading model bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-model-aggregate-"));
    roots.push(root);
    await mkdir(join(root, "models"));
    const modelPath = join(root, "models/shared.mod");
    await Bun.write(modelPath, "");
    await truncate(modelPath, Math.floor(MAX_SIMULATION_MODEL_ARTIFACT_BYTES / 5) + 1);
    const attack = raw(`sha256:${"a".repeat(64)}`) as Record<string, unknown>;
    const componentIds = Array.from({ length: 5 }, (_, index) => `R${index}`);
    (attack.region as Record<string, unknown>).componentIds = componentIds;
    attack.models = componentIds.map((componentId, index) => ({
      id: `model_${index}`,
      device: { kind: "primitive", name: "resistor" },
      bindings: [{ componentId, pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "1k" } }],
      path: "models/shared.mod",
      source: "fixture",
      digest: `sha256:${"a".repeat(64)}`,
      license: "CC0-1.0",
      redistribution: "allowed",
    }));
    await expect(verifySimulationModelAssets({
      projectRoot: root,
      definition: parseSimulationDefinition(attack),
    })).rejects.toThrow(`exceed ${MAX_SIMULATION_MODEL_ARTIFACT_BYTES} aggregate bytes`);
  });

  test("rechecks model size through a stable handle after aggregate preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-model-race-"));
    roots.push(root);
    await mkdir(join(root, "models"));
    const modelPath = join(root, "models/r.mod");
    const bytes = ".model R R\n";
    await Bun.write(modelPath, bytes);
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    await expect(verifySimulationModelAssets({
      projectRoot: root,
      definition: parseSimulationDefinition(raw(digest)),
      afterPreflight: () => truncate(modelPath, MAX_SIMULATION_MODEL_BYTES + 1),
    })).rejects.toThrow(`file exceeds ${MAX_SIMULATION_MODEL_BYTES} bytes`);
  });
});
