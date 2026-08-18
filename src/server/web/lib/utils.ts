// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function shortDigest(value: string | null | undefined): string {
  if (!value) return "—";
  const digest = value.includes(":") ? value.split(":").at(-1)! : value;
  return digest.length > 12 ? `${digest.slice(0, 8)}…${digest.slice(-4)}` : digest;
}

export function titleCase(value: string): string {
  return value.replaceAll(/[-_]/gu, " ").replaceAll(/\b\w/gu, (character) => character.toUpperCase());
}

export function elementId(element: Record<string, unknown>): string | undefined {
  const primary = element[`${String(element.type)}_id`];
  if (typeof primary === "string") return primary;
  return Object.entries(element).find(([key, value]) => key.endsWith("_id") && typeof value === "string")?.[1] as string | undefined;
}

export function elementHumanLabel(element: Record<string, unknown>): string | undefined {
  const reference = typeof element.name === "string" ? element.name : undefined;
  const secondary = [
    element.display_name,
    element.manufacturer_part_number,
    element.display_value,
    element.display_resistance,
    element.display_capacitance,
    element.display_inductance,
    element.value,
  ].find((value) => typeof value === "string" && value.trim() !== "") as string | undefined;
  if (reference && secondary && secondary !== reference) return `${reference} — ${secondary}`;
  return reference ?? secondary;
}
