import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTscircuitDependencyLock } from "../src/upgrade/dependency-lock";
import { SUPPORTED_TSCIRCUIT_INTEGRITY, SUPPORTED_TSCIRCUIT_VERSION } from "../src/project/lock";

const PROJECT_ROOT = join(import.meta.dir, "..");
const CANDIDATE = join(PROJECT_ROOT, "node_modules", "tscircuit");
const VERSION = SUPPORTED_TSCIRCUIT_VERSION;
const INTEGRITY = SUPPORTED_TSCIRCUIT_INTEGRITY;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockFixture(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-lock-test-"));
  roots.push(root);
  await mkdir(join(root, "node_modules"));
  await symlink(CANDIDATE, join(root, "node_modules", "tscircuit"), process.platform === "win32" ? "junction" : undefined);
  const lockPath = join(root, "bun.lock");
  await cp(join(PROJECT_ROOT, "bun.lock"), lockPath);
  return { root, lockPath };
}

async function inspect(lockPath: string, candidatePackageRoot = CANDIDATE) {
  return inspectTscircuitDependencyLock({
    lockPath,
    candidatePackageRoot,
    expectedVersion: VERSION,
    expectedIntegrity: INTEGRITY,
  });
}

describe("tscircuit dependency lock authentication", () => {
  test("binds raw lock bytes to the exact direct package", async () => {
    const fixture = await lockFixture();
    const result = await inspect(fixture.lockPath);
    expect(result.lockPath).toBe(await realpath(fixture.lockPath));
    expect(result.dependencyLockSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects missing locks, wrong root pins, and candidates elsewhere under node_modules", async () => {
    const fixture = await lockFixture();
    await expect(inspect(join(fixture.root, "missing", "bun.lock"))).rejects.toThrow();

    const lock = Bun.JSONC.parse(await Bun.file(fixture.lockPath).text()) as any;
    lock.workspaces[""].devDependencies.tscircuit = "999.0.0";
    await writeFile(fixture.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await expect(inspect(fixture.lockPath)).rejects.toThrow("root dev and peer");

    const elsewhere = await lockFixture();
    const other = join(elsewhere.root, "node_modules", "other", "tscircuit");
    await mkdir(other, { recursive: true });
    await expect(inspect(elsewhere.lockPath, other)).rejects.toThrow("direct node_modules/tscircuit");
  });

  test("rejects duplicate JSONC keys and mutation during inspection", async () => {
    const duplicate = await lockFixture();
    const original = await Bun.file(duplicate.lockPath).text();
    await writeFile(duplicate.lockPath, original.replace(
      '"lockfileVersion": 1,',
      '"lockfileVersion": 1,\n  "lockfileVersion": 1,',
    ));
    await expect(inspect(duplicate.lockPath)).rejects.toThrow("duplicate key");

    const mutated = await lockFixture();
    await expect(inspectTscircuitDependencyLock({
      lockPath: mutated.lockPath,
      candidatePackageRoot: CANDIDATE,
      expectedVersion: VERSION,
      expectedIntegrity: INTEGRITY,
      afterInitialRead: async () => {
        await writeFile(mutated.lockPath, `${await Bun.file(mutated.lockPath).text()}\n`);
      },
    })).rejects.toThrow("changed during inspection");
  });

  test("rejects conflicting root declarations and a malformed package tuple marker", async () => {
    const conflicting = await lockFixture();
    const conflictingLock = Bun.JSONC.parse(await Bun.file(conflicting.lockPath).text()) as any;
    conflictingLock.workspaces[""].dependencies = { tscircuit: VERSION };
    await writeFile(conflicting.lockPath, `${JSON.stringify(conflictingLock, null, 2)}\n`);
    await expect(inspect(conflicting.lockPath)).rejects.toThrow("conflicting tscircuit declaration");

    const malformed = await lockFixture();
    const malformedLock = Bun.JSONC.parse(await Bun.file(malformed.lockPath).text()) as any;
    malformedLock.packages.tscircuit[1] = "unexpected";
    await writeFile(malformed.lockPath, `${JSON.stringify(malformedLock, null, 2)}\n`);
    await expect(inspect(malformed.lockPath)).rejects.toThrow("exact packages.tscircuit tuple");
  });
});
