// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat } from "node:fs/promises";
import {
  pathTreeSha256,
  replacePathsTransactionally,
} from "./path-transaction";

export interface DirectoryReplacement {
  readonly targetDirectory: string;
  readonly stagedDirectory: string;
  readonly expectedTargetSha256: string;
  readonly expectedStagedSha256: string;
}

export interface ReplaceDirectoriesTransactionallyOptions {
  readonly transactionDirectory: string;
  readonly replacements: readonly DirectoryReplacement[];
  /** @internal Adversarial test hook after the original has moved to backup. */
  readonly afterBackup?: (index: number) => Promise<void>;
  /** Revalidate non-target authority while rollback backups still exist. */
  readonly beforeCommit?: () => Promise<void>;
}

/** Directory-only compatibility identity over the shared mixed-path hasher. */
export async function directoryTreeSha256(root: string): Promise<string> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Directory identity root must be a non-symlink directory");
  }
  return pathTreeSha256(root);
}

/**
 * Directory-only compatibility adapter over PCBoo's single rollback-capable
 * publication primitive. Both the prepared and original trees are bound by
 * caller-captured digests; conflict recovery semantics are shared exactly.
 */
export async function replaceDirectoriesTransactionally(
  options: ReplaceDirectoriesTransactionallyOptions,
): Promise<void> {
  await replacePathsTransactionally({
    transactionDirectory: options.transactionDirectory,
    replacements: options.replacements.map((replacement) => ({
      targetPath: replacement.targetDirectory,
      stagedPath: replacement.stagedDirectory,
      expectedTargetSha256: replacement.expectedTargetSha256,
      expectedStagedSha256: replacement.expectedStagedSha256,
    })),
    ...(options.afterBackup === undefined ? {} : { afterBackup: options.afterBackup }),
    ...(options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit }),
  });
}
