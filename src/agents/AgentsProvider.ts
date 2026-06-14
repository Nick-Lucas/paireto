// The persistent "TUI Companion" sidebar panel: one status line per connected Claude session.
// Always visible (unlike the session-scoped review/plan panels). The Focus Agent title button
// brings the terminal area forward.

import * as path from "node:path";

import * as vscode from "vscode";

import type { AgentSessionService } from "./AgentSessionService.js";
import type { AgentSession, AgentState } from "../types.js";

const STATE_LABEL: Record<AgentState, string> = {
  idle: "idle",
  thinking: "thinking",
  toolRunning: "running tool",
  awaitingPlanApproval: "awaiting plan review",
  awaitingPermission: "awaiting permission",
  stopped: "stopped",
  ended: "ended",
};

const STATE_ICON: Record<AgentState, string> = {
  idle: "circle-outline",
  thinking: "loading~spin",
  toolRunning: "tools",
  awaitingPlanApproval: "comment-discussion",
  awaitingPermission: "warning",
  stopped: "primitive-square",
  ended: "circle-slash",
};

export class AgentsProvider implements vscode.TreeDataProvider<AgentSession>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly agents: AgentSessionService) {
    this.sub = agents.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(s: AgentSession): vscode.TreeItem {
    const repo = path.basename(s.repoRoot);
    const item = new vscode.TreeItem(repo, vscode.TreeItemCollapsibleState.None);
    const subs = s.subagentCount > 0 ? ` · ${s.subagentCount} sub` : "";
    item.description = `${STATE_LABEL[s.state]}${subs}`;
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[s.state]);
    item.tooltip = `${s.repoRoot}\nSession ${s.sessionId}\n${STATE_LABEL[s.state]}`;
    item.contextValue = "agentSession";
    return item;
  }

  getChildren(): AgentSession[] {
    return this.agents.allSessions().filter((s) => s.state !== "ended");
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
