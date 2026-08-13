// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PathReplacement {
  readonly targetPath: string;
  readonly stagedPath: string;
  readonly expectedTargetSha256: string;
  readonly expectedStagedSha256: string;
}

export interface ReplacePathsTransactionallyOptions {
  readonly transactionDirectory: string;
  readonly replacements: readonly PathReplacement[];
  /** @internal Failure-injection hook after an original is backed up. */
  readonly afterBackup?: (index: number) => Promise<void>;
  /**
   * Revalidate non-target publication authority after every target is in
   * place, while backups are still available for rollback.
   */
  readonly beforeCommit?: () => Promise<void>;
  /** @internal Failure-injection hook after commit and before cleanup. */
  readonly afterCommitBeforeCleanup?: () => Promise<void>;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function kind(path: string): Promise<"file" | "directory"> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new TypeError(`Transactional path must not be a symlink: ${path}`);
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  throw new TypeError(`Transactional path must be a regular file or directory: ${path}`);
}

export async function pathTreeSha256(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new TypeError("Path identity requires an absolute path");
  const rootKind = await kind(path);
  const hasher = new Bun.CryptoHasher("sha256");
  if (rootKind === "file") {
    hasher.update("F\0");
    hasher.update(await readFile(path));
    return hasher.digest("hex");
  }
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const child = join(directory, entry.name);
      const childKind = await kind(child);
      const name = relative(path, child).replaceAll("\\", "/");
      hasher.update(childKind === "file" ? "F\0" : "D\0");
      hasher.update(name);
      hasher.update("\0");
      if (childKind === "file") {
        hasher.update(await readFile(child));
        hasher.update("\0");
      } else await walk(child);
    }
  };
  await walk(path);
  return hasher.digest("hex");
}

export async function replacePathsTransactionally(options: ReplacePathsTransactionallyOptions): Promise<void> {
  if (!isAbsolute(options.transactionDirectory) || options.replacements.length === 0) {
    throw new TypeError("Path transaction requires an absolute transaction directory and replacements");
  }
  const requestedTransaction = resolve(options.transactionDirectory);
  if (await kind(requestedTransaction) !== "directory") throw new TypeError("Transaction path must be a plain directory");
  const transaction = await realpath(requestedTransaction);
  const validated: Array<{
    target: string;
    staged: string;
    expectedTarget: string;
    expectedStaged: string;
    kind: "file" | "directory";
  }> = [];
  for (const [index, item] of options.replacements.entries()) {
    if (
      !isAbsolute(item.targetPath) || !isAbsolute(item.stagedPath) ||
      !/^[a-f0-9]{64}$/u.test(item.expectedTargetSha256) ||
      !/^[a-f0-9]{64}$/u.test(item.expectedStagedSha256)
    ) {
      throw new TypeError(`Path replacement ${index} is not canonical`);
    }
    const requestedTarget = resolve(item.targetPath);
    const requestedStaged = resolve(item.stagedPath);
    const requestedTargetKind = await kind(requestedTarget);
    const requestedStagedKind = await kind(requestedStaged);
    const target = await realpath(requestedTarget);
    const staged = await realpath(requestedStaged);
    const targetKind = await kind(target);
    if (requestedTargetKind !== targetKind || requestedStagedKind !== targetKind || await kind(staged) !== targetKind) {
      throw new TypeError(`Path replacement ${index} changes path kind`);
    }
    if (inside(target, transaction) || inside(transaction, target) || staged === transaction || !inside(transaction, staged)) {
      throw new TypeError(`Path replacement ${index} has an invalid transaction relationship`);
    }
    for (const prior of validated) {
      if (inside(prior.target, target) || inside(target, prior.target) ||
        inside(prior.staged, staged) || inside(staged, prior.staged)) {
        throw new TypeError("Path transaction replacements overlap");
      }
    }
    if (await pathTreeSha256(staged) !== item.expectedStagedSha256) {
      throw new Error(`Path replacement ${index} staged content changed before publication`);
    }
    validated.push({
      target,
      staged,
      expectedTarget: item.expectedTargetSha256,
      expectedStaged: item.expectedStagedSha256,
      kind: targetKind,
    });
  }

  const backups = join(transaction, "backups");
  await mkdir(backups);
  const states = validated.map((item, index) => ({
    ...item,
    backup: join(backups, `${String(index).padStart(4, "0")}-${basename(item.target)}`),
    backedUp: false,
  }));
  try {
    for (const [index, state] of states.entries()) {
      if (await pathTreeSha256(state.staged) !== state.expectedStaged) {
        throw new Error(`Path replacement ${index} staged content changed before publication`);
      }
      await rename(state.target, state.backup);
      state.backedUp = true;
      if (await pathTreeSha256(state.backup) !== state.expectedTarget) {
        throw new Error(`Path replacement ${index} target changed before publication`);
      }
      await options.afterBackup?.(index);
      if (await pathTreeSha256(state.staged) !== state.expectedStaged) {
        throw new Error(`Path replacement ${index} staged content changed during publication`);
      }
      await mkdir(dirname(state.target), { recursive: true });
      await rename(state.staged, state.target);
      if (await pathTreeSha256(state.target) !== state.expectedStaged) {
        throw new Error(`Path replacement ${index} published content changed during publication`);
      }
    }
    for (const [index, state] of states.entries()) {
      if (await pathTreeSha256(state.target) !== state.expectedStaged) {
        throw new Error(`Path replacement ${index} published content changed before transaction completion`);
      }
    }
    await options.beforeCommit?.();
    // The authority callback is caller-supplied code and may take time. Sweep
    // the published targets again so neither it nor a concurrent writer can
    // leave unbound bytes under a successful commit.
    for (const [index, state] of states.entries()) {
      if (await pathTreeSha256(state.target) !== state.expectedStaged) {
        throw new Error(`Path replacement ${index} published content changed during final authority validation`);
      }
    }
  } catch (cause) {
    const failures: unknown[] = [];
    const displaced = join(transaction, "rollback-displaced");
    const conflicts = join(transaction, "rollback-conflicts");
    const retainedConflicts: string[] = [];
    await mkdir(displaced).catch((error) => failures.push(error));
    for (const [index, state] of [...states.entries()].reverse()) {
      if (!state.backedUp) continue;
      try {
        try {
          await lstat(state.target);
          const isTransactionOutput = await pathTreeSha256(state.target) === state.expectedStaged;
          if (isTransactionOutput) {
            await rename(state.target, join(displaced, `${index}-${basename(state.target)}`));
          } else {
            await mkdir(conflicts, { recursive: true });
            const retained = join(conflicts, `${index}-${basename(state.target)}`);
            await rename(state.target, retained);
            retainedConflicts.push(retained);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(state.backup, state.target);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0 || retainedConflicts.length > 0) {
      throw new AggregateError(
        [cause, ...failures],
        `Path transaction rollback incomplete or conflicted; recovery retained at ${transaction}`,
      );
    }
    await rm(transaction, { recursive: true, force: true });
    throw cause;
  }
  try {
    await options.afterCommitBeforeCleanup?.();
    await rm(transaction, { recursive: true, force: true });
  } catch (error) {
    throw new AggregateError(
      [error],
      `Path transaction publication completed but cleanup remains at ${transaction}`,
    );
  }
}
