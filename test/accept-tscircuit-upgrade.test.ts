import { afterEach, describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  acceptTscircuitUpgrade,
  acceptanceStageSha256,
  assertPreparedFixtureInputRecords,
  candidateRepositoryTests,
  captureAcceptanceTargetSha256,
  createAcceptedTscircuitAnchor,
  expectedAcceptedFixtureInputRecords,
  parseAcceptTscircuitUpgradeArguments,
  requireRuntimeEvidenceForAcceptance,
  requireCandidateAuthoringTypeReexports,
  requireTrustedAcceptanceTypeScript,
  runBoundedChild,
  runWithAcceptanceStageProtected,
  runWithAcceptanceTargetsProtected,
} from "../scripts/accept-tscircuit-upgrade";
import { acceptanceChildContainmentAvailable } from "../scripts/bounded-acceptance-child";
import { reviewTscircuitUpgrade } from "../scripts/review-tscircuit-upgrade";
import { canonicalTscircuitUpgradeReportJson, createTscircuitUpgradeReview, tscircuitUpgradeFileSetSha256 } from "../src/upstream-upgrade";
import { SUPPORTED_TSCIRCUIT_INTEGRITY, SUPPORTED_TSCIRCUIT_VERSION } from "../src/project/lock";
import { createTscircuitRuntimeEvidence } from "../src/upgrade/runtime-evidence";

const ROOT = join(import.meta.dir, "..");
const CURRENT = join(ROOT, "node_modules", "tscircuit");
const LOCK = join(ROOT, "bun.lock");
const INTEGRITY = SUPPORTED_TSCIRCUIT_INTEGRITY;
const NEXT_VERSION = `${SUPPORTED_TSCIRCUIT_VERSION.split(".").slice(0, 2).join(".")}.${Number(SUPPORTED_TSCIRCUIT_VERSION.split(".")[2]) + 1}`;
const OTHER_INTEGRITY = `sha512-${Buffer.alloc(64, 42).toString("base64")}`;
const temporary: string[] = [];
const reports: string[] = [];
const containmentTest = test.skipIf(!acceptanceChildContainmentAvailable());

afterEach(async () => Promise.all([
  ...temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ...reports.splice(0).map((path) => rm(path, { force: true })),
]));

const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
function unavailableRuntimeEvidence(path: string) {
  return {
    runtimeEvidencePath: path,
    runtimeEvidenceSha256: digest("unavailable-runtime-evidence"),
  };
}
const qualification = {
  curatedExportIdentity: "passed", mixedImportSemanticEquivalence: "passed",
  deterministicDoubleEvaluation: "passed", circuitJsonSchemaValidation: "passed",
  independentManufacturingVerification: "passed",
} as const;
function syntheticSnapshot(version: string) {
  const file = { path: "x", size: 1, sha256: digest("x") };
  return {
    schemaVersion: 2,
    engine: {
      version,
      integrity: INTEGRITY,
      contentSha256: digest(version),
      dependencyLockSha256: digest(`lock-${version}`),
      runtimePlatform: `${process.platform}-${process.arch}`,
      runtimeClosureSha256: digest(`runtime-${version}`),
      packedConsumerRuntimeClosureSha256: digest(`packed-${version}`),
    },
    qualification,
    fixtures: ["led-2layer", "plated-hole-4layer"].map((name) => ({
      name, inputs: { files: [file], setSha256: tscircuitUpgradeFileSetSha256([file]) },
      semanticSha256: digest(name), manufacturing: { files: [file], setSha256: tscircuitUpgradeFileSetSha256([file]) },
    })),
  };
}

async function tempReport(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-accept-report-"));
  temporary.push(root);
  const path = join(root, "report.json");
  await writeFile(path, contents);
  return path;
}

async function repositorySha256(): Promise<string> {
  const files: string[] = [];
  const walk = async (root: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (root === ROOT && [".git", ".pcboo", "node_modules"].includes(entry.name)) continue;
      const path = join(root, entry.name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) files.push(path);
    }
  };
  await walk(ROOT);
  const hash = new Bun.CryptoHasher("sha256");
  for (const path of files.sort()) hash.update(relative(ROOT, path)).update("\0").update(await readFile(path)).update("\0");
  return hash.digest("hex");
}

