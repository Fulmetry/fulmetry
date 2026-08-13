// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { readBoundedRegularFile } from "../internal/bounded-file";
import type { SimulationDefinition } from "./definition";
import { requireSupportedBunRuntime } from "../runtime";

export const MAX_SIMULATION_MODEL_BYTES = 16 * 1024 * 1024;
export const MAX_SIMULATION_MODEL_LINE_BYTES = 64 * 1024;
export const MAX_SIMULATION_MODEL_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface VerifiedSimulationModel {
  readonly id: string;
  readonly path: string;
  readonly digest: string;
  readonly license: string;
  readonly redistribution: "allowed" | "prohibited" | "unknown";
  readonly size: number;
}

const SPDX_OR_LOCAL_LICENSE = /^(?:MIT|ISC|BSD-[23]-Clause|Apache-2\.0|GPL-[23]\.0-(?:only|or-later)|LGPL-[23](?:\.1)?-(?:only|or-later)|MPL-2\.0|CC0-1\.0|CERN-OHL-[PSW]-2\.0|TAPR-OHL-1\.0|Unlicense|LicenseRef-[A-Za-z0-9.-]+)$/;
const FORBIDDEN_MODEL_DIRECTIVE = /^\s*\.(?:include|inc|lib|control|endc|pre_osdi|load)\b/i;
const FORBIDDEN_SIMULATION_DIRECTIVE = /^\s*\.(?:end|alter|save|print|plot|write|wrdata|meas|option|op|dc|ac|tran|fourier|noise|pz|sens|tf|disto)\b/i;
const FORBIDDEN_CONTROL_COMMAND = /^\s*(?:shell|exec|source|cd)\b/i;

/** Rejects model constructs that can read files, load code, or launch commands. */
export function validateStaticSimulationModel(bytes: Uint8Array, id: string): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Model ${id} must be valid UTF-8 text`);
  }
  if (text.includes("\0")) throw new Error(`Model ${id} contains a NUL byte`);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (new TextEncoder().encode(line).byteLength > MAX_SIMULATION_MODEL_LINE_BYTES) {
      throw new Error(`Model ${id} line ${index + 1} exceeds ${MAX_SIMULATION_MODEL_LINE_BYTES} bytes`);
    }
    const active = line.trimStart();
    if (active.startsWith("*")) continue;
    if (FORBIDDEN_MODEL_DIRECTIVE.test(active) || FORBIDDEN_SIMULATION_DIRECTIVE.test(active) || FORBIDDEN_CONTROL_COMMAND.test(active)) {
      throw new Error(`Model ${id} line ${index + 1} contains a forbidden external-file, code-loading, or control directive`);
    }
  }
}

export async function verifySimulationModelAssets(options: {
  readonly projectRoot: string;
  readonly definition: SimulationDefinition;
  /** @internal Deterministic mutation hook after cheap aggregate preflight. */
  readonly afterPreflight?: () => void | Promise<void>;
}): Promise<readonly VerifiedSimulationModel[]> {
  requireSupportedBunRuntime();
  const root = await realpath(options.projectRoot);
  const verified: VerifiedSimulationModel[] = [];
  const candidates: Array<{
    readonly model: SimulationDefinition["models"][number];
    readonly resolved: string;
  }> = [];
  let artifactBytes = 0;
  for (const model of options.definition.models) {
    if (!SPDX_OR_LOCAL_LICENSE.test(model.license)) {
      throw new Error(`Model ${model.id} has unknown license identifier ${model.license}`);
    }
    const requested = join(root, ...model.path.replaceAll("\\", "/").split("/"));
    const requestedStat = await lstat(requested);
    if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) {
      throw new Error(`Model ${model.id} must be a regular non-symlinked project file`);
    }
    if (requestedStat.size > MAX_SIMULATION_MODEL_BYTES) {
      throw new Error(`Model ${model.id} exceeds ${MAX_SIMULATION_MODEL_BYTES} bytes`);
    }
    const resolved = await realpath(requested);
    const within = relative(root, resolved);
    if (within.startsWith("..") || isAbsolute(within)) throw new Error(`Model ${model.id} escapes the project`);
    artifactBytes += requestedStat.size;
    if (!Number.isSafeInteger(artifactBytes) || artifactBytes > MAX_SIMULATION_MODEL_ARTIFACT_BYTES) {
      throw new Error(`Simulation model artifacts exceed ${MAX_SIMULATION_MODEL_ARTIFACT_BYTES} aggregate bytes`);
    }
    candidates.push({ model, resolved });
  }
  await options.afterPreflight?.();
  const verifiedIdentities = new Map<string, Readonly<{ digest: string; size: number }>>();
  let capturedArtifactBytes = 0;
  for (const { model, resolved } of candidates) {
    const identity = `${resolved}\0${model.digest}`;
    let captured = verifiedIdentities.get(identity);
    if (captured === undefined) {
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedRegularFile(resolved, MAX_SIMULATION_MODEL_BYTES);
      } catch (error) {
        throw new Error(`Model ${model.id} capture failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
      if (digest !== model.digest) throw new Error(`Model ${model.id} content does not match its declared digest`);
      validateStaticSimulationModel(bytes, model.id);
      captured = Object.freeze({ digest, size: bytes.byteLength });
      verifiedIdentities.set(identity, captured);
    }
    capturedArtifactBytes += captured.size;
    if (!Number.isSafeInteger(capturedArtifactBytes) || capturedArtifactBytes > MAX_SIMULATION_MODEL_ARTIFACT_BYTES) {
      throw new Error(`Simulation model artifacts exceed ${MAX_SIMULATION_MODEL_ARTIFACT_BYTES} aggregate bytes`);
    }
    verified.push(Object.freeze({ id: model.id, path: model.path, digest: captured.digest, license: model.license, redistribution: model.redistribution, size: captured.size }));
  }
  return Object.freeze(verified);
}
