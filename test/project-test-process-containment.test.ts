// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureProjectTestInputAuthority, runBunProjectTests } from "../src/project-tests";
import { classifyProjectTestContainmentError } from "../src/project-tests";
import {
  ProcessContainmentOrphanedError,
  ProcessContainmentUnavailableError,
} from "../src/internal/contained-process";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a green project test cannot leave a reparented new-session daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcboo-project-test-containment-"));
  const outputDirectory = ".pcboo";
  const runDirectory = join(root, outputDirectory, "run");
  const identityPath = join(runDirectory, "daemon.identity");
  const markerPath = join(runDirectory, "daemon-survived");
  let daemonPid: number | undefined;
  try {
    await mkdir(join(root, "tests"), { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    const daemonSource = [
      `await Bun.write(${JSON.stringify(identityPath)}, String(process.pid));`,
      "await Bun.sleep(600);",
      `await Bun.write(${JSON.stringify(markerPath)}, "survived");`,
    ].join("\n");
    const intermediateSource = [
      `const daemon=Bun.spawn([process.execPath,"-e",${JSON.stringify(daemonSource)}],{detached:true,stdin:"ignore",stdout:"ignore",stderr:"ignore"});`,
      "daemon.unref();",
      `while(!await Bun.file(${JSON.stringify(identityPath)}).exists())await Bun.sleep(1);`,
    ].join("\n");
    await Bun.write(join(root, "tests", "containment.test.ts"), [
      'import { test } from "bun:test";',
      'test("contained", async () => {',
      "  try {",
      `    const intermediate=Bun.spawn([process.execPath,"-e",${JSON.stringify(intermediateSource)}],{detached:true,stdin:"ignore",stdout:"ignore",stderr:"ignore"});`,
      "    intermediate.unref();",
      "    await intermediate.exited;",
      `  } catch { await Bun.write(${JSON.stringify(identityPath)}, "blocked"); }`,
      "});",
      "",
    ].join("\n"));

    const result = await runBunProjectTests({
      projectRoot: root,
      outputDirectory,
      runDirectory,
      timeoutMs: 5_000,
    });
    expect(result.reason).toBe("subprocess-forbidden");
    expect(result.outcome).toBe("incomplete");
    expect(result.inputAuthority.subprocessDeclarations).toEqual([
      "tests/containment.test.ts:4:24",
    ]);
    if (await Bun.file(identityPath).exists()) {
      const identity = await readFile(identityPath, "utf8");
      if (identity !== "blocked") daemonPid = Number(identity);
    }
    expect(daemonPid).toBeUndefined();
    await Bun.sleep(700);
    expect(await Bun.file(markerPath).exists()).toBeFalse();
  } finally {
    if (daemonPid !== undefined && isAlive(daemonPid)) {
      try { process.kill(daemonPid, "SIGKILL"); } catch { /* exact daemon may exit */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("records direct and computed subprocess authorities before test execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcboo-project-test-process-scan-"));
  try {
    await mkdir(join(root, "tests"));
    await Bun.write(join(root, "tests", "process.test.ts"), [
      'import { test } from "bun:test";',
      'import { spawn as launch } from "node:child_process";',
      'const method = "sp" + "awn";',
      'test("not executed", () => { void Bun[method]; void globalThis.Bun.spawnSync; void launch; });',
      "",
    ].join("\n"));
    const authority = await captureProjectTestInputAuthority({
      projectRoot: root,
      outputDirectory: ".pcboo",
    });
    expect(authority.subprocessDeclarations).toEqual([
      "tests/process.test.ts:2:33",
      "tests/process.test.ts:4:35",
      "tests/process.test.ts:4:53",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies typed containment failures independently of wrapper exit codes", () => {
  expect(classifyProjectTestContainmentError(new ProcessContainmentUnavailableError("CreateProcess failed"))).toEqual({
    outcome: "incomplete",
    reason: "process-containment-unavailable",
  });
  expect(classifyProjectTestContainmentError(new ProcessContainmentOrphanedError([
    { pid: 123, startTimeUtcTicks: "456" },
  ]))).toEqual({
    outcome: "failed",
    reason: "process-containment-violation",
  });
});
