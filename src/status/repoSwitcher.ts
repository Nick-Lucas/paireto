// The repo/worktree switcher QuickPick opened from the status bar. Sections: current window,
// worktrees of the current repo, recent repos. Each row can open same-window or new-window.

import * as path from "node:path";

import * as vscode from "vscode";

import type { RepoService } from "../git/RepoService.js";
import type { WorktreeService } from "../git/WorktreeService.js";
import type { RecentRepoStore } from "../storage/RecentRepoStore.js";

interface SwitchItem extends vscode.QuickPickItem {
  fsPath?: string;
}

const NEW_WINDOW_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("empty-window"),
  tooltip: "Open in new window",
};

export async function showRepoSwitcher(
  repoService: RepoService,
  worktrees: WorktreeService,
  recents: RecentRepoStore,
): Promise<void> {
  const current = repoService.current();
  const items: SwitchItem[] = [];

  items.push({ label: "Current window", kind: vscode.QuickPickItemKind.Separator });
  if (current) {
    items.push({
      label: `$(repo) ${path.basename(current.root.fsPath)}`,
      description: current.branch,
      detail: current.root.fsPath,
      fsPath: current.root.fsPath,
    });
  }

  if (current) {
    const list = await worktrees.list(current.root.fsPath);
    const others = list.filter((w) => w.path !== current.root.fsPath);
    if (others.length > 0) {
      items.push({ label: "Worktrees", kind: vscode.QuickPickItemKind.Separator });
      for (const w of others) {
        items.push({
          label: `$(git-branch) ${w.branch ?? (w.detached ? "(detached)" : path.basename(w.path))}`,
          description: w.locked ? "locked" : undefined,
          detail: w.path,
          fsPath: w.path,
          buttons: [NEW_WINDOW_BUTTON],
        });
      }
    }
  }

  const recentList = recents.list().filter((r) => r.fsPath !== current?.root.fsPath);
  if (recentList.length > 0) {
    items.push({ label: "Recent repositories", kind: vscode.QuickPickItemKind.Separator });
    for (const r of recentList) {
      items.push({
        label: `$(history) ${r.label}`,
        detail: r.fsPath,
        fsPath: r.fsPath,
        buttons: [NEW_WINDOW_BUTTON],
      });
    }
  }

  const qp = vscode.window.createQuickPick<SwitchItem>();
  qp.title = "Switch Repository / Worktree";
  qp.items = items;
  qp.matchOnDetail = true;

  const open = async (fsPath: string, newWindow: boolean): Promise<void> => {
    await recents.touch(fsPath);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(fsPath), {
      forceNewWindow: newWindow,
    });
  };

  qp.onDidTriggerItemButton(async (e) => {
    if (e.item.fsPath) {
      qp.hide();
      await open(e.item.fsPath, true);
    }
  });
  qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (sel?.fsPath && sel.fsPath !== current?.root.fsPath) {
      await open(sel.fsPath, false);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
