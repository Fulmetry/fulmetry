// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import type {
  ActionKind,
  ArtifactsResponse,
  ChecksResponse,
  CircuitResponse,
  ProjectResponse,
  SimulationsResponse,
  WorkspaceData,
} from "../types";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    throw new Error(body?.error?.message ?? `${path} returned ${response.status}`);
  }
  return await response.json() as T;
}

export async function loadWorkspace(): Promise<WorkspaceData> {
  const [project, circuit] = await Promise.all([
    getJson<ProjectResponse>("/api/project"),
    getJson<CircuitResponse>("/api/circuit"),
  ]);
  const results = await Promise.allSettled([
    getJson<ChecksResponse>("/api/checks"),
    getJson<SimulationsResponse>("/api/simulations"),
    getJson<ArtifactsResponse>("/api/artifacts"),
  ]);
  const warning = (name: string, result: PromiseSettledResult<unknown>): string[] => result.status === "rejected"
    ? [`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : [];
  const [checksResult, simulationsResult, artifactsResult] = results;
  const checks = checksResult!.status === "fulfilled" ? checksResult!.value : {
    schemaVersion: 1,
    snapshot: project.snapshot,
    evidence: { state: "none" as const, boundProjectDigest: null, boundCircuitDigest: null, currentProjectDigest: project.snapshot.projectDigest, currentCircuitDigest: project.snapshot.circuitDigest },
    statuses: {},
    diagnostics: [],
    sourcingEvidence: {},
    lastAction: null,
    evidenceActions: [],
  };
  const simulations = simulationsResult!.status === "fulfilled" ? simulationsResult!.value : { schemaVersion: 1, snapshot: project.snapshot, simulations: [] };
  const artifacts = artifactsResult!.status === "fulfilled" ? artifactsResult!.value : { schemaVersion: 1, snapshot: project.snapshot, evidence: { state: "none" as const }, outputDirectory: project.project.config.outputDirectory, artifacts: [], servingFiles: false as const };
  return {
    project,
    circuit,
    checks,
    simulations,
    artifacts,
    loadWarnings: [
      ...warning("Checks unavailable", checksResult!),
      ...warning("Simulations unavailable", simulationsResult!),
      ...warning("Artifacts unavailable", artifactsResult!),
    ],
  };
}

export async function loadProject(): Promise<ProjectResponse> {
  return await getJson<ProjectResponse>("/api/project");
}

export async function runAction(
  project: ProjectResponse,
  kind: ActionKind,
  simulationName?: string,
): Promise<Record<string, unknown>> {
  if (!project.server.actionsEnabled || !project.server.actionToken) {
    throw new Error("Browser actions are unavailable for this server binding.");
  }
  const response = await fetch(`/api/actions/${kind}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-PCBoo-Action-Token": project.server.actionToken,
    },
    body: JSON.stringify(kind === "simulate" && simulationName ? { name: simulationName } : {}),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `Action returned ${response.status}`);
  return body;
}
