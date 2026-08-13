// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runCli, type CliRun, type RunCliOptions } from "../cli/runner";
import { discoverProject, type DiscoveredProject } from "../project/discovery";
import { loadProjectConfig, type PcbooConfig } from "../project/config";
import {
  evaluateProjectCircuitTwice,
  type ProjectCircuitEvaluation,
} from "../project/evaluate";
import { loadPcbooLock, type PcbooLock } from "../project/lock";
import { statusSet, unassessedStatusSet, type StatusSet } from "../status";
import {
  requireTscircuitIdentity,
  type TscircuitIdentityReport,
} from "../engine-identity";
import type { Diagnostic } from "../diagnostics";
import type { ArtifactReference, ExitClassification } from "../result";
import { digestProjectInputs } from "../project/input-digest";
import { assessRecordedSourcing, type RecordedSourcingEvidence } from "../sourcing";
import type { AnyCircuitElement } from "circuit-json";
import {
  convertCircuitJsonToPcbSvg,
  convertCircuitJsonToSchematicSvg,
} from "circuit-to-svg";
import {
  boundsGap,
  inspectableElements,
  intersects,
  logicalConnectivityPath,
  physicalConnectivityPath,
  relationPath,
  unconnectedManufacturedEndpointIds,
  type BoundsMm,
  type PointMm,
} from "./inspection";
import {
  captureServerGeneratedFileAuthority,
  captureServerArtifactAuthority,
  ServerArtifactFreshnessError,
  verifyServerArtifactAuthority,
  type ServerArtifactAuthority,
  type ServerGeneratedFileAuthority,
} from "./artifact-freshness";
import { requireSupportedBunRuntime } from "../runtime";
import {
  deriveAuthoritativeConnectivity,
  type AuthoritativeConnectivity,
} from "../authoritative-connectivity";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_MAX_QUERY_BYTES = 2_048;
const MAX_INSPECT_VALUE_LENGTH = 256;
const MAX_INSPECT_RESULTS = 200;
const DEFAULT_WATCH_DEBOUNCE_MS = 75;
const DEFAULT_ACTION_BODY_BYTES = 1_024;
const DEFAULT_ACTION_BODY_TIMEOUT_MS = 5_000;

const VIEWER_SCRIPT = String.raw`(() => {
  const number = (value) => Number.parseFloat(value || "");
  for (const root of document.querySelectorAll("[data-pcboo-viewer]")) {
    const svg = root.querySelector("svg");
    if (!svg) continue;
    const width = number(svg.getAttribute("width")) || 1000;
    const height = number(svg.getAttribute("height")) || 700;
    let view = { x: 0, y: 0, width, height };
    const apply = () => svg.setAttribute("viewBox", [view.x, view.y, view.width, view.height].join(" "));
    apply();
    const zoom = (factor, clientX = svg.getBoundingClientRect().left + svg.clientWidth / 2, clientY = svg.getBoundingClientRect().top + svg.clientHeight / 2) => {
      const rect = svg.getBoundingClientRect();
      const rx = (clientX - rect.left) / rect.width;
      const ry = (clientY - rect.top) / rect.height;
      const nextWidth = Math.min(width * 20, Math.max(width / 100, view.width * factor));
      const nextHeight = Math.min(height * 20, Math.max(height / 100, view.height * factor));
      view = { x: view.x + rx * (view.width - nextWidth), y: view.y + ry * (view.height - nextHeight), width: nextWidth, height: nextHeight };
      apply();
    };
    root.querySelector('[data-action="zoom-in"]')?.addEventListener("click", () => zoom(0.8));
    root.querySelector('[data-action="zoom-out"]')?.addEventListener("click", () => zoom(1.25));
    root.querySelector('[data-action="reset"]')?.addEventListener("click", () => { view = { x: 0, y: 0, width, height }; apply(); });
    svg.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 0.85 : 1.18, event.clientX, event.clientY); }, { passive: false });
    let drag;
    svg.addEventListener("pointerdown", (event) => { if (!root.hasAttribute("data-measuring")) { drag = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y }; svg.setPointerCapture(event.pointerId); } });
    svg.addEventListener("pointermove", (event) => { if (!drag) return; const rect = svg.getBoundingClientRect(); view.x = drag.viewX - (event.clientX - drag.x) * view.width / rect.width; view.y = drag.viewY - (event.clientY - drag.y) * view.height / rect.height; apply(); });
    svg.addEventListener("pointerup", () => { drag = undefined; });
    for (const input of root.querySelectorAll("[data-layer-filter]")) input.addEventListener("change", () => {
      const layer = input.getAttribute("data-layer-filter");
      for (const item of svg.querySelectorAll("[data-pcb-layer]")) if (item.getAttribute("data-pcb-layer") === layer) item.style.display = input.checked ? "" : "none";
    });
    const selection = root.querySelector("[data-selection]");
    svg.addEventListener("click", (event) => {
      if (root.hasAttribute("data-measuring")) return;
      const item = event.target.closest?.("[data-type]");
      if (!item || !selection) return;
      selection.textContent = JSON.stringify({ type: item.dataset.type, layer: item.dataset.pcbLayer || null, pad: item.dataset.padName || null });
    });
    root.querySelector('[data-action="copy-selection"]')?.addEventListener("click", async () => { if (selection?.textContent) await navigator.clipboard.writeText(selection.textContent); });
    const measureOutput = root.querySelector("[data-measurement]");
    let measurePoints = [];
    root.querySelector('[data-action="measure"]')?.addEventListener("click", () => { root.toggleAttribute("data-measuring"); measurePoints = []; if (measureOutput) measureOutput.textContent = root.hasAttribute("data-measuring") ? "Select two points" : "Measurement off"; });
    svg.addEventListener("click", (event) => {
      if (!root.hasAttribute("data-measuring")) return;
      const matrix = svg.getScreenCTM();
      const board = svg.querySelector(".pcb-board");
      const boardWidthMm = number(root.getAttribute("data-board-width-mm"));
      if (!matrix || !board || !boardWidthMm) { if (measureOutput) measureOutput.textContent = "Exact visual scale unavailable; use /api/inspect"; return; }
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      measurePoints.push(p);
      if (measurePoints.length === 2) {
        const unitsPerMm = board.getBBox().width / boardWidthMm;
        const distance = Math.hypot(measurePoints[1].x - measurePoints[0].x, measurePoints[1].y - measurePoints[0].y) / unitsPerMm;
        if (measureOutput) measureOutput.textContent = distance.toFixed(3) + " mm (visual; verify exact object gaps via /api/inspect)";
        measurePoints = [];
      }
    });
  }
  for (const button of document.querySelectorAll("[data-server-action]")) button.addEventListener("click", async () => {
    const output = document.querySelector("[data-action-result]");
    try {
      const project = await fetch("/api/project").then((response) => response.json());
      if (!project.server.actionsEnabled || !project.server.actionToken) throw new Error("Browser actions are disabled for this binding");
      const action = button.getAttribute("data-server-action");
      const name = action === "simulate" ? document.querySelector("[data-simulation-name]")?.value : undefined;
      const response = await fetch("/api/actions/" + action, { method: "POST", headers: { "Content-Type": "application/json", "X-PCBoo-Action-Token": project.server.actionToken }, body: JSON.stringify(name ? { name } : {}) });
      const body = await response.json();
      if (output) output.textContent = JSON.stringify(body, null, 2);
    } catch (error) { if (output) output.textContent = String(error); }
  });
})();`;

export const INSPECTION_SERVER_INITIAL_LIMITS = Object.freeze([
  "The server watches project source and atomically retains the last good snapshot when rebuilding fails.",
  "Fixed build, check, simulation, and detached KiCad export actions may write derived .pcboo artifacts but never authored source.",
  "Schematic and PCB pages use pinned tscircuit-backed SVG rendering; structured inspection remains authoritative.",
  "Artifact metadata is reported without serving arbitrary project or output files.",
] as const);

export interface InspectionServerWarning {
  readonly code: "SERVER_NETWORK_EXPOSURE";
  readonly message: string;
}

export interface StartInspectionServerOptions {
  /** A PCBoo project root or any descendant directory. */
  readonly projectDirectory: string;
  /** Defaults to the IPv4 loopback address. */
  readonly hostname?: string;
  /** Defaults to 0 so Bun asks the operating system for an available port. */
  readonly port?: number;
  readonly maxQueryBytes?: number;
  readonly watchDebounceMs?: number;
  readonly maxActionBodyBytes?: number;
  readonly actionBodyTimeoutMs?: number;
  /** @internal Explicit local executable paths for embedding and boundary tests. */
  readonly externalToolPaths?: Readonly<{ ngspice?: string | null; kicadCli?: string | null }>;
  /** @internal Deterministic KiCad failure boundary used by server attachment tests. */
  readonly kicadTestHooks?: RunCliOptions["kicadTestHooks"];
  /** @internal Deterministic watcher handoff/stop race test hook. */
  readonly beforeWatcherCommit?: () => Promise<void>;
  /** @internal Deterministic action artifact race test hook. */
  readonly beforeArtifactAttachment?: (run: Readonly<CliRun>) => void | Promise<void>;
  /** @internal Deterministic request-level action publication race test hook. */
  readonly beforeActionPublication?: () => void | Promise<void>;
  /** @internal Deterministic request-time project-authority race test hook. */
  readonly beforeProjectAuthorityRecheck?: () => void | Promise<void>;
}

export interface InspectionServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: URL;
  readonly project: Readonly<DiscoveredProject>;
  readonly warnings: readonly InspectionServerWarning[];
  readonly limits: typeof INSPECTION_SERVER_INITIAL_LIMITS;
  readonly actionToken: string;
  stop(): Promise<void>;
}

interface SnapshotRebuildState {
  readonly state: "ready" | "pending" | "failed";
  readonly revision: number;
  readonly circuitDigest: string;
  readonly projectDigest: string;
  readonly message?: string;
}

