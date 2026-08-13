// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateKicadBehavioralOutputs } from "../src/kicad/live";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function outputFixture(): Promise<{
  root: string;
  outputs: Array<{ path: string; size: number; sha256: string }>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-kicad-output-"));
  roots.push(root);
  await mkdir(join(root, "gerbers"));
  const files: Record<string, string> = {
    "erc.json": '{"$schema":"https://schemas.kicad.org/erc.v1.json","coordinate_units":"mm","date":"2026-08-13T00:00:00Z","kicad_version":"10.0.5","source":"board.kicad_sch","included_severities":["error","warning","exclusion"],"ignored_checks":[],"sheets":[{"path":"/","uuid_path":"/00000000-0000-0000-0000-000000000001","violations":[]}]}',
    "drc.json": '{"$schema":"https://schemas.kicad.org/drc.v1.json","coordinate_units":"mm","date":"2026-08-13T00:00:00Z","kicad_version":"10.0.5","source":"board.kicad_pcb","included_severities":["error","warning","exclusion"],"ignored_checks":[],"violations":[],"unconnected_items":[],"schematic_parity":[]}',
    "board.net": '(export (components (comp (ref "R1"))) (nets (net (name "GND"))))',
    "gerbers/board-F_Cu.gbr": "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX1000Y0D01*\nM02*\n",
    "gerbers/board-In1_Cu.gbr": "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L2,Inr*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX1000Y0D01*\nM02*\n",
    "gerbers/board-In2_Cu.gbr": "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L3,Inr*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX1000Y0D01*\nM02*\n",
    "gerbers/board-B_Cu.gbr": "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L4,Bot*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX1000Y0D01*\nM02*\n",
    "gerbers/board-Edge_Cuts.gbr": "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Profile,NP*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX1000Y0D01*\nX1000Y1000D01*\nX0Y1000D01*\nX0Y0D01*\nM02*\n",
  };
  const outputs = [];
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(join(root, ...path.split("/")), content);
    outputs.push({ path, size: new TextEncoder().encode(content).byteLength, sha256: sha256(content) });
  }
  return { root, outputs };
}

