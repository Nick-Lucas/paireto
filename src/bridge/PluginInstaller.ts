// Installs + registers the bundled Claude Code plugin by driving the `claude` CLI — the supported,
// schema-correct path. We deliberately do NOT hand-edit known_marketplaces.json / installed_plugins.json
// (that risks corrupting the user's config).

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { log } from "../log.js";

const MARKETPLACE_NAME = "paireto";
const PLUGIN_NAME = "paireto";

/**
 * The installed-version marker compares against this, read straight from the shipped plugin
 * manifest so there's a single source of truth (a hardcoded copy previously drifted out of sync,
 * so an upgraded extension never re-triggered setup). The manifest ships with the extension, so a
 * missing/malformed file is a packaging bug, not a runtime condition to handle — let it throw, but
 * assert its shape explicitly rather than blindly trust-casting `JSON.parse`'s `any` so the error
 * points straight at the manifest instead of surfacing later as a confusing downstream failure.
 */
export function readPluginVersion(pluginsRoot: string): string {
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

export interface InstallResult {
  ok: boolean;
  detail: string;
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

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, encoding: "utf8" }, (err, stdout, stderr) => {
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
export async function installPlugin(pluginsRoot: string): Promise<InstallResult> {
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
