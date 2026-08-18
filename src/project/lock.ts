// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { MANUFACTURING_ADAPTER_VERSIONS } from "../manufacturing/export";
import { parseJsonWithoutDuplicateKeys } from "../upgrade/jsonc";

export const PCBOO_LOCK_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_TSCIRCUIT_VERSION = "0.0.2261" as const;
export const SUPPORTED_TSCIRCUIT_INTEGRITY =
  "sha512-pwJzfkh5UFE7lFRaKQE5tUDdMd7A1bl+NhX2dG+BY2EEfvaMFVQDJJc+BcT/zM6BvkMepxZCNOCAJFzqhxiEUw==" as const;

export interface RecordedSourcingPolicyLock {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly maxAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
  readonly minimumStock: number;
}

export interface RecordedSourcingSelectionLock {
  readonly sourceComponentId: string;
  readonly manufacturer: { readonly name: string; readonly partNumber: string };
  readonly supplier: { readonly name: string; readonly partNumber: string };
  readonly package: string;
  readonly footprint: string;
  readonly snapshot: {
    readonly schemaVersion: 1;
    readonly source: string;
    readonly retrievedAt: string;
    readonly lifecycle: "active" | "nrnd" | "obsolete" | "unknown";
    readonly stock: number | null;
    readonly price: {
      readonly currency: string;
      readonly unitPrice: number;
      readonly quantity: number;
    } | null;
  };
  readonly contentSha256: string;
}

export interface RecordedSourcingLock {
  readonly schemaVersion: 1;
  readonly policy: RecordedSourcingPolicyLock | null;
  readonly selections: Readonly<Record<string, RecordedSourcingSelectionLock>>;
}

export interface PcbooLock {
  readonly schemaVersion: typeof PCBOO_LOCK_SCHEMA_VERSION;
  readonly tscircuit: {
    readonly version: typeof SUPPORTED_TSCIRCUIT_VERSION;
    readonly integrity: string;
  };
  readonly adapters: typeof MANUFACTURING_ADAPTER_VERSIONS;
  readonly profiles: Readonly<Record<string, { readonly version: string; readonly digest: string }>>;
  readonly assets: Readonly<Record<string, LockedAsset>>;
  readonly sourcing: RecordedSourcingLock;
}

