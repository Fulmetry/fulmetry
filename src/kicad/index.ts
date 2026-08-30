// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import type { AnyCircuitElement } from "circuit-json";
import {
  CircuitJsonToKicadPcbConverter,
  CircuitJsonToKicadProConverter,
  CircuitJsonToKicadSchConverter,
} from "circuit-json-to-kicad";
import { parseKicadPcb, parseKicadSch } from "kicadts";
import { canonicalCircuitJson } from "../circuit-json";
import {
  assertAuthenticKicadHandoff,
  assertAuthenticKicadLiveValidation,
  markAuthenticKicadHandoff,
} from "./authority";
import { requireKicadAdapterIdentity, type KicadAdapterPackageIdentity } from "./identity";
import { requireSupportedBunRuntime } from "../runtime";
import {
  failedKicadSemanticReconciliation,
  reconcileKicadHandoffSemantics,
  type KicadSemanticReconciliation,
} from "./semantic";

const PRISTINE_CRYPTO_HASHER = Bun.CryptoHasher;
const PRISTINE_HASHER_UPDATE = Function.prototype.call.bind(
  PRISTINE_CRYPTO_HASHER.prototype.update,
) as (hasher: InstanceType<typeof PRISTINE_CRYPTO_HASHER>, value: string) => InstanceType<typeof PRISTINE_CRYPTO_HASHER>;
const PRISTINE_HASHER_DIGEST = Function.prototype.call.bind(
  PRISTINE_CRYPTO_HASHER.prototype.digest,
) as (hasher: InstanceType<typeof PRISTINE_CRYPTO_HASHER>, encoding: "hex") => string;
const PRISTINE_TEXT_ENCODER = new TextEncoder();
const PRISTINE_TEXT_ENCODE = Function.prototype.call.bind(
  TextEncoder.prototype.encode,
) as (encoder: TextEncoder, value: string) => Uint8Array;

export const KICAD_HANDOFF_SCHEMA_VERSION = 1 as const;

export type KicadMappingDisposition = "exact" | "approximated" | "omitted" | "unsupported";

export interface KicadMappingEntry {
  readonly circuitJsonType: string;
  readonly count: number;
  readonly disposition: KicadMappingDisposition;
  readonly reason: string;
}

export interface KicadHandoffFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export type KicadLiveValidationState = "unavailable" | "unsupported" | "unqualified" | "qualified" | "failed";

export interface KicadLiveValidationEvidence {
  readonly schemaVersion: 1;
  readonly adapter: { readonly name: "fulmetry-kicad-cli"; readonly version: string };
  readonly source: {
    readonly circuitDigest: string;
    readonly semanticReconciliationSha256: string;
    readonly authoredSourceDigest?: string;
  };
  readonly input: {
    readonly artifactSetSha256: string;
    readonly artifacts: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
  };
  readonly tool?: {
    readonly name: "kicad-cli";
    readonly version: string;
    readonly major: number;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly executableSha256: string;
    readonly distribution?: {
      readonly kind: "official-macos-app";
      readonly bundlePath: "/Applications/KiCad/KiCad.app";
      readonly teamIdentifier: "9FQDHNY6U2";
      readonly architectures: readonly string[];
      readonly codeSignatureSha256: string;
    };
    readonly versionProbe: {
      readonly arguments: readonly ["version"];
      readonly stdoutSha256: string;
      readonly stderrSha256: string;
      readonly stdoutByteLength: number;
      readonly stderrByteLength: number;
    };
  };
  readonly execution: {
    readonly state:
      | "not-run-tool-unavailable"
      | "not-run-unsupported-version"
      | "not-run-unqualified-identity"
      | "qualified"
      | "failed";
    readonly commands: readonly {
      readonly name: "schematic-erc" | "pcb-drc" | "schematic-netlist" | "pcb-gerbers";
      readonly arguments: readonly string[];
      readonly exitCode: number;
      readonly stdoutSha256: string;
      readonly stderrSha256: string;
      readonly stdoutByteLength: number;
      readonly stderrByteLength: number;
    }[];
    readonly outputs: readonly {
      readonly path: string;
      readonly size: number;
      readonly sha256: string;
    }[];
  };
}

