// Installs the bundled OpenCode adapter. OpenCode autoloads any plugin file dropped in its global
// config dir (`~/.config/opencode/plugin/`) and any command in `~/.config/opencode/commands/` — no
// registration CLI, no config edits. So the install is a plain file copy of our own three artifacts:
//
//   plugins/opencode/paireto.js            → <config>/plugin/paireto.js
//   plugins/opencode/adapter.json          → <config>/plugin/adapter.json   (the plugin reads its
//                                             own version from this sibling at runtime)
//   plugins/opencode/commands/paireto-review.md → <config>/commands/paireto-review.md
//
// merge-don't-clobber: those dirs are SHARED with the user's other plugins/commands, but we only ever
// write our own three filenames — every foreign file is left untouched. The plan is a PURE function
// (unit-tested); the IO wrapper stays thin. No stableDir staging (unlike Codex, whose hooks.json
// points at absolute paths): OpenCode loads the copied file in place, so a durable dir isn't needed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { log } from "../log.js";
import type { InstallState } from "../welcome/protocol.js";
import type { InstallResult } from "./PluginInstaller.js";

/** One file to copy during install. */
export interface OpenCodeCopy {
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Pure: paths + install plan
// ---------------------------------------------------------------------------

/** The set of copies that make up an install, given the shipped `plugins/` root and OpenCode's config
 *  dir. Pure — the IO wrapper walks this list. */
export function openCodeInstallPlan(pluginsRoot: string, configDir: string): OpenCodeCopy[] {
  const src = path.join(pluginsRoot, "opencode");
  const pluginDir = path.join(configDir, "plugin");
  const commandsDir = path.join(configDir, "commands");
  return [
    { from: path.join(src, "paireto.js"), to: path.join(pluginDir, "paireto.js") },
    { from: path.join(src, "adapter.json"), to: path.join(pluginDir, "adapter.json") },
    {
      from: path.join(src, "commands", "paireto-review.md"),
      to: path.join(commandsDir, "paireto-review.md"),
    },
  ];
}

// ---------------------------------------------------------------------------
// Pure: version parsing (shipped + installed manifests)
// ---------------------------------------------------------------------------

/** Parse a `version` string out of an adapter.json body, or undefined when absent/malformed. Used to
 *  compare the installed plugin against the shipped one. */
export function parseAdapterVersion(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object") {
      const version = (parsed as { version?: unknown }).version;
      return typeof version === "string" ? version : undefined;
    }
  } catch {
    // malformed — treat as no version
  }
  return undefined;
}

/** Read the shipped OpenCode adapter version from `<pluginsRoot>/opencode/adapter.json`. The manifest
 *  ships with the extension, so a missing/malformed file is a packaging bug — throw, asserting the
 *  shape so the error names the manifest (mirrors readCodexAdapterVersion). */
export function readOpenCodeAdapterVersion(pluginsRoot: string): string {
  const manifest = path.join(pluginsRoot, "opencode", "adapter.json");
  const version = parseAdapterVersion(fs.readFileSync(manifest, "utf8"));
  if (version === undefined) {
    throw new Error(`invalid opencode adapter manifest at ${manifest}: missing/invalid "version"`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// IO wrappers (thin)
// ---------------------------------------------------------------------------

/** `~/.config/opencode` (or `$XDG_CONFIG_HOME/opencode`) — where OpenCode autoloads plugins/commands. */
function openCodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

function installedAdapterPath(): string {
  return path.join(openCodeConfigDir(), "plugin", "adapter.json");
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Install the OpenCode adapter by copying our three artifacts into the user's OpenCode config dir.
 * `ctx.pluginsRoot` is the shipped `plugins/` dir; `ctx.stableDir` is unused (OpenCode loads the file
 * in place). Foreign files in those shared dirs are never touched.
 */
export async function installOpenCode(ctx: {
  pluginsRoot: string;
  stableDir: string;
}): Promise<InstallResult> {
  try {
    const version = readOpenCodeAdapterVersion(ctx.pluginsRoot);
    const configDir = openCodeConfigDir();
    for (const copy of openCodeInstallPlan(ctx.pluginsRoot, configDir)) {
      fs.mkdirSync(path.dirname(copy.to), { recursive: true });
      fs.copyFileSync(copy.from, copy.to);
    }
    log.info(`[opencode] installed adapter v${version} → ${configDir}`);
    return {
      ok: true,
      detail: "plugin + command copied (OpenCode loads them on its next session; all repos)",
    };
  } catch (err) {
    return {
      ok: false,
      detail: `opencode install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Tri-state install status from the installed adapter.json body vs the shipped version: absent/
 *  malformed → not-installed; version matches → installed; present but different → update-available. */
export function openCodeInstallState(installedJson: string, shipped: string): InstallState {
  const installed = parseAdapterVersion(installedJson);
  if (installed === undefined) {
    return "not-installed";
  }
  return installed === shipped ? "installed" : "update-available";
}

/** Probe for the Welcome screen: tri-state from the installed plugin's adapter.json version vs the
 *  shipped one. */
export function openCodeInstalledProbe(ctx: {
  pluginsRoot: string;
  stableDir: string;
}): InstallState {
  const shipped = readOpenCodeAdapterVersion(ctx.pluginsRoot);
  return openCodeInstallState(readFileOrEmpty(installedAdapterPath()), shipped);
}
