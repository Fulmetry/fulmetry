// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/runner";
import { startInspectionServer } from "../src/server";
import { MANUFACTURING_ADAPTER_VERSIONS } from "../src/manufacturing/export";
import { SUPPORTED_TSCIRCUIT_INTEGRITY, SUPPORTED_TSCIRCUIT_VERSION } from "../src/project/lock";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import {
  assertPerformanceFixtureIdentity,
  loadPerformanceBaselineAuthority,
  observePerformanceFixture,
  PERFORMANCE_FIXTURE_NAMES,
  PERFORMANCE_WORKLOAD_NAMES,
  type PerformanceFixtureIdentity,
  type PerformanceFixtureName,
  type PerformanceWorkloadName,
} from "./performance-baseline";

const baselinePath = join(import.meta.dir, "../compatibility/performance.json");

export function fixtureCircuit(identity: PerformanceFixtureIdentity): unknown[] {
  const circuit: unknown[] = [
    { type: "source_group", source_group_id: "source_group_0", subcircuit_id: "subcircuit_source_group_0", is_subcircuit: true },
    { type: "source_board", source_board_id: "source_board_0", source_group_id: "source_group_0" },
    { type: "pcb_board", pcb_board_id: "pcb_board_0", source_board_id: "source_board_0", center: { x: 0, y: 0 }, width: 100, height: 100, thickness: 1.6, num_layers: identity.layers, material: "fr4" },
  ];
  const positions: { x: number; y: number }[] = [];
  for (let index = 0; index < identity.components; index += 1) {
    const name = `R${index + 1}`;
    const x = -45 + (index % 20) * 4.5;
    const y = -45 + Math.floor(index / 20) * 4.5;
    positions.push({ x, y });
    const connected = index < identity.traces * 2;
    circuit.push(
      { type: "source_component", source_component_id: `source_component_${index}`, source_group_id: "source_group_0", name, ftype: "simple_resistor", resistance: 10_000 },
      { type: "source_port", source_port_id: `source_port_${index}`, source_component_id: `source_component_${index}`, subcircuit_id: "subcircuit_source_group_0", name: "pin1", pin_number: 1, ...(connected ? {} : { do_not_connect: true }) },
      { type: "pcb_component", pcb_component_id: `pcb_component_${index}`, source_component_id: `source_component_${index}`, subcircuit_id: "subcircuit_source_group_0", positioned_relative_to_pcb_board_id: "pcb_board_0", center: { x, y }, width: 2, height: 1, layer: "top", rotation: 0, do_not_place: false },
      { type: "pcb_port", pcb_port_id: `pcb_port_${index}`, pcb_component_id: `pcb_component_${index}`, source_port_id: `source_port_${index}`, subcircuit_id: "subcircuit_source_group_0", x, y, layers: ["top"] },
      { type: "pcb_smtpad", pcb_smtpad_id: `pcb_smtpad_${index}`, pcb_component_id: `pcb_component_${index}`, pcb_port_id: `pcb_port_${index}`, subcircuit_id: "subcircuit_source_group_0", shape: "rect", x, y, width: 0.8, height: 0.8, layer: "top", is_covered_with_solder_mask: false },
      { type: "pcb_solder_paste", pcb_solder_paste_id: `pcb_solder_paste_${index}`, pcb_smtpad_id: `pcb_smtpad_${index}`, subcircuit_id: "subcircuit_source_group_0", shape: "rect", x, y, width: 0.56, height: 0.56, layer: "top" },
      { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: `pcb_courtyard_rect_${index}`, pcb_component_id: `pcb_component_${index}`, subcircuit_id: "subcircuit_source_group_0", center: { x, y }, width: 2.4, height: 1.4, layer: "top" },
    );
  }
  for (let index = 0; index < identity.traces; index += 1) {
    const first = index * 2;
    const second = first + 1;
    const start = positions[first]!;
    const end = positions[second]!;
    circuit.push(
      { type: "source_trace", source_trace_id: `source_trace_${index}`, subcircuit_id: "subcircuit_source_group_0", name: `NET_${index + 1}`, connected_source_port_ids: [`source_port_${first}`, `source_port_${second}`], connected_source_net_ids: [], min_trace_thickness: 0.2 },
      { type: "pcb_trace", pcb_trace_id: `pcb_trace_${index}`, source_trace_id: `source_trace_${index}`, subcircuit_id: "subcircuit_source_group_0", connectsTo: [`pcb_port_${first}`, `pcb_port_${second}`], trace_length: Math.hypot(end.x - start.x, end.y - start.y), route: [
        { route_type: "wire", layer: "top", width: 0.2, x: start.x, y: start.y, start_pcb_port_id: `pcb_port_${first}` },
        { route_type: "wire", layer: "top", width: 0.2, x: end.x, y: end.y, end_pcb_port_id: `pcb_port_${second}` },
      ] },
    );
  }
  return circuit;
}

