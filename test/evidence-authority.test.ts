import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  captureRunEvidenceAuthority,
  captureSelectedEvidenceAuthority,
  RUN_EVIDENCE_DEPTH_LIMIT,
  RUN_EVIDENCE_ENTRY_LIMIT,
  RUN_EVIDENCE_FILE_BYTES_LIMIT,
  RUN_EVIDENCE_TOTAL_BYTES_LIMIT,
  verifyRunEvidenceAuthority,
} from "../src/cli/evidence-authority";
import type { ArtifactReference } from "../src/result";

const roots: string[] = [];

async function project(name: string): Promise<{ root: string; run: string; report: string }> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  const run = join(root, ".pcboo", "runs", "authority");
  await mkdir(run, { recursive: true });
  return { root, run, report: join(run, "report.json") };
}

function artifact(root: string, path: string): ArtifactReference {
  return {
    kind: "command-error",
    path: relative(root, path).replaceAll("\\", "/"),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run evidence filesystem authority", () => {
  test("captures and revalidates one exact bounded tree", async () => {
    const fixture = await project("pcboo-evidence-authority");
    const nested = join(fixture.run, "nested");
    await mkdir(nested);
    const file = join(nested, "evidence.json");
    await Bun.write(file, "{\"state\":\"passed\"}\n");
    const authority = await captureRunEvidenceAuthority({
      runDirectory: fixture.run,
      projectRoot: fixture.root,
      reportPath: fixture.report,
      artifacts: [artifact(fixture.root, file)],
    });
    expect(authority.files.map(({ path }) => path)).toEqual(["nested/evidence.json"]);
    await expect(verifyRunEvidenceAuthority(authority, fixture.root)).resolves.toBeUndefined();

    await Bun.write(file, "{\"state\":\"changed\"}\n");
    await expect(verifyRunEvidenceAuthority(authority, fixture.root))
      .rejects.toThrow("no longer matches");
  });

  test("rejects a sparse evidence artifact above the per-file limit before hashing it", async () => {
    const fixture = await project("pcboo-evidence-file-limit");
    const file = join(fixture.run, "oversized.bin");
    await Bun.write(file, "");
    await truncate(file, RUN_EVIDENCE_FILE_BYTES_LIMIT + 1);

    await expect(captureRunEvidenceAuthority({
      runDirectory: fixture.run,
      projectRoot: fixture.root,
      reportPath: fixture.report,
      artifacts: [artifact(fixture.root, file)],
    })).rejects.toThrow(`${RUN_EVIDENCE_FILE_BYTES_LIMIT}-byte per-file limit`);
  });

  test("rejects aggregate evidence bytes above the bounded command total", async () => {
    const fixture = await project("pcboo-evidence-total-limit");
    const chunkSize = Math.floor(RUN_EVIDENCE_TOTAL_BYTES_LIMIT / 5) + 1;
    const artifacts: ArtifactReference[] = [];
    for (let index = 0; index < 5; index += 1) {
      const file = join(fixture.run, `aggregate-${index}.bin`);
      await Bun.write(file, "");
      await truncate(file, chunkSize);
      artifacts.push(artifact(fixture.root, file));
    }

    await expect(captureRunEvidenceAuthority({
      runDirectory: fixture.run,
      projectRoot: fixture.root,
      reportPath: fixture.report,
      artifacts,
    })).rejects.toThrow(`${RUN_EVIDENCE_TOTAL_BYTES_LIMIT}-byte aggregate limit`);
  }, 30_000);

  test("streams and bounds broad and deep evidence directory trees", async () => {
    const broad = await project("pcboo-evidence-entry-limit");
    for (let start = 0; start <= RUN_EVIDENCE_ENTRY_LIMIT; start += 64) {
      await Promise.all(Array.from(
        { length: Math.min(64, RUN_EVIDENCE_ENTRY_LIMIT + 1 - start) },
        (_, offset) => mkdir(join(broad.run, `empty-${start + offset}`)),
      ));
    }
    await expect(captureRunEvidenceAuthority({
      runDirectory: broad.run,
      projectRoot: broad.root,
      reportPath: broad.report,
      artifacts: [],
    })).rejects.toThrow(`exceeds ${RUN_EVIDENCE_ENTRY_LIMIT} entries`);

    const deep = await project("pcboo-evidence-depth-limit");
    let directory = deep.run;
    for (let depth = 0; depth <= RUN_EVIDENCE_DEPTH_LIMIT; depth += 1) {
      directory = join(directory, "d");
      await mkdir(directory);
    }
    await expect(captureRunEvidenceAuthority({
      runDirectory: deep.run,
      projectRoot: deep.root,
      reportPath: deep.report,
      artifacts: [],
    })).rejects.toThrow(`${RUN_EVIDENCE_DEPTH_LIMIT} directory levels`);
  });

  test("applies the same file bound to selected failure evidence", async () => {
    const fixture = await project("pcboo-selected-evidence-limit");
    const file = join(fixture.run, "error.txt");
    await Bun.write(file, "");
    await truncate(file, RUN_EVIDENCE_FILE_BYTES_LIMIT + 1);

    await expect(captureSelectedEvidenceAuthority({
      runDirectory: fixture.run,
      projectRoot: fixture.root,
      reportPath: fixture.report,
      artifacts: [artifact(fixture.root, file)],
    })).rejects.toThrow(`${RUN_EVIDENCE_FILE_BYTES_LIMIT}-byte per-file limit`);
  });

  test("shares count and aggregate-byte budgets across selected failure evidence", async () => {
    const counted = await project("pcboo-selected-evidence-count");
    const countedArtifacts: ArtifactReference[] = [];
    for (let index = 0; index <= RUN_EVIDENCE_ENTRY_LIMIT; index += 1) {
      const file = join(counted.run, `error-${index}.txt`);
      await Bun.write(file, "");
      countedArtifacts.push(artifact(counted.root, file));
    }
    await expect(captureSelectedEvidenceAuthority({
      runDirectory: counted.run,
      projectRoot: counted.root,
      reportPath: counted.report,
      artifacts: countedArtifacts,
    })).rejects.toThrow(`exceeds ${RUN_EVIDENCE_ENTRY_LIMIT} entries`);

    const aggregate = await project("pcboo-selected-evidence-total");
    const chunkSize = Math.floor(RUN_EVIDENCE_TOTAL_BYTES_LIMIT / 5) + 1;
    const aggregateArtifacts: ArtifactReference[] = [];
    for (let index = 0; index < 5; index += 1) {
      const file = join(aggregate.run, `error-${index}.bin`);
      await Bun.write(file, "");
      await truncate(file, chunkSize);
      aggregateArtifacts.push(artifact(aggregate.root, file));
    }
    await expect(captureSelectedEvidenceAuthority({
      runDirectory: aggregate.run,
      projectRoot: aggregate.root,
      reportPath: aggregate.report,
      artifacts: aggregateArtifacts,
    })).rejects.toThrow(`${RUN_EVIDENCE_TOTAL_BYTES_LIMIT}-byte aggregate limit`);
  }, 30_000);

  test("allows a canonical system-root alias but rejects a symlink below the project root", async () => {
    const fixture = await project("pcboo-evidence-local-ancestor-symlink");
    const ordinaryFile = join(fixture.run, "ordinary.json");
    await Bun.write(ordinaryFile, "{}\n");
    await expect(captureRunEvidenceAuthority({
      runDirectory: fixture.run,
      projectRoot: fixture.root,
      reportPath: fixture.report,
      artifacts: [artifact(fixture.root, ordinaryFile)],
    })).resolves.toMatchObject({ mode: "exact-tree" });

    const external = await mkdtemp(join(tmpdir(), "pcboo-evidence-external-"));
    roots.push(external);
    const externalRun = join(external, "runs", "authority");
    await mkdir(externalRun, { recursive: true });
    const externalFile = join(externalRun, "evidence.json");
    await Bun.write(externalFile, "{}\n");
    await rm(join(fixture.root, ".pcboo"), { recursive: true, force: true });
    await symlink(
      external,
      join(fixture.root, ".pcboo"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const redirectedRun = join(fixture.root, ".pcboo", "runs", "authority");
    const redirectedReport = join(redirectedRun, "report.json");
    const redirectedArtifact = artifact(fixture.root, join(redirectedRun, "evidence.json"));

    await expect(captureRunEvidenceAuthority({
      runDirectory: redirectedRun,
      projectRoot: fixture.root,
      reportPath: redirectedReport,
      artifacts: [redirectedArtifact],
    })).rejects.toThrow("symlink below the project root");
    await expect(captureSelectedEvidenceAuthority({
      runDirectory: redirectedRun,
      projectRoot: fixture.root,
      reportPath: redirectedReport,
      artifacts: [redirectedArtifact],
    })).rejects.toThrow("symlink below the project root");
  });

  test("rejects intermediate directory symlinks instead of following evidence through them", async () => {
    const fixture = await project("pcboo-evidence-symlink");
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await Bun.write(join(outside, "evidence.json"), "{}\n");
    await symlink(
      outside,
      join(fixture.run, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(captureRunEvidenceAuthority({
      runDirectory: fixture.run,
      projectRoot: fixture.root,
      reportPath: fixture.report,
      artifacts: [],
    })).rejects.toThrow("contains symlink linked");
  });
});
