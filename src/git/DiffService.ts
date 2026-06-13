// Computes the changed-file list and the base/modified content refs for each review mode, using
// the git CLI for exact behavior. Returns "content refs" that the ReviewContentProvider resolves
// to actual text (HEAD/branch/commit blob, the index, the working file, or empty).

import { git, gitSafe, splitNul } from "./gitCli.js";
import type { ReviewMode, ReviewSpec } from "../types.js";

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "U"; // U = untracked

export interface ChangedFile {
  path: string; // repo-relative (the "new" path for renames)
  oldPath?: string;
  status: FileStatus;
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

export class DiffService {
  /** List changed files for a review spec (plus untracked, if requested). */
  async listChanges(repoRoot: string, spec: ReviewSpec): Promise<ChangedFile[]> {
    const args = nameStatusArgs(spec);
    const out = await gitSafe(repoRoot, args);
    const files = parseNameStatus(out);

    if (spec.includeUntracked) {
      const untrackedOut = await gitSafe(repoRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      for (const p of splitNul(untrackedOut)) {
        files.push({ path: p, status: "U" });
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Resolve the base/modified content refs for a file under a given spec. */
  async fileSides(repoRoot: string, spec: ReviewSpec, file: ChangedFile): Promise<FileSides> {
    if (file.status === "U") {
      return { base: { kind: "empty" }, modified: { kind: "working" } };
    }
    if (file.status === "D") {
      return { base: await baseRef(repoRoot, spec), modified: { kind: "empty" } };
    }
    return { base: await baseRef(repoRoot, spec), modified: modifiedRef(spec) };
  }

  /** Encode a ContentRef as the `ref` query value used in tui-review URIs. */
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
}

function nameStatusArgs(spec: ReviewSpec): string[] {
  const common = ["--name-status", "-z"];
  switch (spec.mode) {
    case "unstaged":
      return ["diff", ...common];
    case "staged":
      return ["diff", "--cached", ...common];
    case "uncommitted":
      return ["diff", "HEAD", ...common];
    case "branch":
      return ["diff", `${spec.baseRef ?? "main"}...HEAD`, ...common];
    case "commitRange":
      return ["diff", spec.baseRef ?? "HEAD~1", spec.compareRef ?? "HEAD", ...common];
  }
}

function modifiedRef(spec: ReviewSpec): ContentRef {
  switch (spec.mode) {
    case "unstaged":
    case "uncommitted":
      return { kind: "working" };
    case "staged":
      return { kind: "index" };
    case "branch":
      return { kind: "ref", ref: spec.compareRef ?? "HEAD" };
    case "commitRange":
      return { kind: "ref", ref: spec.compareRef ?? "HEAD" };
  }
}

async function baseRef(repoRoot: string, spec: ReviewSpec): Promise<ContentRef> {
  switch (spec.mode) {
    case "unstaged":
      return { kind: "index" };
    case "staged":
    case "uncommitted":
      return { kind: "ref", ref: "HEAD" };
    case "branch": {
      const base = spec.baseRef ?? "main";
      const mergeBase = (await gitSafe(repoRoot, ["merge-base", base, "HEAD"])).trim();
      return { kind: "ref", ref: mergeBase || base };
    }
    case "commitRange":
      return { kind: "ref", ref: spec.baseRef ?? "HEAD~1" };
  }
}

/** Parse `git diff --name-status -z` output. Renames/copies consume two path tokens. */
export function parseNameStatus(output: string): ChangedFile[] {
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
        files.push({ path: newPath, oldPath, status: letter });
      }
    } else {
      const p = tokens[i++];
      if (p !== undefined) {
        files.push({ path: p, status: normalizeStatus(letter) });
      }
    }
  }
  return files;
}

function normalizeStatus(letter: string): FileStatus {
  if (letter === "A" || letter === "M" || letter === "D") {
    return letter;
  }
  return "M";
}

/** Detect whether the diff treats a path as binary (numstat shows "-\t-"). */
export async function isBinary(repoRoot: string, spec: ReviewSpec, p: string): Promise<boolean> {
  const args = nameStatusArgs(spec)
    .map((a) => (a === "--name-status" ? "--numstat" : a))
    .filter((a) => a !== "-z");
  const out = await gitSafe(repoRoot, [...args, "--", p]);
  return out.trim().startsWith("-\t-");
}

export type { ReviewMode };
export { git };
