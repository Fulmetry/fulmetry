import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ARTIFACT_MANIFEST_ENTRY_LIMIT,
  ARTIFACT_MANIFEST_FILE_BYTES_LIMIT,
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT,
  createDraftArtifactManifest,
  verifyArtifactManifest,
  type ArtifactManifest,
} from "../src/artifacts/manifest"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pcboo-manifest-"))
  roots.push(root)
  return root
}

async function sparseFile(path: string, size: number): Promise<void> {
  await Bun.write(path, new Uint8Array())
  await truncate(path, size)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("bounded artifact manifests", () => {
  test("creates and verifies an ordinary manifest without retaining whole files", async () => {
    const root = await temporaryRoot()
    await Bun.write(join(root, "board.gbr"), "G04 PCBoo*\nM02*\n")

    const manifest = await createDraftArtifactManifest({
      root,
      artifactPaths: ["board.gbr"],
      artifactKinds: { "board.gbr": "gerber" },
    })

    expect(manifest.artifacts).toHaveLength(1)
    expect(manifest.artifacts[0]?.kind).toBe("gerber")
    expect((await verifyArtifactManifest(root, manifest)).integrityValid).toBe(true)
  })

  test("rejects an over-count draft before resolving or hashing any path", async () => {
    const root = await temporaryRoot()
    const artifactPaths = Array.from(
      { length: ARTIFACT_MANIFEST_ENTRY_LIMIT + 1 },
      (_, index) => `missing-${index}.gbr`,
    )

    await expect(createDraftArtifactManifest({ root, artifactPaths })).rejects.toThrow(
      `exceeds ${ARTIFACT_MANIFEST_ENTRY_LIMIT} entries`,
    )
  })

  test("rejects an oversized sparse draft artifact from metadata before reading it", async () => {
    const root = await temporaryRoot()
    await sparseFile(
      join(root, "oversized.gbr"),
      ARTIFACT_MANIFEST_FILE_BYTES_LIMIT + 1,
    )

    await expect(createDraftArtifactManifest({
      root,
      artifactPaths: ["oversized.gbr"],
    })).rejects.toThrow(`exceeds ${ARTIFACT_MANIFEST_FILE_BYTES_LIMIT} bytes`)
  })

  test("preflights aggregate actual bytes before hashing any artifact", async () => {
    const root = await temporaryRoot()
    const paths = ["a.gbr", "b.gbr", "c.gbr", "d.gbr", "e.gbr"]
    for (const path of paths.slice(0, 4)) {
      await sparseFile(join(root, path), ARTIFACT_MANIFEST_FILE_BYTES_LIMIT)
    }
    await sparseFile(join(root, paths[4]!), 1)

    const manifest: ArtifactManifest = {
      schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
      lifecycle: "draft",
      artifacts: paths.map((path) => ({ path, sha256: "0".repeat(64), size: 0 })),
    }
    const verification = await verifyArtifactManifest(root, manifest)

    expect(ARTIFACT_MANIFEST_FILE_BYTES_LIMIT * 4 + 1).toBeGreaterThan(
      ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT,
    )
    expect(verification.integrityValid).toBe(false)
    expect(verification.findings).toEqual([
      expect.objectContaining({ code: "ARTIFACT_LIMIT_EXCEEDED" }),
    ])
  })

  test("rejects declared aggregate bytes before touching artifact paths", async () => {
    const root = await temporaryRoot()
    const manifest: ArtifactManifest = {
      schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
      lifecycle: "draft",
      artifacts: Array.from({ length: 5 }, (_, index) => ({
        path: `missing-${index}.gbr`,
        sha256: "0".repeat(64),
        size: ARTIFACT_MANIFEST_FILE_BYTES_LIMIT,
      })),
    }

    const verification = await verifyArtifactManifest(root, manifest)
    expect(verification.integrityValid).toBe(false)
    expect(verification.findings).toEqual([
      expect.objectContaining({
        code: "MANIFEST_INVALID",
        message: expect.stringContaining(
          `exceeds ${ARTIFACT_MANIFEST_TOTAL_BYTES_LIMIT} aggregate bytes`,
        ),
      }),
    ])
  })

  test("enforces the aggregate budget again as files grow after preflight", async () => {
    const root = await temporaryRoot()
    const paths = ["a.gbr", "b.gbr", "c.gbr", "d.gbr", "e.gbr"]
    for (const path of paths) await Bun.write(join(root, path), "x")
    let completedCaptures = 0

    await expect(createDraftArtifactManifest({
      root,
      artifactPaths: paths,
      testHooks: {
        beforeCapture: (path) => truncate(
          join(root, path),
          ARTIFACT_MANIFEST_FILE_BYTES_LIMIT,
        ),
        afterCapture: () => { completedCaptures += 1 },
      },
    })).rejects.toThrow(/exceeds .* bytes|aggregate bytes/)
    expect(completedCaptures).toBe(4)
  })

  test("rejects a mixed-epoch creation when an earlier artifact changes", async () => {
    const root = await temporaryRoot()
    await Bun.write(join(root, "a.gbr"), "a")
    await Bun.write(join(root, "b.gbr"), "b")

    await expect(createDraftArtifactManifest({
      root,
      artifactPaths: ["a.gbr", "b.gbr"],
      testHooks: {
        afterCapture: async (path) => {
          if (path === "a.gbr") await Bun.write(join(root, path), "changed")
        },
      },
    })).rejects.toThrow("changed after its identity was captured")
  })

  test("rejects a mixed-epoch verification when an earlier artifact changes", async () => {
    const root = await temporaryRoot()
    await Bun.write(join(root, "a.gbr"), "a")
    await Bun.write(join(root, "b.gbr"), "b")
    const manifest = await createDraftArtifactManifest({
      root,
      artifactPaths: ["a.gbr", "b.gbr"],
    })

    const verification = await verifyArtifactManifest(root, manifest, {
      afterCapture: async (path) => {
        if (path === "a.gbr") await Bun.write(join(root, path), "changed")
      },
    })
    expect(verification.integrityValid).toBe(false)
    expect(verification.findings).toContainEqual(expect.objectContaining({
      code: "ARTIFACT_IDENTITY_INVALID",
      path: "a.gbr",
    }))
  })

  test("rejects a symlink alias instead of counting one physical file twice", async () => {
    const root = await temporaryRoot()
    await Bun.write(join(root, "board.gbr"), "board")
    const original = await createDraftArtifactManifest({
      root,
      artifactPaths: ["board.gbr"],
    })
    await symlink("board.gbr", join(root, "alias.gbr"))
    const entry = original.artifacts[0]!
    const forged: ArtifactManifest = {
      ...original,
      artifacts: [entry, { ...entry, path: "alias.gbr" }],
    }

    const verification = await verifyArtifactManifest(root, forged)
    expect(verification.integrityValid).toBe(false)
    expect(verification.findings).toContainEqual(expect.objectContaining({
      code: "ARTIFACT_IDENTITY_INVALID",
      path: "alias.gbr",
    }))
  })
})
