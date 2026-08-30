// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintTscircuitRuntimeEvidenceImplementation,
  TSCIRCUIT_RUNTIME_EVIDENCE_IMPLEMENTATION_FILES,
} from "../src/upgrade/implementation-identity";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("runtime evidence implementation identity binds every authority source", async () => {
  const sourceRoot = join(import.meta.dir, "..");
  const root = await mkdtemp(join(tmpdir(), "fulmetry-implementation-identity-"));
  roots.push(root);
  for (const path of TSCIRCUIT_RUNTIME_EVIDENCE_IMPLEMENTATION_FILES) {
    const destination = join(root, path);
    await cp(join(sourceRoot, path), destination, { recursive: false });
  }
  const first = await fingerprintTscircuitRuntimeEvidenceImplementation(root);
  for (const path of TSCIRCUIT_RUNTIME_EVIDENCE_IMPLEMENTATION_FILES) {
    const absolute = join(root, path);
    const before = await readFile(absolute);
    await writeFile(absolute, Buffer.concat([before, Buffer.from("\n// authority mutation\n")]));
    expect(await fingerprintTscircuitRuntimeEvidenceImplementation(root)).not.toBe(first);
    await writeFile(absolute, before);
    expect(await fingerprintTscircuitRuntimeEvidenceImplementation(root)).toBe(first);
  }
});
