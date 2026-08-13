// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
export const PCBOO_PACKAGE_NAME = "@pcboo/pcboo";

/** Read the version from the package boundary that owns the executing code. */
export async function requirePcbooVersion(): Promise<string> {
  const metadata = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
    name?: unknown;
    version?: unknown;
  };
  if (
    metadata.name !== PCBOO_PACKAGE_NAME ||
    typeof metadata.version !== "string" ||
    !SEMVER.test(metadata.version)
  ) {
    throw new Error("PCBoo package identity has invalid name or version metadata");
  }
  return metadata.version;
}
