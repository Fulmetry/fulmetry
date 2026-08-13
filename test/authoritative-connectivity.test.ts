import { describe, expect, test } from "bun:test";
import type { AnyCircuitElement } from "@pcboo/pcboo/authoring";
import { deriveAuthoritativeConnectivity } from "../src/authoritative-connectivity";
import { manufacturingFixture } from "./fixtures/manufacturing";

function clone(elements: readonly AnyCircuitElement[]): AnyCircuitElement[] {
  return structuredClone(elements) as AnyCircuitElement[];
}

describe("authoritative logical and physical connectivity", () => {
  test("derives canonical fixture nets without trusting raw-key identity", async () => {
    const result = deriveAuthoritativeConnectivity(await manufacturingFixture(4));
    expect(result.connectivityFailures).toEqual([]);
    expect(result.netIdentityFailures).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.netForSourceTraceId("source_trace_0"))
      .toBe(result.netForSourceTraceId("source_trace_1"));
    expect(result.netForSourceTraceId("source_trace_2"))
      .not.toBe(result.netForSourceTraceId("source_trace_3"));
  });

  test("finds manufactured ports whose whole declared connection disappeared", async () => {
    const attacked = (await manufacturingFixture(4)).filter(
      (element) =>
        !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
        !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
        !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0"),
    );
    const result = deriveAuthoritativeConnectivity(attacked);
    expect(result.connectivityFailures).toContainEqual(
      expect.stringContaining("manufactured-port-has-no-logical-group"),
    );
  });

  test("rejects physical component pins whose source-port authority was deleted", async () => {
    const removed = new Set(["source_port_1", "source_port_3"]);
    const attacked = (await manufacturingFixture(4)).filter((element) =>
      !(element.type === "source_trace" && element.source_trace_id === "source_trace_2") &&
      !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0") &&
      !(element.type === "source_port" && removed.has(element.source_port_id)) &&
      !(element.type === "schematic_port" && removed.has(element.source_port_id))
    );
    const result = deriveAuthoritativeConnectivity(attacked);
    expect(result.pinAuthorityFailures).toEqual(expect.arrayContaining([
      "pcb_port_1:source-port-count:0",
      "pcb_port_3:source-port-count:0",
    ]));
    expect(result.connectivityFailures).toEqual(expect.arrayContaining(
      result.pinAuthorityFailures,
    ));
  });

  test("rejects a PCB port whose physical and source owners do not exist", async () => {
    const attacked = clone(await manufacturingFixture(2));
    attacked.push({
      type: "pcb_port",
      pcb_port_id: "pcb_port_orphan",
      pcb_component_id: "pcb_component_missing",
      source_port_id: "source_port_missing",
      layers: ["top"],
      x: 0,
      y: 5,
      subcircuit_id: "subcircuit_source_group_0",
    } as AnyCircuitElement);
    const result = deriveAuthoritativeConnectivity(attacked);
    expect(result.pinAuthorityFailures).toEqual(expect.arrayContaining([
      "pcb_port_orphan:pcb-component-count:0",
      "pcb_port_orphan:source-port-count:0",
    ]));
  });

  test("keeps distinct endpoint sets distinct when every mutable raw key is collided", async () => {
    const attacked = clone(await manufacturingFixture(4));
    const left = attacked.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_2",
    );
    const right = attacked.find(
      (element) => element.type === "source_trace" && element.source_trace_id === "source_trace_3",
    );
    if (left?.type !== "source_trace" || right?.type !== "source_trace") {
      throw new Error("Fixture logical connections missing");
    }
    const key = left.subcircuit_connectivity_map_key;
    right.subcircuit_connectivity_map_key = key;
    for (const element of attacked) {
      if (element.type === "source_port" && right.connected_source_port_ids.includes(element.source_port_id)) {
        element.subcircuit_connectivity_map_key = key;
      }
      if (element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_1") {
        element.subcircuit_connectivity_map_key = key;
      }
    }
    const result = deriveAuthoritativeConnectivity(attacked);
    expect(result.netForSourceTraceId(left.source_trace_id))
      .not.toBe(result.netForSourceTraceId(right.source_trace_id));
    expect(result.netIdentityFailures).toContainEqual(
      expect.stringContaining("connectivity-key-collision"),
    );
    expect(result.netForRawConnectivityKey(key!)).toBeUndefined();
  });

  test("requires a physical graph for a declared group with two manufactured endpoints", async () => {
    const attacked = (await manufacturingFixture(4)).filter(
      (element) =>
        !(element.type === "pcb_trace" && element.pcb_trace_id === "pcb_trace_0") &&
        !(element.type === "pcb_via" && element.pcb_trace_id === "pcb_trace_0"),
    );
    const result = deriveAuthoritativeConnectivity(attacked);
    expect(result.connectivityFailures).toContainEqual(
      expect.stringContaining("no-physical-copper"),
    );
  });

  test("rejects a zero-port trace that aliases two declared named nets", async () => {
    const attacked = clone(await manufacturingFixture(4));
    const original = attacked.find((element) => element.type === "source_net");
    if (original?.type !== "source_net") throw new Error("Fixture source net missing");
    attacked.push(
      {
        ...original,
        source_net_id: "source_net_hostile_alias",
        name: "HOSTILE_ALIAS",
        subcircuit_connectivity_map_key: "hostile-distinct-key",
      },
      {
        type: "source_trace",
        source_trace_id: "source_trace_zero_port_bridge",
        connected_source_port_ids: [],
        connected_source_net_ids: [original.source_net_id, "source_net_hostile_alias"],
      } as AnyCircuitElement,
    );
    const result = deriveAuthoritativeConnectivity(attacked);
    expect(result.netIdentityFailures).toContain(
      "source_trace_zero_port_bridge:multiple-source-nets:source_net_0,source_net_hostile_alias",
    );
    expect(result.netIdentityFailures).toContain(
      "source-net-root:source_net_0,source_net_hostile_alias:contains-2-declared-nets",
    );
  });
});
