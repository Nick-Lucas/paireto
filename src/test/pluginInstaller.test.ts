import * as assert from "node:assert";

import { marketplaceNamesToRemove } from "../bridge/PluginInstaller.js";

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
