// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from "bun:test";
import { cp, link, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectPackedConsumer } from "../src/upgrade/packed-consumer";
import { SUPPORTED_TSCIRCUIT_INTEGRITY } from "../src/project/lock";

const roots: string[] = [];
const repositoryRoot = join(import.meta.dir, "..");

function sri(bytes: Uint8Array): string {
  return `sha512-${Buffer.from(new Bun.CryptoHasher("sha512").update(bytes).digest()).toString("base64")}`;
}

async function fixture(): Promise<Readonly<{ root: string; lock: Record<string, unknown> }>> {
  const authority = await mkdtemp(join(tmpdir(), "pcboo-packed-consumer-test-"));
  roots.push(authority);
  const root = join(authority, "harness", "board");
  const packages = join(authority, "packages");
  const pcbooRoot = join(root, "node_modules", "pcboo");
  const tscircuitRoot = join(root, "node_modules", "tscircuit");
  const cliRoot = join(root, "node_modules", "@tscircuit", "cli");
  await mkdir(join(pcbooRoot, "src"), { recursive: true });
  await mkdir(tscircuitRoot, { recursive: true });
  await mkdir(cliRoot, { recursive: true });
  await mkdir(packages);
  const pcbooPackage = {
    name: "pcboo", version: "0.0.0", type: "module", main: "src/index.ts",
    peerDependencies: { tscircuit: "0.0.2261" },
    os: ["darwin"], cpu: ["arm64"],
  };
  const tscircuitPackage = { name: "tscircuit", version: "0.0.2261", type: "module", main: "index.js" };
  const cliPackage = {
    name: "@tscircuit/cli", version: "0.1.1858",
    peerDependencies: { "circuit-json": "^0.0.464", tscircuit: "*" },
    bin: { "tscircuit-cli": "./cli/entrypoint.js" },
  };
  const pcbooFiles = {
    "package/package.json": `${JSON.stringify(pcbooPackage)}\n`,
    "package/src/index.ts": "export const pcboo = true;\n",
  };
  await writeFile(join(pcbooRoot, "package.json"), pcbooFiles["package/package.json"]);
  await writeFile(join(pcbooRoot, "src", "index.ts"), pcbooFiles["package/src/index.ts"]);
  await writeFile(join(tscircuitRoot, "package.json"), `${JSON.stringify(tscircuitPackage)}\n`);
  await writeFile(join(tscircuitRoot, "index.js"), "export default 1;\n");
  await writeFile(join(cliRoot, "package.json"), `${JSON.stringify(cliPackage)}\n`);
  const archive = new Bun.Archive(pcbooFiles, { compress: "gzip" });
  const tarball = join(packages, "pcboo-0.0.0.tgz");
  const tarballBytes = await archive.bytes();
  await writeFile(tarball, tarballBytes);
  const manifest = {
    name: "board", version: "0.0.0", private: true, type: "module", packageManager: "bun@1.3.14",
    engines: { bun: "1.3.14" },
    scripts: {
      build: "pcboo build", check: "pcboo check", inspect: "pcboo inspect", dev: "pcboo dev",
      test: "pcboo test", "export:gerbers": "pcboo export gerbers",
    },
    dependencies: { pcboo: "file:../../packages/pcboo-0.0.0.tgz", tscircuit: "0.0.2261" },
    devDependencies: { "@types/bun": "1.3.14" },
    overrides: { "@tscircuit/cli": "0.1.1858", "bun-match-svg": "0.0.15" },
  };
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(repositoryRoot, "test", "fixtures", "canonical", "led-2layer", "pcboo.lock"), join(root, "pcboo.lock"));
  const lock: Record<string, unknown> = {
    lockfileVersion: 1,
    configVersion: 1,
    overrides: { "@tscircuit/cli": "0.1.1858", "bun-match-svg": "0.0.15" },
    workspaces: { "": { name: "board", dependencies: manifest.dependencies, devDependencies: manifest.devDependencies } },
    packages: {
      pcboo: ["pcboo@../../packages/pcboo-0.0.0.tgz", { peerDependencies: { tscircuit: "0.0.2261" } }, sri(tarballBytes)],
      tscircuit: ["tscircuit@0.0.2261", "", {}, SUPPORTED_TSCIRCUIT_INTEGRITY],
      "@tscircuit/cli": ["@tscircuit/cli@0.1.1858", "", {
        peerDependencies: { "circuit-json": "^0.0.464", tscircuit: "*" },
        bin: { "tscircuit-cli": "cli/entrypoint.js" },
      }, "sha512-FPrP/p1BqGHTOKXiKHv1CCe95jE2fuOKLBjA52GdrlWy9QB9VMY8rgjr8JHj8OjU2R3WzX7rWQ//+NO2qsisoA=="],
    },
  };
  await writeFile(join(root, "bun.lock"), `${JSON.stringify(lock, null, 2)}\n`);
  return Object.freeze({ root, lock });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const inspect = (root: string, afterInitialRead?: () => Promise<void>) => inspectPackedConsumer({
  root,
  repositoryRoot,
  expectedVersion: "0.0.2261",
  expectedIntegrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
  expectedPcbooVersion: "0.0.0",
  ...(afterInitialRead === undefined ? {} : { afterInitialRead }),
});

