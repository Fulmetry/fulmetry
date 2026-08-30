// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { mock } from "bun:test";

const configuredLogPath = process.env.FULMETRY_NETWORK_OBSERVER_LOG;
if (configuredLogPath === undefined || configuredLogPath.length === 0) {
  throw new Error("FULMETRY_NETWORK_OBSERVER_LOG is required by the network observer preload");
}
const logPath: string = configuredLogPath;
const readyLogPath = process.env.FULMETRY_NETWORK_OBSERVER_READY_LOG;
if (readyLogPath !== undefined && readyLogPath.length > 0) {
  appendFileSync(readyLogPath, `${JSON.stringify({ pid: process.pid, ppid: process.ppid })}\n`, {
    encoding: "utf8",
  });
}

function boundedTarget(values: readonly unknown[]): string {
  try {
    return JSON.stringify(values, (_key, value) =>
      typeof value === "string" && value.length > 512 ? `${value.slice(0, 512)}…` : value
    ).slice(0, 2_048);
  } catch {
    return "[unserializable]";
  }
}

function block(kind: string, values: readonly unknown[]): never {
  appendFileSync(logPath, `${JSON.stringify({ kind, target: boundedTarget(values) })}\n`, {
    encoding: "utf8",
  });
  throw new Error(`FULMETRY_NETWORK_EGRESS_OBSERVED: ${kind}`);
}

const blocked = (kind: string) => (...values: unknown[]): never => block(kind, values);

globalThis.fetch = blocked("fetch") as unknown as typeof globalThis.fetch;

const bunRuntime = Bun as typeof Bun & {
  connect: (...values: unknown[]) => unknown;
  udpSocket?: (...values: unknown[]) => unknown;
};
const observerPreloadPath = fileURLToPath(import.meta.url);
const originalSpawn = Bun.spawn.bind(Bun) as (...values: unknown[]) => unknown;
const originalSpawnSync = Bun.spawnSync.bind(Bun) as (...values: unknown[]) => unknown;

function observedChildCommand(command: unknown): unknown {
  if (!Array.isArray(command) || command.length === 0 || command[0] !== process.execPath) {
    return command;
  }
  if (command.some((value, index) => value === observerPreloadPath && command[index - 1] === "--preload")) {
    return command;
  }
  return [command[0], "--preload", observerPreloadPath, ...command.slice(1)];
}

function observedChildOptions(options: unknown): unknown {
  if (options === null || typeof options !== "object" || Array.isArray(options)) return options;
  const record = options as Record<string, unknown>;
  const suppliedEnvironment = record.env;
  const environment = suppliedEnvironment !== null && typeof suppliedEnvironment === "object" &&
      !Array.isArray(suppliedEnvironment)
    ? suppliedEnvironment as Record<string, unknown>
    : process.env;
  return {
    ...record,
    env: {
      ...environment,
      FULMETRY_NETWORK_OBSERVER_LOG: logPath,
      ...(readyLogPath === undefined || readyLogPath.length === 0
        ? {}
        : { FULMETRY_NETWORK_OBSERVER_READY_LOG: readyLogPath }),
    },
  };
}

function observedSpawn(original: (...values: unknown[]) => unknown, values: readonly unknown[]): unknown {
  const [first, second, ...rest] = values;
  if (Array.isArray(first)) {
    return original(observedChildCommand(first), observedChildOptions(second), ...rest);
  }
  if (first !== null && typeof first === "object") {
    const options = first as Record<string, unknown>;
    return original(observedChildOptions({ ...options, cmd: observedChildCommand(options.cmd) }));
  }
  return original(...values);
}

(bunRuntime as unknown as Record<string, unknown>).spawn = (...values: unknown[]) =>
  observedSpawn(originalSpawn, values);
(bunRuntime as unknown as Record<string, unknown>).spawnSync = (...values: unknown[]) =>
  observedSpawn(originalSpawnSync, values);
bunRuntime.connect = blocked("Bun.connect");
if (typeof bunRuntime.udpSocket === "function") {
  bunRuntime.udpSocket = blocked("Bun.udpSocket");
}

for (const [object, names, prefix] of [
  [net, ["connect", "createConnection"], "net"],
  [tls, ["connect"], "tls"],
  [http, ["request", "get"], "http"],
  [https, ["request", "get"], "https"],
  [http2, ["connect"], "http2"],
  [dns, [
    "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny",
    "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs",
    "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
  ], "dns"],
] as const) {
  const mutable = object as unknown as Record<string, unknown>;
  for (const name of names) {
    if (typeof mutable[name] === "function") mutable[name] = blocked(`${prefix}.${name}`);
  }
}

const dnsPromises = dns.promises as unknown as Record<string, unknown>;
for (const name of Object.keys(dnsPromises)) {
  if (typeof dnsPromises[name] === "function") dnsPromises[name] = blocked(`dns.promises.${name}`);
}

(dgram as unknown as Record<string, unknown>).createSocket = blocked("dgram.createSocket");

if (typeof globalThis.WebSocket === "function") {
  globalThis.WebSocket = class BlockedWebSocket {
    constructor(...values: unknown[]) {
      block("WebSocket", values);
    }
  } as unknown as typeof globalThis.WebSocket;
}

if (typeof globalThis.EventSource === "function") {
  globalThis.EventSource = class BlockedEventSource {
    constructor(...values: unknown[]) {
      block("EventSource", values);
    }
  } as unknown as typeof globalThis.EventSource;
}

syncBuiltinESMExports();

function observeNamedBuiltin(name: string, value: Record<string, unknown>): void {
  mock.module(name, () => ({ ...value, default: value }));
}

for (const [name, value] of [
  ["node:net", net], ["net", net],
  ["node:tls", tls], ["tls", tls],
  ["node:http", http], ["http", http],
  ["node:https", https], ["https", https],
  ["node:http2", http2], ["http2", http2],
  ["node:dns", dns], ["dns", dns],
  ["node:dgram", dgram], ["dgram", dgram],
] as const) {
  observeNamedBuiltin(name, value as unknown as Record<string, unknown>);
}
