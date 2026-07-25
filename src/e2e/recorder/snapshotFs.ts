// Working-tree snapshots + deltas for tapes. The extension asserts file effects (hello.txt/bye.txt/
// note.txt) via the real filesystem, so a tape carries the repo's file changes as deltas: replay
// applies them so the same assertions pass with no harness ever writing anything. `.git`/`.vscode`
// are excluded (git internals + the seeded settings are not agent output). The sandbox repo is a
// handful of tiny files, so a full re-scan per snapshot is cheap.

import * as fs from "node:fs";
import * as path from "node:path";

import type { FsDelta } from "./tapeTypes.js";

const EXCLUDED_DIRS = new Set([".git", ".vscode"]);

/** Snapshot the working tree: repo-relative path → utf8 content (excluding `.git`/`.vscode`). */
export function snapshot(repoRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  walk(repoRoot, repoRoot, files);
  return files;
}

function walk(root: string, dir: string, out: Map<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      walk(root, path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    out.set(rel, fs.readFileSync(abs, "utf8"));
  }
}

/** The change from `prev` to `next`: added/changed files → content, removed files → null. */
export function computeDelta(prev: Map<string, string>, next: Map<string, string>): FsDelta {
  const files: Record<string, string | null> = {};
  for (const [rel, content] of next) {
    if (prev.get(rel) !== content) {
      files[rel] = content;
    }
  }
  for (const rel of prev.keys()) {
    if (!next.has(rel)) {
      files[rel] = null;
    }
  }
  return { files };
}

export function isEmptyDelta(delta: FsDelta): boolean {
  return Object.keys(delta.files).length === 0;
}

/** Apply a delta to the working tree: write/overwrite content, unlink nulls (best-effort). */
export function applyDelta(repoRoot: string, delta: FsDelta): void {
  for (const [rel, content] of Object.entries(delta.files)) {
    const abs = path.join(repoRoot, ...rel.split("/"));
    if (content === null) {
      fs.rmSync(abs, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}