export async function createPerformanceFixture(
  name: PerformanceFixtureName,
  identity: PerformanceFixtureIdentity,
): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), `fulmetry-performance-${name}-`));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await symlink(
    join(import.meta.dir, "../node_modules/tscircuit"),
    join(root, "node_modules/tscircuit"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const source = join(root, "src/board.ts");
  await Bun.write(source, `export default ${JSON.stringify(fixtureCircuit(identity))};\n`);
  await Bun.write(join(root, "fulmetry.config.ts"), `export default { entry: 'src/board.ts', outputDirectory: '.fulmetry', profiles: ['${BASELINE_FABRICATION_PROFILE.name}'] };\n`);
  await Bun.write(join(root, "fulmetry.lock"), `${JSON.stringify({
    schemaVersion: 1,
    tscircuit: { version: SUPPORTED_TSCIRCUIT_VERSION, integrity: SUPPORTED_TSCIRCUIT_INTEGRITY },
    adapters: MANUFACTURING_ADAPTER_VERSIONS,
    profiles: {
      [BASELINE_FABRICATION_PROFILE.name]: {
        version: BASELINE_FABRICATION_PROFILE.version,
        digest: BASELINE_FABRICATION_PROFILE.digest,
      },
    },
    assets: {},
  })}\n`);
  return { root, source };
}

async function waitForRevision(url: URL, initial: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (response.ok) {
      const body = await response.json() as { snapshot: { revision: number } };
      if (body.snapshot.revision > initial) return;
    }
    await Bun.sleep(25);
  }
  throw new Error("Incremental rebuild did not publish a ready revision");
}

export type PerformanceCliRun = Awaited<ReturnType<typeof runCli>>;

function requireCliResult(run: PerformanceCliRun, command: string): NonNullable<PerformanceCliRun["result"]> {
  if (run.result === undefined || run.result.command !== command) {
    throw new Error(`Performance workload did not return ${command} result authority`);
  }
  return run.result;
}

async function observedCliCircuit(
  run: PerformanceCliRun,
  root: string,
): Promise<Readonly<PerformanceFixtureIdentity>> {
  const result = requireCliResult(run, run.result?.command ?? "missing command");
  const circuit = result.artifacts.find(({ kind }) => kind === "circuit-json");
  if (circuit === undefined) throw new Error("Performance CLI workload omitted its generated Circuit JSON artifact");
  return observePerformanceFixture(JSON.parse(await Bun.file(join(root, ...circuit.path.split("/"))).text()));
}

function mappingCount(mapping: readonly unknown[], type: string): number {
  const entry = mapping.find(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null && typeof candidate === "object" &&
      (candidate as Record<string, unknown>).circuitJsonType === type,
  );
  return entry === undefined ? 0 : Number(entry.count);
}

