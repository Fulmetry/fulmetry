// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintTscircuitPackage } from "../engine-identity";

export const KICAD_ADAPTER_PACKAGE_PINS = Object.freeze({
  converter: Object.freeze({
    package: "circuit-json-to-kicad",
    version: "0.0.171",
    contentSha256: "b69b6f63a21d5d6f9088168e254508602ab589a44c2b4a35fc86c18023b3315a",
  }),
  parser: Object.freeze({
    package: "kicadts",
    version: "0.0.53",
    contentSha256: "d3664508f31c9b9fecc00a4d3f4a733e46396a430da9576840aafa4830d0c334",
  }),
} as const);

export interface KicadAdapterPackageIdentity {
  readonly package: string;
  readonly version: string;
  readonly contentSha256: string;
}

async function owningPackageRoot(entryPath: string, expectedName: string): Promise<string> {
  let candidate = dirname(entryPath);
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as { name?: unknown };
      if (metadata.name === expectedName) return await realpath(candidate);
    } catch {
      // Continue to the package boundary.
    }
    const parent = dirname(candidate);
    if (parent === candidate || parse(candidate).root === candidate) {
      throw new Error(`Cannot locate package root for ${expectedName}`);
    }
    candidate = parent;
  }
}

export async function requireKicadAdapterIdentity(): Promise<Readonly<{
  converter: KicadAdapterPackageIdentity;
  parser: KicadAdapterPackageIdentity;
}>> {
  const from = fileURLToPath(new URL(".", import.meta.url));
  const entries = await Promise.all(Object.entries(KICAD_ADAPTER_PACKAGE_PINS).map(async ([role, pin]) => {
    const entry = await realpath(Bun.resolveSync(pin.package, from));
    const root = await owningPackageRoot(entry, pin.package);
    const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
    const contentSha256 = await fingerprintTscircuitPackage(root);
    if (metadata.version !== pin.version || contentSha256 !== pin.contentSha256) {
      throw new Error(
        `${pin.package} resolved version/content ${String(metadata.version)}/${contentSha256}; ` +
          `required ${pin.version}/${pin.contentSha256}`,
      );
    }
    return [role, Object.freeze({ package: pin.package, version: pin.version, contentSha256 })] as const;
  }));
  return Object.freeze(Object.fromEntries(entries)) as Readonly<{
    converter: KicadAdapterPackageIdentity;
    parser: KicadAdapterPackageIdentity;
  }>;
}
