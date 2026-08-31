import * as assert from "node:assert";

import {
  claudeInstalledPluginVersion,
  marketplaceNamesToRemove,
} from "../bridge/ClaudeInstaller.js";

suite("Claude Code plugin installer", () => {
  test("removes a renamed marketplace that still owns the plugin directory", () => {
    assert.deepStrictEqual(
      marketplaceNamesToRemove(
        [
          {
            name: "tui-companion",
            source: "directory",
            path: "/extension/plugins",
          },
        ],
        "/extension/plugins",
      ),
      ["tui-companion"],
    );
  });

  test("removes the current marketplace name when it points at an old directory", () => {
    assert.deepStrictEqual(
      marketplaceNamesToRemove(
        [
          {
            name: "paireto",
            source: "directory",
            path: "/old-extension/plugins",
          },
        ],
        "/extension/plugins",
      ),
      ["paireto"],
    );
  });

  test("keeps correct and unrelated marketplace registrations", () => {
    assert.deepStrictEqual(
      marketplaceNamesToRemove(
        [
          { name: "paireto", source: "directory", path: "/extension/plugins" },
          { name: "other", source: "directory", path: "/other/plugins" },
          { name: "paireto", source: "github" },
        ],
        "/extension/plugins",
      ),
      [],
    );
  });
});

// What Claude answers is the only honest source for "installed": an extension update moves the
// directory its marketplace points at, so a marker this extension wrote can say 0.7.0 while the
// agent still serves 0.6.0 — and a 0.6.0 plugin is refused at the handshake, silently.
suite("Claude Code installed-plugin version", () => {
  const list = (rows: unknown[]): string => JSON.stringify(rows);

  test("reads the version of the paireto plugin", () => {
    assert.strictEqual(
      claudeInstalledPluginVersion(
        list([
          { id: "codex@openai-codex", version: "1.0.6", enabled: true },
          { id: "paireto@paireto", version: "0.6.0", enabled: true },
        ]),
      ),
      "0.6.0",
    );
  });

  test("ignores a disabled entry — a disabled plugin reaches nothing", () => {
    assert.strictEqual(
      claudeInstalledPluginVersion(
        list([{ id: "paireto@paireto", version: "0.6.0", enabled: false }]),
      ),
      undefined,
    );
  });

  test("a list without the plugin, or one it cannot read, reports nothing", () => {
    assert.strictEqual(claudeInstalledPluginVersion(list([])), undefined);
    assert.strictEqual(claudeInstalledPluginVersion("not json"), undefined);
    assert.strictEqual(claudeInstalledPluginVersion("{}"), undefined);
    assert.strictEqual(
      claudeInstalledPluginVersion(list([{ id: "paireto@paireto", enabled: true }])),
      undefined,
    );
  });
});
