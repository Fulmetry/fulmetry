// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyCircuitElement } from "tscircuit";
import { canonicalCircuitJson } from "../src/circuit-json";
import { deriveManufacturingExpectation } from "../src/manufacturing/expectation";
import {
  emitDraftManufacturingDirectory,
  exportManufacturingFiles,
} from "../src/manufacturing/export";
import { verifyManufacturingDirectory } from "../src/manufacturing/verify";
import { manufacturingFixture } from "./fixtures/manufacturing";
import {
  propertySeed,
  runSeededProperty,
  SeededPropertyFailure,
} from "./support/seeded-property";

interface ManufacturingPropertyCase {
  readonly layers: 2 | 4;
  readonly dxTenths: number;
  readonly dyTenths: number;
  readonly mirrorAxisTenths: number;
}

type PointTransform = (x: number, y: number) => Readonly<{ x: number; y: number }>;

const roots: string[] = [];
const DEFAULT_PROPERTY_SEED = 0x5043_424f;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function rounded(value: number): number {
  const result = Math.round(value * 1_000_000_000) / 1_000_000_000;
  return Object.is(result, -0) ? 0 : result;
}

function transformPoints(
  value: unknown,
  transform: PointTransform,
  parentKey?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transformPoints(item, transform, parentKey));
  }
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const transformed = Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, transformPoints(item, transform, key)]),
  );
  if (
    parentKey !== "rotation" &&
    typeof source.x === "number" &&
    typeof source.y === "number"
  ) {
    const point = transform(source.x, source.y);
    transformed.x = rounded(point.x);
    transformed.y = rounded(point.y);
  }
  return transformed;
}

function transformPcbCircuit(
  circuitJson: readonly AnyCircuitElement[],
  pointTransform: PointTransform,
  rotationTransform: (degrees: number) => number = (degrees) => degrees,
  skipElement: (element: AnyCircuitElement) => boolean = () => false,
): AnyCircuitElement[] {
  return circuitJson.map((element) => {
    if (
      (!element.type.startsWith("pcb_") && element.type !== "cad_component") ||
      skipElement(element)
    ) return structuredClone(element);
    const transformed = transformPoints(element, pointTransform) as Record<string, unknown>;
    for (const key of ["rotation", "ccw_rotation"] as const) {
      if (typeof transformed[key] === "number") {
        transformed[key] = rounded(rotationTransform(transformed[key] as number));
      }
    }
    return transformed as AnyCircuitElement;
  });
}

function boardCenter(circuitJson: readonly AnyCircuitElement[]): Readonly<{ x: number; y: number }> {
  const board = circuitJson.find((element) => element.type === "pcb_board");
  if (board?.type !== "pcb_board") throw new Error("Property fixture must contain one PCB board");
  return board.center;
}

function translateCircuit(
  circuitJson: readonly AnyCircuitElement[],
  dx: number,
  dy: number,
  skipElement: (element: AnyCircuitElement) => boolean = () => false,
): AnyCircuitElement[] {
  return transformPcbCircuit(
    circuitJson,
    (x, y) => ({ x: x + dx, y: y + dy }),
    undefined,
    skipElement,
  );
}

function rotateCircuit360(circuitJson: readonly AnyCircuitElement[]): AnyCircuitElement[] {
  const center = boardCenter(circuitJson);
  const radians = Math.PI * 2;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return transformPcbCircuit(
    circuitJson,
    (x, y) => ({
      x: center.x + (x - center.x) * cosine - (y - center.y) * sine,
      y: center.y + (x - center.x) * sine + (y - center.y) * cosine,
    }),
    (degrees) => ((degrees + 360) % 360 + 360) % 360,
  );
}

function mirrorCircuitX(
  circuitJson: readonly AnyCircuitElement[],
  axisX: number,
): AnyCircuitElement[] {
  return transformPcbCircuit(
    circuitJson,
    (x, y) => ({ x: axisX * 2 - x, y }),
    (degrees) => ((180 - degrees) % 360 + 360) % 360,
  );
}

function normalizePcbGeometry(circuitJson: readonly AnyCircuitElement[]): string {
  const center = boardCenter(circuitJson);
  const normalized = transformPcbCircuit(
    circuitJson,
    (x, y) => ({ x: x - center.x, y: y - center.y }),
    (degrees) => ((degrees % 360) + 360) % 360,
  );
  return canonicalCircuitJson(normalized);
}

