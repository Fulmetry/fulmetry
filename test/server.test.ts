import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startInspectionServer,
  type InspectionServer,
  type StartInspectionServerOptions,
} from "../src/server/index";
import { canonicalCircuitJson } from "../src/circuit-json";
import type { AnyCircuitElement } from "circuit-json";
import { runCli } from "../src/cli/runner";
import { digestProjectInputs } from "../src/project/input-digest";
import {
  recordedSourcingPolicyDigest,
  recordedSourcingSelectionContentSha256,
} from "../src/sourcing";
import {
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
} from "../src/project/lock";
import { manufacturingFixture } from "./fixtures/manufacturing";

const roots: string[] = [];
const servers: InspectionServer[] = [];
setDefaultTimeout(45_000);
const finalPublicationAttacks: ReadonlyArray<readonly [
  attack: "bytes" | "symlink",
  target: "circuit.json" | "report.json",
]> = [
  ["bytes", "circuit.json"],
  ["bytes", "report.json"],
  ...(process.platform === "win32"
    ? []
    : [["symlink", "circuit.json"] as const, ["symlink", "report.json"] as const]),
];

function lock(assets: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    tscircuit: {
      version: SUPPORTED_TSCIRCUIT_VERSION,
      integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
    },
    adapters: {
      gerber: "circuit-json-to-gerber@0.0.90",
      bom: "circuit-json-to-bom-csv@0.0.14",
      pickAndPlace: "circuit-json-to-pnp-csv@0.0.9",
      independentParser: "gerber-parser@4.2.7",
    },
    profiles: {},
    assets,
  }, null, 2) + "\n";
}

async function writeSmokeTestbench(root: string, modelDigest: string, expected = 5): Promise<void> {
  await Bun.write(join(root, "simulations", "smoke.testbench.ts"), `export default ${JSON.stringify({
    schemaVersion: 1,
    name: "smoke",
    region: { componentIds: ["source_component_1"], netIds: ["VIN", "GND"] },
    models: [{
      id: "fixture", device: { kind: "primitive", name: "resistor" },
      bindings: [{ componentId: "source_component_1", pinMap: { "1": "1", "2": "2" }, parameters: { resistance: "10k" } }],
      path: "models/smoke.model", source: "server fixture", digest: modelDigest,
      license: "CC0-1.0", redistribution: "allowed",
    }],
    stimuli: [{ kind: "voltage", sourceId: "VIN", positiveNode: "VIN", negativeNode: "GND", unit: "V", dcValue: 5, ac: null, transient: null }],
    solver: { engine: "ngspice" }, analysis: { kind: "operating-point" },
    assertions: [{ expression: { kind: "vector", operand: { vector: "v(VIN)", projection: "value", unit: "V" } }, sample: { kind: "last" }, unit: "V", expected, absoluteTolerance: 0, relativeTolerance: 0 }],
    timeoutMs: 1_000,
  })}\n`);
}

async function project(): Promise<{ root: string; entry: string }> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-server-"));
  roots.push(root);
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "simulations"));
  await mkdir(join(root, "models"));
  await mkdir(join(root, "node_modules"));
  await symlink(join(import.meta.dir, "../node_modules/tscircuit"), join(root, "node_modules/tscircuit"), process.platform === "win32" ? "junction" : "dir");
  const entry = join(root, "src", "board.ts");
  await Bun.write(entry, `export default [
    { type: "source_group", source_group_id: "source_group_0", subcircuit_id: "subcircuit_source_group_0", is_subcircuit: true },
    { type: "source_board", source_board_id: "source_board_0", source_group_id: "source_group_0" },
    { type: "pcb_board", pcb_board_id: "pcb_board_0", source_board_id: "source_board_0", center: { x: 0, y: 0 }, width: 10, height: 10, thickness: 1.4, num_layers: 2, material: "fr4" },
    { type: "source_component", source_component_id: "source_component_1", name: "R1", ftype: "simple_resistor", resistance: 10000 },
    { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1", center: { x: 1, y: 2 }, width: 2, height: 1, layer: "top", rotation: 0 },
    { type: "simulation_experiment", simulation_experiment_id: "simulation_experiment_1", name: "smoke", experiment_type: "spice_dc_operating_point" }
  ]\n`);
  const model = ".model fixture R\n";
  await Bun.write(join(root, "models", "smoke.model"), model);
  const modelDigest = `sha256:${new Bun.CryptoHasher("sha256").update(model).digest("hex")}`;
  await writeSmokeTestbench(root, modelDigest);
  await Bun.write(
    join(root, "pcboo.config.ts"),
    "export default { entry: 'src/board.ts', outputDirectory: '.pcboo' }\n",
  );
  await Bun.write(join(root, "pcboo.lock"), lock());
  return { root, entry };
}

