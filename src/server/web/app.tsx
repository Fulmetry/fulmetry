// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadProject, loadWorkspace, runAction } from "./lib/api";
import { Shell } from "./components/shell";
import { Button, Card, CardBody } from "./components/ui";
import { DashboardPage } from "./pages/dashboard";
import { PcbPage, SchematicPage, ThreeDPage } from "./pages/design";
import { ChecksPage } from "./pages/checks";
import { SimulationsPage } from "./pages/simulations";
import { ManufacturingPage } from "./pages/manufacturing";
import { ExplorerPage } from "./pages/explorer";
import type { ActionKind, WorkspaceData } from "./types";

function decodeSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<ActionKind | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const dataRef = useRef<WorkspaceData | null>(null);
  const pollInFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await loadWorkspace();
      dataRef.current = next;
      setData(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    const listener = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        const project = await loadProject();
        if (stopped) return;
        const current = dataRef.current?.project;
        if (
          !current || dataRef.current!.loadWarnings.length > 0 ||
          current.snapshot.revision !== project.snapshot.revision ||
          current.snapshot.state !== project.snapshot.state ||
          current.snapshot.circuitDigest !== project.snapshot.circuitDigest ||
          current.server.actionRunning !== project.server.actionRunning ||
          current.server.syncingEvidence !== project.server.syncingEvidence ||
          current.server.activityRevision !== project.server.activityRevision
        ) await refresh();
      } catch { /* retain the last usable workspace while the server rebuilds */ }
      finally { pollInFlight.current = false; }
    };
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const onRun = useCallback(async (kind: ActionKind, name?: string) => {
    const current = dataRef.current;
    if (!current) return;
    setRunning(kind);
    setActionResult(null);
    try {
      const result = await runAction(current.project, kind, name);
      const classification = typeof result.exitClassification === "string" ? result.exitClassification : "completed";
      setActionResult(`${kind === "export-kicad" ? "KiCad export" : kind} ${classification}. Evidence was attached to the live snapshot.`);
      await refresh();
    } catch (caught) {
      setActionResult(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(null);
    }
  }, [refresh]);

  if (!data) return <div className="grid min-h-screen place-items-center bg-[#1b1b1b] text-[#d0cac2]"><div className="text-center"><LoaderCircle className="mx-auto animate-spin text-orange-400" size={28} /><p className="mt-4 font-serif text-sm">Loading Fulmetry workspace…</p>{error && <p className="mt-2 max-w-md text-xs text-rose-300">{error}</p>}</div></div>;

  const layerMatch = /^\/pcb\/layers\/([^/]+)$/u.exec(pathname);
  const simulationMatch = /^\/simulations\/([^/]+)$/u.exec(pathname);
  let page: React.ReactNode;
  if (pathname === "/") page = <DashboardPage data={data} running={running} onRun={onRun} actionResult={actionResult} />;
  else if (pathname === "/schematic") page = <SchematicPage data={data} />;
  else if (pathname === "/pcb") page = <PcbPage data={data} />;
  else if (layerMatch) page = <PcbPage data={data} selectedLayer={decodeSegment(layerMatch[1])} />;
  else if (pathname === "/3d") page = <ThreeDPage data={data} />;
  else if (pathname === "/checks") page = <ChecksPage data={data} />;
  else if (pathname === "/simulations") page = <SimulationsPage data={data} running={running} onRun={onRun} />;
  else if (simulationMatch) page = <SimulationsPage data={data} selectedName={decodeSegment(simulationMatch[1])} running={running} onRun={onRun} />;
  else if (pathname === "/manufacturing") page = <ManufacturingPage data={data} running={running} onRun={onRun} />;
  else if (pathname === "/explorer") page = <ExplorerPage data={data} />;
  else page = <Card className="mx-auto max-w-xl"><CardBody className="flex flex-col items-center py-14 text-center"><AlertTriangle size={28} className="text-amber-300" /><h1 className="mt-4 text-xl font-semibold text-white">Workspace page not found</h1><p className="mt-2 text-sm text-slate-500">The requested browser route is not part of the fixed Fulmetry inspection surface.</p><Button className="mt-5" onClick={() => { history.pushState({}, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); }}><RefreshCw size={15} /> Return to overview</Button></CardBody></Card>;

  return <Shell pathname={pathname} project={data.project}>
    {error && <div role="alert" className="mb-5 rounded-lg border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">Live refresh failed: {error}. Showing the last usable snapshot.</div>}
    {data.loadWarnings.length > 0 && <div role="status" className="mb-5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"><p className="font-medium">Some derived evidence is temporarily unavailable.</p><ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-200/80">{data.loadWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
    {page}
  </Shell>;
}
