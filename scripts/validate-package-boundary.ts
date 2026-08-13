import { resolve } from "node:path";
import { requireDistributionPackageReady } from "../src/licenses";

const packageRoot = resolve(process.cwd());
const repositoryRoot = resolve(import.meta.dir, "..");

await requireDistributionPackageReady({
  packageRoot,
  nodeModulesRoot: resolve(repositoryRoot, "node_modules"),
});

process.stdout.write(`Validated distribution licensing boundary for ${packageRoot}\n`);
