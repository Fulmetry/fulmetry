#!/usr/bin/env bun

export {};

type CircuitRecord = Record<string, unknown> & { type?: unknown };

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("Usage: bun audit-cad-models.ts --circuit <circuit.json>");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--circuit" || !args[1]) usage();
const path = args[1];
const file = Bun.file(path);
if (!(await file.exists())) usage(`Circuit JSON does not exist: ${path}`);
if (file.size > 64 * 1024 * 1024) usage("Circuit JSON exceeds the 64 MiB audit limit");

let parsed: unknown;
try {
  parsed = await file.json();
} catch {
  usage(`Circuit JSON is not valid JSON: ${path}`);
}
if (!Array.isArray(parsed)) usage("Circuit JSON root must be an array");
const elements = parsed as CircuitRecord[];
const pcbComponents = elements.filter(({ type }) => type === "pcb_component");
const cadComponents = elements.filter(({ type }) => type === "cad_component");
const sourceNames = new Map(elements.filter(({ type }) => type === "source_component").flatMap((source) =>
  typeof source.source_component_id === "string"
    ? [[source.source_component_id, typeof source.name === "string" ? source.name : "<unnamed>"] as const]
    : [],
));
const cadByPcb = new Map<string, CircuitRecord[]>();
for (const cad of cadComponents) {
  const id = cad.pcb_component_id;
  if (typeof id !== "string" || id.length === 0) continue;
  const existing = cadByPcb.get(id) ?? [];
  existing.push(cad);
  cadByPcb.set(id, existing);
}

const modelFields = [
  "model_glb_url", "model_gltf_url", "model_obj_url", "model_stl_url",
  "model_step_url", "model_wrl_url",
] as const;
const unresolved: Array<Record<string, unknown>> = [];
let packageEquivalent = 0;
let directModel = 0;

for (const pcb of pcbComponents) {
  const pcbId = typeof pcb.pcb_component_id === "string" ? pcb.pcb_component_id : "<missing>";
  const sourceId = typeof pcb.source_component_id === "string" ? pcb.source_component_id : null;
  const sourceName = sourceId === null ? null : sourceNames.get(sourceId) ?? "<unnamed>";
  const matches = cadByPcb.get(pcbId) ?? [];
  if (matches.length !== 1) {
    unresolved.push({ pcbComponentId: pcbId, sourceComponentId: sourceId, sourceName, reason: matches.length === 0 ? "missing-cad-component" : "multiple-cad-components" });
    continue;
  }
  const cad = matches[0]!;
  if (cad.show_as_bounding_box === true) {
    unresolved.push({ pcbComponentId: pcbId, sourceComponentId: sourceId, sourceName, cadComponentId: cad.cad_component_id ?? null, reason: "bounding-box-fallback" });
    continue;
  }
  const urlField = modelFields.find((field) => typeof cad[field] === "string" && (cad[field] as string).length > 0);
  if (urlField !== undefined) {
    const url = cad[urlField] as string;
    if (/^(?:https?:)?\/\//iu.test(url)) {
      unresolved.push({ pcbComponentId: pcbId, sourceComponentId: sourceId, sourceName, cadComponentId: cad.cad_component_id ?? null, reason: "remote-runtime-model", field: urlField, url });
      continue;
    }
    directModel += 1;
    continue;
  }
  if (typeof cad.footprinter_string === "string" && cad.footprinter_string.length > 0) {
    packageEquivalent += 1;
    continue;
  }
  unresolved.push({ pcbComponentId: pcbId, sourceComponentId: sourceId, sourceName, cadComponentId: cad.cad_component_id ?? null, reason: "missing-model-binding" });
}

const result = {
  schemaVersion: 1,
  state: unresolved.length === 0 ? "passed" : "incomplete",
  circuit: path,
  counts: {
    pcbComponents: pcbComponents.length,
    cadComponents: cadComponents.length,
    directModels: directModel,
    qualifiedPackageEquivalentModels: packageEquivalent,
    unresolved: unresolved.length,
  },
  unresolved,
};
console.log(JSON.stringify(result, null, 2));
process.exit(unresolved.length === 0 ? 0 : 3);
