// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";

const [specifier, origin] = process.argv.slice(2);
if ((specifier !== "tscircuit" && specifier !== "fulmetry") || origin === undefined || !isAbsolute(origin)) {
  throw new TypeError("Resolver requires fulmetry or tscircuit and one absolute origin");
}
process.stdout.write(await realpath(Bun.resolveSync(specifier, origin)));
