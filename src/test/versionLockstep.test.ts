// Every shipped adapter manifest MUST carry the same version as PLUGIN_VERSION (the wire-protocol
// marker checked for strict equality in the hello handshake). A drifted adapter version means its
// hooks handshake against a mismatched extension and get rejected — so this test locks all bundles
// to the single source of truth. Scans `plugins/*` for either a Claude-style `.claude-plugin/
// plugin.json` or an `adapter.json`, so a new adapter is covered automatically.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import { PLUGIN_VERSION } from "../protocol/types.js";

const pluginsRoot = path.resolve(__dirname, "../../plugins");

function manifestVersion(dir: string): string | undefined {
  const candidates = [
    path.join(dir, ".claude-plugin", "plugin.json"),
    path.join(dir, "adapter.json"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  }
  return undefined;
}

suite("adapter version lockstep", () => {
  // Skip dot-dirs (e.g. plugins/.claude-plugin, the marketplace manifest) and any dir without an
  // adapter manifest — only real adapter bundles are version-locked.
  const bundles = fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => manifestVersion(path.join(pluginsRoot, name)) !== undefined);

  test("at least the claude-code + codex + opencode bundles are present", () => {
    assert.ok(bundles.includes("claude-code"), "claude-code bundle");
    assert.ok(bundles.includes("codex"), "codex bundle");
    assert.ok(bundles.includes("opencode"), "opencode bundle");
  });

  for (const bundle of bundles) {
    test(`plugins/${bundle} manifest version === PLUGIN_VERSION`, () => {
      const version = manifestVersion(path.join(pluginsRoot, bundle));
      assert.ok(version, `plugins/${bundle} has a manifest with a version`);
      assert.strictEqual(version, PLUGIN_VERSION, `plugins/${bundle} version drifted`);
    });
  }
});
