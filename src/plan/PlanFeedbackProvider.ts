// The Plan Review sidebar panel — visible only while a plan review is pending (when: tui.planPending).
// Lists the gathered plan comments; Approve / Send Feedback live in this panel's title bar.

import * as vscode from "vscode";

import { kindColorId, kindIcon, kindLabel } from "../comments/kinds.js";
import type { PlanReviewController } from "./PlanReviewController.js";
import type { PlanCommentData } from "./planFeedback.js";

export class PlanFeedbackProvider
  implements vscode.TreeDataProvider<PlanCommentData>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly controller: PlanReviewController) {
    this.sub = controller.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(c: PlanCommentData): vscode.TreeItem {
    const item = new vscode.TreeItem(`Line ${c.line + 1}`, vscode.TreeItemCollapsibleState.None);
    item.description = c.body;
    const colorId = kindColorId(c.kind);
    item.iconPath = new vscode.ThemeIcon(
      kindIcon(c.kind),
      colorId ? new vscode.ThemeColor(colorId) : undefined
    );
    item.tooltip = new vscode.MarkdownString(
      `**${kindLabel(c.kind)}** · line ${c.line + 1}\n\n> ${c.quote}\n\n${c.body}`
    );
    return item;
  }

  getChildren(): PlanCommentData[] {
    return this.controller.getComments();
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
