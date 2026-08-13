// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseWindowsJobResult,
  parseLinuxCgroupResult,
  ProcessContainmentUnavailableError,
  readWindowsJobResult,
  resolveWindowsJobResult,
  resolveLinuxCgroupResult,
  spawnContainedProcess,
} from "../src/internal/contained-process";

const validResult = {
  containmentApplied: true,
  childExitCode: 87,
  peakJobMemoryBytes: 1234,
  orphanProcesses: [],
  survivorProcesses: [],
  error: null,
} as const;

test("Windows Job Object records preserve actual child exit codes, including reserved wrapper codes", () => {
  expect(resolveWindowsJobResult(parseWindowsJobResult(Buffer.from(JSON.stringify(validResult))), 87)).toBe(87);
  expect(() => resolveWindowsJobResult(parseWindowsJobResult(Buffer.from(JSON.stringify({
    ...validResult,
    childExitCode: 0,
  }))), 1)).toThrow("did not authenticate result status");
  expect(() => resolveWindowsJobResult(parseWindowsJobResult(Buffer.from(JSON.stringify({
    ...validResult,
    orphanProcesses: [{ pid: 123, startTimeUtcTicks: "456" }],
  }))))).toThrow("PROCESS_CONTAINMENT_ORPHANED");
  expect(() => resolveWindowsJobResult(parseWindowsJobResult(Buffer.from(JSON.stringify({
    ...validResult,
    containmentApplied: false,
    error: "CreateProcess failed with Win32 error 2",
  }))))).toThrow("PROCESS_CONTAINMENT_UNAVAILABLE: Windows Job Object runner reported: CreateProcess failed with Win32 error 2");
});

test("Windows Job Object records fail closed when malformed, oversized, missing, symlinked, or replaced", async () => {
  expect(() => parseWindowsJobResult(Buffer.from('{"containmentApplied":true}')))
    .toThrow(ProcessContainmentUnavailableError);
  const root = await mkdtemp(join(tmpdir(), "pcboo-windows-job-record-"));
  try {
    const oversized = join(root, "oversized.json");
    await writeFile(oversized, new Uint8Array(64 * 1024 + 1));
    await expect(readWindowsJobResult(oversized)).rejects.toBeInstanceOf(ProcessContainmentUnavailableError);
    await expect(readWindowsJobResult(join(root, "missing.json"))).rejects.toBeInstanceOf(ProcessContainmentUnavailableError);
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    await writeFile(target, JSON.stringify(validResult));
    await symlink(target, link);
    await expect(readWindowsJobResult(link)).rejects.toBeInstanceOf(ProcessContainmentUnavailableError);
    const replaced = join(root, "replaced.json");
    const replacement = join(root, "replacement.json");
    await writeFile(replaced, JSON.stringify(validResult));
    await writeFile(replacement, JSON.stringify({ ...validResult, childExitCode: 1 }));
    await expect(readWindowsJobResult(replaced, async () => {
      await rename(replacement, replaced);
    })).rejects.toBeInstanceOf(ProcessContainmentUnavailableError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux cgroup records distinguish actual reserved exits, setup failure, and contained orphans", () => {
  const actualReservedExit = parseLinuxCgroupResult(Buffer.from(JSON.stringify({
    containmentApplied: true,
    childExitCode: 86,
    orphanPids: [],
    error: null,
  })));
  expect(resolveLinuxCgroupResult(actualReservedExit, 86)).toBe(86);
  expect(() => resolveLinuxCgroupResult({ ...actualReservedExit, orphanPids: [123] }, 86))
    .toThrow("PROCESS_CONTAINMENT_ORPHANED");
  expect(() => resolveLinuxCgroupResult({
    containmentApplied: false,
    childExitCode: 1,
    orphanPids: [],
    error: "runner did not enter the delegated cgroup",
  }, 87)).toThrow("PROCESS_CONTAINMENT_UNAVAILABLE: Linux cgroup runner reported");
  expect(() => resolveLinuxCgroupResult(actualReservedExit, 87))
    .toThrow("did not authenticate result status 86");
  expect(() => parseLinuxCgroupResult(Buffer.from('{"containmentApplied":true}')))
    .toThrow(ProcessContainmentUnavailableError);
});

test.skipIf(process.platform !== "win32")("a missing Windows target reports typed containment unavailability", async () => {
  const child = await spawnContainedProcess({
    command: ["Z:\\pcboo-guaranteed-missing\\no-such-executable.exe"],
    env: {},
  });
  await expect(child.exited).rejects.toBeInstanceOf(ProcessContainmentUnavailableError);
});

test.skipIf(process.platform !== "darwin")("macOS Seatbelt denies a contained target permission to signal its parent", async () => {
  const outer = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures", "contained-process-signal-probe.ts"),
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(outer.stdout).text();
  const stderr = new Response(outer.stderr).text();
  const exitCode = await outer.exited;
  expect(exitCode).toBe(0);
  expect(await stderr).toBe("");
  expect(JSON.parse(await stdout)).toEqual({
    exitCode: 0,
    stdout: expect.stringContaining("SIGNAL_DENIED:kill() failed: EPERM"),
    stderr: "",
  });
});

test.skipIf(process.platform !== "darwin")("macOS distinguishes Seatbelt application failure from a real target exit 71", async () => {
  const marker = join(tmpdir(), `pcboo-macos-profile-${crypto.randomUUID()}`);
  const rejected = await spawnContainedProcess({
    command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "launched")`],
    env: { PATH: process.env.PATH ?? "" },
    macosProfileForTest: "(version 1)(deny",
  });
  await expect(rejected.exited).rejects.toBeInstanceOf(ProcessContainmentUnavailableError);
  expect(await Bun.file(marker).exists()).toBeFalse();

  const actual = await spawnContainedProcess({
    command: [process.execPath, "-e", "process.exit(71)"],
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(await actual.exited).toBe(71);
});