interface LastServerAction {
  readonly command: string;
  readonly exitClassification: ExitClassification;
  readonly runId: string;
  readonly projectDigest: string;
  readonly circuitDigest: string;
  readonly reportPath?: string;
}

interface LastSimulationAction extends LastServerAction {
  readonly name: string;
  readonly functionalStatus: StatusSet["functional"];
  readonly diagnostics: readonly Diagnostic[];
  readonly artifacts: readonly ArtifactReference[];
}

interface ServerSnapshot {
  readonly project: Readonly<DiscoveredProject>;
  readonly config: Readonly<PcbooConfig>;
  readonly lock: Readonly<PcbooLock>;
  readonly evaluation: Readonly<ProjectCircuitEvaluation>;
  readonly engineIdentity: Readonly<TscircuitIdentityReport>;
  readonly statuses: Readonly<StatusSet>;
  readonly diagnostics: readonly Diagnostic[];
  readonly artifacts: readonly ArtifactReference[];
  readonly artifactAuthority?: Readonly<ServerArtifactAuthority>;
  readonly sourcingEvidence: RecordedSourcingEvidence;
  readonly rebuild: SnapshotRebuildState;
  readonly lastAction?: LastServerAction;
  readonly lastSimulationAction?: LastSimulationAction;
  readonly warnings: readonly InspectionServerWarning[];
  readonly simulationNames: readonly string[];
  readonly inputPaths: readonly string[];
}

type ActionPublicationOutcome = "published" | "evidence-stale" | "artifacts-stale";

interface SimulationSummary {
  readonly name: string;
  readonly elementCount: number;
  readonly elements: readonly unknown[];
}

function simulationActionView(snapshot: ServerSnapshot, name: string) {
  const action = snapshot.lastSimulationAction?.name === name ? snapshot.lastSimulationAction : undefined;
  const current = action !== undefined && snapshot.rebuild.state === "ready" &&
    action.projectDigest === snapshot.rebuild.projectDigest &&
    action.circuitDigest === snapshot.rebuild.circuitDigest;
  return Object.freeze({
    status: action?.functionalStatus ?? null,
    diagnostics: action?.diagnostics ?? Object.freeze([]),
    artifacts: action?.artifacts ?? Object.freeze([]),
    reportPath: action?.reportPath ?? null,
    lastAction: action ?? null,
    freshness: action === undefined ? "none" as const : current ? "current" as const : "stale" as const,
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return false;
}

function networkWarnings(hostname: string): readonly InspectionServerWarning[] {
  if (isLoopbackHostname(hostname)) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      code: "SERVER_NETWORK_EXPOSURE" as const,
      message:
        `PCBoo is explicitly listening on non-loopback host ${hostname}. ` +
        "Project inspection data may be reachable over the network.",
    }),
  ]);
}

function displayHostname(hostname: string): string {
  return isIP(hostname) === 6 && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value, null, 2), { ...init, headers });
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "script-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "));
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(html, { ...init, headers });
}

function javascriptResponse(script: string): Response {
  return new Response(script, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(
  requestPath: string,
  status: number,
  code: string,
  message: string,
): Response {
  if (requestPath.startsWith("/api/")) {
    return jsonResponse({ error: { code, message } }, { status });
  }
  return htmlResponse(
    page("PCBoo error", `<h1>${status}</h1><p>${escapeHtml(message)}</p>`, []),
    { status },
  );
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function warningMarkup(warnings: readonly InspectionServerWarning[]): string {
  if (warnings.length === 0) return "";
  return warnings.map((warning) =>
    `<aside class="warning"><strong>${escapeHtml(warning.code)}</strong> ${escapeHtml(warning.message)}</aside>`
  ).join("");
}

function page(
  title: string,
  body: string,
  warnings: readonly InspectionServerWarning[],
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 72rem; margin: 0 auto; padding: 1.5rem; line-height: 1.5; }
    nav { display: flex; flex-wrap: wrap; gap: .8rem; margin: 1rem 0 1.5rem; }
    pre { overflow: auto; padding: 1rem; border: 1px solid #7777; border-radius: .4rem; }
    .warning { padding: .8rem; margin: .8rem 0; border: 2px solid #c77b00; border-radius: .4rem; }
    table { border-collapse: collapse; } th, td { border: 1px solid #7777; padding: .4rem .6rem; text-align: left; }
    .viewer-toolbar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .8rem 0; }
    .pcboo-viewer svg { width: 100%; height: min(70vh, 46rem); border: 1px solid #7777; touch-action: none; }
    .viewer-readout { min-height: 1.5rem; font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  ${warningMarkup(warnings)}
  <nav aria-label="PCBoo inspection">
    <a href="/">Project</a><a href="/schematic">Schematic</a><a href="/pcb">PCB</a>
    <a href="/checks">Checks</a><a href="/manufacturing">Manufacturing</a>
  </nav>
  <main>${body}</main>
  <script src="/assets/viewer.js" defer></script>
</body>
</html>`;
}

function pretty(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function safeRenderedSvg(svg: string): string {
  if (
    !svg.startsWith("<svg") ||
    /<(?:script|foreignObject|iframe|object|embed)\b/iu.test(svg) ||
    /\son[a-z]+\s*=/iu.test(svg) ||
    /\b(?:href|src)\s*=\s*["'](?!#|data:image\/)/iu.test(svg)
  ) {
    throw new Error("Renderer produced SVG outside PCBoo's static safety profile");
  }
  return svg;
}

function renderCircuitSvg(
  kind: "pcb" | "schematic",
  circuitJson: readonly unknown[],
  layer?: string,
): string | undefined {
  try {
    const elements = circuitJson as AnyCircuitElement[];
    return safeRenderedSvg(kind === "pcb"
      ? convertCircuitJsonToPcbSvg(elements, {
          width: 1_000,
          height: 700,
          includeVersion: false,
          shouldDrawErrors: true,
          ...(layer === undefined ? {} : { layer: layer as never }),
        })
      : convertCircuitJsonToSchematicSvg(elements, {
          width: 1_000,
          height: 700,
          includeVersion: false,
          showErrorsInTextOverlay: true,
        }));
  } catch {
    return undefined;
  }
}

function boardWidthMm(circuitJson: readonly unknown[]): number | undefined {
  for (const element of circuitJson) {
    const record = asRecord(element);
    if (record?.type === "pcb_board" && typeof record.width === "number" && record.width > 0) return record.width;
  }
  return undefined;
}

function viewerMarkup(options: {
  readonly svg: string | undefined;
  readonly snapshot: SnapshotRebuildState;
  readonly layers?: readonly string[];
  readonly boardWidth?: number | undefined;
}): string {
  if (options.svg === undefined) {
    return `<aside class="warning">Render unavailable for this snapshot. Exact Circuit JSON remains available through <a href="/api/inspect">/api/inspect</a>.</aside>`;
  }
  const filters = options.layers?.map((layer) =>
    `<label><input type="checkbox" checked data-layer-filter="${escapeHtml(layer)}"> ${escapeHtml(layer)}</label>`
  ).join(" ") ?? "";
  return `<section data-pcboo-viewer${options.boardWidth === undefined ? "" : ` data-board-width-mm="${options.boardWidth}"`}>
    <p>Snapshot revision ${options.snapshot.revision}; circuit ${escapeHtml(options.snapshot.circuitDigest)}; state ${options.snapshot.state}.</p>
    <div class="viewer-toolbar"><button data-action="zoom-in">Zoom in</button><button data-action="zoom-out">Zoom out</button><button data-action="reset">Reset</button><button data-action="measure">Measure</button><button data-action="copy-selection">Copy selection</button>${filters}</div>
    <p class="viewer-readout" data-measurement>Measurement off</p><p class="viewer-readout" data-selection>No object selected</p>
    ${options.svg}
  </section>`;
}

function actionControls(simulationNames: readonly string[]): string {
  const defaultSimulation = simulationNames[0] ?? "";
  return `<section><h2>Derived actions</h2><p>Actions write only derived output and attach evidence only when its project and circuit digests match the live snapshot.</p>
    <div class="viewer-toolbar"><button data-server-action="build">Build</button><button data-server-action="check">Check</button><button data-server-action="export-kicad">Export KiCad</button><label>Simulation <input data-simulation-name value="${escapeHtml(defaultSimulation)}"></label><button data-server-action="simulate">Simulate</button></div>
    <pre data-action-result>No action requested</pre></section>`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function elementId(record: Record<string, unknown>): string | undefined {
  const primary = record[`${String(record.type)}_id`];
  if (typeof primary === "string") return primary;
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("_id") && typeof value === "string") return value;
  }
  return undefined;
}

function simulationName(record: Record<string, unknown>, index: number): string {
  for (const key of ["name", "display_name", "simulation_experiment_id"] as const) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return `simulation-${index + 1}`;
}

function simulations(names: readonly string[]): readonly SimulationSummary[] {
  return Object.freeze(names.map((name) => Object.freeze({ name, elementCount: 0, elements: Object.freeze([]) })));
}

function availableLayers(circuitJson: readonly unknown[]): readonly string[] {
  const layers = new Set<string>(["top", "bottom"]);
  for (const element of circuitJson) {
    const record = asRecord(element);
    for (const key of ["layer", "from_layer", "to_layer"] as const) {
      if (typeof record?.[key] === "string") layers.add(record[key]);
    }
    if (Array.isArray(record?.layers)) {
      for (const layer of record.layers) if (typeof layer === "string") layers.add(layer);
    }
  }
  return Object.freeze([...layers].sort());
}

function circuitDigest(evaluation: ProjectCircuitEvaluation): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(evaluation.canonicalJson).digest("hex")}`;
}

function validateRawQuery(url: URL, maxBytes: number): string | undefined {
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return `Query string exceeds the ${maxBytes}-byte limit`;
  }
  try {
    decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return "Query string contains malformed percent encoding";
  }
  if (/[^\x20-\x7e]/u.test(raw)) return "Query string contains control characters";
  return undefined;
}

function assertNoQuery(url: URL): string | undefined {
  return url.searchParams.size === 0 ? undefined : "This route does not accept query parameters";
}

function parseFiniteQueryNumber(
  url: URL,
  key: string,
): number | undefined | Response {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", `${key} must be a finite decimal number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e9) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", `${key} must be finite and bounded`);
  }
  return parsed;
}

function parseRegion(url: URL): BoundsMm | undefined | Response {
  const value = url.searchParams.get("region");
  if (value === null) return undefined;
  const parts = value.split(",");
  if (parts.length !== 4) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "region must be minX,minY,maxX,maxY in millimetres");
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((number) => !Number.isFinite(number) || Math.abs(number) > 1e9)) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "region coordinates must be finite and bounded");
  }
  const [minX, minY, maxX, maxY] = numbers as [number, number, number, number];
  if (minX > maxX || minY > maxY) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "region minimums must not exceed maximums");
  }
  return Object.freeze({ minX, minY, maxX, maxY });
}

