// QuickPicks for the review sidebar selectors (mode, base ref). Kept separate from the tree so the
// tree stays a plain data provider.

import * as vscode from "vscode";

import { gitSafe, splitNul } from "../git/gitCli.js";
import type { ReviewMode } from "../types.js";

const MODE_LABELS: Record<ReviewMode, string> = {
  unstaged: "Unstaged changes",
  staged: "Staged changes",
  uncommitted: "All uncommitted (vs HEAD)",
  branch: "Branch (base...HEAD)",
  commitRange: "Commit range (A..B)",
};

export async function pickMode(current: ReviewMode): Promise<ReviewMode | undefined> {
  const items = (Object.keys(MODE_LABELS) as ReviewMode[]).map((mode) => ({
    label: MODE_LABELS[mode],
    description: mode === current ? "current" : undefined,
    mode,
  }));
  const pick = await vscode.window.showQuickPick(items, { title: "Review mode" });
  return pick?.mode;
}

export async function pickBaseRef(
  repoRoot: string,
  current: string | undefined,
): Promise<string | undefined> {
  const out = await gitSafe(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "-z",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches = splitNul(out).filter((b) => b.length > 0);
  const items: vscode.QuickPickItem[] = branches.map((b) => ({
    label: b,
    description: b === current ? "current base" : undefined,
  }));
  items.unshift({ label: "$(edit) Enter ref manually…", alwaysShow: true });

  const pick = await vscode.window.showQuickPick(items, { title: "Base ref" });
  if (!pick) {
    return undefined;
  }
  if (pick.label.startsWith("$(edit)")) {
    return vscode.window.showInputBox({ title: "Base ref", value: current ?? "main" });
  }
  return pick.label;
}
