import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AnyCircuitElement } from "tscircuit";
import { createBuildInputSnapshot } from "../src/artifacts/inputs";
import { canonicalCircuitJson } from "../src/circuit-json";
import { createDraftArtifactManifest } from "../src/artifacts/manifest";
import {
  assessProductionReadiness,
  boardRevisionSilkscreenDiagnostic,
  INCOMPLETE_VERIFIED_BUNDLE_MARKER,
  publishVerifiedProductionBundle,
  promoteProductionBundle,
  VERIFIED_BUNDLE_MANIFEST_FILENAME,
  verifyPublishedProductionBundle,
  type PromoteProductionBundleOptions,
} from "../src/artifacts/promotion";
import { defineDiagnostic, diagnosticId } from "../src/diagnostics";
import {
  EXPECTED_TSCIRCUIT_CONTENT_SHA256,
} from "../src/engine-identity";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import {
  assuranceStatus,
  sourcingStatus,
  statusSet,
} from "../src/status";
import { manufacturingFixture } from "./fixtures/manufacturing";
import { BASELINE_FABRICATION_PROFILE } from "../src/profiles/baseline";
import {
  recordedSourcingPolicyDigest,
  recordedSourcingSelectionContentSha256,
} from "../src/sourcing";
import {
  SUPPORTED_TSCIRCUIT_INTEGRITY,
  SUPPORTED_TSCIRCUIT_VERSION,
} from "../src/project/lock";

const roots: string[] = [];

function productionArtifactKinds(
  files: readonly { readonly path: string; readonly kind: string }[],
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries([
    ...files.map(({ path, kind }) => [path, kind] as const),
    ["evidence/circuit.json", "compiled-circuit"] as const,
  ]));
}

function retainedArtifactKinds(
  manifest: { readonly artifacts: readonly { readonly path: string; readonly kind?: string }[] },
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(manifest.artifacts.map(({ path, kind }) => {
    if (kind === undefined) throw new Error(`Production fixture artifact ${path} lacks a kind`);
    return [path, kind] as const;
  })));
}

async function fixture(layerCount: 2 | 4 = 4): Promise<PromoteProductionBundleOptions> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-promote-"));
  roots.push(root);
  const projectRoot = join(root, "agent project ü");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(join(projectRoot, "node_modules"), { recursive: true });
  await symlink(
    join(import.meta.dir, "../node_modules/tscircuit"),
    join(projectRoot, "node_modules/tscircuit"),
  );
  const circuitJson = await manufacturingFixture(layerCount);
  await Bun.write(
    join(projectRoot, "src/board.tsx"),
    `export default ${canonicalCircuitJson(circuitJson).trim()}\n`,
  );
  await Bun.write(
    join(projectRoot, "pcboo.config.ts"),
    `export default { entry: 'src/board.tsx', profiles: ['${BASELINE_FABRICATION_PROFILE.name}'], boardRevision: 'A' }\n`,
  );
  await Bun.write(join(projectRoot, "pcboo.lock"), JSON.stringify({
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
    profiles: {
      [BASELINE_FABRICATION_PROFILE.name]: {
        version: BASELINE_FABRICATION_PROFILE.version,
        digest: BASELINE_FABRICATION_PROFILE.digest,
      },
    },
    assets: {},
  }, null, 2) + "\n");
  const inputSnapshot = await createBuildInputSnapshot({
    projectRoot,
    inputs: [
      { path: "src/board.tsx", role: "source" },
      { path: "pcboo.config.ts", role: "config" },
      { path: "pcboo.lock", role: "lockfile" },
    ],
  });

  const files = await exportManufacturingFiles({ boardName: "control", circuitJson });
  const artifactRoot = join(root, "run-001", "draft");
  await emitDraftManufacturingDirectory({ targetDirectory: artifactRoot, files });
  await mkdir(join(artifactRoot, "evidence"), { recursive: true });
  await Bun.write(
    join(artifactRoot, "evidence/circuit.json"),
    canonicalCircuitJson(circuitJson),
  );
  const draftManifest = await createDraftArtifactManifest({
    root: artifactRoot,
    boardRevision: "A",
    artifactPaths: [...files.map(({ path }) => path), "evidence/circuit.json"],
    artifactKinds: productionArtifactKinds(files),
  });

  return {
    artifactRoot,
    projectRoot,
    draftManifest,
    inputSnapshot,
    manufacturingExpectation: deriveManufacturingExpectation({
      boardName: "control",
      circuitJson,
    }),
    statuses: statusSet({
      fabrication: assuranceStatus("fabrication", "passed"),
      electrical: assuranceStatus("electrical", "passed"),
      functional: assuranceStatus("functional", "not-run"),
      standards: assuranceStatus("standards", "not-run"),
      sourcing: sourcingStatus("unchecked"),
    }),
  };
}

async function replaceFixtureConfigRevision(
  options: PromoteProductionBundleOptions,
  boardRevision?: string,
): Promise<PromoteProductionBundleOptions> {
  await Bun.write(
    join(options.projectRoot, "pcboo.config.ts"),
    `export default { entry: 'src/board.tsx', profiles: ['${BASELINE_FABRICATION_PROFILE.name}']${
      boardRevision === undefined
        ? ""
        : `, boardRevision: ${JSON.stringify(boardRevision)}`
    } }\n`,
  );
  const inputSnapshot = await createBuildInputSnapshot({
    projectRoot: options.projectRoot,
    inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
  });
  return { ...options, inputSnapshot };
}

async function fixtureWithRecordedSourcing(): Promise<PromoteProductionBundleOptions> {
  const options = await fixture();
  const circuitJson = JSON.parse(
    await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
  ) as any[];
  const manufacturerParts: Record<string, string> = {
    R1: "RC0603FR-0710KL",
    D1: "LTST-C190KGKT",
    J1: "M20-9990245",
  };
  for (const element of circuitJson) {
    if (element.type === "source_component" && manufacturerParts[element.name] !== undefined) {
      element.manufacturer_part_number = manufacturerParts[element.name];
    }
  }
  const policyWithoutDigest = {
    name: "pcboo-recorded-sourcing",
    version: "1.0.0",
    maxAgeSeconds: 86_400,
    maxFutureSkewSeconds: 300,
    minimumStock: 100,
  };
  const selections: Record<string, unknown> = {};
  for (const pcb of circuitJson.filter(({ type }) => type === "pcb_component")) {
    if (pcb.do_not_place === true) continue;
    const source = circuitJson.find(({ type, source_component_id }) =>
      type === "source_component" && source_component_id === pcb.source_component_id
    );
    const cad = circuitJson.find(({ type, pcb_component_id }) =>
      type === "cad_component" && pcb_component_id === pcb.pcb_component_id
    );
    if (!source?.name || !cad?.footprinter_string) continue;
    const selection = {
      sourceComponentId: source.source_component_id,
      manufacturer: {
        name: source.name === "R1" ? "Yageo" : source.name === "D1" ? "Lite-On" : "Harwin",
        partNumber: source.manufacturer_part_number,
      },
      supplier: { name: "jlcpcb", partNumber: source.supplier_part_numbers.jlcpcb[0] },
      package: source.name === "J1" ? "2.54mm-pin-header-1x2" : "0603-imperial",
      footprint: cad.footprinter_string,
      snapshot: {
        schemaVersion: 1 as const,
        source: `recorded:https://example.invalid/jlcpcb/${source.supplier_part_numbers.jlcpcb[0]}`,
        retrievedAt: new Date(Date.now() - 60_000).toISOString(),
        lifecycle: "active" as const,
        stock: 10_000,
        price: { currency: "USD", unitPrice: 0.01, quantity: 100 },
      },
    };
    selections[source.name] = {
      ...selection,
      contentSha256: recordedSourcingSelectionContentSha256({
        designator: source.name,
        selection,
      }),
    };
  }
  const lockPath = join(options.projectRoot, "pcboo.lock");
  const lock = JSON.parse(await Bun.file(lockPath).text());
  lock.sourcing = {
    schemaVersion: 1,
    policy: {
      ...policyWithoutDigest,
      digest: recordedSourcingPolicyDigest(policyWithoutDigest),
    },
    selections,
  };
  await Bun.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await Bun.write(
    join(options.projectRoot, "src/board.tsx"),
    `export default ${canonicalCircuitJson(circuitJson).trim()}\n`,
  );
  await rm(options.artifactRoot, { recursive: true });
  const files = await exportManufacturingFiles({ boardName: "control", circuitJson });
  await emitDraftManufacturingDirectory({ targetDirectory: options.artifactRoot, files });
  await mkdir(join(options.artifactRoot, "evidence"), { recursive: true });
  await Bun.write(
    join(options.artifactRoot, "evidence/circuit.json"),
    canonicalCircuitJson(circuitJson),
  );
  const draftManifest = await createDraftArtifactManifest({
    root: options.artifactRoot,
    boardRevision: "A",
    artifactPaths: [...files.map(({ path }) => path), "evidence/circuit.json"],
    artifactKinds: productionArtifactKinds(files),
  });
  const inputSnapshot = await createBuildInputSnapshot({
    projectRoot: options.projectRoot,
    inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
  });
  return {
    ...options,
    draftManifest,
    inputSnapshot,
    manufacturingExpectation: deriveManufacturingExpectation({
      boardName: "control",
      circuitJson,
    }),
  };
}

async function replaceFixtureCircuit(
  options: PromoteProductionBundleOptions,
  circuitJson: any[],
): Promise<PromoteProductionBundleOptions> {
  await Bun.write(
    join(options.projectRoot, "src/board.tsx"),
    `export default ${canonicalCircuitJson(circuitJson).trim()}\n`,
  );
  await rm(options.artifactRoot, { recursive: true });
  const files = await exportManufacturingFiles({ boardName: "control", circuitJson });
  await emitDraftManufacturingDirectory({ targetDirectory: options.artifactRoot, files });
  await mkdir(join(options.artifactRoot, "evidence"), { recursive: true });
  await Bun.write(
    join(options.artifactRoot, "evidence/circuit.json"),
    canonicalCircuitJson(circuitJson),
  );
  const draftManifest = await createDraftArtifactManifest({
    root: options.artifactRoot,
    boardRevision: "A",
    artifactPaths: [...files.map(({ path }) => path), "evidence/circuit.json"],
    artifactKinds: productionArtifactKinds(files),
  });
  const inputSnapshot = await createBuildInputSnapshot({
    projectRoot: options.projectRoot,
    inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
  });
  return {
    ...options,
    draftManifest,
    inputSnapshot,
    manufacturingExpectation: deriveManufacturingExpectation({
      boardName: "control",
      circuitJson,
    }),
  };
}

