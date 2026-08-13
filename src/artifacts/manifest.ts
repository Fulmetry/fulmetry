// SPDX-FileCopyrightText: 2026 PCBoo contributors
// SPDX-License-Identifier: MIT
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"
import {
  captureBoundedRegularFileHash,
  revalidateCapturedRegularFile,
  type BoundedFileIdentity,
} from "../internal/bounded-file"

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const
export const ARTIFACT_MANIFEST_ENTRY_LIMIT = 128
export const ARTIFACT_MANIFEST_PATH_DEPTH_LIMIT = 8
export const ARTIFACT_MANIFEST_PATH_LENGTH_LIMIT = 4_096
export const ARTIFACT_MANIFEST_KIND_LENGTH_LIMIT = 256
export const ARTIFACT_MANIFEST_FILE_BYTES_LIMIT = 64 * 1024 * 1024
export const ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT = 256 * 1024 * 1024

export type ArtifactLifecycle = "draft" | "verified"

export interface ArtifactEntry {
  kind?: string
  path: string
  sha256: string
  size: number
}

export interface ArtifactManifestProvenance {
  generatedAt: string
  sourceControl:
    | { state: "recorded"; revision: string; dirty: boolean }
    | { state: "not-assessed"; reason: string }
  inputDigests: {
    project: string
    source: string
    config: string
    lockfile: string
  }
  tools: Readonly<Record<string, Readonly<Record<string, string>>>>
  adapters: Readonly<Record<string, Readonly<Record<string, string>>>>
  validation: Readonly<Record<string, string>>
  knownLimitations: readonly string[]
  externalCapabilities: readonly Readonly<Record<string, string>>[]
  activeProfiles: readonly Readonly<Record<string, string>>[]
  waivers: readonly Readonly<Record<string, string>>[]
  verificationResults: Readonly<Record<string, string>>
}

export interface ArtifactManifest {
  schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION
  lifecycle: ArtifactLifecycle
  boardRevision?: string
  provenance?: ArtifactManifestProvenance
  artifacts: ArtifactEntry[]
}

export interface CreateDraftArtifactManifestInput {
  root: string
  boardRevision?: string
  artifactPaths: string[]
  artifactKinds?: Readonly<Record<string, string>>
  provenance?: ArtifactManifestProvenance
  /** @internal Deterministic resource and mutation hooks for adversarial tests. */
  testHooks?: ArtifactManifestTestHooks
}

export interface ArtifactManifestTestHooks {
  readonly afterPreflight?: () => void | Promise<void>
  readonly beforeCapture?: (path: string, index: number) => void | Promise<void>
  readonly afterCapture?: (path: string, index: number) => void | Promise<void>
}

export type ArtifactIntegrityFindingCode =
  | "MANIFEST_INVALID"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_PATH_ESCAPE"
  | "ARTIFACT_IDENTITY_INVALID"
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "ARTIFACT_SIZE_MISMATCH"
  | "ARTIFACT_DIGEST_MISMATCH"

export interface ArtifactIntegrityFinding {
  code: ArtifactIntegrityFindingCode
  path?: string
  message: string
  expected?: string | number
  actual?: string | number
}

export interface ArtifactManifestVerification {
  /** Byte integrity only. This is never manufacturing or production validity. */
  integrityValid: boolean
  lifecycle: ArtifactLifecycle
  findings: ArtifactIntegrityFinding[]
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

function normalizeArtifactPath(path: string): string {
  return path.replaceAll("\\", "/")
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function assertDigest(name: string, digest: string): void {
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`)
  }
}

function assertArtifactPath(path: string): void {
  if (!path || isAbsolute(path)) {
    throw new Error(`Artifact path must be a non-empty relative path: ${path}`)
  }

  const normalized = normalizeArtifactPath(path)
  if (normalized.length > ARTIFACT_MANIFEST_PATH_LENGTH_LIMIT) {
    throw new Error(
      `Artifact path exceeds ${ARTIFACT_MANIFEST_PATH_LENGTH_LIMIT} characters`,
    )
  }
  if (normalized.split("/").length > ARTIFACT_MANIFEST_PATH_DEPTH_LIMIT) {
    throw new Error(
      `Artifact path exceeds ${ARTIFACT_MANIFEST_PATH_DEPTH_LIMIT} segments: ${path}`,
    )
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`Artifact path escapes the output root: ${path}`)
  }
}

function assertManifest(manifest: ArtifactManifest): void {
  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported artifact manifest schema: ${manifest.schemaVersion}`)
  }

