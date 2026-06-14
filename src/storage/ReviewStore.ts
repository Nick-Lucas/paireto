// Persists Changes-view state (Compare-To, layout, recent refs) in workspaceState and writes opt-in
// shareable review artifacts to .vscode/agent-reviews/<reviewId>.json.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { StateKeys } from "../config.js";
import type { CompareTo, FileLayout } from "../types.js";
import type { ReviewComment } from "../review/reviewTypes.js";

const DEFAULT_COMPARE_TO: CompareTo = { kind: "head" };
const MAX_RECENT_REFS = 3;

export class ReviewStore {
  constructor(private readonly memento: vscode.Memento) {}

  getCompareTo(): CompareTo {
    return this.memento.get<CompareTo>(StateKeys.compareTo, DEFAULT_COMPARE_TO);
  }

  async setCompareTo(value: CompareTo): Promise<void> {
    await this.memento.update(StateKeys.compareTo, value);
  }

  getLayout(): FileLayout {
    return this.memento.get<FileLayout>(StateKeys.fileLayout, "tree");
  }

  async setLayout(value: FileLayout): Promise<void> {
    await this.memento.update(StateKeys.fileLayout, value);
  }

  getRecentRefs(): string[] {
    return this.memento.get<string[]>(StateKeys.recentRefs, []);
  }

  /** Push a ref to the front of the MRU list (deduped, capped). */
  async addRecentRef(ref: string): Promise<void> {
    const next = [ref, ...this.getRecentRefs().filter((r) => r !== ref)].slice(0, MAX_RECENT_REFS);
    await this.memento.update(StateKeys.recentRefs, next);
  }

  async export(
    repoRoot: string,
    reviewId: string,
    compareLabel: string,
    comments: ReviewComment[]
  ): Promise<string> {
    const dir = path.join(repoRoot, ".vscode", "agent-reviews");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${reviewId}.json`);
    const artifact = {
      schemaVersion: 1,
      reviewId,
      repoRoot,
      compareTo: compareLabel,
      createdAt: new Date().toISOString(),
      comments,
    };
    await fs.writeFile(file, JSON.stringify(artifact, null, 2));
    return file;
  }
}
