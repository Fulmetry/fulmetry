// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { Box, CircuitBoard, Layers3, Zap } from "lucide-react";
import { lazy, Suspense } from "react";
import { DesignViewer } from "../components/design-viewer";
import { AppLink } from "../components/shell";
import { Badge, Card, Skeleton } from "../components/ui";
import type { WorkspaceData } from "../types";

const Board3D = lazy(() => import("../components/board-3d"));

function boardLayers(data: WorkspaceData): string[] {
  const found = new Set<string>();
  for (const element of data.circuit.elements) {
    for (const value of [element.layer, element.from_layer, element.to_layer]) if (typeof value === "string") found.add(value);
    if (Array.isArray(element.layers)) for (const layer of element.layers) if (typeof layer === "string") found.add(layer);
  }
  const order = ["top", "inner1", "inner2", "bottom"];
  return [...found].sort((left, right) => (order.indexOf(left) < 0 ? 99 : order.indexOf(left)) - (order.indexOf(right) < 0 ? 99 : order.indexOf(right)) || left.localeCompare(right));
}

export function SchematicPage({ data }: { data: WorkspaceData }) {
  return <div className="flex h-full min-h-0 flex-col gap-2"><DesignPageBar icon={<Zap size={15} />} title="Schematic" detail="Connectivity and component intent" actions={<Badge tone="info">{data.circuit.elements.filter(({ type }) => type.startsWith("schematic_")).length} objects</Badge>} /><div className="min-h-0 flex-1"><DesignViewer kind="schematic" snapshot={data.project.snapshot} circuit={data.circuit.elements} /></div></div>;
}

export function PcbPage({ data, selectedLayer }: { data: WorkspaceData; selectedLayer?: string | undefined }) {
  const layers = boardLayers(data);
  const layerFocus = layers.length > 1 && <div className="flex min-w-0 items-center gap-1 overflow-x-auto"><span className="mr-1 shrink-0 text-[9px] font-bold uppercase tracking-[0.14em] text-[#77817c]">Focus</span><AppLink href="/pcb" className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold ${!selectedLayer ? "border-[#9cff57] bg-[#9cff57] text-[#0b0e0c]" : "border-white/15 text-[#a8b0ac]"}`}>All</AppLink>{layers.map((layer) => <AppLink key={layer} href={`/pcb/layers/${encodeURIComponent(layer)}`} className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold ${selectedLayer === layer ? "border-[#9cff57] bg-[#9cff57] text-[#0b0e0c]" : "border-white/15 text-[#a8b0ac]"}`}>{layer}</AppLink>)}</div>;
  return <div className="flex h-full min-h-0 flex-col gap-2">
    <DesignPageBar icon={<CircuitBoard size={15} />} title={selectedLayer ? `${selectedLayer} layer` : "PCB layout"} detail="Routed geometry and placement feedback" center={layerFocus} actions={<><Badge tone="info"><Layers3 size={11} className="mr-1" /> {layers.length} layers</Badge><CompactViewLink href="/3d" icon={<Box size={13} />}>3D</CompactViewLink></>} />
    <div className="min-h-0 flex-1"><DesignViewer kind="pcb" snapshot={data.project.snapshot} circuit={data.circuit.elements} layers={layers} selectedLayer={selectedLayer} /></div>
  </div>;
}

export function ThreeDPage({ data }: { data: WorkspaceData }) {
  const componentCount = data.circuit.elements.filter(({ type }) => type === "pcb_component").length;
  return <div className="flex h-full min-h-0 flex-col gap-2"><DesignPageBar icon={<Box size={15} />} title="3D board" detail="Assembly and mechanical relationships" actions={<><Badge tone="info"><CircuitBoard size={11} className="mr-1" /> {componentCount} components</Badge><CompactViewLink href="/pcb" icon={<Layers3 size={13} />}>2D</CompactViewLink></>} /><Card className="min-h-0 flex-1 overflow-hidden"><Suspense fallback={<div className="h-full p-3"><Skeleton className="h-full min-h-80" /></div>}><Board3D circuit={data.circuit.elements} /></Suspense></Card></div>;
}

function CompactViewLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <AppLink href={href} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-2.5 text-[10px] font-bold text-[#c7ceca] transition-colors hover:border-[#9cff57]/50 hover:text-[#9cff57]">{icon}{children}</AppLink>;
}

function DesignPageBar({ icon, title, detail, center, actions }: { icon: React.ReactNode; title: string; detail: string; center?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="flex min-h-9 shrink-0 items-center gap-3 rounded-xl border border-white/10 bg-[#111513]/85 px-3 py-1.5 shadow-[0_8px_22px_rgba(0,0,0,.18)]">
    <div className="flex min-w-0 shrink-0 items-center gap-2 text-[#9cff57]">{icon}<h1 className="text-sm font-bold tracking-[-0.02em] text-[#f5f7f5]">{title}</h1><span className="hidden text-[10px] text-[#7e8983] md:inline">{detail}</span></div>
    {center && <div className="min-w-0 flex-1">{center}</div>}
    {!center && <div className="flex-1" />}
    {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
  </div>;
}
