// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

function requireBoundedRegularFileSize(size: number, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("file byte limit is invalid");
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error(`file exceeds ${limit} bytes`);
}

function sameFileIdentity(
  left: BoundedFileIdentity,
  right: BoundedFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export interface BoundedFileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

function fileIdentity(stat: BoundedFileIdentity): BoundedFileIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  })
}

export async function hashBoundedRegularFile(
  path: string,
  limit: number,
  afterOpen?: () => void | Promise<void>,
): Promise<string> {
  return (await captureBoundedRegularFileHash(path, limit, afterOpen)).sha256;
}

export async function captureBoundedRegularFileHash(
  path: string,
  limit: number,
  afterOpen?: () => void | Promise<void>,
): Promise<{ sha256: string; size: number; identity: BoundedFileIdentity }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("file is not regular");
    requireBoundedRegularFileSize(before.size, limit);
    await afterOpen?.();
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = new Uint8Array(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      requireBoundedRegularFileSize(total, limit);
      hasher.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      total !== before.size || !sameFileIdentity(before, after) || current.isSymbolicLink() ||
      !current.isFile() || current.dev !== after.dev || current.ino !== after.ino ||
      current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
    ) throw new Error("file changed while its identity was captured");
    return {
      sha256: hasher.digest("hex"),
      size: total,
      identity: fileIdentity(after),
    };
  } finally {
    await handle.close();
  }
}

export async function revalidateCapturedRegularFile(
  path: string,
  identity: BoundedFileIdentity,
): Promise<void> {
  const current = await lstat(path)
  if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(current, identity)) {
    throw new Error("file changed after its identity was captured")
  }
}

export async function readBoundedRegularFile(
  path: string,
  limit: number,
  afterOpen?: () => void | Promise<void>,
): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("file is not regular");
    requireBoundedRegularFileSize(before.size, limit);
    await afterOpen?.();
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    const extraRead = await handle.read(extra, 0, 1, null);
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      offset !== bytes.byteLength || extraRead.bytesRead !== 0 || !sameFileIdentity(before, after) ||
      current.isSymbolicLink() || !current.isFile() || current.dev !== after.dev ||
      current.ino !== after.ino || current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
    ) throw new Error("file changed while its bytes were captured");
    return bytes;
  } finally {
    await handle.close();
  }
}
