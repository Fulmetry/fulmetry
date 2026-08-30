import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rename, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyCircuitElement } from "tscircuit";
import {
  deriveManufacturingExpectation as deriveManufacturingExpectationImplementation,
} from "../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import {
  MANUFACTURING_ARTIFACT_ENTRY_LIMIT,
  MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT,
  MANUFACTURING_ARTIFACT_TOTAL_BYTES_LIMIT,
  MANUFACTURING_CSV_ROW_LIMIT,
  MANUFACTURING_PARSER_RECORD_LIMIT,
  MANUFACTURING_RECONCILIATION_FEATURE_LIMIT,
  MANUFACTURING_TEXT_LINE_LIMIT,
  verifyManufacturingDirectory as verifyManufacturingDirectoryImplementation,
} from "../src/manufacturing/verify";
import { manufacturingFixture } from "./fixtures/manufacturing";
import { loadCanonicalFixture } from "./fixtures/canonical";
import {
  MANUFACTURING_FINDING_CODE_DIRECT_TEST,
  MANUFACTURING_NEGATIVE_CORPUS,
} from "./fixtures/manufacturing-negative-corpus";

const temporaryRoots: string[] = [];
type SourcePortElement = Extract<AnyCircuitElement, { type: "source_port" }>;
type PcbPortElement = Extract<AnyCircuitElement, { type: "pcb_port" }>;
const circuitJsonByExpectation = new WeakMap<object, readonly AnyCircuitElement[]>();

function deriveManufacturingExpectation(
  options: Parameters<typeof deriveManufacturingExpectationImplementation>[0],
): ReturnType<typeof deriveManufacturingExpectationImplementation> {
  const expectation = deriveManufacturingExpectationImplementation(options);
  circuitJsonByExpectation.set(expectation, options.circuitJson);
  return expectation;
}

function cloneExpectation<T extends object>(expectation: T): T {
  const clone = structuredClone(expectation);
  const circuitJson = circuitJsonByExpectation.get(expectation);
  if (circuitJson !== undefined) circuitJsonByExpectation.set(clone, circuitJson);
  return clone;
}

async function verifyManufacturingDirectory(
  options: Omit<
    Parameters<typeof verifyManufacturingDirectoryImplementation>[0],
    "circuitJson"
  > & { readonly circuitJson?: readonly AnyCircuitElement[] },
) {
  const circuitJson = options.circuitJson ?? circuitJsonByExpectation.get(options.expectation);
  if (circuitJson === undefined) throw new Error("Test expectation lacks Circuit JSON authority");
  return verifyManufacturingDirectoryImplementation({ ...options, circuitJson });
}

async function emittedFixture(layers: 2 | 4) {
  const parent = await mkdtemp(join(tmpdir(), "fulmetry-verify-"));
  temporaryRoots.push(parent);
  const root = join(parent, "draft");
  const circuitJson = await manufacturingFixture(layers);
  await emitDraftManufacturingDirectory({
    targetDirectory: root,
    files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
  });
  const expectation = deriveManufacturingExpectation({
    boardName: "control",
    circuitJson,
  });
  return { parent, root, expectation, circuitJson };
}

