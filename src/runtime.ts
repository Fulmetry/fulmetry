// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

export const SUPPORTED_BUN_VERSION = "1.3.14" as const;
export const UNSUPPORTED_BUN_DIAGNOSTIC_ID =
  "FULMETRY_RUNTIME_UNSUPPORTED_BUN_001" as const;
export const UNSUPPORTED_PLATFORM_DIAGNOSTIC_ID =
  "FULMETRY_RUNTIME_UNSUPPORTED_PLATFORM_001" as const;
export const SUPPORTED_RUNTIME_PLATFORM = "darwin-arm64" as const;

export function isSupportedBunVersion(
  version: unknown,
): version is typeof SUPPORTED_BUN_VERSION {
  return version === SUPPORTED_BUN_VERSION;
}

export class UnsupportedBunRuntimeError extends Error {
  readonly code = UNSUPPORTED_BUN_DIAGNOSTIC_ID;
  readonly observedVersion: unknown;
  readonly supportedVersion = SUPPORTED_BUN_VERSION;

  constructor(observedVersion: unknown) {
    super(
      `${UNSUPPORTED_BUN_DIAGNOSTIC_ID}: Fulmetry requires Bun ` +
        `${SUPPORTED_BUN_VERSION}, but the running Bun version is ${JSON.stringify(observedVersion)}`,
    );
    this.name = "UnsupportedBunRuntimeError";
    this.observedVersion = observedVersion;
  }
}

export class UnsupportedPlatformRuntimeError extends Error {
  readonly code = UNSUPPORTED_PLATFORM_DIAGNOSTIC_ID;
  readonly observedPlatform: string;
  readonly supportedPlatform = SUPPORTED_RUNTIME_PLATFORM;

  constructor(observedPlatform: string) {
    super(
      `${UNSUPPORTED_PLATFORM_DIAGNOSTIC_ID}: Fulmetry requires Apple Silicon macOS ` +
        `(${SUPPORTED_RUNTIME_PLATFORM}), but the running platform is ${JSON.stringify(observedPlatform)}`,
    );
    this.name = "UnsupportedPlatformRuntimeError";
    this.observedPlatform = observedPlatform;
  }
}

/** Reads the actual runtime identity; callers cannot supply or override it. */
export function requireSupportedBunRuntime(): typeof SUPPORTED_BUN_VERSION {
  if (!isSupportedBunVersion(Bun.version)) {
    throw new UnsupportedBunRuntimeError(Bun.version);
  }
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== SUPPORTED_RUNTIME_PLATFORM) {
    throw new UnsupportedPlatformRuntimeError(platform);
  }
  return SUPPORTED_BUN_VERSION;
}
