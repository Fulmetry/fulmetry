import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  truncate,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_PACKAGE_DEPTH_LIMIT,
  ENGINE_PACKAGE_ENTRY_LIMIT,
  ENGINE_PACKAGE_FILE_BYTES_LIMIT,
  ENGINE_PACKAGE_METADATA_BYTES_LIMIT,
  ENGINE_PACKAGE_TOTAL_BYTES_LIMIT,
  fingerprintEnginePackage,
  fingerprintInstalledPackageClosure,
  readStableEnginePackageFile,
} from "../src/engine-package-fingerprint";

const temporaryRoots: string[] = [];

async function temporaryPackage(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "fulmetry-engine-fingerprint-"));
  temporaryRoots.push(parent);
  const root = join(parent, "tscircuit");
  await mkdir(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("bounded engine-package fingerprinting", () => {
  test("preserves the accepted path-and-bytes digest domain", async () => {
    const root = await temporaryPackage();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), "metadata\n");
    await writeFile(join(root, "dist", "index.js"), "engine\n");

    const hasher = new Bun.CryptoHasher("sha256");
    for (const [path, bytes] of [
      ["dist/index.js", "engine\n"],
      ["package.json", "metadata\n"],
    ] as const) {
      hasher.update(path);
      hasher.update("\0");
      hasher.update(bytes);
      hasher.update("\0");
    }

    expect(await fingerprintEnginePackage(root)).toBe(hasher.digest("hex"));
  });

  test("identifies package-owned content independently of dependency hoisting", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "index.js"), "package code\n");
    const withoutInstallLayout = await fingerprintEnginePackage(root);

    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "first layout\n");
    expect(await fingerprintEnginePackage(root)).toBe(withoutInstallLayout);

    await writeFile(join(root, "node_modules", "dependency", "index.js"), "second layout\n");
    expect(await fingerprintEnginePackage(root)).toBe(withoutInstallLayout);

    await rm(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules"), "alternate package-manager entry\n");
    expect(await fingerprintEnginePackage(root)).toBe(withoutInstallLayout);

    await writeFile(join(root, "index.js"), "altered package code\n");
    expect(await fingerprintEnginePackage(root)).not.toBe(withoutInstallLayout);
  });

  test("binds runtime dependency bytes while remaining independent of physical hoisting", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "tscircuit",
      version: "1.0.0",
      main: "index.js",
      dependencies: { dependency: "1.0.0" },
    })}\n`);
    await writeFile(join(root, "index.js"), 'import value from "dependency"; export default value;\n');
    const nested = join(root, "node_modules", "dependency");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), `${JSON.stringify({
      name: "dependency", version: "1.0.0", main: "index.js",
    })}\n`);
    await writeFile(join(nested, "index.js"), 'export default "first";\n');

    const nestedIdentity = await fingerprintInstalledPackageClosure(root);
    await writeFile(join(nested, "index.js"), 'export default "mutated";\n');
    expect(await fingerprintInstalledPackageClosure(root)).not.toBe(nestedIdentity);
  });

  test("rejects a runtime dependency changed after closure content hashing", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "tscircuit",
      version: "1.0.0",
      main: "index.js",
      dependencies: { dependency: "1.0.0" },
    })}\n`);
    await writeFile(join(root, "index.js"), 'import value from "dependency"; export default value;\n');
    const dependency = join(root, "node_modules", "dependency");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "package.json"), `${JSON.stringify({
      name: "dependency", version: "1.0.0", main: "index.js",
    })}\n`);
    await writeFile(join(dependency, "index.js"), 'export default "first";\n');

    await expect(fingerprintInstalledPackageClosure(root, {
      beforeFinalInventory: async () => {
        await writeFile(join(dependency, "index.js"), 'export default "tampered";\n');
      },
    })).rejects.toThrow(/changed (?:after graph capture|during fingerprinting)/);
  });

  test("distinguishes shared and duplicated stateful runtime package instances", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js",
      dependencies: { a: "1.0.0", b: "1.0.0" },
    }));
    await writeFile(join(root, "index.js"),
      'import a from "a"; import b from "b"; export default [a(), b()];\n');
    for (const name of ["a", "b", "shared"]) {
      const directory = join(root, "node_modules", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({
        name, version: "1.0.0", main: "index.js",
        ...(name === "a" || name === "b" ? { dependencies: { shared: "1.0.0" } } : {}),
      }));
    }
    await writeFile(join(root, "node_modules/a/index.js"),
      'import next from "shared"; export default next;\n');
    await writeFile(join(root, "node_modules/b/index.js"),
      'import next from "shared"; export default next;\n');
    await writeFile(join(root, "node_modules/shared/index.js"),
      'let value = 0; export default () => ++value;\n');
    const shared = await fingerprintInstalledPackageClosure(root);

    const duplicate = join(root, "node_modules", "b", "node_modules", "shared");
    await mkdir(duplicate, { recursive: true });
    await writeFile(join(duplicate, "package.json"), JSON.stringify({
      name: "shared", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(duplicate, "index.js"),
      'let value = 0; export default () => ++value;\n');
    expect(await fingerprintInstalledPackageClosure(root)).not.toBe(shared);
  });

  test("binds a declared bare import resolved from the ambient install", async () => {
    const root = await temporaryPackage();
    const ambient = join(root, "..", "node_modules", "phantom");
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js", dependencies: { phantom: "1.0.0" },
    }));
    await writeFile(join(root, "index.js"), 'import value from "phantom"; export default value;\n');
    await mkdir(ambient, { recursive: true });
    await writeFile(join(ambient, "package.json"), JSON.stringify({
      name: "phantom", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(ambient, "index.js"), 'export default "first";\n');
    const first = await fingerprintInstalledPackageClosure(root);
    await writeFile(join(ambient, "index.js"), 'export default "mutated";\n');
    expect(await fingerprintInstalledPackageClosure(root)).not.toBe(first);
  });

  test("fingerprints Bun's resolved exports entry instead of an unused module or main field", async () => {
    const root = await temporaryPackage();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit",
      version: "1.0.0",
      module: "dist/module.js",
      main: "dist/main.js",
      exports: { ".": { default: "./dist/export.js" } },
    }));
    await writeFile(join(root, "dist/module.js"), 'export default "unused-module";\n');
    await writeFile(join(root, "dist/main.js"), 'export default "unused-main";\n');
    await writeFile(join(root, "dist/export.js"), 'export default "actual-export";\n');

    const first = await fingerprintInstalledPackageClosure(root);
    await writeFile(join(root, "dist/export.js"), 'export default "mutated-export";\n');
    expect(await fingerprintInstalledPackageClosure(root)).not.toBe(first);
  });

  test("rejects a caller entrypoint that disagrees with Bun's package resolution", async () => {
    const root = await temporaryPackage();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit",
      version: "1.0.0",
      module: "dist/module.js",
      exports: { ".": { default: "./dist/export.js" } },
    }));
    await writeFile(join(root, "dist/module.js"), 'export default "unused-module";\n');
    await writeFile(join(root, "dist/export.js"), 'export default "actual-export";\n');

    const consumerRoot = join(root, "..", "entry-consumer");
    await mkdir(join(consumerRoot, "node_modules"), { recursive: true });
    await symlink(root, join(consumerRoot, "node_modules", "tscircuit"));
    await expect(fingerprintInstalledPackageClosure(root, {
      entryPath: join(root, "dist/module.js"),
      resolutionOrigin: consumerRoot,
    })).rejects.toThrow("differs from the executed entrypoint");
  });

  test("binds package resources reached through createRequire instead of static imports", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js", dependencies: { phantom: "1.0.0" },
    }));
    await writeFile(join(root, "index.js"),
      'import { createRequire } from "node:module"; export default createRequire(import.meta.url)("phantom");\n');
    const phantom = join(root, "node_modules", "phantom");
    await mkdir(phantom, { recursive: true });
    await writeFile(join(phantom, "package.json"), JSON.stringify({
      name: "phantom", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(phantom, "index.js"), 'export default "first";\n');
    await writeFile(join(phantom, "data.json"), '{"value":"first"}\n');
    const first = await fingerprintInstalledPackageClosure(root);
    await writeFile(join(phantom, "data.json"), '{"value":"second"}\n');
    expect(await fingerprintInstalledPackageClosure(root)).not.toBe(first);
  });

  test("ignores unrelated consumer packages outside the declared engine closure", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(root, "index.js"), 'export default "engine";\n');
    const consumerRoot = join(root, "..", "ambient-consumer");
    const phantom = join(consumerRoot, "node_modules", "phantom");
    await mkdir(phantom, { recursive: true });
    await symlink(root, join(consumerRoot, "node_modules", "tscircuit"));
    await writeFile(join(phantom, "package.json"), JSON.stringify({
      name: "phantom", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(phantom, "index.js"), 'export default "first";\n');
    const entryPath = Bun.resolveSync("tscircuit", consumerRoot);
    const first = await fingerprintInstalledPackageClosure(root, { entryPath, resolutionOrigin: consumerRoot });
    await writeFile(join(phantom, "index.js"), 'export default "second";\n');
    expect(await fingerprintInstalledPackageClosure(root, { entryPath, resolutionOrigin: consumerRoot })).toBe(first);
  });

  test("rejects an undeclared nested package slot reachable by computed loaders", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(root, "index.js"),
      'import { createRequire } from "node:module"; export default createRequire(import.meta.url)("phantom");\n');
    const phantom = join(root, "node_modules", "phantom");
    await mkdir(phantom, { recursive: true });
    await writeFile(join(phantom, "package.json"), JSON.stringify({
      name: "phantom", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(phantom, "index.js"), 'export default "first";\n');

    await expect(fingerprintInstalledPackageClosure(root)).rejects.toThrow(
      /undeclared installed package slot .*phantom/,
    );
  });

  test("rejects a wrong-name package unless the dependency is an explicit npm alias", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js", dependencies: { dependency: "1.0.0" },
    }));
    await writeFile(join(root, "index.js"), 'import value from "dependency"; export default value;\n');
    const nearest = join(root, "node_modules", "dependency");
    await mkdir(nearest, { recursive: true });
    await writeFile(join(nearest, "package.json"), JSON.stringify({
      name: "decoy-name", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(nearest, "index.js"), 'export default "nearest";\n');
    const cleanAncestor = join(root, "..", "node_modules", "dependency");
    await mkdir(cleanAncestor, { recursive: true });
    await writeFile(join(cleanAncestor, "package.json"), JSON.stringify({
      name: "dependency", version: "1.0.0", main: "index.js",
    }));
    await writeFile(join(cleanAncestor, "index.js"), 'export default "ancestor";\n');
    await expect(fingerprintInstalledPackageClosure(root)).rejects.toThrow(
      "without an explicit npm alias",
    );

    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "tscircuit", version: "1.0.0", main: "index.js",
      dependencies: { dependency: "npm:decoy-name@1.0.0" },
    }));
    await expect(fingerprintInstalledPackageClosure(root)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  test.skipIf(process.platform === "win32")(
    "distinguishes a direct dependency directory from a package link",
    async () => {
      const root = await temporaryPackage();
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "tscircuit", version: "1.0.0", main: "index.js",
        dependencies: { dependency: "1.0.0" },
      }));
      await writeFile(join(root, "index.js"), 'import value from "dependency"; export default value;\n');
      const direct = join(root, "node_modules", "dependency");
      await mkdir(direct, { recursive: true });
      await writeFile(join(direct, "package.json"), JSON.stringify({
        name: "dependency", version: "1.0.0", main: "index.js",
      }));
      await writeFile(join(direct, "index.js"), 'export default "same";\n');
      const directoryDigest = await fingerprintInstalledPackageClosure(root);

      const stored = join(root, "..", "dependency-store");
      await rename(direct, stored);
      await symlink(stored, direct, "dir");
      expect(await fingerprintInstalledPackageClosure(root)).not.toBe(directoryDigest);
    },
  );

  test.skipIf(process.platform === "win32")(
    "binds package command-link topology under node_modules/.bin",
    async () => {
      const root = await temporaryPackage();
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "tscircuit", version: "1.0.0", main: "index.js",
        dependencies: { a: "1.0.0", b: "1.0.0" },
      }));
      await writeFile(join(root, "index.js"), 'export default "engine";\n');
      for (const name of ["a", "b"]) {
        const packageRoot = join(root, "node_modules", name);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({
          name, version: "1.0.0", main: "index.js", bin: { tool: "cli.js" },
        }));
        await writeFile(join(packageRoot, "index.js"), `export default ${JSON.stringify(name)};\n`);
        await writeFile(join(packageRoot, "cli.js"), `console.log(${JSON.stringify(name)});\n`);
      }
      const binRoot = join(root, "node_modules", ".bin");
      await mkdir(binRoot);
      const command = join(binRoot, "tool");
      await symlink("../a/cli.js", command);
      const first = await fingerprintInstalledPackageClosure(root);
      await rm(command);
      await symlink("../b/cli.js", command);
      expect(await fingerprintInstalledPackageClosure(root)).not.toBe(first);

      await expect(fingerprintInstalledPackageClosure(root, {
        beforeFinalInventory: async () => {
          await rm(command);
          await symlink("../a/cli.js", command);
        },
      })).rejects.toThrow("changed during fingerprinting");
    },
  );

  test.skipIf(process.platform === "win32")(
    "binds Bun tuple-level command links and rejects targets outside the closure",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "fulmetry-bun-tuple-bin-"));
      temporaryRoots.push(parent);
      const modules = join(parent, "node_modules", ".bun", "tscircuit@1.0.0", "node_modules");
      const root = join(modules, "tscircuit");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "tscircuit", version: "1.0.0", main: "index.js",
        dependencies: { a: "1.0.0", b: "1.0.0" },
      }));
      await writeFile(join(root, "index.js"), 'export default "engine";\n');
      for (const name of ["a", "b"]) {
        const packageRoot = join(modules, name);
        await mkdir(packageRoot);
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({
          name, version: "1.0.0", main: "index.js", bin: { tool: "cli.js" },
        }));
        await writeFile(join(packageRoot, "index.js"), `export default ${JSON.stringify(name)};\n`);
        await writeFile(join(packageRoot, "cli.js"), `console.log(${JSON.stringify(name)});\n`);
      }
      const binRoot = join(modules, ".bin");
      await mkdir(binRoot);
      const command = join(binRoot, "tool");
      await symlink("../a/cli.js", command);
      const first = await fingerprintInstalledPackageClosure(root);
      await rm(command);
      await symlink("../b/cli.js", command);
      expect(await fingerprintInstalledPackageClosure(root)).not.toBe(first);

      const evil = join(parent, "evil");
      await mkdir(evil);
      await writeFile(join(evil, "cli.js"), 'console.log("evil");\n');
      await rm(command);
      await symlink("../../../../../evil/cli.js", command);
      await expect(fingerprintInstalledPackageClosure(root)).rejects.toThrow(
        "outside the authenticated package closure",
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a dependency-layout switch after graph capture",
    async () => {
      const root = await temporaryPackage();
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "tscircuit", version: "1.0.0", main: "index.js", dependencies: { dependency: "1.0.0" },
      }));
      await writeFile(join(root, "index.js"), 'import value from "dependency"; export default value;\n');
      const store = join(root, "..", "store");
      for (const name of ["a", "b"]) {
        const directory = join(store, name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify({
          name: "dependency", version: "1.0.0", main: "index.js",
        }));
        await writeFile(join(directory, "index.js"), `export default ${JSON.stringify(name)};\n`);
      }
      await mkdir(join(root, "node_modules"), { recursive: true });
      const link = join(root, "node_modules", "dependency");
      await symlink(join(store, "a"), link, "dir");
      await expect(fingerprintInstalledPackageClosure(root, {
        beforeFinalInventory: async () => {
          await rm(link);
          await symlink(join(store, "b"), link, "dir");
        },
      })).rejects.toThrow(/changed during fingerprinting|changed after graph capture/);
    },
  );

  test("rejects an oversized sparse file before reading it", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "oversized.bin"), "");
    await truncate(
      join(root, "oversized.bin"),
      ENGINE_PACKAGE_FILE_BYTES_LIMIT + 1,
    );

    expect(fingerprintEnginePackage(root)).rejects.toThrow(
      `exceeds ${ENGINE_PACKAGE_FILE_BYTES_LIMIT} bytes`,
    );
  });

  test("rejects excessive aggregate sparse bytes", async () => {
    const root = await temporaryPackage();
    const fileSize = Math.floor(ENGINE_PACKAGE_TOTAL_BYTES_LIMIT / 3) + 1;
    for (const name of ["one.bin", "two.bin", "three.bin", "four.bin"]) {
      await writeFile(join(root, name), "");
      await truncate(join(root, name), fileSize);
    }

    expect(fingerprintEnginePackage(root)).rejects.toThrow(
      `exceeds ${ENGINE_PACKAGE_TOTAL_BYTES_LIMIT} aggregate bytes`,
    );
  });

  test("rejects excessive breadth before retaining an unbounded inventory", async () => {
    const root = await temporaryPackage();
    const paths = Array.from(
      { length: ENGINE_PACKAGE_ENTRY_LIMIT + 1 },
      (_, index) => join(root, `entry-${index.toString().padStart(5, "0")}`),
    );
    for (let offset = 0; offset < paths.length; offset += 256) {
      await Promise.all(paths.slice(offset, offset + 256).map((path) => writeFile(path, "")));
    }

    expect(fingerprintEnginePackage(root)).rejects.toThrow(
      `exceeds ${ENGINE_PACKAGE_ENTRY_LIMIT} entries`,
    );
  });

  test("rejects excessive directory depth", async () => {
    const root = await temporaryPackage();
    let directory = root;
    for (let depth = 0; depth <= ENGINE_PACKAGE_DEPTH_LIMIT; depth += 1) {
      directory = join(directory, "d");
      await mkdir(directory);
    }

    expect(fingerprintEnginePackage(root)).rejects.toThrow(
      `exceeds directory depth ${ENGINE_PACKAGE_DEPTH_LIMIT}`,
    );
  });

  test("rejects files added after content hashing", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "index.js"), "engine\n");

    expect(
      fingerprintEnginePackage(root, {
        beforeFinalInventory: async (canonicalRoot) => {
          await writeFile(join(canonicalRoot, "late.js"), "late\n");
        },
      }),
    ).rejects.toThrow(/changed during fingerprinting|directory changed/);
  });

  test("rejects a root swapped for a byte-identical directory", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "index.js"), "engine\n");

    expect(
      fingerprintEnginePackage(root, {
        beforeFinalInventory: async (canonicalRoot) => {
          await rename(canonicalRoot, `${canonicalRoot}-original`);
          await mkdir(canonicalRoot);
          await writeFile(join(canonicalRoot, "index.js"), "engine\n");
        },
      }),
    ).rejects.toThrow(/changed during fingerprinting/);
  });

  test("rejects content restored to the same bytes after hashing", async () => {
    const root = await temporaryPackage();
    const entry = join(root, "index.js");
    await writeFile(entry, "engine\n");

    expect(
      fingerprintEnginePackage(root, {
        beforeFinalInventory: async () => {
          await writeFile(entry, "altered\n");
          await writeFile(entry, "engine\n");
        },
      }),
    ).rejects.toThrow(/changed during fingerprinting/);
  });

  test("rejects an early file changed after its final identity check", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "a.js"), "first\n");
    await writeFile(join(root, "b.js"), "second\n");

    expect(
      fingerprintEnginePackage(root, {
        beforeFinalIdentityCheck: async (canonicalRoot, _path, index) => {
          if (index === 1) await writeFile(join(canonicalRoot, "a.js"), "altered\n");
        },
      }),
    ).rejects.toThrow(/changed during final fingerprint verification/);
  });

  test("does not trust a poisoned Array iterator to enumerate captured files", async () => {
    const root = await temporaryPackage();
    await writeFile(join(root, "index.js"), "engine\n");
    const expected = await fingerprintEnginePackage(root);
    const originalIterator = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = function () {
      const first = this[0] as unknown;
      if (
        Object.isFrozen(this) &&
        first !== null &&
        typeof first === "object" &&
        "path" in first &&
        "size" in first
      ) return originalIterator.call([]);
      return originalIterator.call(this);
    };
    try {
      expect(await fingerprintEnginePackage(root)).toBe(expected);
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
  });

  test("invalidates the in-process fingerprint cache after package mutation", async () => {
    const root = await temporaryPackage();
    const entry = join(root, "index.js");
    await writeFile(entry, "first\n");
    const first = await fingerprintEnginePackage(root);
    expect(await fingerprintEnginePackage(root)).toBe(first);
    await writeFile(entry, "second\n");
    expect(await fingerprintEnginePackage(root)).not.toBe(first);
  });

  test("bounds package metadata before allocating its bytes", async () => {
    const root = await temporaryPackage();
    const metadataPath = join(root, "package.json");
    await writeFile(metadataPath, "");
    await truncate(metadataPath, ENGINE_PACKAGE_METADATA_BYTES_LIMIT + 1);

    expect(readStableEnginePackageFile(metadataPath)).rejects.toThrow(
      `exceeds ${ENGINE_PACKAGE_METADATA_BYTES_LIMIT} bytes`,
    );
  });
});
