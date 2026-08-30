import { afterEach, describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  parseReviewTscircuitUpgradeArguments,
  reviewTscircuitUpgrade,
  UPGRADE_REVIEW_IMPLEMENTATION_INPUTS,
} from "../scripts/review-tscircuit-upgrade";
import { acceptanceChildContainmentAvailable } from "../scripts/bounded-acceptance-child";
import { tscircuitUpgradeReportSha256 } from "../src/upstream-upgrade";
import { SUPPORTED_TSCIRCUIT_INTEGRITY, SUPPORTED_TSCIRCUIT_VERSION } from "../src/project/lock";
import {
  requireSupportedUpgradeReviewBunVersion,
  SUPPORTED_UPGRADE_REVIEW_BUN_VERSION,
} from "../src/upgrade/runtime";

const PROJECT_ROOT = join(import.meta.dir, "..");
const CURRENT_CANDIDATE = join(PROJECT_ROOT, "node_modules", "tscircuit");
const CURRENT_LOCK = join(PROJECT_ROOT, "bun.lock");
const CURRENT_INTEGRITY = SUPPORTED_TSCIRCUIT_INTEGRITY;
const DIFFERENT_INTEGRITY = `sha512-${Buffer.alloc(64, 23).toString("base64")}`;
const NEXT_VERSION = `${SUPPORTED_TSCIRCUIT_VERSION.split(".").slice(0, 2).join(".")}.${Number(SUPPORTED_TSCIRCUIT_VERSION.split(".")[2]) + 1}`;
const temporaryRoots: string[] = [];
const reportPaths: string[] = [];
const containmentTest = test.skipIf(!acceptanceChildContainmentAvailable());

afterEach(async () => {
  await Promise.all([
    ...temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...reportPaths.splice(0).map((path) => rm(path, { force: true })),
  ]);
});

async function copiedCandidate(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "fulmetry-review-candidate-"));
  temporaryRoots.push(parent);
  const modules = join(parent, "node_modules");
  await mkdir(modules);
  const sourceModules = join(PROJECT_ROOT, "node_modules");
  for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
    if (entry.name === "tscircuit") continue;
    await symlink(
      join(sourceModules, entry.name),
      join(modules, entry.name),
      process.platform === "win32" ? (entry.isDirectory() ? "junction" : "file") : undefined,
    );
  }
  const target = join(modules, "tscircuit");
  await cp(await realpath(CURRENT_CANDIDATE), target, { recursive: true, errorOnExist: true });
  await cp(CURRENT_LOCK, join(parent, "bun.lock"));
  return target;
}

function lockFor(candidate: string): string {
  return join(dirname(dirname(candidate)), "bun.lock");
}

