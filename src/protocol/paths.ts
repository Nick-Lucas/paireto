// Deterministic resolution of the runtime state dir, per-repo socket paths, and the
// repo key. The plugin's bridge.js MUST compute identical values — any divergence and the
// hook talks to the wrong socket (or none). The non-negotiable rule: realpath both sides
// before hashing, so macOS /var <-> /private/var symlinks don't produce different keys.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const APP_DIR = "paireto";

/** `${XDG_STATE_HOME:-~/.local/state}/paireto` — keeps $HOME uncluttered (XDG state dir). */
export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, APP_DIR);
}

/** Directory holding the per-repo sockets. Kept short so socket paths stay under sun_path (~104B). */
export function socketDir(): string {
  return path.join(stateDir(), "s");
}

export function indexPath(): string {
  return path.join(stateDir(), "index.json");
}

/** Directory of per-repo activity summaries each window publishes for the cross-repo switcher view. */
export function activityDir(): string {
  return path.join(stateDir(), "activity");
}

/** Activity file for a repo/worktree root: `activity/<repoKey>.json`. */
export function activityPath(toplevel: string): string {
  return path.join(activityDir(), `${repoKey(toplevel)}.json`);
}

export function indexLockPath(): string {
  return path.join(stateDir(), "index.lock");
}

export function configPath(): string {
  return path.join(stateDir(), "config.json");
}

/**
 * Resolve a filesystem path to its canonical, symlink-free form with no trailing slash.
 * Falls back to a lexical normalize if the path does not exist (realpath would throw).
 */
export function canonicalize(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = path.resolve(p);
  }
  // Strip a trailing separator (path.resolve already removes it except for the root).
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * The stable key for a repo/worktree root: first 8 bytes of sha256(canonical path), hex.
 * 64 bits of entropy — collision-negligible for per-user repo counts.
 */
export function repoKey(toplevel: string): string {
  const canonical = canonicalize(toplevel);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest();
  return digest.subarray(0, 8).toString("hex");
}

/** Absolute path of the Unix socket for a given repo/worktree root. */
export function socketPath(toplevel: string): string {
  return path.join(socketDir(), `${repoKey(toplevel)}.sock`);
}