async function start(
  root: string,
  options: Omit<StartInspectionServerOptions, "projectDirectory"> = {},
) {
  const server = await startInspectionServer({
    projectDirectory: join(root, "src", "nested"),
    ...options,
  });
  servers.push(server);
  return server;
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    last = value;
    if (accept(value)) return value;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for inspection server state; last=${JSON.stringify(last)}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("fixed PCBoo inspection and action server", () => {
  test("binds to loopback on an ephemeral port and serves every fixed route", async () => {
    const { root } = await project();
    const server = await start(root);
    expect(server.hostname).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    expect(server.warnings).toEqual([]);

    for (const path of [
      "/", "/api/project", "/api/circuit", "/api/inspect?type=pcb_component",
      "/api/checks", "/api/simulations", "/api/artifacts", "/schematic", "/pcb",
      "/api/actions", "/api/render/schematic", "/api/render/pcb",
      "/pcb/layers/top", "/checks", "/simulations", "/simulations/smoke", "/manufacturing",
      "/3d", "/explorer",
    ]) {
      const response = await fetch(new URL(path, server.url));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("content-type"), path).toMatch(
        path.startsWith("/api/render/") ? /^image\/svg\+xml/
          : path.startsWith("/api/") ? /^application\/json/ : /^text\/html/,
      );
    }
  }, 45_000);

  test("returns focused inspection data, unassessed engineering statuses, and fail-closed sourcing evidence", async () => {
    const { root } = await project();
    const server = await start(root);
    const inspectResponse = await fetch(new URL("/api/inspect?name=R1&limit=1", server.url));
    expect(await inspectResponse.json()).toMatchObject({
      total: 1,
      truncated: false,
      elements: [{ type: "source_component", name: "R1" }],
    });
    const checksResponse = await fetch(new URL("/api/checks", server.url));
    expect(await checksResponse.json()).toMatchObject({
      statuses: {
        fabrication: { state: "not-run" },
        electrical: { state: "not-run" },
        functional: { state: "not-run" },
        standards: { state: "not-run" },
        sourcing: { state: "unchecked" },
      },
      sourcingEvidence: {
        mode: "recorded-offline",
        networkAccess: "none",
        claim: "not-checked-no-policy",
        timeAuthority: "host-wall-clock",
      },
    });
  });

  test("attaches the exact same-instant sourcing evidence returned by a check action", async () => {
    const { root, entry } = await project();
    await Bun.write(entry, `export default [
      { type: "source_component", source_component_id: "source_component_1", name: "R1", ftype: "simple_resistor", resistance: 10000, manufacturer_part_number: "RC0603FR-0710KL", supplier_part_numbers: { jlcpcb: ["C25804"] } },
      { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1", center: { x: 1, y: 2 }, width: 2, height: 1, layer: "top", rotation: 0 },
      { type: "cad_component", cad_component_id: "cad_component_1", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1", position: { x: 1, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, model_origin_alignment: "center_of_component_on_board_surface", anchor_alignment: "center_of_component_on_board_surface", footprinter_string: "res0603" }
    ]\n`);
    const policyWithoutDigest = {
      name: "pcboo-recorded-sourcing",
      version: "1.0.0",
      maxAgeSeconds: 4,
      maxFutureSkewSeconds: 300,
      minimumStock: 100,
    };
    const selection = {
      sourceComponentId: "source_component_1",
      manufacturer: { name: "Yageo", partNumber: "RC0603FR-0710KL" },
      supplier: { name: "jlcpcb", partNumber: "C25804" },
      package: "0603-imperial",
      footprint: "res0603",
      snapshot: {
        schemaVersion: 1 as const,
        source: "recorded:https://example.invalid/jlcpcb/C25804",
        retrievedAt: "2020-01-01T00:00:00.000Z",
        lifecycle: "active" as const,
        stock: 10_000,
        price: null,
      },
    };
    const lockDocument = JSON.parse(lock());
    lockDocument.sourcing = {
      schemaVersion: 1,
      policy: {
        ...policyWithoutDigest,
        digest: recordedSourcingPolicyDigest(policyWithoutDigest),
      },
      selections: {
        R1: {
          ...selection,
          contentSha256: recordedSourcingSelectionContentSha256({
            designator: "R1",
            selection,
          }),
        },
      },
    };
    await Bun.write(join(root, "pcboo.lock"), `${JSON.stringify(lockDocument, null, 2)}\n`);

    const server = await start(root);
    const before = await (await fetch(new URL("/api/checks", server.url))).json() as any;
    expect(before.statuses.sourcing.checkedAt).toBe(before.sourcingEvidence.checkedAt);
    expect(before.sourcingEvidence.selections[0].recordedCondition).toBe("stale");
    const action = await fetch(new URL("/api/actions/check", server.url), {
      method: "POST",
      headers: {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(action.status).toBe(200);
    const actionBody = await action.json() as any;
    expect(actionBody.result.statuses.sourcing.checkedAt)
      .toBe(actionBody.result.sourcingEvidence.checkedAt);
    expect(actionBody.result.sourcingEvidence.selections[0].recordedCondition).toBe("stale");

    const after = await (await fetch(new URL("/api/checks", server.url))).json() as any;
    expect(after.statuses.sourcing.checkedAt).toBe(after.sourcingEvidence.checkedAt);
    expect(after.sourcingEvidence).toEqual(actionBody.result.sourcingEvidence);
    expect(after.sourcingEvidence.selections[0].recordedCondition).toBe("stale");
  });

  test("returns bounded spatial, layer, distance, and connectivity inspection data", async () => {
    const { root } = await project();
    const server = await start(root);
    const nearest = await fetch(new URL("/api/inspect?x=1&y=2&radius=0&layer=top&limit=5", server.url));
    expect(nearest.status).toBe(200);
    expect(await nearest.json()).toMatchObject({
      units: { coordinates: "mm", distances: "mm" },
      total: 1,
      inspection: [{
        id: "pcb_component_1",
        type: "pcb_component",
        center: { x: 1, y: 2 },
        distanceFromPointMm: 0,
        layers: ["top"],
      }],
    });
    const related = await fetch(new URL(
      "/api/inspect?from=pcb_component_1&to=source_component_1&limit=5",
      server.url,
    ));
    expect(await related.json()).toMatchObject({
      measurement: { kind: "bounding-box-gap", unit: "mm", available: false },
      logicalConnectivityPath: null,
      physicalConnectivityPath: null,
      unconnectedManufacturedEndpointIds: [],
      relationPath: ["pcb_component_1", "source_component_1"],
    });
    expect((await fetch(new URL("/api/inspect?x=1", server.url))).status).toBe(400);
    expect((await fetch(new URL("/api/inspect?region=2,2,1,1", server.url))).status).toBe(400);
  });

  test("serializes logical intent separately from physically proven copper", async () => {
    const { root, entry } = await project();
    await Bun.write(entry, `export default ${JSON.stringify([
      { type: "source_component", source_component_id: "SC1", name: "R1", ftype: "simple_resistor", resistance: 10_000 },
      { type: "source_component", source_component_id: "SC2", name: "R2", ftype: "simple_resistor", resistance: 10_000 },
      { type: "pcb_component", pcb_component_id: "PC1", source_component_id: "SC1", center: { x: 0, y: 0 }, width: 1, height: 1, layer: "top", rotation: 0 },
      { type: "pcb_component", pcb_component_id: "PC2", source_component_id: "SC2", center: { x: 10, y: 0 }, width: 1, height: 1, layer: "top", rotation: 0 },
      { type: "source_port", source_port_id: "SP1", source_component_id: "SC1", name: "pin1", pin_number: 1 },
      { type: "source_port", source_port_id: "SP2", source_component_id: "SC2", name: "pin1", pin_number: 1 },
      { type: "source_trace", source_trace_id: "ST", connected_source_port_ids: ["SP1", "SP2"], connected_source_net_ids: [] },
      { type: "pcb_port", pcb_port_id: "PP1", pcb_component_id: "PC1", source_port_id: "SP1", x: 0, y: 0, layers: ["top"] },
      { type: "pcb_port", pcb_port_id: "PP2", pcb_component_id: "PC2", source_port_id: "SP2", x: 10, y: 0, layers: ["top"] },
      { type: "pcb_smtpad", pcb_smtpad_id: "PAD1", pcb_component_id: "PC1", pcb_port_id: "PP1", x: 0, y: 0, width: 1, height: 1, shape: "rect", layer: "top" },
      { type: "pcb_smtpad", pcb_smtpad_id: "PAD2", pcb_component_id: "PC2", pcb_port_id: "PP2", x: 10, y: 0, width: 1, height: 1, shape: "rect", layer: "top" },
    ])}\n`);
    const server = await start(root);
    const response = await fetch(new URL("/api/inspect?from=PAD1&to=PAD2&limit=20", server.url));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      logicalConnectivityPath: ["PAD1", "PP1", "SP1", "ST", "SP2", "PP2", "PAD2"],
      physicalConnectivityPath: null,
      unconnectedManufacturedEndpointIds: ["PAD1", "PAD2"],
    });
    expect(body).not.toHaveProperty("connectivityPath");
  });

  test("publishes exact structured trace length, via count, and transitions", async () => {
    const { root, entry } = await project();
    await Bun.write(entry, `export default ${JSON.stringify([
      { type: "source_group", source_group_id: "SG", subcircuit_id: "SUB", is_subcircuit: true },
      { type: "source_board", source_board_id: "SB", source_group_id: "SG" },
      { type: "pcb_board", pcb_board_id: "BOARD", source_board_id: "SB", center: { x: 5, y: 0 }, width: 20, height: 10, thickness: 1.6, num_layers: 2, material: "fr4" },
      { type: "source_component", source_component_id: "SC1", name: "R1", ftype: "simple_resistor", resistance: 10_000 },
      { type: "source_component", source_component_id: "SC2", name: "R2", ftype: "simple_resistor", resistance: 10_000 },
      { type: "pcb_component", pcb_component_id: "PC1", source_component_id: "SC1", center: { x: 0, y: 0 }, width: 1, height: 1, layer: "top", rotation: 0 },
      { type: "pcb_component", pcb_component_id: "PC2", source_component_id: "SC2", center: { x: 10, y: 0 }, width: 1, height: 1, layer: "top", rotation: 0 },
      { type: "source_port", source_port_id: "SP1", source_component_id: "SC1", name: "pin1", pin_number: 1 },
      { type: "source_port", source_port_id: "SP2", source_component_id: "SC2", name: "pin1", pin_number: 1 },
      { type: "source_trace", source_trace_id: "ST", connected_source_port_ids: ["SP1", "SP2"], connected_source_net_ids: [] },
      { type: "pcb_port", pcb_port_id: "PP1", pcb_component_id: "PC1", source_port_id: "SP1", x: 0, y: 0, layers: ["top"] },
      { type: "pcb_port", pcb_port_id: "PP2", pcb_component_id: "PC2", source_port_id: "SP2", x: 10, y: 0, layers: ["bottom"] },
      { type: "pcb_smtpad", pcb_smtpad_id: "PAD1", pcb_component_id: "PC1", pcb_port_id: "PP1", x: 0, y: 0, width: 1, height: 1, shape: "rect", layer: "top" },
      { type: "pcb_smtpad", pcb_smtpad_id: "PAD2", pcb_component_id: "PC2", pcb_port_id: "PP2", x: 10, y: 0, width: 1, height: 1, shape: "rect", layer: "bottom" },
      { type: "pcb_trace", pcb_trace_id: "PT", source_trace_id: "ST", route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "PP1" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: 5, y: 0, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "bottom", end_pcb_port_id: "PP2" },
      ] },
      { type: "pcb_via", pcb_via_id: "V", pcb_trace_id: "PT", x: 5, y: 0, from_layer: "top", to_layer: "bottom", layers: ["top", "bottom"], hole_diameter: 0.2, outer_diameter: 0.3 },
    ])}\n`);
    const server = await start(root);
    const response = await fetch(new URL("/api/inspect?id=PT&limit=5", server.url));
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.inspection).toHaveLength(1);
    expect(body.inspection[0].traceMeasurement).toEqual({
      state: "proven",
      unit: "mm",
      lengthMm: 11.6,
      viaCount: 1,
      transitions: [{
        viaId: "V", x: 5, y: 0, fromLayer: "top", toLayer: "bottom",
      }],
    });
  });

  test("filters net inspection by authoritative identity instead of names or raw keys", async () => {
    const { root, entry } = await project();
    await Bun.write(entry, `export default ${JSON.stringify([
      { type: "source_component", source_component_id: "SC_A", name: "VIN", ftype: "simple_resistor", resistance: 10_000 },
      { type: "source_component", source_component_id: "SC_B", name: "R2", ftype: "simple_resistor", resistance: 10_000 },
      { type: "source_component", source_component_id: "SC_SPOOF", name: "R3", ftype: "simple_resistor", resistance: 10_000 },
      { type: "source_port", source_port_id: "SP_A", source_component_id: "SC_A", name: "pin1", pin_number: 1, subcircuit_connectivity_map_key: "COLLIDED_RAW_KEY" },
      { type: "source_port", source_port_id: "SP_B", source_component_id: "SC_B", name: "pin1", pin_number: 1, subcircuit_connectivity_map_key: "COLLIDED_RAW_KEY" },
      { type: "source_port", source_port_id: "SP_SPOOF", source_component_id: "SC_SPOOF", name: "pin1", pin_number: 1, subcircuit_connectivity_map_key: "COLLIDED_RAW_KEY" },
      { type: "source_net", source_net_id: "NET_A", name: "NET_A_NAME", member_source_group_ids: [], subcircuit_connectivity_map_key: "COLLIDED_RAW_KEY" },
      { type: "source_net", source_net_id: "NET_B", name: "NET_B_NAME", member_source_group_ids: [], subcircuit_connectivity_map_key: "COLLIDED_RAW_KEY" },
      { type: "source_trace", source_trace_id: "TRACE_A", connected_source_port_ids: ["SP_A"], connected_source_net_ids: ["NET_A"], subcircuit_connectivity_map_key: "COLLIDED_RAW_KEY" },
      { type: "source_trace", source_trace_id: "TRACE_B", connected_source_port_ids: ["SP_B"], connected_source_net_ids: ["NET_B"], subcircuit_connectivity_map_key: "COLLIDED_RAW_KEY" },
      { type: "source_net", source_net_id: "NET_DUP_1", name: "DUPLICATE", member_source_group_ids: [] },
      { type: "source_net", source_net_id: "NET_DUP_2", name: "DUPLICATE", member_source_group_ids: [] },
      { type: "source_net", source_net_id: "NET_MERGED_1", name: "MERGED_1", member_source_group_ids: [] },
      { type: "source_net", source_net_id: "NET_MERGED_2", name: "MERGED_2", member_source_group_ids: [] },
      { type: "source_trace", source_trace_id: "TRACE_INVALID_MERGE", connected_source_port_ids: [], connected_source_net_ids: ["NET_MERGED_1", "NET_MERGED_2"] },
    ])}\n`);
    const server = await start(root);
    const query = async (selector: string) => {
      const response = await fetch(new URL(`/api/inspect?net=${selector}&limit=50`, server.url));
      return { response, body: await response.json() as any };
    };
    const byId = await query("NET_A");
    const byName = await query("NET_A_NAME");
    expect(byId.response.status).toBe(200);
    expect(byName.response.status).toBe(200);
    const ids = (body: any) => body.inspection.map(({ id }: { id: string }) => id).sort();
    expect(ids(byId.body)).toEqual(["NET_A", "SP_A", "TRACE_A"]);
    expect(ids(byName.body)).toEqual(ids(byId.body));
    expect(byId.body.query).toMatchObject({ net: "NET_A", resolvedSourceNetId: "NET_A" });
    expect(ids(byId.body)).not.toContain("NET_B");
    expect(ids(byId.body)).not.toContain("SP_SPOOF");
    expect(ids(byId.body)).not.toContain("SC_A");

    const ambiguous = await query("DUPLICATE");
    expect(ambiguous.response.status).toBe(409);
    expect(ambiguous.body.error.code).toBe("INSPECTION_NET_AMBIGUOUS");
    const absent = await query("DOES_NOT_EXIST");
    expect(absent.response.status).toBe(404);
    expect(absent.body.error.code).toBe("INSPECTION_NET_NOT_FOUND");
    const componentNameOnly = await query("VIN");
    expect(componentNameOnly.response.status).toBe(404);
    expect(componentNameOnly.body.error.code).toBe("INSPECTION_NET_NOT_FOUND");
    for (const selector of ["NET_MERGED_1", "NET_MERGED_2"]) {
      const mergedIdentity = await query(selector);
      expect(mergedIdentity.response.status).toBe(409);
      expect(mergedIdentity.body.error.code).toBe("INSPECTION_NET_IDENTITY_AMBIGUOUS");
      expect(mergedIdentity.body).not.toHaveProperty("inspection");
    }
  });

  test("keeps authoritative PCB ports visible while excluding invalid pad mappings", async () => {
    const { root, entry } = await project();
    const sourceComponents = ["MISSING", "DUPLICATE", "OWNER"].map((suffix, index) => ({
      type: "source_component",
      source_component_id: `SC_${suffix}`,
      name: `R${index + 1}`,
      ftype: "simple_resistor",
      resistance: 10_000,
    }));
    const sourcePorts = ["MISSING", "DUPLICATE", "OWNER"].map((suffix) => ({
      type: "source_port",
      source_port_id: `SP_${suffix}`,
      source_component_id: `SC_${suffix}`,
      name: "pin1",
      pin_number: 1,
    }));
    const pcbComponents = ["MISSING", "DUPLICATE", "OWNER"].map((suffix, index) => ({
      type: "pcb_component",
      pcb_component_id: `PC_${suffix}`,
      source_component_id: `SC_${suffix}`,
      center: { x: index * 5, y: 0 },
      width: 1,
      height: 1,
      layer: "top",
      rotation: 0,
    }));
    const pcbPorts = ["MISSING", "DUPLICATE", "OWNER"].map((suffix, index) => ({
      type: "pcb_port",
      pcb_port_id: `PP_${suffix}`,
      pcb_component_id: `PC_${suffix}`,
      source_port_id: `SP_${suffix}`,
      x: index * 5,
      y: 0,
      layers: ["top"],
    }));
    const pad = (id: string, port: string, component: string, x: number) => ({
      type: "pcb_smtpad", pcb_smtpad_id: id, pcb_port_id: port,
      pcb_component_id: component, x, y: 0, width: 1, height: 1,
      shape: "rect", layer: "top",
    });
    await Bun.write(entry, `export default ${JSON.stringify([
      ...sourceComponents,
      ...sourcePorts,
      { type: "source_net", source_net_id: "NET", name: "SIGNAL", member_source_group_ids: [] },
      { type: "source_trace", source_trace_id: "TRACE", connected_source_port_ids: sourcePorts.map(({ source_port_id }) => source_port_id), connected_source_net_ids: ["NET"] },
      ...pcbComponents,
      ...pcbPorts,
      pad("PAD_DUPLICATE_1", "PP_DUPLICATE", "PC_DUPLICATE", 5),
      pad("PAD_DUPLICATE_2", "PP_DUPLICATE", "PC_DUPLICATE", 5),
      pad("PAD_WRONG_OWNER", "PP_OWNER", "PC_DUPLICATE", 10),
    ])}\n`);
    const server = await start(root);
    const response = await fetch(new URL("/api/inspect?net=NET&limit=50", server.url));
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const byId = new Map(body.inspection.map((item: any) => [item.id, item]));
    for (const id of ["PP_MISSING", "PP_DUPLICATE", "PP_OWNER"]) {
      expect(byId.get(id)).toMatchObject({
        id,
        manufacturedPinMapping: { state: "invalid" },
      });
    }
    for (const id of ["PAD_DUPLICATE_1", "PAD_DUPLICATE_2", "PAD_WRONG_OWNER"]) {
      expect(byId.has(id), id).toBeFalse();
    }
  });

  test("attaches internal-detail violations and provenance to exact inspected objects", async () => {
    const { root, entry } = await project();
    const attacked = structuredClone(await manufacturingFixture(2));
    const sourceTrace = attacked.find((element) =>
      element.type === "source_trace" && element.source_trace_id === "source_trace_2"
    );
    if (sourceTrace?.type !== "source_trace") throw new Error("Fixture source trace missing");
    sourceTrace.max_length = 0.01;
    await Bun.write(entry, `export default ${JSON.stringify(attacked)}\n`);
    const server = await start(root);
    const checked = await fetch(new URL("/api/actions/check", server.url), {
      method: "POST",
      headers: {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(checked.status).toBe(200);
    const response = await fetch(new URL(
      "/api/inspect?id=source_trace_2&limit=5",
      server.url,
    ));
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.inspection).toHaveLength(1);
    expect(body.inspection[0].violations).toContain("FAB_ROUTE_CONSTRAINT_001");
    expect(body.inspection[0].sourceLocations.length).toBeGreaterThan(0);
  });

  test("serves the Bun-built React application and fixed tscircuit-backed SVG views", async () => {
    const { root } = await project();
    const server = await start(root);
    const pcb = await fetch(new URL("/pcb", server.url));
    const html = await pcb.text();
    expect(html).toContain('id="root"');
    expect(html).toMatch(/\/assets\/pcboo-app-[a-z0-9]+\.js/u);
    expect(html).toContain("circuit sha256:");
    const scriptPath = html.match(/src="(\/assets\/pcboo-app-[a-z0-9]+\.js)"/u)?.[1];
    expect(scriptPath).toBeDefined();
    const script = await fetch(new URL(scriptPath!, server.url));
    expect(script.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await script.text()).length).toBeGreaterThan(10_000);
    const render = await fetch(new URL("/api/render/pcb", server.url));
    expect(render.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(await render.text()).toContain("<svg");
  }, 15_000);

  test("returns visible warning metadata for explicit non-loopback binding", async () => {
    const { root } = await project();
    const server = await start(root, { hostname: "0.0.0.0" });
    expect(server.warnings).toEqual([
      expect.objectContaining({ code: "SERVER_NETWORK_EXPOSURE" }),
    ]);
    const response = await fetch(new URL("/api/project", server.url));
    expect(await response.json()).toMatchObject({
      server: {
        warnings: [{ code: "SERVER_NETWORK_EXPOSURE" }],
        actionsEnabled: false,
      },
    });
  });

  test("serves only digest-locked project-local 3D model bytes", async () => {
    const { root } = await project();
    const model = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    const notice = "fixture model notice\n";
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(model).digest("hex")}`;
    const noticeDigest = `sha256:${new Bun.CryptoHasher("sha256").update(notice).digest("hex")}`;
    await Bun.write(join(root, "models", "assembly.glb"), model);
    await Bun.write(join(root, "models", "LICENSE.txt"), notice);
    await Bun.write(join(root, "pcboo.lock"), lock({
      assembly: {
        source: "https://example.invalid/assembly.glb",
        version: "fixture-1",
        digest,
        license: "CC0-1.0",
        attribution: "PCBoo test fixture",
        licenseNotice: "models/LICENSE.txt",
        licenseNoticeDigest: noticeDigest,
        redistribution: "allowed",
      },
    }));
    const server = await start(root);

    const response = await fetch(new URL("/models/assembly.glb", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("model/gltf-binary");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(model);
    const head = await fetch(new URL("/models/assembly.glb", server.url), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    await Bun.write(join(root, "models", "assembly.glb"), new Uint8Array([...model, 1]));
    const changed = await fetch(new URL("/models/assembly.glb", server.url));
    expect(changed.status).toBe(409);
    expect(await changed.text()).toContain("Model bytes are not approved by pcboo.lock.assets");
  });

  test("publishes verified engine identity without filesystem locations", async () => {
    const { root } = await project();
    const server = await start(root);
    const response = await fetch(new URL("/api/project", server.url));
    const body = await response.json() as {
      project: { root: string; tscircuit: Record<string, unknown> };
    };
    expect(body.project.root).toBe(".");
    expect(body.project.tscircuit).toMatchObject({
      version: SUPPORTED_TSCIRCUIT_VERSION,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(body)).not.toContain(root);
    expect(body.project.tscircuit).not.toHaveProperty("packageRoot");
    expect(body.project.tscircuit).not.toHaveProperty("entryPath");
  });

  test("refuses clock-driven resolved configuration instead of serving unstable freshness", async () => {
    const { root } = await project();
    await Bun.write(
      join(root, "pcboo.config.ts"),
      "export default { entry: 'src/board.ts', profiles: [String((Date.now() / 60000).toFixed(0))] }\n",
    );

    expect(start(root)).rejects.toThrow(
      "forbids ambient nondeterminism global Date",
    );
  });

  test("refuses clock-driven circuit source instead of serving unstable freshness", async () => {
    const { root, entry } = await project();
    await Bun.write(
      entry,
      "const epoch = (Date.now() / 60000) | 0; export default epoch % 2 ? [] : []\n",
    );

    expect(start(root)).rejects.toThrow(
      "forbids ambient nondeterminism global Date",
    );
  });

  test("rejects reflective runtime recovery in resolved configuration", async () => {
    const { root } = await project();
    await Bun.write(
      join(root, "pcboo.config.ts"),
      `const F=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>{}),"constructor").value;void F;export default {entry:"src/board.ts"}\n`,
    );

    expect(start(root)).rejects.toThrow("constructor/evaluator access");
  });

  test("fails when the requested port is already occupied", async () => {
    const { root } = await project();
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    try {
      if (occupied.port === undefined) throw new Error("Bun did not report the occupied port");
      await expect(startInspectionServer({
        projectDirectory: root,
        hostname: "127.0.0.1",
        port: occupied.port,
      })).rejects.toThrow();
    } finally {
      await occupied.stop(true);
    }
  });

  test("rejects traversal, malformed and oversized queries, and unknown routes", async () => {
    const { root } = await project();
    const server = await start(root);
    const cases: Array<[string, number]> = [
      ["/not-a-route", 404],
      ["/api/private-file", 404],
      ["/pcb/layers/%2Fetc", 400],
      ["/api/inspect?unknown=value", 400],
      ["/api/inspect?name=%ZZ", 400],
      [`/api/inspect?name=${"x".repeat(2_100)}`, 400],
    ];
    for (const [path, status] of cases) {
      expect((await fetch(new URL(path, server.url))).status, path).toBe(status);
    }
  });

  test("denies cross-origin and mutation methods while allowing same-origin CORS", async () => {
    const { root } = await project();
    let freshnessRechecks = 0;
    const server = await start(root, {
      beforeProjectAuthorityRecheck: () => { freshnessRechecks += 1; },
    });
    const endpoint = new URL("/api/project", server.url);
    expect((await fetch(endpoint, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect(freshnessRechecks).toBe(0);
    const sameOrigin = await fetch(endpoint, { headers: { Origin: server.url.origin } });
    expect(sameOrigin.status).toBe(200);
    expect(freshnessRechecks).toBe(1);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(server.url.origin);
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(405);
  });

  test("rejects DNS-rebinding Host headers before disclosing or accepting action authority", async () => {
    const { root } = await project();
    const server = await start(root);
    const hostileOrigin = `http://evil.test:${server.port}`;
    const rebound = await fetch(`http://127.0.0.1:${server.port}/api/project`, {
      headers: { Host: `evil.test:${server.port}`, Origin: hostileOrigin },
    });
    expect(rebound.status).toBe(421);
    expect(await rebound.text()).not.toContain(server.actionToken);
    const action = await fetch(`http://127.0.0.1:${server.port}/api/actions/build`, {
      method: "POST",
      headers: {
        Host: `evil.test:${server.port}`,
        Origin: hostileOrigin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(action.status).toBe(421);
  });

  test("disables browser actions when explicitly bound to the network", async () => {
    const { root } = await project();
    const server = await start(root, { hostname: "0.0.0.0" });
    const projectResponse = await fetch(new URL("/api/project", server.url));
    const state = await projectResponse.json() as { server: Record<string, unknown> };
    expect(state.server.actionsEnabled).toBe(false);
    expect(state.server).not.toHaveProperty("actionToken");
    const response = await fetch(new URL("/api/actions/build", server.url), {
      method: "POST",
      headers: {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "ACTIONS_NETWORK_DISABLED" } });
  });

  test("atomically watches source changes and retains the last good snapshot on failure", async () => {
    const { root, entry } = await project();
    const server = await start(root, { watchDebounceMs: 20, externalToolPaths: { kicadCli: null } });
    const projectState = async () => await (await fetch(new URL("/api/project", server.url))).json() as {
      snapshot: { state: string; revision: number; circuitDigest: string };
    };
    const initial = await projectState();
    await Bun.write(entry, `export default [{ type: "source_component", source_component_id: "source_component_2", name: "R2", ftype: "simple_resistor", resistance: 2200 }]\n`);
    const rebuilt = await waitFor(projectState, ({ snapshot }) => snapshot.revision > initial.snapshot.revision);
    expect(rebuilt.snapshot.state).toBe("ready");
    const rebuiltCircuit = await (await fetch(new URL("/api/circuit", server.url))).json() as { elements: Array<{ name?: string }> };
    expect(rebuiltCircuit.elements.map(({ name }) => name)).toContain("R2");

    await Bun.write(entry, "export default { malformed: true }\n");
    const failed = await waitFor(projectState, ({ snapshot }) => snapshot.state === "failed");
    expect(failed.snapshot.revision).toBe(rebuilt.snapshot.revision);
    expect(failed.snapshot.circuitDigest).toBe(rebuilt.snapshot.circuitDigest);
    const retained = await (await fetch(new URL("/api/circuit", server.url))).json() as { elements: Array<{ name?: string }> };
    expect(retained.elements.map(({ name }) => name)).toContain("R2");
  });

  test("installs and revalidates new graph watchers before publishing a candidate ready", async () => {
    const { root, entry } = await project();
    const wideDirectory = join(root, "wide-graph");
    const targetDirectory = join(root, "zzzz-target");
    await mkdir(wideDirectory);
    await mkdir(targetDirectory);
    await Promise.all(Array.from({ length: 400 }, (_, index) =>
      Bun.write(join(wideDirectory, `module-${index}.ts`), `export const value${index} = ${index}\n`)
    ));
    const target = join(targetDirectory, "part.ts");
    const targetSource = (revision: number) =>
      `export default [{ type: "source_component", source_component_id: "source_component_${revision}", name: "HANDOFF_${revision}", ftype: "simple_resistor", resistance: ${revision * 1000} }]\n`;
    await Bun.write(target, targetSource(17));
    let watcherCommitCount = 0;
    const server = await start(root, {
      watchDebounceMs: 20,
      beforeWatcherCommit: async () => {
        watcherCommitCount += 1;
        if (watcherCommitCount === 2) await Bun.write(target, targetSource(18));
      },
    });
    const imports = Array.from({ length: 400 }, (_, index) =>
      `import "../wide-graph/module-${index}"`
    ).join("\n");
    await Bun.write(entry, `${imports}\nexport { default } from "../zzzz-target/part"\n`);
    const observedReadyNames: string[] = [];
    const final = await waitFor(
      async () => {
        const body = await (await fetch(new URL("/api/circuit", server.url))).json() as {
          snapshot: { state: string };
          elements: Array<{ name?: string }>;
        };
        if (body.snapshot.state === "ready") {
          observedReadyNames.push(...body.elements.flatMap(({ name }) => name ?? []));
        }
        return body;
      },
      ({ snapshot, elements }) =>
        snapshot.state === "ready" && elements.some(({ name }) => name === "HANDOFF_18"),
    );
    expect(final.elements.map(({ name }) => name)).toContain("HANDOFF_18");
    expect(observedReadyNames).not.toContain("HANDOFF_17");
    expect(watcherCommitCount).toBeGreaterThanOrEqual(3);
  }, 120_000);

  test("converges on the last rapid change while concurrent readers observe digest-bound snapshots", async () => {
    const { root, entry } = await project();
    await mkdir(join(root, ".pcboo"), { recursive: true });
    const server = await start(root, { watchDebounceMs: 20 });
    const initialCircuit = await (await fetch(new URL("/api/circuit", server.url))).json() as {
      elements: AnyCircuitElement[];
    };
    const rapidCircuit = (revision: number): AnyCircuitElement[] => ([
      {
        type: "source_group" as const,
        source_group_id: "source_group_0",
        subcircuit_id: "subcircuit_source_group_0",
        is_subcircuit: true,
      },
      {
        type: "source_board" as const,
        source_board_id: "source_board_0",
        source_group_id: "source_group_0",
      },
      {
        type: "pcb_board" as const,
        pcb_board_id: "pcb_board_0",
        source_board_id: "source_board_0",
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        thickness: 1.4,
        num_layers: 2,
        material: "fr4" as const,
      },
      {
        type: "source_component" as const,
        source_component_id: `source_component_${revision}`,
        name: `RAPID_${revision}`,
        ftype: "simple_resistor" as const,
        resistance: revision * 1000,
      },
    ] as unknown as AnyCircuitElement[]);
    const rapidSource = (revision: number, delayMs = 0) =>
      `${delayMs > 0 ? `await Bun.sleep(${delayMs})\n` : ""}export default ${JSON.stringify(rapidCircuit(revision))}\n`;
    const allowedCanonicalCircuits = new Set([
      canonicalCircuitJson(initialCircuit.elements),
      ...Array.from({ length: 17 }, (_, index) =>
        canonicalCircuitJson(rapidCircuit(index + 1))
      ),
    ]);
    const observations: Array<{ state: string; revision: number; name?: string }> = [];
    const readers = Array.from({ length: 6 }, async () => {
      let previousRevision = 0;
      for (let sample = 0; sample < 12; sample += 1) {
        const response = await fetch(new URL("/api/circuit", server.url));
        if (response.status !== 200) throw new Error(`Concurrent reader received ${response.status}`);
        const body = await response.json() as {
          schemaVersion: number;
          snapshot: { state: string; revision: number; circuitDigest: string };
          elements: AnyCircuitElement[];
        };
        const canonical = canonicalCircuitJson(body.elements);
        const digest = `sha256:${new Bun.CryptoHasher("sha256")
          .update(canonical).digest("hex")}`;
        if (digest !== body.snapshot.circuitDigest) {
          throw new Error("Reader observed elements from a different snapshot digest");
        }
        if (!allowedCanonicalCircuits.has(canonical)) {
          throw new Error("Reader observed circuit bytes that were not one complete authored fixture");
        }
        if (body.snapshot.revision < previousRevision) {
          throw new Error("One reader observed a decreasing snapshot revision");
        }
        previousRevision = body.snapshot.revision;
        const source = (body.elements as unknown as Array<{
          type: string;
          name?: string;
          source_component_id?: string;
        }>).find(({ type }) => type === "source_component");
        if (
          source?.name?.startsWith("RAPID_") &&
          source.source_component_id !== `source_component_${source.name.slice("RAPID_".length)}`
        ) throw new Error("Reader observed a partially replaced source component");
        observations.push({
          state: body.snapshot.state,
          revision: body.snapshot.revision,
          ...(source?.name === undefined ? {} : { name: source.name }),
        });
        await Bun.sleep(3);
      }
    });
    for (let revision = 1; revision <= 12; revision += 1) {
      await Bun.write(entry, rapidSource(revision));
      await Bun.sleep(4);
    }
    await Promise.all(readers);
    const final = await waitFor(
      async () => await (await fetch(new URL("/api/circuit", server.url))).json() as {
        snapshot: { state: string; revision: number };
        elements: Array<{ name?: string }>;
      },
      ({ snapshot, elements }) =>
        snapshot.state === "ready" && elements.some(({ name }) => name === "RAPID_12"),
    );
    expect(final.elements.map(({ name }) => name)).toContain("RAPID_12");
    expect(observations).toHaveLength(72);
    expect(observations.every(({ state }) => ["ready", "pending"].includes(state))).toBeTrue();
    expect(observations.some(({ state, name }) =>
      state === "pending" || name?.startsWith("RAPID_") === true
    )).toBeTrue();

    let keepRepeatedReaderRunning = true;
    const repeatedRevisions: number[] = [];
    const repeatedReader = (async () => {
      let previousRevision = 0;
      while (keepRepeatedReaderRunning) {
        const body = await (await fetch(new URL("/api/circuit", server.url))).json() as {
          snapshot: { revision: number; circuitDigest: string };
          elements: AnyCircuitElement[];
        };
        const canonical = canonicalCircuitJson(body.elements);
        const digest = `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;
        if (!allowedCanonicalCircuits.has(canonical) || digest !== body.snapshot.circuitDigest) {
          throw new Error("Repeated-change reader observed a partial or digest-mismatched snapshot");
        }
        if (body.snapshot.revision < previousRevision) {
          throw new Error("Repeated-change reader observed a decreasing snapshot revision");
        }
        previousRevision = body.snapshot.revision;
        repeatedRevisions.push(body.snapshot.revision);
        await Bun.sleep(5);
      }
    })();
    let previousSuccessfulRevision = final.snapshot.revision;
    try {
      for (const revision of [13, 14, 15]) {
        await Bun.write(entry, rapidSource(revision));
        const repeated = await waitFor(
          async () => await (await fetch(new URL("/api/circuit", server.url))).json() as {
            snapshot: { state: string; revision: number };
            elements: Array<{ name?: string }>;
          },
          ({ snapshot, elements }) =>
            snapshot.state === "ready" &&
            elements.some(({ name }) => name === `RAPID_${revision}`),
        );
        expect(repeated.snapshot.revision).toBeGreaterThan(previousSuccessfulRevision);
        previousSuccessfulRevision = repeated.snapshot.revision;
      }
    } finally {
      keepRepeatedReaderRunning = false;
      await repeatedReader;
    }
    expect(new Set(repeatedRevisions).size).toBeGreaterThanOrEqual(3);

    await Bun.write(
      entry,
      `export default async function slowCircuit() {\n  await new Promise((resolve) => setTimeout(resolve, 500))\n  return ${JSON.stringify(rapidCircuit(16))}\n}\n`,
    );
    await waitFor(
      async () => await (await fetch(new URL("/api/project", server.url))).json() as {
        snapshot: { state: string; message?: string };
      },
      ({ snapshot }) =>
        snapshot.state === "pending" && snapshot.message?.includes("snapped input generation") === true,
    );
    const actionHeaders = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": server.actionToken,
      "Content-Type": "application/json",
    };
    const assertPendingAdmission = async () => {
      const [projectState, checkState, action] = await Promise.all([
        fetch(new URL("/api/project", server.url)).then((response) => response.json()) as Promise<{
          snapshot: { state: string };
        }>,
        fetch(new URL("/api/checks", server.url)).then((response) => response.json()) as Promise<{
          snapshot: { state: string };
        }>,
        fetch(new URL("/api/actions/check", server.url), {
          method: "POST",
          headers: actionHeaders,
          body: "{}",
        }),
      ]);
      expect(projectState.snapshot.state).toBe("pending");
      expect(checkState.snapshot.state).toBe("pending");
      expect(action.status).toBe(409);
      expect(await action.json()).toMatchObject({ error: { code: "ACTION_SNAPSHOT_NOT_READY" } });
    };
    await assertPendingAdmission();
    await Bun.write(entry, rapidSource(17));
    await assertPendingAdmission();
    const supersessionObservations: string[] = [];
    const superseded = await waitFor(
      async () => {
        const body = await (await fetch(new URL("/api/circuit", server.url))).json() as {
          snapshot: { state: string; circuitDigest: string; revision: number };
          elements: AnyCircuitElement[];
        };
        const canonical = canonicalCircuitJson(body.elements);
        const digest = `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex")}`;
        if (!allowedCanonicalCircuits.has(canonical) || digest !== body.snapshot.circuitDigest) {
          throw new Error("Supersession reader observed a partial or digest-mismatched snapshot");
        }
        const source = (body.elements as unknown as Array<{ type: string; name?: string }>)
          .find(({ type }) => type === "source_component");
        if (body.snapshot.state === "ready" && source?.name === "RAPID_16") {
          throw new Error("Superseded input generation was published as ready");
        }
        if (source?.name !== undefined) supersessionObservations.push(source.name);
        return { body, sourceName: source?.name };
      },
      ({ body, sourceName }) => body.snapshot.state === "ready" && sourceName === "RAPID_17",
    );
    expect(superseded.body.snapshot.revision).toBeGreaterThan(previousSuccessfulRevision);
    expect(supersessionObservations).not.toContain("RAPID_16");

    const finalProject = await (await fetch(new URL("/api/project", server.url))).json() as {
      snapshot: { projectDigest: string; circuitDigest: string };
    };
    const built = await runCli({ argv: ["build"], cwd: root, runId: "stress-binding" });
    expect(built.exitCode).toBe(0);
    expect(built.result?.project?.projectDigest).toBe(finalProject.snapshot.projectDigest);
    const artifactPath = built.result?.artifacts[0]?.path;
    if (artifactPath === undefined) throw new Error("Stress binding build emitted no circuit artifact");
    const artifactCanonical = await Bun.file(join(root, artifactPath)).text();
    const artifactDigest = `sha256:${new Bun.CryptoHasher("sha256").update(artifactCanonical).digest("hex")}`;
    expect(artifactDigest).toBe(finalProject.snapshot.circuitDigest);
  }, 120_000);

  test("marks retained checks and artifacts stale when current source cannot rebuild", async () => {
    const { root, entry } = await project();
    const server = await start(root, { watchDebounceMs: 20 });
    const initial = await (await fetch(new URL("/api/project", server.url))).json() as {
      server: { actionToken: string };
    };
    const headers = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": initial.server.actionToken,
      "Content-Type": "application/json",
    };
    expect((await fetch(new URL("/api/actions/check", server.url), {
      method: "POST", headers, body: "{}",
    })).status).toBe(200);
    const current = await (await fetch(new URL("/api/checks", server.url))).json() as {
      evidence: { state: string };
      statuses: { electrical: { state: string } };
    };
    expect(current.evidence.state).toBe("current");
    expect(current.statuses.electrical.state).not.toBe("not-run");

    await Bun.write(entry, "export default { malformed: true }\n");
    await waitFor(
      async () => {
        const response = await fetch(new URL("/api/project", server.url));
        if (response.status !== 200) return { snapshot: { state: "stale" } };
        return await response.json() as { snapshot: { state: string } };
      },
      ({ snapshot }) => snapshot.state === "failed",
    );
    for (const route of ["/api/checks", "/checks", "/api/artifacts", "/manufacturing"]) {
      const stale = await fetch(new URL(route, server.url));
      expect(stale.status, route).toBe(409);
      const text = await stale.text();
      expect(text, route).toContain("Stored artifact evidence changed");
      expect(text, route).not.toContain(".pcboo/runs/");
    }
    const staleInspection = await (await fetch(new URL("/api/inspect?name=R1", server.url))).json() as {
      snapshot: { state: string };
    };
    expect(staleInspection.snapshot.state).toBe("failed");
    const staleSimulations = await (await fetch(new URL("/api/simulations", server.url))).json() as {
      snapshot: { state: string };
    };
    expect(staleSimulations.snapshot.state).toBe("failed");
  });

  test("never reports ready after a watcher-missed file appears in an existing nested directory", async () => {
    const { root } = await project();
    const unwatched = join(root, "scratch", "deep");
    await mkdir(unwatched, { recursive: true });
    let injectDuringAuthorityCapture = false;
    const server = await start(root, {
      watchDebounceMs: 20,
      beforeProjectAuthorityRecheck: async () => {
        if (!injectDuringAuthorityCapture) return;
        injectDuringAuthorityCapture = false;
        await Bun.write(join(unwatched, "new-authority.txt"), "new project authority\n");
      },
    });
    const initial = await (await fetch(new URL("/api/project", server.url))).json() as {
      snapshot: { revision: number; projectDigest: string; state: string };
    };
    expect(initial.snapshot.state).toBe("ready");

    injectDuringAuthorityCapture = true;
    const first = await fetch(new URL("/api/project", server.url));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { snapshot: { state: string } };
    expect(firstBody.snapshot.state).not.toBe("ready");
    const expectedAuthority = await digestProjectInputs({
      projectRoot: root,
      entry: "src/board.ts",
      outputDirectory: ".pcboo",
      profiles: [],
    });
    expect(expectedAuthority.inputPaths).toContain("scratch/deep/new-authority.txt");

    const rebuilt = await waitFor(
      async () => {
        const response = await fetch(new URL("/api/project", server.url));
        if (response.status !== 200) return null;
        return await response.json() as {
          snapshot: { revision: number; projectDigest: string; state: string };
        };
      },
      (body) => body?.snapshot.state === "ready" &&
        body.snapshot.revision > initial.snapshot.revision &&
        body.snapshot.projectDigest === expectedAuthority.projectDigest,
    );
    expect(rebuilt?.snapshot.projectDigest).not.toBe(initial.snapshot.projectDigest);
  });

  test("reserves the action slot after streamed body parsing to prevent concurrent execution", async () => {
    const { root } = await project();
    const server = await start(root);
    const initial = await (await fetch(new URL("/api/project", server.url))).json() as {
      server: { actionToken: string };
    };
    const headers = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": initial.server.actionToken,
      "Content-Type": "application/json",
    };
    let release!: () => void;
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        release = () => {
          controller.enqueue(new TextEncoder().encode("}"));
          controller.close();
        };
      },
    });
    const slow = fetch(new URL("/api/actions/build", server.url), {
      method: "POST",
      headers,
      body: slowBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await Bun.sleep(25);
    const fast = fetch(new URL("/api/actions/build", server.url), {
      method: "POST", headers, body: "{}",
    });
    await waitFor(
      async () => await (await fetch(new URL("/api/actions", server.url))).json() as { running: boolean },
      ({ running }) => running,
    );
    release();
    const responses = await Promise.all([slow, fast]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    await waitFor(
      async () => await (await fetch(new URL("/api/actions", server.url))).json() as { running: boolean },
      ({ running }) => !running,
    );
  });

  test("bounds stalled action bodies and aborts every pending body parser during shutdown", async () => {
    const { root } = await project();
    const server = await start(root, { actionBodyTimeoutMs: 100 });
    const headers = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": server.actionToken,
      "Content-Type": "application/json",
    };
    const stalledBody = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const timed = fetch(new URL("/api/actions/build", server.url), {
      method: "POST",
      headers,
      body: stalledBody(),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const timeoutResponse = await timed;
    expect(timeoutResponse.status).toBe(408);
    expect(await timeoutResponse.json()).toMatchObject({ error: { code: "ACTION_BODY_TIMEOUT" } });

    const pending = [0, 1].map(() => fetch(new URL("/api/actions/build", server.url), {
      method: "POST",
      headers,
      body: stalledBody(),
      duplex: "half",
    } as RequestInit & { duplex: "half" }).catch(() => undefined));
    await Bun.sleep(25);
    const started = performance.now();
    await server.stop();
    expect(performance.now() - started).toBeLessThan(1_000);
    await Promise.all(pending);
    servers.splice(servers.indexOf(server), 1);
  }, 120_000);

  test("authorizes fixed derived actions without changing source or triggering output rebuild loops", async () => {
    const { root, entry } = await project();
    const before = await readFile(entry);
    const server = await start(root, { watchDebounceMs: 20 });
    const projectUrl = new URL("/api/project", server.url);
    const initial = await (await fetch(projectUrl)).json() as { snapshot: { revision: number }; server: { actionToken: string } };
    const action = new URL("/api/actions/build", server.url);
    const actionHeaders = { Origin: server.url.origin, "X-PCBoo-Action-Token": initial.server.actionToken, "Content-Type": "application/json" };
    expect((await fetch(action, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(action, {
      method: "POST",
      headers: actionHeaders,
      body: JSON.stringify({ unknown: true }),
    })).status).toBe(400);
    const built = await fetch(action, {
      method: "POST",
      headers: actionHeaders,
      body: "{}",
    });
    expect(built.status).toBe(200);
    expect(await built.json()).toMatchObject({ result: { command: "pcboo build", exitClassification: "success" } });
    expect(Buffer.compare(before, await readFile(entry))).toBe(0);
    await Bun.sleep(250);
    const after = await (await fetch(projectUrl)).json() as { snapshot: { revision: number } };
    expect(after.snapshot.revision).toBe(initial.snapshot.revision);
    const artifacts = await (await fetch(new URL("/api/artifacts", server.url))).json() as { artifacts: Array<{ kind: string }> };
    expect(artifacts.artifacts.map(({ kind }) => kind)).toContain("circuit-json");
    const checked = await fetch(new URL("/api/actions/check", server.url), { method: "POST", headers: actionHeaders, body: "{}" });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ result: { command: "pcboo check", requestedDimensions: ["electrical", "fabrication"] } });
    const simulated = await fetch(new URL("/api/actions/simulate", server.url), { method: "POST", headers: actionHeaders, body: JSON.stringify({ name: "smoke" }) });
    expect(simulated.status).toBe(200);
    expect(await simulated.json()).toMatchObject({ result: { command: "pcboo simulate smoke", requestedDimensions: ["functional"] } });
    const exported = await fetch(new URL("/api/actions/export-kicad", server.url), { method: "POST", headers: actionHeaders, body: "{}" });
    expect(exported.status).toBe(200);
    const exportedBody = await exported.json() as { result: { command: string; exitClassification: string; project: { sourceDigest: string }; artifacts: Array<{ kind: string; path: string }> } };
    expect(exportedBody.result).toMatchObject({ command: "pcboo export kicad", exitClassification: "incomplete" });
    const handoffReport = exportedBody.result.artifacts.find(({ kind }) => kind === "kicad-handoff-report");
    expect(handoffReport).toBeDefined();
    const liveReport = JSON.parse(await Bun.file(join(root, handoffReport!.path)).text());
    expect(liveReport).toMatchObject({
      semanticReconciliation: {
        state: "failed",
        message: expect.stringContaining("schematic symbols do not cover every source component"),
      },
      liveKiCadValidation: {
        state: "unqualified",
        supportedMajors: [10],
        evidence: { execution: { state: "not-run-unqualified-identity", commands: [] } },
      },
    });
    expect(liveReport.mapping.some(({ disposition }: { disposition: string }) => disposition === "exact")).toBeFalse();
    expect(liveReport.liveKiCadValidation.evidence.source.authoredSourceDigest).toBe(exportedBody.result.project.sourceDigest);
    const checks = await (await fetch(new URL("/api/checks", server.url))).json() as { statuses: Record<string, { state: string }>; lastAction: { command: string } };
    expect(checks.statuses.electrical?.state).not.toBe("not-run");
    expect(["unavailable", "incomplete"]).toContain(checks.statuses.functional!.state);
    expect(checks.lastAction.command).toBe("pcboo export kicad");
  }, 120_000);

  test("live-syncs verification evidence written by an external CLI action", async () => {
    const { root } = await project();
    const server = await start(root, { watchDebounceMs: 20 });
    const projectUrl = new URL("/api/project", server.url);
    const initial = await (await fetch(projectUrl)).json() as {
      snapshot: { revision: number };
      server: { activityRevision: number; activityUpdatedAt: string };
    };

    const checked = await runCli({
      argv: ["check"],
      cwd: root,
      runId: "external-live-sync",
    });
    expect(checked.result?.requestedDimensions).toEqual(["electrical", "fabrication"]);

    const synchronized = await waitFor(
      async () => await (await fetch(projectUrl)).json() as {
        snapshot: { revision: number };
        server: { activityRevision: number; activityUpdatedAt: string };
      },
      ({ server: live }) => live.activityRevision > initial.server.activityRevision,
    );
    expect(synchronized.snapshot.revision).toBe(initial.snapshot.revision);
    expect(Date.parse(synchronized.server.activityUpdatedAt))
      .toBeGreaterThanOrEqual(Date.parse(initial.server.activityUpdatedAt));

    const checks = await (await fetch(new URL("/api/checks", server.url))).json() as any;
    expect(checks.lastAction).toMatchObject({
      command: "pcboo check",
      runId: "external-live-sync",
    });
    expect(checks.evidenceActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "external-live-sync" }),
    ]));
  }, 120_000);

  test("rejects artifact mutation before action attachment and publishes no stale references", async () => {
    const { root } = await project();
    let attacked = false;
    const server = await start(root, {
      beforeArtifactAttachment: async (run) => {
        if (attacked || run.result?.artifacts[0] === undefined) return;
        attacked = true;
        await Bun.write(join(root, run.result.artifacts[0].path), "mutated before server attachment\n");
      },
    });
    const headers = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": server.actionToken,
      "Content-Type": "application/json",
    };
    const action = await fetch(new URL("/api/actions/build", server.url), {
      method: "POST", headers, body: "{}",
    });
    expect(action.status).toBe(409);
    expect(await action.json()).toMatchObject({ error: { code: "ACTION_ARTIFACTS_STALE" } });
    const artifacts = await fetch(new URL("/api/artifacts", server.url));
    expect(artifacts.status).toBe(200);
    expect(await artifacts.json()).toMatchObject({ artifacts: [] });
  });

  test.each(finalPublicationAttacks)(
    "rejects final-boundary %s replacement of %s before publishing action success",
    async (attack, targetName) => {
      const { root } = await project();
      const server = await start(root, {
        beforeActionPublication: async () => {
          const runIds = await readdir(join(root, ".pcboo", "runs"));
          if (runIds.length !== 1) throw new Error("Expected exactly one action run");
          const runDirectory = join(root, ".pcboo", "runs", runIds[0]!);
          const target = join(runDirectory, targetName);
          if (attack === "bytes") {
            await Bun.write(target, `mutated ${targetName} before publication\n`);
          } else {
            await rm(target);
            await symlink(targetName === "report.json" ? "circuit.json" : "report.json", target);
          }
        },
      });
      const action = await fetch(new URL("/api/actions/build", server.url), {
        method: "POST",
        headers: {
          Origin: server.url.origin,
          "X-PCBoo-Action-Token": server.actionToken,
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      expect(action.status).toBe(409);
      expect(await action.json()).toMatchObject({
        error: { code: "ACTION_ARTIFACTS_STALE" },
      });
      expect(await (await fetch(new URL("/api/actions", server.url))).json()).toMatchObject({
        evidence: { state: "none" },
        lastAction: null,
      });
      expect(await (await fetch(new URL("/api/artifacts", server.url))).json()).toMatchObject({
        evidence: { state: "none" },
        artifacts: [],
      });
    },
  );

  test("client cancellation publishes no action authority", async () => {
    const { root } = await project();
    let entered!: () => void;
    let release!: () => void;
    const attachmentStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const attachmentGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await start(root, {
      beforeArtifactAttachment: async () => {
        entered();
        await attachmentGate;
      },
    });
    const controller = new AbortController();
    const request = fetch(new URL("/api/actions/build", server.url), {
      method: "POST",
      headers: {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await attachmentStarted;
    controller.abort();
    const requestOutcome = await request;
    expect(requestOutcome).toBeInstanceOf(Error);
    expect((requestOutcome as Error).name).toBe("AbortError");
    await Bun.sleep(25);
    release();

    await waitFor(
      async () => await (await fetch(new URL("/api/actions", server.url))).json() as {
        running: boolean;
      },
      ({ running }) => !running,
    );
    expect(await (await fetch(new URL("/api/actions", server.url))).json()).toMatchObject({
      evidence: { state: "none" },
      running: false,
      lastAction: null,
    });
    expect(await (await fetch(new URL("/api/artifacts", server.url))).json()).toMatchObject({
      evidence: { state: "none" },
      artifacts: [],
    });
    expect(await (await fetch(new URL("/api/checks", server.url))).json()).toMatchObject({
      evidence: { state: "none" },
      lastAction: null,
      statuses: {
        electrical: { state: "not-run" },
        fabrication: { state: "not-run" },
        functional: { state: "not-run" },
        standards: { state: "not-run" },
        sourcing: { state: "unchecked" },
      },
    });
    expect((await readdir(join(root, ".pcboo", "runs"))).length).toBe(1);
  }, 120_000);

  test("client cancellation at the final publication boundary commits no action authority", async () => {
    const { root } = await project();
    let entered!: () => void;
    let release!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publicationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await start(root, {
      beforeActionPublication: async () => {
        entered();
        await publicationGate;
      },
    });
    const controller = new AbortController();
    const request = fetch(new URL("/api/actions/build", server.url), {
      method: "POST",
      headers: {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await publicationStarted;
    controller.abort();
    await Bun.sleep(25);
    release();
    const requestOutcome = await request;
    expect(requestOutcome).toBeInstanceOf(Error);
    expect((requestOutcome as Error).name).toBe("AbortError");

    await waitFor(
      async () => await (await fetch(new URL("/api/actions", server.url))).json() as {
        running: boolean;
      },
      ({ running }) => !running,
    );
    expect(await (await fetch(new URL("/api/actions", server.url))).json()).toMatchObject({
      evidence: { state: "none" },
      running: false,
      lastAction: null,
    });
    expect(await (await fetch(new URL("/api/artifacts", server.url))).json()).toMatchObject({
      evidence: { state: "none" },
      artifacts: [],
    });
    expect(await (await fetch(new URL("/api/checks", server.url))).json()).toMatchObject({
      evidence: { state: "none" },
      lastAction: null,
    });
    expect((await readdir(join(root, ".pcboo", "runs"))).length).toBe(1);
  }, 120_000);

  test.skipIf(process.platform === "win32")(
    "client cancellation terminates a supervised external-tool process tree without publishing it",
    async () => {
      const { root, entry } = await project();
      await Bun.write(
        entry,
        `export default ${canonicalCircuitJson(await manufacturingFixture(2)).trim()}\n`,
      );
      const toolRoot = await mkdtemp(join(tmpdir(), "pcboo-server-cancel-kicad-"));
      roots.push(toolRoot);
      const executable = join(toolRoot, "kicad-cli");
      const childPidPath = join(toolRoot, "child.pid");
      await Bun.write(
        executable,
        `#!${process.execPath}\nif(!process.argv.includes('version'))process.exit(88);try{const child=Bun.spawn({cmd:[process.execPath,'-e','await new Promise(()=>{})'],stdin:'ignore',stdout:'ignore',stderr:'ignore'});await Bun.write(${JSON.stringify(childPidPath)},String(child.pid))}catch{await Bun.write(${JSON.stringify(childPidPath)},'blocked')}await new Promise(()=>{})\n`,
      );
      await chmod(executable, 0o700);
      const server = await start(root, {
        externalToolPaths: { kicadCli: executable },
      });
      const controller = new AbortController();
      const request = fetch(new URL("/api/actions/export-kicad", server.url), {
        method: "POST",
        headers: {
          Origin: server.url.origin,
          "X-PCBoo-Action-Token": server.actionToken,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      }).catch((error: unknown) => error);

      for (
        let attempt = 0;
        attempt < 1_200 && !await Bun.file(childPidPath).exists();
        attempt += 1
      ) await Bun.sleep(25);
      if (!await Bun.file(childPidPath).exists()) {
        const early = await request;
        if (early instanceof Response) {
          const body = await early.json() as {
            result?: { artifacts?: Array<{ path: string }> };
          };
          const errorPath = body.result?.artifacts?.[0]?.path;
          throw new Error(
            errorPath === undefined
              ? `KiCad export ended before the fixture process started: ${JSON.stringify(body)}`
              : `KiCad export ended before the fixture process started: ${await Bun.file(join(root, errorPath)).text()}`,
          );
        }
        throw new Error(
          `KiCad export request failed before the fixture process started: ${String(early)}`,
        );
      }
      expect(await Bun.file(childPidPath).exists()).toBeTrue();
      controller.abort();
      const requestOutcome = await request;
      expect(requestOutcome).toBeInstanceOf(Error);
      expect((requestOutcome as Error).name).toBe("AbortError");

      const childIdentity = await Bun.file(childPidPath).text();
      if (childIdentity === "blocked") {
        expect(process.platform).toBe("darwin");
      } else {
        const childPid = Number(childIdentity);
        expect(Number.isSafeInteger(childPid) && childPid > 0).toBeTrue();
      let childAlive = true;
      for (let attempt = 0; attempt < 100 && childAlive; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(20);
        } catch {
          childAlive = false;
        }
      }
      expect(childAlive).toBeFalse();
      }
      await waitFor(
        async () => await (await fetch(new URL("/api/actions", server.url))).json() as {
          running: boolean;
        },
        ({ running }) => !running,
      );
      expect(await (await fetch(new URL("/api/actions", server.url))).json()).toMatchObject({
        evidence: { state: "none" },
        lastAction: null,
      });
      expect(await (await fetch(new URL("/api/artifacts", server.url))).json()).toMatchObject({
        evidence: { state: "none" },
        artifacts: [],
      });
      expect((await readdir(join(root, ".pcboo", "runs"))).length).toBe(1);
    },
    120_000,
  );

  test("rejects a report replaced before server capture instead of self-authenticating attacker bytes", async () => {
    const { root } = await project();
    const server = await start(root, {
      beforeArtifactAttachment: async (run) => {
        if (run.reportPath !== undefined) await Bun.write(run.reportPath, "{}\n");
      },
    });
    const action = await fetch(new URL("/api/actions/build", server.url), {
      method: "POST",
      headers: {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(action.status).toBe(409);
    expect(await action.json()).toMatchObject({ error: { code: "ACTION_ARTIFACTS_STALE" } });
    expect(await (await fetch(new URL("/api/actions", server.url))).json()).toMatchObject({ lastAction: null });
  });

  test("authenticates command-error artifact references before server attachment", async () => {
    const { root } = await project();
    const server = await start(root, {
      kicadTestHooks: {
        beforeLiveInputWrite: () => {
          throw new Error("deterministic KiCad fixture command failure");
        },
      },
    });
    const headers = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": server.actionToken,
      "Content-Type": "application/json",
    };
    const action = await fetch(new URL("/api/actions/export-kicad", server.url), {
      method: "POST", headers, body: "{}",
    });
    expect(action.status).toBe(200);
    const body = await action.json() as { result: { exitClassification: string; artifacts: Array<{ kind: string; digest?: string }> } };
    expect(body.result.exitClassification).toBe("failure");
    expect(body.result.artifacts).toHaveLength(1);
    expect(body.result.artifacts[0]).toMatchObject({ kind: "command-error" });
    expect(body.result.artifacts[0]?.digest).toMatch(/^(?:sha256:)?[a-f0-9]{64}$/);
    const artifacts = await fetch(new URL("/api/artifacts", server.url));
    expect(artifacts.status).toBe(200);
    expect(await artifacts.json()).toMatchObject({ artifacts: [{ kind: "command-error" }] });
  }, 120_000);

  test("returns a typed 409 instead of current artifact metadata after byte or symlink replacement", async () => {
    for (const attack of ["bytes", ...(process.platform === "win32" ? [] : ["symlink"])] as const) {
      const { root } = await project();
      const server = await start(root);
      const headers = {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      };
      const action = await fetch(new URL("/api/actions/build", server.url), {
        method: "POST", headers, body: "{}",
      });
      expect(action.status, attack).toBe(200);
      const body = await action.json() as { result: { artifacts: Array<{ path: string }> }; reportPath: string };
      const artifactPath = join(root, body.result.artifacts[0]!.path);
      if (attack === "bytes") {
        await Bun.write(artifactPath, "mutated after attachment\n");
      } else {
        await rm(artifactPath);
        await symlink("report.json", artifactPath);
      }
      for (const route of ["/api/artifacts", "/manufacturing", "/api/checks", "/checks", "/api/actions"]) {
        const artifacts = await fetch(new URL(route, server.url));
        expect(artifacts.status, `${attack}:${route}`).toBe(409);
        const responseText = await artifacts.text();
        if (route.startsWith("/api/")) {
          const stale = JSON.parse(responseText) as { error: { code: string }; artifacts?: unknown };
          expect(stale.error.code, `${attack}:${route}`).toBe("ARTIFACT_EVIDENCE_STALE");
          expect(stale.artifacts, `${attack}:${route}`).toBeUndefined();
        } else {
          expect(responseText, `${attack}:${route}`).toContain("Stored artifact evidence changed");
        }
        expect(responseText, `${attack}:${route}`).not.toContain(body.result.artifacts[0]!.path);
      }
      const head = await fetch(new URL("/api/artifacts", server.url), { method: "HEAD" });
      expect(head.status, attack).toBe(409);
    }
  }, 120_000);

  test.skipIf(process.platform === "win32")("guards retained simulation artifacts on every simulation route", async () => {
    const { root } = await project();
    const toolRoot = await mkdtemp(join(tmpdir(), "pcboo-server-ngspice-artifacts-"));
    roots.push(toolRoot);
    const executable = join(toolRoot, "ngspice");
    const raw = [
      "Title: fixture", "Plotname: Operating Point", "Flags: real", "No. Variables: 1", "No. Points: 1",
      "Variables:", "0 v(vin) voltage", "Values:", "0 5", "",
    ].join("\n");
    await Bun.write(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('ngspice-44');process.exit(0)}const i=process.argv.indexOf('-r');await Bun.write(process.argv[i+1],${JSON.stringify(raw)});\n`);
    await chmod(executable, 0o700);
    const server = await start(root, { externalToolPaths: { ngspice: executable } });
    const headers = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": server.actionToken,
      "Content-Type": "application/json",
    };
    const action = await fetch(new URL("/api/actions/simulate", server.url), {
      method: "POST", headers, body: JSON.stringify({ name: "smoke" }),
    });
    expect(action.status).toBe(200);
    const body = await action.json() as { result: { artifacts: Array<{ kind: string; path: string }> } };
    const artifact = body.result.artifacts.find(({ kind }) => kind.startsWith("simulation-") || kind === "command-error");
    expect(artifact).toBeDefined();
    await Bun.write(join(root, artifact!.path), "mutated retained simulation artifact\n");
    for (const route of ["/api/simulations", "/simulations/smoke"]) {
      const response = await fetch(new URL(route, server.url));
      expect(response.status, route).toBe(409);
      const responseText = await response.text();
      if (route.startsWith("/api/")) {
        expect(JSON.parse(responseText), route).toMatchObject({ error: { code: "ARTIFACT_EVIDENCE_STALE" } });
      } else {
        expect(responseText, route).toContain("Stored artifact evidence changed");
      }
      expect(responseText, route).not.toContain(artifact!.path);
    }
  }, 120_000);

  test("authenticates exposed action reports and rejects byte or symlink replacement", async () => {
    for (const attack of ["bytes", ...(process.platform === "win32" ? [] : ["symlink"])] as const) {
      const { root } = await project();
      const server = await start(root);
      const headers = {
        Origin: server.url.origin,
        "X-PCBoo-Action-Token": server.actionToken,
        "Content-Type": "application/json",
      };
      const action = await fetch(new URL("/api/actions/build", server.url), {
        method: "POST", headers, body: "{}",
      });
      expect(action.status, attack).toBe(200);
      const body = await action.json() as { reportPath: string; result: { artifacts: Array<{ path: string }> } };
      const reportPath = join(root, body.reportPath);
      if (attack === "bytes") {
        await Bun.write(reportPath, "mutated report\n");
      } else {
        await rm(reportPath);
        await symlink("circuit.json", reportPath);
      }
      for (const route of ["/api/actions", "/api/checks", "/checks"]) {
        for (const method of ["GET", "HEAD"] as const) {
          const response = await fetch(new URL(route, server.url), { method });
          expect(response.status, `${attack}:${route}:${method}`).toBe(409);
          if (method === "GET") {
            const text = await response.text();
            if (route.startsWith("/api/")) {
              expect(JSON.parse(text), `${attack}:${route}`).toMatchObject({ error: { code: "ARTIFACT_EVIDENCE_STALE" } });
            } else {
              expect(text, `${attack}:${route}`).toContain("Stored artifact evidence changed");
            }
            expect(text, `${attack}:${route}`).not.toContain(body.reportPath);
          }
        }
      }
    }
  }, 120_000);

  test("authenticates zero-artifact simulation reports on action and simulation routes", async () => {
    const { root } = await project();
    const server = await start(root, { externalToolPaths: { ngspice: null } });
    const headers = {
      Origin: server.url.origin,
      "X-PCBoo-Action-Token": server.actionToken,
      "Content-Type": "application/json",
    };
    const action = await fetch(new URL("/api/actions/simulate", server.url), {
      method: "POST", headers, body: JSON.stringify({ name: "smoke" }),
    });
    expect(action.status).toBe(200);
    const body = await action.json() as { reportPath: string; result: { artifacts: unknown[] } };
    expect(body.result.artifacts).toEqual([]);
    await Bun.write(join(root, body.reportPath), "mutated unavailable-simulation report\n");
    for (const route of ["/api/actions", "/api/simulations", "/simulations/smoke"]) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await fetch(new URL(route, server.url), { method });
        expect(response.status, `${route}:${method}`).toBe(409);
        if (method === "GET") {
          const text = await response.text();
          expect(text, route).toContain("Stored artifact evidence changed");
          expect(text, route).not.toContain(body.reportPath);
        }
      }
    }
  }, 120_000);

  test("binds simulation routes and freshness to definition and model input authority", async () => {
    const { root } = await project();
    const server = await start(root, { watchDebounceMs: 20 });
    const initial = await (await fetch(new URL("/api/project", server.url))).json() as {
      snapshot: { revision: number; projectDigest: string };
      server: { actionToken: string };
    };
    const headers = { Origin: server.url.origin, "X-PCBoo-Action-Token": initial.server.actionToken, "Content-Type": "application/json" };
    const action = await fetch(new URL("/api/actions/simulate", server.url), {
      method: "POST", headers, body: JSON.stringify({ name: "smoke" }),
    });
    expect(action.status).toBe(200);
    const actionBody = await action.json() as { result: { statuses: { functional: { state: string } }; diagnostics: Array<{ id: string }> }; reportPath: string };
    expect(actionBody.result.statuses.functional.state).toBe("unavailable");

    const current = await (await fetch(new URL("/api/simulations", server.url))).json() as {
      simulations: Array<{ name: string; freshness: string; status: { state: string }; diagnostics: Array<{ id: string }>; reportPath: string }>;
    };
    expect(current.simulations).toHaveLength(1);
    expect(current.simulations[0]).toMatchObject({
      name: "smoke", freshness: "current", status: { state: "unavailable" },
      diagnostics: [{ id: "SIM_NGSPICE_UNAVAILABLE_001" }], reportPath: actionBody.reportPath,
    });
    expect(await (await fetch(new URL("/simulations/smoke", server.url))).text()).toContain("current");

    const testbenchPath = join(root, "simulations", "smoke.testbench.ts");
    await writeSmokeTestbench(root, `sha256:${new Bun.CryptoHasher("sha256").update(".model fixture R\n").digest("hex")}`, 4);
    const changedDefinition = await waitFor(
      async () => await (await fetch(new URL("/api/project", server.url))).json() as { snapshot: { state: string; revision: number; projectDigest: string } },
      ({ snapshot }) => snapshot.state === "ready" && snapshot.revision > initial.snapshot.revision,
    );
    expect(changedDefinition.snapshot.projectDigest).not.toBe(initial.snapshot.projectDigest);
    const staleAfterDefinition = await fetch(new URL("/api/simulations", server.url));
    expect(staleAfterDefinition.status).toBe(409);
    expect(await staleAfterDefinition.json()).toMatchObject({ error: { code: "ARTIFACT_EVIDENCE_STALE" } });
    expect((await fetch(new URL("/simulations/smoke", server.url))).status).toBe(409);

    const changedModel = ".model fixture R Rshunt=1e12\n";
    await Bun.write(join(root, "models", "smoke.model"), changedModel);
    const changedModelDigest = `sha256:${new Bun.CryptoHasher("sha256").update(changedModel).digest("hex")}`;
    await writeSmokeTestbench(root, changedModelDigest, 4);
    const afterModel = await waitFor(
      async () => await (await fetch(new URL("/api/project", server.url))).json() as { snapshot: { state: string; revision: number; projectDigest: string } },
      ({ snapshot }) => snapshot.state === "ready" && snapshot.revision > changedDefinition.snapshot.revision,
    );
    expect(afterModel.snapshot.projectDigest).not.toBe(changedDefinition.snapshot.projectDigest);

    const discoveryServer = await start(root, { watchDebounceMs: 20 });
    const other = (await Bun.file(testbenchPath).text()).replace('"name":"smoke"', '"name":"other"');
    await Bun.write(join(root, "simulations", "other.testbench.ts"), other);
    await waitFor(
      async () => await (await fetch(new URL("/api/simulations", discoveryServer.url))).json() as { simulations: Array<{ name: string }> },
      ({ simulations }) => simulations.some(({ name }) => name === "other"),
    );
    await rm(join(root, "simulations", "other.testbench.ts"));
    await waitFor(
      async () => await (await fetch(new URL("/api/simulations", discoveryServer.url))).json() as { simulations: Array<{ name: string }> },
      ({ simulations }) => !simulations.some(({ name }) => name === "other"),
    );
  }, 120_000);

  test("watches an existing empty simulations directory for its first testbench and deletion", async () => {
    const { root } = await project();
    await rm(join(root, "simulations", "smoke.testbench.ts"));
    const server = await start(root, { watchDebounceMs: 20 });
    expect((await (await fetch(new URL("/api/simulations", server.url))).json() as { simulations: unknown[] }).simulations).toEqual([]);
    const model = await Bun.file(join(root, "models", "smoke.model")).text();
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(model).digest("hex")}`;
    await writeSmokeTestbench(root, digest);
    await waitFor(
      async () => await (await fetch(new URL("/api/simulations", server.url))).json() as { simulations: Array<{ name: string }> },
      ({ simulations }) => simulations.some(({ name }) => name === "smoke"),
    );
    await rm(join(root, "simulations", "smoke.testbench.ts"));
    await waitFor(
      async () => await (await fetch(new URL("/api/simulations", server.url))).json() as { simulations: Array<{ name: string }> },
      ({ simulations }) => simulations.length === 0,
    );
  }, 15_000);

  test("never changes source bytes and stops gracefully more than once", async () => {
    const { root, entry } = await project();
    const before = await readFile(entry);
    const server = await start(root);
    await fetch(new URL("/pcb", server.url));
    await fetch(new URL("/api/inspect?id=pcb_component_1", server.url));
    await fetch(new URL("/checks", server.url));
    expect(Buffer.compare(before, await readFile(entry))).toBe(0);
    await server.stop();
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
  });

  test("cancels an in-flight non-settling rebuild during shutdown", async () => {
    const { root, entry } = await project();
    const server = await start(root, { watchDebounceMs: 20 });
    await Bun.write(entry, "while (true) {}\nexport default []\n");
    await waitFor(
      async () => await (await fetch(new URL("/api/project", server.url))).json() as { snapshot: { state: string } },
      ({ snapshot }) => snapshot.state === "pending",
    );
    await Bun.sleep(250);
    const started = performance.now();
    await server.stop();
    expect(performance.now() - started).toBeLessThan(2_000);
    servers.splice(servers.indexOf(server), 1);
  }, 10_000);
});
