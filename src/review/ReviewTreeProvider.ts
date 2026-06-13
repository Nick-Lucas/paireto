// Renders the Code Review sidebar: header rows (mode / base / include-untracked) that open the
// selector QuickPicks, followed by the changed-file list. A plain TreeDataProvider — all state
// lives in the ReviewController.

import * as path from "node:path";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import type { ChangedFile } from "../git/DiffService.js";
import type { ReviewController } from "./ReviewController.js";

type Node =
  | { kind: "header"; id: string; label: string; command: string }
  | { kind: "file"; file: ChangedFile };

export class ReviewTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly controller: ReviewController) {
    this.sub = controller.onDidChangeState(() => this.emitter.fire());
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "header") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.command = { command: node.command, title: node.label };
      item.iconPath = new vscode.ThemeIcon("settings-gear");
      item.contextValue = "reviewHeader";
      return item;
    }
    const file = node.file;
    const item = new vscode.TreeItem(
      path.basename(file.path),
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = path.dirname(file.path) === "." ? undefined : path.dirname(file.path);
    item.resourceUri = vscode.Uri.file(file.path);
    item.iconPath = statusIcon(file.status);
    item.contextValue = "changedFile";
    item.command = {
      command: Commands.reviewOpenDiff,
      title: "Open Diff",
      arguments: [file],
    };
    return item;
  }

  getChildren(element?: Node): Node[] {
    if (element) {
      return [];
    }
    const state = this.controller.getState();
    const headers: Node[] = [
      {
        kind: "header",
        id: "mode",
        label: `Mode: ${state.spec.mode}`,
        command: Commands.reviewPickMode,
      },
      {
        kind: "header",
        id: "base",
        label: `Base: ${state.spec.baseRef ?? "—"}`,
        command: Commands.reviewPickBase,
      },
      {
        kind: "header",
        id: "untracked",
        label: `Untracked: ${state.spec.includeUntracked ? "on" : "off"}`,
        command: Commands.reviewToggleUntracked,
      },
    ];
    const files: Node[] = state.files.map((file) => ({ kind: "file", file }));
    return [...headers, ...files];
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

function statusIcon(status: ChangedFile["status"]): vscode.ThemeIcon {
  switch (status) {
    case "A":
      return new vscode.ThemeIcon("diff-added");
    case "D":
      return new vscode.ThemeIcon("diff-removed");
    case "R":
      return new vscode.ThemeIcon("diff-renamed");
    case "U":
      return new vscode.ThemeIcon("diff-added");
    default:
      return new vscode.ThemeIcon("diff-modified");
  }
}
