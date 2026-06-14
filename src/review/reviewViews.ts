// The two Code Review sidebar panels, both driven by ReviewController state:
//   1. Review   — changed files, git-panel-style (status color + badge + line counts). The mode/base
//                 selectors live in this panel's title bar; its description shows the current values.
//   2. Feedback — the gathered review comments.
// Plain TreeDataProviders; all state lives in the ReviewController.

import * as path from "node:path";

import * as vscode from "vscode";

import { kindColorId, kindIcon, kindLabel } from "../comments/kinds.js";
import { Commands } from "../config.js";
import type { ChangedFile } from "../git/DiffService.js";
import { ReviewFileDecorationProvider } from "./ReviewFileDecorationProvider.js";
import type { ReviewController } from "./ReviewController.js";
import type { ReviewComment } from "./reviewTypes.js";
import type { ReviewMode, ReviewSpec } from "../types.js";

const MODE_LABELS: Record<ReviewMode, string> = {
  unstaged: "Unstaged",
  staged: "Staged",
  uncommitted: "Uncommitted",
  branch: "Branch",
  commitRange: "Commit range",
};

/** Short current-selection summary shown as the Review panel's title description. */
export function reviewSummary(spec: ReviewSpec): string {
  const base = spec.mode === "branch" || spec.mode === "commitRange" ? ` · ${spec.baseRef ?? "—"}` : "";
  return `${MODE_LABELS[spec.mode]}${base}`;
}

abstract class BaseProvider<T> implements vscode.TreeDataProvider<T>, vscode.Disposable {
  protected readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(protected readonly controller: ReviewController) {
    this.sub = controller.onDidChangeState(() => this.emitter.fire());
  }

  abstract getTreeItem(element: T): vscode.TreeItem;
  abstract getChildren(element?: T): T[];

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

// ── 1. Review (changed files) ────────────────────────────────────────────────
export class ReviewFilesProvider extends BaseProvider<ChangedFile> {
  getTreeItem(file: ChangedFile): vscode.TreeItem {
    const item = new vscode.TreeItem(
      ReviewFileDecorationProvider.fileUri(file.path, file.status),
      vscode.TreeItemCollapsibleState.None
    );
    const dir = path.dirname(file.path);
    const counts = `+${file.additions} -${file.deletions}`;
    item.description = dir === "." ? counts : `${dir}  ${counts}`;
    item.tooltip = `${file.path}\n${statusWord(file.status)} · ${counts}`;
    item.contextValue = "changedFile";
    item.command = { command: Commands.reviewOpenDiff, title: "Open Diff", arguments: [file] };
    return item;
  }

  getChildren(): ChangedFile[] {
    return this.controller.getState().files;
  }
}

// ── 2. Feedback ──────────────────────────────────────────────────────────────
export class ReviewFeedbackProvider extends BaseProvider<ReviewComment> {
  getTreeItem(c: ReviewComment): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${path.basename(c.filePath)}:${c.line + 1}`,
      vscode.TreeItemCollapsibleState.None
    );
    const dir = path.dirname(c.filePath);
    item.description = dir === "." ? c.body : `${dir} · ${c.body}`;
    const colorId = kindColorId(c.kind);
    item.iconPath = new vscode.ThemeIcon(
      kindIcon(c.kind),
      colorId ? new vscode.ThemeColor(colorId) : undefined
    );
    item.tooltip = new vscode.MarkdownString(
      `**${kindLabel(c.kind)}** · ${c.filePath}:${c.line + 1}\n\n> ${c.quote}\n\n${c.body}`
    );
    item.contextValue = "reviewComment";
    // Click a row to jump back to the line/diff and expand the comment.
    item.command = {
      command: Commands.reviewRevealComment,
      title: "Reveal Comment",
      arguments: [c],
    };
    return item;
  }

  getChildren(): ReviewComment[] {
    return this.controller.getComments();
  }
}

function statusWord(s: ChangedFile["status"]): string {
  return { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked" }[s];
}
