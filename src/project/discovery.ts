// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

const INCOMPLETE_SCAFFOLD_MARKER = ".fulmetry-scaffold-incomplete";

export interface DiscoveredProject {
  readonly root: string;
  readonly configPath: string;
  readonly lockfilePath: string;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Discovers metadata only; it never evaluates trusted project source/config. */
export async function discoverProject(startDirectory: string): Promise<Readonly<DiscoveredProject>> {
  let current = await realpath(startDirectory);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (await isRegularFile(join(current, INCOMPLETE_SCAFFOLD_MARKER))) {
      throw new Error(`Incomplete Fulmetry scaffold at ${current}: remove the partial directory and run the creator again`);
    }
    const configPath = join(current, "fulmetry.config.ts");
    const lockfilePath = join(current, "fulmetry.lock");
    const [hasConfig, hasLock] = await Promise.all([
      isRegularFile(configPath),
      isRegularFile(lockfilePath),
    ]);
    if (hasConfig || hasLock) {
      if (!hasConfig || !hasLock) {
        throw new Error(
          `Incomplete Fulmetry project at ${current}: fulmetry.config.ts and fulmetry.lock are both required`,
        );
      }
      return Object.freeze({ root: current, configPath, lockfilePath });
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  throw new Error(`No Fulmetry project found from ${startDirectory}`);
}
