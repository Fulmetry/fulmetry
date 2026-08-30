// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { spawnContainedProcess } from "../../src/internal/contained-process";

const target = [
  'try { process.kill(process.ppid, "SIGKILL"); process.stdout.write("SIGNAL_ALLOWED\\n"); }',
  'catch (error) { process.stdout.write("SIGNAL_DENIED:" + (error instanceof Error ? error.message : String(error)) + "\\n"); }',
].join("\n");
const child = await spawnContainedProcess({
  command: [process.execPath, "-e", target],
  env: { PATH: process.env.PATH ?? "" },
});
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();
const exitCode = await child.exited;
process.stdout.write(JSON.stringify({ exitCode, stdout: await stdout, stderr: await stderr }));
