// LRU list of recently opened repos, persisted in globalState (cross-workspace).

import * as path from "node:path";

import * as vscode from "vscode";

import { StateKeys } from "../config.js";

export interface RecentRepo {
  fsPath: string;
  label: string;
  lastOpenedMs: number;
}

const CAP = 12;

export class RecentRepoStore {
  constructor(private readonly memento: vscode.Memento) {}

  list(): RecentRepo[] {
    return this.memento
      .get<RecentRepo[]>(StateKeys.recentRepos, [])
      .slice()
      .sort((a, b) => b.lastOpenedMs - a.lastOpenedMs);
  }

  async touch(fsPath: string): Promise<void> {
    const existing = this.memento.get<RecentRepo[]>(StateKeys.recentRepos, []);
    const filtered = existing.filter((r) => r.fsPath !== fsPath);
    filtered.unshift({ fsPath, label: path.basename(fsPath), lastOpenedMs: Date.now() });
    await this.memento.update(StateKeys.recentRepos, filtered.slice(0, CAP));
  }
}
