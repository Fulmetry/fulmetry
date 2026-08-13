// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import ts from "typescript";

function rejectDuplicateKeys(text: string, label: string): void {
  const source = ts.parseJsonText(label, text);
  const diagnostics = (source as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length > 0) {
    throw new TypeError(`${label} is invalid JSONC: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ")}`);
  }
  const walk = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set<string>();
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          (!ts.isStringLiteral(property.name) && !ts.isNumericLiteral(property.name))
        ) throw new TypeError(`${label} contains an unsupported JSONC property`);
        if (keys.has(property.name.text)) {
          throw new TypeError(`${label} contains duplicate key ${JSON.stringify(property.name.text)}`);
        }
        keys.add(property.name.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
}

export function parseJsoncWithoutDuplicateKeys(text: string, label: string): unknown {
  rejectDuplicateKeys(text, label);
  try {
    return Bun.JSONC.parse(text);
  } catch (error) {
    throw new TypeError(`${label} is invalid JSONC: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseJsonWithoutDuplicateKeys(text: string, label: string): unknown {
  rejectDuplicateKeys(text, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${label} is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
