// Enumerates git worktrees (the Git extension API does not expose them). Parses the NUL-record
// porcelain output and caches per repo root; invalidated on WorktreeCreate/Remove bridge events.

import { gitSafe, splitNul } from "./gitCli.js";

export interface WorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
  isMain: boolean;
  detached: boolean;
  locked: boolean;
}

export class WorktreeService {
  private readonly cache = new Map<string, WorktreeInfo[]>();

  invalidate(repoRoot: string): void {
    this.cache.delete(repoRoot);
  }

  async list(repoRoot: string): Promise<WorktreeInfo[]> {
    const cached = this.cache.get(repoRoot);
    if (cached) {
      return cached;
    }
    const out = await gitSafe(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
    const result = parseWorktrees(out);
    this.cache.set(repoRoot, result);
    return result;
  }
}

/** Parse `git worktree list --porcelain -z`. Tokens are NUL-separated; "" ends a worktree block. */
export function parseWorktrees(output: string): WorktreeInfo[] {
  const tokens = splitNul(output);
  const result: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | undefined;
  let isFirst = true;

  const flush = (): void => {
    if (current && current.path) {
      result.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        isMain: current.isMain ?? false,
        detached: current.detached ?? false,
        locked: current.locked ?? false,
      });
    }
    current = undefined;
  };

  for (const token of tokens) {
    if (token === "") {
      flush();
      continue;
    }
    const sp = token.indexOf(" ");
    const key = sp === -1 ? token : token.slice(0, sp);
    const value = sp === -1 ? "" : token.slice(sp + 1);
    if (key === "worktree") {
      flush();
      current = { path: value, isMain: isFirst };
      isFirst = false;
    } else if (current) {
      if (key === "HEAD") {
        current.head = value;
      } else if (key === "branch") {
        current.branch = value.replace(/^refs\/heads\//, "");
      } else if (key === "detached") {
        current.detached = true;
      } else if (key === "locked") {
        current.locked = true;
      }
    }
  }
  flush();
  return result;
}