test("authenticates a minimal physical packed consumer and its tarball", async () => {
  const value = await fixture();
  const descriptor = await inspect(value.root);
  expect(descriptor.runtimeClosureSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(descriptor.packedPcbooContentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(descriptor.pcbooTarballIntegrity).toMatch(/^sha512-/);
});

test("rejects extra lock authority, malformed tuples, and secondary engine aliases", async () => {
  for (const mutation of [
    (lock: any) => { lock.extra = true; },
    (lock: any) => { lock.packages.tscircuit[2] = null; },
    (lock: any) => { lock.packages.alias = ["npm:tscircuit@0.0.2261", "", {}, SUPPORTED_TSCIRCUIT_INTEGRITY]; },
  ]) {
    const value = await fixture();
    mutation(value.lock);
    await writeFile(join(value.root, "bun.lock"), `${JSON.stringify(value.lock)}\n`);
    await expect(inspect(value.root)).rejects.toThrow(/unexpected fields|exact tscircuit tuple|another PCBoo or tscircuit/);
  }
});

test("rejects a missing, wrong-version, or wrong-integrity qualified CLI tuple", async () => {
  for (const mutation of [
    (lock: any) => { delete lock.packages["@tscircuit/cli"]; },
    (lock: any) => { lock.packages["@tscircuit/cli"][0] = "@tscircuit/cli@0.1.1908"; },
    (lock: any) => { lock.packages["@tscircuit/cli"][3] = SUPPORTED_TSCIRCUIT_INTEGRITY; },
  ]) {
    const value = await fixture();
    mutation(value.lock);
    await writeFile(join(value.root, "bun.lock"), `${JSON.stringify(value.lock)}\n`);
    await expect(inspect(value.root)).rejects.toThrow("qualified tscircuit CLI tuple");
  }
});

test("rejects changed scaffold dependency overrides in the manifest or lock", async () => {
  const manifestChanged = await fixture();
  const manifest = await Bun.file(join(manifestChanged.root, "package.json")).json();
  manifest.overrides["bun-match-svg"] = "0.0.16";
  await writeFile(join(manifestChanged.root, "package.json"), `${JSON.stringify(manifest)}\n`);
  await expect(inspect(manifestChanged.root)).rejects.toThrow("dependency overrides are not qualified");

  const lockChanged = await fixture();
  (lockChanged.lock.overrides as Record<string, string>)["bun-match-svg"] = "0.0.16";
  await writeFile(join(lockChanged.root, "bun.lock"), `${JSON.stringify(lockChanged.lock)}\n`);
  await expect(inspect(lockChanged.root)).rejects.toThrow("lock overrides are not qualified");
});

test("rejects a symlinked tscircuit CLI package slot", async () => {
  const value = await fixture();
  const slot = join(value.root, "node_modules", "@tscircuit", "cli");
  await rename(slot, `${slot}-store`);
  await symlink(`${slot}-store`, slot, "dir");
  await expect(inspect(value.root)).rejects.toThrow("physical scope and package directories");
});

test("authenticates platform selectors from the tarball even though Bun omits them from its local-tarball tuple", async () => {
  const value = await fixture();
  const tuple = (value.lock.packages as any).pcboo;
  tuple[1].os = ["darwin"];
  await writeFile(join(value.root, "bun.lock"), `${JSON.stringify(value.lock)}\n`);
  await expect(inspect(value.root)).rejects.toThrow("lock metadata differs");
});

test("rejects package files hard-linked to repository authority", async () => {
  const value = await fixture();
  const installed = join(value.root, "node_modules", "pcboo", "src", "index.ts");
  await rm(installed);
  await link(join(repositoryRoot, "src", "index.ts"), installed);
  await expect(inspect(value.root)).rejects.toThrow("shares a hard-linked file");
});

test("rejects any hard link shared with an explicit candidate profile, regardless of relative path", async () => {
  const value = await fixture();
  const candidate = join((await mkdtemp(join(tmpdir(), "pcboo-packed-candidate-"))), "tscircuit");
  roots.push(dirname(candidate));
  await mkdir(candidate);
  await link(
    join(value.root, "node_modules", "tscircuit", "index.js"),
    join(candidate, "different-name.js"),
  );
  await writeFile(join(candidate, "package.json"), JSON.stringify({ name: "tscircuit", version: "0.0.2261" }));
  await expect(inspectPackedConsumer({
    root: value.root,
    repositoryRoot,
    expectedVersion: "0.0.2261",
    expectedIntegrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
    expectedPcbooVersion: "0.0.0",
    independentTscircuitRoots: [candidate],
  })).rejects.toThrow("shares a hard-linked file");
});

test("rejects linked direct packages and an engine split beneath packed PCBoo", async () => {
  const linked = await fixture();
  const pcboo = join(linked.root, "node_modules", "pcboo");
  await rename(pcboo, `${pcboo}-store`);
  await symlink(`${pcboo}-store`, pcboo, "dir");
  await expect(inspect(linked.root)).rejects.toThrow("physical directory");

  const split = await fixture();
  const nested = join(split.root, "node_modules", "pcboo", "node_modules", "tscircuit");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "package.json"), JSON.stringify({ name: "tscircuit", version: "0.0.2261", main: "index.js" }));
  await writeFile(join(nested, "index.js"), "export default 2;\n");
  await expect(inspect(split.root)).rejects.toThrow("resolve different tscircuit engines");
});

test("rejects oversized metadata before reading and byte-identical directory replacement", async () => {
  const oversized = await fixture();
  await truncate(join(oversized.root, "package.json"), 1024 * 1024 + 1);
  await expect(inspect(oversized.root)).rejects.toThrow("no larger than 1048576 bytes");

  const raced = await fixture();
  const pcboo = join(raced.root, "node_modules", "pcboo");
  await expect(inspect(raced.root, async () => {
    const replacement = `${pcboo}-replacement`;
    await cp(pcboo, replacement, { recursive: true });
    await rm(pcboo, { recursive: true });
    await rename(replacement, pcboo);
  })).rejects.toThrow("authority changed during inspection");
});
