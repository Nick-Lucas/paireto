// Computes the grouped "Changes" model (Staged / Unstaged / Committed) and the base/modified content
// refs per file, plus the git write-ops (stage/unstage/discard). Uses the git CLI for exact behavior;
// the ReviewContentProvider resolves the returned ContentRefs to actual text.

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { git, gitSafe, splitNul } from "./gitCli.js";
import type { CompareTo, FileGroup, FileLayout } from "../types.js";

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "U"; // U = untracked

export interface ChangedFile {
  path: string; // repo-relative (the "new" path for renames)
  oldPath?: string;
  status: FileStatus;
  group: FileGroup;
  additions: number;
  deletions: number;
}

export interface ChangesModel {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  committed: ChangedFile[];
  /** Human label for the resolved Compare-To point (e.g. "main", "merge-base"). */
  compareLabel: string;
  /** Resolved ref the committed group is diffed against, or null when Compare-To = HEAD. */
  compareRef: string | null;
}

/** A reference the content provider knows how to read. */
export type ContentRef =
  | { kind: "empty" }
  | { kind: "working" }
  | { kind: "index" }
  | { kind: "ref"; ref: string };

export interface FileSides {
  base: ContentRef;
  modified: ContentRef;
}

/** Replace a tab's comparison point without changing the content shown on its modified side. */
export function withBaseComparison(sides: FileSides, base: ContentRef): FileSides {
  return { base, modified: sides.modified };
}

/**
 * Which side to show in a SINGLE editor (no diff) for an add or delete — there's nothing to diff
 * against the empty side, and a two-pane diff would render a broken/empty pane (fatal for an image
 * viewer). A delete (no modified) shows the `base`; an add (no base) shows the `modified`. Returns
 * `null` when both sides have content, i.e. a real modification → keep the two-pane diff.
 */
export function singlePaneSide(sides: FileSides): "base" | "modified" | null {
  if (sides.modified.kind === "empty") {
    return "base";
  }
  if (sides.base.kind === "empty") {
    return "modified";
  }
  return null;
}

type Counts = Map<string, { additions: number; deletions: number }>;

export class DiffService {
  /** Build the grouped Changes model for the given Compare-To point. */
  async getChanges(repoRoot: string, compareTo: CompareTo): Promise<ChangesModel> {
    const resolved = await this.resolveCompareTo(repoRoot, compareTo);
    const { staged, unstaged, committed } = await this.scan(repoRoot, resolved.ref);
    const sort = (a: ChangedFile, b: ChangedFile): number => a.path.localeCompare(b.path);
    return {
      staged: staged.sort(sort),
      unstaged: unstaged.sort(sort),
      committed: committed.sort(sort),
      compareLabel: resolved.label,
      compareRef: resolved.ref,
    };
  }

  /**
   * The scoped equivalent of {@link getChanges} for ONE file: the current entries for the given
   * paths (matched by path, or a rename's old path), against an already-resolved compare ref. Lets
   * openDiff sync a single file without the full model rebuild.
   */
  async changesForPath(
    repoRoot: string,
    relPaths: string[],
    compareRef: string | null,
  ): Promise<ChangedFile[]> {
    const { staged, unstaged, committed } = await this.scan(repoRoot, compareRef, relPaths);
    return [...staged, ...unstaged, ...committed];
  }

  /**
   * The one working-state scan behind {@link getChanges} and {@link changesForPath} — shared so the
   * group a path lands in (notably the committed-while-also-staged/unstaged suppression) can never
   * diverge between the tree's model and openDiff's scoped sync. Optional `paths` scope the result
   * to the given files.
   */
  private async scan(
    repoRoot: string,
    compareRef: string | null,
    paths: string[] = [],
  ): Promise<{ staged: ChangedFile[]; unstaged: ChangedFile[]; committed: ChangedFile[] }> {
    // Tracked diffs are NEVER pathspec-limited: git pairs a rename only when BOTH sides are inside
    // the pathspec, so scoping to one side degrades the R into a phantom D/A the full scan would
    // never report. Run them whole and filter afterwards.
    const stagedAll = await this.collect(repoRoot, ["diff", "--cached"], "staged");
    const unstagedAll = await this.collect(repoRoot, ["diff"], "unstaged");

    // Committed = changed between Compare-To and HEAD, minus anything already staged/unstaged (the
    // `here` filter below). A bad/unresolvable compare ref is a persistent condition, so degrade to
    // empty here rather than failing the whole model (staged/unstaged failures, by contrast,
    // propagate and keep last-good).
    let committedAll: ChangedFile[] = [];
    if (compareRef) {
      try {
        committedAll = await this.collect(repoRoot, ["diff", compareRef, "HEAD"], "committed");
      } catch {
        committedAll = [];
      }
    }

    // A scoped scan must return EVERY entry mergeChangesForPath will count as affected: a matched
    // rename widens the scope with its other half, which can itself match further entries (an edit
    // at the rename's new path, a chained rename) — so widen to a fixpoint. An entry at a widened
    // path missing from the result would be dropped from the merged model with no replacement.
    const scoped = widenAcrossRenames(paths, [...stagedAll, ...unstagedAll, ...committedAll]);
    const scope = (files: ChangedFile[]): ChangedFile[] =>
      scoped === undefined ? files : files.filter((f) => matchesPaths(f, scoped));
    const staged = scope(stagedAll);
    const unstaged = scope(unstagedAll);

    // Untracked files are working-tree changes → Unstaged group. ls-files keeps the (widened)
    // pathspec — untracked files can't be rename halves, and the untracked walk is the expensive
    // call here. `:(literal)` so a path starting with ':' (pathspec magic) or holding glob
    // characters still matches itself exactly.
    const pathspec =
      scoped === undefined ? [] : ["--", ...[...scoped].map((p) => `:(literal)${p}`)];
    const untrackedOut = await gitSafe(repoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...pathspec,
    ]);
    for (const p of splitNul(untrackedOut)) {
      unstaged.push({
        path: p,
        status: "U",
        group: "unstaged",
        additions: await countLines(repoRoot, p),
        deletions: 0,
      });
    }

