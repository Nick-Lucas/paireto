// Reads the per-repo activity summaries (written by ActivityPublisher) plus the live index, so the
// repo/worktree switcher can show — from one window — what each OTHER repo's agents are doing and
// whether a repo even has an open window. Pure fs reads; no writes.

import * as fs from "node:fs";

import type { RepoActivity } from "../agents/AgentSessionService.js";
import { activityPath, repoKey } from "../protocol/paths.js";
import { IndexRegistry } from "./IndexRegistry.js";

/** The shape ActivityPublisher writes to `activity/<repoKey>.json`. */
export interface RepoActivityFile {
  version: number;
  repoRoot: string;
  repoKey: string;
  pid: number;
  updatedAt: string;
  activity: RepoActivity;
  needsAttention: boolean;
}

/** What the switcher needs about one repo: is a window open, and its last-published activity. */
export interface RepoSnapshot {
  open: boolean;
  activity?: RepoActivity;
  needsAttention: boolean;
}

export function readActivityFile(repoRoot: string): RepoActivityFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(activityPath(repoRoot), "utf8")) as RepoActivityFile;
    if (parsed && parsed.activity) {
      return parsed;
    }
  } catch {
    /* missing or corrupt */
  }
  return undefined;
}

/** Snapshot several repo roots at once (reads the live index just once). */
export function repoSnapshots(roots: string[]): Map<string, RepoSnapshot> {
  const liveKeys = new IndexRegistry().liveKeys();
  const out = new Map<string, RepoSnapshot>();
  for (const root of roots) {
    const file = readActivityFile(root);
    out.set(root, {
      open: liveKeys.has(repoKey(root)),
      activity: file?.activity,
      needsAttention: file?.needsAttention ?? false,
    });
  }
  return out;
}
