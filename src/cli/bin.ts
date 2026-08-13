#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT

import { argumentFailure, runCli, unsupportedBunRuntimeRun } from "./runner";
import { startDevCommand, waitForDevShutdown } from "./dev";
import { UnsupportedBunRuntimeError } from "../runtime";

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (argv[0] === "dev") {
    try {
      const started = await startDevCommand({ argv: argv.slice(1) });
      await Bun.write(Bun.stdout, started.stdout);
      await waitForDevShutdown();
      await started.server.stop();
      return 0;
    } catch (error) {
      if (error instanceof UnsupportedBunRuntimeError) {
        const failure = unsupportedBunRuntimeRun(
          argv.includes("--json"),
          "pcboo dev",
        );
        if (failure.stdout) await Bun.write(Bun.stdout, failure.stdout);
        if (failure.stderr) await Bun.write(Bun.stderr, failure.stderr);
        return failure.exitCode;
      }
      const failure = argumentFailure(
        error instanceof Error ? error.message : String(error),
        argv.includes("--json"),
        "pcboo dev",
      );
      if (failure.stdout) await Bun.write(Bun.stdout, failure.stdout);
      if (failure.stderr) await Bun.write(Bun.stderr, failure.stderr);
      return failure.exitCode;
    }
  }
  const run = await runCli({ argv });
  if (run.stdout) await Bun.write(Bun.stdout, run.stdout);
  if (run.stderr) await Bun.write(Bun.stderr, run.stderr);
  return run.exitCode;
}

if (import.meta.main) process.exitCode = await main();
