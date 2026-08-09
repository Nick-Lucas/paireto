// The guided-review model: an agent-authored plan that groups the changed files into named
// changesets, each with a description and an ordered reading list.
//
// Pure — no `vscode` import — so both halves are unit-testable on their own: `parseChangesets`
// sanitizes the wire payload once at the boundary, and `buildGuidedState` re-resolves the sanitized
// plan against the live Changes model. The plan holds only paths, never `ChangedFile` snapshots,
// because the model behind those is rebuilt wholesale on every refresh.

import type { CompareTo, CompareToKind, FileGroup } from "../types.js";
import type { RepoChangedFile, RepositoryReviewState } from "./ReviewController.js";

/** Bounds on the agent-authored payload. The plan travels as ONE NDJSON line over the socket and one
 *  MCP stdio line, so both the count and the text have to stay bounded. */
const MAX_CHANGESETS = 40;
const MAX_FILES_PER_CHANGESET = 200;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_NOTE = 300;

/** A sanitized changeset. `id` is minted from submission order so the tree and the git actions can
 *  refer to one changeset without carrying its (agent-authored, non-unique) title around. */
export interface ParsedChangeset {
  id: string;
  title: string;
  description: string;
  files: ParsedChangesetFile[];
}

export interface ParsedChangesetFile {
  path: string;
  note?: string;
}

/** The sanitized plan, held by ReviewController for the lifetime of one guided review. */
export interface GuidedPlan {
  repoRoot: string;
  summary?: string;
  /** What the agent diffed against; the window aligns its Compare To to this when the plan opens. */
  compareTo: CompareTo;
  changesets: ParsedChangeset[];
}

/** One row under a changeset. `file` is undefined when the named path no longer has a live change —
 *  the row still renders, saying so, rather than silently disappearing. */
export interface GuidedFileRow {
  changesetId: string;
  path: string;
  note?: string;
  file?: RepoChangedFile;
}

export interface GuidedChangesetState {
  id: string;
  title: string;
  description: string;
  files: GuidedFileRow[];
  missingCount: number;
  /** Files sitting in the working tree, so the row can offer Stage All only when it would do work. */
  stageableCount: number;
  /** Files sitting in the index, likewise for Unstage All. */
  unstageableCount: number;
}

export interface GuidedReviewState {
  repoRoot: string;
  summary?: string;
  compareTo: CompareTo;
  /** The agent's changesets, plus a trailing synthetic one holding every live change the plan did
   *  not name (see {@link OTHER_CHANGESET_ID}). */
  changesets: GuidedChangesetState[];
  fileTotal: number;
  missingTotal: number;
}

/** Id of the synthetic changeset holding the changes no changeset named, so the plan can never hide
 *  one. It is built here rather than in the view so its rows resolve through the same id lookup as
 *  every other row — a view-only bucket would leave every command on it inert. */
export const OTHER_CHANGESET_ID = "__other";
const OTHER_TITLE = "Other changes";
const OTHER_DESCRIPTION = "Changed files the review plan did not name.";

/**
 * Sanitize the agent-authored wire payload into a plan we are willing to render, or `undefined` when
 * nothing usable survives (the caller then fails open — no gate, benign tool result). The payload is
 * model output, so nothing in it is trusted: paths are normalized and confined to the repository,
 * text is trimmed and capped, and malformed entries are dropped rather than rejected wholesale.
 */
export function parseChangesets(raw: unknown): ParsedChangeset[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const changesets: ParsedChangeset[] = [];
  for (const entry of raw.slice(0, MAX_CHANGESETS)) {
    const changeset = parseChangeset(entry, changesets.length);
    if (changeset) {
      changesets.push(changeset);
    }
  }
  return changesets.length > 0 ? changesets : undefined;
}

function parseChangeset(raw: unknown, index: number): ParsedChangeset | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const title = cap(text(raw.title), MAX_TITLE);
  if (!title) {
    return undefined;
  }
  const files: ParsedChangesetFile[] = [];
  const seen = new Set<string>();
  const rawFiles = Array.isArray(raw.files) ? raw.files : [];
  for (const rawFile of rawFiles) {
    if (files.length >= MAX_FILES_PER_CHANGESET) {
      break;
    }
    const file = parseChangesetFile(rawFile);
    if (file && !seen.has(file.path)) {
      seen.add(file.path);
      files.push(file);
    }
  }
  if (files.length === 0) {
    return undefined;
  }
  return {
    id: `cs${index}`,
    title,
    description: cap(text(raw.description), MAX_DESCRIPTION),
    files,
  };
}

function parseChangesetFile(raw: unknown): ParsedChangesetFile | undefined {
  // A bare string is accepted alongside the documented object form — models reach for the shorthand.
  const source = typeof raw === "string" ? { path: raw } : raw;
  if (!isRecord(source)) {
    return undefined;
  }
  const path = normalizePath(text(source.path));
  if (!path) {
    return undefined;
  }
  const note = cap(text(source.note), MAX_NOTE);
  return note ? { path, note } : { path };
}

