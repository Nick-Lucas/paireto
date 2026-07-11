// Shared inline-comment machinery for both gate flows (Plan Review + Code Review). Each controller
// owns one CommentSession: it wraps a vscode.CommentController for a scheme, hands out comment
// instances, and owns reset. The add/save/delete *commands* are global (registered once) and operate
// on any GateComment via the callbacks the owning controller attaches — so editing and deleting work
// identically in plan and review, while each flow keeps its own model/collect logic.

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { commentAuthorName } from "./author.js";
import { wholeDocumentRange } from "./commentingRanges.js";
import { kindLabel, type CommentKind } from "./kinds.js";

/** A reviewer comment shared across both flows. The owner attaches onSaved/onDeleted to sync state. */
export class GateComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: commentAuthorName() };
  /** "preview" | "editing" — drives the edit/save menu `when` clauses (see package.json). */
  contextValue = "preview";
  label: string;
  thread?: vscode.CommentThread;
  /** Owner-supplied id (review uses the model id; plan leaves it unset). */
  id?: string;
  /** Called with the edited text after the user saves an edit — sync your model here. */
  onSaved?: (newBody: string) => void;
  /** Called after the comment is removed from its thread — clean up your model here. */
  onDeleted?: () => void;

  constructor(
    public body: string | vscode.MarkdownString,
    public kind: CommentKind,
  ) {
    this.label = kindLabel(kind);
  }
}

export function commentText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}

/** Reassign thread.comments so VS Code re-renders after a mode/body change. */
function refreshThread(comment: GateComment): void {
  const thread = comment.thread;
  if (thread) {
    thread.comments = [...thread.comments];
  }
}

/** Put a comment into edit mode (the gutter pencil action). */
export function editComment(comment: GateComment): void {
  comment.mode = vscode.CommentMode.Editing;
  comment.contextValue = "editing";
  refreshThread(comment);
}

/** Commit an edit: back to preview, then sync the edited text via onSaved. */
export function saveComment(comment: GateComment): void {
  comment.mode = vscode.CommentMode.Preview;
  comment.contextValue = "preview";
  refreshThread(comment);
  comment.onSaved?.(commentText(comment.body));
}

/** Remove a comment from its thread (disposing the thread if it empties), then sync via onDeleted. */
export function deleteComment(comment: GateComment): void {
  const thread = comment.thread;
  if (thread) {
    thread.comments = thread.comments.filter((c) => c !== comment);
    if (thread.comments.length === 0) {
      thread.dispose();
    }
  }
  comment.onDeleted?.();
}

/**
 * Register the global comment edit/save/delete commands once. They act on the GateComment instance
 * VS Code passes in, so a single registration serves both comment controllers.
 */
export function registerCommentEditingCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(Commands.commentEdit, editComment),
    vscode.commands.registerCommand(Commands.commentSave, saveComment),
    vscode.commands.registerCommand(Commands.commentDelete, deleteComment),
  );
}

export interface CommentCallbacks {
  onSaved?: (newBody: string) => void;
  onDeleted?: () => void;
  id?: string;
}

/** Wraps a CommentController for one scheme: ranges, options, comment creation, and reset. */
export class CommentSession implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly threadSet = new Set<vscode.CommentThread>();

  constructor(
    id: string,
    label: string,
    scheme: string,
    options: vscode.CommentOptions,
    /** Which docs are commentable. Defaults to "this controller's scheme"; the review controller
     *  widens it to also cover the editable working-tree (file:) side of its changed-file diffs. */
    matches: (doc: vscode.TextDocument) => boolean = (doc) => doc.uri.scheme === scheme,
  ) {
    this.controller = vscode.comments.createCommentController(id, label);
    this.controller.options = options;
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => (matches(doc) ? wholeDocumentRange(doc) : undefined),
    };
  }

  /** Append a new comment to the reply's thread and track the thread. */
  add(reply: vscode.CommentReply, kind: CommentKind, cb?: CommentCallbacks): GateComment {
    const comment = new GateComment(reply.text, kind);
    comment.thread = reply.thread;
    comment.onSaved = cb?.onSaved;
    comment.onDeleted = cb?.onDeleted;
    comment.id = cb?.id;
    reply.thread.comments = [...reply.thread.comments, comment];
    this.threadSet.add(reply.thread);
    return comment;
  }

  /** Move a live comment to a new document/range without losing it when its backing diff changes. */
  reattach(
    comment: GateComment,
    uri: vscode.Uri,
    range: vscode.Range,
    label: string,
  ): vscode.CommentThread {
    const old = comment.thread;
    if (old?.uri.toString() === uri.toString()) {
      old.range = range;
      old.label = label;
      return old;
    }

    // Create first: if VS Code rejects the new attachment, the original thread remains intact.
    const replacement = this.controller.createCommentThread(uri, range, [comment]);
    replacement.label = label;
    replacement.collapsibleState =
      old?.collapsibleState ?? vscode.CommentThreadCollapsibleState.Expanded;
    this.threadSet.add(replacement);
    comment.thread = replacement;

    if (old) {
      old.comments = old.comments.filter((item) => item !== comment);
      if (old.comments.length === 0) {
        this.threadSet.delete(old);
        old.dispose();
      }
    }
    return replacement;
  }

  /** All tracked threads (plan collects per-thread; review tracks per-comment). */
  threads(): vscode.CommentThread[] {
    return [...this.threadSet];
  }

  /** Forget a thread (after it has been disposed by a delete). */
  forget(thread: vscode.CommentThread): void {
    this.threadSet.delete(thread);
  }

  /** Dispose every thread and clear tracking. */
  reset(): void {
    for (const thread of this.threadSet) {
      thread.dispose();
    }
    this.threadSet.clear();
  }

  dispose(): void {
    this.reset();
    this.controller.dispose();
  }
}
