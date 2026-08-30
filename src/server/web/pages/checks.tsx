// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { AlertCircle, CheckCircle2, CircleDashed, Filter, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeading } from "../components/shell";
import { Badge, Card, CardBody, CardHeader, EmptyState, JsonDetails } from "../components/ui";
import { titleCase } from "../lib/utils";
import type { DiagnosticRecord, WorkspaceData } from "../types";

function tone(state: string): "success" | "warning" | "danger" | "neutral" {
  if (/pass|ready|current/iu.test(state)) return "success";
  if (/fail|error|invalid|stale/iu.test(state)) return "danger";
  if (/warn|pending|not-run|unchecked|unassessed/iu.test(state)) return "warning";
  return "neutral";
}

function diagnosticText(diagnostic: DiagnosticRecord): string {
  return String(diagnostic.message ?? diagnostic.code ?? diagnostic.id ?? "Unlabelled diagnostic");
}

export function ChecksPage({ data }: { data: WorkspaceData }) {
  const [filter, setFilter] = useState("");
  const diagnostics = useMemo(() => data.checks.diagnostics.filter((diagnostic) => JSON.stringify(diagnostic).toLowerCase().includes(filter.toLowerCase())), [data.checks.diagnostics, filter]);
  return <>
    <PageHeading eyebrow="Engineering evidence" title="Checks and readiness" description="Review independent fabrication, electrical, functional, standards, and sourcing claims without collapsing unknowns into a single score." actions={<Badge tone={data.checks.evidence.state === "current" ? "success" : data.checks.evidence.state === "stale" ? "danger" : "neutral"}>{data.checks.evidence.state} evidence</Badge>} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{Object.entries(data.checks.statuses).map(([name, status]) => <Card key={name}><CardBody><div className="flex items-start justify-between gap-2"><div className={`rounded-lg border border-slate-700 bg-slate-800 p-2 ${tone(status.state) === "success" ? "text-emerald-300" : tone(status.state) === "danger" ? "text-rose-300" : "text-amber-300"}`}>{tone(status.state) === "success" ? <CheckCircle2 size={17} /> : tone(status.state) === "danger" ? <AlertCircle size={17} /> : <CircleDashed size={17} />}</div><Badge tone={tone(status.state)}>{status.state}</Badge></div><p className="mt-4 text-sm font-medium text-white">{titleCase(name)}</p><p className="mt-1 line-clamp-3 text-xs leading-5 text-slate-500">{typeof status.summary === "string" ? status.summary : "Independent verification status"}</p></CardBody></Card>)}</div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_22rem]">
      <Card><CardHeader className="items-center"><div><h2 className="text-lg font-black text-white">Diagnostics</h2><p className="mt-1 font-serif text-sm text-[#a9a198]">{data.checks.diagnostics.length} findings in this snapshot</p></div><label className="flex h-9 items-center gap-2 rounded-full border border-white/15 bg-[#191919] px-3 text-[#817a72] focus-within:border-orange-400"><Filter size={14} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter diagnostics" className="w-40 bg-transparent text-xs text-slate-200 outline-none placeholder:text-[#6f6962]" /></label></CardHeader><CardBody className="space-y-3">{diagnostics.length === 0 ? <EmptyState icon={<ShieldCheck size={21} />} title={filter ? "No matching diagnostics" : "No diagnostics recorded"} description={filter ? "Try a broader filter." : "Run checks to generate fresh, snapshot-bound engineering evidence."} /> : diagnostics.map((diagnostic, index) => <div key={String(diagnostic.id ?? diagnostic.code ?? index)} className="rounded-xl border border-white/10 bg-[#191919] p-4"><div className="flex flex-wrap items-center gap-2"><Badge tone={tone(String(diagnostic.severity ?? "neutral"))}>{String(diagnostic.severity ?? "finding")}</Badge>{diagnostic.code && <code className="text-xs text-slate-500">{diagnostic.code}</code>}</div><p className="mt-3 text-sm leading-6 text-slate-300">{diagnosticText(diagnostic)}</p><details className="mt-3"><summary className="cursor-pointer text-xs text-[#817a72]">Details</summary><pre className="mt-2 overflow-auto text-[11px] text-slate-500">{JSON.stringify(diagnostic, null, 2)}</pre></details></div>)}</CardBody></Card>
      <div className="space-y-4"><JsonDetails label="Evidence runs" value={data.checks.evidenceActions} /><JsonDetails label="Sourcing evidence" value={data.checks.sourcingEvidence} /><JsonDetails label="Last check action" value={data.checks.lastAction} /></div>
    </div>
  </>;
}
