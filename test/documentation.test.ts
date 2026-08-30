import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

describe("documentation security boundaries", () => {
  test("describes offline mode as Fulmetry-managed policy rather than an OS sandbox", async () => {
    const requirements = await readFile(
      join(repositoryRoot, "PRODUCT_REQUIREMENTS.md"),
      "utf8",
    );

    expect(requirements).not.toContain("`--offline` prevents network access");
    expect(requirements).toContain(
      "`--offline` blocks Fulmetry-managed network access",
    );
  });

  test("states the shipped subprocess-containment boundaries without the obsolete daemon caveat", async () => {
    const readme = await readFile(join(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).toContain("authoritative project tests may not import or reference subprocess APIs");
    expect(readme).toContain("operational cleanup uses macOS Seatbelt to deny direct child creation and parent signaling");
    expect(readme).toContain("does not claim to sandbox a malicious executable");
    expect(readme).toContain("If the required OS cleanup mechanism is unavailable, Fulmetry reports process containment unavailable without launching the selected executable");
    expect(readme).not.toContain("deliberately daemonized process that reparents itself outside that group");
  });

  test("states the macOS observed privacy evidence and its native-code boundary", async () => {
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    expect(readme).toContain("on the declared Apple Silicon macOS platform, preloads a sensitivity-checked runtime egress observer");
    expect(readme).toContain("a nested-Bun canary proves the observer is injected into Fulmetry's fresh configuration/evaluation processes");
    expect(readme).toContain("named `node:net`, DNS, fetch, and UDP canaries independently prove those client surfaces are instrumented");
    expect(readme).toContain("compiles through the real pinned tscircuit authoring graph");
    expect(readme).toContain("proves multiple fresh child processes joined observation");
    expect(readme).toContain("requires zero socket, DNS, HTTP, WebSocket, or UDP client attempts");
    expect(readme).toContain("not malicious trusted project code or native code issuing raw system calls outside the runtime APIs");
    expect(readme).not.toContain("Linux and Windows still require equivalent packet-, DNS-, or socket-level deny/observe evidence before release");
  });

  test("binds every ordinary documented command to the clean packed-project exercise", async () => {
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    const packed = await readFile(join(repositoryRoot, "scripts", "packed-e2e.ts"), "utf8");
    const packedCompact = packed.replaceAll(/\s+/gu, "");
    const commands = [
      "bun run fulmetry help",
      "bun run fulmetry build --json",
      "bun run fulmetry check --json",
      "bun run fulmetry test --json",
      "bun run fulmetry inspect --status fabrication --json",
      "bun run fulmetry export kicad --json",
      "bun run fulmetry export gerbers --offline --json",
      "bun run fulmetry verify manufacturing --json",
      "bun run fulmetry dev --port 0 --json",
      "bun run test",
    ];
    for (const command of commands) {
      expect(readme).toContain(command);
      const arguments_ = command.split(" ").slice(1);
      expect(packedCompact).toContain(JSON.stringify(arguments_).slice(1, -1));
    }
    expect(readme).toContain("fail-closed future interface");
  });

  test("documents the fail-closed source-controlled waiver boundary", async () => {
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    expect(readme).toContain("Scoped waivers live in source-controlled `waivers/*.json` files");
    expect(readme).toContain("Capability, connectivity, ownership, identity, unsupported-construct, resource-limit, and artifact-integrity findings remain non-waivable");
    expect(readme).toContain("Source-only `check` remains `incomplete` even after valid waivers");
    expect(readme).toContain("`warning-only` is available only after the emitted manufacturing files pass independent verification");
  });
});
