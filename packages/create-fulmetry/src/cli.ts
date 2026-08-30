#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { scaffoldFulmetryProject } from "./scaffold";

export function parseCreateArguments(argv: readonly string[]): Readonly<{ directory: string; install: boolean; skills: boolean }> {
  let directory: string | undefined;
  let install = true;
  let skills = true;
  for (const argument of argv) {
    if (argument === "--no-install") install = false;
    else if (argument === "--no-skills") skills = false;
    else if (argument === "--help" || argument === "-h") throw new Error("help");
    else if (argument.startsWith("-")) throw new TypeError(`Unknown option ${argument}`);
    else if (directory === undefined) directory = argument;
    else throw new TypeError("create-fulmetry accepts at most one project directory");
  }
  return Object.freeze({ directory: directory ?? "fulmetry-project", install, skills });
}

export const CREATE_FULMETRY_HELP = `create-fulmetry [directory] [--no-install] [--no-skills]\n\nCreate one composable Fulmetry TypeScript project with project-local Agent Skills by default.\n`;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<number> {
  try {
    const parsed = parseCreateArguments(argv);
    const result = await scaffoldFulmetryProject({ cwd, ...parsed });
    process.stdout.write(`Created Fulmetry project at ${result.root}\n${result.installed ? "Dependencies installed." : "Run bun install before building."}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === "help") {
      process.stdout.write(CREATE_FULMETRY_HELP);
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
