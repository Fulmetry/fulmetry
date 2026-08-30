// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
export const FULMETRY_PACKAGE_NAME = "fulmetry";

/** Read the version from the package boundary that owns the executing code. */
export async function requireFulmetryVersion(): Promise<string> {
  const metadata = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
    name?: unknown;
    version?: unknown;
  };
  if (
    metadata.name !== FULMETRY_PACKAGE_NAME ||
    typeof metadata.version !== "string" ||
    !SEMVER.test(metadata.version)
  ) {
    throw new Error("Fulmetry package identity has invalid name or version metadata");
  }
  return metadata.version;
}
