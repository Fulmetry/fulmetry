import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateProjectCircuitTwice } from "../src/project/evaluate";

const roots: string[] = [];

async function project(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fulmetry-evaluate-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await Bun.write(join(root, "src/board.ts"), source);
  await Bun.write(join(root, "fulmetry.config.ts"), "export default { entry: 'src/board.ts' }\n");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded fresh-process project evaluation", () => {
  test("normalizes unit-bearing source values left as strings by the pinned emitter", async () => {
    const root = await project(`
      import { Board, Circuit, Inductor } from "tscircuit";
      const circuit = new Circuit();
      const board = new Board({ width: "10mm", height: "10mm" });
      circuit.add(board);
      board.add(new Inductor({ name: "LUNIT", inductance: "4mH", footprint: "0603" }));
      export default circuit;
    `);
    await mkdir(join(root, "node_modules"));
    await symlink(
      join(import.meta.dir, "../node_modules/tscircuit"),
      join(root, "node_modules/tscircuit"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const evaluated = await evaluateProjectCircuitTwice(root);
    const inductor = evaluated.circuitJson.find(
      (element) => element.type === "source_component" && element.name === "LUNIT",
    );
    expect(inductor).toMatchObject({ type: "source_component", inductance: 0.004 });
    expect(evaluated.canonicalJson).toContain('"inductance":0.004');
    expect(evaluated.canonicalJson).not.toContain('"inductance":"4mH"');
  });

  test("terminates an entry that never settles", async () => {
    const root = await project("while (true) {}\nexport default []\n");
    const started = performance.now();
    await expect(evaluateProjectCircuitTwice(root, { timeoutMs: 100 })).rejects.toThrow("exceeded 100 ms");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("terminates oversized output instead of buffering it without limit", async () => {
    const root = await project("process.stdout.write('x'.repeat(4096))\nexport default []\n");
    await expect(evaluateProjectCircuitTwice(root, { outputLimit: 1024 })).rejects.toThrow("exceeded 1024 bytes");
  });

  test("propagates cancellation to the evaluation process", async () => {
    const root = await project("while (true) {}\nexport default []\n");
    const controller = new AbortController();
    const pending = evaluateProjectCircuitTwice(root, { timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 75);
    await expect(pending).rejects.toThrow("cancelled");
  });

  test("does not echo entry stderr into a caller-visible error", async () => {
    const secret = "fulmetry-entry-secret-do-not-echo";
    const root = await project(`process.stderr.write(${JSON.stringify(secret)}); throw new Error(${JSON.stringify(secret)});\n`);
    let message = "";
    try {
      await evaluateProjectCircuitTwice(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("project stderr is not echoed");
    expect(message).not.toContain(secret);
  });
});
