// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import {
  Activity,
  Box,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircuitBoard,
  Factory,
  FileJson2,
  LayoutDashboard,
  Menu,
  X,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn, shortDigest } from "../lib/utils";
import type { ProjectResponse } from "../types";
import { Badge, Button } from "./ui";

export interface NavigationItem {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
}

const navigation: readonly NavigationItem[] = [
  { label: "Overview", href: "/", icon: LayoutDashboard },
  { label: "Schematic", href: "/schematic", icon: Zap },
  { label: "PCB layout", href: "/pcb", icon: CircuitBoard },
  { label: "3D board", href: "/3d", icon: Box },
  { label: "Checks", href: "/checks", icon: CheckCircle2 },
  { label: "Simulations", href: "/simulations", icon: Activity },
  { label: "Manufacturing", href: "/manufacturing", icon: Factory },
  { label: "Circuit data", href: "/explorer", icon: FileJson2 },
] as const;

function matches(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppLink({ href, children, className, onNavigate, ...props }: { href: string; children: ReactNode; className?: string; onNavigate?: () => void; "aria-current"?: "page" }) {
  return <a
    href={href}
    className={className}
    {...props}
    onClick={(event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
      onNavigate?.();
    }}
  >{children}</a>;
}

function StatusBeacon({ project }: { project: ProjectResponse }) {
  const tone = project.snapshot.state === "ready" && !project.server.actionRunning && !project.server.syncingEvidence ? "success" : project.snapshot.state === "failed" ? "danger" : "warning";
  const label = project.server.actionRunning
    ? "Running checks…"
    : project.server.syncingEvidence
      ? "Syncing evidence…"
    : project.snapshot.state === "ready"
      ? "Live & synced"
      : project.snapshot.state === "pending"
        ? "Rebuilding circuit…"
        : "Rebuild failed";
  return <div className="flex items-center gap-2">
    <span className={cn("size-2 rounded-full", tone === "success" ? "bg-emerald-400" : tone === "warning" ? "animate-pulse bg-amber-400" : "bg-rose-400")} />
    <span className="text-xs font-bold text-[#d0cac2]" title={`Last synchronized ${project.server.activityUpdatedAt}`}>{label}</span>
  </div>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <AppLink href="/" className="flex min-w-0 items-center gap-3">
    <span className={cn("pcboo-spectrum-mark shrink-0", compact && "is-compact")} aria-hidden="true"><i /><i /><i /></span>
    <div className="min-w-0"><p className={cn("truncate font-bold tracking-[-0.045em] text-white", compact ? "text-lg" : "text-xl")}>PCBoo</p><p className="-mt-0.5 truncate font-mono text-[8px] font-medium uppercase tracking-[0.2em] text-[#87928c]">Circuit workbench</p></div>
  </AppLink>;
}

function WorkspaceNavigation({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return <nav className="grid gap-1.5" aria-label="PCBoo workspace">
    {navigation.map((item) => {
      const Icon = item.icon;
      const selected = matches(pathname, item.href);
      return <AppLink key={item.href} href={item.href} {...(onNavigate === undefined ? {} : { onNavigate })} {...(selected ? { "aria-current": "page" as const } : {})} className={cn(
        "group flex h-11 items-center gap-3 rounded-xl border px-3 text-sm font-bold transition-colors",
        selected
          ? "border-[#9cff57]/35 bg-[#9cff57]/10 text-[#caffaa]"
          : "border-transparent text-[#929c97] hover:border-white/10 hover:bg-white/[0.05] hover:text-white",
      )}>
        <Icon size={17} strokeWidth={selected ? 2.6 : 2} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <ChevronRight size={14} className={cn("transition-transform", selected ? "opacity-75" : "opacity-0 group-hover:translate-x-0.5 group-hover:opacity-50")} />
      </AppLink>;
    })}
  </nav>;
}

export function Shell({ pathname, project, children }: { pathname: string; project: ProjectResponse; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const active = navigation.find((item) => matches(pathname, item.href)) ?? navigation[0]!;
  const immersiveDesign = pathname === "/schematic" || pathname === "/pcb" || pathname === "/3d" || pathname.startsWith("/pcb/layers/");

  return <div className="flex h-dvh overflow-hidden bg-[#090a0a] text-[#f5f7f5] selection:bg-[#9cff57]/35">
    <aside className="hidden h-dvh w-60 shrink-0 flex-col border-r border-white/10 bg-[#0e1110] p-3 lg:flex">
      <div className="px-2 py-2"><Brand /></div>
      <div className="my-5 h-px bg-white/10" />
      <p className="mb-2 px-3 text-[10px] font-black uppercase tracking-[0.16em] text-[#6f6962]">Views</p>
      <WorkspaceNavigation pathname={pathname} />
      <div className="mt-auto rounded-2xl border border-white/10 bg-[#141816] p-3">
        <div className="flex items-center justify-between gap-2"><StatusBeacon project={project} /><Badge tone="neutral">r{project.snapshot.revision}</Badge></div>
        <p className="mt-3 truncate text-xs font-bold text-white">{project.project.name}</p>
        <p className="mt-1 text-[10px] uppercase tracking-wide text-[#817a72]">Circuit <code className="normal-case text-[#c8c1b8]">{shortDigest(project.snapshot.circuitDigest)}</code></p>
      </div>
    </aside>

    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0b0d0c]/95 px-4 sm:px-5">
        <div className="lg:hidden"><Brand compact /></div>
        <div className="hidden min-w-0 items-center gap-2 lg:flex"><span className="truncate text-xs font-bold text-[#9ba59f]">{project.project.name}</span><ChevronRight size={13} className="shrink-0 text-[#56605a]" /><span className="truncate text-xs font-bold text-[#9cff57]">{active.label}</span></div>
        <div className="ml-auto hidden items-center gap-4 text-[10px] uppercase tracking-wider text-[#817a72] sm:flex"><span>Engine <strong className="text-[#d0cac2]">{project.project.tscircuit.version}</strong></span><span className="lg:hidden"><StatusBeacon project={project} /></span></div>
        <Button variant="ghost" size="icon" className="ml-auto lg:hidden" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} onClick={() => setMobileOpen((value) => !value)}>{mobileOpen ? <X size={21} /> : <Menu size={21} />}</Button>
      </header>

      {mobileOpen && <><button className="fixed inset-0 top-14 z-30 bg-black/70 lg:hidden" aria-label="Close navigation overlay" onClick={() => setMobileOpen(false)} /><aside className="fixed inset-y-0 left-0 top-14 z-40 flex w-72 flex-col border-r border-white/10 bg-[#0e1110] p-4 shadow-2xl lg:hidden"><p className="mb-3 px-3 text-[10px] font-black uppercase tracking-[0.16em] text-[#6f6962]">Views</p><WorkspaceNavigation pathname={pathname} onNavigate={() => setMobileOpen(false)} /><div className="mt-auto rounded-xl border border-white/10 bg-[#141816] p-3"><StatusBeacon project={project} /></div></aside></>}

      {project.server.warnings.length > 0 && <div className="shrink-0 border-b border-orange-500/30 bg-orange-500/10 px-4 py-2 text-xs text-orange-100 sm:px-6">{project.server.warnings.map((warning) => <span key={warning.code} className="mr-4"><strong>{warning.code}</strong> — {warning.message}</span>)}</div>}
      <main className={cn("min-h-0 flex-1 overscroll-contain", immersiveDesign ? "overflow-hidden p-2 sm:p-2.5" : "overflow-y-auto p-4 sm:p-6 lg:p-7")} data-pcboo-workspace-pane>{children}</main>
    </div>
  </div>;
}

export function PageHeading({ eyebrow, title, description, actions, compact = false }: { eyebrow?: string; title: string; description: string; actions?: ReactNode; compact?: boolean }) {
  return <div className={cn("flex flex-col justify-between xl:flex-row xl:items-end", compact ? "mb-3 gap-2" : "mb-6 gap-4")}>
    <div className="min-w-0">{eyebrow && <p className={cn("font-mono font-medium uppercase tracking-[0.16em] text-[#75d59e]", compact ? "mb-0.5 text-[9px]" : "mb-1 text-[9px]")}>{eyebrow}</p>}<h1 className={cn("max-w-5xl break-words font-bold leading-none tracking-[-0.055em] text-white", compact ? "text-xl sm:text-2xl" : "text-2xl sm:text-3xl")}>{title}</h1><p className={cn("max-w-3xl text-[#9aa49f]", compact ? "mt-1 text-xs leading-5" : "mt-2 text-sm leading-5")}>{description}</p></div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>;
}

export function MobileSectionNav({ pathname }: { pathname: string }) {
  return <div className="-mx-4 mb-5 overflow-x-auto px-4 lg:hidden"><div className="flex min-w-max gap-2">{navigation.slice(1, 7).map((item) => <AppLink key={item.href} href={item.href} className={cn("rounded-full border px-3 py-1.5 text-xs font-bold", matches(pathname, item.href) ? "border-orange-400 bg-orange-400 text-black" : "border-white/15 text-[#c8c1b8]")}>{item.label}</AppLink>)}</div></div>;
}

export function ProductMark() {
  return <span className="inline-flex items-center gap-2"><Boxes size={16} className="text-orange-400" /> PCBoo workspace</span>;
}