function normalizeUnknown(value: unknown, centerX: number, centerY: number): unknown {
  if (typeof value === "number") return rounded(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalizeUnknown(item, centerX, centerY));
  const source = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeUnknown(item, centerX, centerY)]),
  );
  for (const [xKey, yKey] of [
    ["x", "y"],
    ["startX", "startY"],
    ["endX", "endY"],
    ["centerX", "centerY"],
  ] as const) {
    if (typeof source[xKey] === "number" && typeof source[yKey] === "number") {
      normalized[xKey] = rounded(source[xKey] - centerX);
      normalized[yKey] = rounded(source[yKey] - centerY);
    }
  }
  if (typeof source.rotation === "number") {
    normalized.rotation = rounded(((source.rotation % 360) + 360) % 360);
  }
  return normalized;
}

function normalizedExpectation(expectation: ReturnType<typeof deriveManufacturingExpectation>): string {
  return JSON.stringify(
    normalizeUnknown(expectation, expectation.board.centerX, expectation.board.centerY),
  );
}

async function exportAndVerify(
  circuitJson: AnyCircuitElement[],
  label: string,
) {
  const parent = await mkdtemp(join(tmpdir(), `fulmetry-property-${label}-`));
  roots.push(parent);
  try {
    const root = join(parent, "manufacturing");
    const expectation = deriveManufacturingExpectation({ boardName: "property", circuitJson });
    expect(expectation.unsupported).toEqual([]);
    const files = await exportManufacturingFiles({ boardName: "property", circuitJson });
    await emitDraftManufacturingDirectory({ targetDirectory: root, files });
    const verification = await verifyManufacturingDirectory({ root, expectation, circuitJson });
    expect(verification.passed).toBeTrue();
    expect(verification.findings).toEqual([]);
    return {
      expectation: normalizedExpectation(expectation),
      files,
      artifactPaths: verification.artifacts.map(({ path }) => path),
    };
  } finally {
    await rm(parent, { recursive: true, force: true });
    const index = roots.indexOf(parent);
    if (index >= 0) roots.splice(index, 1);
  }
}

function generatedCase(
  random: { integer(minimum: number, maximum: number): number },
  caseIndex: number,
): ManufacturingPropertyCase {
  let dxTenths = random.integer(-50, 50);
  const dyTenths = random.integer(-50, 50);
  if (dxTenths === 0 && dyTenths === 0) dxTenths = 1;
  return Object.freeze({
    layers: caseIndex % 2 === 0 ? 2 : 4,
    dxTenths,
    dyTenths,
    mirrorAxisTenths: random.integer(-30, 30),
  });
}

function shrinkCase(value: ManufacturingPropertyCase): readonly ManufacturingPropertyCase[] {
  const candidates: ManufacturingPropertyCase[] = [];
  const add = (change: Partial<ManufacturingPropertyCase>) => candidates.push({ ...value, ...change });
  if (value.layers === 4) add({ layers: 2 });
  if (value.dxTenths !== 0) add({ dxTenths: 0 });
  if (value.dyTenths !== 0) add({ dyTenths: 0 });
  if (value.mirrorAxisTenths !== 0) add({ mirrorAxisTenths: 0 });
  if (Math.abs(value.dxTenths) > 1) add({ dxTenths: Math.sign(value.dxTenths) });
  if (Math.abs(value.dyTenths) > 1) add({ dyTenths: Math.sign(value.dyTenths) });
  if (Math.abs(value.mirrorAxisTenths) > 1) {
    add({ mirrorAxisTenths: Math.sign(value.mirrorAxisTenths) });
  }
  return candidates;
}

