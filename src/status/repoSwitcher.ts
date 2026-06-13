// The repo/worktree switcher QuickPick (status bar click or Cmd/Ctrl+Shift+K). Sections: current
// window, worktrees of the current repo, recent repos.
//
// Window target: plain Enter opens in a NEW window; Shift+Enter opens in THIS window (shift == this
// window). VS Code's QuickPick API exposes no live modifier-hold state, so this is wired as an
// alternate-accept keybinding (tui-companion.switcher.acceptThisWindow) gated on a context key set
// while the switcher is visible — the title spells out the mapping. The per-row button mirrors it.

import * as path from "node:path";

import * as vscode from "vscode";

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

  constructor(
    private readonly repoService: RepoService,
    private readonly worktrees: WorktreeService,
    private readonly recents: RecentRepoStore,
  ) {
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
        label: `$(repo) ${path.basename(current.root.fsPath)}`,
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
            label: `$(git-branch) ${
              w.branch ?? (w.detached ? "(detached)" : path.basename(w.path))
            }`,
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
          label: `$(history) ${r.label}`,
          detail: r.fsPath,
          fsPath: r.fsPath,
          buttons: [THIS_WINDOW_BUTTON],
        });
      }
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
