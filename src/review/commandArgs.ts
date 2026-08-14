// Command arguments arrive as `unknown`: VS Code hands a `view/item/context` menu command whatever
// the tree NODE was, the command palette hands nothing at all, and our own call sites pass a plain
// payload. So every command has to work out what it was given before it can act — and a shape it
// fails to recognise makes a button silently do nothing.
//
// These schemas are the recognition step, in one place, and `withArg` is how a command uses one: it
// parses the argument and hands the handler a typed value, so no handler starts with `unknown`. They
// are LOOSE on purpose — each names only the fields the command reads and lets everything else
// through, so a node gaining a field never stops a button working.

import type * as vscode from "vscode";

import { z } from "zod";
import { prettifyError } from "zod/v4";

import { log } from "../log.js";
import { filesInEntry, type TreeEntry } from "../views/fileTree.js";

/** A changed file as the tree carries it. Spelled out rather than passed through, so the parsed
 *  value IS a RepoChangedFile — nothing downstream has to trust a cast. */
export const ChangedFileArg = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(["A", "M", "D", "R", "C", "U"]),
  group: z.enum(["staged", "unstaged", "committed"]),
  additions: z.number(),
  deletions: z.number(),
  repoRoot: z.string(),
});
export type ChangedFileArg = z.infer<typeof ChangedFileArg>;

/** The changed file a command argument names: the file itself, a Changed Files node wrapping one, or
 *  a Review Plan row wrapping one a level further down. A planned row whose path has no live change
 *  carries no file, and resolves to nothing — correct, there is nothing to act on. */
export const FileArg = z.union([
  ChangedFileArg,
  z.object({ file: ChangedFileArg }).transform((node) => node.file),
  z.object({ row: z.object({ file: ChangedFileArg }) }).transform((node) => node.row.file),
]);
export type FileArg = z.infer<typeof FileArg>;

/** Every changed file a git action should act on: a folder row means all its descendants, matching
 *  the native git panel; anything else is the one file it names. */
export const FilesArg = z.union([
  z
    .object({ kind: z.literal("folder"), entry: z.custom<TreeEntry>() })
    .transform((node) => filesInEntry(node.entry) as ChangedFileArg[]),
  FileArg.transform((file) => [file]),
]);
export type FilesArg = z.infer<typeof FilesArg>;

/** A Review Plan file row, as the tree node or as the `{changesetId, path}` payload its own command
 *  passes. Identifies the row; the live file is looked up from it. */
export const GuidedRowArg = z.union([
  z.object({ changesetId: z.string(), path: z.string() }),
  z
    .object({ row: z.object({ changesetId: z.string(), path: z.string() }) })
    .transform((node) => node.row),
]);
export type GuidedRowArg = z.infer<typeof GuidedRowArg>;

/** A changeset: its tree node, or the `{changesetId}` payload the row's own command passes. */
export const ChangesetIdArg = z.union([
  z
    .object({ kind: z.literal("changeset"), changeset: z.object({ id: z.string() }) })
    .transform((node) => node.changeset.id),
  z.object({ changesetId: z.string() }).transform((node) => node.changesetId),
]);
export type ChangesetIdArg = z.infer<typeof ChangesetIdArg>;

/** A repository, named directly or through a changed file. */
export const RepoRootArg = z.union([
  z.object({ repoRoot: z.string() }).transform((node) => node.repoRoot),
  FileArg.transform((file) => file.repoRoot),
]);
export type RepoRootArg = z.infer<typeof RepoRootArg>;

/** What a bulk Stage/Unstage/Discard was invoked on: a changeset row, a repository row (or any node
 *  that names one), or nothing. Nothing is a real case, not a defensive one: these three are palette
 *  commands ("Paireto: Stage All Changes"), and the palette passes no argument — that invocation is
 *  what the Choose Repository quick pick exists for. */
export const BulkTargetArg = z.union([
  ChangesetIdArg.transform((changesetId) => ({ changesetId, repoRoot: undefined })),
  RepoRootArg.transform((repoRoot) => ({ changesetId: undefined, repoRoot })),
  z.undefined().transform(() => ({ changesetId: undefined, repoRoot: undefined })),
]);
export type BulkTargetArg = z.infer<typeof BulkTargetArg>;

/** A review comment, by id. Only the id travels: the live comment is looked up from it, so a stale
 *  copy carried on a tree node can never be acted on. */
export const CommentIdArg = z.object({ id: z.string() }).transform((comment) => comment.id);
export type CommentIdArg = z.infer<typeof CommentIdArg>;

/** VS Code's own reply object, from the comment thread's Add buttons. Checked for the two fields we
 *  read; the rest is the editor's. */
export const CommentReplyArg = z.custom<vscode.CommentReply>(
  (value) =>
    !!value &&
    typeof value === "object" &&
    "thread" in value &&
    "text" in value &&
    typeof value.text === "string",
  { message: "expected a comment reply with a thread and text" },
);
export type CommentReplyArg = z.infer<typeof CommentReplyArg>;

/**
 * Wrap a command handler so it receives the argument it asks for, already typed. An argument that
 * does not match is a WIRING BUG — a menu pointed at the wrong node, or a caller passing the wrong
 * payload — so it is logged and thrown rather than dropped: a button that silently does nothing is
 * the hardest version of this to find.
 */
export function withArg<S extends z.ZodTypeAny>(
  schema: S,
  run: (value: z.infer<S>) => unknown,
): (arg: unknown) => unknown {
  return (arg: unknown) => {
    const parsed = schema.safeParse(arg);
    if (!parsed.success) {
      const message = `command argument rejected —\n${prettifyError(parsed.error)}`;
      log.error(message);
      throw new Error(message);
    }
    return run(parsed.data);
  };
}

/** For a caller whose argument is genuinely optional — "not that shape" is one of the answers it
 *  handles, so there is no error to report. Command handlers use {@link withArg} instead. */
export function readArg<S extends z.ZodTypeAny>(schema: S, arg: unknown): z.infer<S> | undefined {
  const parsed = schema.safeParse(arg);
  return parsed.success ? parsed.data : undefined;
}
