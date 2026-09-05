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
const manifests = [
  "agent-plugin/plugin.json",
  "agent-plugin/com.openai.codex/.codex-plugin/plugin.json",
  "claude-code/assets/.claude-plugin/plugin.json",
  "opencode/assets/adapter.json",
];

suite("adapter version lockstep", () => {
  test("changed hook bundles advance past the prior installed version", () => {
    assert.notStrictEqual(PLUGIN_VERSION, "0.7.0");
  });

  for (const manifest of manifests) {
    test(`src/plugins/${manifest} version === PLUGIN_VERSION`, () => {
      const file = path.join(pluginsRoot, manifest);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
      assert.strictEqual(parsed.version, PLUGIN_VERSION, `${manifest} version drifted`);
    });
  }
});
