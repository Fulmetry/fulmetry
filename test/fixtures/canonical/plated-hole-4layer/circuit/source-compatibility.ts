import type { AnyCircuitElement } from "tscircuit";

/** The accepted tscircuit emitter omits Battery.voltage from its simple_power_source record. */
export function applyBatterySourceCompatibility(circuitJson: AnyCircuitElement[]): void {
  const source = circuitJson.find((element) => element.type === "source_component" && element.name === "B1");
  if (source?.type !== "source_component" || source.ftype !== "simple_power_source") {
    throw new Error("Canonical battery source B1 was not rendered");
  }
  (source as typeof source & { voltage: number }).voltage = 5;
}
