// Renders the workspace-level status bar item: current repo · branch + Claude activity glyph.
// Re-renders on repo state changes and agent telemetry. Clicking opens the repo/worktree switcher.

import * as path from "node:path";

import * as vscode from "vscode";

import type { AgentSessionService, RepoActivity } from "../agents/AgentSessionService.js";
import { Commands } from "../config.js";
import type { RepoService } from "../git/RepoService.js";

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly repoService: RepoService,
    private readonly agents: AgentSessionService,
  ) {
    this.item = vscode.window.createStatusBarItem("tui.repo", vscode.StatusBarAlignment.Left, 100);
    this.item.name = "TUI Companion";
    this.item.command = Commands.openSwitcher;
    this.disposables.push(
      this.item,
      this.repoService.onDidChange(() => this.render()),
      this.agents.onDidChange(() => this.render()),
    );
    this.render();
  }

  render(): void {
    const repo = this.repoService.current();
    if (!repo) {
      this.item.hide();
      return;
    }
    const repoName = path.basename(repo.root.fsPath);
    const branch = repo.branch ?? "detached";
    const activity = this.agents.activityForRepo(repo.root.fsPath);
    const glyph = activityGlyph(activity);

    this.item.text = `$(repo) ${repoName} · ${branch}${glyph}`;
    this.item.tooltip = buildTooltip(repo.root.fsPath, branch, activity);
    this.item.backgroundColor = activityBackground(activity);
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function activityGlyph(activity: RepoActivity): string {
  if (activity.sessionCount === 0) {
    return "";
  }
  const agents = activity.sessionCount > 1 ? ` ${activity.sessionCount} agents` : "";
  const subs = activity.subagentCount > 0 ? ` (${activity.subagentCount} sub)` : "";
  // Waiting-for-you trumps the underlying state — make it unmissable.
  if (activity.needsAttention) {
    return ` $(bell-dot) needs you${subs}`;
  }
  switch (activity.state) {
    case "awaitingPlanApproval":
      return ` $(comment-discussion) plan review${subs}`;
    case "awaitingPermission":
      return ` $(warning) waiting${subs}`;
    case "toolRunning":
      return ` $(tools)${agents}${subs}`;
    case "thinking":
      return ` $(loading~spin)${agents}${subs}`;
    default:
      return agents ? ` $(circle-outline)${agents}` : "";
  }
}

function activityBackground(activity: RepoActivity): vscode.ThemeColor | undefined {
  if (activity.needsAttention) {
    return new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  return undefined;
}

function buildTooltip(root: string, branch: string, activity: RepoActivity): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Repository:** ${path.basename(root)}\n\n`);
  md.appendMarkdown(`**Path:** \`${root}\`\n\n`);
  md.appendMarkdown(`**Branch:** ${branch}\n\n`);
  if (activity.sessionCount > 0) {
    md.appendMarkdown(
      `**Claude:** ${activity.state} · ${activity.sessionCount} session(s)` +
        (activity.subagentCount > 0 ? ` · ${activity.subagentCount} subagent(s)` : "") +
        "\n\n",
    );
  } else {
    md.appendMarkdown(`**Claude:** idle\n\n`);
  }
  md.appendMarkdown(`_Click to switch repo / worktree_`);
  return md;
}
