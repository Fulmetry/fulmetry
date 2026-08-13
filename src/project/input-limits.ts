// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
export const PROJECT_INPUT_FILE_LIMIT = 10_000;
export const PROJECT_INPUT_ENTRY_LIMIT = 12_000;
export const PROJECT_INPUT_DEPTH_LIMIT = 128;
export const PROJECT_INPUT_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
export const PROJECT_INPUT_TOTAL_BYTES_LIMIT = 512 * 1024 * 1024;
export const PROJECT_SIMULATION_EVALUATION_TIMEOUT_MS = 60_000;

export function assertProjectInputFileSize(path: string, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > PROJECT_INPUT_FILE_BYTES_LIMIT) {
    throw new Error(
      `${path} project input exceeds the ${PROJECT_INPUT_FILE_BYTES_LIMIT}-byte per-file limit`,
    );
  }
}

export function assertProjectInputTotalSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > PROJECT_INPUT_TOTAL_BYTES_LIMIT) {
    throw new Error(
      `Project inputs exceed the ${PROJECT_INPUT_TOTAL_BYTES_LIMIT}-byte aggregate limit`,
    );
  }
}
