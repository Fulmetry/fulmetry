import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSupportedNgspiceVersion, parseNgspiceVersionOutput, probeExternalTool, probeNgspice } from "../src/external-tools";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isContainmentUnavailable(result: Awaited<ReturnType<typeof probeExternalTool>>): boolean {
  return result.state === "unavailable" &&
    (result.reason?.includes("PROCESS_CONTAINMENT_UNAVAILABLE") ?? false);
}

describe("external executable boundary", () => {
  test("reports a missing tool without installing or inventing a version", async () => {
    expect(await probeExternalTool({ tool: "ngspice", executable: null })).toEqual({
      tool: "ngspice",
      state: "unavailable",
      reason: "ngspice was not found on PATH; PCBoo does not install external tools",
    });
  });

  test("executes a detected version probe directly without a shell", async () => {
    const executable = Bun.which("bun");
    if (executable === null) throw new Error("Bun executable is unavailable in its own test process");
    const result = await probeExternalTool({
      tool: "bun",
      executable,
      versionArguments: ["--version"],
    });
    if (isContainmentUnavailable(result)) {
      expect(result.reason).toContain("containment");
      return;
    }
    expect(result.state).toBe("detected");
    expect(result.versionOutput).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.executableSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("bounds hostile tool time, output, and nonzero exits", async () => {
    const executable = Bun.which("bun");
    if (executable === null) throw new Error("Bun executable is unavailable in its own test process");
    const timedOut = await probeExternalTool({
      tool: "hostile-timeout",
      executable,
      versionArguments: ["-e", "await new Promise(() => {})"],
      timeoutMs: 25,
    });
    if (isContainmentUnavailable(timedOut)) return;
    expect(timedOut.state).toBe("unavailable");
    expect(timedOut.reason).toContain("exceeded 25 ms");

    const oversized = await probeExternalTool({
      tool: "hostile-output",
      executable,
      versionArguments: ["-e", "process.stdout.write('x'.repeat(2048))"],
      outputLimit: 128,
    });
    expect(oversized.state).toBe("unavailable");
    expect(oversized.reason).toContain("exceeded 128 bytes");

    const crashed = await probeExternalTool({
      tool: "hostile-exit",
      executable,
      versionArguments: ["-e", "process.stderr.write('nope'); process.exit(7)"],
    });
    expect(crashed.state).toBe("unavailable");
    expect(crashed.reason).toContain("exited 7");
    expect(crashed.reason).not.toContain("nope");
  });

  test("returns unavailable for non-executable files and forged product output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcboo-probe-"));
    const inert = join(directory, "not-an-executable");
    try {
      await writeFile(inert, "ngspice-44\n", { mode: 0o600 });
      await chmod(inert, 0o600);
      const unavailable = await probeExternalTool({ tool: "ngspice", executable: inert });
      expect(unavailable.state).toBe("unavailable");
      expect(unavailable.reason).toContain("Executable identity failed");

      const bun = Bun.which("bun");
      if (bun === null) throw new Error("Bun executable is unavailable in its own test process");
      const forged = await probeNgspice({ executable: bun });
      expect(forged.state).toBe("unavailable");
      expect(forged.reason).toContain(
        isContainmentUnavailable(forged) ? "PROCESS_CONTAINMENT_UNAVAILABLE" : "did not identify",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an oversized executable before hashing or spawning it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcboo-probe-size-"));
    const executable = join(directory, "oversized-tool");
    try {
      await writeFile(executable, `#!${process.execPath}\nconsole.log('ngspice-44')\n`, { mode: 0o700 });
      await truncate(executable, 4_097);
      const result = await probeExternalTool({
        tool: "oversized-tool",
        executable,
        executableBytesLimit: 4_096,
      });
      expect(result.state).toBe("unavailable");
      expect(result.reason).toContain("exceeds 4096 bytes");
      expect(result.executableSha256).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects executable path replacement after opening a bounded identity handle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcboo-probe-race-"));
    const executable = join(directory, "tool");
    const original = join(directory, "tool-original");
    const replacement = join(directory, "tool-replacement");
    try {
      await writeFile(executable, `#!${process.execPath}\nconsole.log('ngspice-44')\n`, { mode: 0o700 });
      await writeFile(replacement, "replacement");
      await truncate(replacement, 8_192);
      const result = await probeExternalTool({
        tool: "raced-tool",
        executable,
        executableBytesLimit: 4_096,
        afterExecutableOpen: async () => {
          await rename(executable, original);
          await rename(replacement, executable);
        },
      });
      expect(result.state).toBe("unavailable");
      expect(result.reason).toContain("changed while its identity was captured");
      expect(result.executableSha256).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recognizes ngspice product identity and rejects lookalikes", () => {
    expect(parseNgspiceVersionOutput("ngspice-44.2\nCopyright")).toBe("44.2");
    expect(parseNgspiceVersionOutput("ngspice 42")).toBe("42");
    expect(parseNgspiceVersionOutput("definitely-not-ngspice 999")).toBeNull();
    expect(isSupportedNgspiceVersion("47")).toBeTrue();
    expect(isSupportedNgspiceVersion("48")).toBeFalse();
    expect(isSupportedNgspiceVersion("999999")).toBeFalse();
  });

  test("kills descendants when a probe times out", async () => {
    const executable = Bun.which("bun");
    if (executable === null) throw new Error("Bun executable is unavailable in its own test process");
    const directory = await mkdtemp(join(tmpdir(), "pcboo-process-tree-"));
    const pidPath = join(directory, "child.pid");
    try {
      const script = [
        "try {",
        "  const child = Bun.spawn({ cmd: [process.execPath, '-e', 'await new Promise(() => {})'], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });",
        `  await Bun.write(${JSON.stringify(pidPath)}, String(child.pid));`,
        `} catch { await Bun.write(${JSON.stringify(pidPath)}, "blocked"); }`,
        "await new Promise(() => {});",
      ].join("\n");
      const result = await probeExternalTool({
        tool: "hostile-tree",
        executable,
        versionArguments: ["-e", script],
        timeoutMs: 250,
      });
      expect(result.state).toBe("unavailable");
      if (isContainmentUnavailable(result)) {
        expect(await Bun.file(pidPath).exists()).toBeFalse();
        return;
      }
      expect(result.reason).toContain("exceeded 250 ms");
      const identity = await readFile(pidPath, "utf8");
      if (identity === "blocked") return;
      const childPid = Number(identity);
      let alive = true;
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("contains a successful probe's reparented new-session daemon before returning", async () => {
    const executable = Bun.which("bun");
    if (executable === null) throw new Error("Bun executable is unavailable in its own test process");
    const directory = await mkdtemp(join(tmpdir(), "pcboo-probe-daemon-"));
    const pidPath = join(directory, "daemon.pid");
    const markerPath = join(directory, "daemon-survived.txt");
    let daemonPid: number | undefined;
    try {
      const daemonSource = [
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));`,
        "await Bun.sleep(600);",
        `await Bun.write(${JSON.stringify(markerPath)}, "survived");`,
      ].join("\n");
      const intermediateSource = [
        `const daemon = Bun.spawn([process.execPath, "-e", ${JSON.stringify(daemonSource)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
        "daemon.unref();",
        `while (!await Bun.file(${JSON.stringify(pidPath)}).exists()) await Bun.sleep(1);`,
      ].join("\n");
      const probeSource = [
        "try {",
        `  const intermediate = Bun.spawn([process.execPath, "-e", ${JSON.stringify(intermediateSource)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
        "  await intermediate.exited;",
        `} catch { await Bun.write(${JSON.stringify(pidPath)}, "blocked"); }`,
        "console.log('ngspice-44');",
      ].join("\n");
      const result = await probeExternalTool({
        tool: "daemonizing-probe",
        executable,
        versionArguments: ["-e", probeSource],
      });
      if (isContainmentUnavailable(result)) {
        expect(await Bun.file(pidPath).exists()).toBeFalse();
        expect(await Bun.file(markerPath).exists()).toBeFalse();
        return;
      }
      const identity = await readFile(pidPath, "utf8");
      if (process.platform === "darwin") {
        expect(result.state).toBe("detected");
        expect(identity).toBe("blocked");
      } else {
        expect(result.state).toBe("unavailable");
        daemonPid = Number(identity);
        expect(daemonPid).toBeGreaterThan(0);
        expect(processIsAlive(daemonPid)).toBeFalse();
      }
      await Bun.sleep(700);
      expect(await Bun.file(markerPath).exists()).toBeFalse();
    } finally {
      if (daemonPid !== undefined && processIsAlive(daemonPid)) {
        try { process.kill(daemonPid, "SIGKILL"); } catch { /* exact daemon may exit */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
