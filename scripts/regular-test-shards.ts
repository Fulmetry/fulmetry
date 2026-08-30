// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const REGULAR_TEST_ENTRY_LIMIT = 4_096;
const REGULAR_TEST_DEPTH_LIMIT = 16;
export const REGULAR_TEST_FILES_PER_SHARD_LIMIT = 4;

export const HEAVY_TEST_FILES = Object.freeze([
  "cli.test.ts",
  "accept-tscircuit-upgrade.test.ts",
  "artifact-manifest.test.ts",
  "manufacturing-properties.test.ts",
  "semantic-properties.test.ts",
  "manufacturing-verify.test.ts",
  "production-promotion.test.ts",
  "scaffold.test.ts",
  "server.test.ts",
  "ngspice-live.test.ts",
] as const);

export const REGULAR_CI_GATE_NAMES = Object.freeze([
  "regular-01",
  "regular-02",
  "regular-03",
  "regular-04",
  "regular-05",
  "regular-06",
  "regular-07",
  "regular-08",
  "regular-09",
  "regular-10",
  "regular-11",
  "regular-12",
  "regular-13",
  "regular-14",
  "regular-15",
  "regular-16",
] as const);

export type RegularCiGateName = typeof REGULAR_CI_GATE_NAMES[number];

/** Discovers every test file recursively and excludes only separately measured heavy gates. */
export async function discoverRegularTestFiles(
  testRoot = join(repositoryRoot, "test"),
): Promise<readonly string[]> {
  const discovered: string[] = [];
  let entries = 0;
  const visit = async (
    directory: string,
    pathPrefix: "test" | "tests",
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > REGULAR_TEST_DEPTH_LIMIT) {
      throw new Error(`Regular test discovery exceeds depth ${REGULAR_TEST_DEPTH_LIMIT}`);
    }
    for await (const entry of await opendir(directory)) {
      entries += 1;
      if (entries > REGULAR_TEST_ENTRY_LIMIT) {
        throw new Error(`Regular test discovery exceeds ${REGULAR_TEST_ENTRY_LIMIT} entries`);
      }
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Regular test tree contains a symlink: ${relativePath}`);
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), pathPrefix, relativePath, depth + 1);
      } else if (!entry.isFile()) {
        throw new Error(`Regular test tree contains a non-regular entry: ${relativePath}`);
      } else if (/\.test\.tsx?$/u.test(entry.name)) {
        discovered.push(`./${pathPrefix}/${relativePath}`);
      }
    }
  };
  const visitRoot = async (root: string, pathPrefix: "test" | "tests", required: boolean): Promise<void> => {
    try {
      const metadata = await lstat(root);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Regular ${pathPrefix} root must be a non-symlink directory`);
      }
      await visit(root, pathPrefix, "", 0);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  };
  await visitRoot(testRoot, "test", true);
  await visitRoot(join(dirname(testRoot), "tests"), "tests", false);
  const heavyPaths = new Set(HEAVY_TEST_FILES.map((file) => `./test/${file}`));
  for (const path of heavyPaths) {
    if (!discovered.includes(path)) throw new Error(`Separately measured heavy test is missing: ${path}`);
  }
  const regular = discovered.filter((path) => !heavyPaths.has(path)).sort();
  if (regular.length === 0) throw new Error("Regular test discovery found no test files");
  return Object.freeze(regular);
}

export async function regularTestShardFiles(
  gate: RegularCiGateName,
  testRoot?: string,
): Promise<readonly string[]> {
  const shardIndex = REGULAR_CI_GATE_NAMES.indexOf(gate);
  if (shardIndex < 0) throw new TypeError(`Unknown regular CI shard: ${gate}`);
  const regularFiles = await discoverRegularTestFiles(testRoot);
  const files = regularFiles.filter((_, index) => index % REGULAR_CI_GATE_NAMES.length === shardIndex);
  if (files.length === 0) throw new Error(`Regular CI shard ${gate} is empty`);
  if (files.length > REGULAR_TEST_FILES_PER_SHARD_LIMIT) {
    throw new Error(
      `Regular CI shard ${gate} has ${files.length} files; add another named shard before exceeding ` +
      `${REGULAR_TEST_FILES_PER_SHARD_LIMIT}`,
    );
  }
  return Object.freeze(files);
}
