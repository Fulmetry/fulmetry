#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPOSITORY_TEST_JUNIT_BYTES_LIMIT,
  parseRepositoryTestJunit,
  requirePassingRepositoryTestReport,
} from "./repository-test-contract";

export const REPOSITORY_TEST_PROCESS_TIMEOUT_MS = 10 * 60_000;
export const PRODUCTION_PROMOTION_TEST_PROCESS_TIMEOUT_MS = 15 * 60_000;
export const SERVER_TEST_PROCESS_TIMEOUT_MS = 19 * 60_000;
const repositoryRoot = join(import.meta.dir, "..");
const policyPreload = join(import.meta.dir, "repository-test-policy-preload.ts");

async function readStableJunit(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > REPOSITORY_TEST_JUNIT_BYTES_LIMIT) {
      throw new Error("REPOSITORY_TEST_JUNIT_INVALID: missing, special, or oversized");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size
    ) throw new Error("REPOSITORY_TEST_JUNIT_INVALID: changed while captured");
    return bytes;
  } finally {
    await handle.close();
  }
}

function terminate(child: Bun.Subprocess): void {
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group may already be empty. */ }
  }
  try { child.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
}

export async function runRepositoryTestGate(files: readonly string[]): Promise<void> {
  if (files.length === 0 || files.some((path) => !/^\.\/(?:test|tests)\/.+\.test\.tsx?$/u.test(path))) {
    throw new TypeError("REPOSITORY_TEST_FILES_INVALID");
  }
  const directory = await mkdtemp(join(tmpdir(), "fulmetry-repository-test-"));
  const processTimeoutMilliseconds = files.length === 1 && files[0] === "./test/server.test.ts"
    ? SERVER_TEST_PROCESS_TIMEOUT_MS
    : files.length === 1 && files[0] === "./test/production-promotion.test.ts"
    ? PRODUCTION_PROMOTION_TEST_PROCESS_TIMEOUT_MS
    : REPOSITORY_TEST_PROCESS_TIMEOUT_MS;
  const junitPath = join(directory, "junit.xml");
  const child = Bun.spawn([
    process.execPath,
    ...(process.platform === "win32" ? [] : ["--no-orphans"]),
    "test",
    "--max-concurrency=1",
    "--timeout=120000",
    "--preload",
    policyPreload,
    "--reporter=junit",
    `--reporter-outfile=${junitPath}`,
    ...files,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, FULMETRY_REPOSITORY_TEST_POLICY_REQUIRED: "1" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const stop = () => terminate(child);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = setTimeout(() => { timedOut = true; terminate(child); }, processTimeoutMilliseconds);
  try {
    const exitCode = await child.exited;
    if (timedOut) throw new Error(`REPOSITORY_TEST_TIMEOUT: ${processTimeoutMilliseconds} ms`);
    if (exitCode !== 0) throw new Error(`REPOSITORY_TEST_RUNNER_EXIT: ${exitCode}`);
    requirePassingRepositoryTestReport(parseRepositoryTestJunit(await readStableJunit(junitPath)), files);
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    terminate(child);
    await child.exited.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await runRepositoryTestGate(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
