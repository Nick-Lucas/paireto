// The repo/worktree switcher QuickPick (status bar click or Cmd/Ctrl+Shift+K). Sections: current
// window, worktrees of the current repo, recent repos.
//
// Window target: plain Enter opens in a NEW window; Shift+Enter opens in THIS window (shift == this
// window). VS Code's QuickPick API exposes no live modifier-hold state, so this is wired as an
// alternate-accept keybinding (tui-companion.switcher.acceptThisWindow) gated on a context key set
// while the switcher is visible — the title spells out the mapping. The per-row button mirrors it.

import * as path from "node:path";

import * as vscode from "vscode";

import { summarizeActivity } from "../agents/activitySummary.js";
import { repoSnapshots, type RepoSnapshot } from "../bridge/ActivitySnapshot.js";
import { Commands } from "../config.js";
import type { RepoService } from "../git/RepoService.js";
import type { WorktreeService } from "../git/WorktreeService.js";
import type { RecentRepoStore } from "../storage/RecentRepoStore.js";

const CONTEXT_VISIBLE = "tui.switcherVisible";

interface SwitchItem extends vscode.QuickPickItem {
  fsPath?: string;
}

const THIS_WINDOW_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("window"),
  tooltip: "Open in this window (Shift+Enter)",
};

export class RepoSwitcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private active?: vscode.QuickPick<SwitchItem>;
  private currentPath?: string;
  /** Left icon for a repo whose agent is waiting — a baked-orange SVG, since QuickPick ignores a
   *  ThemeColor on a ThemeIcon iconPath (the colour just wouldn't apply otherwise). */
  private readonly waitingIcon: vscode.Uri;

  constructor(
    private readonly repoService: RepoService,
    private readonly worktrees: WorktreeService,
    private readonly recents: RecentRepoStore,
    extensionUri: vscode.Uri,
  ) {
    this.waitingIcon = vscode.Uri.joinPath(extensionUri, "media", "bell-orange.svg");
    this.disposables.push(
      vscode.commands.registerCommand(Commands.openSwitcher, () => this.show()),
      vscode.commands.registerCommand(Commands.switcherAcceptThisWindow, () =>
        this.acceptHighlighted(false),
      ),
    );
  }

  async show(): Promise<void> {
    const current = this.repoService.current();
    this.currentPath = current?.root.fsPath;
    const items: SwitchItem[] = [];

    items.push({ label: "Current window", kind: vscode.QuickPickItemKind.Separator });
    if (current) {
      items.push({
        iconPath: new vscode.ThemeIcon("repo"),
        label: path.basename(current.root.fsPath),
        description: current.branch,
        detail: current.root.fsPath,
        fsPath: current.root.fsPath,
      });
    }

    if (current) {
      const list = await this.worktrees.list(current.root.fsPath);
      const others = list.filter((w) => w.path !== current.root.fsPath);
      if (others.length > 0) {
        items.push({ label: "Worktrees", kind: vscode.QuickPickItemKind.Separator });
        for (const w of others) {
          items.push({
            iconPath: new vscode.ThemeIcon("git-branch"),
            label: w.branch ?? (w.detached ? "(detached)" : path.basename(w.path)),
            description: w.locked ? "locked" : undefined,
            detail: w.path,
            fsPath: w.path,
            buttons: [THIS_WINDOW_BUTTON],
          });
        }
      }
    }

    const recentList = this.recents.list().filter((r) => r.fsPath !== this.currentPath);
    if (recentList.length > 0) {
      items.push({ label: "Recent repositories", kind: vscode.QuickPickItemKind.Separator });
      for (const r of recentList) {
        items.push({
          iconPath: new vscode.ThemeIcon("history"),
          label: r.label,
          detail: r.fsPath,
          fsPath: r.fsPath,
          buttons: [THIS_WINDOW_BUTTON],
        });
      }
    }

    // Annotate each row with its agent activity (from other windows' published summaries) and
    // whether the repo even has an open window. Reads are cheap fs lookups done once. A repo whose
    // agent is waiting gets the orange bell as its left icon so it's obvious at a glance.
    const snaps = repoSnapshots(items.flatMap((i) => (i.fsPath ? [i.fsPath] : [])));
    for (const item of items) {
      if (!item.fsPath) {
        continue;
      }
      const snap = snaps.get(item.fsPath);
      if (snap?.needsAttention) {
        item.iconPath = this.waitingIcon;
      }
      item.description = [item.description, activityText(snap)].filter(Boolean).join(" · ");
    }

    const qp = vscode.window.createQuickPick<SwitchItem>();
    qp.title = "Switch Repository / Worktree";
    qp.placeholder = "Shift+Enter to open in current window";
    qp.items = items;
    qp.matchOnDetail = true;
    this.active = qp;
    void vscode.commands.executeCommand("setContext", CONTEXT_VISIBLE, true);

    qp.onDidTriggerItemButton(async (e) => {
      // Button mirrors the Shift alternate: open in this window.
      if (e.item.fsPath) {
        qp.hide();
        await this.openFolder(e.item.fsPath, false);
      }
    });
    qp.onDidAccept(async () => {
      const sel = qp.selectedItems[0];
      qp.hide();
      if (sel?.fsPath) {
        await this.openFolder(sel.fsPath, true); // plain Enter -> new window
      }
    });
    qp.onDidHide(() => {
      void vscode.commands.executeCommand("setContext", CONTEXT_VISIBLE, false);
      this.active = undefined;
      qp.dispose();
    });
    qp.show();
  }

  /** Invoked by the Shift+Enter keybinding: open the highlighted row in this window. */
  private async acceptHighlighted(newWindow: boolean): Promise<void> {
    const qp = this.active;
    if (!qp) {
      return;
    }
    const item = qp.activeItems[0];
    qp.hide();
    if (item?.fsPath) {
      await this.openFolder(item.fsPath, newWindow);
    }
  }

  private async openFolder(fsPath: string, newWindow: boolean): Promise<void> {
    if (!newWindow && fsPath === this.currentPath) {
      return; // already here
    }
    await this.recents.touch(fsPath);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(fsPath), {
      forceNewWindow: newWindow,
    });
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.active?.dispose();
  }
}

/** Compact activity label for a switcher row: distinguishes "no window" / "open · idle" / live state. */
function activityText(snap?: RepoSnapshot): string {
  if (!snap?.open) {
    return "no window";
  }
  if (snap.needsAttention) {
    return summarizeActivity(snap.activity, true);
  }
  if (!snap.activity || snap.activity.sessionCount === 0) {
    return "open · idle";
  }
  return summarizeActivity(snap.activity);
}
