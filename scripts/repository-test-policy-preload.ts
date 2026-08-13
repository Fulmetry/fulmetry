#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { describe, test } from "bun:test";

const seen = new WeakSet<Function>();
const reject = (kind: string): never => {
  throw new Error(`PCBOO_REPOSITORY_TEST_POLICY_FORBIDDEN:${kind}`);
};

process.env.PCBOO_REPOSITORY_TEST_POLICY_ACTIVE = "1";

function fixed(target: Function, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function guard(api: Function): void {
  if (seen.has(api)) return;
  seen.add(api);
  for (const key of ["only", "skip", "todo", "failing", "failingIf"]) {
    let candidate: unknown;
    try { candidate = Reflect.get(api, key); } catch { continue; }
    if (typeof candidate === "function") fixed(api, key, () => reject(key));
  }
}

guard(test);
guard(describe);