export async function assertPerformanceDetachedExport(
  run: PerformanceCliRun,
  root: string,
  expected: Readonly<PerformanceFixtureIdentity>,
): Promise<void> {
  if (run.exitCode !== 3) throw new Error(`detached-export returned ${run.exitCode}`);
  const result = requireCliResult(run, "fulmetry export kicad");
  const diagnostic = result.diagnostics[0];
  if (
    result.exitClassification !== "incomplete" ||
    result.diagnostics.length !== 1 ||
    String(diagnostic?.id) !== "KICAD_HANDOFF_SEMANTIC_FAILED_001" ||
    diagnostic?.severity !== "error" || diagnostic.dimension !== "fabrication" ||
    diagnostic.disposition !== "active" || diagnostic.waiverPolicy !== "forbidden" ||
    result.statuses.fabrication.state !== "not-run" ||
    result.statuses.electrical.state !== "not-run" ||
    result.statuses.functional.state !== "not-run" ||
    result.statuses.standards.state !== "not-run" ||
    result.statuses.sourcing.state !== "unchecked"
  ) throw new Error("Detached export did not preserve its explicit incomplete handoff boundary");
  const reportArtifact = result.artifacts.find(({ kind }) => kind === "kicad-handoff-report");
  const handoffArtifacts = result.artifacts.filter(({ kind }) => kind === "kicad-handoff");
  const liveInputArtifacts = result.artifacts.filter(({ kind }) => kind === "kicad-live-input");
  const extensions = (artifacts: typeof handoffArtifacts) =>
    artifacts.map(({ path }) => path.slice(path.lastIndexOf("."))).sort();
  if (
    reportArtifact === undefined || handoffArtifacts.length !== 3 || liveInputArtifacts.length !== 3 ||
    result.artifacts.length !== 7 ||
    JSON.stringify(extensions(handoffArtifacts)) !== JSON.stringify([".kicad_pcb", ".kicad_pro", ".kicad_sch"]) ||
    JSON.stringify(extensions(liveInputArtifacts)) !== JSON.stringify([".kicad_pcb", ".kicad_pro", ".kicad_sch"])
  ) throw new Error(`Detached export omitted or added handoff artifacts: ${JSON.stringify(result.artifacts.map(({ kind, path }) => ({ kind, path })))}`);
  const reportBytes = await Bun.file(join(root, ...reportArtifact.path.split("/"))).arrayBuffer();
  const reportSha256 = new Bun.CryptoHasher("sha256").update(reportBytes).digest("hex");
  if (reportArtifact.digest !== `sha256:${reportSha256}`) {
    throw new Error("Detached export report digest does not match its bytes");
  }
  const report = JSON.parse(new TextDecoder().decode(reportBytes)) as Record<string, unknown>;
  const offline = report.offlineParse as Record<string, unknown> | undefined;
  const live = report.liveKiCadValidation as Record<string, unknown> | undefined;
  const liveEvidence = live?.evidence as Record<string, unknown> | undefined;
  const liveInput = liveEvidence?.input as Record<string, unknown> | undefined;
  const liveFiles = liveInput?.artifacts;
  const mapping = report.mapping;
  const files = report.files;
  const semantics = report.semanticReconciliation as Record<string, unknown> | undefined;
  if (
    report.lifecycle !== "detached-downstream-handoff" ||
    offline?.schematic !== "passed" || offline.pcb !== "passed" ||
    offline.projectJson !== "passed" || !Array.isArray(mapping) || !Array.isArray(files) ||
    files.length !== 3 || semantics?.state !== "failed" || live?.state !== "unqualified" || !Array.isArray(live.supportedMajors) ||
    JSON.stringify(live.supportedMajors) !== JSON.stringify([10]) ||
    !Array.isArray(liveFiles) || liveFiles.length !== 3 ||
    mapping.some(
      (entry) => (entry as Record<string, unknown>).disposition === "unsupported",
    ) !== true
  ) throw new Error("Detached export did not prove all three offline parse results");
  for (const artifact of handoffArtifacts) {
    const filename = artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
    const declared = files.find(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object" &&
        (entry as Record<string, unknown>).path === filename,
    );
    const bytes = await Bun.file(join(root, ...artifact.path.split("/"))).arrayBuffer();
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (
      declared === undefined || declared.sha256 !== sha256 ||
      artifact.digest !== `sha256:${sha256}`
    ) throw new Error(`Detached export artifact ${filename} does not match its report`);
  }
  for (const artifact of liveInputArtifacts) {
    const filename = artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
    const declared = liveFiles.find(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object" &&
        (entry as Record<string, unknown>).path === filename,
    );
    const bytes = await Bun.file(join(root, ...artifact.path.split("/"))).arrayBuffer();
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (
      declared === undefined || declared.size !== bytes.byteLength || declared.sha256 !== sha256 ||
      artifact.digest !== `sha256:${sha256}`
    ) throw new Error(`Detached export live input ${filename} does not match its report`);
  }
  const observed = Object.freeze({
    components: mappingCount(mapping, "source_component"),
    pads: mappingCount(mapping, "pcb_smtpad") + mappingCount(mapping, "pcb_plated_hole"),
    traces: mappingCount(mapping, "pcb_trace"),
    layers: expected.layers,
  });
  assertPerformanceFixtureIdentity(observed, expected, "detached-export mapping");
}

async function fetchObservedServerCircuit(
  url: URL,
  expected: Readonly<PerformanceFixtureIdentity>,
): Promise<void> {
  const response = await fetch(new URL("/api/circuit", url));
  if (!response.ok) throw new Error(`Server circuit authority returned ${response.status}`);
  const body = await response.json() as { elements?: unknown };
  assertPerformanceFixtureIdentity(
    observePerformanceFixture(body.elements),
    expected,
    "inspection server output",
  );
}

