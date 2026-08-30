// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { CheckCircle2, Cpu, Factory, LoaderCircle, Play } from "lucide-react";
import { useState } from "react";
import type { ActionKind, ProjectResponse, SimulationRecord } from "../types";
import { Button } from "./ui";

export function ActionBar({ project, simulations, running, onRun }: {
  project: ProjectResponse;
  simulations: readonly SimulationRecord[];
  running: ActionKind | null;
  onRun: (kind: ActionKind, name?: string) => Promise<void>;
}) {
  const [simulation, setSimulation] = useState(simulations[0]?.name ?? "");
  const disabled = !project.server.actionsEnabled || running !== null || project.snapshot.state !== "ready";
  const icon = (kind: ActionKind, fallback: React.ReactNode) => running === kind ? <LoaderCircle className="animate-spin" size={15} /> : fallback;
  return <div className="flex flex-wrap items-center gap-2">
    <Button variant="secondary" disabled={disabled} onClick={() => void onRun("build")}>{icon("build", <Cpu size={15} />)} Build</Button>
    <Button variant="secondary" disabled={disabled} onClick={() => void onRun("check")}>{icon("check", <CheckCircle2 size={15} />)} Check</Button>
    <Button variant="secondary" disabled={disabled} onClick={() => void onRun("export-kicad")}>{icon("export-kicad", <Factory size={15} />)} Export KiCad</Button>
    {simulations.length > 0 && <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800">
      <select aria-label="Simulation" value={simulation} onChange={(event) => setSimulation(event.target.value)} className="h-9 max-w-44 bg-transparent px-2 text-xs text-slate-200 outline-none">
        {simulations.map(({ name }) => <option key={name} value={name}>{name}</option>)}
      </select>
      <Button className="rounded-l-none" disabled={disabled || !simulation} onClick={() => void onRun("simulate", simulation)}>{icon("simulate", <Play size={14} />)} Run</Button>
    </div>}
  </div>;
}
