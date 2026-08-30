// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
/** Exact tscircuit temporary-name form observed from the pinned compiler. */
export function isDeterministicTemporaryComponentName(name: string | undefined): boolean {
  return typeof name === "string" && /^unnamed_[a-z][a-z0-9_]*\d+$/i.test(name.trim());
}

/** Conservative, unambiguous reference grammar shared by assembly boundaries. */
export function isStableAssemblyDesignator(name: unknown): name is string {
  return typeof name === "string" &&
    /^(?=.{2,64}$)[A-Za-z][A-Za-z0-9_-]*[1-9][0-9]*$/.test(name) &&
    !isDeterministicTemporaryComponentName(name);
}
