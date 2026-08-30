// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/** Every source that can change the meaning or acceptance of runtime evidence. */
export const TSCIRCUIT_RUNTIME_EVIDENCE_IMPLEMENTATION_FILES = Object.freeze([
  "src/engine-package-fingerprint.ts",
  "src/internal/fresh-package-entry.ts",
  "src/internal/bounded-file.ts",
  "src/internal/empty-bunfig.toml",
  "src/internal/resolve-package-entry.ts",
  "src/upgrade/dependency-lock.ts",
  "src/upgrade/engine-package.ts",
  "src/upgrade/implementation-identity.ts",
  "src/upgrade/jsonc.ts",
  "src/upgrade/packed-consumer.ts",
  "src/project/lock.ts",
  "src/runtime.ts",
  "src/manufacturing/export.ts",
  "src/upgrade/platforms.ts",
  "src/upgrade/runtime-evidence.ts",
  "src/upgrade/refresh-guard.ts",
  "src/upgrade/authority-epoch.ts",
  "src/upgrade/path-transaction.ts",
  "scripts/packed-e2e.ts",
  "scripts/accept-tscircuit-upgrade.ts",
  "scripts/qualify-tscircuit-runtime.ts",
] as const);

export async function fingerprintTscircuitRuntimeEvidenceImplementation(
  repositoryRoot: string,
): Promise<string> {
  if (!isAbsolute(repositoryRoot)) throw new TypeError("Implementation root must be absolute");
  const root = await realpath(repositoryRoot);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of TSCIRCUIT_RUNTIME_EVIDENCE_IMPLEMENTATION_FILES) {
    const absolute = join(root, ...path.split("/"));
    const candidate = relative(root, absolute);
    if (candidate === "" || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate)) {
      throw new Error("Runtime evidence implementation path escaped the repository");
    }
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new TypeError(`Runtime evidence implementation file ${path} must be regular`);
    }
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size
    ) throw new Error(`Runtime evidence implementation file ${path} changed while hashing`);
    hasher.update(path);
    hasher.update("\0");
    hasher.update(bytes);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}
