// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "circuit-json";
import { canonicalCircuitJson, parseCanonicalRouteCandidateCircuitJson } from "../src/circuit-json";
import { promoteCandidateRoutes, renderPromotedRouteSourceSet } from "../src/routing";
import { manufacturingFixture } from "./fixtures/manufacturing";

const candidate = [
  { type: "source_component", source_component_id: "generated-c1", name: "U1" },
  { type: "source_component", source_component_id: "generated-c2", name: "J1" },
  { type: "source_port", source_port_id: "generated-sp1", source_component_id: "generated-c1", name: "OUT", pin_number: 1 },
  { type: "source_port", source_port_id: "generated-sp2", source_component_id: "generated-c2", name: "IN", pin_number: 2 },
  { type: "pcb_port", pcb_port_id: "generated-pp1", source_port_id: "generated-sp1", x: 1, y: 2, layers: ["top"] },
  { type: "pcb_port", pcb_port_id: "generated-pp2", source_port_id: "generated-sp2", x: 4, y: 5, layers: ["top"] },
  { type: "source_net", source_net_id: "generated-net", name: "AUDIO/L" },
  { type: "source_trace", source_trace_id: "generated-st", connected_source_net_ids: ["generated-net"] },
  {
    type: "pcb_trace",
    pcb_trace_id: "generated-pt",
    source_trace_id: "generated-st",
    route: [
      { route_type: "wire", x: 1.0000000004, y: 2, layer: "top", width: 0.2, start_pcb_port_id: "generated-pp1" },
      { route_type: "via", x: 2.34567891, y: 3, from_layer: "top", to_layer: "inner2" },
      { route_type: "wire", x: 4, y: 5, layer: "inner2", width: 0.2, end_pcb_port_id: "generated-pp2" },
    ],
  },
] as unknown as AnyCircuitElement[];