export interface KicadLiveValidation {
  readonly state: KicadLiveValidationState;
  readonly supportedMajors: readonly number[];
  readonly detectionCandidateMajors?: readonly number[];
  readonly message: string;
  readonly evidence?: KicadLiveValidationEvidence;
}

export interface KicadHandoffReport {
  readonly schemaVersion: typeof KICAD_HANDOFF_SCHEMA_VERSION;
  readonly lifecycle: "detached-downstream-handoff";
  readonly projectName: string;
  readonly circuitDigest: string;
  readonly deterministic: true;
  readonly adapter: {
    readonly converter: KicadAdapterPackageIdentity;
    readonly parser: KicadAdapterPackageIdentity;
  };
  readonly offlineParse: {
    readonly schematic: "passed";
    readonly pcb: "passed";
    readonly projectJson: "passed";
  };
  readonly semanticReconciliation: KicadSemanticReconciliation;
  readonly liveKiCadValidation: KicadLiveValidation;
  readonly mapping: readonly KicadMappingEntry[];
  readonly files: readonly Omit<KicadHandoffFile, "content">[];
  readonly limitations: readonly string[];
}

export interface KicadHandoff {
  readonly files: readonly KicadHandoffFile[];
  readonly report: KicadHandoffReport;
}

function pristineDigest(value: string): string {
  const hasher = new PRISTINE_CRYPTO_HASHER("sha256");
  PRISTINE_HASHER_UPDATE(hasher, value);
  return PRISTINE_HASHER_DIGEST(hasher, "hex");
}

function liveInputMatchesHandoff(
  files: readonly KicadHandoffFile[],
  input: KicadLiveValidationEvidence["input"],
): boolean {
  if (input.artifacts.length !== files.length) return false;
  let setIdentity = "";
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const artifact = input.artifacts[index]!;
    const sha256 = pristineDigest(file.content);
    const size = PRISTINE_TEXT_ENCODE(PRISTINE_TEXT_ENCODER, file.content).byteLength;
    if (
      file.sha256 !== sha256 ||
      artifact.path !== file.path ||
      artifact.size !== size ||
      artifact.sha256 !== sha256
    ) return false;
    setIdentity += `${file.path}\0${size}\0${sha256}\n`;
  }
  return input.artifactSetSha256 === pristineDigest(setIdentity);
}

/** Returns a new detached handoff envelope; generated file bytes remain unchanged. */
export function withKicadLiveValidation(
  handoff: Readonly<KicadHandoff>,
  liveKiCadValidation: Readonly<KicadLiveValidation>,
): Readonly<KicadHandoff> {
  assertAuthenticKicadHandoff(handoff);
  assertAuthenticKicadLiveValidation(liveKiCadValidation);
  if (liveKiCadValidation.evidence !== undefined && liveKiCadValidation.evidence.source.circuitDigest !== handoff.report.circuitDigest) {
    throw new TypeError("KiCad live evidence circuit digest does not match the handoff");
  }
  if (liveKiCadValidation.evidence !== undefined &&
    liveKiCadValidation.evidence.source.semanticReconciliationSha256 !== handoff.report.semanticReconciliation.sha256) {
    throw new TypeError("KiCad live evidence semantic reconciliation does not match the handoff");
  }
  if (liveKiCadValidation.evidence !== undefined) {
    if (!liveInputMatchesHandoff(handoff.files, liveKiCadValidation.evidence.input)) {
      throw new TypeError("KiCad live evidence artifact set does not match the handoff");
    }
  }
  const report = Object.freeze({ ...handoff.report, liveKiCadValidation });
  return markAuthenticKicadHandoff(Object.freeze({ files: handoff.files, report }));
}

const SEMANTICALLY_RECONCILED_TYPES = new Set([
  "pcb_board", "pcb_component", "pcb_hole", "pcb_plated_hole", "pcb_smtpad",
  "pcb_trace", "pcb_via", "schematic_component", "source_component",
  "source_net", "source_trace",
]);

const APPROXIMATED_TYPES = new Set([
  "pcb_copper_pour", "pcb_courtyard_rect", "pcb_keepout", "pcb_silkscreen_path",
  "pcb_silkscreen_text", "pcb_solder_paste", "schematic_circle", "schematic_line",
  "schematic_net_label", "schematic_path", "schematic_sheet", "schematic_symbol",
  "schematic_text", "schematic_trace",
]);

