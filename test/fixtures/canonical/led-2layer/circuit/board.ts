import { Board, Circuit } from "tscircuit";
import type { AnyCircuitElement } from "tscircuit";
import { addComponents } from "./components";
import { addRouting } from "./routing";
import { applyBatterySourceCompatibility } from "./source-compatibility";

export default async function buildLedBoard(): Promise<AnyCircuitElement[]> {
  const circuit = new Circuit();
  const board = new Board({ width: "20mm", height: "15mm", layers: 2 });
  circuit.add(board);
  addComponents(board);
  addRouting(board);
  await circuit.renderUntilSettled();
  const circuitJson = circuit.getCircuitJson().filter((element) => !element.type.startsWith("pcb_silkscreen"));
  applyBatterySourceCompatibility(circuitJson);
  return circuitJson;
}
