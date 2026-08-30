// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathTreeSha256 } from "./path-transaction";

export interface PathAuthorityRecord {
  readonly path: string;
  readonly realPath: string;
  readonly sha256: string;
}

export interface PathAuthorityEpoch {
  readonly records: readonly PathAuthorityRecord[];
}

async function recordPath(path: string): Promise<Readonly<PathAuthorityRecord>> {
  if (!isAbsolute(path)) throw new TypeError("Authority epoch paths must be absolute");
  const requested = resolve(path);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new TypeError(`Authority epoch path must be a regular file or directory: ${requested}`);
  }
  return Object.freeze({
    path: requested,
    realPath: await realpath(requested),
    sha256: await pathTreeSha256(requested),
  });
}

export async function capturePathAuthorityEpoch(paths: readonly string[]): Promise<Readonly<PathAuthorityEpoch>> {
  if (paths.length === 0) throw new TypeError("Authority epoch requires at least one path");
  const canonical = paths.map((path) => resolve(path));
  if (new Set(canonical).size !== canonical.length) throw new TypeError("Authority epoch paths must be unique");
  return Object.freeze({ records: Object.freeze(await Promise.all(canonical.map(recordPath))) });
}

export async function requireUnchangedPathAuthorityEpoch(epoch: PathAuthorityEpoch): Promise<void> {
  if (!Array.isArray(epoch.records) || epoch.records.length === 0) {
    throw new TypeError("Authority epoch contains no path records");
  }
  for (const expected of epoch.records) {
    const actual = await recordPath(expected.path);
    if (actual.realPath !== expected.realPath || actual.sha256 !== expected.sha256) {
      throw new Error(`Maintenance authority changed during preparation: ${expected.path}`);
    }
  }
}