async function fixtureWithCadAsset(options: {
  readonly redistribution: "allowed" | "prohibited" | "unknown";
  readonly license: string;
  readonly noticeText?: string;
  readonly attribution?: string;
  readonly copyrightHolder?: string;
}): Promise<PromoteProductionBundleOptions> {
  const base = await fixture();
  const bytes = "# third-party fixture model\nv 0 0 0\n";
  const source = "vendor/model.obj";
  await mkdir(join(base.projectRoot, "vendor"));
  await Bun.write(join(base.projectRoot, source), bytes);
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  const licenseNotice = options.noticeText ?? (options.license === "MIT"
    ? [
      "MIT License",
      "",
      `Copyright (c) 2026 ${options.copyrightHolder ?? "Example Model Author"}`,
      "",
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
      "",
      "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
      "",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
      "",
    ].join("\n")
    : options.license === "CC-BY-4.0"
      ? "Example Model Author\nCreative Commons Attribution 4.0 International\nhttps://creativecommons.org/licenses/by/4.0/\n"
      : `Example Model Author\nLicense evidence for ${options.license}\n`);
  const licenseNoticePath = "vendor/model.LICENSE.txt";
  await Bun.write(join(base.projectRoot, licenseNoticePath), licenseNotice);
  const licenseNoticeDigest = `sha256:${new Bun.CryptoHasher("sha256").update(licenseNotice).digest("hex")}`;
  const lockPath = join(base.projectRoot, "pcboo.lock");
  const lock = JSON.parse(await Bun.file(lockPath).text());
  lock.assets.enclosure = {
    source,
    version: "fixture-1",
    digest,
    license: options.license,
    attribution: options.attribution ?? "Example Model Author",
    licenseNotice: licenseNoticePath,
    licenseNoticeDigest,
    redistribution: options.redistribution,
  };
  await Bun.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const circuitJson = JSON.parse(
    await Bun.file(join(base.artifactRoot, "evidence/circuit.json")).text(),
  ) as any[];
  const cad = circuitJson.find(({ type }) => type === "cad_component");
  if (cad === undefined) throw new Error("fixture lacks cad_component");
  const dataUrl = `data:model/obj;base64,${Buffer.from(bytes).toString("base64")}`;
  cad.model_obj_url = dataUrl;
  cad.model_asset = { project_relative_path: source, url: dataUrl, mimetype: "model/obj" };
  const replaced = await replaceFixtureCircuit(base, circuitJson);
  const inputSnapshot = await createBuildInputSnapshot({
    projectRoot: replaced.projectRoot,
    inputs: [
      ...replaced.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
      { path: source, role: "vendored" as const },
      { path: licenseNoticePath, role: "vendored" as const },
    ],
  });
  return { ...replaced, inputSnapshot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("production bundle promotion", () => {
  test("blocks prohibited, unknown, unqualified, or unlocked CAD assets from verified redistribution", async () => {
    for (const attack of [
      { redistribution: "prohibited" as const, license: "LicenseRef-Proprietary-NoRedistribution", code: "ASSET_REDISTRIBUTION_PROHIBITED" as const },
      { redistribution: "unknown" as const, license: "LicenseRef-Unknown", code: "ASSET_REDISTRIBUTION_PROHIBITED" as const },
      { redistribution: "allowed" as const, license: "LicenseRef-Unreviewed", code: "ASSET_LICENSE_EVIDENCE_INVALID" as const },
    ]) {
      const attacked = await fixtureWithCadAsset(attack);
      const readiness = await assessProductionReadiness(attacked);
      expect(readiness.eligible, attack.code).toBeFalse();
      expect(readiness.findings.map(({ code }) => code), attack.code).toContain(attack.code);
      await expect(promoteProductionBundle(attacked)).rejects.toThrow(attack.code);
    }

    const placeholderNotice = await fixtureWithCadAsset({
      redistribution: "allowed",
      license: "MIT",
      noticeText: 'Copyright (c) 2026 Example Model Author\nPermission is hereby granted, free of charge\nTHE SOFTWARE IS PROVIDED "AS IS"\n',
    });
    const placeholderReadiness = await assessProductionReadiness(placeholderNotice);
    expect(placeholderReadiness.eligible).toBeFalse();
    expect(placeholderReadiness.findings.map(({ code }) => code))
      .toContain("ASSET_LICENSE_EVIDENCE_INVALID");

    const headingAsAttribution = await fixtureWithCadAsset({
      redistribution: "allowed",
      license: "MIT",
      attribution: "MIT License",
      copyrightHolder: "Completely Different Holder",
    });
    const headingReadiness = await assessProductionReadiness(headingAsAttribution);
    expect(headingReadiness.eligible).toBeFalse();
    expect(headingReadiness.findings.map(({ code }) => code))
      .toContain("ASSET_LICENSE_EVIDENCE_INVALID");

    const unlocked = await fixture();
    const circuitJson = JSON.parse(
      await Bun.file(join(unlocked.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const cad = circuitJson.find(({ type }) => type === "cad_component");
    cad.model_obj_url = `data:model/obj;base64,${Buffer.from("unlocked model").toString("base64")}`;
    const replaced = await replaceFixtureCircuit(unlocked, circuitJson);
    const readiness = await assessProductionReadiness(replaced);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("ASSET_LICENSE_EVIDENCE_INVALID");

    const mtlOnly = await fixture();
    const mtlCircuit = JSON.parse(
      await Bun.file(join(mtlOnly.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const mtlCad = mtlCircuit.find(({ type }) => type === "cad_component");
    mtlCad.model_mtl_url = `data:model/mtl;base64,${Buffer.from("restricted mtl").toString("base64")}`;
    const mtlReplaced = await replaceFixtureCircuit(mtlOnly, mtlCircuit);
    const mtlReadiness = await assessProductionReadiness(mtlReplaced);
    expect(mtlReadiness.eligible).toBeFalse();
    expect(mtlReadiness.findings.map(({ code }) => code)).toContain("ASSET_LICENSE_EVIDENCE_INVALID");

    const jscadOnly = await fixture();
    const jscadCircuit = JSON.parse(
      await Bun.file(join(jscadOnly.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const jscadCad = jscadCircuit.find(({ type }) => type === "cad_component");
    jscadCad.model_jscad = {
      type: "roundedCuboid",
      size: [10, 20, 10],
      roundRadius: 2,
      segments: 16,
      copyright_notice: "All rights reserved",
    };
    const jscadReplaced = await replaceFixtureCircuit(jscadOnly, jscadCircuit);
    const jscadReadiness = await assessProductionReadiness(jscadReplaced);
    expect(jscadReadiness.eligible).toBeFalse();
    expect(jscadReadiness.findings.map(({ code }) => code)).toContain("ASSET_LICENSE_EVIDENCE_INVALID");
  }, 90_000);

  test("blocks a vendored build input whose provenance is erased from compiled geometry", async () => {
    const options = await fixture();
    await mkdir(join(options.projectRoot, "vendor"), { recursive: true });
    await Bun.write(
      join(options.projectRoot, "vendor/third-party-footprint.ts"),
      "export const pads = [{ x: 0, y: 0 }];\n",
    );
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "vendor/third-party-footprint.ts", role: "vendored" as const },
      ],
    });

    const readiness = await assessProductionReadiness({ ...options, inputSnapshot });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual(expect.objectContaining({
      code: "ASSET_LICENSE_EVIDENCE_INVALID",
      message: expect.stringContaining("vendor/third-party-footprint.ts"),
    }));

    const misclassifiedSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "vendor/third-party-footprint.ts", role: "source" as const },
      ],
    });
    const misclassified = await assessProductionReadiness({
      ...options,
      inputSnapshot: misclassifiedSnapshot,
    });
    expect(misclassified.eligible).toBeFalse();
    expect(misclassified.findings).toContainEqual(expect.objectContaining({
      code: "ASSET_LICENSE_EVIDENCE_INVALID",
      message: expect.stringContaining(
        "vendor/third-party-footprint.ts must be classified as a vendored build input",
      ),
    }));
  }, 30_000);

  test("binds an allowed CAD asset's provenance and redistribution notice into the verified manifest", async () => {
    const options = await fixtureWithCadAsset({ redistribution: "allowed", license: "MIT" });
    const manifest = await promoteProductionBundle(options);
    expect(manifest.assetNotices).toEqual([expect.objectContaining({
      name: "enclosure",
      source: "vendor/model.obj",
      license: "MIT",
      attribution: "Example Model Author",
      redistribution: "allowed",
    })]);
    const destinationDirectory = join(await realpath(dirname(options.projectRoot)), "verified-with-asset");
    const published = await publishVerifiedProductionBundle({ ...options, destinationDirectory });
    const persisted = JSON.parse(await Bun.file(published.manifestPath).text());
    expect(persisted.assetNotices).toEqual(manifest.assetNotices);
    expect(manifest.assetNoticeArtifact).toEqual(expect.objectContaining({
      kind: "third-party-notices",
      path: "THIRD_PARTY_NOTICES.md",
    }));
    expect(persisted.assetNoticeArtifact).toEqual(manifest.assetNoticeArtifact);
    const notice = await Bun.file(join(published.root, "THIRD_PARTY_NOTICES.md")).text();
    expect(notice).toContain("Example Model Author");
    expect(notice).toContain("Permission is hereby granted, free of charge");
    expect(notice).toContain("The above copyright notice and this permission notice shall be included");
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(notice).toContain("IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE");
    expect(persisted.artifacts.some(({ path }: { path: string }) => path === "evidence/circuit.json"))
      .toBeTrue();
    expect(published.artifactCount).toBe(manifest.artifacts.length + 1);
  }, 60_000);

  test("revalidates the complete persisted bundle, generated notice, semantic types, and exact tree", async () => {
    const options = await fixtureWithCadAsset({ redistribution: "allowed", license: "MIT" });
    const destinationDirectory = join(await realpath(dirname(options.projectRoot)), "verified-revalidation");
    const published = await publishVerifiedProductionBundle({ ...options, destinationDirectory });
    const manifestPath = join(published.root, VERIFIED_BUNDLE_MANIFEST_FILENAME);
    const noticePath = join(published.root, "THIRD_PARTY_NOTICES.md");
    const manifestBytes = await Bun.file(manifestPath).bytes();
    const noticeBytes = await Bun.file(noticePath).bytes();
    const verifyPublished = (options: {
      readonly afterArtifactIntegrity?: () => void | Promise<void>;
    } = {}) => verifyPublishedProductionBundle(published.root, {
      expectedManifestSha256: published.manifestSha256,
      ...options,
    });

    expect(await verifyPublished()).toEqual(expect.objectContaining({
      integrityValid: true,
      manifestSha256: published.manifestSha256,
      artifactCount: published.artifactCount,
      findings: [],
    }));

    const wrongAuthority = await verifyPublishedProductionBundle(published.root, {
      expectedManifestSha256: "0".repeat(64),
    });
    expect(wrongAuthority.integrityValid).toBeFalse();
    expect(wrongAuthority.findings).toContainEqual(expect.objectContaining({
      code: "MANIFEST_DIGEST_MISMATCH",
    }));

    await rm(noticePath);
    const missingNotice = await verifyPublished();
    expect(missingNotice.integrityValid).toBeFalse();
    expect(missingNotice.findings).toContainEqual(expect.objectContaining({
      code: "ARTIFACT_INTEGRITY_FAILED",
      path: "THIRD_PARTY_NOTICES.md",
    }));
    await Bun.write(noticePath, noticeBytes);

    await Bun.write(join(published.root, "unmanifested.txt"), "not part of the publication\n");
    const extraFile = await verifyPublished();
    expect(extraFile.integrityValid).toBeFalse();
    expect(extraFile.findings).toContainEqual(expect.objectContaining({
      code: "BUNDLE_INVENTORY_MISMATCH",
    }));
    await rm(join(published.root, "unmanifested.txt"));

    const originalManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const racedArtifactPath = join(published.root, originalManifest.artifacts[0].path);
    const racedArtifactBytes = await Bun.file(racedArtifactPath).bytes();
    const racedArtifact = await verifyPublished({
      afterArtifactIntegrity: async () => {
        await chmod(racedArtifactPath, 0o644);
        await Bun.write(racedArtifactPath, "changed after the asynchronous integrity pass\n");
      },
    });
    expect(racedArtifact.integrityValid).toBeFalse();
    expect(racedArtifact.findings).toContainEqual(expect.objectContaining({
      code: "ARTIFACT_INTEGRITY_FAILED",
    }));
    await Bun.write(racedArtifactPath, racedArtifactBytes);

    const forged = JSON.parse(new TextDecoder().decode(manifestBytes));
    forged.artifacts[0].kind = "forged-artifact-type";
    await chmod(manifestPath, 0o644);
    await Bun.write(manifestPath, `${JSON.stringify(forged, null, 2)}\n`);
    const forgedType = await verifyPublished();
    expect(forgedType.integrityValid).toBeFalse();
    expect(forgedType.findings).toContainEqual(expect.objectContaining({
      code: "MANIFEST_INVALID",
      message: expect.stringContaining("expected"),
    }));

    await Bun.write(manifestPath, manifestBytes);
    const forgedLink = JSON.parse(new TextDecoder().decode(manifestBytes));
    delete forgedLink.assetNoticeArtifact;
    await Bun.write(manifestPath, `${JSON.stringify(forgedLink, null, 2)}\n`);
    const missingLink = await verifyPublished();
    expect(missingLink.integrityValid).toBeFalse();
    expect(missingLink.findings).toContainEqual(expect.objectContaining({
      code: "MANIFEST_INVALID",
      message: expect.stringContaining("assetNoticeArtifact is missing"),
    }));

    const amplifiedNotice = JSON.parse(new TextDecoder().decode(manifestBytes));
    amplifiedNotice.assetNotices[0].licenseNoticeText += "\n".repeat(256 * 1024 + 1);
    amplifiedNotice.assetNotices[0].licenseNoticeDigest =
      `sha256:${new Bun.CryptoHasher("sha256")
        .update(amplifiedNotice.assetNotices[0].licenseNoticeText)
        .digest("hex")}`;
    await Bun.write(manifestPath, `${JSON.stringify(amplifiedNotice, null, 2)}\n`);
    const boundedNotice = await verifyPublished();
    expect(boundedNotice.integrityValid).toBeFalse();
    expect(boundedNotice.findings).toEqual([
      expect.objectContaining({
        code: "MANIFEST_INVALID",
        message: expect.stringContaining("262144 UTF-8 bytes"),
      }),
    ]);

    for (const mutate of [
      (candidate: any) => { candidate.entityProvenance = []; },
      (candidate: any) => { candidate.entityProvenance[0].instancePath = ["group:forged", "component:forged"]; },
    ]) {
      const forgedHierarchy = JSON.parse(new TextDecoder().decode(manifestBytes));
      mutate(forgedHierarchy);
      await Bun.write(manifestPath, `${JSON.stringify(forgedHierarchy, null, 2)}\n`);
      const hierarchy = await verifyPublished();
      expect(hierarchy.integrityValid).toBeFalse();
      expect(hierarchy.findings).toContainEqual(expect.objectContaining({
        code: "ENTITY_PROVENANCE_INVALID",
        message: expect.stringContaining("does not exactly match"),
      }));
    }

    const forgedSourceLocation = JSON.parse(new TextDecoder().decode(manifestBytes));
    forgedSourceLocation.entityProvenance[0].origin = "authored";
    forgedSourceLocation.entityProvenance[0].sourceLocations = [
      "forged/not-source.ts:999:999",
    ];
    await Bun.write(manifestPath, `${JSON.stringify(forgedSourceLocation, null, 2)}\n`);
    const sourceAuthority = await verifyPublished();
    expect(sourceAuthority.integrityValid).toBeFalse();
    expect(sourceAuthority.findings).toContainEqual(expect.objectContaining({
      code: "MANIFEST_DIGEST_MISMATCH",
    }));

    const missingEntityProvenance = JSON.parse(new TextDecoder().decode(manifestBytes));
    delete missingEntityProvenance.entityProvenance;
    await Bun.write(manifestPath, `${JSON.stringify(missingEntityProvenance, null, 2)}\n`);
    const missingHierarchy = await verifyPublished();
    expect(missingHierarchy.integrityValid).toBeFalse();
    expect(missingHierarchy.findings).toEqual([
      expect.objectContaining({
        code: "MANIFEST_INVALID",
        message: expect.stringContaining("missing entityProvenance"),
      }),
    ]);
  }, 60_000);

  test("rejects hostile persisted-manifest bounds before inspecting the output tree", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.projectRoot)), "verified-bounds");
    const published = await publishVerifiedProductionBundle({ ...options, destinationDirectory });
    const manifestPath = join(published.root, VERIFIED_BUNDLE_MANIFEST_FILENAME);
    const valid = JSON.parse(await Bun.file(manifestPath).text());
    await chmod(manifestPath, 0o644);
    await Bun.write(join(published.root, "unexpected-before-preflight.txt"), "must not be traversed\n");

    const verifyInvalidManifestOnly = async (mutate: (manifest: any) => void) => {
      const candidate = structuredClone(valid);
      mutate(candidate);
      await Bun.write(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`);
      const verification = await verifyPublishedProductionBundle(published.root, {
        expectedManifestSha256: published.manifestSha256,
      });
      expect(verification.integrityValid).toBeFalse();
      expect(verification.findings).toEqual([
        expect.objectContaining({ code: "MANIFEST_INVALID" }),
      ]);
    };

    await verifyInvalidManifestOnly((candidate) => {
      candidate.artifacts = Array.from({ length: 129 }, (_, index) => ({
        kind: "gerber",
        path: `gerbers/bounded-${index}.gbr`,
        sha256: "0".repeat(64),
        size: 0,
      }));
    });
    await verifyInvalidManifestOnly((candidate) => {
      candidate.artifacts[0].path = `gerbers/${"x".repeat(4_090)}.gbr`;
    });
    await verifyInvalidManifestOnly((candidate) => {
      candidate.artifacts[0].path = "gerbers/a/b/c/d/e/f/g/h.gbr";
    });
    await verifyInvalidManifestOnly((candidate) => {
      candidate.artifacts[0].kind = "g".repeat(257);
    });
    await verifyInvalidManifestOnly((candidate) => {
      candidate.artifacts[0].size = 64 * 1024 * 1024 + 1;
    });
    await verifyInvalidManifestOnly((candidate) => {
      candidate.artifacts = Array.from({ length: 5 }, (_, index) => ({
        kind: "gerber",
        path: `gerbers/aggregate-${index}.gbr`,
        sha256: "0".repeat(64),
        size: 64 * 1024 * 1024,
      }));
    });
  }, 60_000);

  test("promotes captured authority for both baseline layer counts", async () => {
    for (const layerCount of [2, 4] as const) {
      const options = await fixture(layerCount);
      const manifest = await promoteProductionBundle(options);
      expect(manifest.lifecycle).toBe("verified");
      expect(manifest.capabilities.layerCount).toBe(layerCount);
      expect(manifest.inputSnapshot.digest).toBe(options.inputSnapshot.digest);
      expect(manifest.artifacts).toEqual(options.draftManifest.artifacts);
      expect(manifest.artifacts.every(({ kind }) => kind !== undefined)).toBeTrue();
      expect(manifest.artifacts.find(({ path }) => path === "evidence/circuit.json")?.kind)
        .toBe("compiled-circuit");
      const circuitJson = JSON.parse(
        await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
      ) as Record<string, unknown>[];
      const provenanceTypes = new Set([
        "source_component", "pcb_component", "pcb_smtpad", "pcb_plated_hole",
        "source_net", "source_trace", "pcb_trace", "pcb_via",
      ]);
      const expectedIds = circuitJson
        .filter(({ type }) => provenanceTypes.has(String(type)))
        .map((element) => String(element[`${String(element.type)}_id`]))
        .sort();
      expect(manifest.entityProvenance.map(({ elementId }) => elementId)).toEqual(expectedIds);
      expect(manifest.entityProvenance.every(({ instancePath }) => instancePath.length >= 2))
        .toBeTrue();
      expect(manifest.entityProvenance.some(({ kind }) => kind === "via")).toBeTrue();
    }
  }, 45_000);

  test("blocks production when manufactured entities lose their source-group hierarchy", async () => {
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const withoutGroups = circuitJson.filter(({ type }) => type !== "source_group");
    await Bun.write(
      join(options.projectRoot, "src/board.tsx"),
      `export default ${canonicalCircuitJson(withoutGroups).trim()}\n`,
    );
    const files = await exportManufacturingFiles({ boardName: "control", circuitJson: withoutGroups });
    await rm(options.artifactRoot, { recursive: true });
    await emitDraftManufacturingDirectory({ targetDirectory: options.artifactRoot, files });
    await mkdir(join(options.artifactRoot, "evidence"), { recursive: true });
    await Bun.write(
      join(options.artifactRoot, "evidence/circuit.json"),
      canonicalCircuitJson(withoutGroups),
    );
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    const draftManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: [...files.map(({ path }) => path), "evidence/circuit.json"],
      artifactKinds: productionArtifactKinds(files),
    });
    const readiness = await assessProductionReadiness({
      ...options,
      inputSnapshot,
      draftManifest,
      manufacturingExpectation: deriveManufacturingExpectation({
        boardName: "control",
        circuitJson: withoutGroups,
      }),
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual(expect.objectContaining({
      code: "ENTITY_PROVENANCE_INCOMPLETE",
      message: expect.stringContaining("source-group hierarchy"),
    }));
  }, 45_000);

  test("blocks production when direct and referenced manufactured ownership disagree", async () => {
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const rootGroup = circuitJson.find(({ type }) => type === "source_group");
    const pad = circuitJson.find(({ type }) => type === "pcb_smtpad");
    if (rootGroup === undefined || pad === undefined) throw new Error("fixture lacks ownership records");
    circuitJson.push({
      type: "source_group",
      source_group_id: "source_group_forged_child",
      subcircuit_id: "subcircuit_forged_child",
      parent_source_group_id: rootGroup.source_group_id,
      parent_subcircuit_id: rootGroup.subcircuit_id,
      name: "forged-child",
      is_subcircuit: true,
      was_automatically_named: false,
    });
    pad.subcircuit_id = "subcircuit_forged_child";
    const attacked = await replaceFixtureCircuit(options, circuitJson);
    const readiness = await assessProductionReadiness(attacked);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual(expect.objectContaining({
      code: "ENTITY_PROVENANCE_INCOMPLETE",
      message: expect.stringContaining("contradictory source-group ownership"),
    }));
    await expect(promoteProductionBundle(attacked)).rejects.toThrow(
      "ENTITY_PROVENANCE_INCOMPLETE",
    );
  }, 45_000);

  test("blocks same-group pad references that disagree about component ownership", async () => {
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const pad = circuitJson.find(({ type }) => type === "pcb_smtpad");
    const foreignPort = circuitJson.find(({ type, pcb_component_id }) =>
      type === "pcb_port" && pcb_component_id !== pad?.pcb_component_id
    );
    if (pad === undefined || foreignPort === undefined) {
      throw new Error("fixture lacks cross-component pad ownership records");
    }
    pad.pcb_port_id = foreignPort.pcb_port_id;
    const attacked = await replaceFixtureCircuit(options, circuitJson);
    const readiness = await assessProductionReadiness(attacked);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual(expect.objectContaining({
      code: "ENTITY_PROVENANCE_INCOMPLETE",
      message: expect.stringContaining("contradictory source_component ownership"),
    }));
    await expect(promoteProductionBundle(attacked)).rejects.toThrow(
      "ENTITY_PROVENANCE_INCOMPLETE",
    );
  }, 45_000);

  test("blocks same-component pad references that disagree about source-port ownership", async () => {
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const pad = circuitJson.find(({ type }) => type === "pcb_smtpad");
    const pcbPort = circuitJson.find(({ type, pcb_port_id }) =>
      type === "pcb_port" && pcb_port_id === pad?.pcb_port_id
    );
    const pcbComponent = circuitJson.find(({ type, pcb_component_id }) =>
      type === "pcb_component" && pcb_component_id === pad?.pcb_component_id
    );
    const alternatePort = circuitJson.find(({ type, source_component_id, source_port_id }) =>
      type === "source_port" && source_component_id === pcbComponent?.source_component_id &&
      source_port_id !== pcbPort?.source_port_id
    );
    if (pad === undefined || pcbPort === undefined || pcbComponent === undefined || alternatePort === undefined) {
      throw new Error("fixture lacks same-component alternate source-port ownership records");
    }
    pcbPort.source_port_id = alternatePort.source_port_id;
    const attacked = await replaceFixtureCircuit(options, circuitJson);
    const readiness = await assessProductionReadiness(attacked);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual(expect.objectContaining({
      code: "ENTITY_PROVENANCE_INCOMPLETE",
      message: expect.stringContaining("port hint"),
    }));
    await expect(promoteProductionBundle(attacked)).rejects.toThrow(
      "ENTITY_PROVENANCE_INCOMPLETE",
    );
  }, 45_000);

  test("publishes complete parent-subcircuit-only entity ancestry", async () => {
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const rootGroup = circuitJson.find(({ type }) => type === "source_group");
    const net = circuitJson.find(({ type }) => type === "source_net");
    if (rootGroup === undefined || net === undefined) throw new Error("fixture lacks hierarchy records");
    circuitJson.push({
      type: "source_group",
      source_group_id: "source_group_nested_net",
      subcircuit_id: "subcircuit_nested_net",
      parent_subcircuit_id: rootGroup.subcircuit_id,
      name: "nested-net-group",
      is_subcircuit: true,
      was_automatically_named: false,
    });
    net.subcircuit_id = "subcircuit_nested_net";
    const movedIds = new Set<string>([net.source_net_id]);
    const ownershipReferences = [
      "source_component_id", "source_trace_id", "source_port_id", "source_net_id",
      "pcb_component_id", "pcb_trace_id", "pcb_port_id",
    ];
    let movedAnother = true;
    while (movedAnother) {
      movedAnother = false;
      for (const element of circuitJson) {
        if (
          !ownershipReferences.some((key) => movedIds.has(String(element[key]))) ||
          element === net
        ) continue;
        if (element.subcircuit_id !== "subcircuit_nested_net") {
          element.subcircuit_id = "subcircuit_nested_net";
          movedAnother = true;
        }
        const id = element[`${element.type}_id`];
        if (typeof id === "string" && !movedIds.has(id)) {
          movedIds.add(id);
          movedAnother = true;
        }
      }
    }
    const nested = await replaceFixtureCircuit(options, circuitJson);
    const manifest = await promoteProductionBundle(nested);
    expect(manifest.entityProvenance.find(({ elementId }) => elementId === net.source_net_id))
      .toEqual(expect.objectContaining({
        instancePath: [
          `group:@${rootGroup.source_group_id}`,
          "group:nested-net-group",
          `net:${net.name}`,
          `record:${net.source_net_id}`,
        ],
      }));
    const destinationDirectory = join(await realpath(dirname(options.projectRoot)), "verified-parent-subcircuit");
    const published = await publishVerifiedProductionBundle({
      ...nested,
      destinationDirectory,
    });
    const verified = await verifyPublishedProductionBundle(published.root, {
      expectedManifestSha256: published.manifestSha256,
    });
    expect(verified.integrityValid).toBeTrue();
    expect(verified.findings).toEqual([]);
  }, 60_000);

  test("blocks a disconnected second source-group root at the production API", async () => {
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    circuitJson.push({
      type: "source_group",
      source_group_id: "source_group_detached",
      subcircuit_id: "subcircuit_detached",
      name: "detached",
      is_subcircuit: true,
      was_automatically_named: false,
    });
    const attacked = await replaceFixtureCircuit(options, circuitJson);
    const readiness = await assessProductionReadiness(attacked);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual(expect.objectContaining({
      code: "ENTITY_PROVENANCE_INCOMPLETE",
      message: expect.stringContaining(
        "source_group_detached is disconnected from source_board root source_group_0",
      ),
    }));
    await expect(promoteProductionBundle(attacked)).rejects.toThrow(
      "ENTITY_PROVENANCE_INCOMPLETE",
    );
  }, 45_000);

  test("rejects missing or caller-forged production artifact type labels", async () => {
    const options = await fixture(4);
    for (const artifactMutation of [
      (artifact: (typeof options.draftManifest.artifacts)[number]) => {
        const { kind: _omittedKind, ...untyped } = artifact;
        return untyped;
      },
      (artifact: (typeof options.draftManifest.artifacts)[number]) => ({
        ...artifact,
        kind: "cryptographic-signature",
      }),
    ]) {
      const draftManifest = {
        ...structuredClone(options.draftManifest),
        artifacts: options.draftManifest.artifacts.map(artifactMutation),
      };
      const readiness = await assessProductionReadiness({ ...options, draftManifest });
      expect(readiness.eligible).toBeFalse();
      expect(readiness.findings).toContainEqual({
        code: "ARTIFACT_INTEGRITY_FAILED",
        message: "Draft artifact manifest does not exactly cover and type the independently bounded manufacturing and Circuit JSON artifact set",
      });
      await expect(promoteProductionBundle({ ...options, draftManifest })).rejects.toThrow(
        /ARTIFACT_INTEGRITY_FAILED.*exactly cover and type/u,
      );
    }
  }, 30_000);

  test("rejects a rehashed draft whose embedded producer contradicts authenticated tools", async () => {
    const options = await fixture(2);
    for (const artifact of options.draftManifest.artifacts.filter(({ path }) =>
      path.endsWith(".gbr")
    )) {
      const path = join(options.artifactRoot, ...artifact.path.split("/"));
      await Bun.write(
        path,
        (await Bun.file(path).text()).replace(
          /^%TF\.GenerationSoftware,[^\n]+$/m,
          "%TF.GenerationSoftware,EvilCorp,fabricator,999*%",
        ),
      );
    }
    const rehashedManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: options.draftManifest.artifacts.map(({ path }) => path),
      artifactKinds: retainedArtifactKinds(options.draftManifest),
    });

    await expect(promoteProductionBundle({
      ...options,
      draftManifest: rehashedManifest,
    })).rejects.toThrow(/GERBER_STATE_UNSUPPORTED|FABRICATION_EVIDENCE_MISMATCH/u);
  });

  test("cannot promote rehashed macro-aperture copper omitted by geometric reconciliation", async () => {
    const options = await fixture(4);
    const relativePath = "gerbers/control-In1_Cu.gbr";
    const path = join(options.artifactRoot, ...relativePath.split("/"));
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
    const rehashedManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: options.draftManifest.artifacts.map(({ path }) => path),
      artifactKinds: retainedArtifactKinds(options.draftManifest),
    });

    await expect(promoteProductionBundle({
      ...options,
      draftManifest: rehashedManifest,
    })).rejects.toThrow(
      /MANUFACTURING_VERIFICATION_FAILED.*GERBER_STATE_UNSUPPORTED.*1 plotted operation\(s\)/u,
    );
  });

  test("cannot promote a rehashed unused zero-diameter drill tool", async () => {
    const options = await fixture(4);
    const relativePath = "drills/drill-L1-L4.drl";
    const path = join(options.artifactRoot, ...relativePath.split("/"));
    const declaration = [
      "; #@! TA.AperFunction,Plated,PTH,ComponentDrill",
      "T99C0",
    ].join("\n");
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace(
        "%\nG90",
        `${declaration}\n%\nG90`,
      ),
    );
    const rehashedManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: options.draftManifest.artifacts.map(({ path }) => path),
      artifactKinds: retainedArtifactKinds(options.draftManifest),
    });

    await expect(promoteProductionBundle({
      ...options,
      draftManifest: rehashedManifest,
    })).rejects.toThrow(
      /MANUFACTURING_VERIFICATION_FAILED.*DRILL_STATE_UNSUPPORTED.*strictly positive circular diameter/u,
    );
  });

  test("rejects a rehashed draft with contradictory embedded drill provenance", async () => {
    const options = await fixture(2);
    const drill = options.draftManifest.artifacts.find(({ path }) =>
      path === "drills/drill-L1-L2.drl"
    );
    if (drill === undefined) throw new Error("Fixture plated drill artifact missing");
    const drillPath = join(options.artifactRoot, ...drill.path.split("/"));
    await Bun.write(
      drillPath,
      (await Bun.file(drillPath).text()).replace(
        "; #@! TF.GenerationSoftware,tscircuit",
        "; #@! TF.GenerationSoftware,EvilCorp,fabricator,999",
      ),
    );
    const rehashedManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: options.draftManifest.artifacts.map(({ path }) => path),
      artifactKinds: retainedArtifactKinds(options.draftManifest),
    });
    await expect(promoteProductionBundle({
      ...options,
      draftManifest: rehashedManifest,
    })).rejects.toThrow(/DRILL_STATE_UNSUPPORTED|FABRICATION_EVIDENCE_MISMATCH/u);
  });

  test("requires every regular project file in production input authority", async () => {
    const options = await fixture(2);
    await Bun.write(
      join(options.projectRoot, "board-data.json"),
      "{\"boardWidthMm\":20}\n",
    );
    await expect(promoteProductionBundle(options)).rejects.toThrow(
      /BUILD_INPUT_INCOMPLETE.*board-data\.json/u,
    );
  });

  test("cannot verify a production bundle that silently drops an authored component", async () => {
    const options = await fixture(2);
    const circuitPath = join(options.artifactRoot, "evidence", "circuit.json");
    const circuitJson = JSON.parse(await Bun.file(circuitPath).text()) as AnyCircuitElement[];
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "D1",
    );
    if (source?.type !== "source_component") throw new Error("D1 source fixture missing");
    circuitJson.push({
      ...source,
      source_component_id: "source_component_orphan",
      name: "D_ORPHAN",
    });
    const attackedCircuit = canonicalCircuitJson(circuitJson);
    await Bun.write(circuitPath, attackedCircuit);
    await Bun.write(
      join(options.projectRoot, "src", "board.tsx"),
      `export default ${attackedCircuit.trim()}\n`,
    );
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    const draftManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: options.draftManifest.artifacts.map(({ path }) => path),
      artifactKinds: retainedArtifactKinds(options.draftManifest),
    });
    await expect(promoteProductionBundle({
      ...options,
      inputSnapshot,
      draftManifest,
      manufacturingExpectation: deriveManufacturingExpectation({
        boardName: "control",
        circuitJson,
      }),
    })).rejects.toThrow(/FAB_COMPONENT_MAPPING_001|MANUFACTURING_UNSUPPORTED|authored component resolves to 0/u);
  });

  test("cannot promote rehashed artifacts for an unqualified board substrate", async () => {
    const material = "fr1";
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const board = circuitJson.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
    board.material = material;
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);

    expect(attackedOptions.manufacturingExpectation.unsupported).toContainEqual(
      expect.stringContaining("outside the baseline manufacturing capability"),
    );
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code))
      .toContain("FABRICATION_EVIDENCE_MISMATCH");
    expect(readiness.findings.map(({ code }) => code))
      .toContain("MANUFACTURING_VERIFICATION_FAILED");
    await expect(promoteProductionBundle(attackedOptions)).rejects.toThrow(
      /FAB_BOARD_MATERIAL_001|MANUFACTURING_INPUT_LIMIT|Production promotion blocked/u,
    );
  });

  test("cannot promote an ambiguous populated supplier identity", async () => {
    const options = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "R1",
    );
    if (source?.type !== "source_component") throw new Error("R1 source fixture missing");
    source.supplier_part_numbers = {
      digikey: ["DKEY-123"],
      mouser: ["M-456"],
    };
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);
    expect(attackedOptions.manufacturingExpectation.unsupported).toContainEqual(
      expect.stringContaining("supplier identity cannot be represented unambiguously in one BOM row"),
    );
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("MANUFACTURING_VERIFICATION_FAILED");
    expect(readiness.findings.map(({ message }) => message).join("\n")).toContain(
      "MANUFACTURING_UNSUPPORTED",
    );
    await expect(promoteProductionBundle(attackedOptions)).rejects.toThrow(
      /MANUFACTURING_UNSUPPORTED|Production promotion blocked/u,
    );
  });

  test("cannot promote a BOM containing an unsafe manufacturer part identity", async () => {
    const options = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "R1",
    );
    if (source?.type !== "source_component") throw new Error("R1 source fixture missing");
    source.manufacturer_part_number = "MPN\0TRUNCATED";
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);
    expect(attackedOptions.manufacturingExpectation.unsupported).toContainEqual(
      expect.stringContaining("manufacturer part identity is not a conservative printable ASCII token"),
    );
    const bom = await Bun.file(join(attackedOptions.artifactRoot, "assembly/bom.csv")).text();
    expect(bom).not.toContain("\0");
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("MANUFACTURING_VERIFICATION_FAILED");
    await expect(promoteProductionBundle(attackedOptions)).rejects.toThrow(
      /MANUFACTURING_UNSUPPORTED|Production promotion blocked/u,
    );
  });

  test("cannot promote a formula-like manufactured designator", async () => {
    const options = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "R1",
    );
    if (source?.type !== "source_component") throw new Error("R1 source fixture missing");
    source.name = '=HYPERLINK("https://example.invalid","R1")';
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);
    expect(attackedOptions.manufacturingExpectation.unsupported).toContainEqual(
      expect.stringContaining("assembly designator must be a conservative ASCII reference"),
    );
    const assembly = [
      await Bun.file(join(attackedOptions.artifactRoot, "assembly/bom.csv")).text(),
      await Bun.file(join(attackedOptions.artifactRoot, "assembly/positions.csv")).text(),
    ].join("\n");
    expect(assembly).not.toContain("HYPERLINK");
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("MANUFACTURING_VERIFICATION_FAILED");
    await expect(promoteProductionBundle(attackedOptions)).rejects.toThrow(
      /MANUFACTURING_UNSUPPORTED|Production promotion blocked/u,
    );
  });

  test("cannot promote physical routing that violates authored trace constraints", async () => {
    const options = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const sourceTrace = circuitJson.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    if (sourceTrace?.type !== "source_trace") throw new Error("Fixture source trace missing");
    sourceTrace.min_trace_thickness = 1;
    sourceTrace.max_length = 1;
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("FABRICATION_EVIDENCE_MISMATCH");
    await expect(promoteProductionBundle(attackedOptions)).rejects.toThrow(
      /FABRICATION_EVIDENCE_MISMATCH|Production promotion blocked/u,
    );
  });

  test("cannot promote an unmeasurable maximum length through a displaced through-pad", async () => {
    const options = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const sourceTrace = circuitJson.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_0",
    );
    const pcbTrace = circuitJson.find(
      (element) => element.type === "pcb_trace" && element.pcb_trace_id === "source_net_0_0",
    );
    const holes = circuitJson.filter((element) => element.type === "pcb_plated_hole")
      .sort((left, right) => left.x - right.x);
    if (
      sourceTrace?.type !== "source_trace" ||
      pcbTrace?.type !== "pcb_trace" ||
      holes.length !== 2
    ) throw new Error("Fixture through-pad route authority missing");
    const start = holes[0]!;
    const end = holes[1]!;
    sourceTrace.max_length = 100;
    pcbTrace.route = [
      {
        route_type: "wire",
        x: start.x,
        y: start.y,
        width: 0.2,
        layer: "top",
        start_pcb_port_id: start.pcb_port_id,
      },
      {
        route_type: "through_pad",
        start: { x: start.x, y: start.y },
        end: { x: start.x + 0.7, y: start.y },
        width: 0.2,
        start_layer: "top",
        end_layer: "bottom",
        pcb_plated_hole_id: start.pcb_plated_hole_id,
      },
      {
        route_type: "wire",
        x: start.x + 0.7,
        y: start.y,
        width: 0.2,
        layer: "bottom",
      },
      {
        route_type: "wire",
        x: end.x,
        y: end.y,
        width: 0.2,
        layer: "bottom",
        end_pcb_port_id: end.pcb_port_id,
      },
    ];
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("FABRICATION_EVIDENCE_MISMATCH");
    await expect(promoteProductionBundle(attackedOptions)).rejects.toThrow(
      /FABRICATION_EVIDENCE_MISMATCH|Production promotion blocked/u,
    );
  });

  test("cannot promote an invalid supplier identity that is explicitly attached to DNP", async () => {
    const options = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const source = circuitJson.find(
      (element) => element.type === "source_component" && element.name === "D1",
    );
    const component = source?.type === "source_component"
      ? circuitJson.find((element) => element.type === "pcb_component" &&
        element.source_component_id === source.source_component_id)
      : undefined;
    if (source?.type !== "source_component" || component?.type !== "pcb_component") {
      throw new Error("D1 fixture assembly identity missing");
    }
    source.supplier_part_numbers = { jlcpcb: ["=DNP_FORMULA"] };
    component.do_not_place = true;
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);
    expect(attackedOptions.manufacturingExpectation.unsupported).toContainEqual(
      expect.stringContaining("DNP manufacturing component D1"),
    );
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("MANUFACTURING_VERIFICATION_FAILED");
    await expect(promoteProductionBundle(attackedOptions)).rejects.toThrow(
      /MANUFACTURING_UNSUPPORTED|Production promotion blocked/u,
    );
  });

  test("cannot verify physical component pins after their source-port authority disappears", async () => {
    const options = await fixture(4);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
    const removed = new Set(["source_port_1", "source_port_3"]);
    const attacked = circuitJson.filter((element) =>
      !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
      !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "source_port" && removed.has(element.source_port_id)) &&
      !(element.type === "schematic_port" && removed.has(element.source_port_id))
    );
    const attackedOptions = await replaceFixtureCircuit(options, attacked);
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "ELECTRICAL_EVIDENCE_MISMATCH",
      "FABRICATION_EVIDENCE_MISMATCH",
    ]));
  });

  test("cannot verify arbitrary ownerless SMT copper as a board primitive", async () => {
    const options = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    ) as AnyCircuitElement[];
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
    const attackedOptions = await replaceFixtureCircuit(options, circuitJson);
    const readiness = await assessProductionReadiness(attackedOptions);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "MANUFACTURING_VERIFICATION_FAILED",
      "FABRICATION_EVIDENCE_MISMATCH",
    ]));
  });

  test("reports a missing board revision on copper-adjacent silkscreen evidence", () => {
    expect(String(boardRevisionSilkscreenDiagnostic([], "A")?.id)).toBe(
      "FAB_BOARD_REVISION_SILKSCREEN_001",
    );
    for (const text of ["PCBoo control · REV A", "REVISION:A", "REV-A"]) {
      expect(boardRevisionSilkscreenDiagnostic([{
        type: "pcb_silkscreen_text",
        layer: "top",
        text,
      }], "A")).toBeUndefined();
    }
    for (const text of ["REVA", "REV A-OLD", "REV A.1", "REV AB", "VERSION A"]) {
      expect(String(boardRevisionSilkscreenDiagnostic([{
        type: "pcb_silkscreen_text",
        layer: "top",
        text,
      }], "A")?.id)).toBe("FAB_BOARD_REVISION_SILKSCREEN_001");
    }
    expect(String(boardRevisionSilkscreenDiagnostic([{
      type: "pcb_silkscreen_text",
      layer: "top",
      text: "REV A",
    }], "A.1")?.id)).toBe("FAB_BOARD_REVISION_SILKSCREEN_001");
    expect(boardRevisionSilkscreenDiagnostic([{
      type: "pcb_silkscreen_text",
      layer: "bottom",
      text: "board REV A.1, production",
    }], "A.1")).toBeUndefined();
  });

  test("binds the production revision to authenticated source-controlled design metadata", async () => {
    const missing = await replaceFixtureConfigRevision(await fixture());
    const missingReadiness = await assessProductionReadiness(missing);
    expect(missingReadiness.eligible).toBeFalse();
    expect(missingReadiness.findings).toContainEqual({
      code: "BOARD_REVISION_REQUIRED",
      message: "pcboo.config.ts must declare a source-controlled boardRevision for production promotion",
    });
    await expect(promoteProductionBundle(missing)).rejects.toThrow("BOARD_REVISION_REQUIRED");

    const { boardRevision: _omittedRevision, ...missingBothDraft } =
      structuredClone(missing.draftManifest);
    const missingBothReadiness = await assessProductionReadiness({
      ...missing,
      draftManifest: missingBothDraft,
    });
    expect(missingBothReadiness.findings.filter(
      ({ code }) => code === "BOARD_REVISION_REQUIRED",
    )).toHaveLength(1);

    const mismatched = await replaceFixtureConfigRevision(await fixture(), "B");
    const mismatchedReadiness = await assessProductionReadiness(mismatched);
    expect(mismatchedReadiness.eligible).toBeFalse();
    expect(mismatchedReadiness.findings).toContainEqual({
      code: "BOARD_REVISION_MISMATCH",
      message: "Draft manifest board revision does not match authenticated pcboo.config.ts design metadata",
    });
    await expect(promoteProductionBundle(mismatched)).rejects.toThrow("BOARD_REVISION_MISMATCH");
  });

  test("is the only API that creates a verified, explicitly unsigned manifest", async () => {
    const options = await fixture();
    expect(options.draftManifest.lifecycle).toBe("draft");

    const manifest = await promoteProductionBundle(options);

    expect(manifest.lifecycle).toBe("verified");
    expect(manifest.boardRevision).toBe("A");
    expect(manifest.evaluationDate).toBe(new Date().toISOString().slice(0, 10));
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
    expect(manifest.sourceControl).toEqual({
      state: "not-assessed",
      reason: "Promotion binds complete project input bytes; Git revision and dirty-tree state were not invoked",
    });
    const pcbooPackage = await Bun.file(join(import.meta.dir, "../package.json")).json() as {
      version: string;
    };
    expect(manifest.toolVersions).toEqual({
      pcboo: pcbooPackage.version,
      bun: "1.3.14",
    });
    expect(manifest.cryptographicSignature).toBe("absent");
    expect(manifest.inputSnapshot.digest).toBe(options.inputSnapshot.digest);
    expect(manifest.requiredDimensions).toEqual(["fabrication", "electrical"]);
    expect(manifest.adapterVersions.independentParser).toBe("gerber-parser@4.2.7");
    expect(manifest.activeProfiles).toEqual([{
      name: BASELINE_FABRICATION_PROFILE.name,
      version: BASELINE_FABRICATION_PROFILE.version,
      digest: BASELINE_FABRICATION_PROFILE.digest,
    }]);
    expect(manifest.tscircuit).toEqual({
      version: SUPPORTED_TSCIRCUIT_VERSION,
      integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
      contentSha256: EXPECTED_TSCIRCUIT_CONTENT_SHA256,
      runtimeClosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(manifest.manufacturingPackages.independentParser).toEqual({
      package: "gerber-parser",
      version: "4.2.7",
      contentSha256: "7a7fa9ec1f2649ed8c13ee184dd73b523c8a2bdb507a533e692d7e167c2de9a6",
    });
    expect(manifest.runtimeEvidencePackages.circuitJsonSchema).toEqual({
      package: "circuit-json",
      version: "0.0.464",
      contentSha256: "89da172be71b44d541f1f31798c284be574778cbd3b34bf6d9a3f74334b2a00f",
    });
    expect(manifest.externalToolVersions).toEqual({});
    expect(manifest.capabilities).toMatchObject({
      boardCount: 1,
      layerCount: 4,
      viaTechnology: "through-via",
      independentParser: "gerber-parser@4.2.7",
    });
    expect(manifest.knownGaps).toEqual(BASELINE_FABRICATION_PROFILE.knownGaps);
    expect(manifest.diagnostics.map(({ id }) => String(id))).toEqual([
      "FAB_BOARD_REVISION_SILKSCREEN_001",
    ]);
  });

  test("does not persist caller-authored status prose or observation timestamps as verified evidence", async () => {
    const options = await fixture();
    const statuses = statusSet({
      fabrication: assuranceStatus("fabrication", "passed", {
        summary: "Legally certified fabrication by caller",
      }),
      electrical: assuranceStatus("electrical", "passed", {
        summary: "All simulations passed according to caller",
      }),
      functional: assuranceStatus("functional", "not-run", {
        summary: "Functional qualification secretly passed",
      }),
      standards: assuranceStatus("standards", "not-run", {
        summary: "Internationally certified by caller",
      }),
      sourcing: sourcingStatus("unchecked", {
        summary: "Live stock verified by caller",
        checkedAt: "2099-01-01T00:00:00.000Z",
      }),
    });

    const manifest = await promoteProductionBundle({ ...options, statuses });
    expect(manifest.statuses.fabrication.summary).not.toContain("caller");
    expect(manifest.statuses.electrical.summary).not.toContain("caller");
    expect(manifest.statuses.functional.summary).toBeUndefined();
    expect(manifest.statuses.standards.summary).toBeUndefined();
    expect(manifest.statuses.sourcing.summary).toBeUndefined();
    expect(manifest.statuses.sourcing.checkedAt).toBeUndefined();
  });

  test("cannot promote a design whose whole connection was deleted or whose net keys hide a short", async () => {
    const deletedBase = await fixture();
    const deletedCircuit = JSON.parse(
      await Bun.file(join(deletedBase.artifactRoot, "evidence/circuit.json")).text(),
    ).filter(
      (element: any) =>
        !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
        !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
        !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0"),
    );
    const deleted = await replaceFixtureCircuit(deletedBase, deletedCircuit);
    const deletedReadiness = await assessProductionReadiness(deleted);
    expect(deletedReadiness.eligible).toBeFalse();
    expect(deletedReadiness.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["ELECTRICAL_EVIDENCE_MISMATCH", "FABRICATION_EVIDENCE_MISMATCH"]),
    );

    const collisionBase = await fixture();
    const collided = JSON.parse(
      await Bun.file(join(collisionBase.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const physical = collided.find(
      (element) => element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0",
    );
    const attackedPoint = physical?.route?.find(
      (point: any) => point.route_type === "wire" && point.layer === "bottom" &&
        point.x === 0 && point.y === 1.175,
    );
    const left = collided.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    const right = collided.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_3",
    );
    if (attackedPoint === undefined || left === undefined || right === undefined) {
      throw new Error("Production connectivity attack fixture is incomplete");
    }
    attackedPoint.x = 6;
    attackedPoint.y = 6;
    const collidedKey = left.subcircuit_connectivity_map_key;
    right.subcircuit_connectivity_map_key = collidedKey;
    for (const element of collided) {
      if (element.type === "source_port" && right.connected_source_port_ids.includes(element.source_port_id)) {
        element.subcircuit_connectivity_map_key = collidedKey;
      }
      if (element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_1") {
        element.subcircuit_connectivity_map_key = collidedKey;
      }
    }
    const collision = await replaceFixtureCircuit(collisionBase, collided);
    const collisionReadiness = await assessProductionReadiness(collision);
    expect(collisionReadiness.eligible).toBeFalse();
    expect(collisionReadiness.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["ELECTRICAL_EVIDENCE_MISMATCH", "FABRICATION_EVIDENCE_MISMATCH"]),
    );

    const namedNetBase = await fixture();
    const namedNetCircuit = JSON.parse(
      await Bun.file(join(namedNetBase.artifactRoot, "evidence/circuit.json")).text(),
    ) as any[];
    const existingNet = namedNetCircuit.find((element) => element.type === "source_net");
    const existingTrace = namedNetCircuit.find((element) => element.type === "source_trace");
    if (existingNet === undefined || existingTrace === undefined) {
      throw new Error("Production named-net attack fixture is incomplete");
    }
    namedNetCircuit.push(
      {
        ...existingNet,
        source_net_id: "source_net_alias_attack_a",
        name: "ALIAS_ATTACK_A",
        is_ground: false,
        subcircuit_connectivity_map_key: "alias-attack-key-a",
      },
      {
        ...existingNet,
        source_net_id: "source_net_alias_attack_b",
        name: "ALIAS_ATTACK_B",
        is_ground: false,
        subcircuit_connectivity_map_key: "alias-attack-key-b",
      },
      {
        ...existingTrace,
        source_trace_id: "source_trace_alias_attack",
        connected_source_port_ids: [],
        connected_source_net_ids: ["source_net_alias_attack_a", "source_net_alias_attack_b"],
        name: "ALIAS_ATTACK_BRIDGE",
        display_name: "two distinct named nets",
        subcircuit_connectivity_map_key: "alias-attack-bridge-key",
      },
    );
    const namedNetAttack = await replaceFixtureCircuit(namedNetBase, namedNetCircuit);
    const namedNetReadiness = await assessProductionReadiness(namedNetAttack);
    expect(namedNetReadiness.eligible).toBeFalse();
    expect(namedNetReadiness.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["ELECTRICAL_EVIDENCE_MISMATCH", "FABRICATION_EVIDENCE_MISMATCH"]),
    );
  }, 60_000);

  test("publishes a persisted verified directory with the manifest as the validity boundary", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "production-rev-A");
    let validityTokenIdentity: { device: number; inode: number } | undefined;
    const published = await publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeValidityCommit: async () => {
        const tokenPath = join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER);
        const token = JSON.parse(await Bun.file(tokenPath).text());
        expect(token.lifecycle).toBe("verified");
        const stat = await lstat(tokenPath);
        validityTokenIdentity = { device: stat.dev, inode: stat.ino };
        expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists()).toBeFalse();
      },
    });
    expect(published.root).toBe(destinationDirectory);
    expect(published.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists()).toBeFalse();
    const persisted = JSON.parse(
      await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).text(),
    );
    if (validityTokenIdentity === undefined) throw new Error("validity token hook did not run");
    const finalManifestStat = await lstat(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME));
    expect({ device: finalManifestStat.dev, inode: finalManifestStat.ino }).toEqual(validityTokenIdentity);
    expect(persisted).toMatchObject({
      lifecycle: "verified",
      boardRevision: "A",
      cryptographicSignature: "absent",
    });
    expect(persisted.artifacts).toHaveLength(published.artifactCount);
    for (const artifact of persisted.artifacts as Array<{ path: string; sha256: string; size: number }>) {
      const bytes = await Bun.file(join(destinationDirectory, ...artifact.path.split("/"))).arrayBuffer();
      expect(bytes.byteLength).toBe(artifact.size);
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
  }, 30_000);

  test("refuses stale publication and preserves a concurrently claimed destination", async () => {
    const stale = await fixture();
    const staleDestination = join(await realpath(dirname(stale.artifactRoot)), "stale-production");
    await expect(publishVerifiedProductionBundle({
      ...stale,
      destinationDirectory: staleDestination,
      beforeCommit: async () => {
        await Bun.write(join(stale.artifactRoot, "assembly/bom.csv"), "changed during publication\n");
      },
    })).rejects.toThrow("ARTIFACT_INTEGRITY_FAILED");
    expect(await Bun.file(staleDestination).exists()).toBeFalse();

    const raced = await fixture();
    const racedDestination = join(await realpath(dirname(raced.artifactRoot)), "claimed-production");
    await expect(publishVerifiedProductionBundle({
      ...raced,
      destinationDirectory: racedDestination,
      beforeCommit: async () => {
        await mkdir(racedDestination);
        await Bun.write(join(racedDestination, "owned-by-user.txt"), "preserve me\n");
      },
    })).rejects.toThrow();
    expect(await Bun.file(join(racedDestination, "owned-by-user.txt")).text()).toBe("preserve me\n");
  }, 45_000);

  test("rejects unmanifested staging content instead of publishing arbitrary extras", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "extra-attack");
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeCommit: async () => {
        const parent = dirname(destinationDirectory);
        const prefix = `.${basename(destinationDirectory)}.pcboo-`;
        const stagingName = (await readdir(parent)).find((name) =>
          name.startsWith(prefix) && name.endsWith(".tmp")
        );
        if (stagingName === undefined) throw new Error("test could not locate staging directory");
        await Bun.write(join(parent, stagingName, "extra-unmanifested.gbr"), "attacker bytes\n");
      },
    })).rejects.toThrow("exact inventory");
    expect(await Bun.file(destinationDirectory).exists()).toBeFalse();
  }, 30_000);

  test("rejects an overbroad unexpected staging subtree before descending into it", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "broad-tree-attack");
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeCommit: async () => {
        const parent = dirname(destinationDirectory);
        const prefix = `.${basename(destinationDirectory)}.pcboo-`;
        const stagingName = (await readdir(parent)).find((name) =>
          name.startsWith(prefix) && name.endsWith(".tmp")
        );
        if (stagingName === undefined) throw new Error("test could not locate staging directory");
        const unexpected = join(parent, stagingName, "unexpected-tree");
        await mkdir(unexpected);
        for (let start = 0; start < 1_024; start += 128) {
          await Promise.all(Array.from(
            { length: 128 },
            (_, offset) => mkdir(join(unexpected, `empty-${start + offset}`)),
          ));
        }
      },
    })).rejects.toThrow("exact inventory");
    expect(await Bun.file(destinationDirectory).exists()).toBeFalse();
  }, 30_000);

  test("rejects an expected staging directory replaced by a symlink without following it", async () => {
    const options = await fixture();
    const publicationParent = await realpath(dirname(options.artifactRoot));
    const destinationDirectory = join(publicationParent, "staging-symlink-attack");
    const outsideAssembly = join(publicationParent, "outside-staging-assembly");
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeCommit: async () => {
        const prefix = `.${basename(destinationDirectory)}.pcboo-`;
        const stagingName = (await readdir(publicationParent)).find((name) =>
          name.startsWith(prefix) && name.endsWith(".tmp")
        );
        if (stagingName === undefined) throw new Error("test could not locate staging directory");
        const assembly = join(publicationParent, stagingName, "assembly");
        await rename(assembly, outsideAssembly);
        await symlink(
          outsideAssembly,
          assembly,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    })).rejects.toThrow("symlink");
    expect(await Bun.file(join(outsideAssembly, "bom.csv")).exists()).toBeTrue();
    expect(await Bun.file(destinationDirectory).exists()).toBeFalse();
  }, 30_000);

  test("rejects destination ancestor replacement after initial validation", async () => {
    const options = await fixture();
    const publicationParent = await realpath(dirname(options.artifactRoot));
    const destinationDirectory = join(publicationParent, "ancestor-attack");
    const movedParent = join(dirname(publicationParent), `${basename(publicationParent)}-moved`);
    const victimParent = join(dirname(publicationParent), `${basename(publicationParent)}-victim`);
    let victimPath = "";
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeCommit: async () => {
        const stagingName = (await readdir(publicationParent)).find((name) =>
          name.startsWith(".ancestor-attack.pcboo-") && name.endsWith(".tmp")
        );
        if (stagingName === undefined) throw new Error("test could not locate staging directory");
        await rename(publicationParent, movedParent);
        victimPath = join(victimParent, stagingName, "valuable.txt");
        await mkdir(dirname(victimPath), { recursive: true });
        await Bun.write(victimPath, "must survive rejected cleanup\n");
        await symlink(victimParent, publicationParent, process.platform === "win32" ? "junction" : undefined);
      },
    })).rejects.toThrow("destination authority changed");
    expect(await Bun.file(join(movedParent, "ancestor-attack")).exists()).toBeFalse();
    expect(await Bun.file(victimPath).text()).toBe("must survive rejected cleanup\n");
  }, 30_000);

  test("keeps the incomplete boundary when a committed artifact changes", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "target-mutation");
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeValidityCommit: async () => {
        expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists()).toBeTrue();
        expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists()).toBeFalse();
        await Bun.write(join(destinationDirectory, "assembly", "bom.csv"), "changed in target\n");
      },
    })).rejects.toThrow("ARTIFACT_INTEGRITY_FAILED");
    expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists()).toBeTrue();
    expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists()).toBeFalse();
  }, 30_000);

  test("keeps the incomplete boundary when publication is cancelled before validity commit", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "target-cancelled");
    const controller = new AbortController();
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      signal: controller.signal,
      beforeValidityCommit: async () => {
        controller.abort();
      },
    })).rejects.toThrow("cancelled");
    expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists())
      .toBeTrue();
    expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists())
      .toBeFalse();
  }, 30_000);

  test("rejects a committed artifact inode swap after synchronous hashing", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "target-final-inode-swap");
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      afterSynchronousRecordedFiles: () => {
        const artifact = join(destinationDirectory, "assembly", "bom.csv");
        const replacement = join(destinationDirectory, "assembly", ".bom-replacement.csv");
        writeFileSync(replacement, readFileSync(artifact));
        renameSync(replacement, artifact);
      },
    })).rejects.toThrow("recorded file identity changed");
    expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists())
      .toBeTrue();
    expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists())
      .toBeFalse();
  }, 30_000);

  test("rejects plain-directory replacement of the created target even with identical owned entries", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "target-identity-attack");
    const movedTarget = `${destinationDirectory}-moved`;
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeValidityCommit: async () => {
        await rename(destinationDirectory, movedTarget);
        await mkdir(destinationDirectory);
        for (const entry of await readdir(movedTarget)) {
          await rename(join(movedTarget, entry), join(destinationDirectory, entry));
        }
      },
    })).rejects.toThrow("target directory identity changed");
    expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists()).toBeTrue();
    expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists()).toBeFalse();
  }, 30_000);

  test("rejects validity-token inode substitution even when replacement bytes are identical", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "token-identity-attack");
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeValidityCommit: async () => {
        const token = join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER);
        const bytes = await Bun.file(token).bytes();
        await rm(token);
        await Bun.write(token, bytes);
      },
    })).rejects.toThrow("verified manifest changed");
    expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists()).toBeTrue();
    expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists()).toBeFalse();
  }, 30_000);

  test("retains incomplete output and unrelated bytes when staging cleanup loses identity", async () => {
    const options = await fixture();
    const destinationDirectory = join(await realpath(dirname(options.artifactRoot)), "cleanup-identity");
    let replacementStaging = "";
    await expect(publishVerifiedProductionBundle({
      ...options,
      destinationDirectory,
      beforeStagingCleanup: async () => {
        const parent = dirname(destinationDirectory);
        const stagingName = (await readdir(parent)).find((name) =>
          name.startsWith(".cleanup-identity.pcboo-") && name.endsWith(".tmp") &&
          !name.includes("manifest")
        );
        if (stagingName === undefined) throw new Error("test could not locate staging directory");
        const staging = join(parent, stagingName);
        await rename(staging, `${staging}-moved`);
        await mkdir(staging);
        replacementStaging = join(staging, "valuable.txt");
        await Bun.write(replacementStaging, "must not be recursively deleted\n");
      },
    })).rejects.toThrow("recovery retained");
    expect(await Bun.file(replacementStaging).text()).toBe("must not be recursively deleted\n");
    expect(await Bun.file(join(destinationDirectory, INCOMPLETE_VERIFIED_BUNDLE_MARKER)).exists()).toBeTrue();
    expect(await Bun.file(join(destinationDirectory, VERIFIED_BUNDLE_MANIFEST_FILENAME)).exists()).toBeFalse();
  }, 30_000);

  test("cannot replace input-snapshot or draft-manifest authority during publication", async () => {
    const sourceAttack = await fixture();
    const sourceDestination = join(await realpath(dirname(sourceAttack.artifactRoot)), "source-authority-attack");
    const sourceRequest: any = { ...sourceAttack, destinationDirectory: sourceDestination };
    sourceRequest.beforeCommit = async () => {
      const sourcePath = join(sourceAttack.projectRoot, "src/board.tsx");
      await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}\n// concurrent source revision\n`);
      sourceRequest.inputSnapshot = await createBuildInputSnapshot({
        projectRoot: sourceAttack.projectRoot,
        inputs: sourceAttack.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
      });
    };
    await expect(publishVerifiedProductionBundle(sourceRequest)).rejects.toThrow("BUILD_INPUT_STALE");
    expect(await Bun.file(sourceDestination).exists()).toBeFalse();

    const artifactAttack = await fixture();
    const artifactDestination = join(await realpath(dirname(artifactAttack.artifactRoot)), "artifact-authority-attack");
    const artifactRequest: any = { ...artifactAttack, destinationDirectory: artifactDestination };
    artifactRequest.beforeCommit = async () => {
      await Bun.write(join(artifactAttack.artifactRoot, "assembly/bom.csv"), "replacement artifact bytes\n");
      artifactRequest.draftManifest = await createDraftArtifactManifest({
        root: artifactAttack.artifactRoot,
        boardRevision: "A",
        artifactPaths: artifactAttack.draftManifest.artifacts.map(({ path }) => path),
      });
    };
    await expect(publishVerifiedProductionBundle(artifactRequest)).rejects.toThrow("ARTIFACT_INTEGRITY_FAILED");
    expect(await Bun.file(artifactDestination).exists()).toBeFalse();
  }, 60_000);

  test("promotion uses one frozen authority epoch despite nested caller mutation", async () => {
    const options = await fixture();
    const mutable: any = {
      ...options,
      draftManifest: structuredClone(options.draftManifest),
      inputSnapshot: structuredClone(options.inputSnapshot),
      manufacturingExpectation: structuredClone(options.manufacturingExpectation),
      statuses: structuredClone(options.statuses),
    };
    const originalFirstArtifact = structuredClone(mutable.draftManifest.artifacts[0]);
    const pending = promoteProductionBundle(mutable);
    mutable.draftManifest.boardRevision = "FORGED";
    mutable.draftManifest.artifacts[0].sha256 = "0".repeat(64);
    mutable.inputSnapshot.inputs[0].sha256 = "1".repeat(64);
    mutable.manufacturingExpectation.layerCount = 2;
    mutable.statuses.electrical.state = "failed";
    const manifest = await pending;
    expect(manifest.boardRevision).toBe("A");
    expect(manifest.artifacts[0]).toEqual(originalFirstArtifact);
    expect(manifest.inputSnapshot.digest).toBe(options.inputSnapshot.digest);
    expect(manifest.capabilities.layerCount).toBe(4);
    expect(manifest.statuses.electrical.state).toBe("passed");
  }, 30_000);

  test("reduces required and optional accessors once and rejects proxy authority before verification", async () => {
    const options = await fixture();
    let manifestReads = 0;
    let diagnosticReads = 0;
    let requiredDimensionReads = 0;
    let externalToolReads = 0;
    const accessorRequest: any = { ...options };
    Object.defineProperty(accessorRequest, "draftManifest", {
      enumerable: true,
      get() {
        manifestReads += 1;
        return manifestReads === 1
          ? options.draftManifest
          : { ...options.draftManifest, boardRevision: "FORGED" };
      },
    });
    Object.defineProperty(accessorRequest, "diagnostics", {
      enumerable: true,
      get() {
        diagnosticReads += 1;
        return diagnosticReads === 1 ? undefined : [{ forged: true }];
      },
    });
    Object.defineProperty(accessorRequest, "additionallyRequiredDimensions", {
      enumerable: true,
      get() {
        requiredDimensionReads += 1;
        return requiredDimensionReads === 1 ? undefined : ["functional"];
      },
    });
    Object.defineProperty(accessorRequest, "externalToolVersions", {
      enumerable: true,
      get() {
        externalToolReads += 1;
        return externalToolReads === 1 ? undefined : { forged: "1" };
      },
    });
    const manifest = await promoteProductionBundle(accessorRequest);
    expect(manifestReads).toBe(1);
    expect(diagnosticReads).toBe(1);
    expect(requiredDimensionReads).toBe(1);
    expect(externalToolReads).toBe(1);
    expect(manifest.boardRevision).toBe("A");

    const proxyManifest = new Proxy(structuredClone(options.draftManifest), {});
    await expect(promoteProductionBundle({ ...options, draftManifest: proxyManifest }))
      .rejects.toThrow("structured-cloneable plain data");
  }, 30_000);

  test("blocks production promotion when no immutable fabrication profile is active", async () => {
    const options = await fixture();
    await Bun.write(
      join(options.projectRoot, "pcboo.config.ts"),
      "export default { entry: 'src/board.tsx', profiles: [] }\n",
    );
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    const readiness = await assessProductionReadiness({ ...options, inputSnapshot });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "FABRICATION_PROFILE_REQUIRED",
    );
  });

  test("blocks a duplicate project engine even when it claims the supported version", async () => {
    const options = await fixture();
    const enginePath = join(options.projectRoot, "node_modules/tscircuit");
    await rm(enginePath);
    await mkdir(enginePath, { recursive: true });
    await Bun.write(
      join(enginePath, "package.json"),
      JSON.stringify({ name: "tscircuit", version: SUPPORTED_TSCIRCUIT_VERSION, type: "module", main: "index.js" }),
    );
    await Bun.write(join(enginePath, "index.js"), "export class Circuit {}\n");
    const readiness = await assessProductionReadiness(options);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "TSCIRCUIT_IDENTITY_INVALID",
    );
  });

  test("requires every transitive local circuit module in the build-input snapshot", async () => {
    const options = await fixture();
    const boardPath = join(options.projectRoot, "src/board.tsx");
    await Bun.write(join(options.projectRoot, "src/helper.ts"), "export const provenance = 'tracked'\n");
    await Bun.write(
      boardPath,
      `import './helper.ts'\n${await Bun.file(boardPath).text()}`,
    );
    const incompleteSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    const readiness = await assessProductionReadiness({
      ...options,
      inputSnapshot: incompleteSnapshot,
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("BUILD_INPUT_INCOMPLETE");
  });

  test("requires every transitive config module in the build-input snapshot", async () => {
    const options = await fixture();
    await Bun.write(
      join(options.projectRoot, "profile-name.ts"),
      `export const profileName = '${BASELINE_FABRICATION_PROFILE.name}'\n`,
    );
    await Bun.write(
      join(options.projectRoot, "pcboo.config.ts"),
      "import { profileName } from './profile-name.ts'\nexport default { entry: 'src/board.tsx', profiles: [profileName] }\n",
    );
    const incompleteSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    const readiness = await assessProductionReadiness({ ...options, inputSnapshot: incompleteSnapshot });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("BUILD_INPUT_INCOMPLETE");
    expect(readiness.findings.map(({ message }) => message).join("\n")).toContain(
      "profile-name.ts",
    );
  });

  test("requires ordinary test files to retain distinct test authority", async () => {
    const options = await fixture();
    await mkdir(join(options.projectRoot, "tests"));
    await Bun.write(
      join(options.projectRoot, "tests/board.test.ts"),
      'import { test } from "bun:test"; test("board", () => {});\n',
    );
    const mislabeled = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "tests/board.test.ts", role: "source" as const },
      ],
    });
    const readiness = await assessProductionReadiness({ ...options, inputSnapshot: mislabeled });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "BUILD_INPUT_INCOMPLETE",
      message: "Build input snapshot misclassifies test authority: tests/board.test.ts",
    });

    const correctlyLabeled = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "tests/board.test.ts", role: "test" as const },
      ],
    });
    expect((await promoteProductionBundle({ ...options, inputSnapshot: correctlyLabeled }))
      .inputSnapshot.inputs).toContainEqual(expect.objectContaining({
        path: "tests/board.test.ts",
        role: "test",
      }));
  });

  test("rejects caller-asserted external tool versions without adapter evidence", async () => {
    const options = await fixture();
    const readiness = await assessProductionReadiness({
      ...options,
      externalToolVersions: { kicad: "99.0-certified" },
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "EXTERNAL_TOOL_EVIDENCE_INVALID",
    );
  });

  test("blocks a false status pass when actual manufacturing artifacts fail", async () => {
    const options = await fixture();
    await rm(join(options.artifactRoot, "gerbers/control-In1_Cu.gbr"));

    const readiness = await assessProductionReadiness(options);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "MANUFACTURING_VERIFICATION_FAILED",
    );
    expect(promoteProductionBundle(options)).rejects.toThrow(
      "MANUFACTURING_VERIFICATION_FAILED",
    );
  });

  test("cannot promote a manufactured component with a temporary compiler name", async () => {
    const base = await fixture(2);
    const circuitJson = JSON.parse(
      await Bun.file(join(base.artifactRoot, "evidence/circuit.json")).text(),
    );
    const source = circuitJson.find(
      (element: any) => element.type === "source_component" && element.name === "D1",
    );
    if (source === undefined) throw new Error("D1 source fixture missing");
    source.name = "unnamed_led1";
    const options = await replaceFixtureCircuit(base, circuitJson);

    const readiness = await assessProductionReadiness(options);
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "MANUFACTURING_VERIFICATION_FAILED",
    );
    expect(readiness.findings.map(({ message }) => message).join("\n")).toContain(
      "must be replaced by an explicit stable manufactured-component name",
    );
    expect(promoteProductionBundle(options)).rejects.toThrow(
      "MANUFACTURING_VERIFICATION_FAILED",
    );
  });

  test("derives electrical readiness from Circuit JSON instead of trusting a passed label", async () => {
    const options = await fixture();
    const persisted = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    );
    const attackedCircuitJson = [
      ...persisted,
      {
        type: "source_pin_missing_trace_warning" as const,
        source_pin_missing_trace_warning_id: "source_pin_missing_trace_warning_attack",
        warning_type: "source_pin_missing_trace_warning" as const,
        source_component_id: "source_component_0",
        source_port_id: "source_port_0",
        message: "Port pin1 on R1 is missing a trace",
      },
    ];
    await Bun.write(
      join(options.artifactRoot, "evidence/circuit.json"),
      canonicalCircuitJson(attackedCircuitJson),
    );
    const draftManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: options.draftManifest.artifacts.map(({ path }) => path),
      artifactKinds: retainedArtifactKinds(options.draftManifest),
    });
    const readiness = await assessProductionReadiness({
      ...options,
      draftManifest,
      manufacturingExpectation: deriveManufacturingExpectation({
        boardName: "control",
        circuitJson: attackedCircuitJson,
      }),
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "ELECTRICAL_EVIDENCE_MISMATCH",
    );
  });

  test("derives fabrication readiness and rejects an impossible annular ring", async () => {
    const options = await fixture();
    const circuitJson = JSON.parse(
      await Bun.file(join(options.artifactRoot, "evidence/circuit.json")).text(),
    );
    const via = circuitJson.find((element: { type?: string }) => element.type === "pcb_via");
    if (via === undefined) throw new Error("fixture via missing");
    via.hole_diameter = 0.5;
    via.outer_diameter = 0.3;
    const files = await exportManufacturingFiles({ boardName: "control", circuitJson });
    for (const file of files) {
      await Bun.write(join(options.artifactRoot, ...file.path.split("/")), file.content);
    }
    await Bun.write(
      join(options.artifactRoot, "evidence/circuit.json"),
      canonicalCircuitJson(circuitJson),
    );
    const draftManifest = await createDraftArtifactManifest({
      root: options.artifactRoot,
      boardRevision: "A",
      artifactPaths: options.draftManifest.artifacts.map(({ path }) => path),
      artifactKinds: retainedArtifactKinds(options.draftManifest),
    });
    const readiness = await assessProductionReadiness({
      ...options,
      draftManifest,
      manufacturingExpectation: deriveManufacturingExpectation({
        boardName: "control",
        circuitJson,
      }),
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "FABRICATION_EVIDENCE_MISMATCH",
    );
  });

  test("cannot promote an internally consistent board with non-positive thickness", async () => {
    for (const thickness of [0, -1]) {
      const base = await fixture(4);
      const circuitJson = JSON.parse(
        await Bun.file(join(base.artifactRoot, "evidence/circuit.json")).text(),
      );
      const board = circuitJson.find(
        (element: { type?: string }) => element.type === "pcb_board",
      );
      if (board === undefined) throw new Error("Fixture board missing");
      board.thickness = thickness;
      const options = await replaceFixtureCircuit(base, circuitJson);

      const readiness = await assessProductionReadiness(options);
      expect(readiness.eligible, String(thickness)).toBeFalse();
      expect(readiness.findings.map(({ code }) => code), String(thickness)).toEqual(
        expect.arrayContaining([
          "FABRICATION_EVIDENCE_MISMATCH",
          "MANUFACTURING_VERIFICATION_FAILED",
        ]),
      );
      await expect(promoteProductionBundle(options)).rejects.toThrow(
        "FABRICATION_EVIDENCE_MISMATCH",
      );
    }
  });

  test("blocks stale source bytes and stale artifact bytes", async () => {
    const source = await fixture();
    await Bun.write(join(source.projectRoot, "src/board.tsx"), "export const revision = 'B'\n");
    expect(
      (await assessProductionReadiness(source)).findings.map(({ code }) => code),
    ).toContain("BUILD_INPUT_STALE");

    const artifact = await fixture();
    await Bun.write(join(artifact.artifactRoot, "assembly/bom.csv"), "stale\n");
    expect(
      (await assessProductionReadiness(artifact)).findings.map(({ code }) => code),
    ).toContain("ARTIFACT_INTEGRITY_FAILED");
  });

  test("rejects a fresh source snapshot paired with an older clean bundle", async () => {
    const options = await fixture();
    await Bun.write(join(options.projectRoot, "src/board.tsx"), "export default []\n");
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    const readiness = await assessProductionReadiness({
      ...options,
      inputSnapshot,
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "SOURCE_CIRCUIT_MISMATCH",
    );
  });

  test("always requires fabrication and electrical, while functional is opt-in", async () => {
    const options = await fixture();
    const statuses = statusSet({
      ...options.statuses,
      functional: assuranceStatus("functional", "failed"),
    });

    const optional = await assessProductionReadiness({ ...options, statuses });
    expect(optional.eligible).toBeTrue();

    const required = await assessProductionReadiness({
      ...options,
      statuses,
      additionallyRequiredDimensions: ["functional"],
    });
    expect(required.eligible).toBeFalse();
    expect(required.findings.map(({ code }) => code)).toContain(
      "REQUIRED_STATUS_NOT_PASSING",
    );

    const assertedPass = statusSet({
      ...options.statuses,
      functional: assuranceStatus("functional", "passed"),
    });
    const optionalUnproven = await assessProductionReadiness({
      ...options,
      statuses: assertedPass,
    });
    expect(optionalUnproven.eligible).toBeFalse();
    expect(optionalUnproven.findings.map(({ code }) => code)).toContain(
      "UNVERIFIED_STATUS_CLAIM",
    );
    const forgedAuthority = await assessProductionReadiness({
      ...options,
      statuses: assertedPass,
      functionalSimulationAuthority: Object.freeze({
        inputSnapshotDigest: options.inputSnapshot.digest,
        evidence: Object.freeze({ circuitDigest: "sha256:" + "0".repeat(64) }),
      }) as never,
    });
    expect(forgedAuthority.eligible).toBeFalse();
    expect(forgedAuthority.findings.map(({ code }) => code)).toContain(
      "UNVERIFIED_STATUS_CLAIM",
    );
    const unavailable = await assessProductionReadiness({
      ...options,
      statuses: assertedPass,
      additionallyRequiredDimensions: ["functional"],
    });
    expect(unavailable.eligible).toBeFalse();
    expect(unavailable.findings.map(({ code }) => code)).toContain(
      "REQUIRED_DIMENSION_EVIDENCE_UNAVAILABLE",
    );
  });

  test("independently re-derives a claimed standards pass and permits it as an opt-in gate", async () => {
    const options = await fixture();
    const statuses = statusSet({
      ...options.statuses,
      standards: assuranceStatus("standards", "passed", {
        summary: "Caller summary is not evidence",
      }),
    });

    const optional = await assessProductionReadiness({ ...options, statuses });
    expect(optional.eligible).toBeTrue();
    const manifest = await promoteProductionBundle({
      ...options,
      statuses,
      additionallyRequiredDimensions: ["standards"],
    });
    expect(manifest.requiredDimensions).toEqual([
      "fabrication",
      "electrical",
      "standards",
    ]);
    expect(manifest.statuses.standards.state).toBe("passed");
    expect(manifest.statuses.standards.summary).toContain("not certification");
    expect(manifest.statuses.standards.summary).not.toContain("Caller summary");
    expect(manifest.statuses.sourcing.state).toBe("unchecked");
    expect(manifest.standardsEvidence).toMatchObject({
      claim: "checked-against-profile",
      certification: "not-certification",
      outcome: "profile-passed",
      profile: {
        name: BASELINE_FABRICATION_PROFILE.name,
        version: BASELINE_FABRICATION_PROFILE.version,
        digest: BASELINE_FABRICATION_PROFILE.digest,
      },
      evidence: {
        independentParser: "gerber-parser@4.2.7",
        sourceProfileRules: "passed",
        independentlyParsedManufacturingArtifacts: "passed",
      },
    });
    expect(manifest.standardsEvidence?.evidence.boundedArtifactSet).toEqual(
      options.draftManifest.artifacts.map(({ path, sha256, size }) => ({ path, sha256, size })),
    );
  });

  test("rejects forged or stale standards passes and sourcing without recorded evidence", async () => {
    const forged = await fixture();
    const pass = statusSet({
      ...forged.statuses,
      standards: assuranceStatus("standards", "passed"),
    });
    await Bun.write(
      join(forged.artifactRoot, "gerbers/control-In1_Cu.gbr"),
      "",
    );
    const stale = await assessProductionReadiness({
      ...forged,
      statuses: pass,
      additionallyRequiredDimensions: ["standards"],
    });
    expect(stale.eligible).toBeFalse();
    expect(stale.findings.map(({ code }) => code)).toContain(
      "STANDARDS_EVIDENCE_MISMATCH",
    );

    const waived = await fixture();
    const forgedWaiver = statusSet({
      ...waived.statuses,
      standards: assuranceStatus("standards", "passed-with-waivers", {
        diagnosticIds: [diagnosticId("STD_FORGED_WAIVER_001")],
      }),
    });
    const waivedReadiness = await assessProductionReadiness({
      ...waived,
      statuses: forgedWaiver,
    });
    expect(waivedReadiness.eligible).toBeFalse();
    expect(waivedReadiness.findings.map(({ code }) => code)).toContain(
      "STANDARDS_EVIDENCE_MISMATCH",
    );

    const sourcing = await fixture();
    const sourcingPass = statusSet({
      ...sourcing.statuses,
      sourcing: sourcingStatus("available"),
    });
    const sourcingReadiness = await assessProductionReadiness({
      ...sourcing,
      statuses: sourcingPass,
      additionallyRequiredDimensions: ["sourcing"],
    });
    expect(sourcingReadiness.eligible).toBeFalse();
    expect(sourcingReadiness.findings.map(({ code }) => code)).toContain(
      "SOURCING_EVIDENCE_MISMATCH",
    );
    expect(sourcingReadiness.findings.map(({ code }) => code)).toContain("REQUIRED_STATUS_NOT_PASSING");
  });

  test("never promotes a self-authored selection record or recorded stock condition as required sourcing availability", async () => {
    const options = await fixtureWithRecordedSourcing();
    const readiness = await assessProductionReadiness({
      ...options,
      additionallyRequiredDimensions: ["sourcing"],
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("REQUIRED_STATUS_NOT_PASSING");
    await expect(promoteProductionBundle({
      ...options,
      additionallyRequiredDimensions: ["sourcing"],
    })).rejects.toThrow("REQUIRED_STATUS_NOT_PASSING");

    const forgedStatuses = statusSet({
      ...options.statuses,
      sourcing: sourcingStatus("available", {
        summary: "caller says the self-hashed stock snapshot is authoritative",
        checkedAt: "2099-01-01T00:00:00.000Z",
      }),
    });
    const forged = await assessProductionReadiness({
      ...options,
      statuses: forgedStatuses,
      diagnostics: [defineDiagnostic({
        id: diagnosticId("SRC_CALLER_FORGED_001"),
        severity: "warning",
        dimension: "sourcing",
        message: "caller-authored sourcing prose",
        waiverPolicy: "forbidden",
        objects: ["R1"],
        sourceLocations: ["src/board.tsx:1:1"],
      })],
      additionallyRequiredDimensions: ["sourcing"],
    });
    expect(forged.eligible).toBeFalse();
    expect(forged.findings.map(({ code }) => code)).toContain("SOURCING_EVIDENCE_MISMATCH");

    const uncheckedForgery = await assessProductionReadiness({
      ...options,
      diagnostics: [defineDiagnostic({
        id: diagnosticId("SRC_UNCHECKED_CALLER_FORGED_001"),
        severity: "warning",
        dimension: "sourcing",
        message: "unchecked caller still tries to persist trusted-looking sourcing prose",
        waiverPolicy: "forbidden",
        objects: ["R1"],
        sourceLocations: ["src/board.tsx:1:1"],
      })],
      additionallyRequiredDimensions: ["sourcing"],
    });
    expect(uncheckedForgery.eligible).toBeFalse();
    expect(uncheckedForgery.findings.map(({ code }) => code)).toContain(
      "SOURCING_EVIDENCE_MISMATCH",
    );
  }, 60_000);

  test("rejects a draft manifest that omits a file the independent verifier consumed", async () => {
    const options = await fixture();
    const omitted = options.draftManifest.artifacts.find(
      ({ path }) => path.endsWith("In1_Cu.gbr"),
    );
    expect(omitted).toBeDefined();
    const readiness = await assessProductionReadiness({
      ...options,
      draftManifest: {
        ...options.draftManifest,
        artifacts: options.draftManifest.artifacts.filter(({ path }) => path !== omitted!.path),
      },
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "ARTIFACT_INTEGRITY_FAILED",
      message: "Draft artifact manifest does not exactly cover and type the independently bounded manufacturing and Circuit JSON artifact set",
    });
  });

  test("requires matched, scoped, allowed waiver evidence in the bundle", async () => {
    const options = await fixture();
    const id = diagnosticId("PCB_SILKSCREEN_001");
    const statuses = statusSet({
      ...options.statuses,
      fabrication: assuranceStatus("fabrication", "passed-with-waivers", {
        diagnosticIds: [id],
      }),
    });

    const missing = await assessProductionReadiness({ ...options, statuses });
    expect(missing.eligible).toBeFalse();
    expect(missing.findings.map(({ code }) => code)).toContain(
      "WAIVER_EVIDENCE_INVALID",
    );

    const diagnostic = defineDiagnostic({
      id,
      severity: "warning",
      dimension: "fabrication",
      message: "Reference text is close to the board edge",
      waiverPolicy: "allowed",
      disposition: "waived",
      objects: ["R1.reference"],
      sourceLocations: ["src/board.tsx:12:5"],
      resolution: {
        scope: "R1.reference only",
        justification: "Assembly drawing carries the reference",
      },
    });
    await mkdir(join(options.projectRoot, "waivers"), { recursive: true });
    await Bun.write(
      join(options.projectRoot, "waivers/fabrication.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        waivers: [{
          diagnosticId: id,
          dimension: "fabrication",
          scope: diagnostic.resolution?.scope,
          justification: diagnostic.resolution?.justification,
        }],
      }, null, 2)}\n`,
    );
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "waivers/fabrication.json", role: "waiver" },
      ],
    });
    const manifest = await promoteProductionBundle({
      ...options,
      inputSnapshot,
      statuses,
      diagnostics: [diagnostic],
    });
    expect(manifest.waivers).toEqual([
      {
        diagnosticId: id,
        dimension: "fabrication",
        scope: "R1.reference only",
        justification: "Assembly drawing carries the reference",
      },
    ]);
    const persisted = manifest.diagnostics.find(({ id: candidate }) => candidate === id);
    expect(persisted).toMatchObject({
      id,
      objects: ["R1.reference"],
      disposition: "waived",
      sourceLocations: [expect.stringMatching(/^src\/board\.tsx:\d+:\d+$/)],
      evidence: ["provenance:nearest-authored-name"],
    });
    expect(persisted?.sourceLocations).not.toContain("src/board.tsx:12:5");
  });

  test("preserves every scoped occurrence when one waived rule repeats", async () => {
    const options = await fixture();
    const id = diagnosticId("PCB_SILKSCREEN_002");
    const statuses = statusSet({
      ...options.statuses,
      fabrication: assuranceStatus("fabrication", "passed-with-waivers", {
        diagnosticIds: [id, id],
      }),
    });
    const diagnostics = [
      defineDiagnostic({
        id,
        severity: "warning",
        dimension: "fabrication",
        message: "R1 reference text is close to the board edge",
        waiverPolicy: "allowed",
        disposition: "waived",
        objects: ["R1.reference"],
        resolution: { scope: "R1.reference only", justification: "Assembly drawing carries R1" },
      }),
      defineDiagnostic({
        id,
        severity: "warning",
        dimension: "fabrication",
        message: "D1 reference text is close to the board edge",
        waiverPolicy: "allowed",
        disposition: "waived",
        objects: ["D1.reference"],
        resolution: { scope: "D1.reference only", justification: "Assembly drawing carries D1" },
      }),
    ];
    await mkdir(join(options.projectRoot, "waivers"), { recursive: true });
    await Bun.write(join(options.projectRoot, "waivers/fabrication.json"), `${JSON.stringify({
      schemaVersion: 1,
      waivers: diagnostics.map((diagnostic) => ({
        diagnosticId: diagnostic.id,
        dimension: diagnostic.dimension,
        scope: diagnostic.resolution?.scope,
        justification: diagnostic.resolution?.justification,
      })),
    }, null, 2)}\n`);
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "waivers/fabrication.json", role: "waiver" },
      ],
    });

    const manifest = await promoteProductionBundle({
      ...options,
      inputSnapshot,
      statuses,
      diagnostics,
    });
    expect(manifest.waivers).toEqual([
      {
        diagnosticId: id,
        dimension: "fabrication",
        scope: "R1.reference only",
        justification: "Assembly drawing carries R1",
      },
      {
        diagnosticId: id,
        dimension: "fabrication",
        scope: "D1.reference only",
        justification: "Assembly drawing carries D1",
      },
    ]);
    expect(manifest.diagnostics.filter(({ id: candidate }) => candidate === id)).toHaveLength(2);
  });

  test("rejects a decoy waiver input whose bytes do not match the effective scope", async () => {
    const options = await fixture();
    const id = diagnosticId("PCB_SILKSCREEN_003");
    const diagnostic = defineDiagnostic({
      id,
      severity: "warning",
      dimension: "fabrication",
      message: "Reference text is close to the board edge",
      waiverPolicy: "allowed",
      disposition: "waived",
      objects: ["R1.reference"],
      resolution: { scope: "R1.reference only", justification: "Assembly drawing carries R1" },
    });
    await mkdir(join(options.projectRoot, "waivers"), { recursive: true });
    await Bun.write(join(options.projectRoot, "waivers/fabrication.json"), `${JSON.stringify({
      schemaVersion: 1,
      waivers: [{
        diagnosticId: id,
        dimension: "fabrication",
        scope: "every component",
        justification: "This deliberately does not match",
      }],
    }, null, 2)}\n`);
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "waivers/fabrication.json", role: "waiver" },
      ],
    });
    const readiness = await assessProductionReadiness({
      ...options,
      inputSnapshot,
      statuses: statusSet({
        ...options.statuses,
        fabrication: assuranceStatus("fabrication", "passed-with-waivers", {
          diagnosticIds: [id],
        }),
      }),
      diagnostics: [diagnostic],
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "WAIVER_EVIDENCE_INVALID",
      message: "Source-controlled waiver declarations do not exactly match every effective waiver occurrence",
    });
  });

  test("cannot relabel a waiver declaration as source to bypass waiver parsing", async () => {
    const options = await fixture();
    await mkdir(join(options.projectRoot, "waivers"));
    await Bun.write(
      join(options.projectRoot, "waivers/fabrication.json"),
      "{ this is not a valid waiver declaration }\n",
    );
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "waivers/fabrication.json", role: "source" as const },
      ],
    });
    const readiness = await assessProductionReadiness({ ...options, inputSnapshot });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "WAIVER_EVIDENCE_INVALID",
      message: "waivers/fabrication.json must be classified as a waiver build input",
    });
  });

  test("rejects a required waiver omitted behind a plain passing status", async () => {
    const options = await fixture();
    const diagnostic = defineDiagnostic({
      id: diagnosticId("PCB_SILKSCREEN_004"),
      severity: "warning",
      dimension: "fabrication",
      message: "Reference text is close to the board edge",
      waiverPolicy: "allowed",
      disposition: "waived",
      objects: ["R1.reference"],
      resolution: { scope: "R1.reference only", justification: "Assembly drawing carries R1" },
    });

    const readiness = await assessProductionReadiness({
      ...options,
      diagnostics: [diagnostic],
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "WAIVER_EVIDENCE_INVALID",
      message: `Required fabrication waiver ${diagnostic.id} is omitted from passed-with-waivers status evidence`,
    });
  });

  test("rejects suppression as a production substitute for a scoped waiver", async () => {
    const options = await fixture();
    const diagnostic = defineDiagnostic({
      id: diagnosticId("PCB_SILKSCREEN_005"),
      severity: "warning",
      dimension: "fabrication",
      message: "Reference text is close to the board edge",
      waiverPolicy: "allowed",
      disposition: "suppressed",
      objects: ["R1.reference"],
      resolution: { scope: "R1.reference only", justification: "Hidden during development" },
    });

    const readiness = await assessProductionReadiness({
      ...options,
      diagnostics: [diagnostic],
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "WAIVER_EVIDENCE_INVALID",
      message: `Required fabrication diagnostic ${diagnostic.id} is suppressed; production requires an explicit scoped waiver`,
    });
  });

  test("rejects calendar-invalid dates in source-controlled waiver declarations", async () => {
    const options = await fixture();
    await mkdir(join(options.projectRoot, "waivers"), { recursive: true });
    await Bun.write(join(options.projectRoot, "waivers/fabrication.json"), `${JSON.stringify({
      schemaVersion: 1,
      waivers: [{
        diagnosticId: "PCB_SILKSCREEN_006",
        dimension: "fabrication",
        scope: "R1.reference only",
        justification: "Invalid date canary",
        expiresAt: "2026-02-31",
      }],
    }, null, 2)}\n`);
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "waivers/fabrication.json", role: "waiver" },
      ],
    });

    const readiness = await assessProductionReadiness({ ...options, inputSnapshot });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "WAIVER_EVIDENCE_INVALID",
      message: "Waiver waivers/fabrication.json#0 has invalid required fields",
    });
  });

  test("hashes the exact waiver bytes being parsed instead of trusting path timing", async () => {
    const options = await fixture();
    const id = diagnosticId("PCB_SILKSCREEN_007");
    const diagnostic = defineDiagnostic({
      id,
      severity: "warning",
      dimension: "fabrication",
      message: "Reference text is close to the board edge",
      waiverPolicy: "allowed",
      disposition: "waived",
      objects: ["R1.reference"],
      resolution: { scope: "R1.reference only", justification: "Assembly drawing carries R1" },
    });
    const path = join(options.projectRoot, "waivers/fabrication.json");
    await mkdir(join(options.projectRoot, "waivers"), { recursive: true });
    await Bun.write(path, `${JSON.stringify({ schemaVersion: 1, waivers: [] }, null, 2)}\n`);
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "waivers/fabrication.json", role: "waiver" },
      ],
    });
    await Bun.write(path, `${JSON.stringify({
      schemaVersion: 1,
      waivers: [{
        diagnosticId: id,
        dimension: "fabrication",
        scope: diagnostic.resolution?.scope,
        justification: diagnostic.resolution?.justification,
      }],
    }, null, 2)}\n`);

    const readiness = await assessProductionReadiness({
      ...options,
      inputSnapshot,
      statuses: statusSet({
        ...options.statuses,
        fabrication: assuranceStatus("fabrication", "passed-with-waivers", { diagnosticIds: [id] }),
      }),
      diagnostics: [diagnostic],
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings).toContainEqual({
      code: "WAIVER_EVIDENCE_INVALID",
      message: "Waiver declaration bytes do not match the build snapshot: waivers/fabrication.json",
    });
  });

  test("uses the promotion host date for expiry and rejects a backdated waiver", async () => {
    const options = await fixture();
    const id = diagnosticId("PCB_SILKSCREEN_008");
    const expiresAt = "2000-01-01";
    const diagnostic = defineDiagnostic({
      id,
      severity: "warning",
      dimension: "fabrication",
      message: "Reference text is close to the board edge",
      waiverPolicy: "allowed",
      disposition: "waived",
      objects: ["R1.reference"],
      resolution: {
        scope: "R1.reference only",
        justification: "Historical waiver must not remain valid",
        expiresAt,
      },
    });
    await mkdir(join(options.projectRoot, "waivers"), { recursive: true });
    await Bun.write(join(options.projectRoot, "waivers/fabrication.json"), `${JSON.stringify({
      schemaVersion: 1,
      waivers: [{
        diagnosticId: id,
        dimension: "fabrication",
        scope: diagnostic.resolution?.scope,
        justification: diagnostic.resolution?.justification,
        expiresAt,
      }],
    }, null, 2)}\n`);
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: [
        ...options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
        { path: "waivers/fabrication.json", role: "waiver" },
      ],
    });

    const readiness = await assessProductionReadiness({
      ...options,
      inputSnapshot,
      statuses: statusSet({
        ...options.statuses,
        fabrication: assuranceStatus("fabrication", "passed-with-waivers", { diagnosticIds: [id] }),
      }),
      diagnostics: [diagnostic],
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain("WAIVER_EXPIRED");
  });

  test("retains optional-dimension warning evidence without treating it as a required pass", async () => {
    const options = await fixture();
    const id = diagnosticId("FUNCTIONAL_MODEL_GAP_001");
    const diagnostic = defineDiagnostic({
      id,
      severity: "warning",
      dimension: "functional",
      message: "The optional LED model is unavailable",
      waiverPolicy: "forbidden",
      objects: ["D1"],
      sourceLocations: ["src/board.tsx:1"],
      evidence: ["model:missing"],
    });
    const statuses = statusSet({
      ...options.statuses,
      functional: assuranceStatus("functional", "incomplete", { diagnosticIds: [id] }),
    });
    const manifest = await promoteProductionBundle({
      ...options,
      statuses,
      diagnostics: [diagnostic],
    });
    expect(manifest.requiredDimensions).toEqual(["fabrication", "electrical"]);
    expect(manifest.statuses.functional.state).toBe("incomplete");
    expect(manifest.diagnostics).toContainEqual(diagnostic);
    expect(manifest.diagnostics.map(({ id }) => String(id))).toContain(
      "FAB_BOARD_REVISION_SILKSCREEN_001",
    );
  });

  test("blocks required-dimension diagnostics with unavailable or ambiguous provenance", async () => {
    const options = await fixture();
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_PROVENANCE_GAP_001"),
      severity: "warning",
      dimension: "fabrication",
      message: "Manufactured object provenance is ambiguous",
      waiverPolicy: "forbidden",
      objects: ["pcb_board_0"],
      sourceLocations: [],
      evidence: ["provenance:ambiguous-authored-name"],
    });
    const readiness = await assessProductionReadiness({ ...options, diagnostics: [diagnostic] });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "DIAGNOSTIC_PROVENANCE_INCOMPLETE",
    );
  });

  test("re-derives and persists required provenance instead of trusting a supplied source location", async () => {
    const options = await fixture();
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_PROVENANCE_FORGED_LOCATION_001"),
      severity: "warning",
      dimension: "fabrication",
      message: "A generated component needs review",
      waiverPolicy: "forbidden",
      objects: ["pcb_component_1"],
      sourceLocations: ["src/board.tsx:1:1"],
    });
    const manifest = await promoteProductionBundle({ ...options, diagnostics: [diagnostic] });
    const persisted = manifest.diagnostics.find(({ id }) => id === diagnostic.id);
    expect(persisted?.sourceLocations).toEqual([expect.stringMatching(
      /^src\/board\.tsx:\d+:\d+$/,
    )]);
    expect(persisted?.sourceLocations).not.toContain("src/board.tsx:1:1");
    expect(persisted?.evidence).toContain("provenance:nearest-authored-name");
  });

  test("does not trust a caller synthetic marker for a real circuit object", async () => {
    const options = await fixture();
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_PROVENANCE_FORGED_SYNTHETIC_001"),
      severity: "warning",
      dimension: "fabrication",
      message: "A generated component needs review",
      waiverPolicy: "forbidden",
      objects: ["pcb_board_0"],
      sourceLocations: [],
      evidence: ["provenance:synthetic-generated"],
    });
    const readiness = await assessProductionReadiness({ ...options, diagnostics: [diagnostic] });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "DIAGNOSTIC_PROVENANCE_INCOMPLETE",
    );
  });

  test("does not promote a required diagnostic through a source-only decoy name", async () => {
    const options = await fixture();
    const sourcePath = join(options.projectRoot, "src/board.tsx");
    await Bun.write(
      sourcePath,
      `const decoy = { name: "DECOY" }\n${await Bun.file(sourcePath).text()}`,
    );
    const inputSnapshot = await createBuildInputSnapshot({
      projectRoot: options.projectRoot,
      inputs: options.inputSnapshot.inputs.map(({ path, role }) => ({ path, role })),
    });
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_DECOY_PROVENANCE_001"),
      severity: "warning",
      dimension: "fabrication",
      message: "A source-only decoy must not prove manufactured-object provenance",
      waiverPolicy: "forbidden",
      objects: ["DECOY"],
      sourceLocations: ["src/board.tsx:1:24"],
    });
    const readiness = await assessProductionReadiness({
      ...options,
      inputSnapshot,
      diagnostics: [diagnostic],
    });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "DIAGNOSTIC_PROVENANCE_INCOMPLETE",
    );
  });

  test("does not promote a fabricated selector suffix through a valid component", async () => {
    const options = await fixture();
    const diagnostic = defineDiagnostic({
      id: diagnosticId("FAB_INVALID_SELECTOR_001"),
      severity: "warning",
      dimension: "fabrication",
      message: "A fabricated child selector must not inherit component provenance",
      waiverPolicy: "forbidden",
      objects: ["R1.not-a-real-child"],
      sourceLocations: ["src/board.tsx:1:1"],
    });
    const readiness = await assessProductionReadiness({ ...options, diagnostics: [diagnostic] });
    expect(readiness.eligible).toBeFalse();
    expect(readiness.findings.map(({ code }) => code)).toContain(
      "DIAGNOSTIC_PROVENANCE_INCOMPLETE",
    );
  });

  test("callers cannot impersonate the internally generated board-revision finding", async () => {
    const options = await fixture();
    const impersonation = defineDiagnostic({
      id: diagnosticId("FAB_BOARD_REVISION_SILKSCREEN_001"),
      severity: "info",
      dimension: "fabrication",
      message: "Caller claims the revision is present",
      waiverPolicy: "allowed",
      objects: [],
      sourceLocations: ["src/board.tsx:1:1"],
    });
    const manifest = await promoteProductionBundle({ ...options, diagnostics: [impersonation] });
    const revision = manifest.diagnostics.find(
      ({ id }) => String(id) === "FAB_BOARD_REVISION_SILKSCREEN_001",
    );
    expect(revision?.message).toContain("is not present");
    expect(revision?.sourceLocations).toEqual([]);
    expect(revision?.evidence).toContain("provenance:synthetic-generated");
  });
});
