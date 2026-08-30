// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintTscircuitPackage } from "../engine-identity";

export const MANUFACTURING_PACKAGE_PINS = Object.freeze({
  gerber: Object.freeze({
    package: "circuit-json-to-gerber",
    version: "0.0.90",
    contentSha256: "5ebf1dc2cfa1f74227e037c02b3e320dac3f59761af1c46851f980a59925d0c7",
  }),
  bom: Object.freeze({
    package: "circuit-json-to-bom-csv",
    version: "0.0.14",
    contentSha256: "c67f71defac60a3ed5fb63e65dbcab4285ebe502ba74812dd7ecadf430146955",
  }),
  pickAndPlace: Object.freeze({
    package: "circuit-json-to-pnp-csv",
    version: "0.0.9",
    contentSha256: "80b1fa1e8045bb83f11c6f11c3a8afad13ef895564aeb85e93b58b108741b9ba",
  }),
  independentParser: Object.freeze({
    package: "gerber-parser",
    version: "4.2.7",
    contentSha256: "7a7fa9ec1f2649ed8c13ee184dd73b523c8a2bdb507a533e692d7e167c2de9a6",
  }),
} as const);

export interface ManufacturingPackageIdentity {
  readonly package: string;
  readonly version: string;
  readonly contentSha256: string;
}

async function packageRoot(entryPath: string, expectedName: string): Promise<string> {
  let candidate = dirname(entryPath);
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (metadata.name === expectedName) return await realpath(candidate);
    } catch {
      // Continue to the owning package boundary.
    }
    const parent = dirname(candidate);
    if (parent === candidate || parse(candidate).root === candidate) {
      throw new Error(`Cannot locate package root for ${expectedName}`);
    }
    candidate = parent;
  }
}

export async function requireManufacturingPackageIdentity(): Promise<
  Readonly<Record<keyof typeof MANUFACTURING_PACKAGE_PINS, ManufacturingPackageIdentity>>
> {
  const from = fileURLToPath(new URL(".", import.meta.url));
  const entries = await Promise.all(
    Object.entries(MANUFACTURING_PACKAGE_PINS).map(async ([role, pin]) => {
      const entry = await realpath(Bun.resolveSync(pin.package, from));
      const root = await packageRoot(entry, pin.package);
      const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        version?: unknown;
      };
      const contentSha256 = await fingerprintTscircuitPackage(root);
      if (metadata.version !== pin.version || contentSha256 !== pin.contentSha256) {
        throw new Error(
          `${pin.package} resolved version/content ${String(metadata.version)}/${contentSha256}; ` +
            `required ${pin.version}/${pin.contentSha256}`,
        );
      }
      return [role, Object.freeze({
        package: pin.package,
        version: pin.version,
        contentSha256,
      })] as const;
    }),
  );
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<keyof typeof MANUFACTURING_PACKAGE_PINS, ManufacturingPackageIdentity>
  >;
}
