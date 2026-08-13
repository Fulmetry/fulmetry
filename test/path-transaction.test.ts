import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathTreeSha256, replacePathsTransactionally } from "../src/upgrade/path-transaction";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcboo-path-transaction-"));
  roots.push(root);
  const transaction = join(root, "transaction");
  await mkdir(join(transaction, "staged"), { recursive: true });
  const targetA = join(root, "a.txt");
  const targetB = join(root, "b.txt");
  const stagedA = join(transaction, "staged", "a.txt");
  const stagedB = join(transaction, "staged", "b.txt");
  await Promise.all([
    writeFile(targetA, "old-a"), writeFile(targetB, "old-b"),
    writeFile(stagedA, "new-a"), writeFile(stagedB, "new-b"),
  ]);
  return { root, transaction, targetA, targetB, stagedA, stagedB };
}

describe("rollback-capable file and directory publication", () => {
  test("publishes the complete prepared file set", async () => {
    const value = await fixture();
    await replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        {
          targetPath: value.targetA, stagedPath: value.stagedA,
          expectedTargetSha256: await pathTreeSha256(value.targetA),
          expectedStagedSha256: await pathTreeSha256(value.stagedA),
        },
        {
          targetPath: value.targetB, stagedPath: value.stagedB,
          expectedTargetSha256: await pathTreeSha256(value.targetB),
          expectedStagedSha256: await pathTreeSha256(value.stagedB),
        },
      ],
    });
    expect(await readFile(value.targetA, "utf8")).toBe("new-a");
    expect(await readFile(value.targetB, "utf8")).toBe("new-b");
  });

  test("publishes fixed files and rolls all of them back on a partial failure", async () => {
    const value = await fixture();
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        {
          targetPath: value.targetA, stagedPath: value.stagedA,
          expectedTargetSha256: await pathTreeSha256(value.targetA),
          expectedStagedSha256: await pathTreeSha256(value.stagedA),
        },
        {
          targetPath: value.targetB, stagedPath: value.stagedB,
          expectedTargetSha256: await pathTreeSha256(value.targetB),
          expectedStagedSha256: await pathTreeSha256(value.stagedB),
        },
      ],
      afterBackup: async (index) => { if (index === 1) throw new Error("injected failure"); },
    })).rejects.toThrow("injected failure");
    expect(await readFile(value.targetA, "utf8")).toBe("old-a");
    expect(await readFile(value.targetB, "utf8")).toBe("old-b");
    expect(await Bun.file(value.transaction).exists()).toBeFalse();
  });

  test("rejects final symlinks and the transaction root as staged content", async () => {
    const value = await fixture();
    const link = join(value.root, "target-link");
    await symlink(value.targetA, link);
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetPath: link, stagedPath: value.stagedA,
        expectedTargetSha256: await pathTreeSha256(value.targetA),
        expectedStagedSha256: await pathTreeSha256(value.stagedA),
      }],
    })).rejects.toThrow("must not be a symlink");
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetPath: value.targetA, stagedPath: value.transaction,
        expectedTargetSha256: await pathTreeSha256(value.targetA),
        expectedStagedSha256: await pathTreeSha256(value.transaction),
      }],
    })).rejects.toThrow(/changes path kind|invalid transaction relationship/u);
  });

  test("rejects staged-byte mutation during publication and restores the original", async () => {
    const value = await fixture();
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetPath: value.targetA,
        stagedPath: value.stagedA,
        expectedTargetSha256: await pathTreeSha256(value.targetA),
        expectedStagedSha256: await pathTreeSha256(value.stagedA),
      }],
      afterBackup: async () => { await writeFile(value.stagedA, "mutated-after-validation"); },
    })).rejects.toThrow("staged content changed during publication");
    expect(await readFile(value.targetA, "utf8")).toBe("old-a");
    expect(await Bun.file(value.transaction).exists()).toBeFalse();
  });

  test("rechecks every published target after later replacements and rolls back mutation", async () => {
    const value = await fixture();
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        {
          targetPath: value.targetA, stagedPath: value.stagedA,
          expectedTargetSha256: await pathTreeSha256(value.targetA),
          expectedStagedSha256: await pathTreeSha256(value.stagedA),
        },
        {
          targetPath: value.targetB, stagedPath: value.stagedB,
          expectedTargetSha256: await pathTreeSha256(value.targetB),
          expectedStagedSha256: await pathTreeSha256(value.stagedB),
        },
      ],
      afterBackup: async (index) => {
        if (index === 1) await writeFile(value.targetA, "mutated-after-earlier-publication");
      },
    })).rejects.toThrow("rollback incomplete or conflicted");
    expect(await readFile(value.targetA, "utf8")).toBe("old-a");
    expect(await readFile(value.targetB, "utf8")).toBe("old-b");
    expect(await readFile(join(value.transaction, "rollback-conflicts", "0-a.txt"), "utf8"))
      .toBe("mutated-after-earlier-publication");
  });

  test("retains a concurrent edit when a later replacement fails", async () => {
    const value = await fixture();
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        {
          targetPath: value.targetA, stagedPath: value.stagedA,
          expectedTargetSha256: await pathTreeSha256(value.targetA),
          expectedStagedSha256: await pathTreeSha256(value.stagedA),
        },
        {
          targetPath: value.targetB, stagedPath: value.stagedB,
          expectedTargetSha256: await pathTreeSha256(value.targetB),
          expectedStagedSha256: await pathTreeSha256(value.stagedB),
        },
      ],
      afterBackup: async (index) => {
        if (index === 1) {
          await writeFile(value.targetA, "concurrent-user-edit");
          throw new Error("later publication failure");
        }
      },
    })).rejects.toThrow("rollback incomplete or conflicted");
    expect(await readFile(value.targetA, "utf8")).toBe("old-a");
    expect(await readFile(value.targetB, "utf8")).toBe("old-b");
    expect(await readFile(join(value.transaction, "rollback-conflicts", "0-a.txt"), "utf8"))
      .toBe("concurrent-user-edit");
  });

  test("rolls back every published target when final authority validation fails", async () => {
    const value = await fixture();
    let authorityChecked = false;
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        {
          targetPath: value.targetA, stagedPath: value.stagedA,
          expectedTargetSha256: await pathTreeSha256(value.targetA),
          expectedStagedSha256: await pathTreeSha256(value.stagedA),
        },
        {
          targetPath: value.targetB, stagedPath: value.stagedB,
          expectedTargetSha256: await pathTreeSha256(value.targetB),
          expectedStagedSha256: await pathTreeSha256(value.stagedB),
        },
      ],
      beforeCommit: async () => {
        authorityChecked = true;
        throw new Error("publication authority changed");
      },
    })).rejects.toThrow("publication authority changed");
    expect(authorityChecked).toBeTrue();
    expect(await readFile(value.targetA, "utf8")).toBe("old-a");
    expect(await readFile(value.targetB, "utf8")).toBe("old-b");
    expect(await Bun.file(value.transaction).exists()).toBeFalse();
  });

  test("the post-authority sweep retains a target mutated by a successful callback", async () => {
    const value = await fixture();
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [
        {
          targetPath: value.targetA, stagedPath: value.stagedA,
          expectedTargetSha256: await pathTreeSha256(value.targetA),
          expectedStagedSha256: await pathTreeSha256(value.stagedA),
        },
        {
          targetPath: value.targetB, stagedPath: value.stagedB,
          expectedTargetSha256: await pathTreeSha256(value.targetB),
          expectedStagedSha256: await pathTreeSha256(value.stagedB),
        },
      ],
      beforeCommit: async () => {
        await writeFile(value.targetA, "mutated-during-final-authority-check");
      },
    })).rejects.toThrow("rollback incomplete or conflicted");
    expect(await readFile(value.targetA, "utf8")).toBe("old-a");
    expect(await readFile(value.targetB, "utf8")).toBe("old-b");
    expect(await readFile(join(value.transaction, "rollback-conflicts", "0-a.txt"), "utf8"))
      .toBe("mutated-during-final-authority-check");
  });

  test("reports committed publication explicitly when cleanup cannot complete", async () => {
    const value = await fixture();
    await expect(replacePathsTransactionally({
      transactionDirectory: value.transaction,
      replacements: [{
        targetPath: value.targetA,
        stagedPath: value.stagedA,
        expectedTargetSha256: await pathTreeSha256(value.targetA),
        expectedStagedSha256: await pathTreeSha256(value.stagedA),
      }],
      afterCommitBeforeCleanup: async () => { throw new Error("injected cleanup failure"); },
    })).rejects.toThrow("publication completed but cleanup remains");
    expect(await readFile(value.targetA, "utf8")).toBe("new-a");
    expect((await lstat(value.transaction)).isDirectory()).toBeTrue();
  });
});
