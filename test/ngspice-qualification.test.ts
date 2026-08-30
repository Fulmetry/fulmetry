// SPDX-FileCopyrightText: 2026 Fulmetry contributors
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

const V46_TRANSIENT_RAW = [
  "Title: fixture", "Plotname: Transient Analysis", "Flags: real",
  "No. Variables: 2", "No. Points: 4", "Variables:",
  "0 time time", "1 v(out) voltage", "Values:",
  "0 0", "0", "1 0.001", "3.1606", "2 0.004", "4.9084", "3 0.006", "1.805", "",
].join("\n");

const V46_AC_RAW = [
  "Title: fixture", "Plotname: AC Analysis", "Flags: complex",
  "No. Variables: 2", "No. Points: 3", "Variables:",
  "0 frequency frequency grid=3", "1 v(out) voltage", "Values:",
  "0 10,2.205150681906361e-314", "0.990099009901,-0.0990099009901",
  "1 100,2.205150681906361e-314", "0.5,-0.5",
  "2 1000,2.205150681906361e-314", "0.00990099009901,-0.0990099009901", "",
].join("\n");

const V46_DC_RAW = [
  "Title: fixture", "Plotname: DC transfer characteristic", "Flags: real",
  "No. Variables: 2", "No. Points: 5", "Variables:",
  "0 v(v-sweep) voltage", "1 v(out) voltage", "Values:",
  "0 1", "0.5", "1 2", "1", "2 3", "1.5", "3 4", "2", "4 5", "2.5", "",
].join("\n");

async function v46FixtureExecutable(root: string): Promise<string> {
  const executable = join(root, "ngspice-v46-fixture");
  await Bun.write(executable, [
    `#!${process.execPath}`,
    "if (process.argv.includes('--version')) { console.log('ngspice-46'); process.exit(0) }",
    "const deck = await Bun.file(process.argv.at(-1)).text()",
    `const raw = deck.includes('.tran ') ? ${JSON.stringify(V46_TRANSIENT_RAW)} : deck.includes('.ac ') ? ${JSON.stringify(V46_AC_RAW)} : deck.includes('.dc ') ? ${JSON.stringify(V46_DC_RAW)} : ${JSON.stringify(OPERATING_POINT_RAW)}`,
    "const rawAt = process.argv.indexOf('-r')",
    "await Bun.write(process.argv[rawAt + 1], raw)",
    "",
  ].join("\n"));
  await chmod(executable, 0o700);
  return executable;
}

describe("bounded ngspice behavioral qualification", () => {
  test("qualifies exact ngspice 46 AC metadata, subnormal frequency noise, and DC axis spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-ngspice-v46-"));
    roots.push(root);
    const executable = await v46FixtureExecutable(root);
    const tool = await probeNgspice({ executable });
    const qualification = await qualifyCapturedNgspice({
      executable,
      directory: join(root, "qualification"),
      tool,
    });
    expect(qualification.evidence.cases.map(({ status }) => status),
      JSON.stringify(qualification.evidence.cases, null, 2)).toEqual([
      "passed", "passed", "passed", "passed",
    ]);
    expect(qualification.evidence.qualified).toBeTrue();
    expect(isIssuedNgspiceQualification(qualification, tool)).toBeTrue();
  });

  test("rejects a version-correct executable that only reproduces one canned result", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-ngspice-qualification-"));
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
    expect(qualification.evidence.cases.map(({ status }) => status)).toEqual([
      "passed", "failed", "failed", "failed",
    ]);
    expect(qualification.evidence.cases[1]?.failure).toContain("unexpected vectors");
    expect(isIssuedNgspiceQualification(qualification, tool)).toBeFalse();
    const invocations = (await Bun.file(join(root, "invocations.jsonl")).text())
      .trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(4);
    expect(invocations.every((arguments_) => arguments_.includes("-n"))).toBeTrue();
  });

  test("rejects binary output and caller-forged serialized qualification authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-ngspice-qualification-binary-"));
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
    const root = await mkdtemp(join(tmpdir(), "fulmetry-ngspice-qualification-retained-"));
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
    expect((await readdir(directory)).sort()).toEqual([
      "dc-sweep", "operating-point", "rc-ac", "rc-transient",
    ]);
    for (const caseName of ["operating-point", "rc-transient", "rc-ac", "dc-sweep"]) {
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
    const root = await mkdtemp(join(tmpdir(), "fulmetry-ngspice-qualification-cancel-"));
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
