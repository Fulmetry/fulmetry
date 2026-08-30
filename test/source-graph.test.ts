import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjectSourceGraph } from "../src/project/source-graph";

const roots: string[] = [];

async function project(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "fulmetry-source-graph-"));
  roots.push(parent);
  const root = join(parent, "project");
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("verified project source graph", () => {
  test("discovers every literal transitive local module", async () => {
    const root = await project();
    await Bun.write(join(root, "src/board.ts"), "import './parts.ts'; export default []\n");
    await Bun.write(join(root, "src/parts.ts"), "export { value } from './value.ts'\n");
    await Bun.write(join(root, "src/value.ts"), "export const value = 1\n");
    expect(await discoverProjectSourceGraph(root, "src/board.ts")).toEqual([
      "src/board.ts",
      "src/parts.ts",
      "src/value.ts",
    ]);
  });

  test("rejects local imports that escape the project root", async () => {
    const root = await project();
    await Bun.write(join(root, "../outside.ts"), "export default []\n");
    await Bun.write(join(root, "src/board.ts"), "import '../../outside.ts'; export default []\n");
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "escapes the project root",
    );
  });

  test("rejects a local import that traverses a symlinked parent directory", async () => {
    const root = await project();
    await mkdir(join(root, "real"));
    await Bun.write(join(root, "real", "helper.ts"), "export const helper = 1\n");
    await symlink(
      join(root, "real"),
      join(root, "src", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await Bun.write(
      join(root, "src", "board.ts"),
      "import { helper } from './linked/helper.ts'; export default []; void helper\n",
    );

    await expect(discoverProjectSourceGraph(root, "src/board.ts"))
      .rejects.toThrow("must not traverse a symlink");
  });

  test("rejects computed module loading that static provenance cannot bind", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      "const name='helper'; const module=await import('./'+name+'.ts'); export default module.default\n",
    );
    await Bun.write(join(root, "src/helper.ts"), "export default []\n");
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "computed dynamic import",
    );
  });

  test("rejects unbound bare packages in verified circuit source", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      "import { formatSI } from 'format-si-prefix'; export default []; void formatSI\n",
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      /Cannot resolve import|unlocked package|unbound external package/,
    );
  });

  test("rejects a project-local package impersonating fulmetry", async () => {
    const root = await project();
    await mkdir(join(root, "node_modules/fulmetry"), { recursive: true });
    await Bun.write(
      join(root, "node_modules/fulmetry/package.json"),
      JSON.stringify({ name: "fulmetry", version: "999.0.0", exports: "./index.js" }),
    );
    await Bun.write(join(root, "node_modules/fulmetry/index.js"), "export const Board = class Fake {}\n");
    await Bun.write(
      join(root, "src/board.ts"),
      "import { Board } from 'fulmetry'; export default []; void Board\n",
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      /different physical package|Cannot find package root for @fulmetry\/fulmetry/,
    );
  });

  test.each([
    ["Bun.file('./hidden.json')", "Bun"],
    ["fetch('https://example.invalid/input')", "fetch"],
    ["process.env.HIDDEN_INPUT", "process"],
    ["globalThis['Bun'].file('./hidden.json')", "globalThis"],
    ["window['fetch']('https://example.invalid/input')", "window"],
    ["self['Deno'].readTextFile('./hidden.json')", "self"],
    ["new WebSocket('wss://example.invalid/input')", "WebSocket"],
    ["new EventSource('https://example.invalid/input')", "EventSource"],
    ["new XMLHttpRequest()", "XMLHttpRequest"],
    ["new ShadowRealm()", "ShadowRealm"],
  ])("rejects undeclared runtime input expression %s", async (expression, globalName) => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `void ${expression}; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      `runtime I/O global ${globalName}`,
    );
  });

  test.each([
    "async_hooks", "buffer", "child_process", "cluster", "constants",
    "dgram", "diagnostics_channel", "dns", "domain", "events", "ffi", "fs",
    "http", "http2", "https", "inspector", "jsc", "net", "os", "path",
    "perf_hooks", "punycode", "querystring", "readline", "sqlite", "stream",
    "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url",
    "util", "v8", "vm", "wasi", "worker_threads", "zlib",
  ])("rejects Bun's import-free module global %s", async (globalName) => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `void ${globalName}; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      `runtime I/O global ${globalName}`,
    );
  });

  test.each([
    "Buffer.allocUnsafe(8)",
    "new File([], 'board.json')",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)",
    "setTimeout(() => {}, 1)",
    "prompt('board?')",
  ])("rejects ambient runtime capability %s", async (expression) => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `void ${expression}; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "runtime I/O global",
    );
  });

  test.each([
    "new PerformanceMark('capture').startTime",
    "URL.createObjectURL(new Blob([]))",
    "new Request('https://example.invalid', { body: new FormData() })",
    "document.location.href",
  ])("rejects every non-allowlisted unbound runtime global in %s", async (expression) => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `void ${expression}; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "unbound runtime global",
    );
  });

  test("distinguishes lexical locals and property names from Bun globals", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `const fs = { path: 1 }; const path = fs.path; const Math = { random: () => 4 }; void Math.random(); export default [{ fs, path }]\n`,
    );
    expect(await discoverProjectSourceGraph(root, "src/board.ts")).toContain("src/board.ts");
  });

  test("rejects an unbound Bun global hidden in object shorthand", async () => {
    const root = await project();
    await Bun.write(join(root, "src/board.ts"), "export default { fs }\n");
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "runtime I/O global fs",
    );
  });

  test.each([
    "declare const fs: any; export default JSON.parse(fs.readFileSync('/tmp/board.json', 'utf8'))",
    "type fs = any; export default fs.readFileSync('/tmp/board.json', 'utf8')",
    "import type { AnyCircuitElement as fs } from 'fulmetry'; export default fs.readFileSync('/tmp/board.json', 'utf8')",
  ])("rejects erased TypeScript bindings that expose ambient globals", async (source) => {
    const root = await project();
    await mkdir(join(root, "node_modules"));
    await symlink(
      join(import.meta.dir, ".."),
      join(root, "node_modules", "fulmetry"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await Bun.write(join(root, "src/board.ts"), `${source}\n`);
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "runtime I/O global fs",
    );
  });

  test("rejects erased import-equals declarations before Bun can expose a global", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `import type fs = require("node:fs"); export default JSON.parse(fs.readFileSync("/tmp/board.json", "utf8"))\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "forbids import-equals declarations",
    );
  });

  test.each([
    `namespace fs { export type X = string }; export default JSON.parse(fs.readFileSync("/tmp/board.json", "utf8"))`,
    `namespace Date { export interface X {} }; export default Date.now()`,
  ])("rejects type-only namespaces before they can expose ambient globals", async (source) => {
    const root = await project();
    await Bun.write(join(root, "src/board.ts"), `${source}\n`);
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "forbids namespace and module declarations",
    );
  });

  test("rejects erased generic type parameters used as ambient runtime globals", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `function read<fs>() { return fs.readFileSync("/tmp/board.json", "utf8") }; export default read()\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "runtime I/O global fs",
    );
  });

  test("allows ordinary generic type parameters that are erased and never read as values", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `function identity<T>(value: T): T { return value }; export default identity([])\n`,
    );
    expect(await discoverProjectSourceGraph(root, "src/board.ts")).toContain("src/board.ts");
  });

  test.each(["Worker", "Date", "URL"])(
    "rejects an ambient runtime global recovered through JSX tag %s",
    async (globalName) => {
      const root = await project();
      await Bun.write(
        join(root, "src/board.tsx"),
        `const element = <${globalName} />; export default element.type\n`,
      );
      expect(discoverProjectSourceGraph(root, "src/board.tsx")).rejects.toThrow(
        globalName === "Date"
          ? "ambient nondeterminism global Date"
          : globalName === "Worker"
            ? "runtime I/O global Worker"
            : "unbound runtime global URL",
      );
    },
  );

  test("allows lowercase intrinsic JSX tags", async () => {
    const root = await project();
    await Bun.write(join(root, "src/board.tsx"), "export default <board />\n");
    expect(await discoverProjectSourceGraph(root, "src/board.tsx")).toContain("src/board.tsx");
  });

  test.each([
    ["Date.now()", "global Date"],
    ["performance.now()", "global performance"],
    ["crypto.randomUUID()", "global crypto"],
    ["Math.random()", "Math.random"],
    ["const random = Math.random; random()", "Math.random"],
    ["const math = Math; math.random()", "global Math"],
    ["new Intl.DateTimeFormat('en-CA').format()", "global Intl"],
    ["new WeakRef({})", "global WeakRef"],
  ])("rejects ambient circuit nondeterminism in %s", async (expression, reason) => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `${expression}; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(reason);
  });

  test("allows deterministic Math geometry operations", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `const distance = Math.hypot(Math.abs(-3), Math["max"](4, 5)); void distance; export default []\n`,
    );
    expect(await discoverProjectSourceGraph(root, "src/board.ts")).toContain("src/board.ts");
  });

  test("rejects constructor-based runtime evaluator escape hatches", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `const runtime = (() => {}).constructor("return " + "Bun")(); void runtime; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "constructor/evaluator access",
    );

    await Bun.write(
      join(root, "src/board.ts"),
      `const { "getPrototypeOf": gp, ["getOwn" + "PropertyDescriptor"]: gd } = Object; const F = gd(gp(() => {}), "constructor").value; void F; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "constructor/evaluator access",
    );

    await Bun.write(
      join(root, "src/board.ts"),
      `const key = "getPrototypeOf"; const { [key]: gp } = Object; void gp; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "constructor/evaluator access",
    );

    await Bun.write(
      join(root, "src/board.ts"),
      `const realm = { evaluate() {} }; realm.evaluate(); export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "constructor/evaluator access",
    );

    await Bun.write(
      join(root, "src/board.ts"),
      `const runtime = (() => {})["con" + "structor"]("return Bun")(); void runtime; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "constructor/evaluator access",
    );

    await Bun.write(
      join(root, "src/board.ts"),
      `const key = "constructor".slice(0); const runtime = (() => {})[key]; void runtime; export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "constructor/evaluator access",
    );
  });

  test("rejects import.meta runtime-loader access", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      `void import.meta.require("node:os"); export default []\n`,
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "runtime import.meta access",
    );
  });

  test("rejects Node and Bun runtime modules", async () => {
    const root = await project();
    await Bun.write(
      join(root, "src/board.ts"),
      "import { readFile } from 'node:fs/promises'; export default []; void readFile\n",
    );
    expect(discoverProjectSourceGraph(root, "src/board.ts")).rejects.toThrow(
      "runtime I/O package",
    );
  });

  test("allows only explicit authoring symbols from fulmetry and tscircuit", async () => {
    const root = await project();
    for (const source of [
      `import { createBuildInputSnapshot } from "fulmetry"; void createBuildInputSnapshot; export default []\n`,
      `import * as framework from "fulmetry"; void framework; export default []\n`,
      `import { runTscircuitCode } from "tscircuit"; void runTscircuitCode; export default []\n`,
      `const framework = await import("fulmetry"); void framework; export default []\n`,
    ]) {
      await Bun.write(join(root, "src/board.ts"), source);
      await expect(discoverProjectSourceGraph(root, "src/board.ts"), source)
        .rejects.toThrow(/non-authoring import|explicit named authoring imports|dynamic import/);
    }
    await mkdir(join(root, "node_modules"));
    await symlink(
      join(import.meta.dir, ".."),
      join(root, "node_modules", "fulmetry"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await Bun.write(
      join(root, "src/board.ts"),
      `import { Board, type AnyCircuitElement } from "fulmetry"; void Board; const value: AnyCircuitElement[] = []; export default value\n`,
    );
    expect(await discoverProjectSourceGraph(root, "src/board.ts")).toContain("src/board.ts");
  });
});
