// Enumerates git worktrees (the Git extension API does not expose them). Always fetches fresh:
// there is no reliable invalidation signal (Claude Code's WorktreeCreate is a delegation hook we
// must not register, and worktrees made outside Claude fire nothing), and the only caller is the
// user-triggered switcher, where one fast `git worktree list` per open is fine.

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
  async list(repoRoot: string): Promise<WorktreeInfo[]> {
    const out = await gitSafe(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
    return parseWorktrees(out);
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
