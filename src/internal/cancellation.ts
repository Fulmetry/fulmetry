// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

export const FULMETRY_CANCELLATION_ERROR_CODE = "FULMETRY_OPERATION_CANCELLED" as const;

/** An internal cancellation signal whose identity does not depend on human-readable prose. */
export class FulmetryCancellationError extends Error {
  readonly code = FULMETRY_CANCELLATION_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "FulmetryCancellationError";
  }
}

export function isFulmetryCancellationError(error: unknown): error is FulmetryCancellationError {
  return error instanceof FulmetryCancellationError &&
    error.code === FULMETRY_CANCELLATION_ERROR_CODE;
}

export function throwIfFulmetryCancelled(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted) throw new FulmetryCancellationError(message);
}
