// Wraps the built-in vscode.git extension to expose open repositories, the current repo, and a
// change event the status bar subscribes to. The Git API populates asynchronously, so we wire
// onDidOpenRepository rather than snapshotting api.repositories once.

import * as vscode from "vscode";

import type { API as GitAPI, GitExtension, Repository } from "./vscode-git.js";

export interface RepoInfo {
  root: vscode.Uri;
  branch?: string;
  commit?: string;
}

const DEBOUNCE_MS = 150;

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

  /** The repo containing the active editor, else the first open repo. */
  current(): RepoInfo | undefined {
    const repos = this.repositories;
    if (repos.length === 0) {
      return undefined;
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const containing = repos
        .filter((r) => activeUri.fsPath.startsWith(r.root.fsPath))
        .sort((a, b) => b.root.fsPath.length - a.root.fsPath.length)[0];
      if (containing) {
        return containing;
      }
    }
    return repos[0];
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
