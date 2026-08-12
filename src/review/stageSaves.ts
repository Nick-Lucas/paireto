// Git stages the version of a file that is ON DISK. When an editor still holds unsaved edits for a
// file the user stages, the index gets content the user never sees, and the edits they meant to
// stage stay out of it. These helpers decide what to do about that, and word the messages. They are
// pure and vscode-free so the decision is testable without a running editor.

import { join } from "node:path";

import type { FileStatus } from "../git/DiffService.js";
import { canonicalize } from "../protocol/paths.js";

/** `paireto.review.saveBeforeStage`: what a stage does with unsaved changes in the target files. */
export type SaveBeforeStage = "prompt" | "always" | "never";

/** What the stage must do before it writes the index. */
export type StageSaveAction = "stage" | "save" | "ask";

/** The user's answer to the save prompt. */
export type StageSaveChoice = "save" | "stage" | "cancel";

export const SAVE_AND_STAGE = "Save and Stage";
export const STAGE_SAVED = "Stage Saved Version";

/** The fields we read from a `vscode.TextDocument`. */
interface DocLike {
  uri: { scheme: string; fsPath: string };
  isDirty: boolean;
}

/** A file a stage command was invoked on. */
interface StageTarget {
  repoRoot: string;
  path: string;
  status: FileStatus;
}

/** A dirty document paired with the repo-relative path of the target it matches. */
export interface DirtyTarget<T> {
  doc: T;
  path: string;
}

/**
 * The unsaved working-tree documents among a stage's targets.
 *
 * A deleted target is never included: VS Code keeps the editor open and dirty when something else
 * removes the file, and a save would write the buffer back and re-create it, so the stage would put
 * content in the index where the user asked for a deletion.
 *
 * Both sides are canonicalized, exactly as `repoRelativePath` does: a repo root resolved
 * through git is symlink-free, while a URI keeps whatever path the workspace was opened with, so on
 * macOS a repo under `/tmp` (a symlink to `/private/tmp`) would otherwise never match.
 */
export function dirtyTargetDocs<T extends DocLike>(
  docs: readonly T[],
  targets: readonly StageTarget[],
): DirtyTarget<T>[] {
  const dirty = docs.filter((doc) => doc.isDirty && doc.uri.scheme === "file");
  if (!dirty.length) {
    return [];
  }
  const byPath = new Map(dirty.map((doc) => [canonicalize(doc.uri.fsPath), doc]));
  const found = new Map<T, string>();
  for (const target of targets.filter((t) => t.status !== "D")) {
    const doc = byPath.get(canonicalize(join(target.repoRoot, target.path)));
    if (doc && !found.has(doc)) {
      found.set(doc, target.path);
    }
  }
  return Array.from(found, ([doc, path]) => ({ doc, path }));
}

export function stageSaveAction(setting: SaveBeforeStage, dirtyCount: number): StageSaveAction {
  if (dirtyCount === 0 || setting === "never") {
    return "stage";
  }
  return setting === "always" ? "save" : "ask";
}

/** The dialog button the user pressed. A dismissed dialog cancels the stage. */
export function stageSaveChoice(choice: string | undefined): StageSaveChoice {
  if (choice === SAVE_AND_STAGE) {
    return "save";
  }
  return choice === STAGE_SAVED ? "stage" : "cancel";
}

/** "a.ts, b.ts and 3 more" — a readable list that cannot fill the dialog. */
export function fileList(paths: readonly string[], cap = 5): string {
  const shown = paths.slice(0, cap);
  const extra = paths.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
}

export function saveBeforeStagePrompt(paths: readonly string[]): {
  message: string;
  detail: string;
} {
  const message =
    paths.length === 1
      ? `${paths[0]} has unsaved changes.`
      : `${paths.length} files have unsaved changes.`;
  const detail = [
    "Save first to stage what you see in the editor.",
    "Stage the saved version to leave the unsaved edits out of the index.",
    `\nFiles: ${fileList(paths)}`,
  ].join(" ");
  return { message, detail };
}

export function unsavedAfterStageMessage(paths: readonly string[]): string {
  return `Paireto staged the version on disk. These files still have unsaved changes: ${fileList(paths)}`;
}