describe("route promotion", () => {
  test("removes generated ids, adds via geometry, and rounds deterministic source", () => {
    const promoted = promoteCandidateRoutes(candidate, {
      defaultViaHoleDiameter: 0.3,
      defaultViaOuterDiameter: 0.6,
    });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      net: "AUDIO/L",
      from: { component: "U1", port: "OUT" },
      to: { component: "J1", port: "IN" },
    });
    expect(promoted[0]!.route.find((point) => point.route_type === "via")).toEqual({
      route_type: "via",
      x: 2.345679,
      y: 3,
      from_layer: "top",
      to_layer: "inner2",
      hole_diameter: 0.3,
      outer_diameter: 0.6,
    });
    expect(promoted[0]!.route).toContainEqual({
      route_type: "wire",
      x: 2.345679,
      y: 3,
      layer: "top",
      width: 0.2,
    });
    expect(JSON.stringify(promoted)).not.toContain("generated-");
  });

  test("renders composable modules grouped by semantic net", () => {
    const source = renderPromotedRouteSourceSet(candidate, {
      defaultViaHoleDiameter: 0.3,
      defaultViaOuterDiameter: 0.6,
    });
    expect(source.modules).toHaveLength(1);
    expect(source.modules[0]!.fileName).toBe("audio-l.ts");
    expect(source.modules[0]!.source).toContain('import { defineRoutes } from "pcboo"');
    expect(source.indexSource).toContain("...AUDIO_LRoutes");
  });

  test("rejects candidate routes without stable endpoint metadata", () => {
    const invalid = structuredClone(candidate) as unknown as Record<string, unknown>[];
    const trace = invalid.find(({ type }) => type === "pcb_trace")!;
    delete (trace.route as Record<string, unknown>[])[0]!.start_pcb_port_id;
    expect(() => promoteCandidateRoutes(invalid as unknown as AnyCircuitElement[], {
      defaultViaHoleDiameter: 0.3,
      defaultViaOuterDiameter: 0.6,
    })).toThrow("endpoint ports");
  });

  test("ignores duplicate router-reconstructed footprint ids outside the promotion boundary", async () => {
    const reconstructed = await manufacturingFixture(2);
    const pad = reconstructed.find((element) => element.type === "pcb_smtpad");
    if (pad?.type !== "pcb_smtpad") throw new Error("Fixture SMT pad missing");
    reconstructed.push(structuredClone(pad));
    const parsed = parseCanonicalRouteCandidateCircuitJson(canonicalCircuitJson(reconstructed));
    expect(parsed.some((element) => element.type === "pcb_smtpad")).toBeFalse();
  });

  test("normalizes harmless router duplicates in promotion metadata", () => {
    const reconstructed = structuredClone(candidate) as unknown as AnyCircuitElement[];
    const sourceTrace = reconstructed.find((element) => element.type === "source_trace");
    const pcbPort = reconstructed.find((element) => element.type === "pcb_port");
    if (sourceTrace?.type !== "source_trace" || pcbPort?.type !== "pcb_port") {
      throw new Error("Route fixture metadata missing");
    }
    reconstructed.unshift({
      ...sourceTrace,
      connected_source_net_ids: [],
      connected_source_port_ids: [],
    });
    reconstructed.push({ ...pcbPort, x: 99, y: 99 });
    const parsed = parseCanonicalRouteCandidateCircuitJson(canonicalCircuitJson(reconstructed));
    expect(promoteCandidateRoutes(parsed, {
      defaultViaHoleDiameter: 0.3,
      defaultViaOuterDiameter: 0.6,
    })).toHaveLength(1);
  });

  test("preserves equal-distance branches anchored to a multilayer plated port", () => {
    const branchCandidate = [
      { type: "source_component", source_component_id: "ca", name: "A" },
      { type: "source_component", source_component_id: "cb", name: "B" },
      { type: "source_component", source_component_id: "cp", name: "PTH" },
      { type: "source_port", source_port_id: "spa", source_component_id: "ca", name: "pin1", pin_number: 1 },
      { type: "source_port", source_port_id: "spb", source_component_id: "cb", name: "pin1", pin_number: 1 },
      { type: "source_port", source_port_id: "spp", source_component_id: "cp", name: "pin1", pin_number: 1 },
      { type: "pcb_port", pcb_port_id: "ppa", source_port_id: "spa", x: 0, y: 0, layers: ["top"] },
      { type: "pcb_port", pcb_port_id: "ppb", source_port_id: "spb", x: 10, y: 0, layers: ["inner2"] },
      { type: "pcb_port", pcb_port_id: "ppp", source_port_id: "spp", x: 5, y: 0, layers: ["top", "inner2"] },
      { type: "source_net", source_net_id: "net", name: "BRANCH" },
      {
        type: "source_trace",
        source_trace_id: "st",
        connected_source_net_ids: ["net"],
        connected_source_port_ids: ["spa", "spb", "spp"],
      },
      {
        type: "pcb_trace", pcb_trace_id: "ta", source_trace_id: "st",
        route: [
          { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.2 },
          { route_type: "wire", x: 5, y: 0, layer: "top", width: 0.2 },
        ],
      },
      {
        type: "pcb_trace", pcb_trace_id: "tb", source_trace_id: "st",
        route: [
          { route_type: "wire", x: 10, y: 0, layer: "inner2", width: 0.2 },
          { route_type: "wire", x: 5, y: 0, layer: "inner2", width: 0.2 },
        ],
      },
    ] as unknown as AnyCircuitElement[];
    const promoted = promoteCandidateRoutes(branchCandidate, {
      defaultViaHoleDiameter: 0.3,
      defaultViaOuterDiameter: 0.6,
    });
    expect(promoted).toHaveLength(2);
    expect(promoted.map(({ from, to }) => [from.component, to.component])).toEqual(
      expect.arrayContaining([["A", "PTH"], ["B", "PTH"]]),
    );
  });
});
