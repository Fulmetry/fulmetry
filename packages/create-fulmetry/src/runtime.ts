// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

export const SUPPORTED_CREATE_FULMETRY_BUN_VERSION = "1.3.14" as const;
export const SUPPORTED_CREATE_FULMETRY_PLATFORM = "darwin-arm64" as const;
export const CREATE_FULMETRY_UNSUPPORTED_BUN_ERROR =
  "FULMETRY_RUNTIME_UNSUPPORTED_BUN_001" as const;

/** The independently published creator validates the real runtime itself. */
export function requireSupportedCreateFulmetryRuntime():
  typeof SUPPORTED_CREATE_FULMETRY_BUN_VERSION {
  if (Bun.version !== SUPPORTED_CREATE_FULMETRY_BUN_VERSION) {
    throw new Error(
      `${CREATE_FULMETRY_UNSUPPORTED_BUN_ERROR}: create-fulmetry requires Bun ` +
        `${SUPPORTED_CREATE_FULMETRY_BUN_VERSION}, but the running Bun version is ${JSON.stringify(Bun.version)}`,
    );
  }
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== SUPPORTED_CREATE_FULMETRY_PLATFORM) {
    throw new Error(
      `FULMETRY_RUNTIME_UNSUPPORTED_PLATFORM_001: create-fulmetry requires Apple Silicon macOS ` +
        `(${SUPPORTED_CREATE_FULMETRY_PLATFORM}), but the running platform is ${JSON.stringify(platform)}`,
    );
  }
  return SUPPORTED_CREATE_FULMETRY_BUN_VERSION;
}
