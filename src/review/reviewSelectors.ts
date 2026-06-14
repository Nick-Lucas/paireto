// The "Compare To" QuickPick: choose the point the Committed group is diffed against.
// Presets: HEAD, merge-base, the auto-detected default branch, up to 3 recent refs, and a
// Branch/Ref… picker (whose choice is added to the recents).

import * as vscode from "vscode";

import type { DiffService } from "../git/DiffService.js";
import type { CompareTo } from "../types.js";

interface CompareItem extends vscode.QuickPickItem {
  value?: CompareTo;
  pickRef?: boolean;
}

export async function pickCompareTo(
  repoRoot: string,
  diff: DiffService,
  recentRefs: string[]
): Promise<CompareTo | undefined> {
  const defaultBranch = await diff.defaultBranch(repoRoot);
  const items: CompareItem[] = [
    { label: "$(git-commit) HEAD", description: "working changes only", value: { kind: "head" } },
    { label: "$(git-pull-request) Merge base", description: "since you branched", value: { kind: "mergeBase" } },
  ];
  if (defaultBranch) {
    items.push({
      label: `$(git-branch) ${defaultBranch}`,
      description: "default branch",
      value: { kind: "default" },
    });
  }
  if (recentRefs.length) {
    items.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator });
    for (const ref of recentRefs) {
      items.push({ label: `$(history) ${ref}`, value: { kind: "ref", ref } });
    }
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(git-branch) Branch/Ref…", description: "pick any branch or ref", pickRef: true });

  const choice = await vscode.window.showQuickPick(items, { title: "Compare To" });
  if (!choice) {
    return undefined;
  }
  if (choice.pickRef) {
    return pickRef(repoRoot, diff);
  }
  return choice.value;
}

async function pickRef(repoRoot: string, diff: DiffService): Promise<CompareTo | undefined> {
  const refs = await diff.listRefs(repoRoot);
  const picked = await vscode.window.showQuickPick(refs, { title: "Compare To: branch / ref" });
  return picked ? { kind: "ref", ref: picked } : undefined;
}
