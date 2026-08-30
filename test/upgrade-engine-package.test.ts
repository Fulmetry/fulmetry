import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTscircuitCandidatePackage } from "../src/upgrade/engine-package";

const temporaryRoots: string[] = [];
const VALID_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fulmetry-candidate-engine-"));
  temporaryRoots.push(root);
  return root;
}

async function candidatePackage(
  parent: string,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const root = join(parent, "tscircuit");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "index.js"), "export class Circuit {}\n");
  await writeFile(join(root, "README.md"), "candidate\n");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "tscircuit",
    version: "1.2.3-next.1",
    type: "module",
    main: "dist/index.js",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    ...metadata,
  }, null, 2)}\n`);
  await writeFile(join(root, "dist", "index.d.ts"), "export declare class Circuit {}\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("candidate tscircuit package inspection", () => {
  test("returns a frozen descriptor for an explicit package without executing its entrypoint", async () => {
    const parent = await temporaryRoot();
    const root = await candidatePackage(parent);
    await writeFile(join(root, "dist", "index.js"), "throw new Error('must not execute candidate')\n");

    const descriptor = await inspectTscircuitCandidatePackage({
      packageDirectory: root,
      integrity: VALID_INTEGRITY,
    });
    const realRoot = await realpath(root);

    expect(Object.isFrozen(descriptor)).toBeTrue();
    expect(descriptor).toMatchObject({
      realPackageRoot: realRoot,
      entryPath: join(realRoot, "dist", "index.js"),
      version: "1.2.3-next.1",
      integrity: VALID_INTEGRITY,
    });
    expect(descriptor.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptor.runtimeClosureSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("canonicalizes an explicit package-directory symlink but rejects links inside the package", async () => {
    const parent = await temporaryRoot();
    const root = await candidatePackage(parent);
    const alias = join(parent, "candidate-alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");

    expect((await inspectTscircuitCandidatePackage({ packageDirectory: alias, integrity: VALID_INTEGRITY })).realPackageRoot)
      .toBe(await realpath(root));

    await symlink(join(root, "README.md"), join(root, "linked-readme"));
    expect(inspectTscircuitCandidatePackage({ packageDirectory: root, integrity: VALID_INTEGRITY }))
      .rejects.toThrow("contains a symlink");
  });

  test("fingerprints paths and bytes deterministically, independent of creation order", async () => {
    const parentA = await temporaryRoot();
    const parentB = await temporaryRoot();
    const first = await candidatePackage(parentA);
    const second = join(parentB, "tscircuit");
    await mkdir(join(second, "dist"), { recursive: true });
    for (const path of ["package.json", "README.md", "dist/index.d.ts", "dist/index.js"]) {
      await writeFile(join(second, path), await Bun.file(join(first, path)).bytes());
    }

    const [left, right] = await Promise.all([
      inspectTscircuitCandidatePackage({ packageDirectory: first, integrity: VALID_INTEGRITY }),
      inspectTscircuitCandidatePackage({ packageDirectory: second, integrity: VALID_INTEGRITY }),
    ]);
    expect(left.contentSha256).toBe(right.contentSha256);

    await writeFile(join(second, "README.md"), "changed\n");
    const changed = await inspectTscircuitCandidatePackage({ packageDirectory: second, integrity: VALID_INTEGRITY });
    expect(changed.contentSha256).not.toBe(left.contentSha256);
  });

  test("rejects missing or unsafe package identity metadata", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: "not-tscircuit" }, "name must be exactly"],
      [{ version: undefined }, "version must be a non-empty"],
      [{ version: "" }, "version must be a non-empty"],
      [{ version: "1.2.3/../../evil" }, "unsafe or is not valid semver"],
      [{ main: "../outside.js" }, "traversal path segment"],
      [{ exports: { ".": "../../outside.js" } }, "must start with ./"],
      [{ exports: { ".": "./dist/../outside.js" } }, "traversal path segment"],
    ];
    for (const [metadata, message] of cases) {
      const parent = await temporaryRoot();
      const root = await candidatePackage(parent, metadata);
      await expect(inspectTscircuitCandidatePackage({ packageDirectory: root, integrity: VALID_INTEGRITY }), JSON.stringify(metadata))
        .rejects.toThrow(message);
    }
  });

  test("rejects malformed, non-canonical, and wrong-length SRI values", async () => {
    const parent = await temporaryRoot();
    const root = await candidatePackage(parent);
    for (const integrity of [
      "",
      "sha1-Zm9v",
      "sha512-not_base64!",
      `sha512-${Buffer.alloc(32).toString("base64")}`,
      ` sha512-${Buffer.alloc(64).toString("base64")}`,
    ]) {
      await expect(inspectTscircuitCandidatePackage({ packageDirectory: root, integrity }), integrity)
        .rejects.toThrow(/integrity/i);
    }
  });

  test("rejects a missing entrypoint and a non-directory package input", async () => {
    const parent = await temporaryRoot();
    const root = await candidatePackage(parent, { exports: undefined, main: "dist/missing.js" });
    expect(inspectTscircuitCandidatePackage({ packageDirectory: root, integrity: VALID_INTEGRITY }))
      .rejects.toThrow("entrypoint cannot be resolved");

    const regularFile = join(parent, "regular-file");
    await writeFile(regularFile, "not a package");
    expect(inspectTscircuitCandidatePackage({ packageDirectory: regularFile, integrity: VALID_INTEGRITY }))
      .rejects.toThrow("must resolve to a directory");
  });

  test("rejects special filesystem entries", async () => {
    if (process.platform === "win32") return;
    const parent = await temporaryRoot();
    const root = await candidatePackage(parent);
    const processResult = Bun.spawn(["mkfifo", join(root, "named-pipe")]);
    expect(await processResult.exited).toBe(0);

    await expect(inspectTscircuitCandidatePackage({ packageDirectory: root, integrity: VALID_INTEGRITY }))
      .rejects.toThrow("special filesystem entry");
  });
});