const contract = Object.freeze({
  projectName: "board",
  expectedKicadVersion: "10.0.5",
  semanticCopperLayers: Object.freeze(["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]),
  semanticComponentReferences: Object.freeze(["R1"]),
  semanticSchematicNetNames: Object.freeze(["GND"]),
  semanticBoard: Object.freeze({
    widthMm: 0.001,
    heightMm: 0.001,
    kicadCenter: Object.freeze({ x: 0.0005, y: 0.0005 }),
  }),
});

test("accepts bounded parseable reports with complete netlist and four-layer Gerber identity", async () => {
  const fixture = await outputFixture();
  await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).resolves.toBeUndefined();
});

test("rejects malformed reports and netlists with omitted semantic identities", async () => {
  for (const mutation of [
    async (root: string) => Bun.write(join(root, "erc.json"), "[]"),
    async (root: string) => Bun.write(join(root, "board.net"), '(export (components) (nets (net (name "GND"))))'),
    async (root: string) => Bun.write(join(root, "board.net"), '(export (components (comp (ref "R1"))) (nets))'),
    async (root: string) => Bun.write(join(root, "board.net"), '(export (components (comp (ref "R1")))'),
  ]) {
    const fixture = await outputFixture();
    await mutation(fixture.root);
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
});

test("rejects missing, duplicate, empty, malformed, or misclassified required Gerbers", async () => {
  const cases: Array<(fixture: Awaited<ReturnType<typeof outputFixture>>) => Promise<void> | void> = [
    ({ outputs }) => { outputs.splice(outputs.findIndex(({ path }) => path.includes("In1_Cu")), 1); },
    ({ outputs }) => { outputs.push({ ...outputs.find(({ path }) => path.includes("In1_Cu"))!, path: "gerbers/copy-In1_Cu.gbr" }); },
    async ({ root }) => Bun.write(join(root, "gerbers/board-In1_Cu.gbr"), ""),
    async ({ root }) => Bun.write(join(root, "gerbers/board-In1_Cu.gbr"), "%FSLAX46Y46*%\n%MOMM*%\nM02*\n"),
    async ({ root }) => Bun.write(join(root, "gerbers/board-Edge_Cuts.gbr"), "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\nM02*\n"),
    async ({ root }) => Bun.write(join(root, "gerbers/board-In1_Cu.gbr"), "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L2,Inr*%\n%TF.FileFunction,Copper,L1,Top*%\nM02*\n"),
    async ({ root }) => Bun.write(join(root, "gerbers/board-In1_Cu.gbr"), "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L2,Inr*%\n%TF.FileFunction,Copper,L2,Inr*%\nM02*\n"),
    async ({ root }) => Bun.write(join(root, "gerbers/board-Edge_Cuts.gbr"), "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Profile,NP*%\n%TF.FileFunction,Copper,L1,Top*%\nM02*\n"),
    async ({ root }) => Bun.write(join(root, "gerbers/board-Edge_Cuts.gbr"), "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Profile,NP*%\n%TF.FileFunction,Profile,NP*%\nM02*\n"),
    async ({ root }) => Promise.all([
      "board-In1_Cu.gbr", "board-In2_Cu.gbr", "board-B_Cu.gbr",
    ].map((name) => Bun.write(join(root, "gerbers", name), "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\nM02*\n"))),
  ];
  for (const mutate of cases) {
    const fixture = await outputFixture();
    await mutate(fixture);
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
});

test("rejects X2 file-function text embedded in a Gerber comment on every required layer", async () => {
  for (const [path, expected] of [
    ["gerbers/board-F_Cu.gbr", "%TF.FileFunction,Copper,L1,Top*%"],
    ["gerbers/board-In1_Cu.gbr", "%TF.FileFunction,Copper,L2,Inr*%"],
    ["gerbers/board-In2_Cu.gbr", "%TF.FileFunction,Copper,L3,Inr*%"],
    ["gerbers/board-B_Cu.gbr", "%TF.FileFunction,Copper,L4,Bot*%"],
    ["gerbers/board-Edge_Cuts.gbr", "%TF.FileFunction,Profile,NP*%"],
  ] as const) {
    const fixture = await outputFixture();
    await Bun.write(join(fixture.root, path), `%FSLAX46Y46*%\n%MOMM*%\nG04 ${expected}\nM02*\n`);
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
});

test("rejects X2 file-function commands after Gerber termination on every required layer", async () => {
  for (const [path, expected] of [
    ["gerbers/board-F_Cu.gbr", "%TF.FileFunction,Copper,L1,Top*%"],
    ["gerbers/board-In1_Cu.gbr", "%TF.FileFunction,Copper,L2,Inr*%"],
    ["gerbers/board-In2_Cu.gbr", "%TF.FileFunction,Copper,L3,Inr*%"],
    ["gerbers/board-B_Cu.gbr", "%TF.FileFunction,Copper,L4,Bot*%"],
    ["gerbers/board-Edge_Cuts.gbr", "%TF.FileFunction,Profile,NP*%"],
  ] as const) {
    const fixture = await outputFixture();
    await Bun.write(join(fixture.root, path), `%FSLAX46Y46*%\n%MOMM*%\nM02*\n${expected}\n`);
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
      "contains commands after M02 termination",
    );
  }
});

test("rejects an apparent X2 command inside a comment spanning lines", async () => {
  const fixture = await outputFixture();
  await Bun.write(
    join(fixture.root, "gerbers/board-In1_Cu.gbr"),
    "%FSLAX46Y46*%\n%MOMM*%\nG04 comment\n%TF.FileFunction,Copper,L2,Inr*%\nM02*\n",
  );
  await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
});

test("rejects header-only Gerbers on every required layer", async () => {
  for (const [path, expected] of [
    ["gerbers/board-F_Cu.gbr", "%TF.FileFunction,Copper,L1,Top*%"],
    ["gerbers/board-In1_Cu.gbr", "%TF.FileFunction,Copper,L2,Inr*%"],
    ["gerbers/board-In2_Cu.gbr", "%TF.FileFunction,Copper,L3,Inr*%"],
    ["gerbers/board-B_Cu.gbr", "%TF.FileFunction,Copper,L4,Bot*%"],
    ["gerbers/board-Edge_Cuts.gbr", "%TF.FileFunction,Profile,NP*%"],
  ] as const) {
    const fixture = await outputFixture();
    await Bun.write(join(fixture.root, path), `%FSLAX46Y46*%\n%MOMM*%\n${expected}\nM02*\n`);
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
});

test("rejects coordinate-like garbage and a zero-area profile", async () => {
  for (const path of [
    "gerbers/board-F_Cu.gbr",
    "gerbers/board-In1_Cu.gbr",
    "gerbers/board-In2_Cu.gbr",
    "gerbers/board-B_Cu.gbr",
  ]) {
    const fixture = await outputFixture();
    const expected = await Bun.file(join(fixture.root, path)).text();
    await Bun.write(join(fixture.root, path), expected
      .replace("X0Y0D02*", "NOT_A_GERBER_RECORD_X0Y0D02*")
      .replace("X1000Y0D01*", "NOT_A_GERBER_RECORD_X1000Y0D01*"));
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
      "lacks drawable copper geometry",
    );
  }
  const fixture = await outputFixture();
  await Bun.write(
    join(fixture.root, "gerbers/board-Edge_Cuts.gbr"),
    "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Profile,NP*%\n%ADD10C,0.1*%\nD10*\n" +
      "X0Y0D02*\nX1000Y0D01*\nX2000Y0D01*\nX0Y0D01*\nM02*\n",
  );
  await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
    "lacks a closed drawable profile",
  );
});

test("rejects extra or dimensionally unrelated closed profiles", async () => {
  for (const geometry of [
    "X0Y0D02*\nX1000Y0D01*\nX1000Y1000D01*\nX0Y1000D01*\nX0Y0D01*\n" +
      "X0Y0D02*\nX1000Y0D01*\nX1000Y1000D01*\nX0Y1000D01*\nX0Y0D01*\n",
    "X999999Y999999D02*\nX1000000Y999999D01*\nX999999Y1000000D01*\nX999999Y999999D01*\n",
  ]) {
    const fixture = await outputFixture();
    await Bun.write(
      join(fixture.root, "gerbers/board-Edge_Cuts.gbr"),
      "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Profile,NP*%\n%ADD10C,0.1*%\nD10*\n" + geometry + "M02*\n",
    );
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
});

test("rejects drawable records without a defined selected aperture", async () => {
  const fixture = await outputFixture();
  await Bun.write(
    join(fixture.root, "gerbers/board-F_Cu.gbr"),
    "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\nX0Y0D02*\nX1000Y0D01*\nM02*\n",
  );
  await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
    "draws without a defined selected aperture",
  );
});

test("rejects conflicting format or unit declarations and undefined aperture macros", async () => {
  for (const content of [
    "%FSLAX43Y43*%\n%MOMM*%\n%TF.FileFunction,Profile,NP*%\n%ADD10C,0.1*%\nD10*\n" +
      "X0Y0D02*\nX1000Y0D01*\nX1000Y1000D01*\nX0Y1000D01*\nX0Y0D01*\nM02*\n",
    "%FSLAX46Y46*%\n%MOMM*%\n%MOIN*%\n%TF.FileFunction,Profile,NP*%\n%ADD10C,0.1*%\nD10*\n" +
      "X0Y0D02*\nX1000Y0D01*\nX1000Y1000D01*\nX0Y1000D01*\nX0Y0D01*\nM02*\n",
  ]) {
    const fixture = await outputFixture();
    await Bun.write(join(fixture.root, "gerbers/board-Edge_Cuts.gbr"), content);
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
  const fixture = await outputFixture();
  await Bun.write(
    join(fixture.root, "gerbers/board-F_Cu.gbr"),
    "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\n%ADD10MISSING,0.1*%\nD10*\n" +
      "X0Y0D02*\nX1000Y0D01*\nM02*\n",
  );
  await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
    "unsupported aperture definition",
  );
});

test("rejects invalid aperture arity, aperture macros, and curved board edges", async () => {
  for (const aperture of [
    "%ADD10R,0.1*%",
    "%ADD10P,0.1*%",
    "%AMMYMAC*THIS IS NOT A GERBER MACRO PRIMITIVE*%\n%ADD10MYMAC,0.1*%",
  ]) {
    const fixture = await outputFixture();
    await Bun.write(
      join(fixture.root, "gerbers/board-F_Cu.gbr"),
      `%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\n${aperture}\nD10*\n` +
        "X0Y0D02*\nX1000Y0D01*\nM02*\n",
    );
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
  const fixture = await outputFixture();
  await Bun.write(
    join(fixture.root, "gerbers/board-Edge_Cuts.gbr"),
    "%FSLAX46Y46*%\n%MOMM*%\n%TF.FileFunction,Profile,NP*%\n%ADD10C,0.1*%\nD10*\n" +
      "X0Y0D02*\nG02X1000Y0I500J0D01*\nG02X1000Y1000I0J500D01*\n" +
      "G02X0Y1000I-500J0D01*\nG02X0Y0I0J-500D01*\nM02*\n",
  );
  await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
    "curved interpolation",
  );
});

test("rejects rule-check violations, impossible polygon apertures, and copper arcs", async () => {
  for (const [path, content] of [
    ["erc.json", '{"$schema":"https://schemas.kicad.org/erc.v1.json","coordinate_units":"mm","kicad_version":"10.0.5","source":"board.kicad_sch","sheets":[{"path":"/","uuid_path":"/id","violations":[{"severity":"error"}]}]}'],
    ["drc.json", '{"$schema":"https://schemas.kicad.org/drc.v1.json","coordinate_units":"mm","kicad_version":"10.0.5","source":"board.kicad_pcb","violations":[{"severity":"error"}],"unconnected_items":[],"schematic_parity":[]}'],
  ] as const) {
    const fixture = await outputFixture();
    await Bun.write(join(fixture.root, path), content);
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
  for (const aperture of ["%ADD10P,0.1X999*%", "%ADD10P,0.1X4X0*%"] as const) {
    const fixture = await outputFixture();
    const original = await Bun.file(join(fixture.root, "gerbers/board-F_Cu.gbr")).text();
    await Bun.write(join(fixture.root, "gerbers/board-F_Cu.gbr"), original.replace("%ADD10C,0.1*%", aperture));
    if (aperture.includes("X999")) {
      await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
    } else {
      await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).resolves.toBeUndefined();
    }
  }
  const fixture = await outputFixture();
  const original = await Bun.file(join(fixture.root, "gerbers/board-In1_Cu.gbr")).text();
  await Bun.write(
    join(fixture.root, "gerbers/board-In1_Cu.gbr"),
    original.replace("X1000Y0D01*", "G02X1000Y0D01*"),
  );
  await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
    "curved interpolation",
  );
});

test("binds rule reports to exact schema, source, version, date, and unique JSON keys", async () => {
  const validErc = await (async () => {
    const fixture = await outputFixture();
    return { fixture, report: JSON.parse(await Bun.file(join(fixture.root, "erc.json")).text()) as Record<string, unknown> };
  })();
  for (const mutate of [
    (report: Record<string, unknown>) => { report.sheets = []; },
    (report: Record<string, unknown>) => { report.source = "other.kicad_sch"; },
    (report: Record<string, unknown>) => { report.kicad_version = "10.evil"; },
    (report: Record<string, unknown>) => { delete report.date; },
  ]) {
    const fixture = await outputFixture();
    const report = structuredClone(validErc.report);
    mutate(report);
    await Bun.write(join(fixture.root, "erc.json"), JSON.stringify(report));
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow();
  }
  const duplicate = await outputFixture();
  await Bun.write(
    join(duplicate.root, "drc.json"),
    '{"$schema":"https://schemas.kicad.org/drc.v1.json","coordinate_units":"mm","date":"2026-08-13T00:00:00Z","kicad_version":"10.0.5","source":"board.kicad_pcb","violations":[{"severity":"error"}],"violations":[],"unconnected_items":[],"schematic_parity":[]}',
  );
  await expect(validateKicadBehavioralOutputs(duplicate.root, duplicate.outputs, contract)).rejects.toThrow(
    "duplicate key",
  );
});

test("rejects incomplete severity coverage and ignored rule checks", async () => {
  for (const [path, mutate] of [
    ["erc.json", (report: Record<string, unknown>) => { report.included_severities = ["error"]; }],
    ["drc.json", (report: Record<string, unknown>) => {
      report.ignored_checks = [{ key: "clearance", description: "disabled" }];
    }],
  ] as const) {
    const fixture = await outputFixture();
    const report = JSON.parse(await Bun.file(join(fixture.root, path)).text()) as Record<string, unknown>;
    mutate(report);
    await Bun.write(join(fixture.root, path), JSON.stringify(report));
    await expect(validateKicadBehavioralOutputs(fixture.root, fixture.outputs, contract)).rejects.toThrow(
      "does not match the qualified KiCad 10 JSON identity",
    );
  }
});