export interface LockedAsset {
  readonly source: string;
  readonly version: string;
  readonly digest: string;
  readonly license: string;
  readonly attribution: string;
  readonly licenseNotice: string;
  readonly licenseNoticeDigest: string;
  readonly redistribution: "allowed" | "prohibited" | "unknown";
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${context} fields must be exactly: ${expected.join(", ")}`);
  }
}

function nonEmpty(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function safeAscii(value: unknown, context: string): string {
  const text = nonEmpty(value, context);
  if (!/^[\x21-\x7e](?:[\x20-\x7e]{0,253}[\x21-\x7e])?$/.test(text)) {
    throw new TypeError(`${context} must contain 1-255 printable ASCII characters without surrounding whitespace`);
  }
  return text;
}

function safeToken(value: unknown, context: string, lowerCase = false): string {
  const text = safeAscii(value, context);
  const pattern = lowerCase
    ? /^[a-z0-9][a-z0-9._-]{0,63}$/
    : /^[A-Za-z0-9][A-Za-z0-9._:+/#@()-]{0,127}$/;
  if (!pattern.test(text)) {
    throw new TypeError(`${context} must be a conservative ${lowerCase ? "lowercase " : ""}ASCII identifier`);
  }
  return text;
}

function parseNamedRecords(
  value: unknown,
  fields: readonly string[],
  context: string,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(
      ([name, item]) => {
        nonEmpty(name, `${context} name`);
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new TypeError(`${context}.${name} must be an object`);
        }
        const record = item as Record<string, unknown>;
        exactKeys(record, fields, `${context}.${name}`);
        return [name, Object.freeze(Object.fromEntries(
          fields.map((field) => [field, nonEmpty(record[field], `${context}.${name}.${field}`)]),
        ))];
      },
    ),
  ));
}

function parseAssets(value: unknown): PcbooLock["assets"] {
  const parsed = parseNamedRecords(
    value,
    [
      "source", "version", "digest", "license", "attribution",
      "licenseNotice", "licenseNoticeDigest", "redistribution",
    ],
    "pcboo.lock.assets",
  );
  return Object.freeze(Object.fromEntries(Object.entries(parsed).map(([name, asset]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
      throw new TypeError(`pcboo.lock.assets name ${JSON.stringify(name)} is not a bounded safe identifier`);
    }
    const source = asset.source!;
    const version = asset.version!;
    const digest = asset.digest!;
    const license = asset.license!;
    const attribution = asset.attribution!;
    const licenseNotice = asset.licenseNotice!;
    const licenseNoticeDigest = asset.licenseNoticeDigest!;
    const redistribution = asset.redistribution!;
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
      throw new TypeError(`pcboo.lock.assets.${name}.digest must be a lowercase sha256 digest`);
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(licenseNoticeDigest)) {
      throw new TypeError(`pcboo.lock.assets.${name}.licenseNoticeDigest must be a lowercase sha256 digest`);
    }
    if (
      redistribution !== "allowed" &&
      redistribution !== "prohibited" &&
      redistribution !== "unknown"
    ) {
      throw new TypeError(`pcboo.lock.assets.${name}.redistribution is invalid`);
    }
    return [name, Object.freeze({
      source: safeAscii(source, `pcboo.lock.assets.${name}.source`),
      version: safeAscii(version, `pcboo.lock.assets.${name}.version`),
      digest,
      license: safeAscii(license, `pcboo.lock.assets.${name}.license`),
      attribution: safeAscii(attribution, `pcboo.lock.assets.${name}.attribution`),
      licenseNotice: safeAscii(licenseNotice, `pcboo.lock.assets.${name}.licenseNotice`),
      licenseNoticeDigest,
      redistribution,
    })];
  })));
}

function safeInteger(value: unknown, context: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${context} must be a non-negative safe integer no greater than ${maximum}`);
  }
  return value as number;
}

