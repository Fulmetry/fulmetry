// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeNgspice } from "../src/external-tools";
import {
  isIssuedNgspiceQualification,
  qualifyCapturedNgspice,
} from "../src/simulation/ngspice-qualification";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true })
)));

const OPERATING_POINT_RAW = [
  "Title: fixture", "Plotname: Operating Point", "Flags: real",
  "No. Variables: 1", "No. Points: 1", "Variables:",
  "0 v(out) voltage", "Values:", "0 2.5", "",
].join("\n");

async function oneResultExecutable(root: string, raw = OPERATING_POINT_RAW): Promise<string> {
  const executable = join(root, "ngspice-fixture");
  const invocationLog = join(root, "invocations.jsonl");
  await Bun.write(executable, [
    `#!${process.execPath}`,
    "if (process.argv.includes('--version')) { console.log('ngspice-44'); process.exit(0) }",
    "const { appendFile } = await import('node:fs/promises')",
    `await appendFile(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")`,
    "const rawAt = process.argv.indexOf('-r')",
    `await Bun.write(process.argv[rawAt + 1], ${JSON.stringify(raw)})`,
    "",
  ].join("\n"));
  await chmod(executable, 0o700);
  return executable;
}

describe("bounded ngspice behavioral qualification", () => {
  test("rejects a version-correct executable that only reproduces one canned result", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-qualification-"));
    roots.push(root);
    const executable = await oneResultExecutable(root);
    const tool = await probeNgspice({ executable });
    expect(tool.state).toBe("detected");

    const qualification = await qualifyCapturedNgspice({
      executable,
      directory: join(root, "qualification"),
      tool,
    });
    expect(qualification.evidence.qualified).toBeFalse();
    expect(qualification.evidence.cases.map(({ status }) => status)).toEqual(["passed", "failed"]);
    expect(qualification.evidence.cases[1]?.failure).toContain("unexpected vectors");
    expect(isIssuedNgspiceQualification(qualification, tool)).toBeFalse();
    const invocations = (await Bun.file(join(root, "invocations.jsonl")).text())
      .trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(2);
    expect(invocations.every((arguments_) => arguments_.includes("-n"))).toBeTrue();
  });

  test("rejects binary output and caller-forged serialized qualification authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-qualification-binary-"));
    roots.push(root);
    const executable = await oneResultExecutable(root, "Binary:\n\0fixture");
    const tool = await probeNgspice({ executable });
    const qualification = await qualifyCapturedNgspice({
      executable,
      directory: join(root, "qualification"),
      tool,
    });
    expect(qualification.evidence.qualified).toBeFalse();
    expect(qualification.evidence.cases[0]?.failure).toContain("binary");
    const forged = Object.freeze({
      evidence: qualification.evidence,
      evidenceBytes: qualification.evidenceBytes,
      sha256: qualification.sha256,
    });
    expect(isIssuedNgspiceQualification(forged, tool)).toBeFalse();
  });

  test("retains exact decks, raw output, and streams only for an explicit evidence collector", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-qualification-retained-"));
    roots.push(root);
    const executable = await oneResultExecutable(root);
    const tool = await probeNgspice({ executable });
    const directory = join(root, "qualification");
    const qualification = await qualifyCapturedNgspice({
      executable,
      directory,
      tool,
      retainCaseArtifacts: true,
    });

    expect(qualification.evidence.qualified).toBeFalse();
    expect((await readdir(directory)).sort()).toEqual(["operating-point", "rc-transient"]);
    for (const caseName of ["operating-point", "rc-transient"]) {
      expect((await readdir(join(directory, caseName))).sort()).toEqual([
        "input.cir",
        "result.raw",
        "stderr.bin",
        "stdout.bin",
      ]);
      expect(await Bun.file(join(directory, caseName, "input.cir")).text()).toContain(
        ".options filetype=ascii",
      );
      expect(await Bun.file(join(directory, caseName, "result.raw")).text()).toBe(
        OPERATING_POINT_RAW,
      );
    }
  });

  test("cancellation cannot issue or persist qualification evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-ngspice-qualification-cancel-"));
    roots.push(root);
    const executable = await oneResultExecutable(root);
    const tool = await probeNgspice({ executable });
    const controller = new AbortController();
    controller.abort();
    await expect(qualifyCapturedNgspice({
      executable,
      directory: join(root, "qualification"),
      tool,
      signal: controller.signal,
    })).rejects.toThrow("cancelled");
    expect(await Bun.file(join(root, "qualification")).exists()).toBeFalse();
  });
});