async function updateCandidateLock(candidate: string, version: string, integrity: string): Promise<void> {
  const path = lockFor(candidate);
  const lock = Bun.JSONC.parse(await readFile(path, "utf8")) as {
    workspaces: { "": { devDependencies: { tscircuit: string }; peerDependencies: { tscircuit: string } } };
    packages: { tscircuit: [string, string, Record<string, unknown>, string] };
  };
  lock.workspaces[""].devDependencies.tscircuit = version;
  lock.workspaces[""].peerDependencies.tscircuit = version;
  lock.packages.tscircuit[0] = `tscircuit@${version}`;
  lock.packages.tscircuit[3] = integrity;
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

async function repositoryBytesSha256(): Promise<string> {
  const paths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (directory === PROJECT_ROOT && [".git", ".fulmetry", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) paths.push(path);
      else throw new Error(`Unexpected repository entry ${path}`);
    }
  };
  await walk(PROJECT_ROOT);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of paths.sort()) {
    hasher.update(relative(PROJECT_ROOT, path).replaceAll("\\", "/"));
    hasher.update("\0");
    hasher.update(await readFile(path));
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function output(name: string): { relative: string; absolute: string } {
  const relativePath = `.fulmetry/upgrade-reviews/${name}-${crypto.randomUUID()}.json`;
  const absolute = join(PROJECT_ROOT, ...relativePath.split("/"));
  reportPaths.push(absolute);
  return { relative: relativePath, absolute };
}

describe("offline tscircuit upgrade review runner", () => {
  test("parses only the explicit non-installing review command", () => {
    expect(UPGRADE_REVIEW_IMPLEMENTATION_INPUTS).toContain("package.json");
    expect(UPGRADE_REVIEW_IMPLEMENTATION_INPUTS).toContain("scripts/bounded-acceptance-child.ts");
    expect(UPGRADE_REVIEW_IMPLEMENTATION_INPUTS).toContain("src");
    expect(UPGRADE_REVIEW_IMPLEMENTATION_INPUTS).toContain("test/fixtures/canonical");
    expect(SUPPORTED_UPGRADE_REVIEW_BUN_VERSION).toBe("1.3.14");
    expect(requireSupportedUpgradeReviewBunVersion(Bun.version)).toBe("1.3.14");
    expect(() => requireSupportedUpgradeReviewBunVersion("1.3.15")).toThrow(
      "TSCIRCUIT_UPGRADE_UNSUPPORTED_BUN",
    );
    expect(parseReviewTscircuitUpgradeArguments([
      "review", "--candidate-package", "/tmp/candidate", "--candidate-lock", "/tmp/bun.lock", "--integrity", DIFFERENT_INTEGRITY,
      "--candidate-packed-package", "/tmp/packed/node_modules/tscircuit",
      "--output", ".fulmetry/upgrade-reviews/review.json",
    ])).toEqual({
      candidatePackageDirectory: "/tmp/candidate",
      candidateLockPath: "/tmp/bun.lock",
      candidatePackedPackageDirectory: "/tmp/packed/node_modules/tscircuit",
      integrity: DIFFERENT_INTEGRITY,
      output: ".fulmetry/upgrade-reviews/review.json",
    });
    expect(() => parseReviewTscircuitUpgradeArguments(["accept"])).toThrow("Usage:");
    expect(() => parseReviewTscircuitUpgradeArguments([
      "review", "--candidate-package", "/tmp/candidate", "--candidate-lock", "/tmp/bun.lock",
    ])).toThrow("--integrity is required");
    expect(() => parseReviewTscircuitUpgradeArguments([
      "review", "--candidate-package", "/tmp/candidate", "--integrity", DIFFERENT_INTEGRITY,
    ])).toThrow("--candidate-lock is required");
  });

  containmentTest("rejects one installation masquerading as both runtime profiles", async () => {
    const candidate = await copiedCandidate();
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: candidate,
      candidateLockPath: lockFor(candidate),
      candidatePackedPackageDirectory: candidate,
      integrity: CURRENT_INTEGRITY,
      publishReport: false,
    })).rejects.toThrow("physically distinct");
  });

  containmentTest("reviews the installed candidate offline with zero semantic/manufacturing deltas and no other repo mutation", async () => {
    const selected = output("current");
    const before = await repositoryBytesSha256();
    const result = await reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      candidateLockPath: CURRENT_LOCK,
      integrity: CURRENT_INTEGRITY,
      output: selected.relative,
    });

    expect(result.outputPath).toBe(selected.absolute);
    expect(result.report.outcome).toBe("no-change");
    expect(result.report.bunVersion).toBe("1.3.14");
    expect(result.report.expectedFixtureNames).toEqual(["led-2layer", "plated-hole-4layer"]);
    expect(result.report.baseline.engine).toEqual(result.report.candidate.engine);
    expect(result.report.fixtures.map((fixture) => ({
      name: fixture.name,
      status: fixture.status,
      semanticChanged: fixture.semantic.changed,
      manufacturingChanged: fixture.manufacturing.changedSet,
    }))).toEqual([
      { name: "led-2layer", status: "unchanged", semanticChanged: false, manufacturingChanged: false },
      { name: "plated-hole-4layer", status: "unchanged", semanticChanged: false, manufacturingChanged: false },
    ]);
    expect(result.report.reportSha256).toBe(tscircuitUpgradeReportSha256(result.report));
    expect(result.report.reviewImplementationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.report.baselineAnchorSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.report.baseline.engine.dependencyLockSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(await Bun.file(selected.absolute).text())).toEqual(result.report);
    expect(await repositoryBytesSha256()).toBe(before);

    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      candidateLockPath: CURRENT_LOCK,
      integrity: CURRENT_INTEGRITY,
      output: selected.relative,
    })).rejects.toThrow("already exists and is immutable");
  }, 90_000);

  containmentTest("reports candidate version, integrity, and content changes separately from unchanged board artifacts", async () => {
    const candidate = await copiedCandidate();
    const metadataPath = join(candidate, "package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.version = NEXT_VERSION;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(join(candidate, "README.md"), `${await readFile(join(candidate, "README.md"), "utf8")}\nreview-copy\n`);
    await updateCandidateLock(candidate, NEXT_VERSION, DIFFERENT_INTEGRITY);
    const selected = output("metadata-content");

    const result = await reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: candidate,
      candidateLockPath: lockFor(candidate),
      integrity: DIFFERENT_INTEGRITY,
      output: selected.relative,
    });

    expect(result.report.outcome).toBe("changes-require-review");
    expect(result.report.candidate.engine.version).toBe(NEXT_VERSION);
    expect(result.report.candidate.engine.integrity).toBe(DIFFERENT_INTEGRITY);
    expect(result.report.candidate.engine.contentSha256).not.toBe(result.report.baseline.engine.contentSha256);
    expect(result.report.fixtures.every((fixture) =>
      fixture.status === "unchanged" &&
      !fixture.semantic.changed &&
      !fixture.inputs.changedSet &&
      !fixture.manufacturing.changedSet
    )).toBeTrue();
  }, 90_000);

  containmentTest("does not publish when the candidate is missing required authoring exports", async () => {
    const candidate = await copiedCandidate();
    const metadataPath = join(candidate, "package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      main: string;
      exports: Record<string, unknown>;
    };
    metadata.main = "dist/incomplete.js";
    metadata.exports["."] = { default: "./dist/incomplete.js" };
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(
      join(candidate, "dist", "incomplete.js"),
      "export { Circuit } from './index.js';\n",
    );
    await updateCandidateLock(candidate, SUPPORTED_TSCIRCUIT_VERSION, DIFFERENT_INTEGRITY);
    const selected = output("missing-export");

    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: candidate,
      candidateLockPath: lockFor(candidate),
      integrity: DIFFERENT_INTEGRITY,
      output: selected.relative,
    })).rejects.toThrow("Complete candidate authoring identity test failed");
    expect(await Bun.file(selected.absolute).exists()).toBeFalse();
  }, 90_000);

  containmentTest("does not publish when fulmetry and direct imports resolve duplicate physical engines", async () => {
    const selected = output("duplicate-root");
    const duplicateCandidate = await copiedCandidate();
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      candidateLockPath: CURRENT_LOCK,
      integrity: CURRENT_INTEGRITY,
      output: selected.relative,
      stagePrepared: async (stageRoot) => {
        const nestedModules = join(stageRoot, "src", "node_modules");
        await mkdir(nestedModules, { recursive: true });
        await symlink(
          duplicateCandidate,
          join(nestedModules, "tscircuit"),
          process.platform === "win32" ? "junction" : undefined,
        );
      },
    })).rejects.toThrow(/TSCIRCUIT_DUPLICATE_ENGINE|exact supplied candidate root/u);
    expect(await Bun.file(selected.absolute).exists()).toBeFalse();
  }, 90_000);

  test("fails closed for a missing, mismatched, or unrelated candidate lock", async () => {
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      integrity: CURRENT_INTEGRITY,
    } as any)).rejects.toThrow("candidateLockPath is required");

    const mismatched = await copiedCandidate();
    await updateCandidateLock(mismatched, SUPPORTED_TSCIRCUIT_VERSION, DIFFERENT_INTEGRITY);
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: mismatched,
      candidateLockPath: lockFor(mismatched),
      integrity: CURRENT_INTEGRITY,
    })).rejects.toThrow("integrity does not match");

    const unrelated = await copiedCandidate();
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      candidateLockPath: lockFor(unrelated),
      integrity: CURRENT_INTEGRITY,
    })).rejects.toThrow("direct node_modules/tscircuit");
  }, 30_000);

  test("rejects a stale compatibility anchor before qualification", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-anchor-test-"));
    temporaryRoots.push(root);
    const stalePath = join(root, "tscircuit.json");
    const stale = JSON.parse(await Bun.file(join(PROJECT_ROOT, "compatibility", "tscircuit.json")).text());
    stale.accepted.version = NEXT_VERSION;
    await writeFile(stalePath, `${JSON.stringify(stale, null, 2)}\n`);
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      candidateLockPath: CURRENT_LOCK,
      integrity: CURRENT_INTEGRITY,
      compatibilityAnchorPath: stalePath,
    })).rejects.toThrow("does not match compatibility");
  }, 90_000);

  test("rejects a non-strict compatibility anchor before qualification", async () => {
    const root = await mkdtemp(join(tmpdir(), "fulmetry-anchor-test-"));
    temporaryRoots.push(root);
    const malformedPath = join(root, "malformed.json");
    await writeFile(malformedPath, '{"schemaVersion":1,}');
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      candidateLockPath: CURRENT_LOCK,
      integrity: CURRENT_INTEGRITY,
      compatibilityAnchorPath: malformedPath,
    })).rejects.toThrow("strict JSON");
  }, 90_000);

  containmentTest("does not publish if staged regular inputs mutate after authentication", async () => {
    const selected = output("staged-mutation");
    await expect(reviewTscircuitUpgrade({
      projectRoot: PROJECT_ROOT,
      candidatePackageDirectory: CURRENT_CANDIDATE,
      candidateLockPath: CURRENT_LOCK,
      integrity: CURRENT_INTEGRITY,
      output: selected.relative,
      afterStageInputCaptured: async (stageRoot) => {
        const helper = join(stageRoot, "test", "helpers", "upgrade-engine-identity-process.ts");
        await writeFile(helper, `${await Bun.file(helper).text()}\n`);
      },
    })).rejects.toThrow("Staged source, test, fixture, or package inputs changed");
    expect(await Bun.file(selected.absolute).exists()).toBeFalse();
  }, 90_000);
});
