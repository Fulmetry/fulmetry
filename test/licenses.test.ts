import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISTRIBUTED_PACKAGE_LICENSES,
  renderThirdPartyNotices,
  requireDistributionPackageReady,
  validateDistributionLicenses,
} from "../src/licenses";

describe("distribution licensing and attribution", () => {
  test("the checked-in notice is deterministically generated from every direct distribution pin", async () => {
    expect(await Bun.file(join(import.meta.dir, "../THIRD_PARTY_NOTICES.md")).text()).toBe(
      renderThirdPartyNotices(),
    );
    expect(renderThirdPartyNotices()).toContain("does not relicense user circuit source");
    for (const dependency of DISTRIBUTED_PACKAGE_LICENSES) {
      expect(renderThirdPartyNotices()).toContain(`| ${dependency.name} | ${dependency.version} |`);
    }
  });

  test("the notice graph exactly matches root runtime, optional, and peer declarations", async () => {
    const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json() as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = Object.entries({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    }).sort(([left], [right]) => left.localeCompare(right));
    const noticed = DISTRIBUTED_PACKAGE_LICENSES
      .map(({ name, version }) => [name, version] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    expect(JSON.stringify(noticed)).toBe(JSON.stringify(declared));
  });

  test("validates installed package text or an exact pinned SPDX metadata fallback", async () => {
    expect(await validateDistributionLicenses(join(import.meta.dir, "../node_modules"))).toEqual([]);
  });

  test("enforces licensing at both registry-package prepack boundaries", async () => {
    const root = join(import.meta.dir, "..");
    await expect(requireDistributionPackageReady({
      packageRoot: root,
      nodeModulesRoot: join(root, "node_modules"),
    })).resolves.toBeUndefined();
    await expect(requireDistributionPackageReady({
      packageRoot: join(root, "packages/create-pcboo"),
      nodeModulesRoot: join(root, "node_modules"),
    })).resolves.toBeUndefined();

    const rootManifest = await Bun.file(join(root, "package.json")).json() as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const creatorManifest = await Bun.file(join(root, "packages/create-pcboo/package.json")).json() as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(rootManifest.scripts?.prepack).toBe("bun ./scripts/validate-package-boundary.ts");
    expect(creatorManifest.scripts?.prepack).toBe("bun ../../scripts/validate-package-boundary.ts");
    expect(rootManifest.bin).toEqual({ pcboo: "src/cli/pcboo.js" });
    expect(creatorManifest.bin).toEqual({ "create-pcboo": "src/create-pcboo.js" });
  });

  test("rejects unqualified optional dependencies at both registry package boundaries", async () => {
    const repositoryRoot = join(import.meta.dir, "..");
    for (const [packageName, sourceRoot] of [
      ["pcboo", repositoryRoot],
      ["create-pcboo", join(repositoryRoot, "packages/create-pcboo")],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `pcboo-optional-${packageName}-`));
      try {
        const manifest = await Bun.file(join(sourceRoot, "package.json")).json() as Record<string, unknown>;
        manifest.optionalDependencies = { "unreviewed-optional-package": "1.0.0" };
        await Bun.write(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
        await Bun.write(join(root, "LICENSE"), await Bun.file(join(sourceRoot, "LICENSE")).text());
        await Bun.write(join(root, "README.md"), "fixture\n");
        if (packageName === "pcboo") {
          await Bun.write(
            join(root, "THIRD_PARTY_NOTICES.md"),
            await Bun.file(join(repositoryRoot, "THIRD_PARTY_NOTICES.md")).text(),
          );
        }
        await mkdir(join(root, "src"));
        await Bun.write(
          join(root, "src/index.ts"),
          "// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nexport {};\n",
        );

        await expect(requireDistributionPackageReady({
          packageRoot: root,
          nodeModulesRoot: join(repositoryRoot, "node_modules"),
        }), packageName).rejects.toThrow(
          packageName === "pcboo"
            ? "qualified notice graph"
            : "explicit notice policy",
        );
      } finally {
        await rm(root, { recursive: true });
      }
    }
  });

  test("rejects an incomplete own license and an unqualified package inventory before packing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-package-boundary-"));
    try {
      await Bun.write(join(root, "LICENSE"), "MIT License\nPermission is hereby granted, free of charge\n");
      await Bun.write(join(root, "README.md"), "fixture\n");
      await mkdir(join(root, "src"));
      await Bun.write(join(root, "package.json"), JSON.stringify({
        name: "create-pcboo",
        version: "1.0.0",
        license: "MIT",
        files: ["src", "README.md", "LICENSE"],
      }));
      await expect(requireDistributionPackageReady({ packageRoot: root })).rejects
        .toThrow("complete reviewed MIT license");

      await Bun.write(join(root, "LICENSE"), await Bun.file(join(import.meta.dir, "../LICENSE")).text());
      await Bun.write(join(root, "package.json"), JSON.stringify({
        name: "create-pcboo",
        version: "1.0.0",
        license: "MIT",
        files: ["src", "README.md", "LICENSE", "vendor"],
      }));
      await expect(requireDistributionPackageReady({ packageRoot: root })).rejects
        .toThrow("qualified distribution inventory");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("rejects a nested unqualified code or dependency addition under the packaged source tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-packaged-source-"));
    try {
      const repositoryRoot = join(import.meta.dir, "..");
      await Bun.write(join(root, "package.json"), await Bun.file(join(repositoryRoot, "package.json")).text());
      await Bun.write(join(root, "LICENSE"), await Bun.file(join(repositoryRoot, "LICENSE")).text());
      await Bun.write(join(root, "README.md"), "fixture\n");
      await Bun.write(
        join(root, "THIRD_PARTY_NOTICES.md"),
        await Bun.file(join(repositoryRoot, "THIRD_PARTY_NOTICES.md")).text(),
      );
      await mkdir(join(root, "src/vendor"), { recursive: true });
      await Bun.write(
        join(root, "src/index.ts"),
        "// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nexport {};\n",
      );
      await Bun.write(
        join(root, "src/vendor/gpl-helper.ts"),
        "// SPDX-License-Identifier: GPL-3.0-only\nexport const copied = true;\n",
      );
      await expect(requireDistributionPackageReady({
        packageRoot: root,
        nodeModulesRoot: join(repositoryRoot, "node_modules"),
      })).rejects.toThrow("unqualified third-party directory");

      await rm(join(root, "src/vendor"), { recursive: true });
      await Bun.write(
        join(root, "src/index.ts"),
        "// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nimport \"unnoticed-package\";\n",
      );
      await expect(requireDistributionPackageReady({
        packageRoot: root,
        nodeModulesRoot: join(repositoryRoot, "node_modules"),
      })).rejects.toThrow("imports unqualified package unnoticed-package");

      await Bun.write(
        join(root, "src/index.ts"),
        "// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nexport {};\n",
      );
      await Bun.write(join(root, "src/unqualified.ps1"), "# arbitrary packaged program\n");
      await expect(requireDistributionPackageReady({
        packageRoot: root,
        nodeModulesRoot: join(repositoryRoot, "node_modules"),
      })).rejects.toThrow("unqualified non-TypeScript asset unqualified.ps1");

      await rm(join(root, "src/unqualified.ps1"));
      await mkdir(join(root, "src/internal"));
      await Bun.write(
        join(root, "src/internal/windows-job-runner.ps1"),
        "# wrong provenance\n",
      );
      await expect(requireDistributionPackageReady({
        packageRoot: root,
        nodeModulesRoot: join(repositoryRoot, "node_modules"),
      })).rejects.toThrow("lacks reviewed PCBoo provenance headers: internal/windows-job-runner.ps1");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("applies the recursive source-provenance boundary to create-pcboo", async () => {
    const root = await mkdtemp(join(tmpdir(), "create-pcboo-packaged-source-"));
    try {
      const creatorRoot = join(import.meta.dir, "../packages/create-pcboo");
      await Bun.write(join(root, "package.json"), await Bun.file(join(creatorRoot, "package.json")).text());
      await Bun.write(join(root, "LICENSE"), await Bun.file(join(creatorRoot, "LICENSE")).text());
      await Bun.write(join(root, "README.md"), "fixture\n");
      await mkdir(join(root, "src/vendor"), { recursive: true });
      await Bun.write(
        join(root, "src/cli.ts"),
        "#!/usr/bin/env bun\n// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nexport {};\n",
      );
      await Bun.write(
        join(root, "src/vendor/gpl-helper.ts"),
        "// SPDX-License-Identifier: GPL-3.0-only\nexport const copied = true;\n",
      );
      await expect(requireDistributionPackageReady({ packageRoot: root })).rejects
        .toThrow("unqualified third-party directory");

      await rm(join(root, "src/vendor"), { recursive: true });
      await Bun.write(
        join(root, "src/cli.ts"),
        "#!/usr/bin/env bun\n// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nimport {\n  default as helper\n} from \"unnoticed-multiline-package\";\nvoid helper;\n",
      );
      await expect(requireDistributionPackageReady({ packageRoot: root })).rejects
        .toThrow("imports unqualified package unnoticed-multiline-package");

      await Bun.write(
        join(root, "src/cli.ts"),
        "#!/usr/bin/env bun\n// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nconst value = `${(await import(\"unnoticed-interpolation-package\")).default}`;\nvoid value;\n",
      );
      await expect(requireDistributionPackageReady({ packageRoot: root })).rejects
        .toThrow("imports unqualified package unnoticed-interpolation-package");

      await Bun.write(
        join(root, "src/cli.ts"),
        "#!/usr/bin/env bun\n// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\nconst packageName = process.env.PCBOO_HELPER ?? \"unnoticed-variable-package\";\nawait import(packageName);\n",
      );
      await expect(requireDistributionPackageReady({ packageRoot: root })).rejects
        .toThrow("uses non-literal dynamic import");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("rejects runtime module loaders that can hide undeclared packaged dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-hidden-runtime-loader-"));
    try {
      const repositoryRoot = join(import.meta.dir, "..");
      await Bun.write(join(root, "package.json"), await Bun.file(join(repositoryRoot, "package.json")).text());
      await Bun.write(join(root, "LICENSE"), await Bun.file(join(repositoryRoot, "LICENSE")).text());
      await Bun.write(join(root, "README.md"), "fixture\n");
      await Bun.write(
        join(root, "THIRD_PARTY_NOTICES.md"),
        await Bun.file(join(repositoryRoot, "THIRD_PARTY_NOTICES.md")).text(),
      );
      await mkdir(join(root, "src"));
      const header = "// SPDX-FileCopyrightText: 2026 PCBoo contributors\n// SPDX-License-Identifier: MIT\n";
      const attacks = [
        'import { createRequire as makeLoader } from "node:module";\nconst load = makeLoader(import.meta.url);\nexport const hidden = load("react");',
        'import * as moduleApi from "node:module";\nconst load = moduleApi.createRequire(import.meta.url);\nexport const hidden = load("react");',
        'import moduleApi from "node:module";\nconst key = "createRequire";\nconst load = moduleApi[key](import.meta.url);\nexport const hidden = load("react");',
        'const hiddenRequire = require;\nexport const hidden = hiddenRequire("react");',
        'export const hidden = import.meta.require("react");',
        'const loaderName = "require";\nexport const hidden = globalThis[loaderName]("react");',
        'const moduleApi = await import("node:module");\nexport const hidden = moduleApi.createRequire(import.meta.url)("react");',
        'export const hidden = eval("require")("react");',
        'const builtinGetter = "getBuiltin" + "Module";\nconst loaderFactory = "create" + "Require";\nconst moduleApi = process[builtinGetter]("module");\nconst load = moduleApi[loaderFactory](import.meta.url);\nexport const hidden = load("react");',
        'const moduleApi = process.getBuiltinModule("module");\nexport const hidden = moduleApi.createRequire(import.meta.url)("react");',
      ] as const;

      for (const attack of attacks) {
        await Bun.write(join(root, "src/hidden-runtime-dependency.ts"), `${header}${attack}\n`);
        await expect(requireDistributionPackageReady({
          packageRoot: root,
          nodeModulesRoot: join(repositoryRoot, "node_modules"),
        }), attack).rejects.toThrow(
          "forbids runtime module loaders; use a static declared import",
        );
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("fails a packaging boundary with missing or unproven licenses", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-licenses-"));
    try {
      for (const dependency of DISTRIBUTED_PACKAGE_LICENSES) {
        const packageRoot = join(root, ...dependency.name.split("/"));
        await mkdir(packageRoot, { recursive: true });
        await Bun.write(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: dependency.name, version: dependency.version, license: dependency.license }),
        );
        await Bun.write(join(packageRoot, "LICENSE"), "not authoritative\n");
      }
      const findings = await validateDistributionLicenses(root);
      expect(findings).toHaveLength(DISTRIBUTED_PACKAGE_LICENSES.length);
      for (const finding of findings) {
        expect(finding.message).toContain("does not match reviewed content");
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("requires both exact metadata and pinned SPDX evidence when package text is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-missing-license-"));
    try {
      for (const dependency of DISTRIBUTED_PACKAGE_LICENSES) {
        const packageRoot = join(root, ...dependency.name.split("/"));
        await mkdir(packageRoot, { recursive: true });
        await Bun.write(
          join(packageRoot, "package.json"),
          JSON.stringify({
            name: dependency.name,
            version: dependency.version,
            ...(dependency.name === "circuit-json" ? {} : { license: dependency.license }),
          }),
        );
        if (dependency.name !== "circuit-json") {
          const evidence = dependency.license === "MIT"
            ? "MIT License\nPermission is hereby granted, free of charge\n"
            : dependency.license === "ISC"
              ? "ISC License\nPermission to use, copy, modify, and/or distribute\n"
              : "Apache License\nVersion 2.0\n";
          await Bun.write(join(packageRoot, "LICENSE"), evidence);
        }
      }
      const findings = await validateDistributionLicenses(root);
      expect(findings.find(({ package: name }) => name === "circuit-json")?.message)
        .toContain("fallback requires package metadata license ISC");
      expect(findings.find(({ package: name }) => name === "circuit-to-svg")?.message)
        .toContain("does not match reviewed content");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("rejects arbitrary bytes that copy a fallback package's name, version, and SPDX id", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-forged-license-"));
    try {
      const packageRoot = join(root, "circuit-json");
      await mkdir(packageRoot, { recursive: true });
      await Bun.write(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "circuit-json", version: "0.0.464", license: "ISC" }),
      );
      await Bun.write(join(packageRoot, "implementation.js"), "export const forged = true;\n");
      const findings = await validateDistributionLicenses(root);
      expect(findings.find(({ package: name }) => name === "circuit-json")?.message)
        .toContain("does not match reviewed content");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("does not let a marker-only license file bypass pinned fallback package identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcboo-forged-license-text-"));
    try {
      const packageRoot = join(root, "circuit-json");
      await mkdir(packageRoot, { recursive: true });
      await Bun.write(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "circuit-json", version: "0.0.464", license: "ISC" }),
      );
      await Bun.write(
        join(packageRoot, "LICENSE"),
        "ISC License\nPermission to use, copy, modify, and/or distribute\n",
      );
      await Bun.write(join(packageRoot, "implementation.js"), "export const forged = true;\n");
      const findings = await validateDistributionLicenses(root);
      expect(findings.find(({ package: name }) => name === "circuit-json")?.message)
        .toContain("does not match reviewed content");
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