function inspectCircuit(
  url: URL,
  circuitJson: readonly unknown[],
  diagnostics: readonly Diagnostic[],
  snapshot: SnapshotRebuildState,
): Response {
  const allowed = new Set([
    "type", "id", "name", "net", "layer", "region", "x", "y", "radius", "from", "to", "limit",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return errorResponse(url.pathname, 400, "QUERY_PARAMETER_UNKNOWN", `Unknown inspect query parameter: ${key}`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      return errorResponse(url.pathname, 400, "QUERY_PARAMETER_REPEATED", `Inspect query parameter may occur once: ${key}`);
    }
  }

  const type = url.searchParams.get("type") ?? undefined;
  const id = url.searchParams.get("id") ?? undefined;
  const name = url.searchParams.get("name") ?? undefined;
  const net = url.searchParams.get("net") ?? undefined;
  const layer = url.searchParams.get("layer") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const limitText = url.searchParams.get("limit") ?? "50";
  if (type !== undefined && !/^[a-z][a-z0-9_]{0,127}$/u.test(type)) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "type must be a Circuit JSON type name");
  }
  for (const [key, value] of [["id", id], ["name", name], ["net", net], ["layer", layer], ["from", from], ["to", to]] as const) {
    if (
      value !== undefined &&
      (value.length === 0 || value.length > MAX_INSPECT_VALUE_LENGTH || /[\u0000-\u001f\u007f]/u.test(value))
    ) {
      return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", `${key} is empty, too long, or contains control characters`);
    }
  }
  if (!/^[1-9]\d{0,2}$/u.test(limitText)) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "limit must be an integer from 1 through 200");
  }
  const limit = Number(limitText);
  if (limit > MAX_INSPECT_RESULTS) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "limit must be an integer from 1 through 200");
  }

  const x = parseFiniteQueryNumber(url, "x");
  if (x instanceof Response) return x;
  const y = parseFiniteQueryNumber(url, "y");
  if (y instanceof Response) return y;
  const radius = parseFiniteQueryNumber(url, "radius");
  if (radius instanceof Response) return radius;
  if ((x === undefined) !== (y === undefined)) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "x and y must be provided together");
  }
  if (radius !== undefined && (x === undefined || radius < 0)) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "radius requires x and y and must be non-negative");
  }
  if ((from === undefined) !== (to === undefined)) {
    return errorResponse(url.pathname, 400, "QUERY_VALUE_INVALID", "from and to must be provided together");
  }
  const region = parseRegion(url);
  if (region instanceof Response) return region;
  const queryPoint: PointMm | undefined = x === undefined || y === undefined
    ? undefined
    : Object.freeze({ x, y });
  const inspected = inspectableElements(circuitJson, diagnostics, queryPoint);
  const connectivity = net === undefined
    ? undefined
    : deriveAuthoritativeConnectivity(circuitJson as readonly AnyCircuitElement[]);
  let resolvedNetIdentity: string | undefined;
  let resolvedSourceNetId: string | undefined;
  if (net !== undefined && connectivity !== undefined) {
    const sourceNets = inspected.filter(({ element }) => element.type === "source_net");
    const exactIdMatches = sourceNets.filter(({ element }) => element.source_net_id === net);
    const matchesByName = exactIdMatches.length > 0
      ? exactIdMatches
      : sourceNets.filter(({ element }) => element.name === net);
    if (matchesByName.length === 0) {
      return errorResponse(
        url.pathname,
        404,
        "INSPECTION_NET_NOT_FOUND",
        "net must identify one existing source_net by exact ID or unique name",
      );
    }
    if (matchesByName.length !== 1) {
      return errorResponse(
        url.pathname,
        409,
        "INSPECTION_NET_AMBIGUOUS",
        "net name matches more than one source_net; query by exact source_net_id",
      );
    }
    const selected = matchesByName[0]!.element;
    resolvedSourceNetId = typeof selected.source_net_id === "string"
      ? selected.source_net_id
      : undefined;
    resolvedNetIdentity = resolvedSourceNetId === undefined
      ? undefined
      : connectivity.netForSourceNetId(resolvedSourceNetId);
    if (resolvedNetIdentity === undefined) {
      return errorResponse(
        url.pathname,
        409,
        "INSPECTION_NET_IDENTITY_UNRESOLVED",
        "selected source_net has no authoritative logical identity",
      );
    }
    const sourceNetIdsForIdentity = sourceNets.flatMap(({ element }) => {
      const sourceNetId = typeof element.source_net_id === "string"
        ? element.source_net_id
        : undefined;
      return sourceNetId !== undefined &&
          connectivity.netForSourceNetId(sourceNetId) === resolvedNetIdentity
        ? [sourceNetId]
        : [];
    });
    if (sourceNetIdsForIdentity.length !== 1) {
      return errorResponse(
        url.pathname,
        409,
        "INSPECTION_NET_IDENTITY_AMBIGUOUS",
        "selected source_net shares one logical identity with another declared source_net",
      );
    }
  }

  const authoritativeElementNetIdentity = (
    item: (typeof inspected)[number],
    authority: Readonly<AuthoritativeConnectivity>,
  ): string | undefined => {
    const element = item.element;
    switch (element.type) {
      case "source_net":
        return typeof element.source_net_id === "string"
          ? authority.netForSourceNetId(element.source_net_id)
          : undefined;
      case "source_trace":
        return typeof element.source_trace_id === "string"
          ? authority.netForSourceTraceId(element.source_trace_id)
          : undefined;
      case "source_port":
        return typeof element.source_port_id === "string"
          ? authority.netForSourcePortId(element.source_port_id)
          : undefined;
      case "pcb_port":
        return typeof element.pcb_port_id === "string"
          ? authority.netForPcbPortId(element.pcb_port_id)
          : undefined;
      case "pcb_trace":
        return typeof element.pcb_trace_id === "string"
          ? authority.netForPcbTraceId(element.pcb_trace_id)
          : undefined;
      case "pcb_smtpad":
      case "pcb_plated_hole":
        return typeof element.pcb_port_id === "string" &&
          item.physicalObjectIds.includes(element.pcb_port_id)
          ? authority.netForPcbPortId(element.pcb_port_id)
          : undefined;
      case "pcb_via":
        return typeof element.pcb_trace_id === "string" &&
          item.physicalObjectIds.includes(element.pcb_trace_id)
          ? authority.netForPcbTraceId(element.pcb_trace_id)
          : undefined;
      default:
        return undefined;
    }
  };

  const matches = inspected.filter((item) => {
    const element = item.element;
    if (type !== undefined && item.type !== type) return false;
    if (id !== undefined && item.id !== id) return false;
    if (name !== undefined && element.name !== name && element.display_name !== name) return false;
    if (layer !== undefined && !item.layers.includes(layer)) return false;
    if (region !== undefined && (item.bounds === undefined || !intersects(item.bounds, region))) return false;
    if (radius !== undefined && (item.distanceFromPointMm === undefined || item.distanceFromPointMm > radius)) return false;
    if (
      connectivity !== undefined && resolvedNetIdentity !== undefined &&
      authoritativeElementNetIdentity(item, connectivity) !== resolvedNetIdentity
    ) return false;
    return true;
  });
  const ordered = queryPoint === undefined
    ? matches
    : [...matches].sort((a, b) =>
      (a.distanceFromPointMm ?? Number.POSITIVE_INFINITY) -
      (b.distanceFromPointMm ?? Number.POSITIVE_INFINITY) ||
      (a.id ?? a.type).localeCompare(b.id ?? b.type)
    );
  let measurement: unknown;
  let logicalPath: readonly string[] | undefined;
  let physicalPath: readonly string[] | undefined;
  let unconnectedEndpoints: readonly string[] = Object.freeze([]);
  let structuralPath: readonly string[] | undefined;
  if (from !== undefined && to !== undefined) {
    const fromElement = inspected.find(({ id }) => id === from);
    const toElement = inspected.find(({ id }) => id === to);
    if (fromElement === undefined || toElement === undefined) {
      return errorResponse(url.pathname, 404, "INSPECTION_OBJECT_NOT_FOUND", "from and to must name existing Circuit JSON object IDs");
    }
    measurement = fromElement.bounds === undefined || toElement.bounds === undefined
      ? { kind: "bounding-box-gap", unit: "mm", available: false }
      : {
          kind: "bounding-box-gap",
          unit: "mm",
          available: true,
          value: boundsGap(fromElement.bounds, toElement.bounds),
          from,
          to,
        };
    logicalPath = logicalConnectivityPath(inspected, from, to);
    physicalPath = physicalConnectivityPath(inspected, from, to);
    unconnectedEndpoints = unconnectedManufacturedEndpointIds(inspected, from, to);
    structuralPath = relationPath(inspected, from, to);
  }
  return jsonResponse({
    schemaVersion: 1,
    snapshot,
    units: { coordinates: "mm", distances: "mm" },
    query: {
      ...(type ? { type } : {}), ...(id ? { id } : {}), ...(name ? { name } : {}),
      ...(net ? { net, resolvedSourceNetId } : {}), ...(layer ? { layer } : {}), ...(region ? { region } : {}),
      ...(queryPoint ? { point: queryPoint } : {}), ...(radius === undefined ? {} : { radius }),
      ...(from ? { from, to } : {}), limit,
    },
    total: ordered.length,
    truncated: ordered.length > limit,
    elements: ordered.slice(0, limit).map(({ element }) => element),
    inspection: ordered.slice(0, limit).map(({ element: _element, ...item }) => item),
    ...(measurement === undefined
      ? {}
      : {
          measurement,
          logicalConnectivityPath: logicalPath ?? null,
          physicalConnectivityPath: physicalPath ?? null,
          unconnectedManufacturedEndpointIds: unconnectedEndpoints,
          relationPath: structuralPath ?? null,
        }),
  });
}

