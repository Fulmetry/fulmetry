// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
declare module "format-si-prefix" {
  export function formatSI(value: number): string;
  export function unformatSI(value: string): number;
}
