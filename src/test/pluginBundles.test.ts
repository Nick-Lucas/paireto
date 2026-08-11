// The plugin manifests name file paths that esbuild produces. Nothing else checks that the two
// halves agree, and a mismatch is invisible until an agent tries to run a hook that isn't there.
//
// The size ceiling is the other guard: the hook scripts run once per tool call under a 5 second
// timeout, so they must stay small. Importing anything from core/mcp would drag the MCP SDK in and
// multiply their size — this fails the suite instead of shipping that.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

/** The built plugin tree, produced by esbuild into dist/ alongside the extension bundle. */
const PLUGINS = "dist/plugins";

/** Hooks are spawned per event with a 5s timeout; the shared socket glue alone is ~15 KB. */
const HOOK_BUNDLE_MAX_BYTES = 80 * 1024;

interface HookCommand {
  type: string;
  command: string;
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, ...segments), "utf8")) as T;
}

/** Every `node "<path>"` script named by a hooks.json, with the harness's root variable stripped. */
function hookScriptPaths(pluginDir: string): string[] {
  const hooks = readJson<{
    hooks: Record<string, Array<{ hooks?: HookCommand[] }>>;
  }>(pluginDir, "hooks", "hooks.json");

  const found = new Set<string>();
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const match = /\$\{[A-Z_]+\}\/(\S+?\.js)/.exec(hook.command);
        if (match) {
          found.add(match[1]);
        }
      }
    }
  }
  return [...found];
}

suite("plugin bundles match their manifests", () => {
  for (const pluginDir of [`${PLUGINS}/claude-code`, `${PLUGINS}/codex`]) {
    test(`${pluginDir}: every hooks.json script exists after a build`, () => {
      const scripts = hookScriptPaths(pluginDir);
      assert.ok(scripts.length > 0, `no hook scripts found in ${pluginDir}/hooks/hooks.json`);
      for (const script of scripts) {
        const full = path.join(repoRoot, pluginDir, script);
        assert.ok(fs.existsSync(full), `${pluginDir}/${script} is missing — run the build`);
      }
    });

    test(`${pluginDir}: hook bundles stay small enough for a 5s timeout`, () => {
      for (const script of hookScriptPaths(pluginDir)) {
        const full = path.join(repoRoot, pluginDir, script);
        const size = fs.statSync(full).size;
        assert.ok(
          size <= HOOK_BUNDLE_MAX_BYTES,
          `${pluginDir}/${script} is ${size} bytes, over the ${HOOK_BUNDLE_MAX_BYTES} ceiling — ` +
            "something pulled the MCP SDK or another heavy dependency into a hook",
        );
      }
    });

    test(`${pluginDir}: no hook bundle carries the MCP SDK`, () => {
      for (const script of hookScriptPaths(pluginDir)) {
        const text = fs.readFileSync(path.join(repoRoot, pluginDir, script), "utf8");
        assert.ok(
          !text.includes("modelcontextprotocol"),
          `${pluginDir}/${script} bundles the MCP SDK; hooks must not import from core/mcp`,
        );
      }
    });
  }

  test("each .mcp.json points at a server that exists", () => {
    const claude = readJson<{ mcpServers: Record<string, { args: string[] }> }>(
      `${PLUGINS}/claude-code`,
      ".mcp.json",
    );
    const claudeArg = claude.mcpServers.bridge.args[0].replace("${CLAUDE_PLUGIN_ROOT}/", "");
    assert.ok(fs.existsSync(path.join(repoRoot, `${PLUGINS}/claude-code`, claudeArg)), claudeArg);

    const codex = readJson<{ mcpServers: Record<string, { args: string[] }> }>(
      `${PLUGINS}/codex`,
      ".mcp.json",
    );
    // Codex uses a relative path resolved against the staged plugin directory.
    const codexArg = codex.mcpServers.paireto.args[0];
    assert.ok(fs.existsSync(path.join(repoRoot, `${PLUGINS}/codex`, codexArg)), codexArg);
  });

  test("the OpenCode adapter the installer copies exists", () => {
    assert.ok(fs.existsSync(path.join(repoRoot, `${PLUGINS}/opencode/paireto.js`)));
  });

  test("the MCP servers do carry the SDK — the shared core is really in use", () => {
    for (const server of [
      `${PLUGINS}/claude-code/mcp/server.js`,
      `${PLUGINS}/codex/mcp/liveness.js`,
    ]) {
      const text = fs.readFileSync(path.join(repoRoot, server), "utf8");
      assert.ok(text.includes("paireto_review"), `${server} does not register the review tool`);
    }
  });
});
