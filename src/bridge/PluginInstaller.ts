// Installs + registers the bundled Claude Code plugin so hooks fire without manual setup.
//
// Mechanism (mirrors how plannotator is registered): the .vsix ships a `plugins/` tree whose root
// holds .claude-plugin/marketplace.json with a relative `source: "./claude-code"`. We register that
// directory as a local marketplace in ~/.claude/plugins/known_marketplaces.json (merge, never
// overwrite) and add the plugin to installed_plugins.json. We point the marketplace at the
// extension's own shipped `plugins/` dir — no copy needed since it lives in the install location.
//
// NOTE: the exact loader contract is the one remaining Phase 0 unknown; this writes the files
// plannotator's registration uses. Failures are non-fatal — the README documents manual install.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MARKETPLACE_NAME = "tui-companion";
const PLUGIN_NAME = "tui-companion";
const PLUGIN_VERSION = "0.1.0";

interface InstallResult {
  ok: boolean;
  detail: string;
}

function claudePluginsDir(): string {
  return path.join(os.homedir(), ".claude", "plugins");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * @param pluginsRoot absolute path to the shipped `plugins/` dir (contains .claude-plugin/marketplace.json)
 */
export function installPlugin(pluginsRoot: string): InstallResult {
  const marketplaceManifest = path.join(pluginsRoot, ".claude-plugin", "marketplace.json");
  if (!fs.existsSync(marketplaceManifest)) {
    return { ok: false, detail: `marketplace manifest not found at ${marketplaceManifest}` };
  }

  const base = claudePluginsDir();
  if (!fs.existsSync(base)) {
    return { ok: false, detail: "Claude Code not detected (~/.claude/plugins missing)" };
  }

  try {
    // 1. Register the local marketplace (merge).
    const knownPath = path.join(base, "known_marketplaces.json");
    const known = readJson<Record<string, unknown>>(knownPath, {});
    known[MARKETPLACE_NAME] = {
      source: { source: "local", path: pluginsRoot },
      installLocation: pluginsRoot,
      lastUpdated: new Date().toISOString(),
    };
    writeJson(knownPath, known);

    // 2. Mark the plugin installed (merge).
    const installedPath = path.join(base, "installed_plugins.json");
    const installed = readJson<{ version?: number; plugins?: Record<string, unknown> }>(
      installedPath,
      { version: 2, plugins: {} },
    );
    installed.version = installed.version ?? 2;
    installed.plugins = installed.plugins ?? {};
    installed.plugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`] = [
      {
        scope: "user",
        installPath: path.join(pluginsRoot, "claude-code"),
        version: PLUGIN_VERSION,
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      },
    ];
    writeJson(installedPath, installed);

    return { ok: true, detail: "registered local marketplace + plugin (restart Claude Code)" };
  } catch (err) {
    return { ok: false, detail: `registration failed: ${(err as Error).message}` };
  }
}
