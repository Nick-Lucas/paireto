// Which per-repo socket a plugin process should talk to.
//
// Path and key derivation come from src/protocol/paths.ts, the same module the extension's socket
// server uses, so the two sides cannot disagree about where a repo's socket lives.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

import { canonicalize, socketPath } from "../../protocol/paths.js";

export interface BridgeTarget {
  readonly socketPath: string;
  readonly repoRoot: string;
}

/** The git toplevel for a directory, or undefined when git is unavailable or this is not a repo. */
export function gitToplevel(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const top = out.trim();
    return top.length > 0 ? top : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide which socket to talk to for an agent's cwd, or undefined when nothing is listening.
 *
 * STRICT cwd-first: an agent belongs to its OWN git toplevel — a worktree's toplevel is the worktree
 * directory, not the main repo. Only the exact toplevel's socket counts. Without this, a worktree
 * agent leaks its events into an ancestor repo's window, which shows up as wrong refreshes, agent
 * rows appearing under the wrong repo, and a blank Changes list.
 */
export function resolveTarget(cwd: string): BridgeTarget | undefined {
  const top = gitToplevel(cwd) ?? cwd;
  const sp = socketPath(top);
  if (!fs.existsSync(sp)) {
    return undefined;
  }
  return { socketPath: sp, repoRoot: canonicalize(top) };
}
