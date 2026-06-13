// Persists the selected review spec in workspaceState and writes opt-in shareable review
// artifacts to .vscode/agent-reviews/<reviewId>.json.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { StateKeys } from "../config.js";
import type { ReviewSpec } from "../types.js";
import type { ReviewComment } from "../review/reviewTypes.js";

const DEFAULT_SPEC: ReviewSpec = { mode: "uncommitted", baseRef: "main", includeUntracked: true };

export class ReviewStore {
  constructor(private readonly memento: vscode.Memento) {}

  getSpec(): ReviewSpec {
    return this.memento.get<ReviewSpec>(StateKeys.reviewSpec, DEFAULT_SPEC);
  }

  async setSpec(spec: ReviewSpec): Promise<void> {
    await this.memento.update(StateKeys.reviewSpec, spec);
  }

  async export(
    repoRoot: string,
    reviewId: string,
    spec: ReviewSpec,
    comments: ReviewComment[],
  ): Promise<string> {
    const dir = path.join(repoRoot, ".vscode", "agent-reviews");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${reviewId}.json`);
    const artifact = {
      schemaVersion: 1,
      reviewId,
      repoRoot,
      spec,
      createdAt: new Date().toISOString(),
      comments,
    };
    await fs.writeFile(file, JSON.stringify(artifact, null, 2));
    return file;
  }
}