  if (manifest.lifecycle !== "draft" && manifest.lifecycle !== "verified") {
    throw new Error(`Unsupported artifact lifecycle: ${String(manifest.lifecycle)}`)
  }

  if (manifest.lifecycle === "verified" && !manifest.boardRevision?.trim()) {
    throw new Error("A verified artifact manifest requires a board revision")
  }

  if (manifest.artifacts.length === 0) {
    throw new Error("An artifact manifest must contain at least one artifact")
  }
  if (manifest.artifacts.length > ARTIFACT_MANIFEST_ENTRY_LIMIT) {
    throw new Error(
      `Artifact manifest exceeds ${ARTIFACT_MANIFEST_ENTRY_LIMIT} entries`,
    )
  }

  const paths = new Set<string>()
  let totalBytes = 0
  for (const artifact of manifest.artifacts) {
    assertArtifactPath(artifact.path)
    assertDigest(`Artifact ${artifact.path}`, artifact.sha256)

    if (artifact.kind !== undefined) {
      if (!artifact.kind.trim()) {
        throw new Error(`Artifact ${artifact.path} has an empty kind`)
      }
      if (artifact.kind.length > ARTIFACT_MANIFEST_KIND_LENGTH_LIMIT) {
        throw new Error(
          `Artifact ${artifact.path} kind exceeds ${ARTIFACT_MANIFEST_KIND_LENGTH_LIMIT} characters`,
        )
      }
    }

    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      throw new Error(`Artifact ${artifact.path} has an invalid size`)
    }
    if (artifact.size > ARTIFACT_MANIFEST_FILE_BYTES_LIMIT) {
      throw new Error(
        `Artifact ${artifact.path} exceeds ${ARTIFACT_MANIFEST_FILE_BYTES_LIMIT} bytes`,
      )
    }
    totalBytes += artifact.size
    if (totalBytes > ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT) {
      throw new Error(
        `Artifact manifest exceeds ${ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT} aggregate bytes`,
      )
    }

    const normalized = normalizeArtifactPath(artifact.path)
    if (paths.has(normalized)) {
      throw new Error(`Artifact path is duplicated: ${normalized}`)
    }
    paths.add(normalized)
  }
}

async function resolveContainedArtifact(root: string, path: string): Promise<string> {
  assertArtifactPath(path)

  const resolvedRoot = resolve(root)
  const normalizedPath = normalizeArtifactPath(path)
  const candidate = resolve(resolvedRoot, ...normalizedPath.split("/"))
  if (!isInside(resolvedRoot, candidate)) {
    throw new Error(`Artifact path escapes the output root: ${path}`)
  }

  const declared = await lstat(candidate)
  if (declared.isSymbolicLink()) {
    throw new Error(`Artifact path is a symlink: ${path}`)
  }

  const [realRoot, realCandidate] = await Promise.all([
    realpath(resolvedRoot),
    realpath(candidate),
  ])

  if (!isInside(realRoot, realCandidate)) {
    throw new Error(`Artifact path escapes the output root through a symlink: ${path}`)
  }

  return realCandidate
}

