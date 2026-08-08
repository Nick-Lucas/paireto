// Pure coverage for the native Codex plugin installer. These tests exercise the bundled component
// contract, staged marketplace, and public plugin-list probe.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  codexMarketplacePlan,
  codexPluginInstallState,
  readCodexPluginVersion,
  renderCodexMarketplace,
} from "../bridge/CodexInstaller.js";

const bundledPlugin = path.resolve(__dirname, "../../plugins/codex");

suite("Codex bundled plugin contract", () => {
  test("reads its version from the native manifest, not the removed adapter manifest", () => {
    const pluginsRoot = path.dirname(bundledPlugin);
    assert.strictEqual(readCodexPluginVersion(pluginsRoot), "0.5.7");
    assert.ok(!fs.existsSync(path.join(bundledPlugin, "adapter.json")));
  });

  test("ships native hooks, MCP, and the review skill without installer placeholders", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundledPlugin, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { name: string; skills: string; mcpServers: string };
    assert.strictEqual(manifest.name, "paireto");
    assert.strictEqual(manifest.skills, "./skills/");
    assert.strictEqual(manifest.mcpServers, "./.mcp.json");

    const hooks = fs.readFileSync(path.join(bundledPlugin, "hooks", "hooks.json"), "utf8");
    assert.ok(hooks.includes("${PLUGIN_ROOT}/scripts/on-event.js"));
    assert.ok(!hooks.includes("{{PAIRETO_SCRIPTS}}"));

    const mcp = JSON.parse(fs.readFileSync(path.join(bundledPlugin, ".mcp.json"), "utf8")) as {
      mcpServers: { paireto: { args: string[]; cwd: string; tool_timeout_sec: number } };
      mcp_servers?: unknown;
    };
    assert.strictEqual(mcp.mcp_servers, undefined);
    assert.deepStrictEqual(mcp.mcpServers.paireto.args, ["./mcp/liveness.js"]);
    assert.strictEqual(mcp.mcpServers.paireto.cwd, ".");
    assert.strictEqual(mcp.mcpServers.paireto.tool_timeout_sec, 86_400);

    const skill = fs.readFileSync(
      path.join(bundledPlugin, "skills", "paireto-review", "SKILL.md"),
      "utf8",
    );
    assert.ok(skill.includes("`mcp__paireto__paireto_review`"));
    assert.ok(!fs.existsSync(path.join(bundledPlugin, "skills", "paireto-plan", "SKILL.md")));
    const server = fs.readFileSync(path.join(bundledPlugin, "mcp", "liveness.js"), "utf8");
    assert.ok(server.includes('name: "paireto_review"'));
    assert.ok(
      !fs.existsSync(path.join(bundledPlugin, "skills", "paireto-review", "scripts", "review.js")),
    );
  });
});

suite("Codex native marketplace", () => {
  test("stages a stable, self-contained plugin tree", () => {
    assert.deepStrictEqual(codexMarketplacePlan("/extension/plugins", "/global/codex"), {
      sourcePlugin: "/extension/plugins/codex",
      marketplaceRoot: "/global/codex/marketplace",
      stagedPlugin: "/global/codex/marketplace/plugins/paireto",
      marketplaceManifest: "/global/codex/marketplace/.agents/plugins/marketplace.json",
    });
  });

  test("renders the Codex marketplace contract", () => {
    const marketplace = JSON.parse(renderCodexMarketplace()) as {
      name: string;
      plugins: {
        name: string;
        source: { source: string; path: string };
        policy: { installation: string; authentication: string };
      }[];
    };
    assert.strictEqual(marketplace.name, "paireto");
    assert.deepStrictEqual(marketplace.plugins, [
      {
        name: "paireto",
        source: { source: "local", path: "./plugins/paireto" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ]);
  });
});

suite("Codex native plugin probe", () => {
  test("reports a matching installed plugin", () => {
    const list = JSON.stringify({
      installed: [
        {
          pluginId: "paireto@paireto",
          version: "0.5.7",
          installed: true,
          enabled: true,
        },
      ],
    });
    assert.strictEqual(codexPluginInstallState(list, "0.5.7"), "installed");
  });

  test("reports an old native plugin as update available", () => {
    const list = JSON.stringify({
      installed: [{ pluginId: "paireto@paireto", version: "0.5.2", installed: true }],
    });
    assert.strictEqual(codexPluginInstallState(list, "0.5.7"), "update-available");
  });

  test("does not confuse foreign plugins or malformed output for Paireto", () => {
    assert.strictEqual(
      codexPluginInstallState(
        JSON.stringify({ installed: [{ pluginId: "codex@someone-else", version: "0.5.6" }] }),
        "0.5.7",
      ),
      "not-installed",
    );
    assert.strictEqual(codexPluginInstallState("not json", "0.5.7"), "not-installed");
  });
});