    // The widened scope keeps this suppression in full-scan parity: a committed entry in scope has
    // both rename halves in scope, so any staged/unstaged/untracked change at its path is in `here`.
    const here = new Set([...staged, ...unstaged].map((f) => f.path));
    const committed = scope(committedAll).filter((f) => !here.has(f.path));
    return { staged, unstaged, committed };
  }

  /** Run a name-status diff + numstat for one group and merge the line counts.
   *  name-status uses {@link git} (throwing) so a transient git failure surfaces as an error rather
   *  than a spurious "no changes" — the caller keeps the last good model instead of blanking it. */
  private async collect(
    repoRoot: string,
    diffArgs: string[],
    group: FileGroup,
  ): Promise<ChangedFile[]> {
    const nameStatus = (await git(repoRoot, [...diffArgs, "--name-status", "-z"])).stdout;
    const files = parseNameStatus(nameStatus, group);
    const counts = parseNumstat(await gitSafe(repoRoot, [...diffArgs, "--numstat", "-z"]));
    for (const f of files) {
      const c = counts.get(f.path);
      if (c) {
        f.additions = c.additions;
        f.deletions = c.deletions;
      }
    }
    return files;
  }

  /** Resolve a Compare-To descriptor to a concrete ref (null = HEAD, no committed group) + label. */
  async resolveCompareTo(
    repoRoot: string,
    compareTo: CompareTo,
  ): Promise<{ ref: string | null; label: string }> {
    switch (compareTo.kind) {
      case "head":
        return { ref: null, label: "HEAD" };
      case "default": {
        const branch = await this.defaultBranch(repoRoot);
        return { ref: branch ?? null, label: branch ?? "default" };
      }
      case "mergeBase": {
        const branch = await this.defaultBranch(repoRoot);
        if (!branch) {
          return { ref: null, label: "merge-base" };
        }
        const base = (await gitSafe(repoRoot, ["merge-base", branch, "HEAD"])).trim();
        return { ref: base || branch, label: `merge-base(${branch})` };
      }
      case "ref":
        return { ref: compareTo.ref ?? null, label: compareTo.ref ?? "HEAD" };
    }
  }

  /** True when the repository can resolve the name to a commit. */
  async refExists(repoRoot: string, ref: string): Promise<boolean> {
    const out = await gitSafe(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return out.trim().length > 0;
  }

  /** Auto-detect the default branch (main/master/origin's HEAD), or undefined. */
  async defaultBranch(repoRoot: string): Promise<string | undefined> {
    const head = (
      await gitSafe(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    ).trim();
    if (head) {
      return head; // e.g. "origin/main"
    }
    for (const candidate of ["main", "master"]) {
      const ok = await gitSafe(repoRoot, ["rev-parse", "--verify", "--quiet", candidate]);
      if (ok.trim()) {
        return candidate;
      }
    }
    return undefined;
  }

  /** List local + remote branches (for the Compare-To "Branch/Ref…" picker). */
  async listRefs(repoRoot: string): Promise<string[]> {
    const out = await gitSafe(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--sort=-committerdate",
      "-z",
      "refs/heads",
      "refs/remotes",
    ]);
    return splitNul(out).filter((r) => r.length > 0 && !r.endsWith("/HEAD"));
  }

  /** Resolve base/modified content refs for a file, given the committed group's compare ref. */
  fileSides(file: ChangedFile, compareRef: string | null): FileSides {
    if (file.group === "staged") {
      return wrapDeleted(file, { kind: "ref", ref: "HEAD" }, { kind: "index" });
    }
    if (file.group === "unstaged") {
      if (file.status === "U") {
        return { base: { kind: "empty" }, modified: { kind: "working" } };
      }
      return wrapDeleted(file, { kind: "index" }, { kind: "working" });
    }
    // committed
    const base: ContentRef = compareRef
      ? { kind: "ref", ref: compareRef }
      : { kind: "ref", ref: "HEAD" };
    return wrapDeleted(file, base, { kind: "ref", ref: "HEAD" });
  }

  // ── Git write-ops (operate on repo-relative paths) ─────────────────────────
  async stage(repoRoot: string, paths: string[]): Promise<void> {
    await git(repoRoot, ["add", "--", ...paths]);
  }

  async unstage(repoRoot: string, paths: string[]): Promise<void> {
    await git(repoRoot, ["restore", "--staged", "--", ...paths]);
  }

  /** Discard working-tree changes: restore tracked files; delete untracked ones. */
  async discard(repoRoot: string, files: { path: string; untracked: boolean }[]): Promise<void> {
    const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
    const untracked = files.filter((f) => f.untracked).map((f) => f.path);
    if (tracked.length) {
      await git(repoRoot, ["restore", "--", ...tracked]);
    }
    for (const p of untracked) {
      await rm(join(repoRoot, p), { force: true });
    }
  }

  /** Encode a ContentRef as the `ref` query value used in paireto-review URIs. */
  static encodeRef(ref: ContentRef): string {
    switch (ref.kind) {
      case "empty":
        return "EMPTY";
      case "working":
        return "WORKING";
      case "index":
        return "INDEX";
      case "ref":
        return ref.ref;
    }
  }

  /** Decode the provider token carried by an open diff back into its domain reference. */
  static decodeRef(ref: string): ContentRef {
    if (ref === "EMPTY") {
      return { kind: "empty" };
    }
    if (ref === "WORKING") {
      return { kind: "working" };
    }
    if (ref === "INDEX") {
      return { kind: "index" };
    }
    return { kind: "ref", ref };
  }
}

