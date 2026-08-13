// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Request {
  readonly command: readonly string[];
  readonly cgroup: string;
  readonly resultPath: string;
}

function parseRequest(payload: string | undefined): Readonly<Request> {
  if (payload === undefined) throw new TypeError("Linux containment payload is missing");
  const value = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Partial<Request>;
  if (
    !Array.isArray(value.command) || value.command.length === 0 ||
    !value.command.every((part) => typeof part === "string") ||
    typeof value.cgroup !== "string" || !value.cgroup.startsWith("/sys/fs/cgroup/") ||
    typeof value.resultPath !== "string" || !value.resultPath.startsWith("/")
  ) throw new TypeError("Linux containment payload is invalid");
  return value as Request;
}

const request = parseRequest(process.argv[2]);
const resultHandle = await open(request.resultPath, "wx");
let containmentApplied = false;
let childExitCode = 1;
let orphanPids: number[] = [];
let errorMessage: string | null = null;
try {
  await writeFile(join(request.cgroup, "cgroup.procs"), String(process.pid));
  const membership = (await readFile(join(request.cgroup, "cgroup.procs"), "utf8"))
    .split(/\r?\n/u).map(Number);
  if (!membership.includes(process.pid)) throw new Error("runner did not enter the delegated cgroup");
  containmentApplied = true;
  const child = Bun.spawn({
    cmd: [...request.command],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  childExitCode = await child.exited;
  orphanPids = (await readFile(join(request.cgroup, "cgroup.procs"), "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter((pid) => pid !== "" && pid !== String(process.pid))
    .map(Number);
} catch (error) {
  errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
const record = new TextEncoder().encode(JSON.stringify({
  containmentApplied,
  childExitCode,
  orphanPids,
  error: errorMessage,
}));
await resultHandle.writeFile(record);
await resultHandle.sync();
await resultHandle.close();
if (!containmentApplied || errorMessage !== null) process.exitCode = 87;
else if (orphanPids.length > 0) process.exitCode = 86;
else process.exitCode = childExitCode;
