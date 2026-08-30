// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { AlertTriangle, Check, Copy, Crosshair, Eye, EyeOff, LocateFixed, MessageSquareText, Minus, MousePointer2, Plus, Ruler, ScanSearch, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { elementId } from "../lib/utils";
import { canCopyComponentMoveFeedback, componentMoveFeedbackPrompt, componentPlacementChangesPrompt, resolveComponentFeedbackSelection, type ComponentFeedbackSelection, type ComponentPlacementChange, type SelectionIdentifiers } from "../lib/component-feedback";
import type { CircuitElement, SnapshotState } from "../types";
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton } from "./ui";

type ViewBox = { x: number; y: number; width: number; height: number };
type BoardMapping = { svgX: number; svgY: number; svgWidth: number; svgHeight: number; boardX: number; boardY: number; boardWidth: number; boardHeight: number };

function parseViewBox(svg: SVGSVGElement): ViewBox {
  const values = svg.getAttribute("viewBox")?.split(/\s+/u).map(Number);
  if (values?.length === 4 && values.every(Number.isFinite)) return { x: values[0]!, y: values[1]!, width: values[2]!, height: values[3]! };
  return { x: 0, y: 0, width: Number.parseFloat(svg.getAttribute("width") ?? "1000") || 1000, height: Number.parseFloat(svg.getAttribute("height") ?? "700") || 700 };
}

function schematicContentViewBox(svg: SVGSVGElement, fallback: ViewBox): ViewBox {
  const nodes = svg.querySelectorAll<SVGGraphicsElement>(".sch-component, .sch-trace, .sch-text");
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    try {
      const box = node.getBBox();
      if (box.width <= 0 && box.height <= 0) continue;
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    } catch { /* ignore non-rendered SVG nodes */ }
  }
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return fallback;
  const padding = Math.max(18, Math.max(right - left, bottom - top) * 0.035);
  return { x: left - padding, y: top - padding, width: right - left + padding * 2, height: bottom - top + padding * 2 };
}

function selectedRecord(target: Element): SelectionIdentifiers | null {
  const item = target.closest("[data-type], [data-circuit-json-type]") as HTMLElement | null;
  if (!item) return null;
  return {
    type: item.dataset.type ?? item.dataset.circuitJsonType ?? "unknown",
    layer: item.dataset.pcbLayer ?? null,
    pad: item.dataset.padName ?? null,
    pcbComponentId: item.dataset.pcbComponentId ?? null,
    sourceComponentId: item.dataset.sourceComponentId ?? null,
    schematicComponentId: item.dataset.schematicComponentId ?? null,
  };
}

function elementCenter(element: CircuitElement | undefined): { x: number; y: number } {
  const center = element?.center;
  if (typeof center !== "object" || center === null || Array.isArray(center)) return { x: 0, y: 0 };
  const record = center as Record<string, unknown>;
  return { x: typeof record.x === "number" ? record.x : 0, y: typeof record.y === "number" ? record.y : 0 };
}

function componentSize(circuit: readonly CircuitElement[], reference: string): { width: number; height: number } {
  const source = circuit.find((element) => element.type === "source_component" && element.name === reference);
  const pcb = circuit.find((element) => element.type === "pcb_component" && element.source_component_id === source?.source_component_id);
  return {
    width: typeof pcb?.width === "number" ? Math.max(pcb.width, 1) : 3,
    height: typeof pcb?.height === "number" ? Math.max(pcb.height, 1) : 2,
  };
}

