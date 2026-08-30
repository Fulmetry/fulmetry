import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { inspectTscircuitIdentity } from "../../src/engine-identity";

const [expectedRootInput, expectedVersion, expectedContentSha256, expectedRuntimeClosureSha256] = process.argv.slice(2);
if (
  expectedRootInput === undefined || expectedVersion === undefined ||
  expectedContentSha256 === undefined || expectedRuntimeClosureSha256 === undefined
) {
  throw new TypeError("Expected candidate root, version, content SHA-256, and runtime-closure SHA-256");
}

const stageRoot = process.cwd();
const expectedRoot = await realpath(expectedRootInput);
const report = await inspectTscircuitIdentity({
  projectRoot: stageRoot,
  fulmetryRoot: join(stageRoot, "src"),
  expectedVersion,
  expectedContentSha256,
  expectedRuntimeClosureSha256: [expectedRuntimeClosureSha256],
});
if (!report.compatible) {
  throw new Error(report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
}
if (report.project?.packageRoot !== expectedRoot || report.fulmetry?.packageRoot !== expectedRoot) {
  throw new Error(
    "TSCIRCUIT_DUPLICATE_ENGINE: direct tscircuit and fulmetry/authoring must resolve the exact supplied candidate root",
  );
}
if (
  report.project.runtimeClosureSha256 !== expectedRuntimeClosureSha256 ||
  report.fulmetry.runtimeClosureSha256 !== expectedRuntimeClosureSha256
) throw new Error("TSCIRCUIT_RUNTIME_CLOSURE_UNQUALIFIED: resolved candidate closure differs from reviewed authority");

process.stdout.write(`${JSON.stringify({
  projectPackageRoot: report.project.packageRoot,
  fulmetryPackageRoot: report.fulmetry.packageRoot,
  version: report.project.version,
  contentSha256: report.project.contentSha256,
  runtimeClosureSha256: report.project.runtimeClosureSha256,
})}\n`);
