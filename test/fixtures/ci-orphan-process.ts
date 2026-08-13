// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { readFile, writeFile } from "node:fs/promises";

const [mode, recordPath, nonce] = process.argv.slice(2);
if (recordPath === undefined || nonce === undefined) {
  throw new TypeError("orphan fixture requires a record path and nonce");
}

function environmentWithoutContainmentToken(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([name, value]) => name !== "PCBOO_CI_CONTAINMENT_TOKEN" && value !== undefined)) as Record<string, string>;
}

if (mode === "child") {
  await writeFile(recordPath, JSON.stringify({
    pid: process.pid,
    nonce,
    startedAtUnixMilliseconds: Date.now(),
  }));
  await new Promise<never>(() => undefined);
} else if (mode === "parent") {
  const child = Bun.spawn([
    process.execPath,
    import.meta.path,
    "child",
    recordPath,
    nonce,
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8")) as { nonce?: string };
      if (record.nonce === nonce) break;
    } catch {
      // Wait for the detached child to publish its exact identity.
    }
    await Bun.sleep(10);
  }
  await Bun.sleep(100);
} else if (mode === "immediate-parent" || mode === "immediate-scrubbed-parent") {
  const childRecordPath = `${recordPath}.child`;
  const child = Bun.spawn([
    process.execPath,
    import.meta.path,
    "child",
    childRecordPath,
    nonce,
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    ...(mode === "immediate-scrubbed-parent" ? { env: environmentWithoutContainmentToken() } : {}),
  });
  child.unref();
  await writeFile(`${recordPath}.parent`, JSON.stringify({
    pid: child.pid,
    nonce,
    startedAtUnixMilliseconds: Date.now(),
  }));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(childRecordPath, "utf8")) as { nonce?: string };
      if (record.nonce === nonce) break;
    } catch {
      // Exit immediately after the new-session child proves that it ran.
    }
    await Bun.sleep(1);
  }
} else if (mode === "double-fork-parent") {
  const intermediate = Bun.spawn([
    process.execPath,
    import.meta.path,
    "immediate-parent",
    recordPath,
    nonce,
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  intermediate.unref();
  await intermediate.exited;
} else if (mode === "double-fork-scrubbed-parent") {
  const intermediate = Bun.spawn([
    process.execPath,
    import.meta.path,
    "immediate-scrubbed-parent",
    recordPath,
    nonce,
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  intermediate.unref();
  await intermediate.exited;
} else {
  throw new TypeError(`unknown orphan fixture mode: ${mode ?? "missing"}`);
}
