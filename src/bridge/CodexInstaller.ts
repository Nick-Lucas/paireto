// Installs the bundled Codex integration through Codex's public plugin CLI. The extension stages a
// stable local marketplace because VSIX install paths move between upgrades; Codex then owns plugin
// discovery, component namespacing, caching, enablement, and hook trust.

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { log } from "../log.js";
import type { InstallState } from "../welcome/protocol.js";
import type { InstallResult } from "./PluginInstaller.js";

const MARKETPLACE_NAME = "paireto";
const PLUGIN_NAME = "paireto";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

export interface CodexMarketplacePlan {
  sourcePlugin: string;
  marketplaceRoot: string;
  stagedPlugin: string;
  marketplaceManifest: string;
}

export interface CodexPluginListEntry {
  pluginId?: string;
  version?: string;
  installed?: boolean;
  enabled?: boolean;
}

interface CodexPluginList {
  installed?: CodexPluginListEntry[];
}

interface CodexMarketplaceListEntry {
  name?: string;
  root?: string;
  marketplaceSource?: { sourceType?: string; source?: string };
}

interface CodexMarketplaceList {
  marketplaces?: CodexMarketplaceListEntry[];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CodexInstallOptions {
  /** Test/E2E override. Production resolves CODEX_HOME normally. */
  codexHome?: string;
  /** Test/E2E override. Production resolves CODEX_BIN/PATH/common locations. */
  codexBin?: string;
}

/** Read the native plugin version from the bundled `.codex-plugin/plugin.json`. */
export function readCodexPluginVersion(pluginsRoot: string): string {
  const manifest = path.join(pluginsRoot, "codex", ".codex-plugin", "plugin.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { version?: unknown }).version !== "string"
  ) {
    throw new Error(`invalid Codex plugin manifest at ${manifest}: missing/invalid "version"`);
  }
  return (parsed as { version: string }).version;
}

/** Stable local marketplace layout staged below the extension's globalStorage directory. */
export function codexMarketplacePlan(
  pluginsRoot: string,
  stableDir: string,
): CodexMarketplacePlan {
  const marketplaceRoot = path.join(stableDir, "marketplace");
  return {
    sourcePlugin: path.join(pluginsRoot, "codex"),
    marketplaceRoot,
    stagedPlugin: path.join(marketplaceRoot, "plugins", PLUGIN_NAME),
    marketplaceManifest: path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
  };
}

/** Marketplace metadata consumed by `codex plugin marketplace add`. */
export function renderCodexMarketplace(): string {
  return `${JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      interface: { displayName: "Paireto" },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** Tri-state derived from `codex plugin list --json`. */
export function codexPluginInstallState(source: string, shippedVersion: string): InstallState {
  let parsed: CodexPluginList;
  try {
    parsed = JSON.parse(source) as CodexPluginList;
  } catch {
    return "not-installed";
  }
  const plugin = parsed.installed?.find(
    (entry) => entry.pluginId === PLUGIN_ID && entry.installed !== false,
  );
  if (!plugin) {
    return "not-installed";
  }
  return plugin.version === shippedVersion ? "installed" : "update-available";
}

function resolveCodexBin(env: NodeJS.ProcessEnv, override?: string): string | undefined {
  const candidates: string[] = [];
  if (override) {
    candidates.push(override);
  }
  if (env.CODEX_BIN) {
    candidates.push(env.CODEX_BIN);
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, process.platform === "win32" ? "codex.exe" : "codex"));
    }
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  );
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, encoding: "utf8", env }, (err, stdout, stderr) => {
      const rawCode = err ? (err as NodeJS.ErrnoException).code : 0;
      resolve({
        code: typeof rawCode === "number" ? rawCode : err ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

function isAlreadyPresent(result: RunResult): boolean {
  return `${result.stdout}\n${result.stderr}`.toLowerCase().includes("already");
}

function parsePluginList(source: string): CodexPluginListEntry[] {
  try {
    return (JSON.parse(source) as CodexPluginList).installed ?? [];
  } catch {
    return [];
  }
}

function parseMarketplaceList(source: string): CodexMarketplaceListEntry[] {
  try {
    return (JSON.parse(source) as CodexMarketplaceList).marketplaces ?? [];
  } catch {
    return [];
  }
}

async function repointStaleMarketplace(
  bin: string,
  marketplaceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await run(bin, ["plugin", "marketplace", "list", "--json"], env);
  if (result.code !== 0) {
    return;
  }
  const existing = parseMarketplaceList(result.stdout).find((entry) => entry.name === MARKETPLACE_NAME);
  const configuredRoot = existing?.marketplaceSource?.source ?? existing?.root;
  if (!configuredRoot || path.resolve(configuredRoot) === path.resolve(marketplaceRoot)) {
    return;
  }
  const removed = await run(bin, ["plugin", "marketplace", "remove", MARKETPLACE_NAME, "--json"], env);
  if (removed.code === 0) {
    log.info(`[codex] repointed stale Paireto marketplace from ${configuredRoot}`);
  }
}

/** Stage the self-contained plugin and install it through Codex's supported plugin commands. */
export async function installCodex(
  ctx: { pluginsRoot: string; stableDir: string },
  options: CodexInstallOptions = {},
): Promise<InstallResult> {
  const plan = codexMarketplacePlan(ctx.pluginsRoot, ctx.stableDir);
  const manualCommand =
    `codex plugin marketplace add "${plan.marketplaceRoot}" && ` +
    `codex plugin add ${PLUGIN_ID}`;
  try {
    const version = readCodexPluginVersion(ctx.pluginsRoot);
    fs.rmSync(plan.stagedPlugin, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(plan.stagedPlugin), { recursive: true });
    fs.cpSync(plan.sourcePlugin, plan.stagedPlugin, { recursive: true });
    fs.mkdirSync(path.dirname(plan.marketplaceManifest), { recursive: true });
    fs.writeFileSync(plan.marketplaceManifest, renderCodexMarketplace(), "utf8");

    const baseEnv = { ...process.env };
    if (options.codexHome) {
      baseEnv.CODEX_HOME = options.codexHome;
    }
    const bin = resolveCodexBin(baseEnv, options.codexBin);
    if (!bin) {
      return { ok: false, detail: "codex CLI not found", manualCommand };
    }

    await repointStaleMarketplace(bin, plan.marketplaceRoot, baseEnv);
    const addMarketplace = await run(
      bin,
      ["plugin", "marketplace", "add", plan.marketplaceRoot, "--json"],
      baseEnv,
    );
    if (addMarketplace.code !== 0 && !isAlreadyPresent(addMarketplace)) {
      return {
        ok: false,
        detail: `marketplace add failed: ${(addMarketplace.stderr || addMarketplace.stdout).trim().slice(0, 240)}`,
        manualCommand,
      };
    }

    const listed = await run(bin, ["plugin", "list", "--json"], baseEnv);
    const installedPlugins = parsePluginList(listed.stdout);
    const existing = installedPlugins.find((entry) => entry.pluginId === PLUGIN_ID);
    if (existing && existing.version !== version) {
      const removed = await run(bin, ["plugin", "remove", PLUGIN_ID, "--json"], baseEnv);
      if (removed.code !== 0) {
        return {
          ok: false,
          detail: `old plugin removal failed: ${(removed.stderr || removed.stdout).trim().slice(0, 240)}`,
          manualCommand,
        };
      }
    }

    const addPlugin = await run(bin, ["plugin", "add", PLUGIN_ID, "--json"], baseEnv);
    if (addPlugin.code !== 0 && !isAlreadyPresent(addPlugin)) {
      return {
        ok: false,
        detail: `plugin install failed: ${(addPlugin.stderr || addPlugin.stdout).trim().slice(0, 240)}`,
        manualCommand,
      };
    }

    log.info(`[codex] installed native plugin ${PLUGIN_ID} v${version}`);
    return {
      ok: true,
      detail: "installed as a native Codex plugin; restart Codex and approve its hook trust prompt",
    };
  } catch (err) {
    return {
      ok: false,
      detail: `codex plugin install failed: ${err instanceof Error ? err.message : String(err)}`,
      manualCommand,
    };
  }
}

/** Probe the public plugin registry. */
export function codexInstalledProbe(ctx: { pluginsRoot: string }): InstallState {
  const version = readCodexPluginVersion(ctx.pluginsRoot);
  const env = { ...process.env };
  const bin = resolveCodexBin(env);
  if (bin) {
    try {
      const stdout = execFileSync(bin, ["plugin", "list", "--json"], {
        encoding: "utf8",
        timeout: 5000,
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const state = codexPluginInstallState(stdout, version);
      if (state !== "not-installed") {
        return state;
      }
    } catch {
      // Treat an unavailable plugin registry as not installed.
    }
  }
  return "not-installed";
}
