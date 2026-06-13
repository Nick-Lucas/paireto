// Serves base/modified file content for review diffs under the tui-review:// scheme. The URI
// carries the repo root, side, path, and a `ref` token resolved here to the right git blob, the
// index, the working-tree file, or empty content.
//
//   tui-review://<reviewId>/<side>/<relPath>?ref=<EMPTY|WORKING|INDEX|gitref>&repo=<encodedRoot>

import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { gitSafe } from "../git/gitCli.js";
import { Schemes } from "../config.js";

export class ReviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  /** Force a refresh of any open diff editors backed by these URIs. */
  refresh(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const ref = params.get("ref") ?? "EMPTY";
    const repoRoot = params.get("repo") ? decodeURIComponent(params.get("repo")!) : "";
    const relPath = stripSide(uri.path);

    if (ref === "EMPTY" || !repoRoot || !relPath) {
      return "";
    }
    if (ref === "WORKING") {
      try {
        return await fs.readFile(path.join(repoRoot, relPath), "utf8");
      } catch {
        return "";
      }
    }
    if (ref === "INDEX") {
      return gitSafe(repoRoot, ["show", `:${relPath}`]);
    }
    return gitSafe(repoRoot, ["show", `${ref}:${relPath}`]);
  }

  /** Build a content URI for one side of a file diff. */
  static buildUri(
    reviewId: string,
    side: "base" | "modified",
    relPath: string,
    ref: string,
    repoRoot: string,
  ): vscode.Uri {
    const query = new URLSearchParams({ ref, repo: encodeURIComponent(repoRoot) }).toString();
    return vscode.Uri.from({
      scheme: Schemes.review,
      authority: reviewId,
      path: `/${side}/${relPath}`,
      query,
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function stripSide(uriPath: string): string {
  // uriPath is "/base/<rel>" or "/modified/<rel>"
  const trimmed = uriPath.replace(/^\//, "");
  const slash = trimmed.indexOf("/");
  return slash === -1 ? "" : trimmed.slice(slash + 1);
}
