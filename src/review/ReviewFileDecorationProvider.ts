// Adds git-panel-style status badges + colors to changed-file rows. Scoped to the synthetic
// tui-review-file:// scheme so it never decorates real files in the explorer or editor tabs.
// The status letter is carried in the URI query (?status=M).

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import type { FileStatus } from "../git/DiffService.js";

const DECORATION: Record<FileStatus, { badge: string; color: string; tooltip: string }> = {
  A: { badge: "A", color: "gitDecoration.addedResourceForeground", tooltip: "Added" },
  M: { badge: "M", color: "gitDecoration.modifiedResourceForeground", tooltip: "Modified" },
  D: { badge: "D", color: "gitDecoration.deletedResourceForeground", tooltip: "Deleted" },
  R: { badge: "R", color: "gitDecoration.renamedResourceForeground", tooltip: "Renamed" },
  C: { badge: "C", color: "gitDecoration.renamedResourceForeground", tooltip: "Copied" },
  U: { badge: "U", color: "gitDecoration.untrackedResourceForeground", tooltip: "Untracked" },
};

export class ReviewFileDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== Schemes.reviewFile) {
      return undefined;
    }
    const status = (new URLSearchParams(uri.query).get("status") ?? "M") as FileStatus;
    const d = DECORATION[status] ?? DECORATION.M;
    return {
      badge: d.badge,
      color: new vscode.ThemeColor(d.color),
      tooltip: d.tooltip,
      propagate: false,
    };
  }

  /** Build the synthetic resourceUri for a changed-file row (carries status for decoration). */
  static fileUri(relPath: string, status: FileStatus): vscode.Uri {
    return vscode.Uri.from({
      scheme: Schemes.reviewFile,
      path: "/" + relPath,
      query: `status=${status}`,
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
