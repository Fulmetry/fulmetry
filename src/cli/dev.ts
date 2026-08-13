// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { startInspectionServer, type InspectionServer } from "../server";
import { requireSupportedBunRuntime } from "../runtime";

export interface StartedDevCommand {
  readonly server: Readonly<InspectionServer>;
  readonly stdout: string;
  readonly json: boolean;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || !/^\d{1,5}$/.test(value)) {
    throw new TypeError("--port requires an integer from 0 through 65535");
  }
  const port = Number(value);
  if (port > 65_535) throw new TypeError("--port requires an integer from 0 through 65535");
  return port;
}

/** Starts the long-running fixed inspection server for the CLI boundary. */
export async function startDevCommand(options: {
  readonly argv: readonly string[];
  readonly cwd?: string;
}): Promise<Readonly<StartedDevCommand>> {
  let hostname: string | undefined;
  let port: number | undefined;
  let json = false;
  for (let index = 0; index < options.argv.length; index += 1) {
    const argument = options.argv[index]!;
    if (argument === "--json") {
      if (json) throw new TypeError("--json may be specified only once");
      json = true;
    } else if (argument === "--host") {
      if (hostname !== undefined) throw new TypeError("--host may be specified only once");
      hostname = options.argv[++index];
      if (hostname === undefined || !hostname.trim() || hostname.startsWith("--")) {
        throw new TypeError("--host requires a hostname or IP address");
      }
    } else if (argument === "--port") {
      if (port !== undefined) throw new TypeError("--port may be specified only once");
      port = parsePort(options.argv[++index]);
    } else {
      throw new TypeError(`Unknown pcboo dev argument: ${argument}`);
    }
  }
  requireSupportedBunRuntime();
  const server = await startInspectionServer({
    projectDirectory: options.cwd ?? process.cwd(),
    ...(hostname === undefined ? {} : { hostname }),
    ...(port === undefined ? {} : { port }),
  });
  const payload = Object.freeze({
    schemaVersion: "1" as const,
    command: "pcboo dev" as const,
    protocol: "http" as const,
    url: server.url.href,
    hostname: server.hostname,
    port: server.port,
    warnings: server.warnings,
    limits: server.limits,
  });
  const stdout = json
    ? `${JSON.stringify(payload, null, 2)}\n`
    : [
        `PCBoo inspection: ${server.url.href}`,
        ...server.warnings.map(({ code, message }) => `${code}: ${message}`),
        "Fixed inspection and derived-action routes; authored source is never edited. Press Ctrl-C to stop.",
        "",
      ].join("\n");
  return Object.freeze({ server, stdout, json });
}

export async function waitForDevShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
