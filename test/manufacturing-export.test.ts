import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";
import { manufacturingFixture } from "./fixtures/manufacturing";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("manufacturing export adapter", () => {
  test("emits deterministic two-layer Gerber, drill, BOM, and placement bytes", async () => {
    const circuitJson = await manufacturingFixture(2);
    const first = await exportManufacturingFiles({ boardName: "control", circuitJson });
    await Bun.sleep(5);
    const second = await exportManufacturingFiles({ boardName: "control", circuitJson });

    expect(second).toEqual(first);
    expect(first.some((file) => file.path.endsWith("F_Cu.gbr"))).toBeTrue();
    expect(first.some((file) => file.path.endsWith("B_Cu.gbr"))).toBeTrue();
    expect(first.some((file) => file.path === "drills/drill-L1-L2.drl")).toBeTrue();
    expect(first.some((file) => file.path === "drills/drill_npth.drl")).toBeTrue();
    expect(first.some((file) => file.path === "assembly/bom.csv")).toBeTrue();
    expect(first.some((file) => file.path === "assembly/positions.csv")).toBeTrue();
    expect(first.some((file) => file.path === "fabrication/metadata.json")).toBeTrue();
    expect(first.map((file) => file.content).join("\n")).not.toContain(
      "CreationDate",
    );
    expect(first.map((file) => file.content).join("\n")).not.toContain(
      "Created by tscircuit (builder) date",
    );
    for (const file of first.filter(({ kind }) => kind === "gerber")) {
      expect(file.content).toContain(
        "%TF.GenerationSoftware,tscircuit,circuit-json-to-gerber,0.0.90*%",
      );
      expect(file.content).not.toContain("circuit-json-to-gerber,0.0.89");
    }
  });

  test("emits distinct non-empty inner copper files for four layers", async () => {
    const circuitJson = await manufacturingFixture(4);
    const files = await exportManufacturingFiles({
      boardName: "four-layer",
      circuitJson,
    });

    const inner1 = files.find((file) => file.path.endsWith("In1_Cu.gbr"));
    const inner2 = files.find((file) => file.path.endsWith("In2_Cu.gbr"));
    expect(inner1?.content).toContain("TF.FileFunction,Copper,L2,Inr");
    expect(inner2?.content).toContain("TF.FileFunction,Copper,L3,Inr");
    expect(inner1?.content).not.toEqual(inner2?.content);
    expect(files.some((file) => file.path.endsWith("drill-L1-L4.drl"))).toBeTrue();
    const expectation = deriveManufacturingExpectation({ boardName: "four-layer", circuitJson });
    expect(expectation.copperSegments.In1_Cu).toHaveLength(1);
    expect(expectation.copperSegments.In2_Cu).toHaveLength(1);
    for (const layer of ["In1_Cu", "In2_Cu"] as const) {
      const sources = new Set(expectation.flashes[layer]?.map(({ source }) => source));
      expect(sources.has("pcb_plated_hole_0")).toBeTrue();
      expect(sources.has("pcb_plated_hole_1")).toBeTrue();
      expect([...sources].some((source) => source.startsWith("pcb_via_"))).toBeTrue();
    }
  });

  test("does not claim independent reconciliation for asymmetric mask margins", async () => {
    const circuitJson = await manufacturingFixture(2);
    const pad = circuitJson.find(
      (element) => element.type === "pcb_smtpad" && element.shape === "rect",
    );
    if (pad?.type !== "pcb_smtpad" || pad.shape !== "rect") {
      throw new Error("Fixture rectangular SMT pad missing");
    }
    pad.soldermask_margin_right = 0.15;

    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining(`${pad.pcb_smtpad_id}: asymmetric solder-mask margins`),
    );
  });

  test("publishes a new draft directory atomically and refuses overwrite", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pcboo-emission-"));
    temporaryRoots.push(parent);
    const targetDirectory = join(parent, "run-001", "draft");
    const files = await exportManufacturingFiles({
      boardName: "control",
      circuitJson: await manufacturingFixture(2),
    });

    const emitted = await emitDraftManufacturingDirectory({
      targetDirectory,
      files,
    });

    expect(emitted).toHaveLength(files.length);
    expect(await Bun.file(join(targetDirectory, "assembly/bom.csv")).exists()).toBeTrue();
    expect(
      emitDraftManufacturingDirectory({ targetDirectory, files }),
    ).rejects.toThrow("Refusing to overwrite");
  });

  test("rejects unsafe names and anything other than one supported board", async () => {
    const circuitJson = await manufacturingFixture(2);
    expect(
      exportManufacturingFiles({ boardName: "../escape", circuitJson }),
    ).rejects.toThrow("Unsafe board name");
    expect(
      exportManufacturingFiles({ boardName: "control", circuitJson: [] }),
    ).rejects.toThrow("exactly one board");
    const duplicated = [
      ...circuitJson,
      { ...circuitJson.find((element) => element.type === "pcb_board")! },
    ];
    expect(
      exportManufacturingFiles({ boardName: "control", circuitJson: duplicated }),
    ).rejects.toThrow("exactly one board");
  });
});
