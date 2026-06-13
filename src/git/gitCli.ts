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

/** Split NUL-separated git porcelain output, dropping a trailing empty token. */
export function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}
