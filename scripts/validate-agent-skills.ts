// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { lstat, opendir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const EXPECTED_SKILLS = Object.freeze([
  "fulmetry-best-practices",
  "fulmetry-design",
  "fulmetry-diagnose",
  "fulmetry-manufacturing",
  "fulmetry-resolve-models",
  "fulmetry-schematic-layout",
  "fulmetry-verify",
] as const);
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const REQUIRED_SKILL_CONTRACTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "fulmetry-best-practices": Object.freeze([
    "complete logical and physical design",
    "Do not launch the local server as the final handoff",
  ]),
  "fulmetry-design": Object.freeze([
    "references/completion-and-preview.md",
    "require zero unresolved footprints",
    "Only after the completion gate and `fulmetry-resolve-models` audit pass, start `bun run dev`",
    "clearance and routing-congestion escalation rules",
  ]),
  "fulmetry-diagnose": Object.freeze([
    "browser geometry differs from Circuit JSON",
    "compare the current Circuit JSON inventory",
    "congestion decision tree",
  ]),
  "fulmetry-verify": Object.freeze([
    "component-to-footprint coverage",
    "required logical connections but zero PCB traces",
  ]),
  "fulmetry-resolve-models": Object.freeze([
    "Runtime HTTP model dependencies are not a completion state",
    "Only after both gates pass may the workflow start `bun run dev`",
    "scripts/audit-cad-models.ts",
  ]),
  "fulmetry-schematic-layout": Object.freeze([
    "never reuse PCB coordinates as logical coordinates",
    "no two schematic-component bounding boxes overlap",
    "`schPinArrangement` must use numeric pin identifiers",
    "KiCad CLI provides validation and export commands, not automatic schematic placement or cleanup",
  ]),
});

function parseFrontmatter(source: string, path: string): Readonly<{ name: string; description: string }> {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source);
  if (match === null) throw new Error(`${path} has invalid YAML frontmatter boundaries`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`${path} frontmatter must contain simple key-value fields`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (fields[key] !== undefined) throw new Error(`${path} frontmatter repeats ${key}`);
    fields[key] = value;
  }
  const keys = Object.keys(fields).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["description", "name"])) {
    throw new Error(`${path} frontmatter must contain only name and description`);
  }
  return Object.freeze({ name: fields.name!, description: fields.description! });
}

async function validateSkill(skillRoot: string): Promise<void> {
  const name = basename(skillRoot);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`Invalid skill directory name ${name}`);
  }
  const source = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = parseFrontmatter(source, `${name}/SKILL.md`);
  if (frontmatter.name !== name) throw new Error(`${name}/SKILL.md name must match its directory`);
  if (
    frontmatter.description.length === 0 || frontmatter.description.length > MAX_DESCRIPTION_LENGTH ||
    /[<>]/u.test(frontmatter.description)
  ) throw new Error(`${name}/SKILL.md has an invalid description`);
  if (/\[(?:TODO|TODO:)|\bTODO\b/u.test(source)) throw new Error(`${name}/SKILL.md contains a TODO placeholder`);
  for (const required of REQUIRED_SKILL_CONTRACTS[name] ?? []) {
    if (!source.includes(required)) throw new Error(`${name}/SKILL.md is missing required workflow contract: ${required}`);
  }

  if (name === "fulmetry-design") {
    const completion = await readFile(join(skillRoot, "references/completion-and-preview.md"), "utf8");
    for (const required of [
      "zero `pcb_missing_footprint_error` records",
      "logical connectivity with zero PCB traces is incomplete",
      "no `show_as_bounding_box` fallback",
      "Only after the applicable fresh-artifact and evidence gates pass",
      "Leave the server running",
    ]) {
      if (!completion.includes(required)) throw new Error(`fulmetry-design completion gate is missing: ${required}`);
    }
    const physicalDesign = await readFile(join(skillRoot, "references/physical-design.md"), "utf8");
    for (const required of [
      "Treat `0.20 mm` as a conservative general copper-clearance default",
      "Do not lower the whole board",
      "then enlarge the board outline when routing channels remain genuinely insufficient",
      "Never resize an outline constrained by an enclosure",
      "Prefer the smallest outline that passes",
    ]) {
      if (!physicalDesign.includes(required)) throw new Error(`fulmetry-design routing policy is missing: ${required}`);
    }
  }

  if (name === "fulmetry-diagnose") {
    const diagnostics = await readFile(join(skillRoot, "references/diagnostics.md"), "utf8");
    for (const required of [
      "Keep `0.20 mm` as the ordinary general-clearance target",
      "Never lower the global rule just to make an autorouter finish",
      "enlarge the constrained axis or region by a small documented increment",
      "Never alter a verified land pattern to gain routing space",
    ]) {
      if (!diagnostics.includes(required)) throw new Error(`fulmetry-diagnose routing policy is missing: ${required}`);
    }
  }

  const links = [...source.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/gu)].map((match) => match[1]!);
  for (const link of links) {
    if (link.startsWith("/") || link.includes("..")) throw new Error(`${name}/SKILL.md has unsafe link ${link}`);
    const target = join(skillRoot, ...link.split("/"));
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name}/SKILL.md link is not a regular file: ${link}`);
  }

  const walk = async (directory: string): Promise<void> => {
    for await (const entry of await opendir(directory)) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`${name} contains a symlink`);
      if (stat.isDirectory()) await walk(path);
      else if (!stat.isFile()) throw new Error(`${name} contains a non-regular entry`);
      else if (/\.(?:md|yaml)$/u.test(entry.name)) {
        const text = await readFile(path, "utf8");
        if (/\[(?:TODO|TODO:)|\bTODO\b/u.test(text)) throw new Error(`${path} contains a TODO placeholder`);
        if (entry.name === "openai.yaml") {
          const defaultPrompt = /^\s*default_prompt:\s*"([^"]+)"\s*$/mu.exec(text)?.[1];
          if (defaultPrompt === undefined || !defaultPrompt.includes(`$${name}`)) {
            throw new Error(`${path} default_prompt must mention $${name}`);
          }
          const shortDescription = /^\s*short_description:\s*"([^"]+)"\s*$/mu.exec(text)?.[1];
          if (shortDescription === undefined || shortDescription.length < 25 || shortDescription.length > 64) {
            throw new Error(`${path} short_description must contain 25-64 characters`);
          }
        }
      }
    }
  };
  await walk(skillRoot);
}

const skillsRoot = resolve(import.meta.dir, "../packages/create-fulmetry/skills");
const actual: string[] = [];
for await (const entry of await opendir(skillsRoot)) {
  const stat = await lstat(join(skillsRoot, entry.name));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Skills root contains invalid entry ${entry.name}`);
  actual.push(entry.name);
}
actual.sort();
if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_SKILLS)) {
  throw new Error(`Skill catalog mismatch: ${actual.join(", ")}`);
}
for (const name of actual) await validateSkill(join(skillsRoot, name));
process.stdout.write(`Validated ${actual.length} Fulmetry Agent Skills\n`);
