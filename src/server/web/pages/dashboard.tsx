// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { Activity, AlertTriangle, Boxes, CheckCircle2, CircuitBoard, FileOutput, Layers3, ShieldCheck } from "lucide-react";
import type { ActionKind, WorkspaceData } from "../types";
import { shortDigest, titleCase } from "../lib/utils";
import { ActionBar } from "../components/action-bar";
import { AppLink, PageHeading } from "../components/shell";
import { Badge, Card, CardBody, CardHeader, JsonDetails } from "../components/ui";

function statusTone(state: string): "success" | "warning" | "danger" | "neutral" {
  if (["pass", "passed", "ready", "current", "checked"].includes(state)) return "success";
  if (["fail", "failed", "error", "stale", "invalid"].includes(state)) return "danger";
  if (["pending", "warning", "unassessed", "not-run", "unchecked"].includes(state)) return "warning";
  return "neutral";
}

export function DashboardPage({ data, running, onRun, actionResult }: { data: WorkspaceData; running: ActionKind | null; onRun: (kind: ActionKind, name?: string) => Promise<void>; actionResult: string | null }) {
  const pcbElements = data.circuit.elements.filter(({ type }) => type.startsWith("pcb_"));
  const sourceComponents = data.circuit.elements.filter(({ type }) => type === "source_component");
  const board = data.circuit.elements.find(({ type }) => type === "pcb_board");
  const layers = Number(board?.num_layers ?? 2);
  const failed = Object.values(data.checks.statuses).filter(({ state }) => ["fail", "failed", "error", "invalid"].includes(state)).length;

  return <>
    <PageHeading eyebrow="Project control center" title={data.project.project.name} description="Inspect the current circuit snapshot, run deterministic checks, and move verified outputs toward fabrication." actions={<ActionBar project={data.project} simulations={data.simulations.simulations} running={running} onRun={onRun} />} />

    {actionResult && <div role="status" className="mb-5 rounded-xl border border-orange-400/35 bg-orange-400/10 px-4 py-3 text-sm text-orange-100">{actionResult}</div>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[
        { label: "Components", value: sourceComponents.length, detail: `${pcbElements.length} physical objects`, icon: Boxes, color: "text-orange-300" },
        { label: "Board stack", value: `${layers} layers`, detail: board && typeof board.width === "number" && typeof board.height === "number" ? `${board.width} × ${board.height} mm` : "Dimensions unavailable", icon: Layers3, color: "text-violet-300" },
        { label: "Diagnostics", value: data.checks.diagnostics.length, detail: failed ? `${failed} failing status groups` : "No failing status groups", icon: failed ? AlertTriangle : CheckCircle2, color: failed ? "text-amber-300" : "text-emerald-300" },
        { label: "Artifacts", value: data.artifacts.artifacts.length, detail: `${data.artifacts.evidence.state} evidence`, icon: FileOutput, color: "text-blue-300" },
      ].map(({ label, value, detail, icon: Icon, color }) => <Card key={label} className="bg-[#f4efe6]"><CardBody className="flex items-start justify-between"><div><p className="text-[11px] font-black uppercase tracking-wider text-[#736c63]">{label}</p><p className="mt-2 text-4xl font-black tracking-[-0.04em] text-[#171717]">{value}</p><p className="mt-2 font-serif text-sm text-[#625b53]">{detail}</p></div><div className={`rounded-full border border-black/10 bg-[#171717] p-3 ${color}`}><Icon size={19} /></div></CardBody></Card>)}
    </div>

    <div className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
      <Card>
        <CardHeader><div><h2 className="text-lg font-black text-white">Engineering readiness</h2><p className="mt-1 font-serif text-sm text-[#a9a198]">Independent status dimensions stay separate and explainable.</p></div><ShieldCheck size={19} className="text-orange-400" /></CardHeader>
        <CardBody className="grid gap-3 sm:grid-cols-2">
          {Object.entries(data.checks.statuses).map(([name, status]) => <AppLink href="/checks" key={name} className="group flex items-center justify-between rounded-xl border border-white/10 bg-[#191919] px-4 py-3 transition-colors hover:border-orange-400/45"><div><p className="text-sm font-bold text-slate-200 group-hover:text-white">{titleCase(name)}</p><p className="mt-0.5 font-serif text-xs text-[#817a72]">View evidence and diagnostics</p></div><Badge tone={statusTone(status.state)}>{status.state}</Badge></AppLink>)}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><div><h2 className="text-lg font-black text-white">Live snapshot</h2><p className="mt-1 font-serif text-sm text-[#a9a198]">Authoritative identity for this view.</p></div><Activity size={19} className="text-orange-400" /></CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between"><span className="text-sm text-slate-500">State</span><Badge tone={statusTone(data.project.snapshot.state)}>{data.project.snapshot.state}</Badge></div>
          <div className="flex items-center justify-between"><span className="text-sm text-slate-500">Revision</span><code className="text-xs text-slate-300">{data.project.snapshot.revision}</code></div>
          <div className="flex items-center justify-between gap-4"><span className="text-sm text-slate-500">Circuit</span><code title={data.project.snapshot.circuitDigest} className="truncate text-xs text-slate-300">{shortDigest(data.project.snapshot.circuitDigest)}</code></div>
          <div className="flex items-center justify-between gap-4"><span className="text-sm text-slate-500">Project</span><code title={data.project.snapshot.projectDigest} className="truncate text-xs text-slate-300">{shortDigest(data.project.snapshot.projectDigest)}</code></div>
          <div className="border-t border-slate-800 pt-4"><p className="text-xs text-slate-600">Source</p><code className="mt-1 block truncate text-xs text-slate-300">{data.project.project.config.entry}</code></div>
        </CardBody>
      </Card>
    </div>

    <div className="mt-5 grid gap-5 lg:grid-cols-3">
      {[
        { href: "/schematic", title: "Review schematic", detail: "Pan, zoom, and inspect the logical circuit.", icon: Activity },
        { href: "/pcb", title: "Inspect PCB layout", detail: "Toggle copper layers and measure geometry.", icon: CircuitBoard },
        { href: "/3d", title: "Open 3D board", detail: "Orbit around the assembled board and inspect placement.", icon: Boxes },
      ].map(({ href, title, detail, icon: Icon }) => <AppLink key={href} href={href}><Card className="h-full transition-all hover:-translate-y-1 hover:border-orange-400/45 hover:bg-[#2b2b2b]"><CardBody className="flex items-center gap-4"><div className="rounded-full bg-orange-400/10 p-3 text-orange-300"><Icon size={20} /></div><div><p className="text-lg font-black text-white">{title}</p><p className="mt-1 font-serif text-sm leading-5 text-[#a9a198]">{detail}</p></div></CardBody></Card></AppLink>)}
    </div>

    <div className="mt-5"><JsonDetails value={{ config: data.project.project.config, engine: data.project.project.tscircuit, serverLimits: data.project.server.limits }} label="Project and engine details" /></div>
  </>;
}
