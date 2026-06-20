// Adds git-panel-style status badges + colors to changed-file rows. Scoped to the synthetic
// tui-review-file:// scheme so it never decorates real files in the explorer or editor tabs.
// The status letter is carried in the URI query (?status=M).

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import type { FileStatus } from "../git/DiffService.js";
import type { FileGroup } from "../types.js";

const DECORATION: Record<FileStatus, { badge: string; color: string; tooltip: string }> = {
  A: { badge: "A", color: "gitDecoration.addedResourceForeground", tooltip: "Added" },
  M: { badge: "M", color: "gitDecoration.modifiedResourceForeground", tooltip: "Modified" },
  D: { badge: "D", color: "gitDecoration.deletedResourceForeground", tooltip: "Deleted" },
  R: { badge: "R", color: "gitDecoration.renamedResourceForeground", tooltip: "Renamed" },
  C: { badge: "C", color: "gitDecoration.renamedResourceForeground", tooltip: "Copied" },
  U: { badge: "U", color: "gitDecoration.untrackedResourceForeground", tooltip: "Untracked" },
};

// Far-right file-count badge color per Changes group. The decoration color also tints the row
// label (VS Code has no badge-only color), which reads like the native git panel.
const GROUP_COLOR: Record<FileGroup, string> = {
  staged: "gitDecoration.addedResourceForeground",
  unstaged: "gitDecoration.modifiedResourceForeground",
  committed: "gitDecoration.submoduleResourceForeground",
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
    const params = new URLSearchParams(uri.query);

    // Group title row → far-right file-count badge (capped at 2 chars by VS Code).
    const group = params.get("group") as FileGroup | null;
    if (group) {
      const count = Number(params.get("count") ?? "0");
      return {
        badge: count > 99 ? "99" : String(count),
        color: new vscode.ThemeColor(GROUP_COLOR[group] ?? GROUP_COLOR.unstaged),
        tooltip: `${count} changed ${count === 1 ? "file" : "files"}`,
        propagate: false,
      };
    }

    const status = (params.get("status") ?? "M") as FileStatus;
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

  /** Synthetic resourceUri for a group title row (carries group + file count for the badge). */
  static groupUri(group: FileGroup, count: number): vscode.Uri {
    return vscode.Uri.from({
      scheme: Schemes.reviewFile,
      path: `/__group__/${group}`,
      query: `group=${group}&count=${count}`,
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
