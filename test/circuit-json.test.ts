import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "fulmetry/authoring";
import { canonicalCircuitJson, parseCanonicalCircuitJson } from "../src/circuit-json";
import { manufacturingFixture } from "./fixtures/manufacturing";

describe("canonical Circuit JSON evidence", () => {
  test("uses locale-independent RFC 8785 property ordering", () => {
    const value = ([
      { type: "source_project_metadata", source_project_metadata_id: "meta", z: 1, "ä": 2 },
    ] as unknown) as AnyCircuitElement[];
    expect(canonicalCircuitJson(value)).toContain('"z":1,"ä":2');
  });

  test("rejects duplicate object properties and unpaired Unicode surrogates", () => {
    expect(() => parseCanonicalCircuitJson('[{"type":"pcb_board","type":"pcb_board"}]\n'))
      .toThrow("duplicate key");
    expect(() => canonicalCircuitJson([
      { type: "source_project_metadata", source_project_metadata_id: "meta", bad: "\ud800" },
    ] as unknown as AnyCircuitElement[])).toThrow("unpaired high surrogate");
  });

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