export async function createDraftArtifactManifest(
  input: CreateDraftArtifactManifestInput,
): Promise<ArtifactManifest> {
  if (input.artifactPaths.length === 0) {
    throw new Error("An artifact manifest must contain at least one artifact")
  }
  if (input.artifactPaths.length > ARTIFACT_MANIFEST_ENTRY_LIMIT) {
    throw new Error(
      `Artifact manifest exceeds ${ARTIFACT_MANIFEST_ENTRY_LIMIT} entries`,
    )
  }
  const uniquePaths = new Set(input.artifactPaths.map(normalizeArtifactPath))
  if (uniquePaths.size !== input.artifactPaths.length) {
    throw new Error("Artifact paths must be unique")
  }

  const realPaths = new Set<string>()
  const preflight: Array<{ path: string; absolutePath: string; size: number }> = []
  let totalBytes = 0
  for (const path of [...uniquePaths].sort()) {
    assertArtifactPath(path)
    const absolutePath = await resolveContainedArtifact(input.root, path)
    if (realPaths.has(absolutePath)) {
      throw new Error("Multiple artifact paths resolve to the same file")
    }
    const metadata = await lstat(absolutePath)
    if (!metadata.isFile()) throw new Error(`Artifact is not a regular file: ${path}`)
    if (metadata.size > ARTIFACT_MANIFEST_FILE_BYTES_LIMIT) {
      throw new Error(
        `Artifact ${path} exceeds ${ARTIFACT_MANIFEST_FILE_BYTES_LIMIT} bytes`,
      )
    }
    totalBytes += metadata.size
    if (totalBytes > ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT) {
      throw new Error(
        `Artifact manifest exceeds ${ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT} aggregate bytes`,
      )
    }
    realPaths.add(absolutePath)
    preflight.push({ path, absolutePath, size: metadata.size })
  }

  const artifacts: ArtifactEntry[] = []
  const capturedIdentities: Array<{
    path: string
    absolutePath: string
    identity: BoundedFileIdentity
  }> = []
  let capturedTotalBytes = 0
  await input.testHooks?.afterPreflight?.()
  for (const [index, { path, absolutePath }] of preflight.entries()) {
    await input.testHooks?.beforeCapture?.(path, index)
    const remainingBytes = ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT - capturedTotalBytes
    const captured = await captureBoundedRegularFileHash(
      absolutePath,
      Math.min(ARTIFACT_MANIFEST_FILE_BYTES_LIMIT, Math.max(1, remainingBytes)),
    )
    capturedTotalBytes += captured.size
    if (capturedTotalBytes > ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT) {
      throw new Error(
        `Artifact manifest exceeds ${ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT} aggregate bytes`,
      )
    }
    artifacts.push({
      ...(input.artifactKinds?.[path] === undefined
        ? {}
        : { kind: input.artifactKinds[path] }),
      path,
      sha256: captured.sha256,
      size: captured.size,
    })
    capturedIdentities.push({ path, absolutePath, identity: captured.identity })
    await input.testHooks?.afterCapture?.(path, index)
  }
  for (const captured of capturedIdentities) {
    const finalAbsolutePath = await resolveContainedArtifact(input.root, captured.path)
    if (finalAbsolutePath !== captured.absolutePath) {
      throw new Error(
        `Artifact identity changed while creating the manifest: ${captured.path}`,
      )
    }
    await revalidateCapturedRegularFile(captured.absolutePath, captured.identity)
  }

  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    lifecycle: "draft",
    ...(input.boardRevision ? { boardRevision: input.boardRevision } : {}),
    ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    artifacts,
  }

  assertManifest(manifest)
  return manifest
}

