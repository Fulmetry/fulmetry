// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT

export interface SeededRandom {
  nextUint32(): number;
  integer(minimum: number, maximum: number): number;
}

export interface SeededPropertyOptions<T> {
  readonly name: string;
  readonly seed: number;
  readonly cases: number;
  readonly generate: (random: SeededRandom, caseIndex: number) => T;
  readonly check: (value: T, caseIndex: number) => void | Promise<void>;
  readonly shrink: (value: T) => readonly T[];
  readonly shrinkLimit?: number;
  readonly replayFile?: string;
}

export class SeededPropertyFailure<T> extends Error {
  readonly seed: number;
  readonly caseIndex: number;
  readonly counterexample: T;
  readonly originalCause: unknown;

  constructor(options: {
    readonly name: string;
    readonly seed: number;
    readonly caseIndex: number;
    readonly counterexample: T;
    readonly cause: unknown;
    readonly replayFile?: string;
  }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    const replayFile = options.replayFile ?? "test/manufacturing-properties.test.ts";
    const replay =
      `set PCBOO_PROPERTY_SEED to ${options.seed}, then run ` +
      `bun test ${replayFile}`;
    super(
      `${options.name} failed at generated case ${options.caseIndex}; seed=${options.seed}; ` +
        `minimal-counterexample=${stableJson(options.counterexample)}; cause=${detail}; replay=${replay}`,
      { cause: options.cause },
    );
    this.name = "SeededPropertyFailure";
    this.seed = options.seed;
    this.caseIndex = options.caseIndex;
    this.counterexample = options.counterexample;
    this.originalCause = options.cause;
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function createRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  return Object.freeze({
    nextUint32(): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    },
    integer(minimum: number, maximum: number): number {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
        throw new RangeError("Seeded integer bounds must be ordered safe integers");
      }
      const range = maximum - minimum + 1;
      if (!Number.isSafeInteger(range) || range <= 0 || range > 0x1_0000_0000) {
        throw new RangeError("Seeded integer range must fit in 32 bits");
      }
      return minimum + (this.nextUint32() % range);
    },
  });
}

async function failureOf<T>(
  check: SeededPropertyOptions<T>["check"],
  value: T,
  caseIndex: number,
): Promise<Readonly<{ failed: false }> | Readonly<{ failed: true; error: unknown }>> {
  try {
    await check(value, caseIndex);
    return Object.freeze({ failed: false });
  } catch (error) {
    return Object.freeze({ failed: true, error });
  }
}

/**
 * Run a deterministic, bounded property. A failing case is greedily shrunk to
 * a local minimum and the thrown error contains both the seed and replay case.
 */
export async function runSeededProperty<T>(options: SeededPropertyOptions<T>): Promise<void> {
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) {
    throw new RangeError("Property seed must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(options.cases) || options.cases < 1 || options.cases > 1_000) {
    throw new RangeError("Property case count must be between 1 and 1000");
  }
  const shrinkLimit = options.shrinkLimit ?? 128;
  if (!Number.isSafeInteger(shrinkLimit) || shrinkLimit < 0 || shrinkLimit > 10_000) {
    throw new RangeError("Property shrink limit must be between 0 and 10000");
  }
  const random = createRandom(options.seed);
  for (let caseIndex = 0; caseIndex < options.cases; caseIndex += 1) {
    const generated = options.generate(random, caseIndex);
    const initialResult = await failureOf(options.check, generated, caseIndex);
    if (!initialResult.failed) continue;

    let minimal = generated;
    let minimalFailure = initialResult.error;
    let attempts = 0;
    let improved = true;
    while (improved && attempts < shrinkLimit) {
      improved = false;
      const current = stableJson(minimal);
      const seen = new Set<string>([current]);
      for (const candidate of options.shrink(minimal)) {
        if (attempts >= shrinkLimit) break;
        const encoded = stableJson(candidate);
        if (seen.has(encoded)) continue;
        seen.add(encoded);
        attempts += 1;
        const candidateResult = await failureOf(options.check, candidate, caseIndex);
        if (!candidateResult.failed) continue;
        minimal = candidate;
        minimalFailure = candidateResult.error;
        improved = true;
        break;
      }
    }

    throw new SeededPropertyFailure({
      name: options.name,
      seed: options.seed,
      caseIndex,
      counterexample: minimal,
      cause: minimalFailure,
      ...(options.replayFile === undefined ? {} : { replayFile: options.replayFile }),
    });
  }
}

export function propertySeed(environmentValue: string | undefined, fallback: number): number {
  if (environmentValue === undefined) return fallback;
  if (!/^(?:0|[1-9]\d{0,9})$/.test(environmentValue)) {
    throw new TypeError("PCBOO_PROPERTY_SEED must be an unsigned decimal 32-bit integer");
  }
  const parsed = Number(environmentValue);
  if (!Number.isSafeInteger(parsed) || parsed > 0xffff_ffff) {
    throw new RangeError("PCBOO_PROPERTY_SEED must be at most 4294967295");
  }
  return parsed;
}
