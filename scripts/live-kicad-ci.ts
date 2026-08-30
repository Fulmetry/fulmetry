#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalCircuitJson } from "../src/circuit-json";
import { createKicadHandoff, validateKicadHandoffLive, verifyKicadLiveInputEvidence } from "../src/kicad";
import { requireSupportedBunRuntime } from "../src/runtime";
import { manufacturingFixture } from "../test/fixtures/manufacturing";

const repositoryRoot = join(import.meta.dir, "..");
const evidenceRoot = join(repositoryRoot, ".fulmetry-ci", "kicad-live-darwin-arm64");
const executable = process.env.FULMETRY_KICAD_CLI ??
  "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

async function inspectFailClosedRuleReports(
  fixtureRoot: string,
  projectName: string,
): Promise<Readonly<{ ercViolationTypes: readonly string[]; drcFindingCount: number }>> {
  const output = join(fixtureRoot, "run", "kicad-live-validation", "qualification-output");
  const erc = JSON.parse(await readFile(join(output, "erc.json"), "utf8")) as unknown;
  const drc = JSON.parse(await readFile(join(output, "drc.json"), "utf8")) as unknown;
  record(erc, "KiCad ERC report");
  record(drc, "KiCad DRC report");
  if (
    erc.$schema !== "https://schemas.kicad.org/erc.v1.json" ||
    erc.source !== `${projectName}.kicad_sch` ||
    JSON.stringify(erc.included_severities) !== JSON.stringify(["error", "warning", "exclusion"]) ||
    !Array.isArray(erc.sheets)
  ) throw new Error("KiCad ERC compatibility report has an unexpected identity or severity envelope");
  const ercViolations = erc.sheets.flatMap((sheet) => {
    record(sheet, "KiCad ERC sheet");
    if (!Array.isArray(sheet.violations)) throw new Error("KiCad ERC sheet omitted violations");
    return sheet.violations;
  });
  const ercViolationTypes = ercViolations.map((violation) => {
    record(violation, "KiCad ERC violation");
    if (typeof violation.type !== "string" || typeof violation.severity !== "string") {
      throw new Error("KiCad ERC violation has an invalid type or severity");
    }
    return violation.type;
  }).sort();
  if (ercViolationTypes.length === 0) throw new Error("Expected the current detached handoff to fail closed on ERC findings");
  if (
    drc.$schema !== "https://schemas.kicad.org/drc.v1.json" ||
    drc.source !== `${projectName}.kicad_pcb` ||
    !Array.isArray(drc.violations) || !Array.isArray(drc.unconnected_items) ||
    !Array.isArray(drc.schematic_parity)
  ) throw new Error("KiCad DRC compatibility report has an unexpected identity or finding envelope");
  const drcFindingCount = drc.violations.length + drc.unconnected_items.length + drc.schematic_parity.length;
  return Object.freeze({ ercViolationTypes: Object.freeze(ercViolationTypes), drcFindingCount });
}

requireSupportedBunRuntime();
await mkdir(join(repositoryRoot, ".fulmetry-ci"), { recursive: true });
await mkdir(evidenceRoot);

const fixtures = [];
for (const layers of [2, 4] as const) {
  const fixtureRoot = join(evidenceRoot, `${layers}-layer`);
  const runDirectory = join(fixtureRoot, "run");
  await mkdir(runDirectory, { recursive: true });
  const circuitJson = await manufacturingFixture(layers);
  const canonicalSource = canonicalCircuitJson(circuitJson);
  const sourcePath = join(fixtureRoot, "source-circuit.json");
  await writeFile(sourcePath, canonicalSource, { flag: "wx" });
  const handoff = await createKicadHandoff(circuitJson, {
    projectName: `fulmetry-${layers}-layer`,
  });
  const validation = await validateKicadHandoffLive({
    handoff,
    outputRoot: fixtureRoot,
    runDirectory,
    executable,
  });
  await writeFile(
    join(fixtureRoot, "live-validation.json"),
    `${JSON.stringify(validation, null, 2)}\n`,
    { flag: "wx" },
  );
  if (
    validation.state !== "failed" ||
    !validation.message.startsWith("KiCad behavioral qualification failed:") ||
    validation.evidence?.execution.commands.map(({ name }) => name).join(",") !==
      "schematic-erc,pcb-drc,schematic-netlist,pcb-gerbers"
  ) {
    throw new Error(`KiCad ${layers}-layer compatibility did not reach the expected fail-closed rule result: ${validation.message}`);
  }
  await verifyKicadLiveInputEvidence(validation);
  const ruleReports = await inspectFailClosedRuleReports(fixtureRoot, `fulmetry-${layers}-layer`);
  const report = Object.freeze({
    layers,
    circuitDigest: handoff.report.circuitDigest,
    sourceCircuit: Object.freeze({
      path: "source-circuit.json",
      size: new TextEncoder().encode(canonicalSource).byteLength,
      sha256: sha256(canonicalSource),
    }),
    semanticReconciliation: handoff.report.semanticReconciliation,
    mapping: handoff.report.mapping,
    validation,
    ruleReports,
  });
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(join(fixtureRoot, "qualification.json"), reportBytes, { flag: "wx" });
  fixtures.push(Object.freeze({
    layers,
    circuitDigest: handoff.report.circuitDigest,
    semanticReconciliationSha256: handoff.report.semanticReconciliation.sha256,
    sourceCircuitSha256: sha256(canonicalSource),
    reportSha256: sha256(reportBytes),
    inputArtifactSetSha256: validation.evidence!.input.artifactSetSha256,
    outputArtifactSetSha256: sha256(
      validation.evidence!.execution.outputs
        .map(({ path, size, sha256: digest }) => `${path}\0${size}\0${digest}\n`)
        .join(""),
    ),
    commandNames: validation.evidence!.execution.commands.map(({ name }) => name),
    validationState: validation.state,
    ercViolationTypes: ruleReports.ercViolationTypes,
    drcFindingCount: ruleReports.drcFindingCount,
  }));
}

const resolvedExecutable = await realpath(executable);
const firstReport = JSON.parse(
  await Bun.file(join(evidenceRoot, "2-layer", "qualification.json")).text(),
) as { validation: { evidence: { tool: unknown } } };
const secondReport = JSON.parse(
  await Bun.file(join(evidenceRoot, "4-layer", "qualification.json")).text(),
) as { validation: { evidence: { tool: unknown } } };
if (JSON.stringify(firstReport.validation.evidence.tool) !== JSON.stringify(secondReport.validation.evidence.tool)) {
  throw new Error("KiCad tool identity changed between the two- and four-layer live fixtures");
}
const body = Object.freeze({
  schemaVersion: 1,
  kind: "fulmetry-live-kicad-compatibility",
  runtime: Object.freeze({
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
  }),
  executable: resolvedExecutable,
  tool: firstReport.validation.evidence.tool,
  fixtures: Object.freeze(fixtures),
});
const evidence = Object.freeze({
  ...body,
  selfSha256: sha256(JSON.stringify(body)),
});
await writeFile(
  join(evidenceRoot, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
