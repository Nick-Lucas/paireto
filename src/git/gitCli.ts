// Thin promisified wrapper around the git CLI. We use the CLI (not the Git extension API) for
// exact diff/worktree behavior; maxBuffer is raised because diffs can be large.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Run `git -C <repoRoot> <args...>`. Rejects on non-zero exit. */
export async function git(repoRoot: string, args: string[]): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    maxBuffer: MAX_BUFFER,
    encoding: "utf8",
  });
  return { stdout, stderr };
}

/** Like {@link git} but resolves to "" instead of throwing (for best-effort queries). */
export async function gitSafe(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await git(repoRoot, args);
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Like {@link gitSafe} but returns the raw stdout bytes (no UTF-8 decode), so binary blobs such as
 * images survive a `git show` intact. Resolves to an empty buffer instead of throwing.
 */
export async function gitSafeBytes(repoRoot: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
      maxBuffer: MAX_BUFFER,
      encoding: "buffer",
    });
    return stdout;
  } catch {
    return Buffer.alloc(0);
  }
}

/** Parse `git rev-parse --abbrev-ref HEAD` stdout: trims; "" and "HEAD" (detached) -> undefined. */
export function branchFromRevParse(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "HEAD") {
    return undefined;
  }
  return trimmed;
}

/** Current branch of a repo/worktree root, or undefined when detached / on error. */
export async function currentBranch(repoRoot: string): Promise<string | undefined> {
  return branchFromRevParse(await gitSafe(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]));
}

/**
 * The real git toplevel for `cwd` (a worktree's own directory, never its main repo), or `undefined`
 * if `cwd` isn't inside a git repo. Mirrors `plugins/claude-code/scripts/bridge.js`'s `gitToplevel`
 * exactly — this is what lets the extension bind sockets under the SAME identity the hook scripts
 * independently resolve, rather than trusting a third party's (`vscode.git`) repo-root reporting.
 */
export async function gitToplevel(cwd: string): Promise<string | undefined> {
  const stdout = await gitSafe(cwd, ["rev-parse", "--show-toplevel"]);
  const trimmed = stdout.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Split NUL-separated git porcelain output, dropping a trailing empty token. */
export function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}
