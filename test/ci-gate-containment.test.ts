// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { superviseCiCommand } from "../scripts/run-ci-gate";

interface OrphanIdentity {
  readonly pid: number;
  readonly nonce: string;
  readonly startedAtUnixMilliseconds: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("fails closed and terminates a detached child with an exact fixture identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pcboo-ci-containment-"));
  const recordPath = join(directory, "identity.json");
  const nonce = crypto.randomUUID();
  let identity: OrphanIdentity | undefined;
  try {
    let rejection: unknown;
    try {
      await superviseCiCommand("orphan-regression", [
        process.execPath,
        join(import.meta.dir, "fixtures", "ci-orphan-process.ts"),
        "parent",
        recordPath,
        nonce,
      ]);
    } catch (error) {
      rejection = error;
    }
    identity = JSON.parse(await readFile(recordPath, "utf8")) as OrphanIdentity;
    expect(identity.nonce).toBe(nonce);
    expect(identity.pid).toBeInteger();
    expect(identity.pid).toBeGreaterThan(0);
    expect(identity.startedAtUnixMilliseconds).toBeGreaterThan(0);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("CI_GATE_ORPHANED_PROCESS");
    expect((rejection as Error).message).toContain(String(identity.pid));
    expect(isAlive(identity.pid)).toBe(false);
  } finally {
    if (identity !== undefined && isAlive(identity.pid)) {
      try {
        process.kill(identity.pid, "SIGKILL");
      } catch {
        // The exact fixture process may have exited during cleanup.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bun no-orphans kills a zero-delay new-session child before any ancestry sample", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "pcboo-ci-no-orphans-"));
  const recordPath = join(directory, "identity");
  const nonce = crypto.randomUUID();
  let identity: OrphanIdentity | undefined;
  try {
    const record = await superviseCiCommand("no-orphans-pre-snapshot-regression", [
      process.execPath,
      "--no-orphans",
      join(import.meta.dir, "fixtures", "ci-orphan-process.ts"),
      "immediate-parent",
      recordPath,
      nonce,
    ], { initialSampleDelayMilliseconds: 150 });
    identity = JSON.parse(await readFile(`${recordPath}.parent`, "utf8")) as OrphanIdentity;
    expect(identity.nonce).toBe(nonce);
    expect(identity.pid).toBeGreaterThan(0);
    expect(record.exitCode).toBe(0);
    expect(record.observedDescendantCount).toBe(0);
    expect(record.orphanPids).toEqual([]);
    expect(isAlive(identity.pid)).toBe(false);

    const childIdentity = JSON.parse(
      await readFile(`${recordPath}.child`, "utf8"),
    ) as OrphanIdentity;
    expect(childIdentity).toEqual({
      pid: identity.pid,
      nonce,
      startedAtUnixMilliseconds: expect.any(Number),
    });
  } finally {
    if (identity !== undefined && isAlive(identity.pid)) {
      try {
        process.kill(identity.pid, "SIGKILL");
      } catch {
        // The exact fixture process may have exited during cleanup.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a double-fork daemon that escapes ancestry and process-group sampling", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "pcboo-ci-double-fork-"));
  const recordPath = join(directory, "identity");
  const nonce = crypto.randomUUID();
  let identity: OrphanIdentity | undefined;
  try {
    let rejection: unknown;
    try {
      await superviseCiCommand("double-fork-regression", [
        process.execPath,
        join(import.meta.dir, "fixtures", "ci-orphan-process.ts"),
        "double-fork-parent",
        recordPath,
        nonce,
      ], { initialSampleDelayMilliseconds: 150 });
    } catch (error) {
      rejection = error;
    }
    identity = JSON.parse(await readFile(`${recordPath}.child`, "utf8")) as OrphanIdentity;
    expect(identity.nonce).toBe(nonce);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("CI_GATE_ORPHANED_PROCESS");
    expect((rejection as Error).message).toContain(String(identity.pid));
    expect(isAlive(identity.pid)).toBe(false);
  } finally {
    if (identity !== undefined && isAlive(identity.pid)) {
      try { process.kill(identity.pid, "SIGKILL"); } catch { /* exact daemon may exit */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("labels the unobserved token-stripping POSIX escape outside its best-effort coverage", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "pcboo-ci-tokenless-double-fork-"));
  const recordPath = join(directory, "identity");
  const nonce = crypto.randomUUID();
  let identity: OrphanIdentity | undefined;
  try {
    const record = await superviseCiCommand("tokenless-double-fork-boundary", [
      process.execPath,
      join(import.meta.dir, "fixtures", "ci-orphan-process.ts"),
      "double-fork-scrubbed-parent",
      recordPath,
      nonce,
    ], { initialSampleDelayMilliseconds: 150 });
    identity = JSON.parse(await readFile(`${recordPath}.child`, "utf8")) as OrphanIdentity;
    expect(identity.nonce).toBe(nonce);
    expect(record.containment).toBe("best-effort-posix-process-group+sampled-ancestry+inherited-token");
    expect(record.orphanDetectionCoverage).toBe("observed-or-token-retaining-descendants");
    expect(record.orphanPids).toEqual([]);
    expect(isAlive(identity.pid)).toBe(true);
  } finally {
    if (identity !== undefined && isAlive(identity.pid)) {
      try { process.kill(identity.pid, "SIGKILL"); } catch { /* exact daemon may exit */ }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies a finite supervisor deadline and records timeout authority", async () => {
  const record = await superviseCiCommand("deadline-regression", [
    process.execPath,
    "-e",
    "await new Promise(() => {})",
  ], { timeoutMilliseconds: 1_000 });
  expect(record.timedOut).toBeTrue();
  expect(record.deadlineMilliseconds).toBe(1_000);
  expect(record.exitCode).not.toBe(0);
  expect(record.orphanPids).toEqual([]);
});
