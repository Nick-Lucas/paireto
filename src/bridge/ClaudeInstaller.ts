// Installs the bundled Claude Code integration by driving Claude's public plugin CLI — the supported,
// schema-correct path. We deliberately do NOT hand-edit known_marketplaces.json /
// installed_plugins.json (that risks corrupting the user's config), and the same CLI is what we ask
// which plugin Claude actually carries.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { log } from "../log.js";
import type { InstallResult } from "./types.js";

const MARKETPLACE_NAME = "paireto";
const PLUGIN_NAME = "paireto";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
/** A probe runs behind the Welcome screen, so it waits far less than an install does. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * The installed-version marker compares against this, read straight from the shipped plugin
 * manifest so there's a single source of truth (a hardcoded copy previously drifted out of sync,
 * so an upgraded extension never re-triggered setup). The manifest ships with the extension, so a
 * missing/malformed file is a packaging bug, not a runtime condition to handle — let it throw, but
 * assert its shape explicitly rather than blindly trust-casting `JSON.parse`'s `any` so the error
 * points straight at the manifest instead of surfacing later as a confusing downstream failure.
 */
export function readClaudePluginVersion(pluginsRoot: string): string {
  const manifest = path.join(pluginsRoot, "claude-code", ".claude-plugin", "plugin.json");
  const raw = fs.readFileSync(manifest, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { version?: unknown }).version !== "string"
  ) {
    throw new Error(`invalid plugin manifest at ${manifest}: missing/invalid "version" field`);
  }
  return (parsed as { version: string }).version;
}

/** One row of `claude plugin list --json`. Only the fields this file reads are declared. */
interface ClaudePluginListEntry {
  id?: string;
  version?: string;
  enabled?: boolean;
}

/**
 * The version Claude Code itself reports for the bridge plugin, or undefined when it carries none.
 *
 * Asking Claude rather than trusting a marker the extension wrote: the two are not the same claim.
 * An extension update moves the plugin directory the marketplace points at, so the agent can go on
 * serving an older bundle long after the extension believes it installed a newer one — and a plugin
 * whose version is not this window's is refused at the handshake, silently.
 */
export function claudeInstalledPluginVersion(source: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const entry = (parsed as ClaudePluginListEntry[]).find(
    (row) => row?.id === PLUGIN_ID && row.enabled !== false,
  );
  return typeof entry?.version === "string" ? entry.version : undefined;
}

/** Locate the `claude` binary: explicit env, PATH, then common install locations. */
function resolveClaudeBin(): string | undefined {
  const candidates: string[] = [];
  if (process.env.CLAUDE_BIN) {
    candidates.push(process.env.CLAUDE_BIN);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, "claude"));
    }
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  );
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], timeoutMs = 60000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (((err as NodeJS.ErrnoException).code as unknown as number) ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, stdout, stderr });
    });
  });
}

/** Treat "already added / already installed" as success — the install is idempotent. */
function isAlreadyPresent(r: RunResult): boolean {
  const text = (r.stdout + r.stderr).toLowerCase();
  return text.includes("already");
}

export interface MarketplaceListEntry {
  name?: string;
  source?: string;
  path?: string;
}

export function marketplaceNamesToRemove(
  entries: MarketplaceListEntry[],
  pluginsRoot: string,
): string[] {
  const expectedPath = path.resolve(pluginsRoot);
  return entries.flatMap((entry) => {
    if (entry.source !== "directory" || !entry.name || !entry.path) {
      return [];
    }
    const pathMatches = path.resolve(entry.path) === expectedPath;
    const hasExpectedName = entry.name === MARKETPLACE_NAME;
    return pathMatches === hasExpectedName ? [] : [entry.name];
  });
}

async function removeStaleMarketplaces(bin: string, pluginsRoot: string): Promise<void> {
  const list = await run(bin, ["plugin", "marketplace", "list", "--json"]);
  if (list.code !== 0) {
    return;
  }
  let entries: MarketplaceListEntry[];
  try {
    entries = JSON.parse(list.stdout) as MarketplaceListEntry[];
  } catch {
    return;
  }

  for (const name of marketplaceNamesToRemove(entries, pluginsRoot)) {
    const removed = await run(bin, ["plugin", "marketplace", "remove", name, "--scope", "user"]);
    if (removed.code === 0) {
      log.info(`removed stale plugin marketplace "${name}" before registering ${pluginsRoot}`);
    } else {
      log.info(
        `could not remove stale plugin marketplace "${name}": ` +
          (removed.stderr || removed.stdout).trim().slice(0, 200),
      );
    }
  }
}

/**
 * @param pluginsRoot absolute path to the shipped `dist/plugins/` dir (contains .claude-plugin/marketplace.json)
 */
export async function installClaude(pluginsRoot: string): Promise<InstallResult> {
  const marketplaceManifest = path.join(pluginsRoot, ".claude-plugin", "marketplace.json");
  if (!fs.existsSync(marketplaceManifest)) {
    return { ok: false, detail: `marketplace manifest not found at ${marketplaceManifest}` };
  }

  const bin = resolveClaudeBin();
  if (!bin) {
    return {
      ok: false,
      detail: "claude CLI not found",
    };
  }

  await removeStaleMarketplaces(bin, pluginsRoot);

  const add = await run(bin, ["plugin", "marketplace", "add", pluginsRoot, "--scope", "user"]);
  if (add.code !== 0 && !isAlreadyPresent(add)) {
    return {
      ok: false,
      detail: `marketplace add failed: ${(add.stderr || add.stdout).trim().slice(0, 200)}`,
    };
  }

  const install = await run(bin, [
    "plugin",
    "install",
    `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    "--scope",
    "user",
  ]);
  if (install.code !== 0 && !isAlreadyPresent(install)) {
    return {
      ok: false,
      detail: `install failed: ${(install.stderr || install.stdout).trim().slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    detail: "registered + installed via claude CLI (restart Claude Code to load hooks)",
  };
}

/**
 * Ask Claude Code which bridge plugin it carries. Undefined when it carries none, when the CLI is
 * not on PATH (nothing could have installed the plugin), or when it cannot answer.
 */
export async function claudeInstalledVersion(): Promise<string | undefined> {
  const bin = resolveClaudeBin();
  if (!bin) {
    return undefined;
  }
  const listed = await run(bin, ["plugin", "list", "--json"], PROBE_TIMEOUT_MS);
  return listed.code === 0 ? claudeInstalledPluginVersion(listed.stdout) : undefined;
}
