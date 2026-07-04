// Wraps the built-in vscode.git extension to expose open repositories, the current repo, and a
// change event the status bar subscribes to. The Git API populates asynchronously, so we wire
// onDidOpenRepository rather than snapshotting api.repositories once.

import * as vscode from "vscode";

import { canonicalize, isInside } from "../protocol/paths.js";
import type { API as GitAPI, GitExtension, Repository } from "./vscode-git.js";

export interface RepoInfo {
  root: vscode.Uri;
  branch?: string;
  commit?: string;
}

const DEBOUNCE_MS = 150;

/**
 * Deterministically pick the repo this window is "in". Anchoring on the workspace folder (not
 * repos[0]) is the actual blank-list fix: a mid-review refresh with a virtual `paireto-review:` doc
 * active must not retarget a different discovered repo. Active editor is consulted ONLY for
 * `file:`-scheme docs; both sides are canonicalized (macOS /var skew) and the longest containing
 * root wins.
 */
export function pickCurrentRepo(
  repos: RepoInfo[],
  activeDoc: { scheme: string; fsPath: string } | undefined,
  primaryWorkspaceFolder: string | undefined,
): RepoInfo | undefined {
  if (repos.length === 0) {
    return undefined;
  }
  if (activeDoc && activeDoc.scheme === "file") {
    const byDoc = longestContaining(repos, activeDoc.fsPath);
    if (byDoc) {
      return byDoc;
    }
  }
  if (primaryWorkspaceFolder) {
    const byFolder = longestContaining(repos, primaryWorkspaceFolder);
    if (byFolder) {
      return byFolder;
    }
  }
  return repos[0]; // documented last resort
}

/** The repo whose canonical root contains-or-equals `target`, longest root winning ties. */
function longestContaining(repos: RepoInfo[], target: string): RepoInfo | undefined {
  const canonTarget = canonicalize(target);
  return repos
    .map((r) => ({ repo: r, root: canonicalize(r.root.fsPath) }))
    .filter((x) => isInside(x.root, canonTarget))
    .sort((a, b) => b.root.length - a.root.length)[0]?.repo;
}

export class RepoService implements vscode.Disposable {
  private api?: GitAPI;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoSubs = new Map<Repository, vscode.Disposable>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private debounce?: ReturnType<typeof setTimeout>;

  readonly onDidChange = this.changeEmitter.event;

  async init(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) {
      return;
    }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports.enabled) {
      // Git may still be enabling; getAPI is safe to call regardless.
    }
    this.api = exports.getAPI(1);

    this.disposables.push(
      this.api.onDidOpenRepository((r) => {
        this.registerRepo(r);
        this.fire();
      }),
      this.api.onDidCloseRepository((r) => {
        this.repoSubs.get(r)?.dispose();
        this.repoSubs.delete(r);
        this.fire();
      }),
    );
    for (const repo of this.api.repositories) {
      this.registerRepo(repo);
    }
    this.fire();
  }

  private registerRepo(repo: Repository): void {
    if (this.repoSubs.has(repo)) {
      return;
    }
    this.repoSubs.set(
      repo,
      repo.state.onDidChange(() => this.fire()),
    );
  }

  private fire(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => this.changeEmitter.fire(), DEBOUNCE_MS);
  }

  get repositories(): RepoInfo[] {
    if (!this.api) {
      return [];
    }
    return this.api.repositories.map((r) => ({
      root: r.rootUri,
      branch: r.state.HEAD?.name,
      commit: r.state.HEAD?.commit,
    }));
  }

  // TODO: in the future, perhaps we include multi-root vs code workspaces but just returning all active repos and subscribing to them all?
  /** The repo this window is in: workspace-folder anchored, active editor only for `file:` docs. */
  current(): RepoInfo | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeDoc = activeUri
      ? { scheme: activeUri.scheme, fsPath: activeUri.fsPath }
      : undefined;
    const primaryWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return pickCurrentRepo(this.repositories, activeDoc, primaryWorkspaceFolder);
  }

  dispose(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    for (const sub of this.repoSubs.values()) {
      sub.dispose();
    }
    this.repoSubs.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changeEmitter.dispose();
  }
}
