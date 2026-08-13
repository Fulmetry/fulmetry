#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalCircuitJson } from "../src/circuit-json";
import { createKicadHandoff, validateKicadHandoffLive, verifyKicadLiveInputEvidence } from "../src/kicad";
import { requireSupportedBunRuntime } from "../src/runtime";
import { manufacturingFixture } from "../test/fixtures/manufacturing";

const repositoryRoot = join(import.meta.dir, "..");
const evidenceRoot = join(repositoryRoot, ".pcboo-ci", "kicad-live-darwin-arm64");
const executable = process.env.PCBOO_KICAD_CLI ??
  "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

requireSupportedBunRuntime();
await mkdir(join(repositoryRoot, ".pcboo-ci"), { recursive: true });
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
    projectName: `pcboo-${layers}-layer`,
  });
  const validation = await validateKicadHandoffLive({
    handoff,
    outputRoot: fixtureRoot,
    runDirectory,
    executable,
  });
  if (validation.state !== "qualified") {
    throw new Error(`KiCad ${layers}-layer qualification did not pass: ${validation.message}`);
  }
  await verifyKicadLiveInputEvidence(validation);
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
  kind: "pcboo-live-kicad-qualification",
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
