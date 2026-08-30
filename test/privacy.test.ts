import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../src/cli/runner";
import { MANUFACTURING_ADAPTER_VERSIONS } from "../src/manufacturing/export";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import {
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
} from "../src/project/lock";

const temporaryRoots: string[] = [];

function minimalBoardCircuitFixture(): unknown[] {
  return [
    { type: "source_group", source_group_id: "source_group_0", subcircuit_id: "subcircuit_source_group_0", is_subcircuit: true },
    { type: "source_board", source_board_id: "source_board_0", source_group_id: "source_group_0" },
    {
      type: "pcb_board", pcb_board_id: "pcb_board_0", source_board_id: "source_board_0",
      center: { x: 0, y: 0 }, width: 10, height: 10, thickness: 1.4, num_layers: 2, material: "fr4",
    },
  ];
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fulmetry-privacy-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "circuit"));
  await mkdir(join(root, "node_modules"));
  await symlink(
    join(import.meta.dir, "../node_modules/tscircuit"),
    join(root, "node_modules/tscircuit"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await Bun.write(
    join(root, "circuit/board.ts"),
    `export default ${JSON.stringify(minimalBoardCircuitFixture())};\n`,
  );
  await Bun.write(
    join(root, "fulmetry.config.ts"),
    `export default ${JSON.stringify({
      entry: "circuit/board.ts",
      profiles: [BASELINE_FABRICATION_PROFILE.name],
    })};\n`,
  );
  await Bun.write(
    join(root, "fulmetry.lock"),
    `${JSON.stringify({
      schemaVersion: 1,
      tscircuit: {
        version: SUPPORTED_TSCIRCUIT_VERSION,
        integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
      },
      adapters: MANUFACTURING_ADAPTER_VERSIONS,
      profiles: {
        [BASELINE_FABRICATION_PROFILE.name]: {
          version: BASELINE_FABRICATION_PROFILE.version,
          digest: BASELINE_FABRICATION_PROFILE.digest,
        },
      },
      assets: {},
    }, null, 2)}\n`,
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("default privacy and offline policy", () => {
  test("verified evaluation rejects a supported remote footprint before any default or offline request", async () => {
    const projectRoot = await createProject();
    const requests: string[] = [];
    const observer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${request.url}`);
        return Response.json([]);
      },
    });
    try {
      await Bun.write(
        join(projectRoot, "circuit/board.ts"),
        [
          'import { Board, Circuit, Resistor } from "tscircuit";',
          "export default async function buildRemoteFootprint() {",
          "  const circuit = new Circuit();",
          '  const board = new Board({ width: "10mm", height: "10mm", layers: 2 });',
          "  circuit.add(board);",
          `  board.add(new Resistor({ name: "R1", resistance: "1k", footprint: ${JSON.stringify(`http://127.0.0.1:${observer.port}/remote-footprint.json`)}, pcbX: 0, pcbY: 0 }));`,
          "  await circuit.renderUntilSettled();",
          "  return circuit.getCircuitJson();",
          "}",
          "",
        ].join("\n"),
      );

      for (const [policy, argv] of [
        ["default", ["build", "--json"]],
        ["offline", ["build", "--offline", "--json"]],
      ] as const) {
        const run = await runCli({ argv, cwd: projectRoot, runId: `remote-footprint-${policy}` });
        expect(run.exitCode, policy).toBe(1);
        expect(run.result?.exitClassification, policy).toBe("failure");
        expect(run.result?.project?.networkPolicy, policy).toBe(policy);
        expect(run.result?.artifacts.map(({ kind }) => kind), policy).toEqual(["command-error"]);
      }
      expect(requests).toEqual([]);
    } finally {
      observer.stop(true);
    }
  }, 120_000);

  test("a proxy-observed default and offline build send no Fulmetry traffic and keep identical circuit identity", async () => {
    const projectRoot = await createProject();
    const requests: string[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${request.url}`);
        return new Response("network access denied by test proxy", { status: 502 });
      },
    });
    try {
      const runnerUrl = pathToFileURL(join(import.meta.dir, "../src/cli/runner.ts")).href;
      const script = [
        `const {runCli}=await import(${JSON.stringify(runnerUrl)})`,
        `const first=await runCli({argv:["build","--json"],cwd:process.cwd(),runId:"privacy-default"})`,
        `const second=await runCli({argv:["build","--offline","--json"],cwd:process.cwd(),runId:"privacy-offline"})`,
        `const a=await Bun.file(first.result.artifacts[0].path).arrayBuffer()`,
        `const b=await Bun.file(second.result.artifacts[0].path).arrayBuffer()`,
        `const digest=(bytes)=>{const h=new Bun.CryptoHasher("sha256");h.update(bytes);return h.digest("hex")}`,
        `process.stdout.write(JSON.stringify({first:first.result.project,second:second.result.project,firstExit:first.exitCode,secondExit:second.exitCode,firstArtifact:digest(a),secondArtifact:digest(b)}))`,
      ].join(";");
      const proxyUrl = `http://${proxy.hostname}:${proxy.port}`;
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: projectRoot,
        env: {
          ...process.env,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ALL_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          all_proxy: proxyUrl,
          NO_PROXY: "",
          no_proxy: "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const evidence = JSON.parse(stdout) as {
        first: { networkPolicy: string; projectDigest: string };
        second: { networkPolicy: string; projectDigest: string };
        firstExit: number;
        secondExit: number;
        firstArtifact: string;
        secondArtifact: string;
      };
      expect(evidence.firstExit).toBe(0);
      expect(evidence.secondExit).toBe(0);
      expect(evidence.first.networkPolicy).toBe("default");
      expect(evidence.second.networkPolicy).toBe("offline");
      expect(evidence.second.projectDigest).toBe(evidence.first.projectDigest);
      expect(evidence.secondArtifact).toBe(evidence.firstArtifact);
      expect(requests).toEqual([]);
    } finally {
      proxy.stop(true);
    }
  }, 120_000);

  test("a sensitivity-checked runtime observer sees no default-workflow socket or DNS egress", async () => {
    const projectRoot = await createProject();
    const observerPreload = join(import.meta.dir, "helpers/network-egress-observer-preload.ts");
    const observationRoot = await mkdtemp(join(tmpdir(), "fulmetry-network-observer-"));
    temporaryRoots.push(observationRoot);
    const observerLog = join(observationRoot, "network-egress.jsonl");
    const readyLog = join(observationRoot, "observer-ready.jsonl");
    const marker = "fulmetry-sensitive-project-data-canary";
    let received = "";
    let resolveReceived!: () => void;
    const receivedCanary = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          received += new TextDecoder().decode(data);
          resolveReceived();
          socket.end();
        },
        error() {},
      },
    });
    try {
      const canary = [
        `const socket=await Bun.connect({hostname:"127.0.0.1",port:${listener.port},socket:{data(){},open(socket){socket.write(${JSON.stringify(marker)});socket.end()},error(_socket,error){throw error}}})`,
        "await socket.closed",
      ].join(";");
      const reachable = Bun.spawn([process.execPath, "-e", canary], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const reachableExit = await reachable.exited;
      await Promise.race([
        receivedCanary,
        Bun.sleep(2_000).then(() => {
          throw new Error("Direct socket sensitivity canary was not observed");
        }),
      ]);
      expect(reachableExit).toBe(0);
      expect(received).toContain(marker);

      const blocked = Bun.spawn(
        [process.execPath, "--preload", observerPreload, "-e", canary],
        {
          env: {
            ...process.env,
            FULMETRY_NETWORK_OBSERVER_LOG: observerLog,
            FULMETRY_NETWORK_OBSERVER_READY_LOG: readyLog,
          },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        },
      );
      expect(await blocked.exited).not.toBe(0);
      const sensitivityEvents = (await Bun.file(observerLog).text())
        .trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
      expect(sensitivityEvents).toEqual([
        expect.objectContaining({ kind: "Bun.connect", target: expect.stringContaining(String(listener.port)) }),
      ]);

      await Bun.write(observerLog, "");
      await Bun.write(readyLog, "");
      const inheritedCanary = [
        `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(canary)}],{stdin:"ignore",stdout:"pipe",stderr:"pipe"})`,
        "process.exit(await child.exited)",
      ].join(";");
      const propagated = Bun.spawn(
        [process.execPath, "--preload", observerPreload, "-e", inheritedCanary],
        {
          env: {
            ...process.env,
            FULMETRY_NETWORK_OBSERVER_LOG: observerLog,
            FULMETRY_NETWORK_OBSERVER_READY_LOG: readyLog,
          },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        },
      );
      expect(await propagated.exited).not.toBe(0);
      const propagatedEvents = (await Bun.file(observerLog).text())
        .trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
      expect(propagatedEvents).toEqual([expect.objectContaining({ kind: "Bun.connect" })]);
      const propagatedReady = (await Bun.file(readyLog).text())
        .trim().split(/\r?\n/u).filter(Boolean).map((line) =>
          JSON.parse(line) as { pid: number; ppid: number }
        );
      expect(new Set(propagatedReady.map(({ pid }) => pid)).size).toBe(2);
      expect(propagatedReady.some(({ ppid }) => ppid === propagated.pid)).toBeTrue();

      for (const [kind, apiCanary] of [
        ["fetch", `await fetch(${JSON.stringify(`http://127.0.0.1:${listener.port}/fetch-canary`)})`],
        ["net.connect", `const {connect}=await import("node:net");connect(${listener.port},"127.0.0.1")`],
        ["dns.lookup", 'const {lookup}=await import("node:dns");lookup("localhost",()=>{})'],
        ["dgram.createSocket", 'const {createSocket}=await import("node:dgram");createSocket("udp4")'],
      ] as const) {
        await Bun.write(observerLog, "");
        const apiProbe = Bun.spawn(
          [process.execPath, "--preload", observerPreload, "-e", apiCanary],
          {
            env: {
              ...process.env,
              FULMETRY_NETWORK_OBSERVER_LOG: observerLog,
              FULMETRY_NETWORK_OBSERVER_READY_LOG: readyLog,
            },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
          },
        );
        expect(await apiProbe.exited, kind).not.toBe(0);
        const events = (await Bun.file(observerLog).text())
          .trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
        expect(events, kind).toEqual([expect.objectContaining({ kind })]);
      }

      await Bun.write(observerLog, "");
      await Bun.write(readyLog, "");
      await Bun.write(
        join(projectRoot, "circuit/board.ts"),
        [
          'import { Board, Circuit } from "tscircuit";',
          "export default async function buildObservedAuthoringGraph() {",
          "  const circuit = new Circuit();",
          '  circuit.add(new Board({ width: "10mm", height: "10mm", layers: 2 }));',
          "  await circuit.renderUntilSettled();",
          "  return circuit.getCircuitJson();",
          "}",
          "",
        ].join("\n"),
      );
      const runnerUrl = pathToFileURL(join(import.meta.dir, "../src/cli/runner.ts")).href;
      const licensesUrl = pathToFileURL(join(import.meta.dir, "../src/licenses.ts")).href;
      const packageRoot = join(import.meta.dir, "..");
      const workflow = [
        `const {runCli}=await import(${JSON.stringify(runnerUrl)})`,
        `const {requireDistributionPackageReady}=await import(${JSON.stringify(licensesUrl)})`,
        'const build=await runCli({argv:["build","--json"],cwd:process.cwd(),runId:"privacy-observed-build"})',
        'const check=await runCli({argv:["check","--json"],cwd:process.cwd(),runId:"privacy-observed-check"})',
        'const kicad=await runCli({argv:["export","kicad","--json"],cwd:process.cwd(),runId:"privacy-observed-kicad"})',
        `await requireDistributionPackageReady({packageRoot:${JSON.stringify(packageRoot)},nodeModulesRoot:${JSON.stringify(join(packageRoot, "node_modules"))}})`,
        "process.stdout.write(JSON.stringify({build:[build.exitCode,build.result?.exitClassification],check:[check.exitCode,check.result?.exitClassification],kicad:[kicad.exitCode,kicad.result?.exitClassification],prepack:'passed'}))",
      ].join(";");
      const observed = Bun.spawn(
        [process.execPath, "--preload", observerPreload, "-e", workflow],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            FULMETRY_NETWORK_OBSERVER_LOG: observerLog,
            FULMETRY_NETWORK_OBSERVER_READY_LOG: readyLog,
          },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(observed.stdout).text(),
        new Response(observed.stderr).text(),
        observed.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        build: [0, "success"],
        check: [3, "incomplete"],
        kicad: [3, "incomplete"],
        prepack: "passed",
      });
      expect(await Bun.file(observerLog).text()).toBe("");
      const workflowReady = (await Bun.file(readyLog).text())
        .trim().split(/\r?\n/u).filter(Boolean).map((line) =>
          JSON.parse(line) as { pid: number; ppid: number }
        );
      expect(new Set(workflowReady.map(({ pid }) => pid)).size).toBeGreaterThan(2);
      expect(workflowReady.some(({ ppid }) => ppid === observed.pid)).toBeTrue();
    } finally {
      listener.stop(true);
    }
  }, 120_000);

  test("offline project tests never launch without qualified network containment", async () => {
    const projectRoot = await createProject();
    const requests: string[] = [];
    const observer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${request.url}`);
        return new Response("network canary reached");
      },
    });
    try {
      await Bun.write(
        join(projectRoot, "network.test.ts"),
        [
          'import { expect, test } from "bun:test";',
          `await fetch(${JSON.stringify(`http://127.0.0.1:${observer.port}/project-test-canary`)});`,
          'test("offline canary", () => expect(true).toBeTrue());',
          "",
        ].join("\n"),
      );
      await mkdir(join(projectRoot, "simulations"));
      await mkdir(join(projectRoot, "models"));
      await Bun.write(join(projectRoot, "models/resistors.model"), "* bound model fixture\n");
      await Bun.write(
        join(projectRoot, "simulations/canary.testbench.ts"),
        [
          `await fetch(${JSON.stringify(`http://127.0.0.1:${observer.port}/simulation-preflight-canary`)});`,
          "export default {",
          '  schemaVersion: 1, name: "canary",',
          '  region: { componentIds: ["R1"], netIds: ["VIN", "GND"] },',
          "  models: [{",
          '    id: "resistors", device: { kind: "primitive", name: "resistor" },',
          '    bindings: [{ componentId: "R1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } }],',
          `    path: "models/resistors.model", source: "fixture", digest: "sha256:${"a".repeat(64)}",`,
          '    license: "CC0-1.0", redistribution: "allowed"',
          "  }],",
          '  stimuli: [{ kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND", unit: "V", dcValue: 5, ac: null, transient: null }],',
          '  solver: { engine: "ngspice" }, analysis: { kind: "operating-point" },',
          '  assertions: [{ expression: { kind: "vector", operand: { vector: "v(VIN)", projection: "value", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected: 5, absoluteTolerance: 0.001, relativeTolerance: 0 }],',
          "  timeoutMs: 1000",
          "};",
          "",
        ].join("\n"),
      );

      const run = await runCli({
        argv: ["test", "--offline", "--json"],
        cwd: projectRoot,
        runId: "offline-project-test-containment",
      });

      expect(run.exitCode).toBe(3);
      expect(run.result?.exitClassification).toBe("incomplete");
      expect(run.result?.project?.networkPolicy).toBe("offline");
      expect(run.result?.diagnostics.map(({ id }) => String(id))).toContain(
        "TEST_OFFLINE_CONTAINMENT_UNAVAILABLE_001",
      );
      const simulation = await runCli({
        argv: ["simulate", "canary", "--offline", "--json"],
        cwd: projectRoot,
        runId: "offline-simulation-containment",
      });
      expect(simulation.exitCode).toBe(3);
      expect(simulation.result?.diagnostics.map(({ id }) => String(id))).toContain(
        "SIM_OFFLINE_CONTAINMENT_UNAVAILABLE_001",
      );
      expect(requests).toEqual([]);
    } finally {
      observer.stop(true);
    }
  }, 120_000);

  const macosNetworkDenyTest = process.platform === "darwin" ? test : test.skip;
  macosNetworkDenyTest("default and offline builds succeed under a sensitivity-checked OS network deny", async () => {
    const sandboxExecutable = Bun.which("sandbox-exec");
    expect(sandboxExecutable).not.toBeNull();
    if (sandboxExecutable === null) throw new Error("macOS sandbox-exec is unavailable");
    const profile = "(version 1) (allow default) (deny network*)";
    const observer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("sensitivity canary reached the network"),
    });
    try {
      const canary = [
        `try{await fetch(${JSON.stringify(`http://127.0.0.1:${observer.port}/canary`)})`,
        "process.exit(9)}catch{process.exit(0)}",
      ].join(";");
      const reachable = Bun.spawn(
        [process.execPath, "-e", canary],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(await reachable.exited).toBe(9);
      const sensitivity = Bun.spawn(
        [sandboxExecutable, "-p", profile, process.execPath, "-e", canary],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(await sensitivity.exited).toBe(0);
      const inheritedCanary = [
        `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(canary)}],{stdin:"ignore",stdout:"pipe",stderr:"pipe"})`,
        "process.exit(await child.exited)",
      ].join(";");
      const reachableChild = Bun.spawn(
        [process.execPath, "-e", inheritedCanary],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(await reachableChild.exited).toBe(9);
      const deniedChild = Bun.spawn(
        [sandboxExecutable, "-p", profile, process.execPath, "-e", inheritedCanary],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(await deniedChild.exited).toBe(0);

      const projectRoot = await createProject();
      const runnerUrl = pathToFileURL(join(import.meta.dir, "../src/cli/runner.ts")).href;
      const script = [
        `const {runCli}=await import(${JSON.stringify(runnerUrl)})`,
        `const first=await runCli({argv:["build","--json"],cwd:process.cwd(),runId:"deny-default"})`,
        `const second=await runCli({argv:["build","--offline","--json"],cwd:process.cwd(),runId:"deny-offline"})`,
        `const a=await Bun.file(first.result.artifacts[0].path).arrayBuffer()`,
        `const b=await Bun.file(second.result.artifacts[0].path).arrayBuffer()`,
        `const digest=(bytes)=>{const h=new Bun.CryptoHasher("sha256");h.update(bytes);return h.digest("hex")}`,
        `process.stdout.write(JSON.stringify({firstExit:first.exitCode,secondExit:second.exitCode,firstPolicy:first.result.project.networkPolicy,secondPolicy:second.result.project.networkPolicy,firstProject:first.result.project.projectDigest,secondProject:second.result.project.projectDigest,firstArtifact:digest(a),secondArtifact:digest(b)}))`,
      ].join(";");
      const child = Bun.spawn(
        [sandboxExecutable, "-p", profile, process.execPath, "-e", script],
        { cwd: projectRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const evidence = JSON.parse(stdout) as {
        firstExit: number;
        secondExit: number;
        firstPolicy: string;
        secondPolicy: string;
        firstProject: string;
        secondProject: string;
        firstArtifact: string;
        secondArtifact: string;
      };
      expect(evidence).toMatchObject({
        firstExit: 0,
        secondExit: 0,
        firstPolicy: "default",
        secondPolicy: "offline",
      });
      expect(evidence.secondProject).toBe(evidence.firstProject);
      expect(evidence.secondArtifact).toBe(evidence.firstArtifact);
    } finally {
      observer.stop(true);
    }
  }, 120_000);
});