/**
 * Normalize a repository-relative path, or `undefined` when it is unusable. Absolute paths and any
 * path that climbs out of the repository are rejected outright — the plan can only ever point at
 * files inside the repository whose socket delivered it.
 */
export function normalizePath(raw: string): string | undefined {
  const slashed = raw.replaceAll("\\", "/").trim();
  if (!slashed || slashed.startsWith("/") || /^[a-zA-Z]:\//.test(slashed)) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return undefined;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

/**
 * Resolve a sanitized plan against the live Changes model. Called fresh on every `getState()` —
 * never cached — because `refresh()` replaces the repository models wholesale, so a cached
 * `ChangedFile` would go stale the moment the user saves or stages anything.
 */
export function buildGuidedState(
  plan: GuidedPlan,
  repositories: RepositoryReviewState[],
  resolve: (repository: RepositoryReviewState, path: string) => RepoChangedFile | undefined,
): GuidedReviewState {
  const repository = repositories.find((candidate) => candidate.repoRoot === plan.repoRoot);
  const claimed = new Set<string>();

  const changesets = plan.changesets.map((changeset) =>
    resolveChangeset(
      changeset.id,
      changeset.title,
      changeset.description,
      changeset.files,
      (path) => {
        const file = repository ? resolve(repository, path) : undefined;
        if (file) {
          claimed.add(file.path);
        }
        return file;
      },
    ),
  );

  const unclaimed = repository ? liveFiles(repository).filter((f) => !claimed.has(f.path)) : [];
  if (unclaimed.length > 0) {
    changesets.push(
      resolveChangeset(
        OTHER_CHANGESET_ID,
        OTHER_TITLE,
        OTHER_DESCRIPTION,
        unclaimed.map((file) => ({ path: file.path })),
        (path) => unclaimed.find((file) => file.path === path),
      ),
    );
  }

  return {
    repoRoot: plan.repoRoot,
    summary: plan.summary,
    compareTo: plan.compareTo,
    changesets,
    fileTotal: total(changesets, (c) => c.files.length),
    missingTotal: total(changesets, (c) => c.missingCount),
  };
}

function resolveChangeset(
  id: string,
  title: string,
  description: string,
  files: ParsedChangesetFile[],
  resolve: (path: string) => RepoChangedFile | undefined,
): GuidedChangesetState {
  const rows = files.map(
    (planned): GuidedFileRow => ({
      changesetId: id,
      path: planned.path,
      note: planned.note,
      file: resolve(planned.path),
    }),
  );
  const inGroup = (group: FileGroup): number =>
    rows.filter((row) => row.file?.group === group).length;
  return {
    id,
    title,
    description,
    files: rows,
    missingCount: rows.filter((row) => !row.file).length,
    stageableCount: inGroup("unstaged"),
    unstageableCount: inGroup("staged"),
  };
}

function total(
  changesets: GuidedChangesetState[],
  pick: (changeset: GuidedChangesetState) => number,
): number {
  return changesets.reduce((sum, changeset) => sum + pick(changeset), 0);
}

/** Every live changed file in a repository, deduped by path and sorted, for the unclaimed bucket. A
 *  partially-staged file appears in two groups; the reviewer only needs to be told about it once. */
function liveFiles(repository: RepositoryReviewState): RepoChangedFile[] {
  const byPath = new Map<string, RepoChangedFile>();
  for (const file of [
    ...repository.changes.unstaged,
    ...repository.changes.staged,
    ...repository.changes.committed,
  ]) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function toGuidedPlan(
  repoRoot: string,
  changesets: ParsedChangeset[],
  meta: { summary?: string; compareTo?: unknown },
): GuidedPlan {
  return {
    repoRoot,
    summary: cap(text(meta.summary), MAX_DESCRIPTION) || undefined,
    compareTo: parseCompareTo(meta.compareTo),
    changesets,
  };
}

const COMPARE_TO_KINDS: CompareToKind[] = ["head", "mergeBase", "default", "ref"];

/**
 * Read the agent's declared comparison point, falling back to HEAD. Agent output, so an unknown kind
 * or a `ref` kind with no ref degrades to HEAD rather than being trusted — HEAD shows the working
 * state, which is never wrong, only narrower than the agent may have meant.
 */
export function parseCompareTo(raw: unknown): CompareTo {
  if (!isRecord(raw)) {
    return { kind: "head" };
  }
  const kind = COMPARE_TO_KINDS.find((candidate) => candidate === raw.kind);
  if (!kind) {
    return { kind: "head" };
  }
  if (kind !== "ref") {
    return { kind };
  }
  const ref = cap(text(raw.ref), MAX_TITLE);
  return ref ? { kind, ref } : { kind: "head" };
}