describe("seeded manufacturing geometry properties", () => {
  test("a thrown undefined value cannot be mistaken for a passing generated case", async () => {
    let failure: unknown;
    try {
      await runSeededProperty({
        name: "undefined-throw-regression",
        seed: 1,
        cases: 1,
        generate: () => ({ value: 1 }),
        shrink: () => [],
        check: () => {
          throw undefined;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SeededPropertyFailure);
    expect((failure as SeededPropertyFailure<{ value: number }>).originalCause).toBeUndefined();
  });

  test("generated 2- and 4-layer transforms preserve independently parsed manufacturing meaning", async () => {
    const seed = propertySeed(process.env.FULMETRY_PROPERTY_SEED, DEFAULT_PROPERTY_SEED);
    await runSeededProperty({
      name: "manufacturing-transform-invariance",
      seed,
      cases: 6,
      generate: generatedCase,
      shrink: shrinkCase,
      check: async (propertyCase, caseIndex) => {
        const original = await manufacturingFixture(propertyCase.layers);
        const originalGeometry = normalizePcbGeometry(original);
        const baseline = await exportAndVerify(original, `${caseIndex}-baseline`);
        const repeated = await exportManufacturingFiles({
          boardName: "property",
          circuitJson: original,
        });
        expect(repeated).toEqual(baseline.files);

        const translated = translateCircuit(
          original,
          propertyCase.dxTenths / 10,
          propertyCase.dyTenths / 10,
        );
        const rotated = rotateCircuit360(original);
        const mirroredTwice = mirrorCircuitX(
          mirrorCircuitX(original, propertyCase.mirrorAxisTenths / 10),
          propertyCase.mirrorAxisTenths / 10,
        );

        for (const [variantName, variant] of [
          ["translated", translated],
          ["rotated-360", rotated],
          ["mirrored-twice", mirroredTwice],
        ] as const) {
          expect(normalizePcbGeometry(variant)).toBe(originalGeometry);
          const checked = await exportAndVerify(variant, `${caseIndex}-${variantName}`);
          expect(checked.expectation).toBe(baseline.expectation);
          expect(checked.files.map(({ path, kind }) => ({ path, kind }))).toEqual(
            baseline.files.map(({ path, kind }) => ({ path, kind })),
          );
          expect(checked.artifactPaths).toEqual(baseline.artifactPaths);
        }
      },
    });
  }, 120_000);

  test("a faulty transform is rejected with a replay seed and minimized counterexample", async () => {
    const seed = 0x4641_554c;
    const baseline2 = await manufacturingFixture(2);
    const baseline4 = await manufacturingFixture(4);
    const baselines = {
      2: { circuitJson: baseline2, geometry: normalizePcbGeometry(baseline2) },
      4: { circuitJson: baseline4, geometry: normalizePcbGeometry(baseline4) },
    } as const;
    const omittedViaMismatch = new Error("FAULT_INJECTION_OMITTED_VIA_TRANSLATION");
    let failure: unknown;
    try {
      await runSeededProperty({
        name: "fault-injection-omitted-via-translation",
        seed,
        cases: 1,
        generate: generatedCase,
        shrink: shrinkCase,
        check: async (propertyCase) => {
          const baseline = baselines[propertyCase.layers];
          const faulty = translateCircuit(
            baseline.circuitJson,
            propertyCase.dxTenths / 10,
            propertyCase.dyTenths / 10,
            (element) => element.type === "pcb_via" && element.pcb_via_id === "pcb_via_0",
          );
          if (normalizePcbGeometry(faulty) !== baseline.geometry) {
            throw omittedViaMismatch;
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SeededPropertyFailure);
    const propertyFailure = failure as SeededPropertyFailure<ManufacturingPropertyCase>;
    expect(propertyFailure.seed).toBe(seed);
    expect(propertyFailure.caseIndex).toBe(0);
    expect(propertyFailure.originalCause).toBe(omittedViaMismatch);
    expect(propertyFailure.counterexample.layers).toBe(2);
    expect(
      propertyFailure.counterexample.dxTenths !== 0 ||
        propertyFailure.counterexample.dyTenths !== 0,
    ).toBeTrue();
    expect(Math.abs(propertyFailure.counterexample.dxTenths)).toBeLessThanOrEqual(1);
    expect(Math.abs(propertyFailure.counterexample.dyTenths)).toBeLessThanOrEqual(1);
    expect(propertyFailure.message).toContain(`seed=${seed}`);
    expect(propertyFailure.message).toContain("minimal-counterexample=");
    expect(propertyFailure.message).toContain(`FULMETRY_PROPERTY_SEED to ${seed}`);
  }, 30_000);
});
