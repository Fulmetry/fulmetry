import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "pcboo/authoring";
import { canonicalCircuitJson, parseCanonicalCircuitJson } from "../src/circuit-json";
import { manufacturingFixture } from "./fixtures/manufacturing";

describe("canonical Circuit JSON evidence", () => {
  test("accepts canonical tscircuit output through pinned compatibility shims", async () => {
    const text = canonicalCircuitJson(await manufacturingFixture(2));
    expect(parseCanonicalCircuitJson(text).length).toBeGreaterThan(0);
  });

  test("rejects an unknown element type and malformed known fields", async () => {
    const unknown = [{ type: "pcb_magic", pcb_magic_id: "magic" }] as unknown as AnyCircuitElement[];
    expect(() => parseCanonicalCircuitJson(canonicalCircuitJson(unknown))).toThrow(
      "circuit-json@0.0.464",
    );

    const malformed = structuredClone(await manufacturingFixture(2));
    const board = malformed.find((element) => element.type === "pcb_board");
    if (board?.type !== "pcb_board") throw new Error("Fixture board missing");
    (board as unknown as Record<string, unknown>).width = { untrusted: 20 };
    expect(() => parseCanonicalCircuitJson(canonicalCircuitJson(malformed))).toThrow(
      "circuit-json@0.0.464",
    );
  });

  test("rejects schema-unknown fields instead of letting Zod strip them", async () => {
    const attacked = structuredClone(await manufacturingFixture(2));
    Object.assign(attacked[0]!, { unverified_magic: "changes-output" });
    expect(() => parseCanonicalCircuitJson(canonicalCircuitJson(attacked))).toThrow(
      "schema-unknown field unverified_magic",
    );
  });

  test("rejects duplicate primary identities", async () => {
    const attacked = structuredClone(await manufacturingFixture(2));
    const component = attacked.find((element) => element.type === "pcb_component");
    if (component?.type !== "pcb_component") throw new Error("Fixture component missing");
    attacked.push(structuredClone(component));
    expect(() => parseCanonicalCircuitJson(canonicalCircuitJson(attacked))).toThrow(
      "is duplicated",
    );
  });
});