function finiteRotation(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function prepareRenderedSvg(source: string): { svg: string; warnings: string[] } {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const warnings = [...document.querySelectorAll('[data-type="error_text_overlay"] tspan')]
    .map((item) => item.textContent?.trim() ?? "")
    .filter(Boolean);
  for (const overlay of document.querySelectorAll('[data-type="error_text_overlay"]')) overlay.remove();
  return { svg: new XMLSerializer().serializeToString(document.documentElement), warnings };
}

export function DesignViewer({ kind, snapshot, circuit, layers = [], selectedLayer }: {
  kind: "pcb" | "schematic";
  snapshot: SnapshotState;
  circuit: readonly CircuitElement[];
  layers?: readonly string[];
  selectedLayer?: string | undefined;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [renderWarnings, setRenderWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ComponentFeedbackSelection | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [placementChanges, setPlacementChanges] = useState<ComponentPlacementChange[]>([]);
  const [boardMapping, setBoardMapping] = useState<BoardMapping | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showNetLabels, setShowNetLabels] = useState(false);
  const [showPinNumbers, setShowPinNumbers] = useState(false);
  const [showPinLabels, setShowPinLabels] = useState(false);
  const [measurement, setMeasurement] = useState("Measurement off");
  const [measuring, setMeasuring] = useState(false);
  const [visibleLayers, setVisibleLayers] = useState(() => new Set(selectedLayer ? [selectedLayer] : layers));
  const viewRef = useRef<ViewBox | null>(null);
  const initialRef = useRef<ViewBox | null>(null);
  const dragRef = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const ghostDragRef = useRef<string | null>(null);
  const didPanRef = useRef(false);
  const overlayRef = useRef<SVGSVGElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measurePoints = useRef<{ x: number; y: number }[]>([]);
  const board = circuit.find(({ type }) => type === "pcb_board");
  const boardWidth = typeof board?.width === "number" ? board.width : undefined;
  const boardHeight = typeof board?.height === "number" ? board.height : undefined;
  const endpoint = kind === "schematic" ? "/api/render/schematic" : selectedLayer ? `/api/render/pcb/layers/${encodeURIComponent(selectedLayer)}` : "/api/render/pcb";

  useEffect(() => {
    const controller = new AbortController();
    setSvg(null);
    setRenderWarnings([]);
    setLoadError(null);
    fetch(endpoint, { headers: { Accept: "image/svg+xml" }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Renderer returned ${response.status}`);
        return await response.text();
      })
      .then((source) => {
        const prepared = prepareRenderedSvg(source);
        setSvg(prepared.svg);
        setRenderWarnings(prepared.warnings);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [endpoint, snapshot.circuitDigest]);

  const renderedElements = useMemo(() => circuit.filter(({ type }) => kind === "pcb" ? type.startsWith("pcb_") : type.startsWith("schematic_")), [circuit, kind]);

  useEffect(() => {
    const root = rootRef.current;
    const svgElement = root?.querySelector("svg");
    if (!root || !svgElement || !svg) return;
    const parsed = parseViewBox(svgElement);
    const initial = kind === "schematic" ? schematicContentViewBox(svgElement, parsed) : parsed;
    initialRef.current = initial;
    viewRef.current = initial;
    svgElement.setAttribute("viewBox", `${initial.x} ${initial.y} ${initial.width} ${initial.height}`);
    overlayRef.current?.setAttribute("viewBox", `${initial.x} ${initial.y} ${initial.width} ${initial.height}`);
    if (kind === "pcb" && boardWidth !== undefined && boardHeight !== undefined) {
      const boardShape = svgElement.querySelector<SVGGraphicsElement>(".pcb-board");
      if (boardShape) {
        const box = boardShape.getBBox();
        const at = elementCenter(board);
        setBoardMapping({ svgX: box.x, svgY: box.y, svgWidth: box.width, svgHeight: box.height, boardX: at.x, boardY: at.y, boardWidth, boardHeight });
      }
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 0.84 : 1.18, event.clientX, event.clientY);
    };
    svgElement.addEventListener("wheel", wheel, { passive: false });
    return () => svgElement.removeEventListener("wheel", wheel);
  }, [svg, kind, board, boardWidth, boardHeight]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    const svgElement = rootRef.current?.querySelector("svg");
    if (!svgElement || kind !== "pcb") return;
    for (const item of svgElement.querySelectorAll<HTMLElement>("[data-pcb-layer]")) {
      const layer = item.dataset.pcbLayer;
      item.style.display = !layer || layer === "global" || layer === "board" || visibleLayers.has(layer) ? "" : "none";
    }
  }, [visibleLayers, svg, kind]);

  useEffect(() => {
    const svgElement = rootRef.current?.querySelector("svg");
    if (!svgElement || kind !== "schematic") return;
    for (const item of svgElement.querySelectorAll<HTMLElement>(".sch-net-label")) item.style.display = showNetLabels ? "" : "none";
    for (const item of svgElement.querySelectorAll<HTMLElement>(".sch-pin-number")) item.style.display = showPinNumbers ? "" : "none";
    for (const item of svgElement.querySelectorAll<HTMLElement>(".sch-pin-label")) item.style.display = showPinLabels ? "" : "none";
  }, [showNetLabels, showPinNumbers, showPinLabels, svg, kind]);

  function apply(view: ViewBox) {
    viewRef.current = view;
    rootRef.current?.querySelector("svg")?.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
    overlayRef.current?.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
  }

  function zoom(factor: number, clientX?: number, clientY?: number) {
    const svgElement = rootRef.current?.querySelector("svg");
    const view = viewRef.current;
    const initial = initialRef.current;
    if (!svgElement || !view || !initial) return;
    const rect = svgElement.getBoundingClientRect();
    const rx = clientX === undefined ? 0.5 : (clientX - rect.left) / rect.width;
    const ry = clientY === undefined ? 0.5 : (clientY - rect.top) / rect.height;
    const width = Math.min(initial.width * 12, Math.max(initial.width / 120, view.width * factor));
    const height = Math.min(initial.height * 12, Math.max(initial.height / 120, view.height * factor));
    apply({ x: view.x + rx * (view.width - width), y: view.y + ry * (view.height - height), width, height });
  }

  function boardPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const svgElement = rootRef.current?.querySelector("svg");
    const matrix = svgElement?.getScreenCTM();
    if (!matrix || boardMapping === null) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return {
      x: boardMapping.boardX - boardMapping.boardWidth / 2 + (point.x - boardMapping.svgX) * boardMapping.boardWidth / boardMapping.svgWidth,
      y: boardMapping.boardY + boardMapping.boardHeight / 2 - (point.y - boardMapping.svgY) * boardMapping.boardHeight / boardMapping.svgHeight,
    };
  }

  function componentAt(point: { x: number; y: number }): ComponentFeedbackSelection | null {
    const matches = circuit
      .filter((element) => element.type === "pcb_component")
      .flatMap((element) => {
        const at = elementCenter(element);
        const width = typeof element.width === "number" ? element.width : 3;
        const height = typeof element.height === "number" ? element.height : 2;
        const dx = Math.abs(point.x - at.x);
        const dy = Math.abs(point.y - at.y);
        return dx <= width / 2 + 0.8 && dy <= height / 2 + 0.8 ? [{ element, distance: Math.hypot(dx, dy) }] : [];
      })
      .sort((left, right) => left.distance - right.distance);
    const element = matches[0]?.element;
    if (element === undefined) return null;
    return resolveComponentFeedbackSelection(circuit, {
      type: element.type,
      pcbComponentId: typeof element.pcb_component_id === "string" ? element.pcb_component_id : null,
      sourceComponentId: typeof element.source_component_id === "string" ? element.source_component_id : null,
      layer: typeof element.layer === "string" ? element.layer : null,
    });
  }

  function placeGhost(reference: string, clientX: number, clientY: number): void {
    if (!canCopyComponentMoveFeedback(selection) || selection.reference !== reference) return;
    const point = boardPoint(clientX, clientY);
    if (point === null) return;
    const next: ComponentPlacementChange = {
      reference,
      ...(selection.description === undefined ? {} : { description: selection.description }),
      fromX: selection.xMm,
      fromY: selection.yMm,
      toX: point.x,
      toY: point.y,
      ...(selection.rotationDeg === undefined ? {} : { rotationDeg: selection.rotationDeg }),
      ...(selection.side === undefined ? {} : { side: selection.side }),
      movementPolicy: selection.movementPolicy || "not declared",
    };
    setPlacementChanges((current) => [...current.filter((change) => change.reference !== reference), next]);
  }

  function moveGhost(reference: string, clientX: number, clientY: number): void {
    const point = boardPoint(clientX, clientY);
    if (point === null) return;
    setPlacementChanges((current) => current.map((change) => change.reference === reference ? { ...change, toX: point.x, toY: point.y } : change));
  }

  function notify(message: string): void {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 2_600);
  }

  async function copyPlacementChanges(): Promise<void> {
    if (placementChanges.length === 0) return;
    await navigator.clipboard.writeText(componentPlacementChangesPrompt(placementChanges));
    notify(`${placementChanges.length} placement change${placementChanges.length === 1 ? "" : "s"} copied`);
  }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (measuring || !(event.target instanceof SVGElement)) return;
    const ghost = event.target.closest<SVGElement>("[data-placement-reference]");
    if (ghost?.dataset.placementReference) {
      ghostDragRef.current = ghost.dataset.placementReference;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    didPanRef.current = false;
    dragRef.current = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (ghostDragRef.current !== null) {
      moveGhost(ghostDragRef.current, event.clientX, event.clientY);
      return;
    }
    const drag = dragRef.current;
    const view = viewRef.current;
    const svgElement = rootRef.current?.querySelector("svg");
    if (!drag || !view || !svgElement) return;
    const rect = svgElement.getBoundingClientRect();
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) didPanRef.current = true;
    apply({ ...view, x: drag.viewX - (event.clientX - drag.x) * view.width / rect.width, y: drag.viewY - (event.clientY - drag.y) * view.height / rect.height });
  }

  function viewerClick(event: React.MouseEvent<HTMLDivElement>) {
    const svgElement = rootRef.current?.querySelector("svg");
    if (!svgElement || !(event.target instanceof Element)) return;
    if (didPanRef.current) {
      didPanRef.current = false;
      return;
    }
    if (!measuring) {
      const record = selectedRecord(event.target);
      if (record !== null) {
        const candidate = resolveComponentFeedbackSelection(circuit, record);
        if (canCopyComponentMoveFeedback(candidate)) {
          setSelection(candidate);
          setInspectorOpen(true);
          return;
        }
      }
      if (kind === "pcb") {
        const point = boardPoint(event.clientX, event.clientY);
        const nearby = point === null ? null : componentAt(point);
        if (canCopyComponentMoveFeedback(nearby)) {
          setSelection(nearby);
          setInspectorOpen(true);
          return;
        }
      }
      if (kind === "pcb" && canCopyComponentMoveFeedback(selection)) placeGhost(selection.reference, event.clientX, event.clientY);
      return;
    }
    const matrix = svgElement.getScreenCTM();
    if (!matrix || !boardWidth) {
      setMeasurement("Exact visual scale unavailable; use Circuit data for structured inspection.");
      return;
    }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    measurePoints.current.push(point);
    if (measurePoints.current.length === 1) setMeasurement("Select the second point");
    if (measurePoints.current.length === 2) {
      const boardShape = svgElement.querySelector<SVGGraphicsElement>(".pcb-board");
      if (!boardShape) setMeasurement("Board scale marker unavailable.");
      else {
        const unitsPerMm = boardShape.getBBox().width / boardWidth;
        const [left, right] = measurePoints.current;
        setMeasurement(`${Math.hypot(right!.x - left!.x, right!.y - left!.y) / unitsPerMm}`.slice(0, 8) + " mm visual measurement");
      }
      measurePoints.current = [];
    }
  }

  return <div className="flex h-full min-h-0 flex-col gap-2">{renderWarnings.length > 0 && <details className="shrink-0 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-100" role="status"><summary className="flex cursor-pointer items-center gap-2 text-xs font-bold"><AlertTriangle className="shrink-0 text-amber-300" size={14} />{renderWarnings.length} unresolved physical package assignments <span className="font-normal text-amber-100/55">— drawing overlays hidden; expand for details</span></summary><ul className="mt-2 max-h-32 list-disc space-y-1 overflow-auto border-t border-amber-300/15 pt-2 pl-5 font-mono text-[10px] text-amber-100/65">{renderWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
    <Card className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <CardHeader className="shrink-0 flex-wrap items-center py-1.5">
        <div className="flex items-center gap-2"><Badge tone={snapshot.state === "ready" ? "success" : snapshot.state === "pending" ? "warning" : "danger"}>{snapshot.state}</Badge><span className="text-xs text-slate-500">revision {snapshot.revision}</span></div>
        <div className="flex flex-wrap items-center gap-1">
          {kind === "schematic" && <><Button variant={showNetLabels ? "default" : "ghost"} size="sm" onClick={() => setShowNetLabels((value) => !value)}>{showNetLabels ? <Eye size={14} /> : <EyeOff size={14} />} Net labels</Button><Button variant={showPinLabels ? "default" : "ghost"} size="sm" onClick={() => setShowPinLabels((value) => !value)}>{showPinLabels ? <Eye size={14} /> : <EyeOff size={14} />} Pin names</Button><Button variant={showPinNumbers ? "default" : "ghost"} size="sm" onClick={() => setShowPinNumbers((value) => !value)}>{showPinNumbers ? <Eye size={14} /> : <EyeOff size={14} />} Pin numbers</Button></>}
          {kind === "pcb" && <><Button size="sm" disabled={placementChanges.length === 0} onClick={() => void copyPlacementChanges()}><Copy size={14} /> Copy changes{placementChanges.length > 0 ? ` (${placementChanges.length})` : ""}</Button>{placementChanges.length > 0 && <Button variant="ghost" size="sm" onClick={() => setPlacementChanges([])}><Trash2 size={14} /> Clear</Button>}</>}
          <Button variant="ghost" size="icon" title="Zoom in" onClick={() => zoom(0.8)}><Plus size={16} /></Button>
          <Button variant="ghost" size="icon" title="Zoom out" onClick={() => zoom(1.25)}><Minus size={16} /></Button>
          <Button variant="ghost" size="icon" title="Fit view" onClick={() => initialRef.current && apply(initialRef.current)}><LocateFixed size={16} /></Button>
          {kind === "pcb" && <Button variant={measuring ? "default" : "ghost"} size="sm" onClick={() => { setMeasuring((value) => !value); measurePoints.current = []; setMeasurement(measuring ? "Measurement off" : "Select the first point"); }}><Ruler size={15} /> Measure</Button>}
        </div>
      </CardHeader>
      <div
        ref={rootRef}
        data-fulmetry-viewer
        className={`design-canvas relative min-h-0 flex-1 overflow-hidden bg-[#080b0a] ${measuring ? "is-measuring" : ""}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={() => { dragRef.current = null; ghostDragRef.current = null; }}
        onClick={viewerClick}
      >
        {!svg && !loadError && <div className="p-6"><Skeleton className="h-[34rem] w-full" /></div>}
        {loadError && <div className="p-6"><EmptyState icon={<ScanSearch size={20} />} title="Render unavailable" description={`${loadError}. Structured Circuit JSON remains available in Circuit data.`} /></div>}
        {svg && <div className="absolute inset-0" dangerouslySetInnerHTML={{ __html: svg }} />}
        {kind === "pcb" && boardMapping !== null && <svg ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-label="Placement feedback overlay">
          {placementChanges.map((change) => {
            const atX = boardMapping.svgX + (change.toX - boardMapping.boardX + boardMapping.boardWidth / 2) * boardMapping.svgWidth / boardMapping.boardWidth;
            const atY = boardMapping.svgY + (boardMapping.boardY + boardMapping.boardHeight / 2 - change.toY) * boardMapping.svgHeight / boardMapping.boardHeight;
            const fromX = boardMapping.svgX + (change.fromX - boardMapping.boardX + boardMapping.boardWidth / 2) * boardMapping.svgWidth / boardMapping.boardWidth;
            const fromY = boardMapping.svgY + (boardMapping.boardY + boardMapping.boardHeight / 2 - change.fromY) * boardMapping.svgHeight / boardMapping.boardHeight;
            const size = componentSize(circuit, change.reference);
            const width = size.width * boardMapping.svgWidth / boardMapping.boardWidth;
            const height = size.height * boardMapping.svgHeight / boardMapping.boardHeight;
            const stroke = Math.max(1, boardMapping.svgWidth / boardMapping.boardWidth * 0.16);
            return <g key={change.reference}>
              <line x1={fromX} y1={fromY} x2={atX} y2={atY} stroke="rgb(156 255 87 / 65%)" strokeWidth={stroke * 0.7} strokeDasharray={`${stroke * 2} ${stroke * 2}`} />
              <circle cx={fromX} cy={fromY} r={stroke * 1.8} fill="none" stroke="rgb(148 163 184 / 70%)" strokeWidth={stroke * 0.7} />
              <g data-placement-reference={change.reference} transform={`translate(${atX} ${atY}) rotate(${-finiteRotation(change.rotationDeg)})`} style={{ pointerEvents: "all", cursor: "move" }} onClick={(event) => event.stopPropagation()}>
                <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={Math.min(width, height) * 0.12} fill="rgb(156 255 87 / 24%)" stroke="#9cff57" strokeWidth={stroke} strokeDasharray={`${stroke * 2.5} ${stroke * 1.5}`} />
                <text x={0} y={0} dominantBaseline="central" textAnchor="middle" fill="#fff7ed" fontSize={Math.max(stroke * 4.5, Math.min(width, height) * 0.28)} fontWeight="700" style={{ pointerEvents: "none" }}>{change.reference}</text>
              </g>
            </g>;
          })}
        </svg>}
        {kind === "pcb" && canCopyComponentMoveFeedback(selection) && !placementChanges.some((change) => change.reference === selection.reference) && <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-[#9cff57]/30 bg-[#090c0a]/90 px-3 py-1.5 text-xs text-[#dfffd0] shadow-lg">Click an empty board location to place a ghost of {selection.reference}</div>}
        {toast !== null && <div role="status" className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-950/95 px-3 py-2 text-xs font-bold text-emerald-100 shadow-xl"><Check size={15} className="text-emerald-300" /> {toast}</div>}
        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-md border border-slate-700/70 bg-slate-950/85 px-2.5 py-1.5 text-[11px] text-slate-400 backdrop-blur"><MousePointer2 size={12} /> Drag to pan · Scroll to zoom</div>
        {kind === "pcb" && measurement !== "Measurement off" && <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-orange-400/30 bg-slate-950/90 px-3 py-1.5 text-xs text-orange-100">{measurement}</div>}
        {inspectorOpen && <aside className="absolute inset-y-3 right-3 z-10 flex w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#111513]/95 shadow-2xl backdrop-blur">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 px-3"><div className="flex items-center gap-2"><Crosshair size={15} className="text-[#9cff57]" /><h2 className="text-sm font-bold text-white">Component feedback</h2></div><Button variant="ghost" size="icon" title="Close inspector" onClick={() => setInspectorOpen(false)}><X size={16} /></Button></div>
          <div className="min-h-0 flex-1 overflow-auto p-3">{selection ? <><dl className="space-y-2.5">{Object.entries(selection).map(([key, value]) => <div key={key}><dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">{key}</dt><dd className="mt-0.5 break-all font-mono text-xs text-slate-300">{String(value ?? "—")}</dd></div>)}</dl>{canCopyComponentMoveFeedback(selection) ? <><Button className="mt-4 w-full" size="sm" onClick={() => void navigator.clipboard.writeText(componentMoveFeedbackPrompt(selection))}><MessageSquareText size={15} /> Copy move request</Button><p className="mt-2 text-[11px] leading-5 text-slate-500">Paste the request into your coding-agent chat and replace the bracketed instruction.</p></> : <p className="mt-4 rounded-md border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[11px] leading-5 text-amber-100/80">This drawing object is not owned by a movable component. Select a component body, pad, or plated hole to create a move request.</p>}</> : <EmptyState icon={<Crosshair size={20} />} title="No component selected" description="Select a component or pad in the canvas." />}
          <details className="mt-4 border-t border-white/10 pt-3"><summary className="cursor-pointer text-xs font-bold text-slate-400">{renderedElements.length} rendered elements</summary><pre className="mt-2 max-h-48 overflow-auto text-[10px] text-slate-600">{JSON.stringify(renderedElements.slice(0, 100).map((element) => ({ id: elementId(element), type: element.type })), null, 2)}</pre></details></div>
        </aside>}
      </div>
      {kind === "pcb" && <div className="flex min-h-11 flex-wrap items-center gap-2 border-t border-slate-800 px-4 py-2">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-slate-600">Layers</span>
        {layers.map((layer) => {
          const visible = visibleLayers.has(layer);
          return <button key={layer} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${visible ? "border-[#9cff57]/40 bg-[#9cff57]/10 text-[#caffaa]" : "border-white/10 text-[#626d67]"}`} onClick={() => setVisibleLayers((current) => { const next = new Set(current); if (next.has(layer)) next.delete(layer); else next.add(layer); return next; })}>{visible ? <Eye size={12} /> : <EyeOff size={12} />}{layer}</button>;
        })}
      </div>}
    </Card>
  </div>;
}