/** True when the file is in the scoped repo-relative path set — by its path or, for a rename, its
 *  old path (so either half of a rename pair matches). */
function matchesPaths(file: ChangedFile, paths: ReadonlySet<string>): boolean {
  return paths.has(file.path) || (file.oldPath !== undefined && paths.has(file.oldPath));
}

/** The scoped scan's effective path set: the requested paths plus, to a fixpoint, BOTH halves of
 *  every rename entry the set matches. `undefined` = unscoped. */
function widenAcrossRenames(paths: string[], entries: ChangedFile[]): Set<string> | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  const widened = new Set(paths);
  const renamePairs = entries.flatMap((f) =>
    f.oldPath === undefined ? [] : [[f.path, f.oldPath]],
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [a, b] of renamePairs) {
      const matched = widened.has(a) || widened.has(b);
      if (matched && !(widened.has(a) && widened.has(b))) {
        widened.add(a);
        widened.add(b);
        grew = true;
      }
    }
  }
  return widened;
}

/** Deleted files have no modified side; everything else uses the given sides. */
function wrapDeleted(file: ChangedFile, base: ContentRef, modified: ContentRef): FileSides {
  if (file.status === "D") {
    return { base, modified: { kind: "empty" } };
  }
  if (file.status === "A" || file.status === "U") {
    return { base: { kind: "empty" }, modified };
  }
  return { base, modified };
}

/** Parse `git diff --name-status -z` output, tagging each file with its group. */
export function parseNameStatus(output: string, group: FileGroup): ChangedFile[] {
  const tokens = splitNul(output);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (code === undefined || code === "") {
      continue;
    }
    const letter = code[0] as FileStatus;
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (newPath !== undefined) {
        files.push({ path: newPath, oldPath, status: letter, group, additions: 0, deletions: 0 });
      }
    } else {
      const p = tokens[i++];
      if (p !== undefined) {
        files.push({ path: p, status: normalizeStatus(letter), group, additions: 0, deletions: 0 });
      }
    }
  }
  return files;
}

/** Parse `git diff --numstat -z` into per-path counts. */
export function parseNumstat(output: string): Counts {
  const map: Counts = new Map();
  const tokens = splitNul(output);
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i]);
    if (!m) {
      continue;
    }
    let p = m[3];
    if (p === "") {
      // rename: next two tokens are old, new paths
      i += 1;
      p = tokens[i + 1] ?? tokens[i] ?? "";
      i += 1;
    }
    map.set(p, {
      additions: m[1] === "-" ? 0 : Number(m[1]),
      deletions: m[2] === "-" ? 0 : Number(m[2]),
    });
  }
  return map;
}

async function countLines(repoRoot: string, relPath: string): Promise<number> {
  try {
    const text = await readFile(join(repoRoot, relPath), "utf8");
    if (text === "") {
      return 0;
    }
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

function normalizeStatus(letter: string): FileStatus {
  if (letter === "A" || letter === "M" || letter === "D") {
    return letter;
  }
  return "M";
}

export type { FileLayout };
