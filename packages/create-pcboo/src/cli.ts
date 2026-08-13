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

if (import.meta.main) {
  try {
    const parsed = parseCreateArguments(process.argv.slice(2));
    const result = await scaffoldPcbooProject({ cwd: process.cwd(), ...parsed });
    process.stdout.write(`Created PCBoo project at ${result.root}\n${result.installed ? "Dependencies installed." : "Run bun install before building."}\n`);
  } catch (error) {
    if (error instanceof Error && error.message === "help") {
      process.stdout.write(CREATE_PCBOO_HELP);
      process.exit(0);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
