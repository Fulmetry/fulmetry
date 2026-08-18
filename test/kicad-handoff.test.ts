import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKicadPcb, parseKicadSch } from "kicadts";
import {
  createKicadHandoff,
  parseKicadCliVersionOutput,
  validateKicadHandoffLive,
  verifyKicadLiveInputEvidence,
  withKicadLiveValidation,
  reconcileKicadHandoffSemantics,
} from "../src/kicad";
import { KICAD_ARTIFACT_FILE_BYTES_LIMIT } from "../src/kicad/exact-flat-files";
import { manufacturingFixture } from "./fixtures/manufacturing";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function runDirectory(name: string): Promise<{ outputRoot: string; runDirectory: string }> {
  const outputRoot = await mkdtemp(join(tmpdir(), `pcboo-kicad-${name}-`));
  roots.push(outputRoot);
  const directory = join(outputRoot, "run");
  await mkdir(directory);
  return { outputRoot, runDirectory: directory };
}

async function fakeKicad(root: string, mode: "ok" | "unsupported" | "lookalike" | "nonzero" | "timeout" | "oversize" | "self-mutate" | "child" = "ok"): Promise<string> {
  const executable = join(root, "fake-kicad-cli");
  const action = mode === "timeout" ? "await new Promise(() => {})"
    : mode === "child" ? `try{const child=Bun.spawn({cmd:[process.execPath,'-e','await new Promise(()=>{})'],stdin:'ignore',stdout:'ignore',stderr:'ignore'});await Bun.write(${JSON.stringify(join(root, "child.pid"))},String(child.pid))}catch{await Bun.write(${JSON.stringify(join(root, "child.pid"))},'blocked')}await new Promise(()=>{})`
    : mode === "oversize" ? "process.stdout.write('x'.repeat(4096))"
    : mode === "nonzero" ? "process.stderr.write('failure');process.exit(7)"
    : mode === "lookalike" ? "console.log('KiCad 10.0.5')"
    : mode === "unsupported" ? "console.log('999.0.0')"
    : mode === "self-mutate" ? "await Bun.write(process.argv[1], 'changed');console.log('10.0.5')"
    : `if(process.argv.includes('version')){console.log('10.0.5')}else{const args=process.argv.slice(2);const outputIndex=args.indexOf('--output');if(outputIndex<0)process.exit(87);const output=args[outputIndex+1];if(args.includes('gerbers')){const {mkdir}=await import('node:fs/promises');await mkdir(output,{recursive:true});await Bun.write(output+'/agent-board-F_Cu.gbr','G04 fake qualified gerber*%\\nM02*\\n')}else if(args.includes('erc')||args.includes('drc')){await Bun.write(output,JSON.stringify({schema:'fake-kicad-qualification',violations:[]}))}else if(args.includes('netlist')){await Bun.write(output,'(export (version D))\\n')}else process.exit(86)}`;
  await Bun.write(executable, `#!${process.execPath}\n${mode === "ok" ? action : `if(!process.argv.includes('version'))process.exit(88);${action}`}\n`);
  await chmod(executable, 0o700);
  return executable;
}

