// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT

/** Initial release platform whose two runtime profiles must be qualified. */
export const TSCIRCUIT_RUNTIME_PLATFORM_NAMES = Object.freeze([
  "darwin-arm64",
] as const);

export type TscircuitRuntimePlatform = typeof TSCIRCUIT_RUNTIME_PLATFORM_NAMES[number];

export function requireCompleteTscircuitRuntimeClosures(
  value: Readonly<Record<string, Readonly<{ repository: string; packedConsumer: string }>>>,
): void {
  const expected = [...TSCIRCUIT_RUNTIME_PLATFORM_NAMES].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Tscircuit runtime evidence must cover exactly ${expected.join(", ")}`);
  }
}
