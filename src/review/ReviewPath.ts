// One class owns the paireto-review:// URI shape: serializing a diff side's file identity into a
// URI and parsing it back. The URI *path* is purely presentational — VS Code renders breadcrumbs
// and tab paths from its segments, so it holds the workspace-relative path of the real file, never
// a side marker. Identity rides in the query; `side` keeps a diff's two URIs distinct.
//
//   paireto-review://<reviewId>/<displayPath>?side=<base|modified>&path=<relPath>&ref=<EMPTY|WORKING|INDEX|gitref>&repo=<encodedRoot>

import * as path from "node:path";

import * as vscode from "vscode";

import { canonicalize, isInside } from "../protocol/paths.js";
import { Schemes } from "../config.js";

export type ReviewSide = "base" | "modified";

export interface WorkspaceFolderLike {
  name: string;
  fsPath: string;
}

export interface ReviewFile {
  /** The owning review session (rides as the URI authority). */
  reviewId: string;
  side: ReviewSide;
  /** Repo-relative path of the file. */
  relPath: string;
  /** Content ref token: EMPTY | WORKING | INDEX | \<gitref>. */
  ref: string;
  repoRoot: string;
}

export class ReviewPath implements ReviewFile {
  readonly reviewId: string;
  readonly side: ReviewSide;
  readonly relPath: string;
  readonly ref: string;
  readonly repoRoot: string;

  private constructor(
    file: ReviewFile,
    private readonly workspaceFolders: readonly WorkspaceFolderLike[] = liveWorkspaceFolders(),
  ) {
    this.reviewId = file.reviewId;
    this.side = file.side;
    this.relPath = file.relPath;
    this.ref = file.ref;
    this.repoRoot = file.repoRoot;
  }

  /** A review path from a diff side's file identity (the serializing direction). */
  static create(file: ReviewFile, workspaceFolders?: readonly WorkspaceFolderLike[]): ReviewPath {
    return new ReviewPath(file, workspaceFolders);
  }

  /** A review path parsed back off a URI built by `toUri` (the deserializing direction). */
  static fromUri(uri: vscode.Uri): ReviewPath {
    const params = new URLSearchParams(uri.query);
    const encodedRepo = params.get("repo");

    return new ReviewPath({
      reviewId: uri.authority,
      side: params.get("side") === "base" ? "base" : "modified",
      relPath: params.get("path") ?? "",
      ref: params.get("ref") ?? "EMPTY",
      repoRoot: encodedRepo ? decodeURIComponent(encodedRepo) : "",
    });
  }

  /**
   * Workspace-relative display path, mirroring `asRelativePath`'s defaults: relative to the CLOSEST
   * containing folder (most deeply nested wins, like `getWorkspaceFolder`), folder-name-prefixed
   * only when the window has multiple folders. Both sides are canonicalized so a symlinked folder
   * path (macOS /var vs the git-resolved /private/var repoRoot) still matches. Falls back to the
   * repo-relative path when the file is outside every folder.
   */
  displayPath(): string {
    const target = canonicalize(path.join(this.repoRoot, this.relPath));
    let best: { name: string; root: string } | undefined;
    for (const folder of this.workspaceFolders) {
      const root = canonicalize(folder.fsPath);
      if (isInside(root, target) && (!best || root.length > best.root.length)) {
        best = { name: folder.name, root };
      }
    }
    if (!best) {
      return this.relPath;
    }
    const rel = path.relative(best.root, target).split(path.sep).join("/");
    return this.workspaceFolders.length > 1 ? `${best.name}/${rel}` : rel;
  }

  toUri(): vscode.Uri {
    const query = new URLSearchParams({
      side: this.side,
      path: this.relPath,
      ref: this.ref,
      repo: encodeURIComponent(this.repoRoot),
    }).toString();
    return vscode.Uri.from({
      scheme: Schemes.review,
      authority: this.reviewId,
      path: `/${this.displayPath()}`,
      query,
    });
  }
}

function liveWorkspaceFolders(): WorkspaceFolderLike[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    fsPath: f.uri.fsPath,
  }));
}
