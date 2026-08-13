// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { realpath } from "node:fs/promises";
import { join } from "node:path";

export const FRESH_PACKAGE_ENTRY_TIMEOUT_MS = 15_000 as const;

/** Resolves a qualified package entry in a short-lived process, avoiding resolver-cache trust. */
export async function resolvePackageEntryFresh(
  specifier: "pcboo" | "tscircuit",
  origin: string,
): Promise<string> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-orphans",
      "--no-install",
      "--no-env-file",
      "--no-macros",
      `--config=${join(import.meta.dir, "empty-bunfig.toml")}`,
      join(import.meta.dir, "resolve-package-entry.ts"),
      specifier,
      origin,
    ],
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? "",
      BUN_CONFIG_NO_NETWORK: "1",
      NO_PROXY: "*",
      no_proxy: "*",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(9), FRESH_PACKAGE_ENTRY_TIMEOUT_MS);
  const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
  ]).finally(() => clearTimeout(timer));
  const stdout = new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytes);
  if (exitCode !== 0 || stderrBytes.byteLength !== 0 || stdout.length === 0 || stdout.length > 32_768) {
    throw new Error("Fresh package entry resolver failed or exceeded its 15 second bound");
  }
  return realpath(stdout);
}


export async function resolveTscircuitEntryFresh(origin: string): Promise<string> {
  return resolvePackageEntryFresh("tscircuit", origin);
}
