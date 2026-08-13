// Git stages the version of a file that is ON DISK. When an editor still holds unsaved edits for a
// file the user stages, the index gets content the user never sees, and the edits they meant to
// stage stay out of it. This helper finds those documents so the stage can save them first. It is
// pure and vscode-free so the match is testable without a running editor.

import { join } from "node:path";

import type { FileStatus } from "../git/DiffService.js";
import { canonicalize } from "../protocol/paths.js";

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

/** The error shown when a save fails during a stage. It names the file git could not be given, and
 *  says the stage did not run. */
export function saveFailureMessage(path: string): string {
  return `Could not save ${path}. No files were staged.`;
}
