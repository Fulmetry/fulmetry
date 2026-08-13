// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT

export const SUPPORTED_CREATE_PCBOO_BUN_VERSION = "1.3.14" as const;
export const SUPPORTED_CREATE_PCBOO_PLATFORM = "darwin-arm64" as const;
export const CREATE_PCBOO_UNSUPPORTED_BUN_ERROR =
  "PCBOO_RUNTIME_UNSUPPORTED_BUN_001" as const;

/** The independently published creator validates the real runtime itself. */
export function requireSupportedCreatePcbooRuntime():
  typeof SUPPORTED_CREATE_PCBOO_BUN_VERSION {
  if (Bun.version !== SUPPORTED_CREATE_PCBOO_BUN_VERSION) {
    throw new Error(
      `${CREATE_PCBOO_UNSUPPORTED_BUN_ERROR}: create-pcboo requires Bun ` +
        `${SUPPORTED_CREATE_PCBOO_BUN_VERSION}, but the running Bun version is ${JSON.stringify(Bun.version)}`,
    );
  }
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== SUPPORTED_CREATE_PCBOO_PLATFORM) {
    throw new Error(
      `PCBOO_RUNTIME_UNSUPPORTED_PLATFORM_001: create-pcboo requires Apple Silicon macOS ` +
        `(${SUPPORTED_CREATE_PCBOO_PLATFORM}), but the running platform is ${JSON.stringify(platform)}`,
    );
  }
  return SUPPORTED_CREATE_PCBOO_BUN_VERSION;
}
