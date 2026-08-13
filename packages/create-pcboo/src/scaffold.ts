// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, parse, resolve } from "node:path";
import { requireSupportedCreatePcbooRuntime } from "./runtime";

export interface ScaffoldOptions {
  readonly cwd: string;
  readonly directory: string;
  readonly install?: boolean;
  readonly pcbooPackageSpecifier?: string;
  readonly tscircuitPackageSpecifier?: string;
  /** @internal Deterministic test hook; the command-line creator never supplies it. */
  readonly beforeCommit?: () => Promise<void>;
}

export interface ScaffoldResult {
  readonly root: string;
  readonly installed: boolean;
  readonly files: readonly string[];
}

export const INCOMPLETE_SCAFFOLD_MARKER = ".pcboo-scaffold-incomplete";

function packageName(directory: string): string {
  const normalized = basename(directory).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "pcboo-project";
}

function lockfile(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    tscircuit: {
      version: "0.0.2261",
      integrity: "sha512-pwJzfkh5UFE7lFRaKQE5tUDdMd7A1bl+NhX2dG+BY2EEfvaMFVQDJJc+BcT/zM6BvkMepxZCNOCAJFzqhxiEUw==",
    },
    adapters: {
      gerber: "circuit-json-to-gerber@0.0.90",
      bom: "circuit-json-to-bom-csv@0.0.14",
      pickAndPlace: "circuit-json-to-pnp-csv@0.0.9",
      independentParser: "gerber-parser@4.2.7",
    },
    profiles: {
      "pcboo-baseline-2-4layer": {
        version: "1.2.0",
        digest: "sha256:22d9153319a6f38b50c920fb1866b10b1d2661b435f4b6aca221a1003ef31c02",
      },
    },
    assets: {},
    sourcing: {
      schemaVersion: 1,
      policy: null,
      selections: {},
    },
  }, null, 2)}\n`;
}

async function projectFiles(options: ScaffoldOptions): Promise<Readonly<Record<string, string>>> {
  const ownPackage = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version?: unknown };
  if (typeof ownPackage.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ownPackage.version)) {
    throw new Error("create-pcboo package version is invalid");
  }
  const pcboo = options.pcbooPackageSpecifier ?? `npm:@pcboo/pcboo@${ownPackage.version}`;
  const tscircuit = options.tscircuitPackageSpecifier ?? "0.0.2261";
  return Object.freeze({
    "bunfig.toml": `[install]\nlinker = "hoisted"\nbackend = "copyfile"\n`,
    "package.json": `${JSON.stringify({
      name: packageName(options.directory),
      version: "0.0.0",
      private: true,
      type: "module",
      packageManager: "bun@1.3.14",
      engines: { bun: "1.3.14" },
      scripts: {
        build: "pcboo build",
        check: "pcboo check",
        inspect: "pcboo inspect",
        dev: "pcboo dev",
        test: "pcboo test",
        "export:gerbers": "pcboo export gerbers",
      },
      dependencies: { pcboo, tscircuit },
      // A direct Node type pin also makes Bun's hoisting choice deterministic
      // for incompatible @types/node ranges inside the tscircuit closure.
      devDependencies: { "@types/bun": "1.3.14", "@types/node": "24.13.3" },
      // tscircuit's runtime closure contains open ranges for both packages.
      // Pin the exact graph PCBoo qualified so registry publication cannot
      // silently alter a newly scaffolded project's executable engine.
      overrides: {
        "@tscircuit/cli": "0.1.1858",
        "bun-match-svg": "0.0.15",
      },
    }, null, 2)}\n`,
    "pcboo.config.ts": `import { defineConfig } from "pcboo";\n\nexport default defineConfig({\n  entry: "circuit/board.ts",\n  outputDirectory: ".pcboo",\n  profiles: ["pcboo-baseline-2-4layer"],\n  boardRevision: "A",\n});\n`,
    "pcboo.lock": lockfile(),
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        types: ["bun"],
      },
      include: ["circuit/**/*.ts", "tests/**/*.ts"],
    }, null, 2)}\n`,
    ".gitignore": ".pcboo/\nnode_modules/\n.DS_Store\n",
    "circuit/board.ts": `import { Board, Circuit } from "pcboo";\nimport { addPowerIndicator } from "./components/power-indicator";\n\nexport default function createCircuit(): Circuit {\n  const circuit = new Circuit();\n  const board = new Board({ width: "30mm", height: "20mm", layers: 2 });\n  addPowerIndicator(board);\n  circuit.add(board);\n  return circuit;\n}\n`,
    "circuit/components/power-indicator.ts": `import { Led, PinHeader, Resistor, Trace, type Board } from "pcboo";\n\nexport function addPowerIndicator(board: Board): void {\n  board.add(new Resistor({ name: "R1", resistance: "1k", footprint: "0603", pcbX: -3, pcbY: 2 }));\n  board.add(new Led({ name: "D1", footprint: "0603", layer: "bottom", pcbX: 3, pcbY: 2, pcbRotation: 90 }));\n  board.add(new PinHeader({ name: "J1", pinCount: 2, footprint: "pinrow2_nosquareplating", pcbX: 0, pcbY: -2 }));\n  board.add(new Trace({ name: "VCC_INPUT", from: ".J1 > .pin1", to: "net.VCC", width: "0.2mm" }));\n  board.add(new Trace({ name: "VCC_RESISTOR", from: ".R1 > .pin2", to: "net.VCC", width: "0.2mm" }));\n  board.add(new Trace({\n    name: "LED_DRIVE",\n    from: ".R1 > .pin1",\n    to: ".D1 > .pin1",\n    width: "0.2mm",\n    pcbPath: [\n      { x: -3, y: 3 },\n      { x: -3, y: 3, via: true, fromLayer: "top", toLayer: "bottom" },\n      { x: -3, y: 3 },\n      { x: -3, y: 4 },\n      { x: 9, y: 4 },\n      { x: 9, y: 0.825 },\n    ],\n  }));\n  board.add(new Trace({ name: "GND_LED", from: ".D1 > .pin2", to: "net.GND", width: "0.2mm" }));\n  board.add(new Trace({ name: "GND_RETURN", from: ".J1 > .pin2", to: "net.GND", width: "0.2mm" }));\n}\n`,
    "circuit/constraints.ts": `export const boardIntent = Object.freeze({\n  description: "Keep explicit mechanical and placement intent in source control.",\n  layerCount: 2,\n});\n`,
    "tests/board.test.ts": `import { expect, test } from "bun:test";\nimport createCircuit from "../circuit/board";\n\ntest("defines one board and the intended J1 to R1 to D1 series topology", async () => {\n  const circuit = createCircuit();\n  await circuit.renderUntilSettled();\n  const circuitJson = circuit.getCircuitJson();\n  expect(circuitJson.filter(({ type }) => type === "pcb_board")).toHaveLength(1);\n  const components = circuitJson.filter((element) => element.type === "source_component");\n  const ports = circuitJson.filter((element) => element.type === "source_port");\n  const nets = circuitJson.filter((element) => element.type === "source_net");\n  const componentId = (name: string) => components.find((component) => component.name === name)?.source_component_id;\n  const key = (component: string, pin: string) => ports.find((port) => port.source_component_id === componentId(component) && port.name === pin)?.subcircuit_connectivity_map_key;\n  const netKey = (name: string) => nets.find((net) => net.name === name)?.subcircuit_connectivity_map_key;\n  const vcc = netKey("VCC");\n  const drive = key("R1", "pin1");\n  const ground = netKey("GND");\n  expect(vcc).toBeDefined();\n  expect(drive).toBeDefined();\n  expect(ground).toBeDefined();\n  expect(new Set([vcc, drive, ground]).size).toBe(3);\n  expect(key("J1", "pin1")).toBe(vcc);\n  expect(key("R1", "pin2")).toBe(vcc);\n  expect(key("D1", "pin1")).toBe(drive);\n  expect(key("D1", "pin2")).toBe(ground);\n  expect(key("J1", "pin2")).toBe(ground);\n});\n`,
    "AGENTS.md": `# PCBoo agent guide\n\n- Treat circuit TypeScript, pcboo.config.ts, pcboo.lock, tests, and intentionally vendored assets as source.\n- Never edit .pcboo output; regenerate it with PCBoo commands.\n- Run bun run build after source edits, bun run check for independent electrical and fabrication statuses, and bun run test for bounded functional test evidence.\n- Use bun run export:gerbers only for draft diagnostic files; its nonzero incomplete result is intentional. Run pcboo verify manufacturing separately before considering production promotion.\n- Project tests remain standard Bun .test.ts or .test.tsx files; do not introduce another test DSL.\n- Read the durable report path when terminal diagnostics are insufficient.\n- Fabrication, electrical, functional, standards, and sourcing statuses are independent; never infer one from another.\n- Do not describe draft output as production-ready or suppress a failed rule without a scoped, written waiver.\n`,
    "README.md": `# ${packageName(options.directory)}\n\nA composable TypeScript circuit project created with PCBoo.\n\n\`\`\`sh\nbun run build\nbun run check\nbun run test\nbun run export:gerbers\nbun run dev\n\`\`\`\n\nCircuit source lives in \`circuit/\`; tests live in \`tests/\` as ordinary Bun \`.test.ts\` or \`.test.tsx\` files. \`bun run test\` invokes the bounded PCBoo wrapper and records a separate functional status plus durable Bun/JUnit evidence. \`bun run export:gerbers\` emits only hash-bound draft manufacturing files and intentionally returns an incomplete status until the separate manufacturing verifier runs. Generated \`.pcboo/\` files are disposable and should not be edited. PCBoo is experimental, and a successful build alone does not establish electrical, functional, standards, sourcing, or manufacturing readiness. Choose and add a license for your own circuit source if you intend to publish it.\n`,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  const parsed = parse(path);
  let current = parsed.root;
  for (const segment of path.slice(parsed.root.length).split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Project directory cannot traverse symlink ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Project directory cannot traverse")) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function scaffoldPcbooProject(options: ScaffoldOptions): Promise<Readonly<ScaffoldResult>> {
  requireSupportedCreatePcbooRuntime();
  if (!options.directory.trim() || options.directory.includes("\0")) throw new TypeError("Project directory must be non-empty and contain no NUL byte");
  const canonicalCwd = await realpath(options.cwd);
  const target = resolve(canonicalCwd, options.directory);
  const parent = dirname(target);
  await rejectSymlinkAncestors(parent);
  if (await pathExists(target)) throw new Error(`Refusing to overwrite existing path ${target}`);
  await mkdir(parent, { recursive: true });
  const staging = resolve(parent, `.${basename(target)}.pcboo-${crypto.randomUUID()}.tmp`);
  const files = await projectFiles(options);
  let ownsTarget = false;
  try {
    await mkdir(staging);
    for (const [relativePath, contents] of Object.entries(files)) {
      const destination = resolve(staging, ...relativePath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents, { flag: "wx" });
    }
    if (options.install !== false) {
      const install = Bun.spawn([process.execPath, "install"], {
        cwd: staging,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await install.exited;
      if (exitCode !== 0) throw new Error(`bun install exited ${exitCode}`);
    }
    await options.beforeCommit?.();
    await mkdir(target);
    ownsTarget = true;
    await writeFile(resolve(target, INCOMPLETE_SCAFFOLD_MARKER), "PCBoo scaffold publication is incomplete. Remove this directory and run the creator again.\n", { flag: "wx" });
    const entries = (await readdir(staging)).sort((a, b) => {
      const rank = (name: string) => name === "pcboo.config.ts" ? 2 : name === "pcboo.lock" ? 1 : 0;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    for (const entry of entries) await rename(resolve(staging, entry), resolve(target, entry));
    await rm(resolve(target, INCOMPLETE_SCAFFOLD_MARKER));
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (ownsTarget) await rm(target, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ root: target, installed: options.install !== false, files: Object.freeze(Object.keys(files).sort()) });
}
