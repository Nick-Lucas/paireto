// The repo/worktree switcher QuickPick (status bar click or Cmd/Ctrl+Shift+K). Sections: current
// window, worktrees of the current repo, recent repos.
//
// Window target: plain Enter opens in a NEW window; Shift+Enter opens in THIS window (shift == this
// window). VS Code's QuickPick API exposes no live modifier-hold state, so this is wired as an
// alternate-accept keybinding (paireto.switcher.openInThisWindow) gated on a context key set
// while the switcher is visible — the title spells out the mapping. The per-row button mirrors it.

import * as fs from "node:fs";

import * as vscode from "vscode";

import { summarizeActivity } from "../agents/activitySummary.js";
import { repoSnapshots, type RepoSnapshot } from "../bridge/ActivitySnapshot.js";
import { Commands } from "../config.js";
import { currentBranch } from "../git/gitCli.js";
import type { RepoService } from "../git/RepoService.js";
import type { WorktreeService } from "../git/WorktreeService.js";
import { canonicalize } from "../protocol/paths.js";
import type { RecentRepoStore } from "../storage/RecentRepoStore.js";
import {
  buildSwitcherSections,
  type SwitcherCandidate,
  type SwitcherRow,
  type SwitcherSections,
} from "./switcherRows.js";

const CONTEXT_VISIBLE = "paireto.switcherVisible";

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
  private currentCanonical?: string;
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
      vscode.commands.registerCommand(Commands.switcherOpenInThisWindow, () =>
        this.acceptHighlighted(false),
      ),
    );
  }

  async show(): Promise<void> {
    const current = this.repoService.currentRoot();
    const currentCand: SwitcherCandidate | undefined = current
      ? {
          fsPath: current.uri.fsPath,
          canonical: canonicalize(current.uri.fsPath),
          branch: current.branch,
        }
      : undefined;
    this.currentCanonical = currentCand?.canonical;

    let worktreeCands: SwitcherCandidate[] = [];
    if (current) {
      const list = await this.worktrees.list(current.uri.fsPath);
      worktreeCands = list.map((w) => ({
        fsPath: w.path,
        canonical: canonicalize(w.path),
        branch: w.branch,
        detached: w.detached,
        locked: w.locked,
      }));
    }

    // Recents: skip directories that no longer exist (cheap — max ~12 entries). Branch is unknown at
    // open; rows start with basename labels and get branch-first labels once the live fetch resolves.
    const recentCands: SwitcherCandidate[] = this.recents
      .list()
      .filter((r) => fs.existsSync(r.fsPath))
      .map((r) => ({ fsPath: r.fsPath, canonical: canonicalize(r.fsPath) }));

    const qp = vscode.window.createQuickPick<SwitchItem>();
    qp.title = "Switch Repository / Worktree";
    qp.placeholder = "Shift+Enter to open in current window";
    qp.items = this.buildItems(buildSwitcherSections(currentCand, worktreeCands, recentCands));
    qp.matchOnDetail = true;
    this.active = qp;
    void vscode.commands.executeCommand("setContext", CONTEXT_VISIBLE, true);

    // Live-fetch recent-repo branches (persisting them would go stale immediately) and rebuild the
    // labels branch-first once they resolve — only if this same picker is still showing.
    if (recentCands.length > 0) {
      qp.busy = true;
      void Promise.all(
        recentCands.map(async (c) => [c.fsPath, await currentBranch(c.fsPath)] as const),
      ).then((pairs) => {
        if (this.active !== qp) {
          return;
        }
        const branchByPath = new Map(pairs);
        const sections = buildSwitcherSections(
          currentCand,
          worktreeCands,
          recentCands.map((c) => ({ ...c, branch: branchByPath.get(c.fsPath) })),
        );
        const prevActive = qp.activeItems[0]?.fsPath;
        const newItems = this.buildItems(sections);
        qp.items = newItems;
        const match = prevActive && newItems.find((i) => i.fsPath === prevActive);
        if (match) {
          qp.activeItems = [match];
        }
        qp.busy = false;
      });
    }

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

  /** Map the builder's sections to QuickPick items: separators, icons, buttons, activity annotation. */
  private buildItems(sections: SwitcherSections): SwitchItem[] {
    const items: SwitchItem[] = [];
    items.push({ label: "Current Repository", kind: vscode.QuickPickItemKind.Separator });
    if (sections.current) {
      items.push(this.toItem(sections.current, new vscode.ThemeIcon("repo"), false));
    }
    if (sections.worktrees.length > 0) {
      for (const row of sections.worktrees) {
        items.push(this.toItem(row, new vscode.ThemeIcon("git-branch"), true));
      }
    }
    if (sections.recents.length > 0) {
      items.push({ label: "Recent repositories", kind: vscode.QuickPickItemKind.Separator });
      for (const row of sections.recents) {
        items.push(this.toItem(row, new vscode.ThemeIcon("history"), true));
      }
    }

    // Annotate each row with its agent activity (from other windows' published summaries) and whether
    // the repo even has an open window. A repo whose agent is waiting gets the orange bell left icon.
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
    return items;
  }

  private toItem(row: SwitcherRow, icon: vscode.ThemeIcon, withButton: boolean): SwitchItem {
    return {
      iconPath: icon,
      label: row.label,
      description: row.description,
      detail: row.detail,
      fsPath: row.fsPath,
      buttons: withButton ? [THIS_WINDOW_BUTTON] : undefined,
    };
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
    if (!newWindow && this.currentCanonical && canonicalize(fsPath) === this.currentCanonical) {
      return; // already here (canonical compare handles /var vs /private/var skew)
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
