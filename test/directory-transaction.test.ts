import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directoryTreeSha256,
  replaceDirectoriesTransactionally,
} from "../src/upgrade/directory-transaction";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fulmetry-directory-transaction-"));
  roots.push(root);
  const targetA = join(root, "target-a");
  const targetB = join(root, "target-b");
  const transaction = join(root, "transaction");
  const stagedA = join(transaction, "staged", "a");
  const stagedB = join(transaction, "staged", "b");
  await Promise.all([targetA, targetB, stagedA, stagedB].map((path) => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(join(targetA, "value.txt"), "old-a"),
    writeFile(join(targetB, "value.txt"), "old-b"),
    writeFile(join(stagedA, "value.txt"), "new-a"),
    writeFile(join(stagedB, "value.txt"), "new-b"),
  ]);
  return { root, targetA, targetB, transaction, stagedA, stagedB };
}

async function replacement(targetDirectory: string, stagedDirectory: string) {
  return {
    targetDirectory,
    stagedDirectory,
    expectedTargetSha256: await directoryTreeSha256(targetDirectory),
    expectedStagedSha256: await directoryTreeSha256(stagedDirectory),
  };
}

describe("rollback-capable directory publication", () => {
  test("publishes every prepared directory and removes transaction state", async () => {
    const value = await fixture();
    await replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        await replacement(value.targetA, value.stagedA),
        await replacement(value.targetB, value.stagedB),
      ],
    });
    expect(await readFile(join(value.targetA, "value.txt"), "utf8")).toBe("new-a");
    expect(await readFile(join(value.targetB, "value.txt"), "utf8")).toBe("new-b");
    expect(await Bun.file(value.transaction).exists()).toBeFalse();
  });

  test("restores every original when a later publication step fails", async () => {
    const value = await fixture();
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        await replacement(value.targetA, value.stagedA),
        await replacement(value.targetB, value.stagedB),
      ],
      afterBackup: async (index) => {
        if (index === 1) throw new Error("injected publication failure");
      },
    })).rejects.toThrow("injected publication failure");
    expect(await readFile(join(value.targetA, "value.txt"), "utf8")).toBe("old-a");
    expect(await readFile(join(value.targetB, "value.txt"), "utf8")).toBe("old-b");
    expect(await Bun.file(value.transaction).exists()).toBeFalse();
  });

  test("rejects target mutation after preparation and restores it", async () => {
    const value = await fixture();
    const expected = await directoryTreeSha256(value.targetA);
    const expectedStaged = await directoryTreeSha256(value.stagedA);
    await writeFile(join(value.targetA, "value.txt"), "mutated");
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetDirectory: value.targetA,
        stagedDirectory: value.stagedA,
        expectedTargetSha256: expected,
        expectedStagedSha256: expectedStaged,
      }],
    })).rejects.toThrow("changed before publication");
    expect(await readFile(join(value.targetA, "value.txt"), "utf8")).toBe("mutated");
  });

  test("binds empty directory paths into target identity", async () => {
    const value = await fixture();
    const expected = await directoryTreeSha256(value.targetA);
    const expectedStaged = await directoryTreeSha256(value.stagedA);
    await mkdir(join(value.targetA, "new-empty-directory"));
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetDirectory: value.targetA,
        stagedDirectory: value.stagedA,
        expectedTargetSha256: expected,
        expectedStagedSha256: expectedStaged,
      }],
    })).rejects.toThrow("changed before publication");
    expect(await Bun.file(join(value.targetA, "value.txt")).text()).toBe("old-a");
  });

  test("rejects a target inside the transaction tree without deleting it", async () => {
    const value = await fixture();
    const nestedTarget = join(value.transaction, "nested-target");
    await mkdir(nestedTarget);
    await writeFile(join(nestedTarget, "value.txt"), "must-survive");
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetDirectory: nestedTarget,
        stagedDirectory: value.stagedA,
        expectedTargetSha256: await directoryTreeSha256(nestedTarget),
        expectedStagedSha256: await directoryTreeSha256(value.stagedA),
      }],
    })).rejects.toThrow("invalid transaction relationship");
    expect(await readFile(join(nestedTarget, "value.txt"), "utf8")).toBe("must-survive");
  });

  test("retains a reappeared target as conflicted recovery while restoring the backup", async () => {
    const value = await fixture();
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        await replacement(value.targetA, value.stagedA),
        await replacement(value.targetB, value.stagedB),
      ],
      afterBackup: async (index) => {
        if (index !== 1) return;
        await mkdir(value.targetB);
        await writeFile(join(value.targetB, "blocking.txt"), "unexpected");
      },
    })).rejects.toThrow("rollback incomplete or conflicted");
    expect(await readFile(join(value.targetA, "value.txt"), "utf8")).toBe("old-a");
    expect(await readFile(join(value.targetB, "value.txt"), "utf8")).toBe("old-b");
    expect(await readFile(
      join(value.transaction, "rollback-conflicts", "1-target-b", "blocking.txt"),
      "utf8",
    )).toBe("unexpected");
  });

  test("rejects the transaction root itself as staged content", async () => {
    const value = await fixture();
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetDirectory: value.targetA,
        stagedDirectory: value.transaction,
        expectedTargetSha256: await directoryTreeSha256(value.targetA),
        expectedStagedSha256: await directoryTreeSha256(value.transaction),
      }],
    })).rejects.toThrow(/changes path kind|invalid transaction relationship/u);
    expect(await readFile(join(value.targetA, "value.txt"), "utf8")).toBe("old-a");
  });

  test("canonicalizes symlinked ancestors before containment checks", async () => {
    const value = await fixture();
    const nestedTarget = join(value.transaction, "nested-target");
    await mkdir(nestedTarget);
    await writeFile(join(nestedTarget, "value.txt"), "must-survive");
    const alias = join(value.root, "transaction-alias");
    await symlink(
      value.transaction,
      alias,
      process.platform === "win32" ? "junction" : undefined,
    );
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetDirectory: join(alias, "nested-target"),
        stagedDirectory: value.stagedA,
        expectedTargetSha256: await directoryTreeSha256(nestedTarget),
        expectedStagedSha256: await directoryTreeSha256(value.stagedA),
      }],
    })).rejects.toThrow("invalid transaction relationship");
    expect(await readFile(join(nestedTarget, "value.txt"), "utf8")).toBe("must-survive");
  });

  test("rejects staged mutation and restores the original directory", async () => {
    const value = await fixture();
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [await replacement(value.targetA, value.stagedA)],
      afterBackup: async () => {
        await writeFile(join(value.stagedA, "value.txt"), "mutated-staged-directory");
      },
    })).rejects.toThrow("staged content changed during publication");
    expect(await readFile(join(value.targetA, "value.txt"), "utf8")).toBe("old-a");
    expect(await Bun.file(value.transaction).exists()).toBeFalse();
  });

  test("retains a concurrent edit to an earlier published directory", async () => {
    const value = await fixture();
    await expect(replaceDirectoriesTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        await replacement(value.targetA, value.stagedA),
        await replacement(value.targetB, value.stagedB),
      ],
      afterBackup: async (index) => {
        if (index === 1) await writeFile(join(value.targetA, "value.txt"), "concurrent-user-edit");
      },
    })).rejects.toThrow("rollback incomplete or conflicted");
    expect(await readFile(join(value.targetA, "value.txt"), "utf8")).toBe("old-a");
    expect(await readFile(join(value.targetB, "value.txt"), "utf8")).toBe("old-b");
    expect(await readFile(
      join(value.transaction, "rollback-conflicts", "0-target-a", "value.txt"),
      "utf8",
    )).toBe("concurrent-user-edit");
  });
});