async function copiedCandidate(): Promise<{ packageRoot: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-accept-candidate-"));
  temporary.push(root);
  const modules = join(root, "node_modules");
  await mkdir(modules);
  for (const entry of await readdir(join(ROOT, "node_modules"), { withFileTypes: true })) {
    if (entry.name === "tscircuit") continue;
    if (entry.name === "typescript") {
      await cp(await realpath(join(ROOT, "node_modules", "typescript")), join(modules, "typescript"), {
        recursive: true,
        errorOnExist: true,
      });
      continue;
    }
    await symlink(join(ROOT, "node_modules", entry.name), join(modules, entry.name), process.platform === "win32" ? (entry.isDirectory() ? "junction" : "file") : undefined);
  }
  const packageRoot = join(modules, "tscircuit");
  await cp(await realpath(CURRENT), packageRoot, { recursive: true, errorOnExist: true });
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  metadata.version = NEXT_VERSION;
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(join(packageRoot, "README.md"), `${await readFile(join(packageRoot, "README.md"), "utf8")}\nacceptance-candidate\n`);
  const lock = Bun.JSONC.parse(await readFile(LOCK, "utf8")) as any;
  lock.workspaces[""].devDependencies.tscircuit = NEXT_VERSION;
  lock.workspaces[""].peerDependencies.tscircuit = NEXT_VERSION;
  lock.packages.tscircuit[0] = `tscircuit@${NEXT_VERSION}`;
  lock.packages.tscircuit[3] = OTHER_INTEGRITY;
  const lockPath = join(root, "bun.lock");
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { packageRoot, lockPath };
}

