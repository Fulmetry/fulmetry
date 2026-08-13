// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT

export const PCBOO_CANCELLATION_ERROR_CODE = "PCBOO_OPERATION_CANCELLED" as const;

/** An internal cancellation signal whose identity does not depend on human-readable prose. */
export class PcbooCancellationError extends Error {
  readonly code = PCBOO_CANCELLATION_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "PcbooCancellationError";
  }
}

export function isPcbooCancellationError(error: unknown): error is PcbooCancellationError {
  return error instanceof PcbooCancellationError &&
    error.code === PCBOO_CANCELLATION_ERROR_CODE;
}

export function throwIfPcbooCancelled(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted) throw new PcbooCancellationError(message);
}