export async function verifyArtifactManifest(
  root: string,
  manifest: ArtifactManifest,
  testHooks?: ArtifactManifestTestHooks,
): Promise<ArtifactManifestVerification> {
  const findings: ArtifactIntegrityFinding[] = []

  try {
    assertManifest(manifest)
  } catch (error) {
    findings.push({
      code: "MANIFEST_INVALID",
      message: error instanceof Error ? error.message : String(error),
    })
    return { integrityValid: false, lifecycle: manifest.lifecycle, findings }
  }

  const preflight: Array<{ artifact: ArtifactEntry; absolutePath: string; size: number }> = []
  const realPaths = new Set<string>()
  let actualTotalBytes = 0
  for (const artifact of manifest.artifacts) {
    let absolutePath: string
    try {
      absolutePath = await resolveContainedArtifact(root, artifact.path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      findings.push({
        code: message.includes("escape")
          ? "ARTIFACT_PATH_ESCAPE"
          : message.includes("symlink")
            ? "ARTIFACT_IDENTITY_INVALID"
            : "ARTIFACT_MISSING",
        path: artifact.path,
        message,
      })
      continue
    }
    if (realPaths.has(absolutePath)) {
      findings.push({
        code: "ARTIFACT_IDENTITY_INVALID",
        path: artifact.path,
        message: `Multiple artifact paths resolve to the same file: ${artifact.path}`,
      })
      return { integrityValid: false, lifecycle: manifest.lifecycle, findings }
    }
    realPaths.add(absolutePath)

    let metadata: Awaited<ReturnType<typeof lstat>>
    try {
      metadata = await lstat(absolutePath)
      if (!metadata.isFile()) throw new Error("artifact is not a regular file")
    } catch (error) {
      findings.push({
        code: "ARTIFACT_MISSING",
        path: artifact.path,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (metadata.size > ARTIFACT_MANIFEST_FILE_BYTES_LIMIT) {
      findings.push({
        code: "ARTIFACT_LIMIT_EXCEEDED",
        path: artifact.path,
        message: `Artifact ${artifact.path} exceeds ${ARTIFACT_MANIFEST_FILE_BYTES_LIMIT} bytes`,
      })
      continue
    }
    actualTotalBytes += metadata.size
    if (actualTotalBytes > ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT) {
      findings.push({
        code: "ARTIFACT_LIMIT_EXCEEDED",
        path: artifact.path,
        message: `Artifacts exceed ${ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT} aggregate bytes`,
      })
      return { integrityValid: false, lifecycle: manifest.lifecycle, findings }
    }
    preflight.push({ artifact, absolutePath, size: metadata.size })
  }

  await testHooks?.afterPreflight?.()
  let verifiedBytes = 0
  const capturedIdentities: Array<{
    artifact: ArtifactEntry
    absolutePath: string
    identity: BoundedFileIdentity
  }> = []
  for (const [index, { artifact, absolutePath }] of preflight.entries()) {
    await testHooks?.beforeCapture?.(artifact.path, index)
    let actual: { sha256: string; size: number }
    try {
      const remainingBytes = ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT - verifiedBytes
      actual = await captureBoundedRegularFileHash(
        absolutePath,
        Math.min(ARTIFACT_MANIFEST_FILE_BYTES_LIMIT, Math.max(1, remainingBytes)),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      findings.push({
        code: message.includes("exceeds ")
          ? "ARTIFACT_LIMIT_EXCEEDED"
          : message.includes("changed")
            ? "ARTIFACT_IDENTITY_INVALID"
            : "ARTIFACT_MISSING",
        path: artifact.path,
        message,
      })
      continue
    }
    verifiedBytes += actual.size
    if (verifiedBytes > ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT) {
      findings.push({
        code: "ARTIFACT_LIMIT_EXCEEDED",
        path: artifact.path,
        message: `Artifacts exceed ${ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT} aggregate bytes`,
      })
      continue
    }
    if (actual.size !== artifact.size) {
      findings.push({
        code: "ARTIFACT_SIZE_MISMATCH",
        path: artifact.path,
        message: `Artifact size changed for ${artifact.path}`,
        expected: artifact.size,
        actual: actual.size,
      })
    }

    if (actual.sha256 !== artifact.sha256) {
      findings.push({
        code: "ARTIFACT_DIGEST_MISMATCH",
        path: artifact.path,
        message: `Artifact digest changed for ${artifact.path}`,
        expected: artifact.sha256,
        actual: actual.sha256,
      })
    }
    capturedIdentities.push({
      artifact,
      absolutePath,
      identity: (actual as Awaited<ReturnType<typeof captureBoundedRegularFileHash>>).identity,
    })
    await testHooks?.afterCapture?.(artifact.path, index)
  }

  for (const captured of capturedIdentities) {
    try {
      const finalAbsolutePath = await resolveContainedArtifact(root, captured.artifact.path)
      if (finalAbsolutePath !== captured.absolutePath) {
        throw new Error("artifact path resolves to a different file")
      }
      await revalidateCapturedRegularFile(captured.absolutePath, captured.identity)
    } catch (error) {
      findings.push({
        code: "ARTIFACT_IDENTITY_INVALID",
        path: captured.artifact.path,
        message: `Artifact identity changed while verifying ${captured.artifact.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  }

  return {
    integrityValid: findings.length === 0,
    lifecycle: manifest.lifecycle,
    findings,
  }
}