function finiteNonNegative(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${context} must be a non-negative finite number`);
  }
  return value;
}

function parseIdentity(value: unknown, context: string, supplier = false) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ["name", "partNumber"], context);
  return Object.freeze({
    name: supplier
      ? safeToken(record.name, `${context}.name`, true)
      : safeAscii(record.name, `${context}.name`),
    partNumber: safeToken(record.partNumber, `${context}.partNumber`),
  });
}

function parseSourcing(value: unknown): RecordedSourcingLock {
  if (value === undefined) {
    return Object.freeze({ schemaVersion: 1, policy: null, selections: Object.freeze({}) });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pcboo.lock.sourcing must be an object");
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ["schemaVersion", "policy", "selections"], "pcboo.lock.sourcing");
  if (record.schemaVersion !== 1) throw new TypeError("Unsupported pcboo.lock.sourcing schema");
  let policy: RecordedSourcingPolicyLock | null = null;
  if (record.policy !== null) {
    if (typeof record.policy !== "object" || Array.isArray(record.policy)) {
      throw new TypeError("pcboo.lock.sourcing.policy must be null or an object");
    }
    const item = record.policy as Record<string, unknown>;
    exactKeys(
      item,
      ["name", "version", "digest", "maxAgeSeconds", "maxFutureSkewSeconds", "minimumStock"],
      "pcboo.lock.sourcing.policy",
    );
    const digest = nonEmpty(item.digest, "pcboo.lock.sourcing.policy.digest");
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new TypeError("pcboo.lock.sourcing.policy.digest must be a sha256: lowercase digest");
    }
    policy = Object.freeze({
      name: safeToken(item.name, "pcboo.lock.sourcing.policy.name", true),
      version: safeToken(item.version, "pcboo.lock.sourcing.policy.version"),
      digest,
      maxAgeSeconds: safeInteger(item.maxAgeSeconds, "pcboo.lock.sourcing.policy.maxAgeSeconds", 31_536_000),
      maxFutureSkewSeconds: safeInteger(item.maxFutureSkewSeconds, "pcboo.lock.sourcing.policy.maxFutureSkewSeconds", 3_600),
      minimumStock: safeInteger(item.minimumStock, "pcboo.lock.sourcing.policy.minimumStock"),
    });
  }
  if (record.selections === null || typeof record.selections !== "object" || Array.isArray(record.selections)) {
    throw new TypeError("pcboo.lock.sourcing.selections must be an object");
  }
  const selections = Object.freeze(Object.fromEntries(
    Object.entries(record.selections as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([designator, value]) => {
        safeToken(designator, "pcboo.lock.sourcing selection designator");
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError(`pcboo.lock.sourcing.selections.${designator} must be an object`);
        }
        const item = value as Record<string, unknown>;
        exactKeys(
          item,
          ["sourceComponentId", "manufacturer", "supplier", "package", "footprint", "snapshot", "contentSha256"],
          `pcboo.lock.sourcing.selections.${designator}`,
        );
        if (typeof item.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.contentSha256)) {
          throw new TypeError(`pcboo.lock.sourcing.selections.${designator}.contentSha256 must be a lowercase SHA-256 digest`);
        }
        if (item.snapshot === null || typeof item.snapshot !== "object" || Array.isArray(item.snapshot)) {
          throw new TypeError(`pcboo.lock.sourcing.selections.${designator}.snapshot must be an object`);
        }
        const snapshot = item.snapshot as Record<string, unknown>;
        exactKeys(
          snapshot,
          ["schemaVersion", "source", "retrievedAt", "lifecycle", "stock", "price"],
          `pcboo.lock.sourcing.selections.${designator}.snapshot`,
        );
        if (snapshot.schemaVersion !== 1) {
          throw new TypeError(`Unsupported sourcing snapshot schema for ${designator}`);
        }
        if (!["active", "nrnd", "obsolete", "unknown"].includes(snapshot.lifecycle as string)) {
          throw new TypeError(`Invalid sourcing lifecycle for ${designator}`);
        }
        const stock = snapshot.stock === null
          ? null
          : safeInteger(snapshot.stock, `pcboo.lock.sourcing.selections.${designator}.snapshot.stock`);
        let price: RecordedSourcingSelectionLock["snapshot"]["price"] = null;
        if (snapshot.price !== null) {
          if (typeof snapshot.price !== "object" || Array.isArray(snapshot.price)) {
            throw new TypeError(`Sourcing price for ${designator} must be null or an object`);
          }
          const priceRecord = snapshot.price as Record<string, unknown>;
          exactKeys(priceRecord, ["currency", "unitPrice", "quantity"], `sourcing price for ${designator}`);
          price = Object.freeze({
            currency: safeAscii(priceRecord.currency, `sourcing price currency for ${designator}`),
            unitPrice: finiteNonNegative(priceRecord.unitPrice, `sourcing unit price for ${designator}`),
            quantity: safeInteger(priceRecord.quantity, `sourcing price quantity for ${designator}`),
          });
          if (!/^[A-Z]{3}$/.test(price.currency) || price.quantity <= 0) {
            throw new TypeError(`Sourcing price for ${designator} requires an ISO-style uppercase currency and positive quantity`);
          }
        }
        return [designator, Object.freeze({
          sourceComponentId: safeToken(item.sourceComponentId, `sourcing sourceComponentId for ${designator}`),
          manufacturer: parseIdentity(item.manufacturer, `sourcing manufacturer for ${designator}`),
          supplier: parseIdentity(item.supplier, `sourcing supplier for ${designator}`, true),
          package: safeAscii(item.package, `sourcing package for ${designator}`),
          footprint: safeAscii(item.footprint, `sourcing footprint for ${designator}`),
          snapshot: Object.freeze({
            schemaVersion: 1 as const,
            source: safeAscii(snapshot.source, `sourcing source for ${designator}`),
            retrievedAt: safeAscii(snapshot.retrievedAt, `sourcing retrieval time for ${designator}`),
            lifecycle: snapshot.lifecycle as RecordedSourcingSelectionLock["snapshot"]["lifecycle"],
            stock,
            price,
          }),
          contentSha256: item.contentSha256,
        })];
      }),
  ));
  if (policy === null && Object.keys(selections).length > 0) {
    throw new TypeError("pcboo.lock.sourcing selections require a locked policy");
  }
  return Object.freeze({ schemaVersion: 1, policy, selections });
}

export function parsePcbooLock(text: string): Readonly<PcbooLock> {
  let value: unknown;
  try {
    value = parseJsonWithoutDuplicateKeys(text, "pcboo.lock");
  } catch (error) {
    throw new TypeError(`pcboo.lock is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pcboo.lock must contain an object");
  }
  const lock = value as Record<string, unknown>;
  const allowedKeys = ["schemaVersion", "tscircuit", "adapters", "profiles", "assets", "sourcing"];
  const actualKeys = Object.keys(lock);
  if (
    actualKeys.some((key) => !allowedKeys.includes(key)) ||
    ["schemaVersion", "tscircuit", "adapters", "profiles", "assets"].some((key) => !(key in lock))
  ) {
    throw new TypeError(`pcboo.lock fields must be exactly the required v1 fields plus optional sourcing`);
  }
  if (lock.schemaVersion !== PCBOO_LOCK_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported pcboo.lock schema ${String(lock.schemaVersion)}`);
  }
  if (lock.tscircuit === null || typeof lock.tscircuit !== "object" || Array.isArray(lock.tscircuit)) {
    throw new TypeError("pcboo.lock.tscircuit must be an object");
  }
  const tscircuit = lock.tscircuit as Record<string, unknown>;
  exactKeys(tscircuit, ["version", "integrity"], "pcboo.lock.tscircuit");
  if (tscircuit.version !== SUPPORTED_TSCIRCUIT_VERSION) {
    throw new TypeError(
      `PCBoo supports tscircuit ${SUPPORTED_TSCIRCUIT_VERSION}; lockfile requests ${String(tscircuit.version)}`,
    );
  }
  if (tscircuit.integrity !== SUPPORTED_TSCIRCUIT_INTEGRITY) {
    throw new TypeError("pcboo.lock tscircuit integrity does not match the supported package");
  }
  if (lock.adapters === null || typeof lock.adapters !== "object" || Array.isArray(lock.adapters)) {
    throw new TypeError("pcboo.lock.adapters must be an object");
  }
  const adapters = lock.adapters as Record<string, unknown>;
  exactKeys(adapters, Object.keys(MANUFACTURING_ADAPTER_VERSIONS), "pcboo.lock.adapters");
  for (const [name, version] of Object.entries(MANUFACTURING_ADAPTER_VERSIONS)) {
    if (adapters[name] !== version) {
      throw new TypeError(`Adapter ${name} must be locked to ${version}`);
    }
  }
  return Object.freeze({
    schemaVersion: PCBOO_LOCK_SCHEMA_VERSION,
    tscircuit: Object.freeze({
      version: SUPPORTED_TSCIRCUIT_VERSION,
      integrity: SUPPORTED_TSCIRCUIT_INTEGRITY,
    }),
    adapters: MANUFACTURING_ADAPTER_VERSIONS,
    profiles: parseNamedRecords(lock.profiles, ["version", "digest"], "pcboo.lock.profiles") as PcbooLock["profiles"],
    assets: parseAssets(lock.assets),
    sourcing: parseSourcing(lock.sourcing),
  });
}

export async function loadPcbooLock(projectRoot: string): Promise<Readonly<PcbooLock>> {
  const root = await realpath(projectRoot);
  const path = resolve(root, "pcboo.lock");
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("pcboo.lock must be a regular file, not a symlink");
  }
  return parsePcbooLock(await readFile(path, "utf8"));
}
