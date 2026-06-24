// Publishes THIS window's per-repo agent activity to `$STATE/activity/<repoKey>.json` so other
// windows' switchers can summarize it. Agent state lives only in-memory per window and VS Code has
// no cross-window API, so the shared file is the bridge. One writer per repo (first-window-wins owns
// the socket and thus the telemetry), so writes are lock-free atomic tmp+rename.

import * as fs from "node:fs";

import * as vscode from "vscode";

import type { AgentSessionService } from "../agents/AgentSessionService.js";
import { activityDir, activityPath, canonicalize, repoKey } from "../protocol/paths.js";
import type { RepoActivityFile } from "./ActivitySnapshot.js";

const DEBOUNCE_MS = 250;

export class ActivityPublisher implements vscode.Disposable {
  private readonly sub: vscode.Disposable;
  private timer?: ReturnType<typeof setTimeout>;
  /** canonical repoRoot -> file path we've written, so we can delete files when a repo goes quiet. */
  private readonly written = new Map<string, string>();

  constructor(private readonly agents: AgentSessionService) {
    this.sub = agents.onDidChange(() => this.schedule());
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.publish();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private publish(): void {
    try {
      fs.mkdirSync(activityDir(), { recursive: true, mode: 0o700 });
    } catch {
      return; // can't create the dir — nothing to publish to
    }

    const roots = new Set<string>();
    for (const s of this.agents.allSessions()) {
      if (s.state !== "ended") {
        roots.add(s.repoRoot);
      }
    }

    const seen = new Set<string>();
    for (const root of roots) {
      const activity = this.agents.activityForRepo(root);
      if (activity.sessionCount === 0) {
        continue;
      }
      const file: RepoActivityFile = {
        version: 1,
        repoRoot: root,
        repoKey: repoKey(root),
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        activity,
        needsAttention: activity.needsAttention,
      };
      const p = activityPath(root);
      writeAtomic(p, file);
      const canon = canonicalize(root);
      this.written.set(canon, p);
      seen.add(canon);
    }

    // Drop files for repos that no longer have any live session.
    const stale: string[] = [];
    for (const [canon, p] of this.written) {
      if (!seen.has(canon)) {
        fs.rmSync(p, { force: true });
        stale.push(canon);
      }
    }
    for (const canon of stale) {
      this.written.delete(canon);
    }
  }

  dispose(): void {
    this.sub.dispose();
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const p of this.written.values()) {
      fs.rmSync(p, { force: true });
    }
    this.written.clear();
  }
}

function writeAtomic(filePath: string, file: RepoActivityFile): void {
  try {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    /* best-effort */
  }
}
