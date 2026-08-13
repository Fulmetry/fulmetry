#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { scaffoldPcbooProject } from "./scaffold";

export function parseCreateArguments(argv: readonly string[]): Readonly<{ directory: string; install: boolean }> {
  let directory: string | undefined;
  let install = true;
  for (const argument of argv) {
    if (argument === "--no-install") install = false;
    else if (argument === "--help" || argument === "-h") throw new Error("help");
    else if (argument.startsWith("-")) throw new TypeError(`Unknown option ${argument}`);
    else if (directory === undefined) directory = argument;
    else throw new TypeError("create-pcboo accepts at most one project directory");
  }
  return Object.freeze({ directory: directory ?? "pcboo-project", install });
}

export const CREATE_PCBOO_HELP = `create-pcboo [directory] [--no-install]\n\nCreate one composable PCBoo TypeScript project.\n`;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<number> {
  try {
    const parsed = parseCreateArguments(argv);
    const result = await scaffoldPcbooProject({ cwd, ...parsed });
    process.stdout.write(`Created PCBoo project at ${result.root}\n${result.installed ? "Dependencies installed." : "Run bun install before building."}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === "help") {
      process.stdout.write(CREATE_PCBOO_HELP);
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
