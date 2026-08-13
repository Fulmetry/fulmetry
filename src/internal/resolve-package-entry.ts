// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";

const [specifier, origin] = process.argv.slice(2);
if ((specifier !== "tscircuit" && specifier !== "pcboo") || origin === undefined || !isAbsolute(origin)) {
  throw new TypeError("Resolver requires pcboo or tscircuit and one absolute origin");
}
process.stdout.write(await realpath(Bun.resolveSync(specifier, origin)));
