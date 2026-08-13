// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { SUPPORTED_BUN_VERSION } from "../runtime";

export const SUPPORTED_UPGRADE_REVIEW_BUN_VERSION = SUPPORTED_BUN_VERSION;

/** Upgrade evidence is authoritative only under PCBoo's one qualified Bun runtime. */
export function requireSupportedUpgradeReviewBunVersion(version: unknown):
  typeof SUPPORTED_UPGRADE_REVIEW_BUN_VERSION {
  if (version !== SUPPORTED_UPGRADE_REVIEW_BUN_VERSION) {
    throw new Error(
      `TSCIRCUIT_UPGRADE_UNSUPPORTED_BUN: upgrade review requires Bun ` +
      `${SUPPORTED_UPGRADE_REVIEW_BUN_VERSION}, but the running Bun version is ${JSON.stringify(version)}`,
    );
  }
  return SUPPORTED_UPGRADE_REVIEW_BUN_VERSION;
}
