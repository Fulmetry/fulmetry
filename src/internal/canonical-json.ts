// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT

/**
 * PCBoo canonical JSON v1 follows RFC 8785's JSON-domain requirements and
 * property ordering. Array order is intentionally preserved because compiled
 * Circuit JSON order is part of the deterministic compiler evidence.
 */
export const PCBOO_CANONICAL_JSON_VERSION = 1 as const;

/** Locale-independent lexicographic comparison of JavaScript UTF-16 strings. */
export function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnicodeScalarString(value: string, context: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${context} contains an unpaired high surrogate`);
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${context} contains an unpaired low surrogate`);
    }
  }
}

function normalizeCanonicalJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains non-JSON ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        normalizeCanonicalJson(item, `${path}[${index}]`, ancestors)
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareUtf16(left, right))
        .map(([key, item]) => {
          assertUnicodeScalarString(key, `${path} property name`);
          return [key, normalizeCanonicalJson(item, `${path}.${key}`, ancestors)];
        }),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonStringify(value: unknown, label = "JSON value"): string {
  return JSON.stringify(normalizeCanonicalJson(value, label, new Set<object>()));
}
