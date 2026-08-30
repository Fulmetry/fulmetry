// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { defineDiagnostic, type Diagnostic } from "../diagnostics";
import { discoverProjectSourceGraph } from "./source-graph";
import { internalDiagnosticObjectHead } from "../diagnostic-object-selector";

export interface AuthoredNameLocation {
  readonly name: string;
  readonly location: string;
}

export type EntityProvenanceKind = "component" | "pad" | "net" | "trace" | "via";

export interface VerifiedEntityProvenance {
  readonly kind: EntityProvenanceKind;
  readonly elementId: string;
  /** Root-to-leaf hierarchy derived from Circuit JSON group ownership. */
  readonly instancePath: readonly string[];
  readonly sourceLocations: readonly string[];
  readonly origin: "authored" | "generated" | "ambiguous-authored-location";
}

export interface CircuitEntityHierarchy {
  readonly kind: EntityProvenanceKind;
  readonly elementId: string;
  readonly instancePath: readonly string[];
}

export const ENTITY_PROVENANCE_LIMIT = 8_000;
export const ENTITY_PROVENANCE_PATH_DEPTH_LIMIT = 32;

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function literalText(node: ts.Expression | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

export async function indexAuthoredNames(options: {
  readonly projectRoot: string;
  readonly entry: string;
}): Promise<ReadonlyMap<string, readonly string[]>> {
  const paths = await discoverProjectSourceGraph(options.projectRoot, options.entry);
  const byName = new Map<string, Set<string>>();
  for (const path of paths) {
    const sourceText = await readFile(join(options.projectRoot, path), "utf8");
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const record = (name: string, position: number) => {
      if (!name.trim()) return;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
      const locations = byName.get(name) ?? new Set<string>();
      locations.add(`${path.replaceAll("\\", "/")}:${line + 1}:${character + 1}`);
      byName.set(name, locations);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "name"
      ) {
        const name = literalText(node.initializer);
        if (name !== undefined) record(name, node.initializer.getStart(sourceFile));
      }
      if (
        ts.isJsxAttribute(node) && ts.isIdentifier(node.name) &&
        node.name.text === "name" && node.initializer !== undefined
      ) {
        if (ts.isStringLiteral(node.initializer)) record(node.initializer.text, node.initializer.getStart(sourceFile));
        if (ts.isJsxExpression(node.initializer)) {
          const name = literalText(node.initializer.expression);
          if (name !== undefined) record(name, node.initializer.getStart(sourceFile));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return new Map([...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
    ([name, locations]) => [name, Object.freeze([...locations].sort())] as const,
  ));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function primaryId(element: Record<string, unknown>): string | undefined {
  const id = element[`${String(element.type)}_id`];
  return typeof id === "string" ? id : undefined;
}

const PROVENANCE_ENTITY_KINDS = new Map<string, EntityProvenanceKind>([
  ["source_component", "component"],
  ["pcb_component", "component"],
  ["pcb_smtpad", "pad"],
  ["pcb_plated_hole", "pad"],
  ["source_net", "net"],
  ["source_trace", "trace"],
  ["pcb_trace", "trace"],
  ["pcb_via", "via"],
]);

const PROVENANCE_REFERENCE_KEYS = [
  "source_component_id", "source_trace_id", "source_port_id", "source_net_id",
  "pcb_component_id", "pcb_trace_id", "pcb_port_id",
] as const;

function deriveEntityProvenanceFromNames(
  elements: readonly Record<string, unknown>[],
  names: ReadonlyMap<string, readonly string[]>,
): readonly VerifiedEntityProvenance[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const element of elements) {
    const id = primaryId(element);
    if (id === undefined) continue;
    if (byId.has(id)) throw new Error(`Circuit JSON duplicates provenance identity ${id}`);
    byId.set(id, element);
  }
  const groups = elements.filter(({ type }) => type === "source_group");
  const groupBySourceId = new Map<string, Record<string, unknown>>();
  const groupBySubcircuitId = new Map<string, Record<string, unknown>>();
  for (const group of groups) {
    const sourceGroupId = group.source_group_id;
    if (typeof sourceGroupId !== "string" || !sourceGroupId) {
      throw new Error("A source group lacks its stable source_group_id");
    }
    if (groupBySourceId.has(sourceGroupId)) {
      throw new Error(`Circuit JSON duplicates source group ${sourceGroupId}`);
    }
    groupBySourceId.set(sourceGroupId, group);
    if (typeof group.subcircuit_id === "string") {
      if (groupBySubcircuitId.has(group.subcircuit_id)) {
        throw new Error(`Circuit JSON duplicates subcircuit ${group.subcircuit_id}`);
      }
      groupBySubcircuitId.set(group.subcircuit_id, group);
    }
  }
  const sourceBoards = elements.filter(({ type }) => type === "source_board");
  if (sourceBoards.length !== 1) {
    throw new Error(`Circuit JSON entity hierarchy requires exactly one source_board; found ${sourceBoards.length}`);
  }
  const boardRootId = sourceBoards[0]!.source_group_id;
  if (typeof boardRootId !== "string" || !boardRootId || !groupBySourceId.has(boardRootId)) {
    throw new Error(
      `The sole source_board source-group hierarchy references missing root source group ${String(boardRootId)}`,
    );
  }
  const boardRoot = groupBySourceId.get(boardRootId)!;

  const referencedElements = (
    element: Record<string, unknown>,
  ): readonly Record<string, unknown>[] => PROVENANCE_REFERENCE_KEYS.flatMap((key) => {
    const id = element[key];
    if (id === undefined) return [];
    if (typeof id !== "string" || !id) {
      throw new Error(`${String(primaryId(element) ?? element.type)} has invalid ${key}`);
    }
    const related = byId.get(id);
    // Primary identity fields share names with reference fields on several
    // Circuit JSON records. They identify the record itself, not an owner.
    if (related === element) return [];
    if (related === undefined) {
      throw new Error(`${String(primaryId(element) ?? element.type)} references missing ${key} ${id}`);
    }
    return [related];
  });
  const owningGroup = (
    element: Record<string, unknown>,
  ): Record<string, unknown> | undefined => {
    const candidates = new Set<Record<string, unknown>>();
    const pending = [element];
    const visited = new Set<Record<string, unknown>>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current.type !== "source_group" && current.source_group_id !== undefined) {
        const id = current.source_group_id;
        if (typeof id !== "string" || !id || !groupBySourceId.has(id)) {
          throw new Error(
            `${String(primaryId(current) ?? current.type)} source-group hierarchy references missing source group ${String(id)}`,
          );
        }
        candidates.add(groupBySourceId.get(id)!);
      }
      if (current.subcircuit_id !== undefined) {
        const id = current.subcircuit_id;
        if (typeof id !== "string" || !id || !groupBySubcircuitId.has(id)) {
          throw new Error(
            `${String(primaryId(current) ?? current.type)} source-group hierarchy references missing subcircuit ${String(id)}`,
          );
        }
        candidates.add(groupBySubcircuitId.get(id)!);
      }
      pending.push(...referencedElements(current));
    }
    if (candidates.size > 1) {
      const groups = [...candidates]
        .map(({ source_group_id }) => String(source_group_id))
        .sort()
        .join(", ");
      throw new Error(
        `${String(primaryId(element) ?? element.type)} has contradictory source-group ownership: ${groups}`,
      );
    }
    return candidates.values().next().value;
  };
  const parentGroup = (group: Record<string, unknown>): Record<string, unknown> | undefined => {
    const id = group.source_group_id;
    if (typeof id !== "string" || !id) throw new Error("A provenance group lacks a stable identity");
    const parentCandidates = new Set<Record<string, unknown>>();
    const parentSourceGroupId = group.parent_source_group_id;
    if (parentSourceGroupId !== undefined) {
      if (
        typeof parentSourceGroupId !== "string" || !parentSourceGroupId ||
        !groupBySourceId.has(parentSourceGroupId)
      ) {
        throw new Error(
          `Source group ${id} references missing parent source group ${String(parentSourceGroupId)}`,
        );
      }
      parentCandidates.add(groupBySourceId.get(parentSourceGroupId)!);
    }
    const parentSubcircuitId = group.parent_subcircuit_id;
    if (parentSubcircuitId !== undefined) {
      if (
        typeof parentSubcircuitId !== "string" || !parentSubcircuitId ||
        !groupBySubcircuitId.has(parentSubcircuitId)
      ) {
        throw new Error(
          `Source group ${id} references missing parent subcircuit ${String(parentSubcircuitId)}`,
        );
      }
      parentCandidates.add(groupBySubcircuitId.get(parentSubcircuitId)!);
    }
    if (parentCandidates.size === 0) return undefined;
    if (parentCandidates.size > 1) {
      const parents = [...parentCandidates]
        .map(({ source_group_id }) => String(source_group_id))
        .sort()
        .join(", ");
      throw new Error(`Source group ${id} has contradictory parent hierarchy: ${parents}`);
    }
    return parentCandidates.values().next().value;
  };
  const groupPath = (leaf: Record<string, unknown>): readonly string[] => {
    const reversed: string[] = [];
    const visited = new Set<Record<string, unknown>>();
    let group: Record<string, unknown> | undefined = leaf;
    while (group !== undefined) {
      if (visited.has(group)) throw new Error("Circuit JSON source-group hierarchy contains a cycle");
      if (reversed.length >= ENTITY_PROVENANCE_PATH_DEPTH_LIMIT) {
        throw new Error(`Circuit JSON source-group hierarchy exceeds ${ENTITY_PROVENANCE_PATH_DEPTH_LIMIT} levels`);
      }
      visited.add(group);
      const id = group.source_group_id;
      if (typeof id !== "string" || !id) throw new Error("A provenance group lacks a stable identity");
      const explicitName = group.was_automatically_named !== true &&
          typeof group.name === "string" && group.name.trim()
        ? group.name
        : undefined;
      reversed.push(`group:${explicitName ?? `@${id}`}`);
      const parent = parentGroup(group);
      if (parent === undefined) {
        if (group !== boardRoot) {
          throw new Error(
            `Source group ${id} is disconnected from source_board root ${boardRootId}`,
          );
        }
        break;
      }
      group = parent;
    }
    return Object.freeze(reversed.reverse());
  };
  // Authenticate the complete project hierarchy, including empty groups that
  // do not currently own a manufactured entity. A release cannot hide a
  // disconnected second design tree outside the entity table.
  for (const group of groups) groupPath(group);
  const relatedClosure = (initial: Record<string, unknown>): readonly Record<string, unknown>[] => {
    const found: Record<string, unknown>[] = [];
    const pending = [initial];
    const visited = new Set<Record<string, unknown>>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      found.push(current);
      pending.push(...referencedElements(current));
    }
    return found;
  };
  const exactRelated = (
    closure: readonly Record<string, unknown>[],
    type: "source_component" | "source_trace" | "source_port",
    owner: string,
  ): Record<string, unknown> | undefined => {
    const related = closure.filter((candidate) => candidate.type === type);
    if (related.length > 1) {
      const ids = related.map((candidate) => String(primaryId(candidate))).sort().join(", ");
      throw new Error(`${owner} has contradictory ${type} ownership: ${ids}`);
    }
    return related[0];
  };
  const entityPath = (
    kind: EntityProvenanceKind,
    element: Record<string, unknown>,
    closure: readonly Record<string, unknown>[],
    id: string,
  ): readonly string[] => {
    const sourceComponent = exactRelated(closure, "source_component", id);
    const component = typeof sourceComponent?.name === "string" && sourceComponent.name.trim()
      ? sourceComponent.name
      : undefined;
    if (kind === "component") {
      return [`component:${component ?? id}`, `record:${id}`];
    }
    if (kind === "pad") {
      if (component === undefined) {
        throw new Error(`${id} lacks an authenticated owning source component`);
      }
      const port = exactRelated(closure, "source_port", id);
      const numericHint = Array.isArray(element.port_hints)
        ? element.port_hints.find((hint) => /^\d+$/u.test(String(hint)))
        : undefined;
      if (
        port?.pin_number !== undefined && numericHint !== undefined &&
        String(port.pin_number) !== String(numericHint)
      ) {
        throw new Error(
          `${id} port hint ${String(numericHint)} contradicts source_port ${String(primaryId(port))} pin ${String(port.pin_number)}`,
        );
      }
      const pin = port?.pin_number ?? port?.name ?? numericHint;
      return [`component:${component}`, `pad:${pin === undefined ? id : String(pin)}`, `record:${id}`];
    }
    if (kind === "net") {
      const name = typeof element.name === "string" ? element.name : undefined;
      return [`net:${name ?? id}`, `record:${id}`];
    }
    if (kind === "trace") {
      const sourceTrace = exactRelated(closure, "source_trace", id);
      const name = typeof sourceTrace?.name === "string" ? sourceTrace.name : undefined;
      return [`trace:${name ?? id}`, `record:${id}`];
    }
    const sourceTrace = exactRelated(closure, "source_trace", id);
    const traceName = typeof sourceTrace?.name === "string" ? sourceTrace.name : undefined;
    if (traceName === undefined) throw new Error(`${id} lacks an authenticated owning source trace`);
    return [`trace:${traceName}`, `via:${id}`];
  };

  const targets = elements.filter(({ type }) => PROVENANCE_ENTITY_KINDS.has(String(type)));
  if (targets.length > ENTITY_PROVENANCE_LIMIT) {
    throw new Error(`Entity provenance exceeds ${ENTITY_PROVENANCE_LIMIT} records`);
  }
  const entries = targets.map((element) => {
    const kind = PROVENANCE_ENTITY_KINDS.get(String(element.type))!;
    const elementId = primaryId(element);
    if (elementId === undefined || !elementId) {
      throw new Error(`${String(element.type)} lacks its stable provenance identity`);
    }
    const group = owningGroup(element);
    if (group === undefined) {
      throw new Error(`${elementId} is not owned by an authenticated source-group hierarchy`);
    }
    const closure = relatedClosure(element);
    const candidateNames = new Set<string>();
    for (const related of closure) {
      for (const key of ["name", "display_name"] as const) {
        if (typeof related[key] === "string") candidateNames.add(related[key]);
      }
    }
    const matched = [...candidateNames].flatMap((name) => names.get(name) ?? []);
    const sourceLocations = Object.freeze([...new Set(matched)].sort());
    const ambiguous = [...candidateNames].some((name) => (names.get(name)?.length ?? 0) > 1);
    const instancePath = Object.freeze([
      ...groupPath(group),
      ...entityPath(kind, element, closure, elementId),
    ]);
    if (instancePath.length > ENTITY_PROVENANCE_PATH_DEPTH_LIMIT) {
      throw new Error(
        `${elementId} entity instance path exceeds ${ENTITY_PROVENANCE_PATH_DEPTH_LIMIT} segments`,
      );
    }
    return Object.freeze({
      kind,
      elementId,
      instancePath,
      sourceLocations: ambiguous ? Object.freeze([] as string[]) : sourceLocations,
      origin: ambiguous
        ? "ambiguous-authored-location" as const
        : sourceLocations.length > 0
          ? "authored" as const
          : "generated" as const,
    });
  }).sort((left, right) => left.elementId.localeCompare(right.elementId));
  const pathOwners = new Map<string, string>();
  for (const entry of entries) {
    const path = entry.instancePath.join("/");
    const previous = pathOwners.get(path);
    if (previous !== undefined) {
      throw new Error(
        `Entity instance path ${path} is shared by ${previous} and ${entry.elementId}`,
      );
    }
    pathOwners.set(path, entry.elementId);
  }
  return Object.freeze(entries);
}

export async function deriveEntityProvenance(options: {
  readonly projectRoot: string;
  readonly entry: string;
  readonly circuitJson: readonly unknown[];
}): Promise<readonly VerifiedEntityProvenance[]> {
  const names = await indexAuthoredNames(options);
  const elements = options.circuitJson.flatMap((value) => {
    const element = record(value);
    return element === undefined ? [] : [element];
  });
  return deriveEntityProvenanceFromNames(elements, names);
}

/** Derives the hierarchy that can be authenticated from Circuit JSON alone. */
export function deriveCircuitEntityHierarchy(
  circuitJson: readonly unknown[],
): readonly CircuitEntityHierarchy[] {
  const elements = circuitJson.flatMap((value) => {
    const element = record(value);
    return element === undefined ? [] : [element];
  });
  return Object.freeze(deriveEntityProvenanceFromNames(elements, new Map()).map((entry) =>
    Object.freeze({
      kind: entry.kind,
      elementId: entry.elementId,
      instancePath: entry.instancePath,
    })
  ));
}

export async function enrichDiagnosticProvenance(options: {
  readonly projectRoot: string;
  readonly entry: string;
  readonly circuitJson: readonly unknown[];
  readonly diagnostics: readonly Diagnostic[];
  /** @internal Only for detail tokens emitted directly by Fulmetry assessments. */
  readonly allowInternalDetailSelectors?: boolean;
}): Promise<readonly Diagnostic[]> {
  const names = await indexAuthoredNames(options);
  const elements = options.circuitJson.flatMap((value) => {
    const element = record(value);
    return element === undefined ? [] : [element];
  });
  let entityProvenance: readonly VerifiedEntityProvenance[] = Object.freeze([]);
  try {
    // Diagnostics can also be enriched from intentionally partial Circuit JSON
    // in development. Production derives the complete strict table separately.
    entityProvenance = deriveEntityProvenanceFromNames(elements, names);
  } catch {
    entityProvenance = Object.freeze([]);
  }
  const entityPathById = new Map(
    entityProvenance.map((entry) => [entry.elementId, entry.instancePath.join("/")] as const),
  );
  const byId = new Map<string, Record<string, unknown>[]>();
  for (const element of elements) {
    const id = primaryId(element);
    if (id === undefined) continue;
    byId.set(id, [...(byId.get(id) ?? []), element]);
  }
  const byCircuitName = new Map<string, Record<string, unknown>[]>();
  for (const element of elements) {
    for (const key of ["name", "display_name"] as const) {
      const name = element[key];
      if (typeof name !== "string" || !name.trim()) continue;
      byCircuitName.set(name, [...(byCircuitName.get(name) ?? []), element]);
    }
  }
  const referenceKeys = [
    "source_component_id", "source_trace_id", "source_port_id", "source_net_id",
    "pcb_component_id", "pcb_trace_id", "pcb_port_id",
  ] as const;
  const provenanceForObject = (object: string): Readonly<{
    locations: readonly string[];
    ambiguous: boolean;
    referencesCircuitElement: boolean;
    resolvedSelector: boolean;
    referencesAuthoredName: boolean;
  }> => {
    const locations = new Set<string>();
    let ambiguous = false;
    let referencesCircuitElement = false;
    const referenceMatch = /^([^:.]+)\.reference$/u.exec(object);
    const internalDetailHead = options.allowInternalDetailSelectors === true
      ? internalDiagnosticObjectHead(object)
      : undefined;
    const selectorKind = !object.includes(":") && !object.includes(".")
      ? "element"
      : referenceMatch !== null
        ? "component-reference"
        : internalDetailHead !== undefined
          ? "internal-detail"
        : "invalid";
    const selectorKeys: string[] = [];
    if (selectorKind === "element") selectorKeys.push(object);
    else if (selectorKind === "component-reference") selectorKeys.push(referenceMatch![1]!);
    else if (selectorKind === "internal-detail") selectorKeys.push(internalDetailHead!);
    const referencesAuthoredName = selectorKeys.some((key) => names.has(key));
    const addAuthoredName = (name: string) => {
      const candidates = names.get(name) ?? [];
      if (candidates.length === 1) locations.add(candidates[0]!);
      else if (candidates.length > 1) ambiguous = true;
    };
    const unique = (candidates: readonly Record<string, unknown>[]) => {
      const distinct = [...new Set(candidates)];
      if (distinct.length > 1) ambiguous = true;
      return distinct.length === 1 ? distinct[0] : undefined;
    };
    const resolveSelector = (): Record<string, unknown> | undefined => {
      const acceptsSelectorKind = (element: Record<string, unknown>) =>
        selectorKind !== "component-reference" ||
        element.type === "source_component" || element.type === "pcb_component";
      for (const key of selectorKeys) {
        const element = unique(byId.get(key) ?? []);
        if (element !== undefined && acceptsSelectorKind(element)) return element;
      }
      for (const key of selectorKeys) {
        const element = unique(byCircuitName.get(key) ?? []);
        if (element !== undefined && acceptsSelectorKind(element)) return element;
      }
      return undefined;
    };
    const visitElement = (element: Record<string, unknown>, visited: Set<Record<string, unknown>>) => {
      if (visited.has(element)) return;
      visited.add(element);
      referencesCircuitElement = true;
      for (const key of ["name", "display_name"] as const) {
        const name = element[key];
        if (typeof name === "string") addAuthoredName(name);
      }
      for (const key of referenceKeys) {
        const related = element[key];
        if (typeof related !== "string") continue;
        const relatedElement = unique(byId.get(related) ?? []);
        if (relatedElement !== undefined) visitElement(relatedElement, visited);
      }
    };
    const initial = resolveSelector();
    if (initial !== undefined) visitElement(initial, new Set());
    return Object.freeze({
      locations: Object.freeze([...locations].sort()),
      ambiguous,
      referencesCircuitElement,
      resolvedSelector: initial !== undefined,
      referencesAuthoredName: referencesAuthoredName || selectorKind === "invalid",
    });
  };
  return Object.freeze(options.diagnostics.map((diagnostic) => {
    if (diagnostic.sourceLocations.length > 0) return diagnostic;
    const provenance = diagnostic.objects.map(provenanceForObject);
    const derivedLocations = Object.freeze([
      ...new Set(provenance.flatMap(({ locations }) => locations)),
    ].sort());
    const allSelectorsResolved = provenance.length > 0 &&
      provenance.every(({ resolvedSelector }) => resolvedSelector);
    const sourceLocations = allSelectorsResolved &&
        !provenance.some(({ ambiguous }) => ambiguous)
      ? derivedLocations
      : Object.freeze([] as string[]);
    const marker = sourceLocations.length > 0
      ? "provenance:nearest-authored-name"
      : provenance.some(({ ambiguous }) => ambiguous)
        ? "provenance:ambiguous-authored-name"
        : provenance.some(({ referencesCircuitElement, referencesAuthoredName }) =>
          referencesCircuitElement || referencesAuthoredName
        )
          ? "provenance:authored-location-unavailable"
          : "provenance:synthetic-generated";
    const instancePaths = Object.freeze([
      ...new Set(diagnostic.objects.flatMap((object) => {
        const head = internalDiagnosticObjectHead(object) ?? /^([^:.]+)/u.exec(object)?.[1];
        const path = head === undefined ? undefined : entityPathById.get(head);
        return path === undefined ? [] : [`provenance:instance-path:${path}`];
      })),
    ].sort());
    return defineDiagnostic({
      ...diagnostic,
      sourceLocations,
      evidence: [...(diagnostic.evidence ?? []), marker, ...instancePaths],
    });
  }));
}
