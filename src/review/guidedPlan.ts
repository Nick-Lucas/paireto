// The guided-review model: an agent-authored plan that groups the changed files into named
// changesets, each with a description and an ordered reading list.
//
// Pure — no `vscode` import — so both halves are unit-testable on their own: `parseChangesets`
// sanitizes the wire payload once at the boundary, and `buildGuidedState` re-resolves the sanitized
// plan against the live Changes model. The plan holds only paths, never `ChangedFile` snapshots,
// because the model behind those is rebuilt wholesale on every refresh.

import { z } from "zod";
import { prettifyError } from "zod/v4";

import { CompareTo, GuidedChangeset, GuidedChangesetFile } from "../protocol/guidedReview.js";
import type { FileGroup } from "../types.js";
import type { RepoChangedFile, RepositoryReviewState } from "./ReviewController.js";

/** Bounds on the agent-authored payload. The plan travels as ONE NDJSON line over the socket and one
 *  MCP stdio line, so both the count and the text have to stay bounded. */
const MAX_CHANGESETS = 40;
const MAX_FILES_PER_CHANGESET = 200;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;

/** A sanitized changeset: the wire payload plus an `id` minted from submission order, so the tree and
 *  the git actions can refer to one changeset without carrying its (agent-authored, non-unique)
 *  title around. */
export interface ParsedChangeset extends GuidedChangeset {
  id: string;
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

/** A payload the agent has to fix. Its message is handed straight back as the tool's result. */
export class GuidedPlanError extends Error {}

/**
 * Sanitize the agent-authored wire payload into a plan we are willing to render. The payload is
 * model output, so nothing in it is trusted: text is trimmed and capped, and paths are normalized
 * and confined to the repository. Anything that survives none of that throws — the agent is the one
 * that can fix it, and a plan that quietly lost a changeset would be reviewed as if complete.
 */
export function parseChangesets(raw: unknown): ParsedChangeset[] {
  if (!Array.isArray(raw)) {
    throw new GuidedPlanError("changesets — expected an array of changesets");
  }
  if (raw.length === 0) {
    throw new GuidedPlanError("changesets — the plan named no changesets");
  }
  return raw
    .slice(0, MAX_CHANGESETS)
    .map((entry, index) => parseChangeset(entry, index, `changesets[${index}]`));
}

/**
 * The advertised schema, loosened where a model's near-miss is still usable: a missing file list
 * reads as empty, and a file may be a bare string — models reach for that shorthand. Each file is
 * validated on its own below, so one malformed entry costs its own row instead of the whole
 * changeset. The title and the description are checked below rather than here, so a missing one is
 * named in its own right instead of arriving as a schema error.
 */
const submittedChangesetSchema = z.object({
  title: z.string(),
  description: z.string().catch(""),
  files: z.array(z.unknown()).catch([]),
});

const submittedFileSchema = z.preprocess(
  (raw) => (typeof raw === "string" ? { path: raw } : raw),
  GuidedChangesetFile,
);

function parseChangeset(raw: unknown, index: number, where: string): ParsedChangeset {
  const submitted = submittedChangesetSchema.safeParse(raw);
  if (!submitted.success) {
    throw new GuidedPlanError(`${where} — ${prettifyError(submitted.error)}`);
  }
  const title = cap(submitted.data.title.trim(), MAX_TITLE);
  if (!title) {
    throw new GuidedPlanError(`${where}.title — a changeset needs a title`);
  }
  // The description is what the reviewer reads to learn why these files belong together — a
  // changeset without one is a bare file list, so the agent writes it before the review opens.
  const description = cap(submitted.data.description.trim(), MAX_DESCRIPTION);
  if (!description) {
    throw new GuidedPlanError(
      `${where}.description — a changeset needs a description saying why these files belong together`,
    );
  }
  const files: GuidedChangesetFile[] = [];
  const seen = new Set<string>();
  for (const [fileIndex, rawFile] of submitted.data.files.slice(0, MAX_FILES_PER_CHANGESET).entries()) {
    const file = parseChangesetFile(rawFile, `${where}.files[${fileIndex}]`);
    if (!seen.has(file.path)) {
      seen.add(file.path);
      files.push(file);
    }
  }
  if (files.length === 0) {
    throw new GuidedPlanError(`${where}.files — a changeset needs at least one file`);
  }
  return { id: `cs${index}`, title, description, files };
}

function parseChangesetFile(raw: unknown, where: string): GuidedChangesetFile {
  const submitted = submittedFileSchema.safeParse(raw);
  if (!submitted.success) {
    throw new GuidedPlanError(`${where} — ${prettifyError(submitted.error)}`);
  }
  const path = normalizePath(submitted.data.path);
  if (!path) {
    throw new GuidedPlanError(
      `${where} — "${submitted.data.path}" is not a path inside the repository`,
    );
  }
  return { path };
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
  files: GuidedChangesetFile[],
  resolve: (path: string) => RepoChangedFile | undefined,
): GuidedChangesetState {
  const rows = files.map(
    (planned): GuidedFileRow => ({
      changesetId: id,
      path: planned.path,
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

/**
 * Read the agent's declared comparison point. Omitting it means HEAD; declaring a bad one is an
 * error the agent has to fix — silently comparing against something it did not choose would show it
 * a review of changes it never grouped.
 */
export function parseCompareTo(raw: unknown): CompareTo {
  if (raw === undefined) {
    return { kind: "head" };
  }
  const submitted = CompareTo.safeParse(raw);
  if (!submitted.success) {
    throw new GuidedPlanError(`compareTo — ${prettifyError(submitted.error)}`);
  }
  const { kind, ref } = submitted.data;
  if (kind !== "ref") {
    return { kind };
  }
  const named = cap((ref ?? "").trim(), MAX_TITLE);
  if (!named) {
    throw new GuidedPlanError("compareTo — kind 'ref' needs the ref to compare against");
  }
  return { kind, ref: named };
}

/**
 * Check a plan's comparison point against the repository itself, returning the rejection message for
 * the agent or `undefined` when the plan can open. Only a named ref needs this — the other kinds are
 * computed from the repository, so they always resolve. A ref git cannot resolve leaves the committed
 * group empty, which would open a review missing the very changes the plan grouped.
 */
export async function verifyGuidedCompareTo(
  plan: GuidedPlan,
  refExists: (repoRoot: string, ref: string) => Promise<boolean>,
): Promise<string | undefined> {
  const { kind, ref } = plan.compareTo;
  if (kind !== "ref" || !ref) {
    return undefined;
  }
  return (await refExists(plan.repoRoot, ref))
    ? undefined
    : `compareTo — "${ref}" is not a ref this repository can resolve`;
}
