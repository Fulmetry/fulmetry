// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT

export interface SnapshotState {
  state: "ready" | "pending" | "failed";
  revision: number;
  circuitDigest: string;
  projectDigest: string;
  message?: string;
}

export interface EngineeringStatus {
  state: string;
  reasons?: readonly string[];
  [key: string]: unknown;
}

export interface ProjectResponse {
  schemaVersion: number;
  project: {
    name: string;
    root: string;
    config: {
      entry: string;
      outputDirectory: string;
      profiles: readonly string[];
      boardRevision?: string;
      [key: string]: unknown;
    };
    tscircuit: {
      version: string;
      integrity: string;
      contentSha256: string;
      runtimeClosureSha256: string;
    };
  };
  snapshot: SnapshotState;
  server: {
    warnings: readonly { code: string; message: string }[];
    limits: readonly string[];
    actionsEnabled: boolean;
    actionToken?: string;
    actionRunning: boolean;
    syncingEvidence: boolean;
    activityRevision: number;
    activityUpdatedAt: string;
  };
}

export interface CircuitElement extends Record<string, unknown> {
  type: string;
}

export interface CircuitResponse {
  schemaVersion: number;
  snapshot: SnapshotState;
  elements: CircuitElement[];
}

export interface DiagnosticRecord extends Record<string, unknown> {
  id?: string;
  code?: string;
  severity?: string;
  message?: string;
}

export interface ChecksResponse {
  schemaVersion: number;
  snapshot: SnapshotState;
  evidence: {
    state: "none" | "current" | "stale";
    boundProjectDigest: string | null;
    boundCircuitDigest: string | null;
    currentProjectDigest: string;
    currentCircuitDigest: string;
  };
  statuses: Record<string, EngineeringStatus>;
  diagnostics: DiagnosticRecord[];
  sourcingEvidence: Record<string, unknown>;
  lastAction: Record<string, unknown> | null;
  evidenceActions: Array<Record<string, unknown> & { requestedDimensions: readonly string[] }>;
}

export interface SimulationRecord extends Record<string, unknown> {
  name: string;
  elementCount: number;
  status: EngineeringStatus | null;
  freshness: "none" | "current" | "stale";
  diagnostics: DiagnosticRecord[];
  artifacts: ArtifactRecord[];
}

export interface SimulationsResponse {
  schemaVersion: number;
  snapshot: SnapshotState;
  simulations: SimulationRecord[];
}

export interface ArtifactRecord extends Record<string, unknown> {
  kind: string;
  path: string;
}

export interface ArtifactsResponse {
  schemaVersion: number;
  snapshot: SnapshotState;
  evidence: { state: "none" | "current" | "stale" };
  outputDirectory: string;
  artifacts: ArtifactRecord[];
  servingFiles: false;
}

export interface WorkspaceData {
  project: ProjectResponse;
  circuit: CircuitResponse;
  checks: ChecksResponse;
  simulations: SimulationsResponse;
  artifacts: ArtifactsResponse;
  loadWarnings: readonly string[];
}

export type ActionKind = "build" | "check" | "simulate" | "export-kicad";