describe("explicit tscircuit acceptance transaction", () => {
  test("binds candidate acceptance evidence and constructs the complete macOS anchor", () => {
    const evidence = createTscircuitRuntimeEvidence({
      candidate: {
        version: NEXT_VERSION,
        integrity: OTHER_INTEGRITY,
        contentSha256: digest("candidate-content"),
      },
      baselineAnchorSha256: digest("baseline-anchor"),
      semanticReportSha256: digest("semantic-report"),
      bunVersion: "1.3.14",
      platform: "darwin-arm64",
      implementationSha256: digest("implementation"),
      profiles: {
        repository: {
          closureSha256: digest("repository-closure"),
          lockSha256: digest("repository-lock"),
        },
        packedConsumer: {
          closureSha256: digest("packed-closure"),
          lockSha256: digest("packed-lock"),
          manifestSha256: digest("packed-manifest"),
          packedPcbooContentSha256: digest("packed-pcboo-content"),
          projectPcbooLockSha256: digest("packed-pcboo-lock"),
          singleEngineResolutionSha256: digest("single-engine"),
          pcbooTarballSha256: digest("pcboo-tarball"),
          pcbooTarballIntegrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
          contractVersion: 2,
        },
      },
    });
    const expected = {
      reportSha256: evidence.semanticReportSha256!,
      baselineAnchorSha256: evidence.baselineAnchorSha256,
      bunVersion: evidence.bunVersion,
      runtimePlatform: evidence.platform,
      candidate: evidence.candidate,
      repositoryClosureSha256: evidence.profiles.repository.closureSha256,
      packedConsumerClosureSha256: evidence.profiles.packedConsumer.closureSha256,
      repositoryLockSha256: evidence.profiles.repository.lockSha256,
      packedConsumer: evidence.profiles.packedConsumer,
    };
    expect(() => requireRuntimeEvidenceForAcceptance(evidence, expected)).not.toThrow();
    for (const mutation of [
      { reportSha256: digest("wrong-report") },
      { baselineAnchorSha256: digest("wrong-anchor") },
      { bunVersion: "9.9.9" },
      { runtimePlatform: "linux-x64" },
      { candidate: { ...evidence.candidate, version: `${NEXT_VERSION}-wrong` } },
      { repositoryClosureSha256: digest("wrong-closure") },
      { packedConsumerClosureSha256: digest("wrong-packed") },
      { repositoryLockSha256: digest("wrong-lock") },
      { packedConsumer: { ...evidence.profiles.packedConsumer, lockSha256: digest("wrong-packed-lock") } },
      { packedConsumer: { ...evidence.profiles.packedConsumer, manifestSha256: digest("wrong-packed-manifest") } },
      { packedConsumer: { ...evidence.profiles.packedConsumer, packedPcbooContentSha256: digest("wrong-packed-content") } },
      { packedConsumer: { ...evidence.profiles.packedConsumer, projectPcbooLockSha256: digest("wrong-project-lock") } },
      { packedConsumer: { ...evidence.profiles.packedConsumer, singleEngineResolutionSha256: digest("wrong-single-engine") } },
      { packedConsumer: { ...evidence.profiles.packedConsumer, pcbooTarballSha256: digest("wrong-tarball") } },
      { packedConsumer: { ...evidence.profiles.packedConsumer, pcbooTarballIntegrity: OTHER_INTEGRITY } },
    ]) {
      expect(() => requireRuntimeEvidenceForAcceptance(evidence, { ...expected, ...mutation }))
        .toThrow("Runtime evidence");
    }
    const anchor = createAcceptedTscircuitAnchor({
      previousVersion: SUPPORTED_TSCIRCUIT_VERSION,
      reportSha256: expected.reportSha256,
      evidence,
    });
    expect(anchor).toEqual({
      schemaVersion: 3,
      accepted: evidence.candidate,
      runtimeClosures: {
        "darwin-arm64": {
          repository: evidence.profiles.repository.closureSha256,
          packedConsumer: evidence.profiles.packedConsumer.closureSha256,
        },
      },
      acceptedUpgradeReview: {
        fromVersion: SUPPORTED_TSCIRCUIT_VERSION,
        reportSha256: expected.reportSha256,
        runtimeEvidenceSha256: evidence.evidenceSha256,
      },
    });
    expect(() => createAcceptedTscircuitAnchor({
      previousVersion: SUPPORTED_TSCIRCUIT_VERSION,
      reportSha256: digest("wrong-report"),
      evidence,
    })).toThrow("must match runtime evidence semantic review");
  });

  test("discovers staged TS and TSX tests with an optional recursive tests root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-accept-test-inventory-"));
    temporary.push(root);
    await mkdir(join(root, "test", "nested"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "test", "accept-tscircuit-upgrade.test.ts"), ""),
      writeFile(join(root, "test", "nested", "primary.test.tsx"), ""),
    ]);
    expect(await candidateRepositoryTests(root)).toEqual([
      "test/nested/primary.test.tsx",
    ]);

    await mkdir(join(root, "tests", "nested"), { recursive: true });
    await writeFile(join(root, "tests", "nested", "secondary.test.tsx"), "");
    expect(await candidateRepositoryTests(root)).toEqual([
      "test/nested/primary.test.tsx",
      "tests/nested/secondary.test.tsx",
    ]);
  });

  test("contains or refuses an external double-fork new-session descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-accept-contained-child-"));
    temporary.push(root);
    const pidPath = join(root, "daemon.pid");
    const survivedPath = join(root, "daemon-survived.txt");
    const posixPython = process.platform === "win32" ? undefined : Bun.which("python3");
    if (process.platform !== "win32" && posixPython === null) {
      throw new Error("Hostile POSIX containment regression requires python3");
    }
    const daemonSource = `await Bun.sleep(750);await Bun.write(${JSON.stringify(survivedPath)},'survived')`;
    const doubleForkSource = [
      "import os,sys,time",
      "pid=os.fork()",
      "if pid>0: os._exit(0)",
      "os.setsid()",
      "pid=os.fork()",
      "if pid>0: os._exit(0)",
      "with open(sys.argv[1],'w') as f: f.write(str(os.getpid()))",
      "time.sleep(0.75)",
      "with open(sys.argv[2],'w') as f: f.write('survived')",
    ].join("\n");
    const hostileCommand = process.platform === "win32"
      ? `[process.execPath,'-e',${JSON.stringify(daemonSource)}]`
      : `[${JSON.stringify(posixPython)},'-c',${JSON.stringify(doubleForkSource)},${JSON.stringify(pidPath)},${JSON.stringify(survivedPath)}]`;
    const parentSource = [
      `const child=Bun.spawn(${hostileCommand},{detached:true,stdin:'ignore',stdout:'ignore',stderr:'ignore'});`,
      "child.unref();",
      ...(process.platform === "win32"
        ? [`await Bun.write(${JSON.stringify(pidPath)},String(child.pid));`]
        : ["await child.exited;"]),
    ].join("");
    let boundaryError: unknown;
    try {
      await runBoundedChild(
        [process.execPath, "-e", parentSource],
        root,
        "Hostile direct acceptance child",
        5_000,
      );
    } catch (error) {
      boundaryError = error;
    }
    expect(String(boundaryError)).toMatch(/containment|orphan/i);
    if (await Bun.file(pidPath).exists()) {
      const daemonPid = Number(await Bun.file(pidPath).text());
      expect(Number.isSafeInteger(daemonPid) && daemonPid > 0).toBeTrue();
      await Bun.sleep(1_000);
      expect(await Bun.file(survivedPath).exists()).toBeFalse();
      let alive = true;
      try { process.kill(daemonPid, 0); } catch { alive = false; }
      if (alive) {
        try { process.kill(daemonPid, "SIGKILL"); } catch { /* exact daemon exited */ }
      }
      expect(alive).toBeFalse();
    } else {
      expect(acceptanceChildContainmentAvailable()).toBeFalse();
      expect(await Bun.file(survivedPath).exists()).toBeFalse();
    }
  });

  test("allows only the acceptance-owned canonical fixture input transition", async () => {
    const baseline = await mkdtemp(join(tmpdir(), "pcboo-accept-input-baseline-"));
    const prepared = await mkdtemp(join(tmpdir(), "pcboo-accept-input-prepared-"));
    temporary.push(baseline, prepared);
    await mkdir(join(baseline, "circuit"));
    const board = "export default []\n";
    const config = "export default { entry: 'circuit/board.ts' }\n";
    const lock = {
      schemaVersion: 1,
      tscircuit: { version: "1.2.3", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` },
      adapters: { manufacturing: "fixture" },
    };
    const expectation = {
      boardName: "fixture",
      compatibility: {
        authoring: { engineVersion: "1.2.3", note: "preserve" },
        manufacturing: { engineVersion: "1.2.3", note: "preserve" },
      },
    };
    await writeFile(join(baseline, "circuit/board.ts"), board);
    await writeFile(join(baseline, "pcboo.config.ts"), config);
    await writeFile(join(baseline, "pcboo.lock"), `${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(join(baseline, "expectation.json"), `${JSON.stringify(expectation, null, 2)}\n`);
    const candidate = {
      version: "1.2.4",
      integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
    };
    const expected = await expectedAcceptedFixtureInputRecords({
      fixtureRoot: baseline,
      baseline: lock.tscircuit,
      candidate,
    });
    await cp(baseline, prepared, { recursive: true, errorOnExist: false });
    await writeFile(join(prepared, "pcboo.lock"), `${JSON.stringify({
      ...lock,
      tscircuit: candidate,
    }, null, 2)}\n`);
    await writeFile(join(prepared, "expectation.json"), `${JSON.stringify({
      ...expectation,
      compatibility: Object.fromEntries(Object.entries(expectation.compatibility).map(
        ([name, value]) => [name, { ...value, engineVersion: candidate.version }],
      )),
    }, null, 2)}\n`);
    await expect(assertPreparedFixtureInputRecords({ fixtureRoot: prepared, expected }))
      .resolves.toEqual(expected);

    await writeFile(join(prepared, "circuit/board.ts"), `${board}// mutation\n`);
    await expect(assertPreparedFixtureInputRecords({ fixtureRoot: prepared, expected }))
      .rejects.toThrow("acceptance-owned transition");
    await writeFile(join(prepared, "circuit/board.ts"), board);
    await writeFile(join(prepared, "pcboo.config.ts"), `${config}// mutation\n`);
    await expect(assertPreparedFixtureInputRecords({ fixtureRoot: prepared, expected }))
      .rejects.toThrow("acceptance-owned transition");
    await writeFile(join(prepared, "pcboo.config.ts"), config);
    const preparedExpectation = JSON.parse(await readFile(join(prepared, "expectation.json"), "utf8"));
    preparedExpectation.unreviewed = true;
    await writeFile(join(prepared, "expectation.json"), `${JSON.stringify(preparedExpectation, null, 2)}\n`);
    await expect(assertPreparedFixtureInputRecords({ fixtureRoot: prepared, expected }))
      .rejects.toThrow("acceptance-owned transition");
    delete preparedExpectation.unreviewed;
    await writeFile(join(prepared, "expectation.json"), `${JSON.stringify(preparedExpectation, null, 2)}\n`);
    const preparedLock = JSON.parse(await readFile(join(prepared, "pcboo.lock"), "utf8"));
    preparedLock.adapters.manufacturing = "mutated";
    await writeFile(join(prepared, "pcboo.lock"), `${JSON.stringify(preparedLock, null, 2)}\n`);
    await expect(assertPreparedFixtureInputRecords({ fixtureRoot: prepared, expected }))
      .rejects.toThrow("acceptance-owned transition");
  });

  test("rejects candidate-controlled mutations to a staged publishable target", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-accept-stage-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    const target = join(root, "src", "licenses.ts");
    await writeFile(target, "export const reviewed = true;\n");
    const expected = await captureAcceptanceTargetSha256(root, ["src/licenses.ts"]);

    await expect(runWithAcceptanceTargetsProtected({
      root,
      expected,
      label: "Candidate fixture",
      operation: async () => {
        await writeFile(target, "export const reviewed = true; // candidate mutation\n");
      },
    })).rejects.toThrow("changed publishable staged target src/licenses.ts");
  });

  test("rejects candidate-controlled mutations to non-published repository gate inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-accept-gate-stage-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "test", "fixtures", "canonical"), { recursive: true });
    await writeFile(join(root, "src", "authoring.ts"), "export type Reviewed = true;\n");
    await writeFile(join(root, "test", "fixtures", "canonical", "allowed-output"), "before\n");
    const excludedPaths = ["test/fixtures/canonical"] as const;
    const expectedSha256 = await acceptanceStageSha256(root, excludedPaths);

    await expect(runWithAcceptanceStageProtected({
      root,
      expectedSha256,
      excludedPaths,
      label: "Candidate preparation",
      operation: async () => {
        await writeFile(join(root, "test", "fixtures", "canonical", "allowed-output"), "after\n");
        await writeFile(join(root, "src", "authoring.ts"), "export type Reviewed = false;\n");
      },
    })).rejects.toThrow("changed staged repository gate inputs");
  });

  test("pins the acceptance compiler to PCBoo's reviewed TypeScript package", async () => {
    const compiler = await requireTrustedAcceptanceTypeScript(ROOT);
    expect(compiler).toMatchObject({
      version: "5.9.3",
      contentSha256: "1247d2a746ccfbc5d73c07f6d61c2e05197373d4668f258a0681e77298eccf27",
    });
    expect(compiler.compilerPath).toBe(join(compiler.root, "bin", "tsc"));
    await expect(requireCandidateAuthoringTypeReexports(CURRENT, compiler)).resolves.toBeUndefined();
  });

  test("rejects ambient substitutes for candidate-owned authoring type re-exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-accept-types-"));
    temporary.push(root);
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "tscircuit",
      version: NEXT_VERSION,
      types: "dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    })}\n`);
    await writeFile(join(root, "dist", "index.d.ts"), [
      'export { Board, Circuit } from "./runtime";',
      'declare module "tscircuit" { export type AnyCircuitElement = unknown; export type CircuitJson = unknown; }',
      "",
    ].join("\n"));
    const compiler = await requireTrustedAcceptanceTypeScript(ROOT);

    await expect(requireCandidateAuthoringTypeReexports(root, compiler))
      .rejects.toThrow("lacks required public type re-exports");
  });

  test("rejects a default-first conditional export that can bypass declared types", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-accept-decoy-types-"));
    temporary.push(root);
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "tscircuit",
      version: NEXT_VERSION,
      types: "dist/good.d.ts",
      exports: { ".": { default: "./dist/bad.js", types: "./dist/good.d.ts" } },
    })}\n`);
    await writeFile(join(root, "dist", "good.d.ts"), 'export { AnyCircuitElement, CircuitJson } from "circuit-json";\n');
    await writeFile(join(root, "dist", "bad.d.ts"), 'export { Board, Circuit } from "./runtime";\n');
    const compiler = await requireTrustedAcceptanceTypeScript(ROOT);

    await expect(requireCandidateAuthoringTypeReexports(root, compiler))
      .rejects.toThrow("declaration authorities disagree or are conditional");
  });

  test("parses only the exact explicit maintainer acceptance command", () => {
    const parsed = parseAcceptTscircuitUpgradeArguments([
      "accept",
      "--candidate-package", "candidate",
      "--candidate-lock", "candidate.lock",
      "--candidate-packed-package", "packed/node_modules/tscircuit",
      "--integrity", OTHER_INTEGRITY,
      "--report", "review.json",
      "--reviewed-report-sha256", digest("review"),
      "--runtime-evidence", "darwin.json",
      "--runtime-evidence-sha256", digest("evidence"),
      "--accept-reviewed-upgrade",
    ]);
    expect(parsed).toMatchObject({
      integrity: OTHER_INTEGRITY,
      reviewedReportSha256: digest("review"),
      runtimeEvidenceSha256: digest("evidence"),
      explicitAcceptance: true,
    });
    expect(parsed.candidatePackageDirectory).toBe(join(process.cwd(), "candidate"));
    expect(parsed.candidatePackedPackageDirectory).toBe(join(process.cwd(), "packed/node_modules/tscircuit"));
    expect(parsed.reportPath).toBe(join(process.cwd(), "review.json"));
    expect(parsed.runtimeEvidencePath).toBe(join(process.cwd(), "darwin.json"));
    expect(() => parseAcceptTscircuitUpgradeArguments([])).toThrow("bun run accept:tscircuit accept");
    expect(() => parseAcceptTscircuitUpgradeArguments([
      "accept", "--accept-reviewed-upgrade", "--accept-reviewed-upgrade",
    ])).toThrow("only once");
    expect(() => parseAcceptTscircuitUpgradeArguments([
      "accept", "--unknown", "value", "--accept-reviewed-upgrade",
    ])).toThrow("Unknown acceptance option");
  });

  test("rejects absent acceptance, tampered bytes, and no-change/current reports without source mutation", async () => {
    const snapshot = syntheticSnapshot(SUPPORTED_TSCIRCUIT_VERSION);
    const report = createTscircuitUpgradeReview(snapshot, structuredClone(snapshot), {
      expectedFixtureNames: ["led-2layer", "plated-hole-4layer"],
      reviewImplementationSha256: digest("implementation"), baselineAnchorSha256: digest("anchor"), bunVersion: Bun.version,
    });
    const path = await tempReport(canonicalTscircuitUpgradeReportJson(report));
    const before = await repositorySha256();
    const base = {
      projectRoot: ROOT, candidatePackageDirectory: CURRENT, candidateLockPath: LOCK,
      candidatePackedPackageDirectory: CURRENT,
      integrity: INTEGRITY, reportPath: path, reviewedReportSha256: report.reportSha256,
      ...unavailableRuntimeEvidence(path),
    };
    await expect(acceptTscircuitUpgrade({ ...base, explicitAcceptance: false as true })).rejects.toThrow("Explicit");
    await expect(acceptTscircuitUpgrade({ ...base, explicitAcceptance: true })).rejects.toThrow("no-change or current-engine");
    await writeFile(path, `${canonicalTscircuitUpgradeReportJson(report)} `);
    await expect(acceptTscircuitUpgrade({ ...base, explicitAcceptance: true })).rejects.toThrow(/non-canonical|digest/u);
    expect(await repositorySha256()).toBe(before);
  });

  containmentTest("rejects a self-consistent but stale reviewed report after fresh requalification", async () => {
    const report = createTscircuitUpgradeReview(
      syntheticSnapshot(SUPPORTED_TSCIRCUIT_VERSION),
      syntheticSnapshot(NEXT_VERSION),
      {
        expectedFixtureNames: ["led-2layer", "plated-hole-4layer"],
        reviewImplementationSha256: digest("old-implementation"),
        baselineAnchorSha256: digest("old-anchor"),
        bunVersion: Bun.version,
      },
    );
    const path = await tempReport(canonicalTscircuitUpgradeReportJson(report));
    const before = await repositorySha256();
    await expect(acceptTscircuitUpgrade({
      projectRoot: ROOT,
      candidatePackageDirectory: CURRENT,
      candidateLockPath: LOCK,
      candidatePackedPackageDirectory: CURRENT,
      integrity: INTEGRITY,
      reportPath: path,
      reviewedReportSha256: report.reportSha256,
      ...unavailableRuntimeEvidence(path),
      explicitAcceptance: true,
    })).rejects.toThrow("stale, non-canonical, tampered, or do not match fresh qualification");
    expect(await repositorySha256()).toBe(before);
  }, 60_000);

  containmentTest("rejects a runtime-compatible candidate whose public type surface breaks PCBoo", async () => {
    const candidate = await copiedCandidate();
    const declarationPath = join(candidate.packageRoot, "dist", "index.d.ts");
    const declaration = await readFile(declarationPath, "utf8");
    const typeExport = "export { AnyCircuitElement, CircuitJson } from 'circuit-json';";
    if (!declaration.includes(typeExport)) throw new Error("Fixture candidate has no expected public type export");
    await writeFile(declarationPath, declaration.replace(typeExport, ""));
    const relative = `.pcboo/upgrade-reviews/acceptance-types-${crypto.randomUUID()}.json`;
    const reportPath = join(ROOT, ...relative.split("/"));
    reports.push(reportPath);
    const review = await reviewTscircuitUpgrade({
      projectRoot: ROOT,
      candidatePackageDirectory: candidate.packageRoot,
      candidateLockPath: candidate.lockPath,
      candidatePackedPackageDirectory: candidate.packageRoot,
      integrity: OTHER_INTEGRITY,
      output: relative,
    });
    const before = await repositorySha256();
    await expect(acceptTscircuitUpgrade({
      projectRoot: ROOT,
      candidatePackageDirectory: candidate.packageRoot,
      candidateLockPath: candidate.lockPath,
      candidatePackedPackageDirectory: candidate.packageRoot,
      integrity: OTHER_INTEGRITY,
      reportPath,
      reviewedReportSha256: review.report.reportSha256,
      ...unavailableRuntimeEvidence(reportPath),
      explicitAcceptance: true,
    })).rejects.toThrow("required public type re-exports");
    expect(await repositorySha256()).toBe(before);
  }, 180_000);

  containmentTest("rolls back every accepted authority when publication fails part-way", async () => {
    const candidate = await copiedCandidate();
    const relative = `.pcboo/upgrade-reviews/acceptance-${crypto.randomUUID()}.json`;
    const reportPath = join(ROOT, ...relative.split("/"));
    reports.push(reportPath);
    const review = await reviewTscircuitUpgrade({
      projectRoot: ROOT, candidatePackageDirectory: candidate.packageRoot,
      candidateLockPath: candidate.lockPath, candidatePackedPackageDirectory: candidate.packageRoot,
      integrity: OTHER_INTEGRITY, output: relative,
    });
    const before = await repositorySha256();
    await expect(acceptTscircuitUpgrade({
      projectRoot: ROOT, candidatePackageDirectory: candidate.packageRoot,
      candidateLockPath: candidate.lockPath, integrity: OTHER_INTEGRITY,
      candidatePackedPackageDirectory: candidate.packageRoot,
      reportPath, reviewedReportSha256: review.report.reportSha256, explicitAcceptance: true,
      ...unavailableRuntimeEvidence(reportPath),
      afterPublicationBackup: async (index) => { if (index === 3) throw new Error("injected acceptance publication failure"); },
    })).rejects.toThrow("injected acceptance publication failure");
    expect(await repositorySha256()).toBe(before);
  }, 1_200_000);
});
