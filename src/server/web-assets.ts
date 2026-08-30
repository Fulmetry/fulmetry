// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import { basename, join } from "node:path";
import { compile } from "tailwindcss";
import tailwindStylesheet from "tailwindcss/index.css" with { type: "text" };

export interface InspectionWebAssets {
  readonly entryScript: string;
  readonly stylesheets: readonly string[];
  response(pathname: string, head: boolean): Response | undefined;
}

let cachedAssets: Promise<InspectionWebAssets> | undefined;

const TAILWIND_CANDIDATE = /!?-?[_a-zA-Z0-9][-_a-zA-Z0-9:\/\.\[\]\(\),%#@!]*/gu;

function contentType(output: Bun.BuildArtifact): string {
  if (output.path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (output.path.endsWith(".css")) return "text/css; charset=utf-8";
  switch (output.loader) {
    case "js": return "text/javascript; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "wasm": return "application/wasm";
    default: return "application/octet-stream";
  }
}

async function compileInspectionWebAssets(): Promise<InspectionWebAssets> {
  const webRoot = join(import.meta.dir, "web");
  const candidates = new Set<string>();
  for (const path of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: webRoot, absolute: true })) {
    for (const candidate of (await Bun.file(path).text()).match(TAILWIND_CANDIDATE) ?? []) candidates.add(candidate);
  }
  const stylesheetSource = await Bun.file(join(webRoot, "styles.css")).text();
  const stylesheetCompiler = await compile(stylesheetSource, {
    base: webRoot,
    loadStylesheet: async (id) => {
      if (id !== "tailwindcss") throw new Error(`Fulmetry browser stylesheet requested unsupported import ${id}`);
      return {
        path: "tailwindcss/index.css",
        base: webRoot,
        content: tailwindStylesheet,
      };
    },
  });
  const stylesheet = stylesheetCompiler.build([...candidates].sort());
  const stylesheetHash = new Bun.CryptoHasher("sha256").update(stylesheet).digest("hex").slice(0, 16);
  const stylesheetPath = `/assets/fulmetry-app-${stylesheetHash}.css`;
  const result = await Bun.build({
    entrypoints: [join(webRoot, "main.tsx")],
    target: "browser",
    format: "esm",
    packages: "bundle",
    splitting: true,
    minify: true,
    sourcemap: "none",
    publicPath: "/assets/",
    naming: {
      entry: "fulmetry-app-[hash].[ext]",
      chunk: "fulmetry-chunk-[hash].[ext]",
      asset: "fulmetry-asset-[hash].[ext]",
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });
  if (!result.success) {
    throw new AggregateError(result.logs.map((log) => new Error(log.message)), "Fulmetry browser application could not be bundled");
  }
  const assets = new Map<string, Readonly<{ body: Blob; contentType: string }>>([
    [stylesheetPath, Object.freeze({ body: new Blob([stylesheet]), contentType: "text/css; charset=utf-8" })],
  ]);
  let entryScript: string | undefined;
  for (const output of result.outputs) {
    const path = `/assets/${basename(output.path)}`;
    if (assets.has(path)) throw new Error(`Fulmetry browser build emitted duplicate asset ${path}`);
    assets.set(path, Object.freeze({ body: output, contentType: contentType(output) }));
    if (output.kind === "entry-point" && output.path.endsWith(".js")) entryScript = path;
  }
  if (entryScript === undefined) throw new Error("Fulmetry browser build emitted no JavaScript entry point");
  return Object.freeze({
    entryScript,
    stylesheets: Object.freeze([stylesheetPath]),
    response(pathname: string, head: boolean): Response | undefined {
      const asset = assets.get(pathname);
      if (asset === undefined) return undefined;
      return new Response(head ? null : asset.body, {
        headers: {
          "Content-Type": asset.contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  });
}

export function loadInspectionWebAssets(): Promise<InspectionWebAssets> {
  cachedAssets ??= compileInspectionWebAssets();
  return cachedAssets;
}