describe("detached KiCad handoff", () => {
  test("emits deterministic offline-parseable project files with honest qualification", async () => {
    const circuitJson = await manufacturingFixture(2);
    const first = await createKicadHandoff(circuitJson, { projectName: "agent-board" });
    const second = await createKicadHandoff(circuitJson, { projectName: "agent-board" });
    expect(first).toEqual(second);
    expect(first.files.map(({ path }) => path)).toEqual([
      "agent-board.kicad_pcb",
      "agent-board.kicad_pro",
      "agent-board.kicad_sch",
    ]);
    for (const file of first.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      if (file.path.endsWith(".kicad_pcb")) expect(() => parseKicadPcb(file.content)).not.toThrow();
      if (file.path.endsWith(".kicad_sch")) expect(() => parseKicadSch(file.content)).not.toThrow();
      if (file.path.endsWith(".kicad_pro")) expect(() => JSON.parse(file.content)).not.toThrow();
    }
    expect(first.report).toMatchObject({
      lifecycle: "detached-downstream-handoff",
      deterministic: true,
      offlineParse: { schematic: "passed", pcb: "passed", projectJson: "passed" },
      liveKiCadValidation: { state: "unavailable", supportedMajors: [10] },
      semanticReconciliation: {
        state: "passed", layerCount: 2, copperLayers: ["F.Cu", "B.Cu"],
        counts: { components: 3, schematicSymbols: 3, nets: 3, traces: 9, vias: 2, platedHoles: 2, nonPlatedHoles: 1 },
      },
    });
    expect(first.report.semanticReconciliation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.report.mapping.some(({ disposition }) => disposition === "exact")).toBeTrue();
    expect(first.report.mapping.find(({ circuitJsonType }) => circuitJsonType === "pcb_trace")?.disposition).toBe("exact");
    expect(first.report.limitations.join(" ")).toContain("never synchronized back");
  });

  test("reconciles four-layer net, trace, via, hole, outline, and coordinate semantics", async () => {
    const circuitJson = await manufacturingFixture(4);
    const handoff = await createKicadHandoff(circuitJson, { projectName: "semantic-four-layer" });
    expect(handoff.report.semanticReconciliation).toMatchObject({
      state: "passed",
      layerCount: 4,
      copperLayers: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"],
      board: { widthMm: 20, heightMm: 15, sourceCenter: { x: 0, y: 0 }, kicadCenter: { x: 100, y: 100 } },
      counts: { components: 3, schematicSymbols: 3, nets: 3, traces: 11, vias: 2, platedHoles: 2, nonPlatedHoles: 1 },
      componentReferences: ["D1", "J1", "R1"],
      schematicNetNames: ["GND", "N1", "N2"],
      traceLayers: ["B.Cu", "F.Cu", "In1.Cu", "In2.Cu"],
    });
    expect(handoff.report.semanticReconciliation.state).toBe("passed");
    if (handoff.report.semanticReconciliation.state !== "passed") throw new Error("expected passed semantic reconciliation");
    expect(handoff.report.semanticReconciliation.netNames).toContain("GND");
  });

  test("reconciles four-layer plated routed slots without flattening their drill shape", async () => {
    const circuitJson = await manufacturingFixture(4);
    const hole = circuitJson.find((element) => element.type === "pcb_plated_hole");
    if (hole?.type !== "pcb_plated_hole") throw new Error("Fixture PTH missing");
    const mutable = hole as unknown as Record<string, unknown>;
    delete mutable.hole_diameter;
    delete mutable.outer_diameter;
    Object.assign(mutable, {
      shape: "rotated_pill_hole_with_rect_pad",
      hole_width: 0.6,
      hole_height: 1.2,
      rect_pad_width: 1.1,
      rect_pad_height: 1.8,
      rect_border_radius: 0.55,
    });

    const handoff = await createKicadHandoff(circuitJson, { projectName: "semantic-slot" });
    expect(handoff.report.semanticReconciliation).toMatchObject({
      state: "passed",
      layerCount: 4,
      counts: { platedHoles: 2 },
    });
    const board = handoff.files.find(({ path }) => path.endsWith(".kicad_pcb"))?.content ?? "";
    expect(board).toContain("(drill oval 0.6 1.2)");
  });

  test("rejects independently parsed handoffs with removed or disconnected four-layer semantics", async () => {
    const circuitJson = await manufacturingFixture(4);
    const handoff = await createKicadHandoff(circuitJson, { projectName: "semantic-negative" });
    const mutateBoard = (replacement: (content: string) => string) => handoff.files.map((file) =>
      file.path.endsWith(".kicad_pcb") ? { ...file, content: replacement(file.content) } : file,
    );
    const board = handoff.files.find(({ path }) => path.endsWith(".kicad_pcb"))!.content;
    const innerSegment = /\n  \(segment\n(?:(?!\n  \(segment|\n  \(via|\n\)).)*?\n    \(layer In1\.Cu\)(?:(?!\n  \(segment|\n  \(via|\n\)).)*?\n  \)/su;
    expect(innerSegment.test(board)).toBeTrue();
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateBoard((content) => content.replace(innerSegment, ""))))
      .toThrow(/trace segments|In1\.Cu/);
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateBoard((content) => content.replace(/\(net 1 "GND"\)/u, '(net 1 "BROKEN")'))))
      .toThrow("net names differ");
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateBoard((content) => content.replace(/\n  \(via\n(?:(?!\n  \(via|\n\)).)*?\n  \)/su, ""))))
      .toThrow("KiCad vias count");
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateBoard((content) => content.replace("(1 \"In1.Cu\" signal)", "(1 \"In2.Cu\" signal)").replace("(2 \"In2.Cu\" signal)", "(2 \"In1.Cu\" signal)"))))
      .toThrow("copper layer order");
  });

  test("rejects plausible but wrong schematic and footprint identities, values, wires, and outlines", async () => {
    const circuitJson = await manufacturingFixture(4);
    const handoff = await createKicadHandoff(circuitJson, { projectName: "semantic-adversarial" });
    const mutateFile = (suffix: string, replacement: (content: string) => string) => handoff.files.map((file) =>
      file.path.endsWith(suffix) ? { ...file, content: replacement(file.content) } : file,
    );

    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateFile(
      ".kicad_sch",
      (content) => content.replaceAll('Device:boxresistor_right', 'Device:boxresistor_left'),
    ))).toThrow("schematic symbol identity");
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateFile(
      ".kicad_pcb",
      (content) => content.replace('tscircuit:resistor_res0603', 'tscircuit:resistor_res0805'),
    ))).toThrow("footprint library identity");
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateFile(
      ".kicad_pcb",
      (content) => content.replace('(property "Value" "LED"', '(property "Value" "WRONG"'),
    ))).toThrow("value was not preserved");
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateFile(
      ".kicad_sch",
      (content) => content.replace(/\n  \(wire\n[\s\S]*?\n  \)/u, ""),
    ))).toThrow("schematic wires count");
    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateFile(
      ".kicad_sch",
      (content) => content.replace(/(\n  \(wire\n\s+\(pts\n\s+\(xy )(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)(\)\n\s+\(xy )(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/u,
        (_match, prefix, x1, y1, middle, x2, y2) => `${prefix}${Number(x1) + 1} ${y1}${middle}${Number(x2) + 1} ${y2}`),
    ))).toThrow("schematic wires");

    expect(() => reconcileKicadHandoffSemantics(circuitJson, mutateFile(
      ".kicad_pcb",
      (content) => content
        .replace("(start 90 107.5)\n    (end 110 107.5)", "(start 90 107.5)\n    (end 110 92.5)")
        .replace("(start 110 107.5)\n    (end 110 92.5)", "(start 110 92.5)\n    (end 90 107.5)")
        .replace("(start 110 92.5)\n    (end 90 92.5)", "(start 110 107.5)\n    (end 90 92.5)")
        .replace("(start 90 92.5)\n    (end 90 107.5)", "(start 90 92.5)\n    (end 110 107.5)"),
    ))).toThrow(/diagonal|duplicate|closed/);
  });

  test("does not grant exact mappings when a four-layer plated hole declares only outer layers", async () => {
    const circuitJson = structuredClone(await manufacturingFixture(4)) as any[];
    for (const element of circuitJson) {
      if (element.type === "pcb_plated_hole") element.layers = ["top", "bottom"];
    }
    const handoff = await createKicadHandoff(circuitJson, { projectName: "semantic-plated-layer-attack" });
    expect(handoff.report.semanticReconciliation).toMatchObject({
      state: "failed",
      message: expect.stringContaining("span every copper layer"),
    });
    expect(handoff.report.mapping.some(({ disposition }) => disposition === "exact")).toBeFalse();
  });

  test("rejects unsafe project names before conversion", async () => {
    const circuitJson = await manufacturingFixture(2);
    await expect(createKicadHandoff(circuitJson, { projectName: "../escape" })).rejects.toThrow("filename-safe");
  });

  test("parses only documented plain numeric kicad-cli version output", () => {
    expect(parseKicadCliVersionOutput("10.0.5\n")).toBe("10.0.5");
    expect(parseKicadCliVersionOutput("9.0.9")).toBe("9.0.9");
    expect(parseKicadCliVersionOutput("KiCad 10.0.5")).toBeNull();
    expect(parseKicadCliVersionOutput("10.0.5\nspoof")).toBeNull();
  });

  test("keeps missing and invalid executable paths unavailable on every platform", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const missingRun = await runDirectory("missing");
    const missing = await validateKicadHandoffLive({ handoff, ...missingRun, executable: null });
    expect(missing).toMatchObject({
      state: "unavailable", supportedMajors: [10], detectionCandidateMajors: [9, 10],
      evidence: { execution: { state: "not-run-tool-unavailable", commands: [], outputs: [] } },
    });
    const invalidRun = await runDirectory("invalid-path");
    const invalid = await validateKicadHandoffLive({ handoff, ...invalidRun, executable: join(invalidRun.outputRoot, "missing-kicad-cli") });
    expect(invalid.state).toBe("unavailable");
    expect(invalid.message).toContain("Executable identity failed");
  });

  test.skipIf(process.platform === "win32")("keeps unsupported and fake candidate tools distinct and fail-closed", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    for (const mode of ["unsupported", "lookalike"] as const) {
      const paths = await runDirectory(mode);
      const result = await validateKicadHandoffLive({ handoff, ...paths, executable: await fakeKicad(paths.outputRoot, mode) });
      expect(result.state).toBe("unsupported");
      expect(result.supportedMajors).toEqual([10]);
      expect(result.evidence?.execution.commands).toEqual([]);
    }

    const candidateRun = await runDirectory("candidate");
    const candidate = await validateKicadHandoffLive({ handoff, ...candidateRun, executable: await fakeKicad(candidateRun.outputRoot) });
    expect(candidate).toMatchObject({
      state: "unqualified", supportedMajors: [10],
      evidence: {
        tool: { name: "kicad-cli", version: "10.0.5", major: 10, platform: process.platform, architecture: process.arch },
        execution: { state: "not-run-unqualified-identity", commands: [], outputs: [] },
      },
    });
    expect(candidate.evidence?.tool?.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.evidence?.tool?.versionProbe.stdoutSha256)
      .toBe(new Bun.CryptoHasher("sha256").update("10.0.5\n").digest("hex"));
    expect(withKicadLiveValidation(handoff, candidate).report.mapping.some(({ disposition }) => disposition === "exact")).toBeTrue();
  });

  test.skipIf(process.platform === "win32")("bounds nonzero, timeout, and oversized version probes without claiming validation", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    for (const mode of ["nonzero", "timeout", "oversize"] as const) {
      const paths = await runDirectory(mode);
      const result = await validateKicadHandoffLive({
        handoff, ...paths, executable: await fakeKicad(paths.outputRoot, mode),
        timeoutMs: mode === "timeout" ? 40 : mode === "oversize" ? 5_000 : 1_000,
        outputLimit: 128,
      });
      expect(result.state, mode).toBe("unavailable");
      expect(result.evidence?.execution.commands).toEqual([]);
      expect(result.message).toMatch(mode === "nonzero" ? /exited 7/ : mode === "timeout" ? /exceeded 40 ms/ : /exceeded 128 bytes/);
    }
  });

  test.skipIf(process.platform === "win32")("cancellation terminates the kicad-cli version-probe process tree", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const paths = await runDirectory("cancel-tree");
    const executable = await fakeKicad(paths.outputRoot, "child");
    const controller = new AbortController();
    const pending = validateKicadHandoffLive({ handoff, ...paths, executable, signal: controller.signal, timeoutMs: 5_000 });
    const pidPath = join(paths.outputRoot, "child.pid");
    for (let attempt = 0; attempt < 100 && !await Bun.file(pidPath).exists(); attempt += 1) await Bun.sleep(10);
    expect(await Bun.file(pidPath).exists()).toBeTrue();
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    const childIdentity = await Bun.file(pidPath).text();
    if (childIdentity === "blocked") {
      expect(process.platform).toBe("darwin");
      return;
    }
    const childPid = Number(childIdentity);
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBeTrue();
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try { process.kill(childPid, 0); await Bun.sleep(20); } catch { alive = false; }
    }
    expect(alive).toBeFalse();
  });

  test("binds evidence to the exact circuit and handoff set and rejects replay or stale inputs", async () => {
    const firstCircuit = await manufacturingFixture(2);
    const secondCircuit = structuredClone(firstCircuit) as any[];
    const board = secondCircuit.find(({ type }) => type === "pcb_board");
    board.width += 1;
    const first = await createKicadHandoff(firstCircuit, { projectName: "agent-board" });
    const second = await createKicadHandoff(secondCircuit as any, { projectName: "agent-board" });
    const firstRun = await runDirectory("replay-a");
    const secondRun = await runDirectory("replay-b");
    const firstEvidence = await validateKicadHandoffLive({ handoff: first, ...firstRun, executable: null });
    const secondEvidence = await validateKicadHandoffLive({ handoff: second, ...secondRun, executable: null });
    expect(firstEvidence.evidence?.source.circuitDigest).not.toBe(secondEvidence.evidence?.source.circuitDigest);
    expect(firstEvidence.evidence?.input.artifactSetSha256).not.toBe(secondEvidence.evidence?.input.artifactSetSha256);
    expect(() => withKicadLiveValidation(second, firstEvidence)).toThrow("circuit digest");

    const sameCircuitDifferentFiles = await createKicadHandoff(firstCircuit, { projectName: "different-project" });
    expect(sameCircuitDifferentFiles.report.circuitDigest).toBe(first.report.circuitDigest);
    expect(() => withKicadLiveValidation(sameCircuitDifferentFiles, firstEvidence)).toThrow("artifact set");

    const originalMap = Array.prototype.map;
    let acceptedWithPoisonedMap = false;
    try {
      Array.prototype.map = function () {
        return firstEvidence.evidence?.input.artifacts as never;
      };
      try {
        withKicadLiveValidation(sameCircuitDifferentFiles, firstEvidence);
        acceptedWithPoisonedMap = true;
      } catch {
        // Expected: authority checks do not depend on the poisoned method.
      }
    } finally {
      Array.prototype.map = originalMap;
    }
    expect(acceptedWithPoisonedMap).toBeFalse();

    const forged = {
      ...firstEvidence,
      state: "qualified" as const,
      message: "caller claims live ERC and DRC passed",
    };
    expect(() => withKicadLiveValidation(first, forged)).toThrow("not produced by PCBoo's live validator");
    expect(() => withKicadLiveValidation(first, structuredClone(firstEvidence))).toThrow("not produced by PCBoo's live validator");

    const staleRun = await runDirectory("stale");
    await expect(validateKicadHandoffLive({
      handoff: first, ...staleRun, executable: null,
      beforeFinalInputSnapshot: async (directory) => {
        const path = join(directory, "agent-board.kicad_pcb");
        await chmod(path, 0o600);
        await Bun.write(path, "changed");
      },
    })).rejects.toThrow(/changed|snapshot|artifact set/i);
  });

  test("rejects cloned or forged handoff envelopes even when their bytes and claimed digests are internally consistent", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const cloned = structuredClone(handoff);
    const cloneRun = await runDirectory("cloned-envelope");
    await expect(validateKicadHandoffLive({ handoff: cloned, ...cloneRun, executable: null }))
      .rejects.toThrow("not created by this PCBoo runtime");

    const forged = structuredClone(handoff) as any;
    forged.report.mapping[0].disposition = "exact";
    forged.report.mapping[0].reason = "caller claims an exact mapping";
    forged.report.files = forged.files.map(({ path, sha256 }: { path: string; sha256: string }) => ({ path, sha256 }));
    const forgedRun = await runDirectory("forged-envelope");
    await expect(validateKicadHandoffLive({ handoff: forged, ...forgedRun, executable: null }))
      .rejects.toThrow("not created by this PCBoo runtime");
    expect(await Bun.file(join(forgedRun.runDirectory, "kicad-live-validation")).exists()).toBeFalse();
  });

  test("rejects recursive extras and symlink substitution in the isolated live input", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const extraRun = await runDirectory("extra");
    await expect(validateKicadHandoffLive({
      handoff, ...extraRun, executable: null,
      beforeFinalInputSnapshot: async (directory) => {
        await mkdir(join(directory, "nested"));
        await Bun.write(join(directory, "nested", "spoof"), "spoof");
      },
    })).rejects.toThrow("artifact set mismatch");
    const oversizedRun = await runDirectory("oversized-input");
    await expect(validateKicadHandoffLive({
      handoff, ...oversizedRun, executable: null,
      beforeFinalInputSnapshot: async (directory) => {
        const path = join(directory, "agent-board.kicad_pcb");
        await chmod(path, 0o600);
        await truncate(path, KICAD_ARTIFACT_FILE_BYTES_LIMIT + 1);
      },
    })).rejects.toThrow(`exceeds ${KICAD_ARTIFACT_FILE_BYTES_LIMIT} bytes`);
    if (process.platform !== "win32") {
      const symlinkRun = await runDirectory("symlink");
      await expect(validateKicadHandoffLive({
        handoff, ...symlinkRun, executable: null,
        beforeFinalInputSnapshot: async (directory) => {
          await rm(join(directory, "agent-board.kicad_pcb"));
          await symlink("agent-board.kicad_sch", join(directory, "agent-board.kicad_pcb"));
        },
      })).rejects.toThrow("symlink");

      const rootSwapRun = await runDirectory("input-root-symlink");
      await expect(validateKicadHandoffLive({
        handoff, ...rootSwapRun, executable: null,
        beforeFinalInputSnapshot: async (directory) => {
          const moved = `${directory}-moved`;
          await rename(directory, moved);
          await symlink("input-moved", directory);
        },
      })).rejects.toThrow("not a real directory");
    }
  });

  test("rejects outside, sibling, project-source, and symlinked run authorities before creating outputs", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const parent = await mkdtemp(join(tmpdir(), "pcboo-kicad-authority-"));
    roots.push(parent);
    const outputRoot = join(parent, "output");
    const sibling = join(parent, "sibling");
    await mkdir(outputRoot);
    await mkdir(sibling);
    await expect(validateKicadHandoffLive({ handoff, outputRoot, runDirectory: sibling, executable: null }))
      .rejects.toThrow("strict child");
    await expect(lstat(join(sibling, "kicad-live-validation"))).rejects.toThrow();

    const projectRoot = join(parent, "project");
    const sourceRun = join(projectRoot, "src");
    await mkdir(sourceRun, { recursive: true });
    await expect(validateKicadHandoffLive({
      handoff, projectRoot, outputRoot: projectRoot, runDirectory: sourceRun, executable: null,
    })).rejects.toThrow("authored project root");
    await expect(lstat(join(sourceRun, "kicad-live-validation"))).rejects.toThrow();

    if (process.platform !== "win32") {
      const actualRun = join(outputRoot, "actual-run");
      const linkedRun = join(outputRoot, "linked-run");
      await mkdir(actualRun);
      await symlink("actual-run", linkedRun);
      await expect(validateKicadHandoffLive({ handoff, outputRoot, runDirectory: linkedRun, executable: null }))
        .rejects.toThrow("symlink-free");
      await expect(lstat(join(actualRun, "kicad-live-validation"))).rejects.toThrow();

      const actualAncestor = join(outputRoot, "actual-ancestor");
      const ancestorRun = join(actualAncestor, "run");
      const linkedAncestor = join(outputRoot, "linked-ancestor");
      await mkdir(ancestorRun, { recursive: true });
      await symlink("actual-ancestor", linkedAncestor);
      await expect(validateKicadHandoffLive({
        handoff, outputRoot, runDirectory: join(linkedAncestor, "run"), executable: null,
      })).rejects.toThrow("symlink-free");
      await expect(lstat(join(ancestorRun, "kicad-live-validation"))).rejects.toThrow();
    }
  });

  test("requires the configured output authority and rejects authored subtrees", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const projectRoot = await mkdtemp(join(tmpdir(), "pcboo-kicad-project-authority-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, "src/generated/runs/source-overlap"), { recursive: true });
    await mkdir(join(projectRoot, ".pcboo/runs/valid"), { recursive: true });
    await mkdir(join(projectRoot, ".other"));
    await Bun.write(join(projectRoot, "src/board.ts"), "export default []\n");
    await Bun.write(join(projectRoot, "pcboo.config.ts"), "export default {}\n");
    await Bun.write(join(projectRoot, "pcboo.lock"), "{}\n");
    const protectedInputPaths = ["src/board.ts", "pcboo.config.ts", "pcboo.lock"];

    await expect(validateKicadHandoffLive({
      handoff,
      projectRoot,
      outputRoot: join(projectRoot, "src/generated"),
      runDirectory: join(projectRoot, "src/generated/runs/source-overlap"),
      configuredOutputDirectory: "src/generated",
      protectedInputPaths,
      executable: null,
    })).rejects.toThrow("inside authored input subtree src");

    await expect(validateKicadHandoffLive({
      handoff,
      projectRoot,
      outputRoot: join(projectRoot, ".pcboo"),
      runDirectory: join(projectRoot, ".pcboo/runs/valid"),
      configuredOutputDirectory: ".other",
      protectedInputPaths,
      executable: null,
    })).rejects.toThrow("does not match the configured output directory");

    const valid = await validateKicadHandoffLive({
      handoff,
      projectRoot,
      outputRoot: join(projectRoot, ".pcboo"),
      runDirectory: join(projectRoot, ".pcboo/runs/valid"),
      configuredOutputDirectory: ".pcboo",
      protectedInputPaths,
      executable: null,
    });
    await expect(verifyKicadLiveInputEvidence(valid)).resolves.toBeUndefined();
  });

  test("rejects output and input directory identity swaps before returning evidence", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const inputSwap = await runDirectory("input-identity-swap");
    await expect(validateKicadHandoffLive({
      handoff,
      ...inputSwap,
      executable: null,
      beforeFinalInputSnapshot: async (directory) => {
        await rename(directory, `${directory}-moved`);
        await mkdir(directory);
      },
    })).rejects.toThrow("input directory identity changed");

    const outputSwap = await runDirectory("output-identity-swap");
    const movedOutput = `${outputSwap.outputRoot}-moved`;
    roots.push(movedOutput);
    await expect(validateKicadHandoffLive({
      handoff,
      ...outputSwap,
      executable: null,
      beforeFinalInputSnapshot: async () => {
        await rename(outputSwap.outputRoot, movedOutput);
        await mkdir(outputSwap.outputRoot);
      },
    })).rejects.toThrow("configured output root identity changed");
  });

  test("writes no KiCad input bytes when output or run authority is swapped at the pre-write hook", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    for (const target of ["output", "run"] as const) {
      const paths = await runDirectory(`pre-write-${target}-swap`);
      const swapPath = target === "output" ? paths.outputRoot : paths.runDirectory;
      const movedPath = `${swapPath}-moved`;
      if (target === "output") roots.push(movedPath);
      await expect(validateKicadHandoffLive({
        handoff,
        ...paths,
        executable: null,
        beforeLiveInputWrite: async () => {
          await rename(swapPath, movedPath);
          await mkdir(swapPath);
        },
      })).rejects.toThrow(target === "output" ? "output root identity changed" : "run directory identity changed");
      for (const directory of [swapPath, movedPath]) {
        const entries = await readdir(directory, { recursive: true });
        expect(entries.some((entry) => String(entry).includes(".kicad_")), `${target}:${directory}`).toBeFalse();
      }
    }
  });

  test.skipIf(process.platform === "win32")("detects executable byte changes and stays closed under Set prototype poisoning", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const staleToolRun = await runDirectory("stale-tool");
    const selfMutating = await validateKicadHandoffLive({
      handoff, ...staleToolRun, executable: await fakeKicad(staleToolRun.outputRoot, "self-mutate"),
    });
    expect(selfMutating.state).toBe("unavailable");
    expect(selfMutating.message).toMatch(/changed|identity/i);

    const replacedToolRun = await runDirectory("replaced-tool");
    const replacedExecutable = await fakeKicad(replacedToolRun.outputRoot);
    await expect(validateKicadHandoffLive({
      handoff,
      ...replacedToolRun,
      executable: replacedExecutable,
      beforeFinalInputSnapshot: async () => {
        await Bun.write(replacedExecutable, "replaced after probe");
      },
    })).rejects.toThrow("changed after the version probe");

    const poisonRun = await runDirectory("poison");
    const original = Set.prototype.has;
    let result;
    try {
      result = await validateKicadHandoffLive({
        handoff, ...poisonRun, executable: await fakeKicad(poisonRun.outputRoot),
        beforeQualificationCheck: () => {
          Set.prototype.has = (() => true) as typeof Set.prototype.has;
        },
      });
    } finally {
      Set.prototype.has = original;
    }
    expect(result.state).toBe("unqualified");
    expect(result.supportedMajors).toEqual([10]);
  });

  test("rejects forged live evidence under WeakSet prototype poisoning", async () => {
    const handoff = await createKicadHandoff(await manufacturingFixture(2), { projectName: "agent-board" });
    const clonedHandoff = structuredClone(handoff);
    const forged = {
      state: "qualified" as const,
      supportedMajors: [] as const,
      message: "forged qualification",
    };
    const originalHas = WeakSet.prototype.has;
    const originalAdd = WeakSet.prototype.add;
    try {
      WeakSet.prototype.has = (() => true) as typeof WeakSet.prototype.has;
      WeakSet.prototype.add = (function (this: WeakSet<object>) { return this; }) as typeof WeakSet.prototype.add;
      expect(() => withKicadLiveValidation(handoff, forged)).toThrow("not produced by PCBoo's live validator");
      const paths = await runDirectory("weakset-handoff-poison");
      await expect(validateKicadHandoffLive({ handoff: clonedHandoff, ...paths, executable: null }))
        .rejects.toThrow("not created by this PCBoo runtime");
    } finally {
      WeakSet.prototype.has = originalHas;
      WeakSet.prototype.add = originalAdd;
    }
  });
});
