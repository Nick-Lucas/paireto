// Pure, vscode-free row builder for the repo/worktree switcher. Dedups candidates by canonical path
// (precedence Current > Worktrees > Recents) so a worktree that's also a recent — or a symlink-skewed
// duplicate (/var vs /private/var) — appears once, and labels every row branch-first (directory as the
// secondary description). The caller precomputes each candidate's canonical path (canonicalize()).

import * as path from "node:path";

export interface SwitcherCandidate {
  fsPath: string;
  /** Canonical (realpath'd) form of fsPath — the dedup key. */
  canonical: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
}

export interface SwitcherRow {
  fsPath: string;
  label: string;
  description?: string;
  detail: string;
}

export interface SwitcherSections {
  current?: SwitcherRow;
  worktrees: SwitcherRow[];
  recents: SwitcherRow[];
}

/** Branch-first label with directory as the secondary description; carries the locked annotation. */
function toRow(c: SwitcherCandidate): SwitcherRow {
  const base = path.basename(c.fsPath);
  const label = c.branch ?? (c.detached ? "(detached)" : base);
  const parts: string[] = [];
  // Show the directory only when the label is a branch and differs from the basename (keeps two
  // repos both on "main" distinguishable).
  if (c.branch !== undefined && c.branch !== base) {
    parts.push(base);
  }
  if (c.locked) {
    parts.push("locked");
  }
  return {
    fsPath: c.fsPath,
    label,
    description: parts.length > 0 ? parts.join(" · ") : undefined,
    detail: c.fsPath,
  };
}

/**
 * Build the switcher's three sections, deduping by canonical path with precedence
 * Current > Worktrees > Recents (a canonical claimed by an earlier section is dropped from later ones).
 */
export function buildSwitcherSections(
  current: SwitcherCandidate | undefined,
  worktrees: SwitcherCandidate[],
  recents: SwitcherCandidate[],
): SwitcherSections {
  const seen = new Set<string>();
  const claim = (c: SwitcherCandidate): boolean => {
    if (seen.has(c.canonical)) {
      return false;
    }
    seen.add(c.canonical);
    return true;
  };

  const sections: SwitcherSections = { worktrees: [], recents: [] };
  if (current && claim(current)) {
    sections.current = toRow(current);
  }
  for (const w of worktrees) {
    if (claim(w)) {
      sections.worktrees.push(toRow(w));
    }
  }
  for (const r of recents) {
    if (claim(r)) {
      sections.recents.push(toRow(r));
    }
  }
  return sections;
}
