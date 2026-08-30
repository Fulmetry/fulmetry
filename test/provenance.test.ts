import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDiagnostic, diagnosticId } from "../src/diagnostics";
import {
  deriveCircuitEntityHierarchy,
  deriveEntityProvenance,
  enrichDiagnosticProvenance,
  indexAuthoredNames,
} from "../src/project/provenance";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("nearest honest TypeScript provenance", () => {
  test("derives hierarchical instance paths for nested generated manufacturing entities", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-hierarchy-"));
    roots.push(root);
    await mkdir(join(root, "src", "channels"), { recursive: true });
    await Bun.write(
      join(root, "src", "channels", "channel.ts"),
      "export const channel = { name: 'channelA', part: { name: 'R1' }, net: { name: 'SIG' }, route: { name: 'ROUTE' } }\n",
    );
    await Bun.write(
      join(root, "src", "board.ts"),
      "import { channel } from './channels/channel'\nexport const board = { name: 'board', channel }\n",
    );
    const circuitJson = [
      { type: "source_group", source_group_id: "source_group_root", subcircuit_id: "sub_root", name: "board", was_automatically_named: false },
      { type: "source_board", source_board_id: "source_board_1", source_group_id: "source_group_root" },
      { type: "source_group", source_group_id: "source_group_channel", subcircuit_id: "sub_channel", parent_source_group_id: "source_group_root", parent_subcircuit_id: "sub_root", name: "channelA", was_automatically_named: false },
      { type: "source_component", source_component_id: "source_component_1", source_group_id: "source_group_channel", name: "R1" },
      { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1", subcircuit_id: "sub_channel" },
      { type: "pcb_smtpad", pcb_smtpad_id: "pcb_smtpad_1", pcb_component_id: "pcb_component_1", port_hints: ["1"], subcircuit_id: "sub_channel" },
      { type: "source_net", source_net_id: "source_net_1", name: "SIG", subcircuit_id: "sub_channel" },
      { type: "source_trace", source_trace_id: "source_trace_1", name: "ROUTE", subcircuit_id: "sub_channel" },
      { type: "pcb_trace", pcb_trace_id: "pcb_trace_1", source_trace_id: "source_trace_1", subcircuit_id: "sub_channel" },
      { type: "pcb_via", pcb_via_id: "pcb_via_1", pcb_trace_id: "pcb_trace_1", subcircuit_id: "sub_channel" },
    ];
    const provenance = await deriveEntityProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson,
    });
    expect(provenance).toHaveLength(7);
    expect(provenance.find(({ elementId }) => elementId === "pcb_component_1"))
      .toEqual(expect.objectContaining({
        kind: "component",
        instancePath: [
          "group:board", "group:channelA", "component:R1", "record:pcb_component_1",
        ],
        origin: "authored",
        sourceLocations: [expect.stringMatching(/^src\/channels\/channel\.ts:1:\d+$/u)],
      }));
    expect(provenance.find(({ elementId }) => elementId === "pcb_smtpad_1")?.instancePath)
      .toEqual([
        "group:board", "group:channelA", "component:R1", "pad:1", "record:pcb_smtpad_1",
      ]);
    expect(provenance.find(({ elementId }) => elementId === "source_net_1")?.instancePath)
      .toEqual(["group:board", "group:channelA", "net:SIG", "record:source_net_1"]);
    expect(provenance.find(({ elementId }) => elementId === "pcb_trace_1")?.instancePath)
      .toEqual(["group:board", "group:channelA", "trace:ROUTE", "record:pcb_trace_1"]);
    expect(provenance.find(({ elementId }) => elementId === "pcb_via_1")?.instancePath)
      .toEqual(["group:board", "group:channelA", "trace:ROUTE", "via:pcb_via_1"]);

    expect(new Set(provenance.map(({ instancePath }) => instancePath.join("/"))).size)
      .toBe(provenance.length);

    const [diagnostic] = await enrichDiagnosticProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson,
      diagnostics: [defineDiagnostic({
        id: diagnosticId("FAB_HIERARCHY_TEST_001"),
        severity: "error",
        dimension: "fabrication",
        message: "Nested via violates a rule",
        waiverPolicy: "forbidden",
        objects: ["pcb_via_1"],
        sourceLocations: [],
      })],
    });
    expect(diagnostic?.evidence).toContain(
      "provenance:instance-path:group:board/group:channelA/trace:ROUTE/via:pcb_via_1",
    );
  });

  test("rejects contradictory direct and referenced entity ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-conflict-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Bun.write(join(root, "src/board.ts"), "export default { name: 'R1' }\n");
    const circuitJson = [
      { type: "source_group", source_group_id: "source_group_root", subcircuit_id: "sub_root", name: "root" },
      { type: "source_board", source_board_id: "source_board_1", source_group_id: "source_group_root" },
      { type: "source_group", source_group_id: "source_group_child", subcircuit_id: "sub_child", parent_source_group_id: "source_group_root", name: "child" },
      { type: "source_component", source_component_id: "source_component_1", source_group_id: "source_group_root", name: "R1" },
      { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1", subcircuit_id: "sub_root" },
      { type: "pcb_smtpad", pcb_smtpad_id: "pcb_smtpad_1", pcb_component_id: "pcb_component_1", port_hints: ["1"], subcircuit_id: "sub_child" },
    ];
    await expect(deriveEntityProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson,
    })).rejects.toThrow(
      "pcb_smtpad_1 has contradictory source-group ownership: source_group_child, source_group_root",
    );
  });

  test("nests same-numbered pads beneath distinct component instances", () => {
    const hierarchy = deriveCircuitEntityHierarchy([
      { type: "source_group", source_group_id: "g", subcircuit_id: "s", name: "board" },
      { type: "source_board", source_board_id: "b", source_group_id: "g" },
      { type: "source_component", source_component_id: "sc1", source_group_id: "g", name: "R1" },
      { type: "source_component", source_component_id: "sc2", source_group_id: "g", name: "R2" },
      { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", subcircuit_id: "s" },
      { type: "pcb_component", pcb_component_id: "pc2", source_component_id: "sc2", subcircuit_id: "s" },
      { type: "pcb_smtpad", pcb_smtpad_id: "p1", pcb_component_id: "pc1", port_hints: ["1"], subcircuit_id: "s" },
      { type: "pcb_smtpad", pcb_smtpad_id: "p2", pcb_component_id: "pc2", port_hints: ["1"], subcircuit_id: "s" },
    ]);
    expect(hierarchy.find(({ elementId }) => elementId === "p1")?.instancePath).toEqual([
      "group:board", "component:R1", "pad:1", "record:p1",
    ]);
    expect(hierarchy.find(({ elementId }) => elementId === "p2")?.instancePath).toEqual([
      "group:board", "component:R2", "pad:1", "record:p2",
    ]);
    expect(new Set(hierarchy.map(({ instancePath }) => instancePath.join("/"))).size)
      .toBe(hierarchy.length);
  });

  test("rejects same-group references that disagree about a pad's component", () => {
    expect(() => deriveCircuitEntityHierarchy([
      { type: "source_group", source_group_id: "g", subcircuit_id: "s", name: "board" },
      { type: "source_board", source_board_id: "b", source_group_id: "g" },
      { type: "source_component", source_component_id: "sc1", source_group_id: "g", name: "R1" },
      { type: "source_component", source_component_id: "sc2", source_group_id: "g", name: "R2" },
      { type: "source_port", source_port_id: "sp2", source_component_id: "sc2", subcircuit_id: "s", name: "pin1", pin_number: 1 },
      { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", subcircuit_id: "s" },
      { type: "pcb_component", pcb_component_id: "pc2", source_component_id: "sc2", subcircuit_id: "s" },
      { type: "pcb_port", pcb_port_id: "pp2", pcb_component_id: "pc2", source_port_id: "sp2", subcircuit_id: "s" },
      { type: "pcb_smtpad", pcb_smtpad_id: "pad", pcb_component_id: "pc1", pcb_port_id: "pp2", subcircuit_id: "s", port_hints: ["1"] },
    ])).toThrow("pad has contradictory source_component ownership: sc1, sc2");
  });

  test("rejects same-component references that disagree about a pad's source port", () => {
    expect(() => deriveCircuitEntityHierarchy([
      { type: "source_group", source_group_id: "g", subcircuit_id: "s", name: "board" },
      { type: "source_board", source_board_id: "b", source_group_id: "g" },
      { type: "source_component", source_component_id: "sc", source_group_id: "g", name: "U1" },
      { type: "source_port", source_port_id: "sp1", source_component_id: "sc", subcircuit_id: "s", name: "pin1", pin_number: 1 },
      { type: "source_port", source_port_id: "sp2", source_component_id: "sc", subcircuit_id: "s", name: "pin2", pin_number: 2 },
      { type: "pcb_component", pcb_component_id: "pc", source_component_id: "sc", subcircuit_id: "s" },
      { type: "pcb_port", pcb_port_id: "pp1", pcb_component_id: "pc", source_port_id: "sp1", subcircuit_id: "s" },
      {
        type: "pcb_smtpad", pcb_smtpad_id: "pad", pcb_component_id: "pc",
        pcb_port_id: "pp1", source_port_id: "sp2", subcircuit_id: "s", port_hints: ["1"],
      },
    ])).toThrow("pad has contradictory source_port ownership: sp1, sp2");
  });

  test("follows parent-subcircuit-only ancestry and rejects contradictory parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-parent-subcircuit-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Bun.write(join(root, "src/board.ts"), "export default { name: 'R1' }\n");
    const circuitJson = [
      { type: "source_group", source_group_id: "root", subcircuit_id: "sub_root", name: "root" },
      { type: "source_board", source_board_id: "source_board_1", source_group_id: "root" },
      { type: "source_group", source_group_id: "other", subcircuit_id: "sub_other", parent_source_group_id: "root", name: "other" },
      { type: "source_group", source_group_id: "child", subcircuit_id: "sub_child", parent_subcircuit_id: "sub_root", name: "child" },
      { type: "source_component", source_component_id: "c1", source_group_id: "child", name: "R1" },
    ];
    const provenance = await deriveEntityProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson,
    });
    expect(provenance[0]?.instancePath).toEqual([
      "group:root",
      "group:child",
      "component:R1",
      "record:c1",
    ]);

    (circuitJson[3] as Record<string, unknown>).parent_source_group_id = "other";
    await expect(deriveEntityProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson,
    })).rejects.toThrow("Source group child has contradictory parent hierarchy: other, root");

    delete (circuitJson[3] as Record<string, unknown>).parent_source_group_id;
    delete (circuitJson[2] as Record<string, unknown>).parent_source_group_id;
    await expect(deriveEntityProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson,
    })).rejects.toThrow("Source group other is disconnected from source_board root root");
  });

  test("indexes literal component names across composed source files and maps generated IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-"));
    roots.push(root);
    await mkdir(join(root, "src", "components"), { recursive: true });
    await Bun.write(
      join(root, "src", "components", "indicator.ts"),
      "export const indicator = {\n  name: 'R1',\n  resistance: 1000,\n}\n",
    );
    await Bun.write(
      join(root, "src", "board.ts"),
      "import { indicator } from './components/indicator'\nexport default [indicator]\n",
    );
    const names = await indexAuthoredNames({ projectRoot: root, entry: "src/board.ts" });
    expect(names.get("R1")).toEqual(["src/components/indicator.ts:2:9"]);

    const diagnostic = defineDiagnostic({
      id: diagnosticId("ELECTRICAL_PROVENANCE_TEST_001"),
      severity: "error",
      dimension: "electrical",
      message: "R1 manufactured endpoint is disconnected",
      waiverPolicy: "forbidden",
      objects: ["pcb_component_1"],
      sourceLocations: [],
    });
    const [enriched] = await enrichDiagnosticProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson: [
        { type: "source_component", source_component_id: "source_component_1", name: "R1" },
        { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1" },
      ],
      diagnostics: [diagnostic],
    });
    expect(enriched?.sourceLocations).toEqual(["src/components/indicator.ts:2:9"]);
    expect(enriched?.evidence).toContain("provenance:nearest-authored-name");
  });

  test("labels evidence as generated or unavailable instead of inventing a location", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-empty-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Bun.write(join(root, "src/board.ts"), "export default []\n");
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_SYNTHETIC_TEST_001"),
      severity: "error",
      dimension: "fabrication",
      message: "Synthetic board geometry failed",
      waiverPolicy: "forbidden",
      objects: ["pcb_board_generated"],
      sourceLocations: [],
    });
    const [enriched] = await enrichDiagnosticProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson: [],
      diagnostics: [diagnostic],
    });
    expect(enriched?.sourceLocations).toEqual([]);
    expect(enriched?.evidence).toContain("provenance:synthetic-generated");
  });

  test("does not invent one source location for a reused ambiguous name", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-ambiguous-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Bun.write(
      join(root, "src/board.ts"),
      "const first = { name: 'R1' }\nconst second = { name: 'R1' }\nexport default [first, second]\n",
    );
    const diagnostic = defineDiagnostic({
      id: diagnosticId("ELECTRICAL_AMBIGUOUS_PROVENANCE_001"),
      severity: "error",
      dimension: "electrical",
      message: "Ambiguous reused component name",
      waiverPolicy: "forbidden",
      objects: ["pcb_component_1"],
      sourceLocations: [],
    });
    const [enriched] = await enrichDiagnosticProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson: [
        { type: "source_component", source_component_id: "source_component_1", name: "R1" },
        { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1" },
      ],
      diagnostics: [diagnostic],
    });
    expect(enriched?.sourceLocations).toEqual([]);
    expect(enriched?.evidence).toContain("provenance:ambiguous-authored-name");
  });

  test("does not accept a unique authored decoy that is absent from Circuit JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-decoy-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Bun.write(
      join(root, "src/board.ts"),
      "const decoy = { name: 'DECOY' }\nexport default []\n",
    );
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_DECOY_PROVENANCE_001"),
      severity: "warning",
      dimension: "fabrication",
      message: "A source-only decoy must not prove manufactured-object provenance",
      waiverPolicy: "forbidden",
      objects: ["DECOY"],
      sourceLocations: [],
    });
    const [enriched] = await enrichDiagnosticProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson: [],
      diagnostics: [diagnostic],
    });
    expect(enriched?.sourceLocations).toEqual([]);
    expect(enriched?.evidence).toContain("provenance:authored-location-unavailable");
  });

  test("does not resolve fabricated selector suffixes through a valid base object", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-selector-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Bun.write(
      join(root, "src/board.ts"),
      "const resistor = { name: 'R1' }\nexport default [resistor]\n",
    );
    const diagnostics = ["R1.not-a-real-child", "pcb_component_1:not-a-real-region"].map(
      (object, index) => defineDiagnostic({
        id: diagnosticId(`FAB_INVALID_SELECTOR_${index + 1}_001`),
        severity: "warning",
        dimension: "fabrication",
        message: "A fabricated selector must not inherit its base object's provenance",
        waiverPolicy: "forbidden",
        objects: [object],
        sourceLocations: [],
      }),
    );
    const enriched = await enrichDiagnosticProvenance({
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson: [
        { type: "source_component", source_component_id: "source_component_1", name: "R1" },
        { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1" },
      ],
      diagnostics,
    });
    expect(enriched.map(({ sourceLocations }) => sourceLocations)).toEqual([[], []]);
    expect(enriched.every(({ evidence }) =>
      evidence?.includes("provenance:authored-location-unavailable")
    )).toBeTrue();
  });

  test("can locate colon detail tokens only when they are trusted Fulmetry assessment output", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-provenance-internal-detail-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await Bun.write(
      join(root, "src/board.ts"),
      "const resistor = { name: 'R1' }\nexport default [resistor]\n",
    );
    const diagnostic = defineDiagnostic({
      id: diagnosticId("ELECTRICAL_INTERNAL_DETAIL_001"),
      severity: "error",
      dimension: "electrical",
      message: "Fulmetry generated a trace detail token",
      waiverPolicy: "forbidden",
      objects: ["pcb_component_1:dangling-start"],
      sourceLocations: [],
    });
    const common = {
      projectRoot: root,
      entry: "src/board.ts",
      circuitJson: [
        { type: "source_component", source_component_id: "source_component_1", name: "R1" },
        { type: "pcb_component", pcb_component_id: "pcb_component_1", source_component_id: "source_component_1" },
      ],
      diagnostics: [diagnostic],
    } as const;
    const [strict] = await enrichDiagnosticProvenance(common);
    const [internal] = await enrichDiagnosticProvenance({
      ...common,
      allowInternalDetailSelectors: true,
    });
    expect(strict?.sourceLocations).toEqual([]);
    expect(internal?.sourceLocations).toEqual(["src/board.ts:1:26"]);
    expect(internal?.evidence).toContain("provenance:nearest-authored-name");
  });
});
