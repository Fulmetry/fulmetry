import { describe, expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSupportedBunVersion,
  requireSupportedBunRuntime,
  SUPPORTED_BUN_VERSION,
  SUPPORTED_RUNTIME_PLATFORM,
  UNSUPPORTED_BUN_DIAGNOSTIC_ID,
} from "../src/runtime";
import { SUPPORTED_CREATE_PCBOO_BUN_VERSION } from "../packages/create-pcboo/src/runtime";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("Bun runtime compatibility", () => {
  test("keeps one exact runtime policy across package boundaries", async () => {
    expect(SUPPORTED_BUN_VERSION).toBe("1.3.14");
    expect(SUPPORTED_CREATE_PCBOO_BUN_VERSION).toBe(SUPPORTED_BUN_VERSION);
    expect(isSupportedBunVersion("1.3.13")).toBeFalse();
    expect(isSupportedBunVersion(SUPPORTED_BUN_VERSION)).toBeTrue();
    expect(isSupportedBunVersion("1.3.15")).toBeFalse();
    expect(isSupportedBunVersion(null)).toBeFalse();
    expect(SUPPORTED_RUNTIME_PLATFORM).toBe("darwin-arm64");

    const framework = await Bun.file(join(import.meta.dir, "../package.json")).json() as {
      packageManager: string;
      engines: { bun: string };
      os: string[];
      cpu: string[];
    };
    const creator = await Bun.file(
      join(import.meta.dir, "../packages/create-pcboo/package.json"),
    ).json() as { engines: { bun: string }; os: string[]; cpu: string[] };
    expect(framework.packageManager).toBe(`bun@${SUPPORTED_BUN_VERSION}`);
    expect(framework.engines.bun).toBe(SUPPORTED_BUN_VERSION);
    expect(creator.engines.bun).toBe(SUPPORTED_BUN_VERSION);
    expect(framework.os).toEqual(["darwin"]);
    expect(framework.cpu).toEqual(["arm64"]);
    expect(creator.os).toEqual(["darwin"]);
    expect(creator.cpu).toEqual(["arm64"]);
  });

  test("the real runtime either qualifies or every authority issuer fails before access", async () => {
    const expectedMode = process.env.PCBOO_RUNTIME_COMPAT_EXPECT ??
      "supported-1.3.14";
    const nonexistentProject = join(
      tmpdir(),
      `pcboo-unsupported-bun-${crypto.randomUUID()}`,
    );
    expect(await pathExists(nonexistentProject)).toBeFalse();

    if (expectedMode === "supported-1.3.14") {
      expect(Bun.version).toBe(SUPPORTED_BUN_VERSION);
      expect(requireSupportedBunRuntime()).toBe(SUPPORTED_BUN_VERSION);
      expect(await pathExists(nonexistentProject)).toBeFalse();
      return;
    }
    if (expectedMode !== "unsupported-1.3.13") {
      throw new Error(`Unknown PCBoo runtime compatibility test mode ${JSON.stringify(expectedMode)}`);
    }
    expect(Bun.version).toBe("1.3.13");

    expect(() => requireSupportedBunRuntime()).toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    const { runCli } = await import("../src/cli/runner");
    const { startDevCommand } = await import("../src/cli/dev");
    const { startInspectionServer } = await import("../src/server");
    const { scaffoldPcbooProject } = await import("../packages/create-pcboo/src/scaffold");
    const {
      assessProductionReadiness,
      verifyPublishedProductionBundle,
    } = await import("../src/artifacts/promotion");
    const { verifyManufacturingDirectory } = await import("../src/manufacturing/verify");
    const { exportManufacturingFiles } = await import("../src/manufacturing/export");
    const { requireDistributionPackageReady } = await import("../src/licenses");
    const { loadProjectConfig } = await import("../src/project/config");
    const { runBunProjectTests } = await import("../src/project-tests");
    const { createKicadHandoff } = await import("../src/kicad");
    const { probeExternalTool } = await import("../src/external-tools");
    const { verifySimulationModelAssets } = await import("../src/simulation/assets");
    const { verifyExactSimulationArtifacts } = await import("../src/simulation/exact-output");
    const { runQualifiedNgspice } = await import("../src/simulation/ngspice");
    const run = await runCli({
      argv: ["build", "--json"],
      cwd: nonexistentProject,
    });

    expect(run.exitCode).toBe(4);
    expect(run.result?.exitClassification).toBe("unsupported");
    expect(run.result?.diagnostics.map(({ id }) => String(id))).toEqual([
      "PCBOO_RUNTIME_UNSUPPORTED_BUN_001",
    ]);
    expect(run.stderr).toBe("");
    await expect(startDevCommand({ argv: [], cwd: nonexistentProject }))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(startInspectionServer({ projectDirectory: nonexistentProject }))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(scaffoldPcbooProject({
      cwd: nonexistentProject,
      directory: "board",
      install: false,
    })).rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(assessProductionReadiness({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(verifyPublishedProductionBundle(nonexistentProject, {
      expectedManifestSha256: "0".repeat(64),
    }))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(verifyManufacturingDirectory({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(exportManufacturingFiles({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(requireDistributionPackageReady({ packageRoot: nonexistentProject }))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(loadProjectConfig(nonexistentProject))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(runBunProjectTests({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(createKicadHandoff([], { projectName: "runtime-probe" }))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(probeExternalTool({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(verifySimulationModelAssets({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(verifyExactSimulationArtifacts({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    await expect(runQualifiedNgspice({} as never))
      .rejects.toThrow(UNSUPPORTED_BUN_DIAGNOSTIC_ID);
    expect(await pathExists(nonexistentProject)).toBeFalse();
  });
});