async function runWorkload(
  fixture: PerformanceFixtureName,
  workload: PerformanceWorkloadName,
  identity: PerformanceFixtureIdentity,
  observationPath?: string,
): Promise<void> {
  const prepared = await createPerformanceFixture(fixture, identity);
  try {
    if (workload === "cold-build" || workload === "check-drc" || workload === "detached-export") {
      const argv = workload === "cold-build" ? ["build", "--json"]
        : workload === "check-drc" ? ["check", "--json"]
        : ["export", "kicad", "--json"];
      const run = await runCli({
        argv,
        cwd: prepared.root,
        runId: `performance-${fixture}-${workload}`,
        ...(workload === "detached-export" ? { externalToolPaths: { kicadCli: null } } : {}),
      });
      if (workload === "cold-build") {
        if (run.exitCode !== 0 || requireCliResult(run, "fulmetry build").exitClassification !== "success") {
          throw new Error(`cold-build returned ${run.exitCode}: ${run.stderr || JSON.stringify(run.result?.diagnostics ?? [])}`);
        }
        const observed = await observedCliCircuit(run, prepared.root);
        assertPerformanceFixtureIdentity(observed, identity, "cold-build generated output");
        if (observationPath === undefined) throw new Error("Cold build fixture observation path is missing");
        await writeFile(observationPath, `${JSON.stringify(observed)}\n`, { flag: "wx" });
      } else if (workload === "check-drc") {
        const result = requireCliResult(run, "fulmetry check");
        if (
          run.exitCode !== 3 || result.exitClassification !== "incomplete" ||
          result.statuses.electrical.state !== "passed" || result.statuses.fabrication.state !== "incomplete" ||
          result.diagnostics.length !== 1 ||
          String(result.diagnostics[0]?.id) !== "FAB_ARTIFACT_VERIFICATION_NOT_RUN_001"
        ) throw new Error(`check-drc returned ${run.exitCode}: ${run.stderr || JSON.stringify(result.diagnostics)}`);
        assertPerformanceFixtureIdentity(
          await observedCliCircuit(run, prepared.root),
          identity,
          "check-drc generated output",
        );
      } else {
        await assertPerformanceDetachedExport(run, prepared.root, identity);
      }
      return;
    }
    const server = await startInspectionServer({ projectDirectory: prepared.root, watchDebounceMs: 10 });
    try {
      await fetchObservedServerCircuit(server.url, identity);
      if (workload === "incremental-rebuild") {
        const projectUrl = new URL("/api/project", server.url);
        const initial = await (await fetch(projectUrl)).json() as { snapshot: { revision: number } };
        const sourceText = await Bun.file(prepared.source).text();
        await Bun.write(prepared.source, `${sourceText.trimEnd()}\n\n`);
        await waitForRevision(projectUrl, initial.snapshot.revision);
        await fetchObservedServerCircuit(server.url, identity);
      } else {
        if (workload === "inspection-query") {
          const response = await fetch(new URL("/api/inspect?name=R1&limit=1", server.url));
          const body = await response.json() as { total?: unknown; inspection?: unknown };
          if (
            !response.ok || body.total !== 1 || !Array.isArray(body.inspection) ||
            (body.inspection[0] as Record<string, unknown> | undefined)?.type !== "source_component"
          ) throw new Error(`inspection-query returned invalid authority with status ${response.status}`);
        } else {
          const response = await fetch(new URL("/pcb", server.url));
          const body = await response.text();
          if (
            !response.ok || !response.headers.get("content-type")?.startsWith("text/html") ||
            !body.includes("<svg") || !body.includes("data-fulmetry-viewer") ||
            !body.includes("circuit sha256:")
          ) throw new Error(`pcb-render returned invalid rendered authority with status ${response.status}`);
        }
      }
    } finally {
      await server.stop();
    }
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const fixture = process.argv[2] as PerformanceFixtureName;
  const workload = process.argv[3] as PerformanceWorkloadName;
  const expectedBaselineSha256 = process.argv[4];
  const observationPath = process.argv[5];
  if (!PERFORMANCE_FIXTURE_NAMES.includes(fixture) || !PERFORMANCE_WORKLOAD_NAMES.includes(workload)) {
    throw new TypeError("Expected a performance fixture and workload");
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedBaselineSha256 ?? "")) {
    throw new TypeError("Expected the captured performance baseline SHA-256");
  }
  const authority = await loadPerformanceBaselineAuthority(baselinePath);
  if (authority.sha256 !== expectedBaselineSha256) throw new Error("PERFORMANCE_BASELINE_CHANGED");
  await runWorkload(fixture, workload, authority.baseline.fixtures[fixture], observationPath);
}
