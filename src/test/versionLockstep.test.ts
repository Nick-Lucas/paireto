// Every shipped adapter manifest MUST carry the same version as PLUGIN_VERSION (the wire-protocol
// marker checked for strict equality in the hello handshake). A drifted adapter version means its
// hooks handshake against a mismatched extension and get rejected — so this test locks all bundles
// to the single source of truth. Scans the SOURCE assets (`src/plugins/*/assets`) for native
// Claude/Codex manifests or an `adapter.json`, so a new adapter is covered automatically, and a
// drift is caught without needing a build first.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import { PLUGIN_VERSION } from "../protocol/types.js";

// The repo's source tree, not the compiled one next to this test: only the manifest that
// protocol/types.ts imports is copied into out/, so the others exist solely under src/.
const pluginsRoot = path.resolve(__dirname, "../../src/plugins");

/** A plugin's static assets, which the build copies verbatim into the shipped tree. */
function assetsDir(name: string): string {
  return path.join(pluginsRoot, name, "assets");
}

function manifestVersion(dir: string): string | undefined {
  const candidates = [
    path.join(dir, ".claude-plugin", "plugin.json"),
    path.join(dir, ".codex-plugin", "plugin.json"),
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
  test("changed hook bundles advance past the prior installed version", () => {
    assert.notStrictEqual(PLUGIN_VERSION, "0.5.8");
  });

  // Skip dot-dirs (e.g. plugins/.claude-plugin, the marketplace manifest) and any dir without an
  // adapter manifest — only real adapter bundles are version-locked.
  const bundles = fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => manifestVersion(assetsDir(name)) !== undefined);

  test("at least the claude-code + codex + opencode bundles are present", () => {
    assert.ok(bundles.includes("claude-code"), "claude-code bundle");
    assert.ok(bundles.includes("codex"), "codex bundle");
    assert.ok(bundles.includes("opencode"), "opencode bundle");
  });

  for (const bundle of bundles) {
    test(`src/plugins/${bundle} manifest version === PLUGIN_VERSION`, () => {
      const version = manifestVersion(assetsDir(bundle));
      assert.ok(version, `src/plugins/${bundle} has a manifest with a version`);
      assert.strictEqual(version, PLUGIN_VERSION, `src/plugins/${bundle} version drifted`);
    });
  }
});
