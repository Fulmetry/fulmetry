// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintTscircuitPackage } from "./engine-identity";

/** Packages whose implementation bytes directly affect verified evidence. */
export const RUNTIME_EVIDENCE_PACKAGE_PINS = Object.freeze({
  circuitJsonSchema: Object.freeze({
    package: "circuit-json",
    version: "0.0.464",
    contentSha256: "89da172be71b44d541f1f31798c284be574778cbd3b34bf6d9a3f74334b2a00f",
  }),
  alphabet: Object.freeze({
    package: "@tscircuit/alphabet",
    version: "0.0.25",
    contentSha256: "196a98cb71f0821d256f91d86cfc19c41e52778f8d0b4fae56628f017d91b519",
  }),
  valueFormatter: Object.freeze({
    package: "format-si-prefix",
    version: "0.3.2",
    contentSha256: "5f1a4e5fd4519e1f33f9c3676bd0659663b94b72691aebaad870fc7349958677",
  }),
  sourceGraphParser: Object.freeze({
    package: "typescript",
    version: "5.9.3",
    contentSha256: "1247d2a746ccfbc5d73c07f6d61c2e05197373d4668f258a0681e77298eccf27",
  }),
} as const);

export interface RuntimeEvidencePackageIdentity {
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

export async function requireRuntimeEvidencePackageIdentity(): Promise<
  Readonly<Record<keyof typeof RUNTIME_EVIDENCE_PACKAGE_PINS, RuntimeEvidencePackageIdentity>>
> {
  const from = fileURLToPath(new URL(".", import.meta.url));
  const entries = await Promise.all(
    Object.entries(RUNTIME_EVIDENCE_PACKAGE_PINS).map(async ([role, pin]) => {
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
    Record<keyof typeof RUNTIME_EVIDENCE_PACKAGE_PINS, RuntimeEvidencePackageIdentity>
  >;
}