function fixedRouteResponse(
  url: URL,
  snapshot: ServerSnapshot,
  runtime: Readonly<{ actionToken: string; actionRunning: boolean; actionsEnabled: boolean }>,
): Response {
  const circuitJson = snapshot.evaluation.circuitJson;
  const simulationList = simulations(snapshot.simulationNames);
  const layers = availableLayers(circuitJson);
  const noQueryError = url.pathname === "/api/inspect" ? undefined : assertNoQuery(url);
  const hasEvidence = snapshot.lastAction !== undefined || snapshot.artifacts.length > 0;
  const evidenceCurrent = hasEvidence && snapshot.rebuild.state === "ready" &&
    snapshot.lastAction?.projectDigest === snapshot.rebuild.projectDigest &&
    snapshot.lastAction.circuitDigest === snapshot.rebuild.circuitDigest;
  const evidence = Object.freeze({
    state: !hasEvidence ? "none" as const : evidenceCurrent ? "current" as const : "stale" as const,
    boundProjectDigest: snapshot.lastAction?.projectDigest ?? null,
    boundCircuitDigest: snapshot.lastAction?.circuitDigest ?? null,
    currentProjectDigest: snapshot.rebuild.projectDigest,
    currentCircuitDigest: snapshot.rebuild.circuitDigest,
  });
  if (noQueryError !== undefined) {
    return errorResponse(url.pathname, 400, "QUERY_NOT_ALLOWED", noQueryError);
  }

  if (url.pathname === "/api/project") {
    return jsonResponse({
      schemaVersion: 1,
      project: {
        name: basename(snapshot.project.root),
        root: ".",
        config: snapshot.config,
        tscircuit: {
          version: snapshot.engineIdentity.project!.version,
          integrity: snapshot.lock.tscircuit.integrity,
          contentSha256: snapshot.engineIdentity.project!.contentSha256,
          runtimeClosureSha256: snapshot.engineIdentity.project!.runtimeClosureSha256,
        },
      },
      snapshot: snapshot.rebuild,
      server: {
        warnings: snapshot.warnings,
        limits: INSPECTION_SERVER_INITIAL_LIMITS,
        actionsEnabled: runtime.actionsEnabled,
        ...(runtime.actionsEnabled ? { actionToken: runtime.actionToken } : {}),
        actionRunning: runtime.actionRunning,
      },
    });
  }
  if (url.pathname === "/api/circuit") {
    return jsonResponse({ schemaVersion: 1, snapshot: snapshot.rebuild, elements: circuitJson });
  }
  if (url.pathname === "/api/inspect") {
    return inspectCircuit(url, circuitJson, snapshot.diagnostics, snapshot.rebuild);
  }
  if (url.pathname === "/api/checks") {
    return jsonResponse({
      schemaVersion: 1,
      snapshot: snapshot.rebuild,
      evidence,
      statuses: snapshot.statuses,
      diagnostics: snapshot.diagnostics,
      sourcingEvidence: snapshot.sourcingEvidence,
      lastAction: snapshot.lastAction ?? null,
    });
  }
  if (url.pathname === "/api/simulations") {
    return jsonResponse({
      schemaVersion: 1,
      snapshot: snapshot.rebuild,
      simulations: simulationList.map(({ elements: _elements, ...summary }) => ({
        ...summary,
        ...simulationActionView(snapshot, summary.name),
      })),
    });
  }
  if (url.pathname === "/api/artifacts") {
    return jsonResponse({
      schemaVersion: 1,
      snapshot: snapshot.rebuild,
      evidence,
      outputDirectory: snapshot.config.outputDirectory,
      artifacts: snapshot.artifacts,
      servingFiles: false,
    });
  }
  if (url.pathname === "/api/actions") {
    return jsonResponse({ schemaVersion: 1, snapshot: snapshot.rebuild, evidence, running: runtime.actionRunning, lastAction: snapshot.lastAction ?? null });
  }
  if (url.pathname === "/assets/viewer.js") return javascriptResponse(VIEWER_SCRIPT);
  if (url.pathname === "/") {
    return htmlResponse(page(
      `PCBoo — ${basename(snapshot.project.root)}`,
      `<h1>${escapeHtml(basename(snapshot.project.root))}</h1>
       <p>Live PCBoo project inspection. Fixed actions write derived artifacts only.</p>
       ${pretty({ config: snapshot.config, snapshot: snapshot.rebuild, statuses: snapshot.statuses, elementCount: circuitJson.length })}
       ${actionControls(simulationList.map(({ name }) => name))}`,
      snapshot.warnings,
    ));
  }
  if (url.pathname === "/schematic") {
    const schematic = circuitJson.filter((element) => asRecord(element)?.type?.toString().startsWith("schematic_"));
    return htmlResponse(page(
      "PCBoo schematic",
      `<h1>Schematic</h1>${viewerMarkup({ svg: renderCircuitSvg("schematic", circuitJson), snapshot: snapshot.rebuild })}<details><summary>Structured schematic elements</summary>${pretty(schematic)}</details>`,
      snapshot.warnings,
    ));
  }
  if (url.pathname === "/pcb") {
    const pcb = circuitJson.filter((element) => asRecord(element)?.type?.toString().startsWith("pcb_"));
    return htmlResponse(page(
      "PCBoo PCB",
      `<h1>PCB</h1><p>Layers: ${layers.map((layer) => `<a href="/pcb/layers/${encodeURIComponent(layer)}">${escapeHtml(layer)}</a>`).join(", ")}</p>${viewerMarkup({ svg: renderCircuitSvg("pcb", circuitJson), snapshot: snapshot.rebuild, layers, boardWidth: boardWidthMm(circuitJson) })}<details><summary>Structured PCB elements</summary>${pretty(pcb)}</details>`,
      snapshot.warnings,
    ));
  }
  if (url.pathname === "/checks") {
    return htmlResponse(page("PCBoo checks", `<h1>Checks</h1>${pretty({ statuses: snapshot.statuses, diagnostics: snapshot.diagnostics })}`, snapshot.warnings));
  }
  if (url.pathname === "/manufacturing") {
    return htmlResponse(page(
      "PCBoo manufacturing",
      `<h1>Manufacturing</h1>${pretty({ fabrication: snapshot.statuses.fabrication, outputDirectory: snapshot.config.outputDirectory, artifacts: snapshot.artifacts })}`,
      snapshot.warnings,
    ));
  }

  const layerMatch = /^\/pcb\/layers\/([^/]+)$/u.exec(url.pathname);
  if (layerMatch !== null) {
    const layer = decodePathSegment(layerMatch[1]!);
    if (layer instanceof Response) return layer;
    if (!layers.includes(layer)) {
      return errorResponse(url.pathname, 404, "LAYER_NOT_FOUND", `Unknown PCB layer: ${layer}`);
    }
    const elements = circuitJson.filter((element) => {
      const record = asRecord(element);
      return record?.layer === layer || record?.from_layer === layer || record?.to_layer === layer ||
        (Array.isArray(record?.layers) && record.layers.includes(layer));
    });
    return htmlResponse(page(
      `PCBoo layer ${layer}`,
      `<h1>PCB layer: ${escapeHtml(layer)}</h1>${viewerMarkup({ svg: renderCircuitSvg("pcb", circuitJson, layer), snapshot: snapshot.rebuild, layers: [layer], boardWidth: boardWidthMm(circuitJson) })}<details><summary>Structured layer elements</summary>${pretty(elements)}</details>`,
      snapshot.warnings,
    ));
  }

  const simulationMatch = /^\/simulations\/([^/]+)$/u.exec(url.pathname);
  if (simulationMatch !== null) {
    const name = decodePathSegment(simulationMatch[1]!);
    if (name instanceof Response) return name;
    const simulation = simulationList.find((item) => item.name === name);
    if (simulation === undefined) {
      return errorResponse(url.pathname, 404, "SIMULATION_NOT_FOUND", `Unknown simulation: ${name}`);
    }
    return htmlResponse(page(`PCBoo simulation ${name}`, `<h1>Simulation: ${escapeHtml(name)}</h1>${pretty({ ...simulation, ...simulationActionView(snapshot, name) })}`, snapshot.warnings));
  }

  return errorResponse(url.pathname, 404, "ROUTE_NOT_FOUND", "Unknown PCBoo inspection route");
}

function decodePathSegment(raw: string): string | Response {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return errorResponse(raw, 400, "PATH_ENCODING_INVALID", "Path contains malformed percent encoding");
  }
  if (
    value.length === 0 || value.length > 128 || value === "." || value === ".." ||
    value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return errorResponse(raw, 400, "PATH_SEGMENT_INVALID", "Path segment is invalid");
  }
  return value;
}