const OMITTED_TYPES = new Set([
  "cad_component", "cad_model", "pcb_port", "schematic_port", "source_group",
  "source_board", "source_port", "source_project_metadata", "schematic_group",
]);

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function deterministicUuid(seed: string, index: number): string {
  const hex = digest(`${seed}\0uuid\0${index}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeGeneratedFiles(
  raw: readonly { readonly path: string; readonly content: string }[],
  seed: string,
): readonly KicadHandoffFile[] {
  const uuidMap = new Map<string, string>();
  let uuidIndex = 0;
  const normalized = raw.map(({ path, content }) => {
    let value = content.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      (uuid) => {
        const key = uuid.toLowerCase();
        const existing = uuidMap.get(key);
        if (existing !== undefined) return existing;
        const replacement = deterministicUuid(seed, uuidIndex++);
        uuidMap.set(key, replacement);
        return replacement;
      },
    );
    if (path.endsWith(".kicad_pro")) {
      const project = JSON.parse(value) as Record<string, unknown>;
      const head = project.head;
      if (head !== null && typeof head === "object" && !Array.isArray(head)) {
        (head as Record<string, unknown>).created = "1970-01-01T00:00:00.000Z";
        (head as Record<string, unknown>).modified = "1970-01-01T00:00:00.000Z";
      }
      value = `${JSON.stringify(project, null, 2)}\n`;
    } else if (!value.endsWith("\n")) {
      value += "\n";
    }
    return Object.freeze({ path, content: value, sha256: digest(value) });
  });
  return Object.freeze(normalized);
}

function mappingReport(
  circuitJson: readonly AnyCircuitElement[],
  semanticReconciliation: Readonly<KicadSemanticReconciliation>,
): readonly KicadMappingEntry[] {
  const counts = new Map<string, number>();
  for (const element of circuitJson) counts.set(element.type, (counts.get(element.type) ?? 0) + 1);
  return Object.freeze([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => {
    if (semanticReconciliation.state === "passed" && SEMANTICALLY_RECONCILED_TYPES.has(type)) {
      return Object.freeze({
        circuitJsonType: type,
        count,
        disposition: "exact" as const,
        reason: "Fulmetry independently parsed the emitted KiCad files and reconciled every baseline object of this type against source identity, connectivity, dimensions, layers, and coordinates as applicable.",
      });
    }
    if (APPROXIMATED_TYPES.has(type)) {
      return Object.freeze({
        circuitJsonType: type,
        count,
        disposition: "approximated" as const,
        reason: "The pinned upstream converter emitted this construct and the result parsed offline, but Fulmetry has not independently reconciled every object and supported KiCad major.",
      });
    }
    if (OMITTED_TYPES.has(type) || type.startsWith("simulation_") || type.includes("_error") || type.includes("_warning")) {
      return Object.freeze({
        circuitJsonType: type,
        count,
        disposition: "omitted" as const,
        reason: "This logical, CAD-only, simulation, or diagnostic element is not represented as an independent KiCad design object.",
      });
    }
    return Object.freeze({
      circuitJsonType: type,
      count,
      disposition: "unsupported" as const,
      reason: "Fulmetry has no qualified mapping contract for this Circuit JSON type.",
    });
  }));
}

function validateProjectName(projectName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(projectName)) {
    throw new TypeError("KiCad projectName must be a bounded filename-safe identifier");
  }
}

function explicitViaCompatibleCircuitJson(
  circuitJson: readonly AnyCircuitElement[],
): AnyCircuitElement[] {
  const explicit = new Set(circuitJson.flatMap((element) =>
    element.type === "pcb_via" && typeof element.pcb_trace_id === "string"
      ? [`${element.pcb_trace_id}:${element.x}:${element.y}`]
      : []
  ));
  return circuitJson.map((element) => {
    if (element.type !== "pcb_trace") return element;
    let changed = false;
    const route = element.route.flatMap((point) => {
      if (
        point.route_type !== "via" ||
        !explicit.has(`${element.pcb_trace_id}:${point.x}:${point.y}`)
      ) return [point];
      changed = true;
      return [];
    });
    return changed ? { ...element, route } as AnyCircuitElement : element;
  });
}

export async function createKicadHandoff(
  circuitJson: readonly AnyCircuitElement[],
  options: { readonly projectName: string },
): Promise<Readonly<KicadHandoff>> {
  requireSupportedBunRuntime();
  validateProjectName(options.projectName);
  const adapter = await requireKicadAdapterIdentity();
  const circuitCanonical = canonicalCircuitJson(circuitJson);
  const circuitDigest = digest(circuitCanonical);
  const schematicFilename = `${options.projectName}.kicad_sch`;
  const pcbFilename = `${options.projectName}.kicad_pcb`;
  const projectFilename = `${options.projectName}.kicad_pro`;

  const schematic = new CircuitJsonToKicadSchConverter(circuitJson as AnyCircuitElement[]);
  schematic.runUntilFinished();
  const pcb = new CircuitJsonToKicadPcbConverter(explicitViaCompatibleCircuitJson(circuitJson), {
    includeBuiltin3dModels: false,
    projectName: options.projectName,
  });
  pcb.runUntilFinished();
  const project = new CircuitJsonToKicadProConverter(circuitJson as AnyCircuitElement[], {
    projectName: options.projectName,
    schematicFilename,
    pcbFilename,
    schematicSheetPlan: schematic.schematicSheetPlan,
  });
  project.runUntilFinished();
  const rawFiles = [
    ...schematic.getOutputFiles({ schematicFilename }).map(({ filename, content }) => ({ path: filename, content })),
    { path: pcbFilename, content: pcb.getOutputString() },
    { path: projectFilename, content: project.getOutputString() },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const files = normalizeGeneratedFiles(rawFiles, circuitDigest);

  for (const file of files) {
    if (file.path.endsWith(".kicad_sch")) parseKicadSch(file.content);
    if (file.path.endsWith(".kicad_pcb")) parseKicadPcb(file.content);
    if (file.path.endsWith(".kicad_pro")) JSON.parse(file.content);
  }
  let semanticReconciliation: Readonly<KicadSemanticReconciliation>;
  try {
    semanticReconciliation = reconcileKicadHandoffSemantics(circuitJson, files);
  } catch (error) {
    semanticReconciliation = failedKicadSemanticReconciliation(error);
  }
  const mapping = mappingReport(circuitJson, semanticReconciliation);
  const report = Object.freeze({
    schemaVersion: KICAD_HANDOFF_SCHEMA_VERSION,
    lifecycle: "detached-downstream-handoff" as const,
    projectName: options.projectName,
    circuitDigest,
    deterministic: true as const,
    adapter,
    offlineParse: Object.freeze({ schematic: "passed" as const, pcb: "passed" as const, projectJson: "passed" as const }),
    semanticReconciliation,
    liveKiCadValidation: Object.freeze({
      state: "unavailable" as const,
      supportedMajors: Object.freeze([10]),
      message: "No KiCad executable was invoked; live validation requires the official signed KiCad 10 Apple Silicon macOS application.",
    }),
    mapping,
    files: Object.freeze(files.map(({ content: _content, ...file }) => Object.freeze(file))),
    limitations: Object.freeze([
      "Fulmetry independently reconciles the baseline component, symbol, footprint, net, trace, via, hole, outline, copper-layer, dimension, and coordinate contract; constructs outside that contract remain approximated or omitted as reported.",
      "The handoff is detached: later KiCad edits are an independent downstream design and are never synchronized back to TypeScript.",
      "Ordinary regeneration creates a new handoff and must never overwrite a human-modified KiCad project.",
      "No KiCad ERC or DRC result is implied by offline syntax parsing; live results are explicit current-run evidence when available.",
    ]),
  });
  return markAuthenticKicadHandoff(Object.freeze({ files, report }));
}

export {
  KICAD_DETECTION_CANDIDATE_MAJORS,
  KICAD_LIVE_ADAPTER_VERSION,
  parseKicadCliVersionOutput,
  validateKicadHandoffLive,
  verifyKicadLiveInputEvidence,
  type KicadLiveValidationOptions,
} from "./live";

export {
  reconcileKicadHandoffSemantics,
  failedKicadSemanticReconciliation,
  type KicadSemanticReconciliation,
} from "./semantic";