async function codes(
  root: string,
  expectation: Awaited<ReturnType<typeof emittedFixture>>["expectation"],
) {
  const result = await verifyManufacturingDirectory({ root, expectation });
  return { result, codes: result.findings.map((finding) => finding.code) };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("independent manufacturing verification", () => {
  test("fails closed before cloning hostile or oversized caller authority", async () => {
    const fixture = await emittedFixture(4);
    const hostileExpectation = new Proxy(fixture.expectation, {
      get(_target, key) {
        if (key === "boardName") throw new Error("hostile boardName getter");
        return Reflect.get(_target, key);
      },
    });
    const hostileResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: hostileExpectation,
      circuitJson: fixture.circuitJson,
    });
    expect(hostileResult.passed).toBeFalse();
    expect(hostileResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "hostile boardName getter",
      }),
    ]);
    expect(hostileResult.artifacts).toEqual([]);

    const oversizedCircuit = structuredClone(fixture.circuitJson) as AnyCircuitElement[];
    Object.assign(oversizedCircuit[0]!, {
      hostileNestedValue: "x".repeat(65_537),
    });
    const oversizedResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: fixture.expectation,
      circuitJson: oversizedCircuit,
    });
    expect(oversizedResult.passed).toBeFalse();
    expect(oversizedResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "Circuit JSON value exceeds 65536 characters",
      }),
    ]);
    expect(oversizedResult.artifacts).toEqual([]);

    const oversizedKeyCircuit = structuredClone(fixture.circuitJson) as AnyCircuitElement[];
    Object.assign(oversizedKeyCircuit[0]!, {
      ["x".repeat(65_537)]: true,
    });
    const oversizedKeyResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: fixture.expectation,
      circuitJson: oversizedKeyCircuit,
    });
    expect(oversizedKeyResult.passed).toBeFalse();
    expect(oversizedKeyResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "Circuit JSON property name exceeds 65536 characters",
      }),
    ]);
    expect(oversizedKeyResult.artifacts).toEqual([]);

    const aggregateKeyCircuit = structuredClone(fixture.circuitJson) as AnyCircuitElement[];
    const aggregateKeyTarget = aggregateKeyCircuit[0]! as unknown as Record<string, unknown>;
    for (let index = 0; index < 129; index += 1) {
      const prefix = `hostileAggregateKey${index}:`;
      aggregateKeyTarget[prefix + "x".repeat(65_536 - prefix.length)] = true;
    }
    const aggregateKeyResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: fixture.expectation,
      circuitJson: aggregateKeyCircuit,
    });
    expect(aggregateKeyResult.passed).toBeFalse();
    expect(aggregateKeyResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "Circuit JSON manufacturing authority exceeds 8388608 string characters",
      }),
    ]);
    expect(aggregateKeyResult.artifacts).toEqual([]);

    const schemaUnknownCircuit = structuredClone(fixture.circuitJson) as AnyCircuitElement[];
    Object.assign(schemaUnknownCircuit[0]!, {
      unverified_magic: "changes-output",
    });
    const schemaUnknownResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: fixture.expectation,
      circuitJson: schemaUnknownCircuit,
    });
    expect(schemaUnknownResult.passed).toBeFalse();
    expect(schemaUnknownResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: expect.stringContaining("schema-unknown field unverified_magic"),
      }),
    ]);
    expect(schemaUnknownResult.artifacts).toEqual([]);

    const accessorCircuit = structuredClone(fixture.circuitJson) as AnyCircuitElement[];
    Object.defineProperty(accessorCircuit[0]!, "hostile", {
      enumerable: true,
      get() {
        throw new Error("Circuit JSON accessor executed");
      },
    });
    const accessorResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: fixture.expectation,
      circuitJson: accessorCircuit,
    });
    expect(accessorResult.passed).toBeFalse();
    expect(accessorResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "Circuit JSON manufacturing authority contains an accessor or hidden property",
      }),
    ]);
    expect(accessorResult.artifacts).toEqual([]);

    const soupAccessor = structuredClone(fixture.circuitJson) as AnyCircuitElement[];
    Object.defineProperty(soupAccessor, "_internal_store", {
      enumerable: true,
      get() {
        throw new Error("Soup decoration accessor executed");
      },
    });
    const soupAccessorResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: fixture.expectation,
      circuitJson: soupAccessor,
    });
    expect(soupAccessorResult.passed).toBeFalse();
    expect(soupAccessorResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "Circuit JSON manufacturing authority contains an accessor or hidden property",
      }),
    ]);
    expect(soupAccessorResult.artifacts).toEqual([]);

    const oversizedSoup = structuredClone(fixture.circuitJson) as AnyCircuitElement[];
    Object.assign(oversizedSoup, {
      _internal_store: { hostile: "x".repeat(65_537) },
    });
    const oversizedSoupResult = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation: fixture.expectation,
      circuitJson: oversizedSoup,
    });
    expect(oversizedSoupResult.passed).toBeFalse();
    expect(oversizedSoupResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "Circuit JSON value exceeds 65536 characters",
      }),
    ]);
    expect(oversizedSoupResult.artifacts).toEqual([]);
  });

  test("requires complete circuit-derived assembly authority for BOM and placement evidence", async () => {
    const coordinated = await emittedFixture(4);
    const omitted = cloneExpectation(coordinated.expectation) as any;
    omitted.assemblyAuthority = [];
    omitted.bomHeaders = [];
    omitted.bomRows = [];
    omitted.placements = [];
    await Bun.write(join(coordinated.root, "assembly/bom.csv"), "");
    await Bun.write(join(coordinated.root, "assembly/positions.csv"), "");
    const coordinatedResult = await verifyManufacturingDirectory({
      root: coordinated.root,
      expectation: omitted,
    });
    expect(coordinatedResult.passed).toBeFalse();
    expect(coordinatedResult.findings).toEqual([
      expect.objectContaining({ code: "MANUFACTURING_INPUT_LIMIT" }),
    ]);
    expect(coordinatedResult.artifacts).toEqual([]);

    const authorityOmission = await emittedFixture(4);
    const withoutAuthority = cloneExpectation(authorityOmission.expectation) as any;
    withoutAuthority.assemblyAuthority = [];
    withoutAuthority.bomRows = [];
    withoutAuthority.placements = [];
    const authorityResult = await verifyManufacturingDirectory({
      root: authorityOmission.root,
      expectation: withoutAuthority,
    });
    expect(authorityResult.passed).toBeFalse();
    expect(authorityResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "manufacturing expectation must exactly match the complete supplied Circuit JSON authority",
      }),
    ]);
    expect(authorityResult.artifacts).toEqual([]);

    const relabeledFixture = await emittedFixture(4);
    const relabeled = cloneExpectation(relabeledFixture.expectation) as any;
    const erasedComponent = relabeled.assemblyAuthority[0];
    relabeled.assemblyAuthority = relabeled.assemblyAuthority.slice(1);
    relabeled.bomRows = relabeled.bomRows.filter(
      (row: any) => row.columns.Designator !== erasedComponent.designator,
    );
    relabeled.placements = relabeled.placements.filter(
      (placement: any) => placement.designator !== erasedComponent.designator,
    );
    for (const layer of Object.keys(relabeled.flashes)) {
      relabeled.flashes[layer] = relabeled.flashes[layer].map((flash: any) =>
        erasedComponent.padSources.includes(flash.source)
          ? { ...flash, source: "pcb_trace_decoy" }
          : flash
      );
    }
    const relabeledResult = await verifyManufacturingDirectory({
      root: relabeledFixture.root,
      expectation: relabeled,
    });
    expect(relabeledResult.passed).toBeFalse();
    expect(relabeledResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "copper flash sources must retain a typed SMT-pad, plated-hole, or via identity",
      }),
    ]);
    expect(relabeledResult.artifacts).toEqual([]);

    const roleForgeryFixture = await emittedFixture(4);
    const roleForgery = cloneExpectation(roleForgeryFixture.expectation) as any;
    roleForgery.assemblyAuthority = roleForgery.assemblyAuthority.map(
      (component: any, index: number) => ({
        ...component,
        designator: `TP${index + 1}`,
        role: "test-point",
        dnp: false,
        bomRequired: false,
        placementRequired: false,
      }),
    );
    roleForgery.bomRows = [];
    roleForgery.placements = [];
    await Bun.write(join(roleForgeryFixture.root, "assembly/bom.csv"), "");
    await Bun.write(join(roleForgeryFixture.root, "assembly/positions.csv"), "");
    const roleForgeryResult = await verifyManufacturingDirectory({
      root: roleForgeryFixture.root,
      expectation: roleForgery,
    });
    expect(roleForgeryResult.passed).toBeFalse();
    expect(roleForgeryResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "test-point assembly authority must own exactly one emitted copper pad source",
      }),
    ]);
    expect(roleForgeryResult.artifacts).toEqual([]);

    const splitFixture = await emittedFixture(4);
    const split = cloneExpectation(splitFixture.expectation) as any;
    const originalPadSources = split.assemblyAuthority.flatMap(
      (component: any) => component.padSources,
    );
    split.assemblyAuthority = originalPadSources.map((padSource: string, index: number) => ({
      sourceComponentId: `source_testpoint_${index + 1}`,
      pcbComponentId: `pcb_testpoint_${index + 1}`,
      designator: `TP${index + 1}`,
      role: "test-point",
      dnp: false,
      bomRequired: false,
      placementRequired: false,
      padSources: [padSource],
    }));
    split.bomRows = [];
    split.placements = [];
    await Bun.write(join(splitFixture.root, "assembly/bom.csv"), "");
    await Bun.write(join(splitFixture.root, "assembly/positions.csv"), "");
    const splitResult = await verifyManufacturingDirectory({
      root: splitFixture.root,
      expectation: split,
    });
    expect(splitResult.passed).toBeFalse();
    expect(splitResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "manufacturing expectation must exactly match the complete supplied Circuit JSON authority",
      }),
    ]);
    expect(splitResult.artifacts).toEqual([]);

    const swappedFixture = await emittedFixture(4);
    const swapped = cloneExpectation(swappedFixture.expectation) as any;
    const firstPad = swapped.assemblyAuthority[0].padSources[0];
    swapped.assemblyAuthority[0].padSources[0] =
      swapped.assemblyAuthority[1].padSources[0];
    swapped.assemblyAuthority[1].padSources[0] = firstPad;
    swapped.assemblyAuthority[0].padSources.sort();
    swapped.assemblyAuthority[1].padSources.sort();
    const swappedResult = await verifyManufacturingDirectory({
      root: swappedFixture.root,
      expectation: swapped,
    });
    expect(swappedResult.passed).toBeFalse();
    expect(swappedResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "manufacturing expectation must exactly match the complete supplied Circuit JSON authority",
      }),
    ]);
    expect(swappedResult.artifacts).toEqual([]);

    const circuitMismatchFixture = await emittedFixture(4);
    for (const { mutate, expectedMessage } of [
      { mutate: (circuitJson: AnyCircuitElement[]) => {
        const board = circuitJson.find((element) => element.type === "pcb_board");
        if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
        board.material = "fr1";
      }, expectedMessage: "manufacturing expectation must exactly match the complete supplied Circuit JSON authority" },
      { mutate: (circuitJson: AnyCircuitElement[]) => {
        const board = circuitJson.find((element) => element.type === "pcb_board");
        if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
        board.thickness = 0;
      }, expectedMessage: "manufacturing expectation must exactly match the complete supplied Circuit JSON authority" },
      { mutate: (circuitJson: AnyCircuitElement[]) => {
        const pad = circuitJson.find((element) => element.type === "pcb_smtpad");
        if (pad?.type !== "pcb_smtpad") throw new Error("Fixture SMT pad missing");
        if (!("x" in pad) || typeof pad.x !== "number") {
          throw new Error("Fixture SMT pad has no point center");
        }
        pad.x += 1;
      }, expectedMessage: "manufacturing expectation must exactly match the complete supplied Circuit JSON authority" },
      { mutate: (circuitJson: AnyCircuitElement[]) => {
        circuitJson.push({
          type: "pcb_copper_text",
          pcb_copper_text_id: "pcb_copper_text_unsupported",
          text: "unsupported",
          layer: "top",
          anchor_position: { x: 0, y: 0 },
        } as AnyCircuitElement);
      }, expectedMessage: "is incompatible with circuit-json@0.0.464" },
    ]) {
      const circuitJson = structuredClone(circuitMismatchFixture.circuitJson);
      mutate(circuitJson);
      const result = await verifyManufacturingDirectoryImplementation({
        root: circuitMismatchFixture.root,
        expectation: circuitMismatchFixture.expectation,
        circuitJson,
      });
      expect(result.passed).toBeFalse();
      expect(result.findings).toEqual([
        expect.objectContaining({
          code: "MANUFACTURING_INPUT_LIMIT",
          message: expect.stringContaining(expectedMessage),
        }),
      ]);
      expect(result.artifacts).toEqual([]);
    }

    for (const collection of ["bomRows", "placements"] as const) {
      const fixture = await emittedFixture(4);
      const expectation = cloneExpectation(fixture.expectation) as any;
      expectation[collection] = [];
      const result = await verifyManufacturingDirectory({
        root: fixture.root,
        expectation,
      });
      expect(result.passed, collection).toBeFalse();
      expect(result.findings, collection).toEqual([
        expect.objectContaining({
          code: "MANUFACTURING_INPUT_LIMIT",
          message: collection === "bomRows"
            ? "BOM expectation must contain exactly every assembly-authority designator"
            : "placement expectation must contain exactly every required assembly component and PCB owner",
        }),
      ]);
      expect(result.artifacts, collection).toEqual([]);
    }

    const dnpParent = await mkdtemp(join(tmpdir(), "fulmetry-assembly-dnp-"));
    temporaryRoots.push(dnpParent);
    const dnpRoot = join(dnpParent, "draft");
    const dnpCircuit = await manufacturingFixture(2);
    const dnpComponent = dnpCircuit.find(
      (element) => element.type === "pcb_component" &&
        element.source_component_id === "source_component_0",
    );
    if (dnpComponent?.type !== "pcb_component") throw new Error("DNP fixture component missing");
    dnpComponent.do_not_place = true;
    await emitDraftManufacturingDirectory({
      targetDirectory: dnpRoot,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson: dnpCircuit }),
    });
    const dnpExpectation = deriveManufacturingExpectation({
      boardName: "control",
      circuitJson: dnpCircuit,
    });
    circuitJsonByExpectation.set(dnpExpectation, dnpCircuit);
    expect(dnpExpectation.assemblyAuthority).toContainEqual(
      expect.objectContaining({
        sourceComponentId: "source_component_0",
        dnp: true,
        bomRequired: true,
        placementRequired: false,
        padSources: expect.any(Array),
      }),
    );
    const dnpResult = await verifyManufacturingDirectory({
      root: dnpRoot,
      expectation: dnpExpectation,
    });
    expect(dnpResult.passed, JSON.stringify(dnpResult.findings)).toBeTrue();
    expect(dnpResult.findings).toEqual([]);

    for (const layers of [2, 4] as const) {
      const fixture = await emittedFixture(layers);
      expect(fixture.expectation.assemblyAuthority.length).toBeGreaterThan(0);
      expect((await verifyManufacturingDirectory({
        root: fixture.root,
        expectation: fixture.expectation,
      })).passed).toBeTrue();
    }
  }, 15_000);

  test("rejects board substrate materials outside the baseline manufacturing capability", async () => {
    for (const material of ["", "mystery-substrate"]) {
      const parent = await mkdtemp(join(tmpdir(), "fulmetry-board-material-"));
      temporaryRoots.push(parent);
      const root = join(parent, "draft");
      const circuitJson = await manufacturingFixture(4);
      const board = circuitJson.find((element) => element.type === "pcb_board");
      if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
      (board as unknown as { material: string }).material = material;
      await emitDraftManufacturingDirectory({
        targetDirectory: root,
        files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
      });
      const expectation = deriveManufacturingExpectation({
        boardName: "control",
        circuitJson,
      });
      expect(expectation.unsupported, JSON.stringify(material)).toContainEqual(
        expect.stringContaining("outside the baseline manufacturing capability"),
      );
      expect(expectation.unsupportedDetails, JSON.stringify(material)).toContainEqual(
        expect.objectContaining({
          objects: [`${board.pcb_board_id}.material`],
          measurement: {
            actual: JSON.stringify(material),
            required: "fr4",
          },
        }),
      );
      const result = await verifyManufacturingDirectory({ root, expectation });
      expect(result.passed, JSON.stringify(material)).toBeFalse();
      expect(result.findings, JSON.stringify(material)).toEqual([
        expect.objectContaining({
          code: "MANUFACTURING_INPUT_LIMIT",
          message: "Manufacturing board material must be one of fr4",
        }),
      ]);
      expect(result.artifacts, JSON.stringify(material)).toEqual([]);
    }

    const qualified = await emittedFixture(4);
    expect(qualified.expectation.board.material).toBe("fr4");
    const result = await verifyManufacturingDirectory({
      root: qualified.root,
      expectation: qualified.expectation,
    });
    expect(result.passed).toBeTrue();
    expect(result.findings).toEqual([]);
  });

  test("requires the exact layer expectation inventory before parsing artifacts", async () => {
    const fixture = await emittedFixture(4);
    for (const mutate of [
      (expectation: any) => { delete expectation.flashes.F_Cu; },
      (expectation: any) => { delete expectation.copperSegments.In1_Cu; },
      (expectation: any) => { delete expectation.silkscreenSegments.B_SilkScreen; },
      (expectation: any) => { expectation.flashes.Decoy_Cu = []; },
    ]) {
      const expectation = cloneExpectation(fixture.expectation) as any;
      mutate(expectation);
      const result = await verifyManufacturingDirectory({
        root: fixture.root,
        expectation,
      });
      expect(result.passed).toBeFalse();
      expect(result.findings).toEqual([
        expect.objectContaining({ code: "MANUFACTURING_INPUT_LIMIT" }),
      ]);
      expect(result.artifacts).toEqual([]);
    }
  });

  test("requires stable unique placement designators before parsing artifacts", async () => {
    const fixture = await emittedFixture(4);
    for (const designator of ["", " D1", "unnamed_led1"]) {
      const expectation = cloneExpectation(fixture.expectation) as any;
      expectation.placements[0].designator = designator;
      const result = await verifyManufacturingDirectory({
        root: fixture.root,
        expectation,
      });
      expect(result.passed, JSON.stringify(designator)).toBeFalse();
      expect(result.findings, JSON.stringify(designator)).toEqual([
        expect.objectContaining({
          code: "MANUFACTURING_INPUT_LIMIT",
          message: "placement designator must be an explicit stable assembly reference",
        }),
      ]);
      expect(result.artifacts, JSON.stringify(designator)).toEqual([]);
    }

    const duplicate = cloneExpectation(fixture.expectation) as any;
    duplicate.placements[1].designator = duplicate.placements[0].designator;
    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation: duplicate,
    });
    expect(result.passed).toBeFalse();
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "placement designators must be unique",
      }),
    ]);
    expect(result.artifacts).toEqual([]);
  });

  test("requires every expected manufacturing feature to retain a circuit source identifier", async () => {
    const fixture = await emittedFixture(4);
    const mutations = [
      (expectation: any) => { expectation.flashes.F_Cu[0].source = ""; },
      (expectation: any) => { expectation.copperSegments.F_Cu[0].source = " "; },
      (expectation: any) => { expectation.silkscreenSegments.F_SilkScreen[0].source = "bad/source"; },
      (expectation: any) => { expectation.platedDrills[0].source = ""; },
      (expectation: any) => { expectation.placements[0].source = "\n"; },
    ];
    for (const mutate of mutations) {
      const expectation = cloneExpectation(fixture.expectation) as any;
      mutate(expectation);
      const result = await verifyManufacturingDirectory({
        root: fixture.root,
        expectation,
      });
      expect(result.passed).toBeFalse();
      expect(result.findings).toEqual([
        expect.objectContaining({
          code: "MANUFACTURING_INPUT_LIMIT",
          message: "manufacturing expectation source must be a non-empty conservative circuit identifier",
        }),
      ]);
      expect(result.artifacts).toEqual([]);
    }
  });

  test("requires bidirectional authority between full-stack copper and plated drills", async () => {
    const withoutDrills = await emittedFixture(4);
    const omitted = cloneExpectation(withoutDrills.expectation) as any;
    omitted.platedDrills = [];
    await rm(join(withoutDrills.root, "drills", "drill-L1-L4.drl"));
    const omittedResult = await verifyManufacturingDirectory({
      root: withoutDrills.root,
      expectation: omitted,
    });
    expect(omittedResult.passed).toBeFalse();
    expect(omittedResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "full-stack copper and plated drill authority must reconcile exactly by source and geometry",
      }),
    ]);
    expect(omittedResult.artifacts).toEqual([]);

    const withoutCopper = await emittedFixture(4);
    const converse = cloneExpectation(withoutCopper.expectation) as any;
    const drill = converse.platedDrills[0];
    converse.flashes.F_Cu = converse.flashes.F_Cu.filter(
      (flash: { source: string }) => flash.source !== drill.source,
    );
    const converseResult = await verifyManufacturingDirectory({
      root: withoutCopper.root,
      expectation: converse,
    });
    expect(converseResult.passed).toBeFalse();
    expect(converseResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "full-stack copper flashes must be one aligned circular or rectangular feature per layer and source",
      }),
    ]);
    expect(converseResult.artifacts).toEqual([]);

    const coordinated = await emittedFixture(4);
    const partial = cloneExpectation(coordinated.expectation) as any;
    const removedDrill = partial.platedDrills[0];
    const source = removedDrill.source;
    partial.platedDrills = partial.platedDrills.filter(
      (drill: { source: string }) => drill.source !== source,
    );
    const removedFlashes = ["In1_Cu", "In2_Cu", "B_Cu"].map((layer) => ({
      layer,
      flash: partial.flashes[layer].find(
        (candidate: { source: string }) => candidate.source === source,
      ),
    }));
    for (const { layer } of removedFlashes) {
      partial.flashes[layer] = partial.flashes[layer].filter(
        (flash: { source: string }) => flash.source !== source,
      );
    }
    const drillPath = join(coordinated.root, "drills", "drill-L1-L4.drl");
    const drillText = await Bun.file(drillPath).text();
    const drillHit = `X${removedDrill.x.toFixed(4)}Y${removedDrill.y.toFixed(4)}`;
    const withoutDrillHit = drillText.replace(`${drillHit}\n`, "");
    if (withoutDrillHit === drillText) throw new Error("Coordinated drill hit missing");
    await Bun.write(drillPath, withoutDrillHit);
    const gerberCoordinate = (value: number) => {
      const digits = Math.round(Math.abs(value) * 1_000_000).toString();
      return value < 0 ? `-${digits.padStart(8, "0")}` : digits.padStart(9, "0");
    };
    for (const { layer, flash } of removedFlashes) {
      const copperPath = join(coordinated.root, "gerbers", `control-${layer}.gbr`);
      const copperText = await Bun.file(copperPath).text();
      const copperFlash = `X${gerberCoordinate(flash.x)}Y${gerberCoordinate(flash.y)}D03*`;
      const withoutCopperFlash = copperText.replace(`${copperFlash}\n`, "");
      if (withoutCopperFlash === copperText) {
        throw new Error(`Coordinated ${layer} flash missing`);
      }
      await Bun.write(copperPath, withoutCopperFlash);
    }
    const partialResult = await verifyManufacturingDirectory({
      root: coordinated.root,
      expectation: partial,
    });
    expect(partialResult.passed).toBeFalse();
    expect(partialResult.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "full-stack copper flashes must be one aligned circular feature per layer and source",
      }),
    ]);
    expect(partialResult.artifacts).toEqual([]);
  });

  test("never verifies artifacts for a non-positive physical board thickness", async () => {
    for (const thickness of [0, -1]) {
      const parent = await mkdtemp(join(tmpdir(), "fulmetry-board-thickness-"));
      temporaryRoots.push(parent);
      const root = join(parent, "draft");
      const circuitJson = await manufacturingFixture(4);
      const board = circuitJson.find((element) => element.type === "pcb_board");
      if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
      board.thickness = thickness;
      await emitDraftManufacturingDirectory({
        targetDirectory: root,
        files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
      });

      const expectation = deriveManufacturingExpectation({
        boardName: "control",
        circuitJson,
      });
      expect(expectation.unsupported, String(thickness)).toContainEqual(
        expect.stringContaining("board thickness must be strictly positive"),
      );
      expect(expectation.unsupportedDetails, String(thickness)).toContainEqual(
        expect.objectContaining({
          objects: [board.pcb_board_id],
          measurement: { actual: `${thickness}mm`, required: "> 0mm" },
        }),
      );
      const result = await verifyManufacturingDirectory({ root, expectation });
      expect(result.passed, String(thickness)).toBeFalse();
      expect(result.findings, String(thickness)).toEqual([
        expect.objectContaining({
          code: "MANUFACTURING_INPUT_LIMIT",
          message: "board.thickness must be strictly positive",
        }),
      ]);
      expect(result.artifacts, String(thickness)).toEqual([]);
    }

    const nonFinite = await manufacturingFixture(4);
    const board = nonFinite.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
    board.thickness = Number.NaN;
    expect(() => deriveManufacturingExpectation({
      boardName: "control",
      circuitJson: nonFinite,
    })).toThrow("board thickness must be a finite positive millimetre value");
  });

  test("rejects forged non-positive board dimensions at the caller expectation boundary", async () => {
    const fixture = await emittedFixture(4);
    const metadataPath = join(fixture.root, "fabrication/metadata.json");
    const originalMetadata = await Bun.file(metadataPath).json();
    for (const field of ["width", "height", "thickness"] as const) {
      for (const value of [0, -1]) {
        const expectation = cloneExpectation(fixture.expectation) as any;
        expectation.board[field] = value;
        const metadata = structuredClone(originalMetadata) as any;
        metadata.board[field] = value;
        await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

        const result = await verifyManufacturingDirectory({
          root: fixture.root,
          expectation,
        });
        expect(result.passed, `${field}:${value}`).toBeFalse();
        expect(result.findings, `${field}:${value}`).toEqual([
          expect.objectContaining({
            code: "MANUFACTURING_INPUT_LIMIT",
            message: `board.${field} must be strictly positive`,
          }),
        ]);
        expect(result.artifacts, `${field}:${value}`).toEqual([]);
      }
    }
  });

  test("revalidates the captured expectation after an accessor changes board thickness", async () => {
    const fixture = await emittedFixture(4);
    const metadataPath = join(fixture.root, "fabrication/metadata.json");
    const metadata = await Bun.file(metadataPath).json();
    metadata.board.thickness = 0;
    await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const expectation = cloneExpectation(fixture.expectation) as any;
    let reads = 0;
    Object.defineProperty(expectation.board, "thickness", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 1.4 : 0;
      },
    });

    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation,
    });
    expect(reads).toBe(2);
    expect(result.passed).toBeFalse();
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "board.thickness must be strictly positive",
      }),
    ]);
    expect(result.artifacts).toEqual([]);
  });

  test("rejects an oversized expectation before cloning or reading artifacts", async () => {
    const fixture = await emittedFixture(2);
    const placement = fixture.expectation.placements[0];
    if (placement === undefined) throw new Error("Placement fixture missing");
    const expectation = {
      ...fixture.expectation,
      placements: Array.from(
        { length: MANUFACTURING_RECONCILIATION_FEATURE_LIMIT + 1 },
        () => placement,
      ),
    };

    const result = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation,
      circuitJson: fixture.circuitJson,
    });
    expect(result.passed).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "MANUFACTURING_INPUT_LIMIT" }),
    ]);
    expect(result.artifacts).toEqual([]);
  });

  test("rejects a CSV row overflow as a manufacturing input limit", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "assembly/bom.csv");
    const lines = (await Bun.file(path).text()).trimEnd().split("\n");
    const header = lines[0];
    const row = lines[1];
    if (header === undefined || row === undefined) throw new Error("BOM fixture missing");
    await Bun.write(
      path,
      `${header}\n${Array.from({ length: MANUFACTURING_CSV_ROW_LIMIT + 1 }, () => row).join("\n")}\n`,
    );

    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation: fixture.expectation,
    });
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_INPUT_LIMIT",
      path: "assembly/bom.csv",
    }));
  });

  test("terminates a dense Gerber parser stream at the record ceiling", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    const original = await Bun.file(path).text();
    const operations = Array.from(
      { length: MANUFACTURING_PARSER_RECORD_LIMIT + 1 },
      () => "X000000000Y000000000D03*",
    ).join("\n");
    await Bun.write(path, original.replace("M02*", `${operations}\nM02*`));

    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation: fixture.expectation,
    });
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_INPUT_LIMIT",
      path: "gerbers/control-F_Cu.gbr",
    }));
  });

  test("does not reuse one actual BOM row for duplicate expected rows", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "assembly/bom.csv");
    const lines = (await Bun.file(path).text()).trimEnd().split("\n");
    if (lines.length < 3 || fixture.expectation.bomRows.length < 2) {
      throw new Error("BOM fixture rows missing");
    }
    await Bun.write(path, `${lines[0]}\n${lines[1]}\n${lines[2]}\n`);
    const first = fixture.expectation.bomRows[0]!;
    const expectation = { ...fixture.expectation, bomRows: [first, first] };

    const result = await verifyManufacturingDirectoryImplementation({
      root: fixture.root,
      expectation,
      circuitJson: fixture.circuitJson,
    });
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_INPUT_LIMIT",
      message: "BOM expectation must contain exactly every assembly-authority designator",
    }));
  });

  test("applies the text line ceiling to metadata JSON", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "fabrication/metadata.json");
    const original = await Bun.file(path).text();
    await Bun.write(path, `${"\n".repeat(MANUFACTURING_TEXT_LINE_LIMIT)}${original}`);

    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation: fixture.expectation,
    });
    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_INPUT_LIMIT",
      path: "fabrication/metadata.json",
    }));
  });

  test("rejects duplicate nested fabrication metadata keys", async () => {
    const fixture = await emittedFixture(4);
    const path = join(fixture.root, "fabrication/metadata.json");
    const original = await Bun.file(path).text();
    const attacked = original.replace(
      '"thickness": 1.4,',
      '"thick\\u006eess": 0,\n      "thickness": 1.4,',
    );
    if (attacked === original) throw new Error("Fixture thickness token missing");
    await Bun.write(path, attacked);

    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation: fixture.expectation,
    });
    expect(result.passed).toBeFalse();
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "FABRICATION_METADATA_MISMATCH",
      path: "fabrication/metadata.json",
      message: 'Duplicate JSON object key "thickness"',
    }));
  });

  test("rejects too many additional paths before iterating or reading them", async () => {
    const fixture = await emittedFixture(2);
    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation: fixture.expectation,
      allowedAdditionalPaths: Array.from(
        { length: MANUFACTURING_ARTIFACT_ENTRY_LIMIT + 1 },
        (_, index) => `extra-${index}.txt`,
      ),
    });
    expect(result.passed).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "MANUFACTURING_INPUT_LIMIT" }),
    ]);
    expect(result.artifacts).toEqual([]);
  });

  test("indexes thirteen stable negative cases and every public finding code", () => {
    expect(Object.keys(MANUFACTURING_NEGATIVE_CORPUS)).toHaveLength(13);
    expect(Object.keys(MANUFACTURING_FINDING_CODE_DIRECT_TEST)).toHaveLength(25);
    for (const testId of Object.values(MANUFACTURING_FINDING_CODE_DIRECT_TEST)) {
      expect(testId.length).toBeGreaterThan(0);
    }
    for (const entry of Object.values(MANUFACTURING_NEGATIVE_CORPUS)) {
      for (const code of entry.expectedCodes) {
        expect(MANUFACTURING_FINDING_CODE_DIRECT_TEST[code]).toBeString();
      }
    }
  });

  test.each([2, 4] as const)(
    "parses and reconciles the canonical %i-layer artifact set",
    async (layers) => {
      const fixture = await emittedFixture(layers);
      const { result } = await codes(fixture.root, fixture.expectation);

      expect(result).toMatchObject({
        passed: true,
        parser: "gerber-parser@4.2.7",
        findings: [],
      });
      expect(result.artifacts.length).toBeGreaterThan(10);
      expect(result.artifacts.map(({ path }) => path)).toEqual(
        result.artifacts.map(({ path }) => path).sort(),
      );
      expect(result.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)))
        .toBeTrue();
    },
  );

  test("rejects contradictory embedded exporter provenance", async () => {
    const gerberFixture = await emittedFixture(2);
    const gerberPath = join(
      gerberFixture.root,
      "gerbers",
      "control-F_Cu.gbr",
    );
    await Bun.write(
      gerberPath,
      (await Bun.file(gerberPath).text()).replace(
        /^%TF\.GenerationSoftware,[^\n]+$/m,
        "%TF.GenerationSoftware,EvilCorp,fabricator,999*%",
      ),
    );
    const gerberResult = await verifyManufacturingDirectory({
      root: gerberFixture.root,
      expectation: gerberFixture.expectation,
    });
    expect(gerberResult.passed).toBeFalse();
    expect(gerberResult.findings).toContainEqual(expect.objectContaining({
      code: "GERBER_STATE_UNSUPPORTED",
      path: "gerbers/control-F_Cu.gbr",
    }));

    const drillFixture = await emittedFixture(2);
    const drillPath = join(drillFixture.root, "drills", "drill-L1-L2.drl");
    await Bun.write(
      drillPath,
      (await Bun.file(drillPath).text()).replace(
        "; #@! TF.GenerationSoftware,tscircuit",
        "; #@! TF.GenerationSoftware,EvilCorp,fabricator,999",
      ),
    );
    const drillResult = await verifyManufacturingDirectory({
      root: drillFixture.root,
      expectation: drillFixture.expectation,
    });
    expect(drillResult.passed).toBeFalse();
    expect(drillResult.findings).toContainEqual(expect.objectContaining({
      code: "DRILL_STATE_UNSUPPORTED",
      path: "drills/drill-L1-L2.drl",
    }));
  });

  test("rejects an authored component omitted from every PCB and assembly artifact", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-orphan-component-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "D1",
    );
    if (source?.type !== "source_component") throw new Error("D1 source fixture missing");
    circuitJson.push({
      ...source,
      source_component_id: "source_component_orphan",
      name: "D_ORPHAN",
    });
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({
      boardName: "control",
      circuitJson,
    });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("source_component_orphan: authored component resolves to 0"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_UNSUPPORTED",
      message: expect.stringContaining("source_component_orphan"),
    }));
  });

  test("rejects physical component pins whose source-port authority was omitted", async () => {
    const removed = new Set(["source_port_1", "source_port_3"]);
    const circuitJson = (await manufacturingFixture(4)).filter((element) =>
      !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
      !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "source_port" && removed.has(element.source_port_id)) &&
      !(element.type === "schematic_port" && removed.has(element.source_port_id))
    );
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toEqual(expect.arrayContaining([
      expect.stringContaining("pcb_port_1:source-port-count:0"),
      expect.stringContaining("pcb_port_3:source-port-count:0"),
    ]));
  });

  test("rejects ownerless SMT copper even when its paste and exported files reconcile", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-ownerless-smt-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    circuitJson.push(
      {
        type: "pcb_smtpad",
        pcb_smtpad_id: "pcb_smtpad_orphan",
        layer: "top",
        shape: "circle",
        x: 0,
        y: 5,
        radius: 0.5,
        port_hints: [],
        is_covered_with_solder_mask: false,
        subcircuit_id: "subcircuit_source_group_0",
      } as unknown as AnyCircuitElement,
      {
        type: "pcb_solder_paste",
        pcb_solder_paste_id: "pcb_solder_paste_orphan",
        pcb_smtpad_id: "pcb_smtpad_orphan",
        layer: "top",
        shape: "circle",
        x: 0,
        y: 5,
        radius: 0.35,
        subcircuit_id: "subcircuit_source_group_0",
      } as unknown as AnyCircuitElement,
    );
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("pcb_smtpad_orphan: ownerless SMT pad or fiducial"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_UNSUPPORTED",
      message: expect.stringContaining("pcb_smtpad_orphan: ownerless SMT pad or fiducial"),
    }));
  });

  test("rejects ownerless plated copper even when its drill and Gerber files reconcile", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-ownerless-pth-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    circuitJson.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: "pcb_plated_hole_orphan",
      shape: "circle",
      x: 0,
      y: 5,
      hole_diameter: 0.6,
      outer_diameter: 1,
      layers: ["top", "bottom"],
      is_covered_with_solder_mask: false,
      subcircuit_id: "subcircuit_source_group_0",
    } as unknown as AnyCircuitElement);
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("pcb_plated_hole_orphan: ownerless plated copper"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "MANUFACTURING_UNSUPPORTED",
      message: expect.stringContaining("pcb_plated_hole_orphan: ownerless plated copper"),
    }));
  });

  test("rejects Gerber and placement evidence whose SMT side contradicts its owner", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-side-integrity-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const component = circuitJson.find(
      (element) => element.type === "pcb_component" && element.layer === "bottom",
    );
    if (component?.type !== "pcb_component") throw new Error("Bottom component missing");
    const pads = circuitJson.filter((element) => element.type === "pcb_smtpad")
      .filter((element) => element.pcb_component_id === component.pcb_component_id);
    const padIds = new Set(pads.map((pad) => pad.pcb_smtpad_id));
    const portIds = new Set(pads.flatMap((pad) => pad.pcb_port_id === undefined ? [] : [pad.pcb_port_id]));
    for (const pad of pads) pad.layer = "top";
    for (const aperture of circuitJson.filter((element) => element.type === "pcb_solder_paste")
      .filter((element) =>
        element.pcb_smtpad_id !== undefined && padIds.has(element.pcb_smtpad_id)
      )) aperture.layer = "top";
    for (const port of circuitJson.filter((element) => element.type === "pcb_port")
      .filter((element) => portIds.has(element.pcb_port_id))) port.layers = ["top"];

    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("SMT pad side top contradicts component side bottom"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings.map(({ code }) => code)).toContain("MANUFACTURING_UNSUPPORTED");
  });

  test("rejects matching artifacts when an SMT pad is displaced outside its owner courtyard", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-pad-courtyard-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const component = circuitJson.find(
      (element) => element.type === "pcb_component" && element.layer === "bottom",
    );
    if (component?.type !== "pcb_component") throw new Error("Bottom component missing");
    const pad = circuitJson.find(
      (element) => element.type === "pcb_smtpad" &&
        element.shape === "rect" &&
        element.pcb_component_id === component.pcb_component_id,
    );
    if (pad?.type !== "pcb_smtpad" || pad.shape !== "rect") {
      throw new Error("Bottom rectangular SMT pad missing");
    }
    pad.x += 1;
    const aperture = circuitJson.find(
      (element) => element.type === "pcb_solder_paste" &&
        element.pcb_smtpad_id === pad.pcb_smtpad_id,
    );
    const port = circuitJson.find(
      (element) => element.type === "pcb_port" && element.pcb_port_id === pad.pcb_port_id,
    );
    if (aperture?.type !== "pcb_solder_paste" || port?.type !== "pcb_port") {
      throw new Error("Owned aperture or port missing");
    }
    aperture.x += 1;
    port.x += 1;

    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("SMT pad lies outside its owner courtyard"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings.map(({ code }) => code)).toContain("MANUFACTURING_UNSUPPORTED");
  });

  test("rejects matching artifacts when a plated hole is displaced outside its owner courtyard", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-pth-courtyard-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const hole = circuitJson.find(
      (element) => element.type === "pcb_plated_hole" &&
        element.pcb_plated_hole_id === "pcb_plated_hole_1",
    );
    if (hole?.type !== "pcb_plated_hole" || hole.shape !== "circle") {
      throw new Error("Owned circular plated hole missing");
    }
    const originalX = hole.x;
    hole.x += 3;
    for (const aperture of circuitJson) {
      if (
        aperture.type === "pcb_solder_paste" && aperture.shape === "circle" &&
        aperture.x === originalX && aperture.y === hole.y
      ) aperture.x += 3;
    }
    const port = circuitJson.find((element) =>
      element.type === "pcb_port" && element.pcb_port_id === hole.pcb_port_id
    );
    if (port?.type !== "pcb_port") throw new Error("Owning plated-hole port missing");
    port.x += 3;
    for (const trace of circuitJson.filter((element) => element.type === "pcb_trace")) {
      for (const point of trace.route) {
        if (
          ("start_pcb_port_id" in point && point.start_pcb_port_id === port.pcb_port_id) ||
          ("end_pcb_port_id" in point && point.end_pcb_port_id === port.pcb_port_id)
        ) {
          if ("x" in point && typeof point.x === "number") point.x += 3;
        }
      }
    }

    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("plated-hole pad lies outside its owner courtyard"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings.map(({ code }) => code)).toContain("MANUFACTURING_UNSUPPORTED");
  });

  test("rejects matching artifacts when a remote NPTH claims a component owner", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-npth-courtyard-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const hole = circuitJson.find((element) => element.type === "pcb_hole");
    if (hole?.type !== "pcb_hole") throw new Error("Fixture NPTH missing");
    hole.pcb_component_id = "pcb_component_2";

    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("component-owned NPTH lies outside its owner courtyard"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings.map(({ code }) => code)).toContain("MANUFACTURING_UNSUPPORTED");
  });

  test("rejects missing and empty inner copper instead of trusting exporter success", async () => {
    const missing = await emittedFixture(4);
    await rm(join(missing.root, "gerbers/control-In1_Cu.gbr"));
    expect((await codes(missing.root, missing.expectation)).codes).toContain(
      "MANUFACTURING_FILE_MISSING",
    );

    const empty = await emittedFixture(4);
    await Bun.write(join(empty.root, "gerbers/control-In2_Cu.gbr"), "");
    expect((await codes(empty.root, empty.expectation)).codes).toContain(
      "MANUFACTURING_FILE_EMPTY",
    );
  });

  test("rejects a missing board profile file", async () => {
    const fixture = await emittedFixture(4);
    await rm(join(fixture.root, "gerbers/control-Edge_Cuts.gbr"));
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "MANUFACTURING_FILE_MISSING",
    );
  });

  test("fails if artifact bytes change after the parser-bound snapshot", async () => {
    const fixture = await emittedFixture(4);
    const path = join(fixture.root, "gerbers/control-In1_Cu.gbr");
    const original = await Bun.file(path).text();
    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation: fixture.expectation,
      afterInitialArtifactSnapshot: async () => {
        await Bun.write(path, "transient attacker bytes that the parser must not read\n");
      },
    });

    expect(result.passed).toBeFalse();
    expect(result.findings.map(({ code }) => code)).toContain(
      "MANUFACTURING_ARTIFACT_CHANGED",
    );
    expect(result.findings.map(({ code }) => code)).not.toContain("GERBER_PARSE_ERROR");
    const bound = result.artifacts.find(({ path }) => path === "gerbers/control-In1_Cu.gbr");
    expect(bound?.size).toBe(Buffer.byteLength(original));

    const membership = await emittedFixture(2);
    const membershipResult = await verifyManufacturingDirectory({
      root: membership.root,
      expectation: membership.expectation,
      beforeFinalArtifactSnapshot: async () => {
        await Bun.write(join(membership.root, "late-extra.txt"), "not manifested\n");
      },
    });
    expect(membershipResult.passed).toBeFalse();
    expect(membershipResult.findings.map(({ code }) => code)).toContain(
      "MANUFACTURING_ARTIFACT_CHANGED",
    );
  });

  test("rejects swapped copper layers by their parsed X2 file functions", async () => {
    const fixture = await emittedFixture(4);
    const inner1Path = join(fixture.root, "gerbers/control-In1_Cu.gbr");
    const inner2Path = join(fixture.root, "gerbers/control-In2_Cu.gbr");
    const inner1 = await Bun.file(inner1Path).text();
    const inner2 = await Bun.file(inner2Path).text();
    await Bun.write(inner1Path, inner2);
    await Bun.write(inner2Path, inner1);

    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_FILE_FUNCTION_MISMATCH",
    );
  });

  test("rejects duplicated four-layer copper content with the copied layer's exact function mismatch", async () => {
    const fixture = await emittedFixture(4);
    const inner1Path = join(fixture.root, "gerbers/control-In1_Cu.gbr");
    const inner2Path = join(fixture.root, "gerbers/control-In2_Cu.gbr");
    await Bun.write(inner2Path, await Bun.file(inner1Path).text());
    const result = await codes(fixture.root, fixture.expectation);
    expect(result.result.passed).toBeFalse();
    expect(result.codes).toContain("GERBER_FILE_FUNCTION_MISMATCH");
  });

  test("rejects translated or mirrored copper coordinates", async () => {
    const translated = await emittedFixture(2);
    const translatedPath = join(translated.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      translatedPath,
      (await Bun.file(translatedPath).text()).replace("X-03825000Y002000000D03*", "X-02825000Y002000000D03*"),
    );
    expect((await codes(translated.root, translated.expectation)).codes).toContain(
      "GERBER_FEATURE_MISMATCH",
    );

    const mirrored = await emittedFixture(2);
    const mirroredPath = join(mirrored.root, "gerbers/control-B_Cu.gbr");
    const original = await Bun.file(mirroredPath).text();
    await Bun.write(
      mirroredPath,
      original.replaceAll(/^X(-?\d+)Y/gm, (_match, encodedX) => {
        const mirroredMicrons = -Number(encodedX);
        const mirroredX = mirroredMicrons < 0
          ? `-${String(Math.abs(mirroredMicrons)).padStart(8, "0")}`
          : String(mirroredMicrons).padStart(9, "0");
        return `X${mirroredX}Y`;
      }),
    );
    expect((await codes(mirrored.root, mirrored.expectation)).codes).toContain(
      "GERBER_TRACE_MISMATCH",
    );
  });

  test("classifies the pinned malformed-aperture mutation as an exact parser warning", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    const malformed = (await Bun.file(path).text()).replace("%ADD10", "%BROKEN10");
    await Bun.write(path, malformed);

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.result.findings.filter(({ code }) => code === "GERBER_PARSE_WARNING")).toEqual([{
      code: "GERBER_PARSE_WARNING",
      path: "gerbers/control-F_Cu.gbr",
      message: 'line 52: block "%BROKEN10C,0.200000" was not recognized and was ignored',
    }]);
  });

  test("rejects external macro-aperture copper that cannot disappear from operation accounting", async () => {
    const canonical = await loadCanonicalFixture("plated-hole-4layer");
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-canonical-macro-copper-"));
    temporaryRoots.push(parent);
    const root = join(parent, "manufacturing");
    await cp(join(canonical.root, "manufacturing"), root, {
      recursive: true,
      errorOnExist: true,
    });
    const expectation = deriveManufacturingExpectation({
      boardName: canonical.expectation.boardName,
      circuitJson: canonical.circuitJson,
    });
    const path = join(
      root,
      "gerbers",
      `${canonical.expectation.boardName}-In1_Cu.gbr`,
    );
    const attacked = (await Bun.file(path).text())
      .replace("%TD*%", "%ADD99HORZPILL*%\n%TD*%")
      .replace(
        "M02*",
        [
          "D99*",
          "X005000000Y005000000D02*",
          "X006000000Y005000000D01*",
          "M02*",
        ].join("\n"),
      );
    await Bun.write(path, attacked);

    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "GERBER_STATE_UNSUPPORTED",
      path: `gerbers/${canonical.expectation.boardName}-In1_Cu.gbr`,
      message: expect.stringContaining("1 plotted operation(s)"),
    }));
  });

  test("rejects a plotted Gerber operation without explicit reconcilable coordinates", async () => {
    const fixture = await emittedFixture(4);
    const path = join(fixture.root, "gerbers/control-In1_Cu.gbr");
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace("M02*", "D10*\nD03*\nM02*"),
    );

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.result.passed).toBeFalse();
    expect(result.result.findings).toContainEqual(expect.objectContaining({
      code: "GERBER_STATE_UNSUPPORTED",
      path: "gerbers/control-In1_Cu.gbr",
      message: expect.stringContaining("plotted operation(s)"),
    }));
  });

  test("classifies a strict subset of required flashes as missing", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    const lines = (await Bun.file(path).text()).split("\n");
    const flashIndex = lines.findIndex((line) => /^X-?\d+Y-?\d+D03\*$/.test(line));
    if (flashIndex < 0) throw new Error("Fixture flash operation missing");
    lines.splice(flashIndex, 1);
    await Bun.write(path, lines.join("\n"));
    const result = await codes(fixture.root, fixture.expectation);
    expect(result.codes).toContain("GERBER_FEATURE_MISSING");
    expect(result.codes).not.toContain("GERBER_FEATURE_MISMATCH");
  });

  test("rejects duplicate Gerber aperture D-code redefinitions", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    const original = await Bun.file(path).text();
    const aperture = original.match(/%ADD(\d+)([A-Z]+),([^*]+)\*%/);
    if (aperture === null) throw new Error("Fixture aperture definition missing");
    const attacked = original.replace(aperture[0], `${aperture[0]}\n${aperture[0]}`);
    await Bun.write(path, attacked);
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_STATE_UNSUPPORTED",
    );
  });

  test("rejects absent drill hits and wrong plating metadata", async () => {
    const absent = await emittedFixture(2);
    const drillPath = join(absent.root, "drills/drill-L1-L2.drl");
    await Bun.write(
      drillPath,
      (await Bun.file(drillPath).text()).replace(/^X-1\.2700Y-2\.0000\n/m, ""),
    );
    expect((await codes(absent.root, absent.expectation)).codes).toContain(
      "DRILL_HIT_MISMATCH",
    );

    const plating = await emittedFixture(2);
    const platedPath = join(plating.root, "drills/drill-L1-L2.drl");
    await Bun.write(
      platedPath,
      (await Bun.file(platedPath).text()).replace(
        "TF.FileFunction,Plated,1,2,PTH",
        "TF.FileFunction,NonPlated,1,2,NPTH",
      ),
    );
    expect((await codes(plating.root, plating.expectation)).codes).toContain(
      "DRILL_FILE_FUNCTION_MISMATCH",
    );

    const toolPlating = await emittedFixture(4);
    const toolPath = join(toolPlating.root, "drills/drill-L1-L4.drl");
    await Bun.write(
      toolPath,
      (await Bun.file(toolPath).text()).replaceAll(
        "TA.AperFunction,Plated,PTH,ComponentDrill",
        "TA.AperFunction,NonPlated,NPTH,ComponentDrill",
      ),
    );
    expect((await codes(toolPlating.root, toolPlating.expectation)).codes).toContain(
      "DRILL_FILE_FUNCTION_MISMATCH",
    );
  });

  test("blocks an authored partial-stack via as manufacturing unsupported", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-partial-via-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(4);
    const via = circuitJson.find((element) => element.type === "pcb_via");
    if (via?.type !== "pcb_via") throw new Error("Four-layer fixture via missing");
    const owner = circuitJson.find((element) =>
      element.type === "pcb_trace" && element.pcb_trace_id === via.pcb_trace_id
    );
    if (owner?.type !== "pcb_trace") throw new Error("Four-layer fixture via owner missing");
    const routedVia = owner.route.find((point) =>
      point.route_type === "via" && point.x === via.x && point.y === via.y
    );
    if (routedVia?.route_type !== "via") throw new Error("Four-layer routed via missing");
    via.layers = ["top", "inner1"];
    via.from_layer = "top";
    via.to_layer = "inner1";
    routedVia.from_layer = "top";
    routedVia.to_layer = "inner1";
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported.some((message) => message.includes("full-stack through vias")))
      .toBeTrue();
    const files = await exportManufacturingFiles({ boardName: "control", circuitJson });
    await emitDraftManufacturingDirectory({ targetDirectory: root, files });
    expect(files.map(({ path }) => path).sort()).toEqual([
      "assembly/bom.csv",
      "assembly/positions.csv",
      "drills/drill-L1-L2.drl",
      "drills/drill-L1-L4.drl",
      "drills/drill_npth.drl",
      "fabrication/metadata.json",
      "gerbers/control-B_Cu.gbr",
      "gerbers/control-B_Mask.gbr",
      "gerbers/control-B_Paste.gbr",
      "gerbers/control-B_SilkScreen.gbr",
      "gerbers/control-Edge_Cuts.gbr",
      "gerbers/control-F_Cu.gbr",
      "gerbers/control-F_Mask.gbr",
      "gerbers/control-F_Paste.gbr",
      "gerbers/control-F_SilkScreen.gbr",
      "gerbers/control-In1_Cu.gbr",
      "gerbers/control-In2_Cu.gbr",
    ]);
    const result = await codes(root, expectation);
    expect(result.codes).toContain("MANUFACTURING_UNSUPPORTED");
    expect(result.codes).toContain("MANUFACTURING_FILE_UNEXPECTED");
  });

  test("rejects BOM and bottom-side placement divergence", async () => {
    const fixture = await emittedFixture(2);
    const bomPath = join(fixture.root, "assembly/bom.csv");
    await Bun.write(
      bomPath,
      (await Bun.file(bomPath).text()).split("\n")
        .filter((line) => !line.startsWith('"D1",'))
        .join("\n"),
    );
    const positionsPath = join(fixture.root, "assembly/positions.csv");
    await Bun.write(
      positionsPath,
      (await Bun.file(positionsPath).text()).replace(
        "D1,3.000,2.000,bottom,90",
        "D1,3.000,2.000,bottom,270",
      ),
    );

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.codes).toContain("BOM_MISMATCH");
    expect(result.codes).toContain("PLACEMENT_MISMATCH");
  });

  test("rejects unreconciled extra CSV columns and malformed row arity", async () => {
    const fixture = await emittedFixture(2);
    for (const [relativePath, expectedCode] of [
      ["assembly/bom.csv", "BOM_MISMATCH"],
      ["assembly/positions.csv", "PLACEMENT_MISMATCH"],
    ] as const) {
      const path = join(fixture.root, relativePath);
      const lines = (await Bun.file(path).text()).split(/\r?\n/);
      await Bun.write(
        path,
        lines.map((line, index) => index > 0 && line ? `${line},UNVERIFIED` : line).join("\n"),
      );
      expect((await codes(fixture.root, fixture.expectation)).codes).toContain(expectedCode);
    }
  });

  test("compares placement headers as exact parsed fields", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "assembly/positions.csv");
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace(
        "Designator,Mid X,Mid Y,Layer,Rotation",
        '"Designator,Mid X",Mid Y,Layer,Rotation',
      ),
    );
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "PLACEMENT_MISMATCH",
    );
  });

  test("rejects a caller expectation and placement file with a non-board side", async () => {
    const fixture = await emittedFixture(4);
    const expectation = cloneExpectation(fixture.expectation) as any;
    const placement = expectation.placements.find(
      (candidate: { layer: string }) => candidate.layer === "bottom",
    );
    if (placement === undefined) throw new Error("Bottom placement fixture missing");
    placement.layer = "sideways";
    const path = join(fixture.root, "assembly/positions.csv");
    const original = await Bun.file(path).text();
    const attacked = original.replace(",bottom,", ",sideways,");
    if (attacked === original) throw new Error("Bottom placement row missing");
    await Bun.write(path, attacked);

    const result = await verifyManufacturingDirectory({
      root: fixture.root,
      expectation,
    });
    expect(result.passed).toBeFalse();
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "MANUFACTURING_INPUT_LIMIT",
        message: "placement layer must be exactly top or bottom",
      }),
    ]);
    expect(result.artifacts).toEqual([]);
  });

  test("rejects contradictory layer-stack and placement convention metadata", async () => {
    const fixture = await emittedFixture(4);
    const path = join(fixture.root, "fabrication/metadata.json");
    const metadata = JSON.parse(await Bun.file(path).text());
    metadata.layerStack = ["top", "inner2", "inner1", "bottom"];
    metadata.placement.bottomSide = "silently-mirrored";
    await Bun.write(path, `${JSON.stringify(metadata, null, 2)}\n`);
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "FABRICATION_METADATA_MISMATCH",
    );
  });

  test.each(["invalid", "missing"] as const)(
    "rejects %s placement.bottomSide metadata in isolation",
    async (mutation) => {
      const fixture = await emittedFixture(4);
      const path = join(fixture.root, "fabrication/metadata.json");
      const metadata = JSON.parse(await Bun.file(path).text()) as {
        placement: { bottomSide?: string };
      };
      if (mutation === "missing") delete metadata.placement.bottomSide;
      else metadata.placement.bottomSide = "ambiguous";
      await Bun.write(path, `${JSON.stringify(metadata, null, 2)}\n`);
      expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
        "FABRICATION_METADATA_MISMATCH",
      );
    },
  );

  test("rejects stale extras, inner mask, and symlink substitution", async () => {
    const fixture = await emittedFixture(4);
    await Bun.write(join(fixture.root, "gerbers/control-In1_Mask.gbr"), "stale");
    const outside = join(fixture.parent, "outside.csv");
    await Bun.write(outside, "Designator\nR1\nD1\n");
    const bomPath = join(fixture.root, "assembly/bom.csv");
    await rm(bomPath);
    await symlink(outside, bomPath);

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.codes).toContain("MANUFACTURING_FILE_UNEXPECTED");
    expect(result.codes).toContain("MANUFACTURING_FILE_SYMLINK");
  });

  test("rejects a symlinked manufacturing root instead of canonicalizing through it", async () => {
    const fixture = await emittedFixture(4);
    const linkedRoot = join(fixture.parent, "linked-draft");
    await symlink(
      fixture.root,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await codes(linkedRoot, fixture.expectation);
    expect(result.codes).toContain("MANUFACTURING_FILE_SYMLINK");
    expect(result.result.passed).toBe(false);
  });

  test("rejects an intermediate artifact directory symlink without capturing through it", async () => {
    const fixture = await emittedFixture(4);
    const outsideAssembly = join(fixture.parent, "outside-assembly");
    await rename(join(fixture.root, "assembly"), outsideAssembly);
    await symlink(
      outsideAssembly,
      join(fixture.root, "assembly"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.result.passed).toBe(false);
    expect(result.codes).toContain("MANUFACTURING_FILE_UNEXPECTED");
    expect(result.result.artifacts.some(({ path }) => path.startsWith("assembly/"))).toBe(false);
  });

  test("rejects an oversized expected artifact before reading or parsing its sparse bytes", async () => {
    const fixture = await emittedFixture(4);
    const path = join(fixture.root, "assembly/bom.csv");
    await truncate(path, MANUFACTURING_ARTIFACT_FILE_BYTES_LIMIT + 1);

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.codes).toContain("MANUFACTURING_INPUT_LIMIT");
    expect(result.result.artifacts).toEqual([]);
  });

  test("rejects an aggregate sparse artifact set above the total byte limit before capture", async () => {
    const fixture = await emittedFixture(4);
    const chunkSize = Math.floor(MANUFACTURING_ARTIFACT_TOTAL_BYTES_LIMIT / 5) + 1;
    for (const path of [
      "assembly/bom.csv",
      "assembly/positions.csv",
      "fabrication/metadata.json",
      "gerbers/control-F_Cu.gbr",
      "gerbers/control-B_Cu.gbr",
    ]) await truncate(join(fixture.root, ...path.split("/")), chunkSize);

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.codes).toContain("MANUFACTURING_INPUT_LIMIT");
    expect(result.result.artifacts).toEqual([]);
  });

  test("streams and rejects an overbroad manufacturing directory tree", async () => {
    const fixture = await emittedFixture(4);
    for (let index = 0; index <= MANUFACTURING_ARTIFACT_ENTRY_LIMIT; index += 1) {
      await mkdir(join(fixture.root, `empty-${index}`));
    }

    const result = await codes(fixture.root, fixture.expectation);
    expect(result.codes).toContain("MANUFACTURING_INPUT_LIMIT");
    expect(result.result.passed).toBe(false);
  });

  test("rejects copper files whose authored trace draws were deleted", async () => {
    const fixture = await emittedFixture(4);
    const relativePath = "gerbers/control-In1_Cu.gbr";
    const path = join(fixture.root, relativePath);
    const withoutDraws = (await Bun.file(path).text())
      .split("\n")
      .filter((line) => !/D0[12]\*$/.test(line))
      .join("\n");
    await Bun.write(path, withoutDraws);
    const result = await codes(fixture.root, fixture.expectation);
    expect(result.result.findings.filter((finding) => finding.path === relativePath)
      .map(({ code }) => code).sort()).toEqual([
        "GERBER_NO_OPERATIONS",
        "GERBER_TRACE_MISMATCH",
      ]);
  });

  test("rejects undersized PTH and via annular apertures", async () => {
    const fixture = await emittedFixture(4);
    for (const layer of ["F_Cu", "In1_Cu", "In2_Cu", "B_Cu"]) {
      const path = join(fixture.root, `gerbers/control-${layer}.gbr`);
      const undersized = (await Bun.file(path).text())
        .replaceAll(",1.500000*%", ",0.200000*%")
        .replaceAll(",0.300000*%", ",0.100000*%");
      await Bun.write(path, undersized);
    }

    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_FEATURE_MISMATCH",
    );
  });

  test("rejects outer mask and paste files with all openings deleted", async () => {
    const fixture = await emittedFixture(4);
    for (const layer of ["F_Mask", "B_Mask", "F_Paste", "B_Paste"]) {
      const path = join(fixture.root, `gerbers/control-${layer}.gbr`);
      const withoutFlashes = (await Bun.file(path).text())
        .split("\n")
        .filter((line) => !/D03\*$/.test(line))
        .join("\n");
      await Bun.write(path, withoutFlashes);
    }

    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_FEATURE_MISSING",
    );
  });

  test("rejects an open crossing profile even when its bounds match", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-Edge_Cuts.gbr");
    const attacked = (await Bun.file(path).text())
      .split("\n")
      .filter((line) => !/D0[12]\*$/.test(line))
      .join("\n")
      .replace(
        "M02*",
        [
          "X-10000000Y-07500000D02*",
          "X010000000Y007500000D01*",
          "X-10000000Y007500000D02*",
          "X010000000Y-07500000D01*",
          "M02*",
        ].join("\n"),
      );
    await Bun.write(path, attacked);

    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_PROFILE_MISMATCH",
    );

    const flashed = await emittedFixture(2);
    const flashedPath = join(flashed.root, "gerbers/control-Edge_Cuts.gbr");
    await Bun.write(
      flashedPath,
      (await Bun.file(flashedPath).text()).replace(
        "M02*",
        "D10*\nX000000000Y000000000D03*\nM02*",
      ),
    );
    expect((await codes(flashed.root, flashed.expectation)).codes).toContain(
      "GERBER_PROFILE_MISMATCH",
    );
  });

  test("rejects contradictory duplicate file functions", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace(
        "%TF.FileFunction,Copper,L1,Top*%",
        "%TF.FileFunction,Copper,L1,Top*%\n%TF.FileFunction,Copper,L2,Bot*%",
      ),
    );

    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_FILE_FUNCTION_MISMATCH",
    );
  });

  test("rejects Gerber and drill file attributes detached from their headers", async () => {
    const gerber = await emittedFixture(2);
    const gerberPath = join(gerber.root, "gerbers/control-F_Cu.gbr");
    const gerberOriginal = await Bun.file(gerberPath).text();
    const gerberAttribute = "%TF.FileFunction,Copper,L1,Top*%";
    await Bun.write(
      gerberPath,
      gerberOriginal.replace(`${gerberAttribute}\n`, "").replace("M02*", `${gerberAttribute}\nM02*`),
    );
    expect((await codes(gerber.root, gerber.expectation)).codes).toContain(
      "GERBER_STATE_UNSUPPORTED",
    );

    const drill = await emittedFixture(4);
    const drillPath = join(drill.root, "drills/drill-L1-L4.drl");
    const drillOriginal = await Bun.file(drillPath).text();
    const drillAttribute = "; #@! TF.FileFunction,Plated,1,4,PTH";
    await Bun.write(
      drillPath,
      drillOriginal.replace(`${drillAttribute}\n`, "").replace("M30", `${drillAttribute}\nM30`),
    );
    expect((await codes(drill.root, drill.expectation)).codes).toContain(
      "DRILL_FILE_FUNCTION_MISMATCH",
    );
  });

  test("rejects early or duplicate Gerber attribute deletion state", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace("%FSLAX46Y46*%", "%TD*%\n%FSLAX46Y46*%"),
    );
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_STATE_UNSUPPORTED",
    );
  });

  test("rejects aperture declarations before the Gerber format and units", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    const original = await Bun.file(path).text();
    const aperture = "%ADD11R,0.800000X0.950000*%";
    await Bun.write(
      path,
      original.replace(`${aperture}\n`, "").replace("%FSLAX46Y46*%", `${aperture}\n%FSLAX46Y46*%`),
    );
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_STATE_UNSUPPORTED",
    );
  });

  test("rejects Excellon units declared after tool definitions", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "drills/drill-L1-L2.drl");
    const original = await Bun.file(path).text();
    const toolEnd = "T12C0.200000";
    await Bun.write(
      path,
      original.replace("METRIC\n", "").replace(toolEnd, `${toolEnd}\nMETRIC`),
    );
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "DRILL_STATE_UNSUPPORTED",
    );
  });

  test("rejects Gerber and Excellon operations using undefined tools", async () => {
    const gerber = await emittedFixture(2);
    const gerberPath = join(gerber.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      gerberPath,
      (await Bun.file(gerberPath).text()).replace(
        "M02*",
        "D99*\nX001000000Y001000000D03*\nM02*",
      ),
    );
    expect((await codes(gerber.root, gerber.expectation)).codes).toContain(
      "GERBER_STATE_UNSUPPORTED",
    );

    const drill = await emittedFixture(2);
    const drillPath = join(drill.root, "drills/drill-L1-L2.drl");
    await Bun.write(
      drillPath,
      (await Bun.file(drillPath).text()).replace("M30", "T99\nX1.0000Y1.0000\nM30"),
    );
    expect((await codes(drill.root, drill.expectation)).codes).toContain(
      "DRILL_STATE_UNSUPPORTED",
    );
  });

  test.each([
    ["unused", false],
    ["used", true],
  ] as const)(
    "rejects a zero-diameter Excellon tool independently of hit reconciliation (%s)",
    async (_usage, used) => {
      const fixture = await emittedFixture(4);
      const path = join(fixture.root, "drills/drill-L1-L4.drl");
      const declaration = [
        "; #@! TA.AperFunction,Plated,PTH,ComponentDrill",
        "T99C0",
      ].join("\n");
      const attacked = (await Bun.file(path).text())
        .replace("%\nG90", `${declaration}\n%\nG90`)
        .replace(
          "M30",
          used ? "T99\nX1.0000Y1.0000\nM30" : "M30",
        );
      await Bun.write(path, attacked);

      const result = await verifyManufacturingDirectory({
        root: fixture.root,
        expectation: fixture.expectation,
      });
      expect(result.passed).toBeFalse();
      expect(result.findings).toContainEqual(expect.objectContaining({
        code: "DRILL_STATE_UNSUPPORTED",
        path: "drills/drill-L1-L4.drl",
        message: expect.stringContaining("strictly positive circular diameter"),
      }));
    },
  );

  test("rejects a BOM with correct designators but wrong values and footprints", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "assembly/bom.csv");
    const attacked = (await Bun.file(path).text())
      .replace('"10k","10k","res0603"', '"999","999","wrong-footprint"')
      .replace('"D1","","","0603"', '"D1","bad","bad","wrong"');
    await Bun.write(path, attacked);

    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "BOM_MISMATCH",
    );
  });

  test("rejects CAD owners swapped across incompatible emitted pad signatures", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-cad-owner-swap-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const resistorCad = circuitJson.find((element) =>
      element.type === "cad_component" && element.footprinter_string === "res0603"
    );
    const headerCad = circuitJson.find((element) =>
      element.type === "cad_component" &&
      element.footprinter_string === "pinrow2_nosquareplating"
    );
    if (resistorCad?.type !== "cad_component" || headerCad?.type !== "cad_component") {
      throw new Error("CAD swap fixtures missing");
    }
    const resistorOwner = resistorCad.pcb_component_id;
    resistorCad.pcb_component_id = headerCad.pcb_component_id;
    headerCad.pcb_component_id = resistorOwner;

    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("CAD footprint is not qualified by a pinned or source-bound emitted pad signature"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings.map(({ code }) => code)).toContain("MANUFACTURING_UNSUPPORTED");
  });

  test("allows an intentional CAD model-origin offset within the footprint but rejects a detached anchor", async () => {
    const circuitJson = await manufacturingFixture(2);
    const component = circuitJson.find((element) => element.type === "pcb_component" && element.source_component_id === "source_component_1");
    const cad = component?.type === "pcb_component"
      ? circuitJson.find((element) => element.type === "cad_component" && element.pcb_component_id === component.pcb_component_id)
      : undefined;
    if (component?.type !== "pcb_component" || cad?.type !== "cad_component") throw new Error("CAD anchor fixture missing");

    cad.position.x = component.center.x + component.width / 2;
    let expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).not.toContainEqual(expect.stringContaining("CAD identity or anchor"));

    cad.position.x = component.center.x + component.width / 2 + 0.01;
    expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(expect.stringContaining("CAD identity or anchor lies outside"));
  });

  test("qualifies source-bound custom geometry, mechanical pads, and optional supplier identity", async () => {
    const circuitJson = await manufacturingFixture(2);
    const source = circuitJson.find((element) =>
      element.type === "source_component" && element.name === "R1"
    );
    const component = source?.type === "source_component"
      ? circuitJson.find((element) =>
        element.type === "pcb_component" &&
        element.source_component_id === source.source_component_id
      )
      : undefined;
    const cad = component?.type === "pcb_component"
      ? circuitJson.find((element) =>
        element.type === "cad_component" &&
        element.pcb_component_id === component.pcb_component_id
      )
      : undefined;
    if (
      source?.type !== "source_component" ||
      component?.type !== "pcb_component" ||
      cad?.type !== "cad_component"
    ) throw new Error("Source-bound custom-footprint fixture is incomplete");

    source.manufacturer_part_number = "RC0603FR-0710KL";
    source.supplier_part_numbers = {};
    cad.footprinter_string = "";
    circuitJson.push({
      type: "pcb_smtpad",
      pcb_smtpad_id: "pcb_smtpad_fulmetry_mechanical_1",
      pcb_component_id: component.pcb_component_id,
      layer: "top",
      shape: "rect",
      x: component.center.x,
      y: component.center.y,
      width: 0.8,
      height: 0.8,
      port_hints: ["fulmetry:mechanical"],
    } as AnyCircuitElement);

    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).not.toContainEqual(
      expect.stringContaining(`${component.pcb_component_id}: CAD footprint is not qualified`),
    );
    expect(expectation.unsupported).not.toContainEqual(
      expect.stringContaining("pcb_smtpad_fulmetry_mechanical_1"),
    );
    expect(expectation.unsupported).not.toContainEqual(
      expect.stringContaining(`${component.pcb_component_id}: populated manufacturing component R1 supplier identity`),
    );
    expect(expectation.bomRows.find((row) => row.columns.Designator === "R1")?.columns)
      .toMatchObject({
        Footprint: "",
        Supplier: "",
        "Supplier Part Number": "",
      });
    expect(
      expectation.assemblyAuthority.find((entry) => entry.designator === "R1")?.padSources,
    ).toContain("pcb_smtpad_fulmetry_mechanical_1");
  });

  test("rejects a polarized placement rotation that contradicts its fixed pad orientation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-polarized-rotation-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const ledSource = circuitJson.find((element) =>
      element.type === "source_component" && element.ftype === "simple_led" &&
      element.are_pins_interchangeable === false
    );
    const led = ledSource?.type === "source_component"
      ? circuitJson.find((element) =>
        element.type === "pcb_component" &&
        element.source_component_id === ledSource.source_component_id
      )
      : undefined;
    if (led?.type !== "pcb_component" || led.rotation !== 90) {
      throw new Error("Bottom polarized LED fixture missing");
    }
    led.rotation = 270;

    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining("CAD footprint is not qualified by a pinned or source-bound emitted pad signature"),
    );
    const result = await verifyManufacturingDirectory({ root, expectation });
    expect(result.passed).toBeFalse();
    expect(result.findings.map(({ code }) => code)).toContain("MANUFACTURING_UNSUPPORTED");
  });

  test("rejects BOM quantity and supplier identities independently of designators", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "assembly/bom.csv");
    const original = await Bun.file(path).text();
    await Bun.write(
      path,
      original
        .replace('"R1","1",', '"R1","2",')
        .replace('"JLCPCB","C25804","C25804"', '"ACME","MISSING","MISSING"'),
    );

    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "BOM_MISMATCH",
    );
  });

  test("rejects clear-polarity copper and Gerber step-repeat replication", async () => {
    const clear = await emittedFixture(4);
    const clearPath = join(clear.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      clearPath,
      (await Bun.file(clearPath).text()).replace("%LPD*%", "%LPC*%"),
    );
    expect((await codes(clear.root, clear.expectation)).codes).toContain(
      "GERBER_POLARITY_MISMATCH",
    );

    const repeated = await emittedFixture(4);
    const repeatedPath = join(repeated.root, "gerbers/control-In1_Cu.gbr");
    await Bun.write(
      repeatedPath,
      (await Bun.file(repeatedPath).text())
        .replace("%LPD*%", "%LPD*%\n%SRX2Y1I1.0J0.0*%")
        .replace("M02*", "%SR*%\nM02*"),
    );
    expect((await codes(repeated.root, repeated.expectation)).codes).toContain(
      "GERBER_STEP_REPEAT_UNSUPPORTED",
    );
  });

  test.each(["G91*", "G70*"])(
    "rejects Gerber state command %s",
    async (command) => {
      const fixture = await emittedFixture(2);
      const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
      await Bun.write(
        path,
        (await Bun.file(path).text()).replace(/(X-?\d+Y-?\d+D0[123]\*)/, `${command}\n$1`),
      );
      expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
        "GERBER_STATE_UNSUPPORTED",
      );
    },
  );

  test.each(["G91", "M72", "INCH", "ICI,ON", "M00", "M01", "M02", "S1000", "F100", "R3", "ATC,ON"])(
    "rejects drill state command %s",
    async (command) => {
      const fixture = await emittedFixture(2);
      const path = join(fixture.root, "drills/drill-L1-L2.drl");
      await Bun.write(
        path,
        (await Bun.file(path).text()).replace(/(X-?\d+\.\d+Y-?\d+\.\d+)/, `${command}\n$1`),
      );
      expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
        "DRILL_STATE_UNSUPPORTED",
      );
    },
  );

  test("rejects early Gerber and drill terminators", async () => {
    const fixture = await emittedFixture(2);
    const gerberPath = join(fixture.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      gerberPath,
      (await Bun.file(gerberPath).text()).replace(/(X-?\d+Y-?\d+D0[123]\*)/, "M02*\n$1"),
    );
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_PARSE_ERROR",
    );

    const drill = await emittedFixture(2);
    const drillPath = join(drill.root, "drills/drill-L1-L2.drl");
    await Bun.write(
      drillPath,
      (await Bun.file(drillPath).text()).replace(/(X-?\d+\.\d+Y-?\d+\.\d+)/, "M30\n$1"),
    );
    expect((await codes(drill.root, drill.expectation)).codes).toContain(
      "DRILL_PARSE_ERROR",
    );

    const spacedGerber = await emittedFixture(2);
    const spacedGerberPath = join(spacedGerber.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      spacedGerberPath,
      (await Bun.file(spacedGerberPath).text()).replace(/(X-?\d+Y-?\d+D0[123]\*)/, " M02*\n$1"),
    );
    expect((await codes(spacedGerber.root, spacedGerber.expectation)).codes).toContain(
      "GERBER_PARSE_ERROR",
    );

    const sequencedDrill = await emittedFixture(2);
    const sequencedPath = join(sequencedDrill.root, "drills/drill-L1-L2.drl");
    await Bun.write(
      sequencedPath,
      (await Bun.file(sequencedPath).text()).replace(/(X-?\d+\.\d+Y-?\d+\.\d+)/, "N100M30\n$1"),
    );
    const sequencedCodes = (await codes(sequencedDrill.root, sequencedDrill.expectation)).codes;
    expect(sequencedCodes).toContain("DRILL_PARSE_ERROR");
    expect(sequencedCodes).toContain("DRILL_STATE_UNSUPPORTED");
  });

  test("rejects aperture holes, routed drill slots, arcs, and fake metadata", async () => {
    const holed = await emittedFixture(4);
    const holedPath = join(holed.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      holedPath,
      (await Bun.file(holedPath).text()).replace(
        /(%ADD\d+C,1\.500000)(\*%)/,
        "$1X1.000000$2",
      ),
    );
    const holedResult = await codes(holed.root, holed.expectation);
    expect(holedResult.result.passed).toBeFalse();
    expect(holedResult.codes).toContain("GERBER_STATE_UNSUPPORTED");

    const slotted = await emittedFixture(4);
    const drillPath = join(slotted.root, "drills/drill-L1-L4.drl");
    await Bun.write(
      drillPath,
      (await Bun.file(drillPath).text()).replace(
        "M30",
        "T10\nG00X0.0000Y0.0000\nM15\nG01X1.0000Y0.0000\nM16\nM30",
      ),
    );
    expect((await codes(slotted.root, slotted.expectation)).codes).toContain(
      "DRILL_HIT_MISMATCH",
    );

    const arc = await emittedFixture(2);
    const arcPath = join(arc.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      arcPath,
      (await Bun.file(arcPath).text()).replace("G01*", "G02*"),
    );
    expect((await codes(arc.root, arc.expectation)).codes).toContain(
      "GERBER_TRACE_MISMATCH",
    );

    const fake = await emittedFixture(2);
    const fakePath = join(fake.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      fakePath,
      (await Bun.file(fakePath).text()).replace(
        "%TF.FileFunction,Copper,L1,Top*%",
        "G04 %TF.FileFunction,Copper,L1,Top*%*",
      ),
    );
    expect((await codes(fake.root, fake.expectation)).codes).toContain(
      "GERBER_FILE_FUNCTION_MISMATCH",
    );
  });

  test("rejects traces reinterpreted as Gerber regions", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    const original = await Bun.file(path).text();
    const attacked = original
      .replace(/(X-?\d+Y-?\d+D02\*\nX-?\d+Y-?\d+D01\*)/, "G36*\n$1\nG37*");
    expect(attacked).not.toBe(original);
    await Bun.write(path, attacked);
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_FEATURE_MISMATCH",
    );
  });

  test("rejects drawn mask geometry and deleted authored silkscreen", async () => {
    const mask = await emittedFixture(2);
    const maskPath = join(mask.root, "gerbers/control-F_Mask.gbr");
    await Bun.write(
      maskPath,
      (await Bun.file(maskPath).text()).replace(
        "M02*",
        "D10*\nX00000000Y00000000D02*\nX01000000Y00000000D01*\nM02*",
      ),
    );
    expect((await codes(mask.root, mask.expectation)).codes).toContain(
      "GERBER_FEATURE_MISMATCH",
    );

    const silk = await emittedFixture(2);
    for (const layer of ["F_SilkScreen", "B_SilkScreen"]) {
      const path = join(silk.root, `gerbers/control-${layer}.gbr`);
      await Bun.write(
        path,
        (await Bun.file(path).text())
          .split("\n")
          .filter((line) => !/D0[12]\*$/.test(line))
          .join("\n"),
      );
    }
    expect((await codes(silk.root, silk.expectation)).codes).toContain(
      "GERBER_FEATURE_MISMATCH",
    );

    const flashed = await emittedFixture(2);
    const flashedPath = join(flashed.root, "gerbers/control-F_SilkScreen.gbr");
    await Bun.write(
      flashedPath,
      (await Bun.file(flashedPath).text()).replace(
        "M02*",
        "D10*\nX00000000Y00000000D03*\nM02*",
      ),
    );
    expect((await codes(flashed.root, flashed.expectation)).codes).toContain(
      "GERBER_FEATURE_MISMATCH",
    );
  });

  test("rejects a rectangular aperture substituted for a circular trace tool", async () => {
    const fixture = await emittedFixture(2);
    const path = join(fixture.root, "gerbers/control-F_Cu.gbr");
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace(
        /(%ADD\d+)C,0\.200000\*%/,
        "$1R,0.200000X10.000000*%",
      ),
    );
    expect((await codes(fixture.root, fixture.expectation)).codes).toContain(
      "GERBER_TRACE_MISMATCH",
    );
  });

  test("uses the physical pcb_via record for a routed via without inline diameters", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-upstream-via-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(4);
    const trace = circuitJson.find(
      (element) => element.type === "pcb_trace" &&
        element.route.some((point) => point.route_type === "via"),
    );
    if (trace?.type !== "pcb_trace") throw new Error("routed via fixture missing");
    const point = trace.route.find((candidate) => candidate.route_type === "via");
    if (point?.route_type !== "via") throw new Error("routed via point missing");
    expect(point.hole_diameter).toBeUndefined();
    expect(point.outer_diameter).toBeUndefined();
    expect(circuitJson.some(
      (element) => element.type === "pcb_via" && element.pcb_trace_id === trace.pcb_trace_id,
    )).toBeTrue();
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toEqual([]);
    expect((await codes(root, expectation)).result.passed).toBeTrue();
  });

  test("rejects empty numeric placement fields even for a component at zero", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-zero-placement-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const r1 = circuitJson.find(
      (element) => element.type === "pcb_component" && element.source_component_id === "source_component_0",
    );
    if (r1?.type !== "pcb_component") throw new Error("R1 fixture missing");
    r1.center = { x: 0, y: 0 };
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    const path = join(root, "assembly/positions.csv");
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace("R1,0.000,0.000,top,0", "R1,,,top,"),
    );
    expect((await codes(root, expectation)).codes).toContain("PLACEMENT_MISMATCH");
  });

  test("accepts supplier BOM columns, zero-ohm values, and reversed through-vias", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-semantic-positive-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(4);
    const resistor = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "R1",
    );
    if (resistor?.type !== "source_component" || resistor.ftype !== "simple_resistor") {
      throw new Error("R1 source fixture missing");
    }
    resistor.resistance = 0;
    resistor.supplier_part_numbers = { jlcpcb: ["C25804"] };
    const via = circuitJson.find((element) => element.type === "pcb_via");
    if (via?.type !== "pcb_via") throw new Error("via fixture missing");
    via.from_layer = "bottom";
    via.to_layer = "top";
    via.layers = [...via.layers].reverse();
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect((await codes(root, expectation)).result.passed).toBeTrue();
    expect(await Bun.file(join(root, "assembly/bom.csv")).text()).toContain(
      '"JLCPCB Part #"',
    );
    expect(await Bun.file(join(root, "assembly/bom.csv")).text()).toContain(
      '"Manufacturer Part Number","Supplier","Supplier Part Number"',
    );
  });

  test("preserves a single generic supplier identity in the verified BOM", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-generic-supplier-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const resistor = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "R1",
    );
    if (resistor?.type !== "source_component") throw new Error("R1 source fixture missing");
    resistor.supplier_part_numbers = { digikey: ["DKEY-123"] };
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toEqual([]);
    expect((await codes(root, expectation)).result.passed).toBeTrue();
    const row = (await Bun.file(join(root, "assembly/bom.csv")).text())
      .split("\n")
      .find((line) => line.startsWith('"R1",'));
    expect(row).toBe('"R1","1","10k","10k","res0603","","","digikey","DKEY-123",""');
  });

  test("fails closed when populated supplier identity is unsafe or ambiguous", async () => {
    const attacks = [
      { digikey: ["DKEY-123"], mouser: ["M-456"] },
      { digikey: ["DKEY-123", "DKEY-456"] },
      { "bad provider": ["PART-123"] },
    ];
    for (const [index, supplierPartNumbers] of attacks.entries()) {
      const parent = await mkdtemp(join(tmpdir(), `fulmetry-ambiguous-supplier-${index}-`));
      temporaryRoots.push(parent);
      const root = join(parent, "draft");
      const circuitJson = await manufacturingFixture(2);
      const resistor = circuitJson.find(
        (element) => element.type === "source_component" && element.name === "R1",
      );
      if (resistor?.type !== "source_component") throw new Error("R1 source fixture missing");
      resistor.supplier_part_numbers = supplierPartNumbers;
      await emitDraftManufacturingDirectory({
        targetDirectory: root,
        files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
      });
      const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
      expect(expectation.unsupported).toContainEqual(
        expect.stringContaining("supplier identity cannot be represented unambiguously in one BOM row"),
      );
      const result = await codes(root, expectation);
      expect(result.result.passed).toBeFalse();
      expect(result.codes).toContain(
        index === attacks.length - 1
          ? "MANUFACTURING_INPUT_LIMIT"
          : "MANUFACTURING_UNSUPPORTED",
      );
      const row = (await Bun.file(join(root, "assembly/bom.csv")).text())
        .split("\n")
        .find((line) => line.startsWith('"R1",'));
      expect(row).toBe('"R1","1","10k","10k","res0603","","","","",""');
    }
  });

  test("removes unsafe identity cells from draft BOMs and fails verification, including DNP", async () => {
    const attacks = [
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "R1",
        );
        if (source?.type === "source_component") {
          source.manufacturer_part_number = "MPN\0TRUNCATED";
        }
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "R1",
        );
        if (source?.type === "source_component") {
          source.manufacturer_part_number = "@SUM(1+1)";
          source.supplier_part_numbers = {
            jlcpcb: ['=HYPERLINK("https://example.invalid","open")'],
          };
        }
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        const sourceId = source?.type === "source_component"
          ? source.source_component_id
          : undefined;
        const component = json.find(
          (element) => element.type === "pcb_component" &&
            element.source_component_id === sourceId,
        );
        if (source?.type === "source_component") source.manufacturer_part_number = "+DNP_FORMULA";
        if (component?.type === "pcb_component") component.do_not_place = true;
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        const sourceId = source?.type === "source_component"
          ? source.source_component_id
          : undefined;
        const component = json.find(
          (element) => element.type === "pcb_component" &&
            element.source_component_id === sourceId,
        );
        if (source?.type === "source_component") {
          source.supplier_part_numbers = { jlcpcb: ["=DNP_FORMULA"] };
        }
        if (component?.type === "pcb_component") component.do_not_place = true;
      },
    ];
    for (const [index, attack] of attacks.entries()) {
      const parent = await mkdtemp(join(tmpdir(), `fulmetry-unsafe-bom-identity-${index}-`));
      temporaryRoots.push(parent);
      const root = join(parent, "draft");
      const circuitJson = await manufacturingFixture(2);
      attack(circuitJson);
      await emitDraftManufacturingDirectory({
        targetDirectory: root,
        files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
      });
      const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
      expect(expectation.unsupported.length).toBeGreaterThan(0);
      const result = await codes(root, expectation);
      expect(result.result.passed).toBeFalse();
      expect(result.codes).toContain("MANUFACTURING_UNSUPPORTED");
      const bom = await Bun.file(join(root, "assembly/bom.csv")).text();
      expect(bom).not.toContain("\0");
      expect(bom).not.toContain("HYPERLINK");
      expect(bom).not.toContain("SUM(1+1)");
      expect(bom).not.toContain("DNP_FORMULA");
    }
  });

  test("omits unsafe assembly designators from draft CSVs and fails verification", async () => {
    const attacks = [
      '=HYPERLINK("https://example.invalid","R1")',
      "+R1",
      "@R1",
      "R1 ",
      "R\r\n1",
      "R\u00001",
    ];
    for (const [index, unsafeDesignator] of attacks.entries()) {
      const parent = await mkdtemp(join(tmpdir(), `fulmetry-unsafe-designator-${index}-`));
      temporaryRoots.push(parent);
      const root = join(parent, "draft");
      const circuitJson = await manufacturingFixture(2);
      const source = circuitJson.find(
        (element) => element.type === "source_component" && element.name === "R1",
      );
      const sourceId = source?.type === "source_component"
        ? source.source_component_id
        : undefined;
      const component = circuitJson.find(
        (element) => element.type === "pcb_component" &&
          element.source_component_id === sourceId,
      );
      if (source?.type !== "source_component") throw new Error("R1 source fixture missing");
      source.name = unsafeDesignator;
      if (index === attacks.length - 1 && component?.type === "pcb_component") {
        component.do_not_place = true;
      }
      await emitDraftManufacturingDirectory({
        targetDirectory: root,
        files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
      });
      const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
      expect(expectation.unsupported).toContainEqual(
        expect.stringContaining("assembly designator must be a conservative ASCII reference"),
      );
      const result = await codes(root, expectation);
      expect(result.result.passed).toBeFalse();
      expect(result.codes).toContain("MANUFACTURING_UNSUPPORTED");
      const assembly = [
        await Bun.file(join(root, "assembly/bom.csv")).text(),
        await Bun.file(join(root, "assembly/positions.csv")).text(),
      ].join("\n");
      expect(assembly).not.toContain(unsafeDesignator);
      expect(assembly).not.toContain("HYPERLINK");
      expect(assembly).not.toContain("\0");
    }
  });

  test("reconciles high-precision SI component values with exporter formatting", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-high-precision-bom-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const resistor = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "R1",
    );
    if (resistor?.type !== "source_component" || resistor.ftype !== "simple_resistor") {
      throw new Error("R1 source fixture missing");
    }
    resistor.resistance = 1234.56789012345;
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect((await codes(root, expectation)).result.passed).toBeTrue();
  });

  test("accepts canonical empty assembly files while a featureless bare board remains non-verifiable", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-bare-board-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = (await manufacturingFixture(2)).filter(
      (element) => [
        "source_project_metadata",
        "source_group",
        "source_board",
        "pcb_board",
      ].includes(element.type),
    );
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.bomRows).toEqual([]);
    expect(expectation.placements).toEqual([]);
    const result = await codes(root, expectation);
    expect(result.result.passed).toBeFalse();
    expect(result.codes).not.toContain("BOM_MISMATCH");
    expect(result.codes).not.toContain("PLACEMENT_MISMATCH");
    expect(result.codes).toContain("GERBER_STATE_UNSUPPORTED");
  });

  test("omits DNP components from placement while retaining their BOM marker", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fulmetry-dnp-"));
    temporaryRoots.push(parent);
    const root = join(parent, "draft");
    const circuitJson = await manufacturingFixture(2);
    const d1 = circuitJson.find(
      (element) => element.type === "pcb_component" &&
        element.source_component_id === "source_component_1",
    );
    if (d1?.type !== "pcb_component") throw new Error("D1 fixture missing");
    d1.do_not_place = true;
    await emitDraftManufacturingDirectory({
      targetDirectory: root,
      files: await exportManufacturingFiles({ boardName: "control", circuitJson }),
    });
    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect((await codes(root, expectation)).result.passed).toBeTrue();
    expect(await Bun.file(join(root, "assembly/bom.csv")).text()).toContain("DNP");
    expect(await Bun.file(join(root, "assembly/positions.csv")).text()).not.toContain("D1");
  });

  test("blocks unresolved assembly identity and pad mapping", async () => {
    const attacks = [
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) =>
        json.filter(
          (element) => !(element.type === "source_component" && element.name === "D1"),
        ),
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) =>
        json.filter(
          (element) => !(element.type === "cad_component" && element.source_component_id === "source_component_1"),
        ),
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        if (source?.type === "source_component") source.name = "";
        return json;
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        if (source?.type === "source_component") source.name = "R1";
        return json;
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        const sourceId = source?.type === "source_component"
          ? source.source_component_id
          : undefined;
        const component = json.find(
          (element) => element.type === "pcb_component" &&
            element.source_component_id === sourceId,
        );
        if (source?.type === "source_component") source.name = "";
        if (component?.type === "pcb_component") component.do_not_place = true;
        return json;
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) =>
        json.filter(
          (element) => !(element.type === "pcb_smtpad" && element.pcb_component_id === "pcb_component_1"),
        ),
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        if (source?.type === "source_component") {
          source.supplier_part_numbers = { digikey: ["DKEY-123"], mouser: ["M-456"] };
        }
        return json;
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        if (source?.type === "source_component") {
          source.supplier_part_numbers = { digikey: ["DKEY-123", "DKEY-456"] };
        }
        return json;
      },
      (json: Awaited<ReturnType<typeof manufacturingFixture>>) => {
        const source = json.find(
          (element) => element.type === "source_component" && element.name === "D1",
        );
        if (source?.type === "source_component") source.name = "unnamed_led1";
        return json;
      },
    ];

    for (const attack of attacks) {
      const circuitJson = attack(await manufacturingFixture(2));
      const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
      expect(expectation.unsupported.length).toBeGreaterThan(0);
    }
  });

  test("rejects a reversed footprint pin map for a non-interchangeable component", async () => {
    const circuitJson = await manufacturingFixture(2);
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "D1",
    );
    if (source?.type !== "source_component" || source.are_pins_interchangeable !== false) {
      throw new Error("Non-interchangeable D1 fixture missing");
    }
    const sourcePorts = circuitJson.filter(
      (element): element is SourcePortElement => element.type === "source_port" &&
        element.source_component_id === source.source_component_id,
    ).sort((left, right) => Number(left.pin_number) - Number(right.pin_number));
    if (sourcePorts.length !== 2) throw new Error("D1 pin fixture missing");
    const [pin1, pin2] = sourcePorts;
    const component = circuitJson.find(
      (element) => element.type === "pcb_component" &&
        element.source_component_id === source.source_component_id,
    );
    if (component?.type !== "pcb_component") throw new Error("D1 PCB fixture missing");
    const pcbPorts = circuitJson.filter(
      (element): element is PcbPortElement => element.type === "pcb_port" &&
        element.pcb_component_id === component.pcb_component_id,
    );
    const pad1Port = pcbPorts.find((port) => port.source_port_id === pin1!.source_port_id);
    const pad2Port = pcbPorts.find((port) => port.source_port_id === pin2!.source_port_id);
    if (pad1Port === undefined || pad2Port === undefined) throw new Error("D1 pad map missing");
    pad1Port.source_port_id = pin2!.source_port_id;
    pad2Port.source_port_id = pin1!.source_port_id;
    pin1!.pin_number = 2;
    pin2!.pin_number = 1;
    pin1!.name = "pin2";
    pin2!.name = "pin1";
    pin1!.port_hints = (pin1!.port_hints ?? []).map((hint) => ({
      pin1: "pin2", "1": "2", anode: "cathode", pos: "neg", left: "right",
    })[hint] ?? hint);
    pin2!.port_hints = (pin2!.port_hints ?? []).map((hint) => ({
      pin2: "pin1", "2": "1", cathode: "anode", neg: "pos", right: "left",
    })[hint] ?? hint);

    const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining(
        `schematic port identity for ${pin1!.source_port_id} contradicts source pin 2`,
      ),
    );
    expect(expectation.unsupported).toContainEqual(
      expect.stringContaining(
        `schematic port identity for ${pin2!.source_port_id} contradicts source pin 1`,
      ),
    );
  });

  test.each(["pcb_smtpad", "pcb_plated_hole"] as const)(
    "rejects a PCB port displaced from its owning %s center",
    async (padType) => {
      const circuitJson = await manufacturingFixture(2);
      const pad = circuitJson.find((element) => element.type === padType);
      if (pad === undefined || !("pcb_port_id" in pad) || pad.pcb_port_id === undefined) {
        throw new Error(`${padType} fixture missing`);
      }
      const port = circuitJson.find(
        (element) => element.type === "pcb_port" && element.pcb_port_id === pad.pcb_port_id,
      );
      if (port?.type !== "pcb_port") throw new Error("Owning PCB port fixture missing");
      port.x += 5;

      const expectation = deriveManufacturingExpectation({ boardName: "control", circuitJson });
      expect(expectation.unsupported).toContainEqual(
        expect.stringContaining(
          `PCB port ${port.pcb_port_id} does not coincide with every mapped manufactured pad center`,
        ),
      );
    },
  );
});