function withCors(request: Request, response: Response, expectedOrigin: string): Response {
  const origin = request.headers.get("Origin");
  if (origin === null) return response;
  if (origin !== expectedOrigin) {
    return errorResponse(new URL(request.url).pathname, 403, "CROSS_ORIGIN_DENIED", "Cross-origin requests are not allowed");
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function asHeadResponse(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function loadSnapshot(
  projectDirectory: string,
  warnings: readonly InspectionServerWarning[],
  revision = 1,
  signal?: AbortSignal,
): Promise<ServerSnapshot> {
  const project = await discoverProject(projectDirectory);
  const [config, lock] = await Promise.all([
    loadProjectConfig(project.root, signal === undefined ? {} : { signal }),
    loadPcbooLock(project.root),
  ]);
  const beforeInputs = await digestProjectInputs({ projectRoot: project.root, entry: config.entry, outputDirectory: config.outputDirectory, profiles: config.profiles, ...(config.boardRevision === undefined ? {} : { boardRevision: config.boardRevision }), ...(signal === undefined ? {} : { signal }) });
  const [evaluation, engineIdentity] = await Promise.all([
    evaluateProjectCircuitTwice(project.root, {
      expectedConfig: config,
      ...(signal === undefined ? {} : { signal }),
    }),
    requireTscircuitIdentity({
      projectRoot: project.root,
      expectedVersion: lock.tscircuit.version,
    }),
  ]);
  const afterInputs = await digestProjectInputs({ projectRoot: project.root, entry: config.entry, outputDirectory: config.outputDirectory, profiles: config.profiles, ...(config.boardRevision === undefined ? {} : { boardRevision: config.boardRevision }), ...(signal === undefined ? {} : { signal }) });
  if (beforeInputs.projectDigest !== afterInputs.projectDigest) {
    throw new Error("Project inputs changed while the live snapshot was being evaluated");
  }
  const sourcing = assessRecordedSourcing({
    circuitJson: evaluation.circuitJson,
    lock,
  });
  return Object.freeze({
    project,
    config,
    lock,
    evaluation,
    engineIdentity,
    statuses: statusSet({ ...unassessedStatusSet(), sourcing: sourcing.status }),
    diagnostics: sourcing.diagnostics,
    artifacts: Object.freeze([]),
    sourcingEvidence: sourcing.evidence,
    rebuild: Object.freeze({
      state: "ready" as const,
      revision,
      circuitDigest: circuitDigest(evaluation),
      projectDigest: afterInputs.projectDigest,
    }),
    warnings,
    simulationNames: afterInputs.simulationNames,
    inputPaths: afterInputs.inputPaths,
  });
}

function failedRebuildSnapshot(snapshot: ServerSnapshot): ServerSnapshot {
  return Object.freeze({
    ...snapshot,
    statuses: unassessedStatusSet(),
    diagnostics: Object.freeze([]),
    rebuild: Object.freeze({
      state: "failed" as const,
      revision: snapshot.rebuild.revision,
      circuitDigest: snapshot.rebuild.circuitDigest,
      projectDigest: snapshot.rebuild.projectDigest,
      message: "Project rebuild failed; the last good snapshot was retained",
    }),
  });
}

function pendingRebuildSnapshot(snapshot: ServerSnapshot): ServerSnapshot {
  return Object.freeze({
    ...snapshot,
    statuses: unassessedStatusSet(),
    diagnostics: Object.freeze([]),
    rebuild: Object.freeze({
      state: "pending" as const,
      revision: snapshot.rebuild.revision,
      circuitDigest: snapshot.rebuild.circuitDigest,
      projectDigest: snapshot.rebuild.projectDigest,
      message: "Project inputs changed; retained evidence is stale until rebuilding finishes",
    }),
  });
}

function activeRebuildSnapshot(snapshot: ServerSnapshot): ServerSnapshot {
  return Object.freeze({
    ...snapshot,
    statuses: unassessedStatusSet(),
    diagnostics: Object.freeze([]),
    rebuild: Object.freeze({
      state: "pending" as const,
      revision: snapshot.rebuild.revision,
      circuitDigest: snapshot.rebuild.circuitDigest,
      projectDigest: snapshot.rebuild.projectDigest,
      message: "Project rebuild is evaluating a snapped input generation",
    }),
  });
}

function projectRelativePath(projectRoot: string, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const result = relative(projectRoot, path).replaceAll("\\", "/");
  return result.startsWith("../") ? undefined : result;
}

async function readActionPayload(
  request: Request,
  limit: number,
  allowedFields: readonly string[],
  options: Readonly<{ shutdownSignal: AbortSignal; timeoutMs: number }>,
): Promise<Record<string, unknown> | Response> {
  const requestPath = new URL(request.url).pathname;
  const contentType = request.headers.get("Content-Type");
  if (contentType !== null && !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    return errorResponse(requestPath, 415, "ACTION_CONTENT_TYPE_INVALID", "Action bodies must use application/json");
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    return errorResponse(new URL(request.url).pathname, 413, "ACTION_BODY_TOO_LARGE", `Action body exceeds ${limit} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    const deadline = performance.now() + options.timeoutMs;
    try {
      while (true) {
        const remaining = Math.max(0, deadline - performance.now());
        const { done, value } = await new Promise<{ done: boolean; value?: Uint8Array }>(
          (resolve, reject) => {
            let settled = false;
            const finish = (callback: () => void) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              options.shutdownSignal.removeEventListener("abort", onShutdown);
              request.signal.removeEventListener("abort", onClientAbort);
              callback();
            };
            const onShutdown = () => finish(() => reject(new Error("SERVER_STOPPING")));
            const onClientAbort = () => finish(() => reject(new Error("ACTION_BODY_ABORTED")));
            const timer = setTimeout(
              () => finish(() => reject(new Error("ACTION_BODY_TIMEOUT"))),
              remaining,
            );
            options.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
            request.signal.addEventListener("abort", onClientAbort, { once: true });
            if (options.shutdownSignal.aborted) return onShutdown();
            if (request.signal.aborted) return onClientAbort();
            reader.read().then(
              (result) => finish(() => resolve(
                result.done ? { done: true } : { done: false, value: result.value },
              )),
              () => finish(() => reject(new Error("ACTION_BODY_ABORTED"))),
            );
          },
        ).catch(async (error) => {
          await reader.cancel("PCBoo action body read ended").catch(() => undefined);
          throw error;
        });
        if (done) break;
        if (value === undefined) {
          return errorResponse(requestPath, 400, "ACTION_BODY_ABORTED", "Action body ended before completion");
        }
        byteLength += value.byteLength;
        if (byteLength > limit) {
          await reader.cancel("PCBoo action body limit exceeded");
          return errorResponse(requestPath, 413, "ACTION_BODY_TOO_LARGE", `Action body exceeds ${limit} bytes`);
        }
        chunks.push(value);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "ACTION_BODY_ABORTED";
      if (code === "SERVER_STOPPING") {
        return errorResponse(requestPath, 503, code, "PCBoo server is stopping");
      }
      if (code === "ACTION_BODY_TIMEOUT") {
        return errorResponse(requestPath, 408, code, `Action body was not completed within ${options.timeoutMs} ms`);
      }
      return errorResponse(requestPath, 400, "ACTION_BODY_ABORTED", "Action body ended before completion");
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown = {};
  if (byteLength > 0) {
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return errorResponse(new URL(request.url).pathname, 400, "ACTION_BODY_INVALID", "Action body must be valid UTF-8 JSON");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(new URL(request.url).pathname, 400, "ACTION_BODY_INVALID", "Action body must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowedFields.includes(key));
  if (unknown.length > 0) {
    return errorResponse(new URL(request.url).pathname, 400, "ACTION_FIELD_UNKNOWN", `Unknown action field: ${unknown[0]}`);
  }
  return record;
}

/** Starts the fixed PCBoo inspection and derived-action server. */
export async function startInspectionServer(
  options: StartInspectionServerOptions,
): Promise<Readonly<InspectionServer>> {
  requireSupportedBunRuntime();
  if (!options.projectDirectory.trim()) throw new TypeError("projectDirectory is required");
  const hostname = options.hostname?.trim() || DEFAULT_HOSTNAME;
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer from 0 through 65535");
  }
  const maxQueryBytes = options.maxQueryBytes ?? DEFAULT_MAX_QUERY_BYTES;
  if (!Number.isSafeInteger(maxQueryBytes) || maxQueryBytes < 128 || maxQueryBytes > 65_536) {
    throw new TypeError("maxQueryBytes must be an integer from 128 through 65536");
  }
  const watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  if (!Number.isSafeInteger(watchDebounceMs) || watchDebounceMs < 10 || watchDebounceMs > 5_000) {
    throw new TypeError("watchDebounceMs must be an integer from 10 through 5000");
  }
  const maxActionBodyBytes = options.maxActionBodyBytes ?? DEFAULT_ACTION_BODY_BYTES;
  if (!Number.isSafeInteger(maxActionBodyBytes) || maxActionBodyBytes < 128 || maxActionBodyBytes > 65_536) {
    throw new TypeError("maxActionBodyBytes must be an integer from 128 through 65536");
  }
  const actionBodyTimeoutMs = options.actionBodyTimeoutMs ?? DEFAULT_ACTION_BODY_TIMEOUT_MS;
  if (!Number.isSafeInteger(actionBodyTimeoutMs) || actionBodyTimeoutMs < 50 || actionBodyTimeoutMs > 60_000) {
    throw new TypeError("actionBodyTimeoutMs must be an integer from 50 through 60000");
  }

  const warnings = networkWarnings(hostname);
  let snapshot = await loadSnapshot(options.projectDirectory, warnings);
  const actionToken = crypto.randomUUID();
  let actionRunning = false;
  let activeAction: Promise<Response> | undefined;
  let activeActionController: AbortController | undefined;
  let watchers: FSWatcher[] = [];
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let rebuildChain = Promise.resolve();
  let stopped = false;
  const shutdownController = new AbortController();
  let inputGeneration = 0;
  const actionsEnabled = isLoopbackHostname(hostname);
  const simulationArtifactAuthorities = new WeakMap<object, Readonly<ServerArtifactAuthority>>();
  const reportAuthorities = new WeakMap<object, Readonly<ServerGeneratedFileAuthority>>();
  let canonicalOrigin = "";
  let canonicalHost = "";
  let installWatchers = async (
    _target: ServerSnapshot,
    _expectedGeneration?: number,
  ): Promise<boolean> => false;
  let activeRebuildController: AbortController | undefined;

  const rebuild = async (generation: number) => {
    if (stopped || generation !== inputGeneration) return;
    const controller = new AbortController();
    activeRebuildController = controller;
    snapshot = activeRebuildSnapshot(snapshot);
    const projectRoot = snapshot.project.root;
    const revision = snapshot.rebuild.revision + 1;
    try {
      const candidate = await loadSnapshot(
        projectRoot,
        warnings,
        revision,
        controller.signal,
      );
      if (stopped || generation !== inputGeneration) return;
      if (!await installWatchers(candidate, generation)) return;
      if (stopped || generation !== inputGeneration) return;
      const coveredInputs = await digestProjectInputs({ projectRoot: candidate.project.root, entry: candidate.config.entry, outputDirectory: candidate.config.outputDirectory, profiles: candidate.config.profiles, ...(candidate.config.boardRevision === undefined ? {} : { boardRevision: candidate.config.boardRevision }) });
      if (stopped || generation !== inputGeneration) return;
      if (coveredInputs.projectDigest !== candidate.rebuild.projectDigest) {
        scheduleRebuild(null);
        return;
      }
      snapshot = Object.freeze({
        ...candidate,
        ...(snapshot.lastAction === undefined ? {} : { lastAction: snapshot.lastAction }),
        ...(snapshot.lastSimulationAction === undefined ? {} : { lastSimulationAction: snapshot.lastSimulationAction }),
        artifacts: snapshot.artifacts,
        ...(snapshot.artifactAuthority === undefined ? {} : { artifactAuthority: snapshot.artifactAuthority }),
      });
    } catch {
      if (!stopped && generation === inputGeneration) {
        snapshot = failedRebuildSnapshot(snapshot);
      }
    } finally {
      if (activeRebuildController === controller) activeRebuildController = undefined;
    }
  };
  const scheduleRebuild = (
    filename: string | Buffer | null,
    additionalIgnoredOutput?: string,
  ) => {
    if (stopped) return;
    if (filename !== null) {
      const normalized = filename.toString().replaceAll("\\", "/").replace(/^\.\//, "");
      const ignored = [
        snapshot.config.outputDirectory,
        ...(additionalIgnoredOutput === undefined ? [] : [additionalIgnoredOutput]),
        "node_modules",
        ".git",
      ]
        .map((value) => value.replaceAll("\\", "/").replace(/\/$/, ""));
      if (ignored.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return;
    }
    inputGeneration += 1;
    activeRebuildController?.abort();
    snapshot = pendingRebuildSnapshot(snapshot);
    if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      const generation = inputGeneration;
      rebuildChain = rebuildChain.then(
        () => rebuild(generation),
        () => rebuild(generation),
      );
    }, watchDebounceMs);
  };
  installWatchers = async (target, expectedGeneration) => {
    const superseded = () => stopped ||
      (expectedGeneration !== undefined && expectedGeneration !== inputGeneration);
    if (superseded()) return false;
    if (superseded()) return false;
    await options.beforeWatcherCommit?.();
    if (superseded()) return false;
    const outputPrefix = target.config.outputDirectory.replaceAll("\\", "/").replace(/\/$/, "");
    if (target.inputPaths.some((path) =>
      path === outputPrefix || path.startsWith(`${outputPrefix}/`)
    )) {
      throw new Error("Configured outputDirectory overlaps watched project inputs");
    }
    const directories = new Set<string>();
    for (const path of target.inputPaths) {
      let directory = dirname(join(target.project.root, ...path.replaceAll("\\", "/").split("/")));
      while (directory !== target.project.root) {
        try {
          if ((await lstat(directory)).isDirectory()) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        directory = dirname(directory);
      }
      directories.add(directory);
    }
    directories.add(target.project.root);
    for (const name of ["simulations", "models"]) {
      const directory = join(target.project.root, name);
      try {
        if ((await lstat(directory)).isDirectory()) directories.add(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const replacements: FSWatcher[] = [];
    try {
      for (const directory of [...directories].sort()) {
        const watcher = watch(directory, (_event, filename) => {
          const candidate = filename === null
            ? relative(target.project.root, directory)
            : relative(target.project.root, join(directory, filename.toString()));
          scheduleRebuild(candidate, target.config.outputDirectory);
        });
        watcher.on("error", () => {
          if (!stopped && watchers.includes(watcher)) {
            inputGeneration += 1;
            activeRebuildController?.abort();
            snapshot = failedRebuildSnapshot(snapshot);
          }
        });
        replacements.push(watcher);
      }
    } catch (error) {
      for (const watcher of replacements) watcher.close();
      throw error;
    }
    const previous = watchers;
    watchers = replacements;
    for (const watcher of previous) watcher.close();
    return true;
  };

  const executeAction = async (
    kind: "build" | "check" | "simulate" | "export-kicad",
    payload: Record<string, unknown>,
    signal: AbortSignal,
    deferPublication: (publish: () => Promise<ActionPublicationOutcome>) => void,
  ): Promise<Response> => {
    const actionSnapshot = snapshot;
    const cancelledResponse = (): Response => {
      return errorResponse(
        `/api/actions/${kind}`,
        stopped ? 503 : 409,
        stopped ? "SERVER_STOPPING" : "ACTION_CANCELLED",
        stopped
          ? "PCBoo server stopped before the action could publish evidence"
          : "PCBoo action was cancelled before evidence publication",
      );
    };
    if (actionSnapshot.rebuild.state !== "ready") {
      return errorResponse(`/api/actions/${kind}`, 409, "ACTION_SNAPSHOT_NOT_READY", "Wait for the project snapshot to rebuild before running an action");
    }
    const words: string[] = kind === "export-kicad" ? ["export", "kicad"] : [kind];
    if (kind === "simulate") {
      const name = payload.name;
      if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))) {
        return errorResponse(`/api/actions/${kind}`, 400, "SIMULATION_NAME_INVALID", "name must be a bounded simulation identifier");
      }
      if (typeof name === "string") words.push(name);
    }
    if (signal.aborted) return cancelledResponse();
    const run: CliRun = await runCli({
      argv: words,
      cwd: snapshot.project.root,
      signal,
      ...(options.externalToolPaths === undefined ? {} : { externalToolPaths: options.externalToolPaths }),
      ...(options.kicadTestHooks === undefined ? {} : { kicadTestHooks: options.kicadTestHooks }),
    });
    if (signal.aborted) return cancelledResponse();
    if (run.result === undefined) {
      return errorResponse(`/api/actions/${kind}`, 500, "ACTION_RESULT_MISSING", "PCBoo action returned no structured result");
    }
    if (
      run.result.project === undefined ||
      run.result.project.projectDigest !== actionSnapshot.rebuild.projectDigest ||
      snapshot.rebuild.state !== "ready" ||
      snapshot.rebuild.projectDigest !== actionSnapshot.rebuild.projectDigest ||
      snapshot.rebuild.circuitDigest !== actionSnapshot.rebuild.circuitDigest
    ) {
      return errorResponse(
        `/api/actions/${kind}`,
        409,
        "ACTION_EVIDENCE_STALE",
        "Project inputs changed while the action ran; its evidence was not attached to the live snapshot",
      );
    }
    await options.beforeArtifactAttachment?.(run);
    if (signal.aborted) return cancelledResponse();
    let actionArtifactAuthority: Readonly<ServerArtifactAuthority> | undefined;
    let simulationArtifactAuthority: Readonly<ServerArtifactAuthority> | undefined;
    let reportAuthority: Readonly<ServerGeneratedFileAuthority> | undefined;
    const simulationArtifacts = kind === "simulate"
      ? Object.freeze(run.result.artifacts.filter(({ kind }) => kind.startsWith("simulation-") || kind === "command-error"))
      : Object.freeze([]);
    if (run.result.artifacts.length > 0) {
      if (run.runDirectory === undefined) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_ARTIFACTS_STALE",
          "PCBoo action artifacts did not include their originating run authority",
        );
      }
      try {
        actionArtifactAuthority = await captureServerArtifactAuthority({
          projectRoot: actionSnapshot.project.root,
          runDirectory: run.runDirectory,
          artifacts: run.result.artifacts,
        });
        const currentInputs = await digestProjectInputs({
          projectRoot: actionSnapshot.project.root,
          entry: actionSnapshot.config.entry,
          outputDirectory: actionSnapshot.config.outputDirectory,
          profiles: actionSnapshot.config.profiles,
          ...(actionSnapshot.config.boardRevision === undefined
            ? {}
            : { boardRevision: actionSnapshot.config.boardRevision }),
        });
        if (currentInputs.projectDigest !== actionSnapshot.rebuild.projectDigest) {
          throw new ServerArtifactFreshnessError("Project inputs changed while action artifacts were captured");
        }
        await verifyServerArtifactAuthority(actionArtifactAuthority, run.result.artifacts);
        if (simulationArtifacts.length > 0) {
          simulationArtifactAuthority = await captureServerArtifactAuthority({
            projectRoot: actionSnapshot.project.root,
            runDirectory: run.runDirectory,
            artifacts: simulationArtifacts,
          });
          await verifyServerArtifactAuthority(simulationArtifactAuthority, simulationArtifacts);
        }
      } catch (error) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_ARTIFACTS_STALE",
          error instanceof ServerArtifactFreshnessError
            ? error.message
            : "PCBoo action artifact authority could not be established",
        );
      }
    }
    if (run.reportPath !== undefined) {
      if (run.runDirectory === undefined) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_ARTIFACTS_STALE",
          "PCBoo action report did not include its originating run authority",
        );
      }
      try {
        reportAuthority = await captureServerGeneratedFileAuthority({
          projectRoot: actionSnapshot.project.root,
          runDirectory: run.runDirectory,
          absolutePath: run.reportPath,
          kind: "command-report",
          expectedBytes: `${JSON.stringify(run.result, null, 2)}\n`,
        });
        await verifyServerArtifactAuthority(reportAuthority.authority, [reportAuthority.reference]);
      } catch (error) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_ARTIFACTS_STALE",
          error instanceof ServerArtifactFreshnessError
            ? error.message
            : "PCBoo action report authority could not be established",
        );
      }
    }
    const finalInputs = await digestProjectInputs({
      projectRoot: actionSnapshot.project.root,
      entry: actionSnapshot.config.entry,
      outputDirectory: actionSnapshot.config.outputDirectory,
      profiles: actionSnapshot.config.profiles,
      ...(actionSnapshot.config.boardRevision === undefined
        ? {}
        : { boardRevision: actionSnapshot.config.boardRevision }),
    });
    if (
      finalInputs.projectDigest !== actionSnapshot.rebuild.projectDigest ||
      snapshot.rebuild.state !== "ready" ||
      snapshot.rebuild.projectDigest !== actionSnapshot.rebuild.projectDigest ||
      snapshot.rebuild.circuitDigest !== actionSnapshot.rebuild.circuitDigest
    ) {
      return errorResponse(
        `/api/actions/${kind}`,
        409,
        "ACTION_EVIDENCE_STALE",
        "Project inputs changed while action artifacts were verified; evidence was not attached",
      );
    }
    if (actionArtifactAuthority !== undefined) {
      try {
        await verifyServerArtifactAuthority(actionArtifactAuthority, run.result.artifacts);
      } catch (error) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_ARTIFACTS_STALE",
          error instanceof ServerArtifactFreshnessError
            ? error.message
            : "PCBoo action artifacts changed before publication",
        );
      }
      if (
        snapshot.rebuild.state !== "ready" ||
        snapshot.rebuild.projectDigest !== actionSnapshot.rebuild.projectDigest ||
        snapshot.rebuild.circuitDigest !== actionSnapshot.rebuild.circuitDigest
      ) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_EVIDENCE_STALE",
          "The live snapshot changed before artifact publication",
        );
      }
    }
    if (simulationArtifactAuthority !== undefined) {
      try {
        await verifyServerArtifactAuthority(simulationArtifactAuthority, simulationArtifacts);
      } catch (error) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_ARTIFACTS_STALE",
          error instanceof ServerArtifactFreshnessError
            ? error.message
            : "Simulation artifacts changed before publication",
        );
      }
    }
    if (reportAuthority !== undefined) {
      try {
        await verifyServerArtifactAuthority(reportAuthority.authority, [reportAuthority.reference]);
      } catch (error) {
        return errorResponse(
          `/api/actions/${kind}`,
          409,
          "ACTION_ARTIFACTS_STALE",
          error instanceof ServerArtifactFreshnessError
            ? error.message
            : "PCBoo action report changed before publication",
        );
      }
    }
    if (signal.aborted) return cancelledResponse();
    const lastAction = Object.freeze({
      command: run.result.command,
      exitClassification: run.result.exitClassification,
      runId: run.result.runId,
      projectDigest: run.result.project.projectDigest,
      circuitDigest: actionSnapshot.rebuild.circuitDigest,
      ...(projectRelativePath(snapshot.project.root, run.reportPath) === undefined
        ? {}
        : { reportPath: projectRelativePath(snapshot.project.root, run.reportPath)! }),
    });
    const base = {
      ...snapshot,
      artifacts: run.result.artifacts.length > 0 ? run.result.artifacts : snapshot.artifacts,
      ...(run.result.artifacts.length > 0
        ? { artifactAuthority: actionArtifactAuthority! }
        : snapshot.artifactAuthority === undefined ? {} : { artifactAuthority: snapshot.artifactAuthority }),
      lastAction,
    };
    let nextSnapshot: ServerSnapshot;
    let lastSimulationAction: LastSimulationAction | undefined;
    if (kind === "check") {
      if (run.result.sourcingEvidence === undefined) {
        return errorResponse(
          "/api/actions/check",
          500,
          "SOURCING_EVIDENCE_MISSING",
          "PCBoo check returned sourcing status without its same-instant typed evidence",
        );
      }
      nextSnapshot = Object.freeze({
        ...base,
        statuses: run.result.statuses,
        diagnostics: run.result.diagnostics,
        sourcingEvidence: run.result.sourcingEvidence,
      });
    } else if (kind === "simulate") {
      const simulationName = payload.name as string;
      lastSimulationAction = Object.freeze({
        ...lastAction,
        name: simulationName,
        functionalStatus: run.result.statuses.functional,
        diagnostics: Object.freeze(run.result.diagnostics.filter(({ dimension }) => dimension === "functional")),
        artifacts: simulationArtifacts,
      });
      nextSnapshot = Object.freeze({
        ...base,
        lastSimulationAction,
        statuses: statusSet({ ...snapshot.statuses, functional: run.result.statuses.functional }),
        diagnostics: Object.freeze([
          ...snapshot.diagnostics.filter(({ dimension }) => dimension !== "functional"),
          ...run.result.diagnostics,
        ]),
      });
    } else {
      nextSnapshot = Object.freeze(base);
    }
    deferPublication(async () => {
      if (
        signal.aborted || snapshot.rebuild.state !== "ready" ||
        snapshot.rebuild.projectDigest !== actionSnapshot.rebuild.projectDigest ||
        snapshot.rebuild.circuitDigest !== actionSnapshot.rebuild.circuitDigest
      ) return "evidence-stale";
      let publicationInputs: Awaited<ReturnType<typeof digestProjectInputs>>;
      try {
        publicationInputs = await digestProjectInputs({
          projectRoot: actionSnapshot.project.root,
          entry: actionSnapshot.config.entry,
          outputDirectory: actionSnapshot.config.outputDirectory,
          profiles: actionSnapshot.config.profiles,
          ...(actionSnapshot.config.boardRevision === undefined
            ? {}
            : { boardRevision: actionSnapshot.config.boardRevision }),
        });
      } catch {
        return "evidence-stale";
      }
      if (publicationInputs.projectDigest !== actionSnapshot.rebuild.projectDigest) {
        return "evidence-stale";
      }
      try {
        await Promise.all([
          ...(actionArtifactAuthority === undefined
            ? []
            : [verifyServerArtifactAuthority(actionArtifactAuthority, run.result!.artifacts)]),
          ...(simulationArtifactAuthority === undefined
            ? []
            : [verifyServerArtifactAuthority(simulationArtifactAuthority, simulationArtifacts)]),
          ...(reportAuthority === undefined
            ? []
            : [verifyServerArtifactAuthority(reportAuthority.authority, [reportAuthority.reference])]),
        ]);
      } catch {
        return "artifacts-stale";
      }
      if (
        signal.aborted || snapshot.rebuild.state !== "ready" ||
        snapshot.rebuild.projectDigest !== actionSnapshot.rebuild.projectDigest ||
        snapshot.rebuild.circuitDigest !== actionSnapshot.rebuild.circuitDigest
      ) return "evidence-stale";
      if (reportAuthority !== undefined) reportAuthorities.set(lastAction, reportAuthority);
      if (lastSimulationAction !== undefined) {
        if (simulationArtifactAuthority !== undefined) {
          simulationArtifactAuthorities.set(lastSimulationAction, simulationArtifactAuthority);
        }
        if (reportAuthority !== undefined) reportAuthorities.set(lastSimulationAction, reportAuthority);
      }
      snapshot = nextSnapshot;
      return "published";
    });
    return jsonResponse({
      schemaVersion: 1,
      result: run.result,
      reportPath: lastAction.reportPath ?? null,
    });
  };

  const verifyStoredRouteArtifacts = async (pathname: string): Promise<string | undefined> => {
    const exposesCurrentArtifacts = pathname === "/api/artifacts" || pathname === "/manufacturing" ||
      pathname === "/api/checks" || pathname === "/checks" || pathname === "/api/actions";
    const exposesCurrentReport = pathname === "/api/checks" || pathname === "/checks" ||
      pathname === "/api/actions";
    const exposesSimulationAction = pathname === "/api/simulations" || /^\/simulations\/[^/]+$/u.test(pathname);
    const currentActionIsFresh = snapshot.rebuild.state === "ready" && snapshot.lastAction !== undefined &&
      snapshot.lastAction.projectDigest === snapshot.rebuild.projectDigest &&
      snapshot.lastAction.circuitDigest === snapshot.rebuild.circuitDigest;
    if (
      exposesCurrentArtifacts && (snapshot.lastAction !== undefined || snapshot.artifacts.length > 0) &&
      !currentActionIsFresh
    ) return "Stored action evidence belongs to an older project or circuit epoch";
    if (exposesCurrentArtifacts && snapshot.artifacts.length > 0) {
      if (snapshot.artifactAuthority === undefined) {
        return "Stored artifact references have no authenticated run authority";
      }
      try {
        await verifyServerArtifactAuthority(snapshot.artifactAuthority, snapshot.artifacts);
      } catch (error) {
        return error instanceof ServerArtifactFreshnessError
          ? error.message
          : "Stored artifact authority could not be revalidated";
      }
    }
    if (exposesCurrentReport && snapshot.lastAction?.reportPath !== undefined) {
      const report = reportAuthorities.get(snapshot.lastAction);
      if (report === undefined) return "Stored action report has no authenticated run authority";
      try {
        await verifyServerArtifactAuthority(report.authority, [report.reference]);
      } catch (error) {
        return error instanceof ServerArtifactFreshnessError
          ? error.message
          : "Stored action report authority could not be revalidated";
      }
    }
    const simulationAction = snapshot.lastSimulationAction;
    const simulationActionIsFresh = snapshot.rebuild.state === "ready" && simulationAction !== undefined &&
      simulationAction.projectDigest === snapshot.rebuild.projectDigest &&
      simulationAction.circuitDigest === snapshot.rebuild.circuitDigest;
    if (exposesSimulationAction && simulationAction !== undefined && !simulationActionIsFresh) {
      return "Retained simulation evidence belongs to an older project or circuit epoch";
    }
    if (exposesSimulationAction && (simulationAction?.artifacts.length ?? 0) > 0) {
      const action = snapshot.lastSimulationAction!;
      const authority = simulationArtifactAuthorities.get(action);
      if (authority === undefined) {
        return "Retained simulation artifacts have no matching authenticated run authority";
      }
      try {
        await verifyServerArtifactAuthority(authority, action.artifacts);
      } catch (error) {
        return error instanceof ServerArtifactFreshnessError
          ? error.message
          : "Retained simulation artifact authority could not be revalidated";
      }
    }
    if (exposesSimulationAction && simulationAction?.reportPath !== undefined) {
      const report = reportAuthorities.get(simulationAction);
      if (report === undefined) return "Retained simulation report has no authenticated run authority";
      try {
        await verifyServerArtifactAuthority(report.authority, [report.reference]);
      } catch (error) {
        return error instanceof ServerArtifactFreshnessError
          ? error.message
          : "Retained simulation report authority could not be revalidated";
      }
    }
    return undefined;
  };

  const refreshCurrentProjectAuthority = async (pathname: string): Promise<void> => {
    if (pathname === "/assets/viewer.js" || snapshot.rebuild.state !== "ready") return;
    const observed = snapshot;
    try {
      const firstConfig = await loadProjectConfig(observed.project.root);
      const first = await digestProjectInputs({
        projectRoot: observed.project.root,
        entry: firstConfig.entry,
        outputDirectory: firstConfig.outputDirectory,
        profiles: firstConfig.profiles,
        ...(firstConfig.boardRevision === undefined
          ? {}
          : { boardRevision: firstConfig.boardRevision }),
      });
      await options.beforeProjectAuthorityRecheck?.();
      const currentConfig = await loadProjectConfig(observed.project.root);
      const current = await digestProjectInputs({
        projectRoot: observed.project.root,
        entry: currentConfig.entry,
        outputDirectory: currentConfig.outputDirectory,
        profiles: currentConfig.profiles,
        ...(currentConfig.boardRevision === undefined
          ? {}
          : { boardRevision: currentConfig.boardRevision }),
      });
      if (snapshot !== observed || observed.rebuild.state !== "ready") return;
      if (
        isDeepStrictEqual(firstConfig, currentConfig) &&
        isDeepStrictEqual(currentConfig, observed.config) &&
        first.projectDigest === current.projectDigest &&
        current.projectDigest === observed.rebuild.projectDigest
      ) return;
    } catch {
      if (snapshot !== observed || observed.rebuild.state !== "ready") return;
    }
    scheduleRebuild(null, observed.config.outputDirectory);
  };

  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (canonicalHost.length === 0 || request.headers.get("Host") !== canonicalHost) {
        return errorResponse(url.pathname, 421, "HOST_NOT_ALLOWED", "Request Host does not match the bound PCBoo server authority");
      }
      const requestOrigin = request.headers.get("Origin");
      if (requestOrigin !== null && requestOrigin !== canonicalOrigin) {
        return errorResponse(url.pathname, 403, "CROSS_ORIGIN_DENIED", "Cross-origin requests are not allowed");
      }
      const queryError = validateRawQuery(url, maxQueryBytes);
      if (queryError !== undefined) {
        return withCors(request, errorResponse(url.pathname, 400, "QUERY_INVALID", queryError), canonicalOrigin);
      }
      if (request.method === "OPTIONS") {
        if (requestOrigin === null) {
          return withCors(request, errorResponse(url.pathname, 403, "CROSS_ORIGIN_DENIED", "Cross-origin requests are not allowed"), canonicalOrigin);
        }
        return withCors(request, new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-PCBoo-Action-Token",
            "Access-Control-Max-Age": "600",
          },
        }), canonicalOrigin);
      }
      const actionMatch = /^\/api\/actions\/(build|check|simulate|export-kicad)$/u.exec(url.pathname);
      if (request.method === "POST" && actionMatch !== null) {
        if (!actionsEnabled) {
          return withCors(request, errorResponse(url.pathname, 403, "ACTIONS_NETWORK_DISABLED", "Browser actions are disabled on non-loopback bindings"), canonicalOrigin);
        }
        if (request.headers.get("Origin") !== canonicalOrigin || request.headers.get("X-PCBoo-Action-Token") !== actionToken) {
          return withCors(request, errorResponse(url.pathname, 403, "ACTION_AUTHORIZATION_REQUIRED", "Actions require same-origin authorization"), canonicalOrigin);
        }
        if (actionRunning) {
          return withCors(request, errorResponse(url.pathname, 409, "ACTION_ALREADY_RUNNING", "Another PCBoo action is already running"), canonicalOrigin);
        }
        const kind = actionMatch[1] as "build" | "check" | "simulate" | "export-kicad";
        const payload = await readActionPayload(
          request,
          maxActionBodyBytes,
          kind === "simulate" ? ["name"] : [],
          { shutdownSignal: shutdownController.signal, timeoutMs: actionBodyTimeoutMs },
        );
        if (payload instanceof Response) return withCors(request, payload, canonicalOrigin);
        if (actionRunning) {
          return withCors(request, errorResponse(url.pathname, 409, "ACTION_ALREADY_RUNNING", "Another PCBoo action is already running"), canonicalOrigin);
        }
        actionRunning = true;
        const actionController = new AbortController();
        const onClientAbort = () => actionController.abort("client-disconnected");
        const onShutdown = () => actionController.abort("server-stopping");
        request.signal.addEventListener("abort", onClientAbort, { once: true });
        shutdownController.signal.addEventListener("abort", onShutdown, { once: true });
        if (request.signal.aborted) onClientAbort();
        if (shutdownController.signal.aborted) onShutdown();
        activeActionController = actionController;
        let publishAction: (() => Promise<ActionPublicationOutcome>) | undefined;
        activeAction = executeAction(
          kind,
          payload,
          actionController.signal,
          (publish) => {
            publishAction = publish;
          },
        ).then(
          async (response) => {
            if (publishAction !== undefined) await options.beforeActionPublication?.();
            if (actionController.signal.aborted) {
              return errorResponse(
                url.pathname,
                stopped ? 503 : 409,
                stopped ? "SERVER_STOPPING" : "ACTION_CANCELLED",
                "PCBoo action ended before evidence publication",
              );
            }
            const publicationOutcome = publishAction === undefined
              ? "published"
              : await publishAction();
            if (publicationOutcome === "artifacts-stale") {
              return errorResponse(
                url.pathname,
                409,
                "ACTION_ARTIFACTS_STALE",
                "Action artifact or report evidence changed before publication",
              );
            }
            if (publicationOutcome === "evidence-stale") {
              return errorResponse(
                url.pathname,
                409,
                "ACTION_EVIDENCE_STALE",
                "The live snapshot changed before action evidence publication",
              );
            }
            return response;
          },
        ).catch(() =>
          actionController.signal.aborted
            ? errorResponse(
              url.pathname,
              stopped ? 503 : 409,
              stopped ? "SERVER_STOPPING" : "ACTION_CANCELLED",
              "PCBoo action ended before evidence publication",
            )
            : errorResponse(url.pathname, 500, "ACTION_EXECUTION_FAILED", "PCBoo action failed before producing a structured result")
        );
        try {
          return withCors(request, await activeAction, canonicalOrigin);
        } finally {
          request.signal.removeEventListener("abort", onClientAbort);
          shutdownController.signal.removeEventListener("abort", onShutdown);
          actionRunning = false;
          if (activeActionController === actionController) activeActionController = undefined;
          activeAction = undefined;
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return withCors(request, errorResponse(url.pathname, 405, "METHOD_NOT_ALLOWED", "Only fixed PCBoo inspection and action routes are allowed"), canonicalOrigin);
      }
      await refreshCurrentProjectAuthority(url.pathname);
      const staleArtifactMessage = await verifyStoredRouteArtifacts(url.pathname);
      if (staleArtifactMessage !== undefined) {
        const response = withCors(
          request,
          errorResponse(
            url.pathname,
            409,
            "ARTIFACT_EVIDENCE_STALE",
            "Stored artifact evidence changed; artifact and action references were omitted",
          ),
          canonicalOrigin,
        );
        return request.method === "HEAD" ? asHeadResponse(response) : response;
      }
      try {
        const response = withCors(
          request,
          fixedRouteResponse(url, snapshot, { actionToken, actionRunning, actionsEnabled }),
          canonicalOrigin,
        );
        return request.method === "HEAD" ? asHeadResponse(response) : response;
      } catch {
        const response = withCors(
          request,
          errorResponse(url.pathname, 500, "SERVER_INTERNAL_ERROR", "PCBoo could not render this fixed inspection route"),
          canonicalOrigin,
        );
        return request.method === "HEAD" ? asHeadResponse(response) : response;
      }
    },
  });

  const actualPort = server.port;
  if (actualPort === undefined) {
    await server.stop(true);
    throw new Error("Bun did not report the inspection server's bound port");
  }
  const url = new URL(`http://${displayHostname(hostname)}:${actualPort}/`);
  canonicalOrigin = url.origin;
  canonicalHost = url.host;
  try {
    if (!await installWatchers(snapshot)) {
      throw new Error("Inspection server stopped before watcher installation completed");
    }
    snapshot = await loadSnapshot(snapshot.project.root, warnings, snapshot.rebuild.revision);
  } catch (error) {
    stopped = true;
    if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
    for (const watcher of watchers) watcher.close();
    watchers = [];
    await server.stop(true);
    throw error;
  }
  return Object.freeze({
    hostname,
    port: actualPort,
    url,
    project: snapshot.project,
    warnings,
    limits: INSPECTION_SERVER_INITIAL_LIMITS,
    actionToken,
    async stop() {
      if (stopped) return;
      stopped = true;
      shutdownController.abort();
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
      activeRebuildController?.abort();
      activeActionController?.abort();
      for (const watcher of watchers) watcher.close();
      watchers = [];
      await rebuildChain;
      for (const watcher of watchers) watcher.close();
      watchers = [];
      if (activeAction !== undefined) await activeAction.catch(() => undefined);
      await server.stop();
    },
  });
}
