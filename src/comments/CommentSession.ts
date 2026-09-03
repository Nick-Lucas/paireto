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
  session?: CommentSession;
  /** Called with the edited text after the user saves an edit — sync your model here. */
  onSaved?: (newBody: string) => void;
  /** Called after the comment and its thread are gone — clean up your model here. */
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

/** Delete a comment, and every comment that goes down with it, then sync each via onDeleted. */
export function deleteComment(comment: GateComment): void {
  const removed = comment.session?.remove(comment) ?? [comment];
  for (const item of removed) {
    item.onDeleted?.();
  }
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
  label?: string;
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

  add(reply: vscode.CommentReply, kind: CommentKind, cb?: CommentCallbacks): GateComment {
    const comment = new GateComment(reply.text, kind);
    comment.onSaved = cb?.onSaved;
    comment.onDeleted = cb?.onDeleted;
    comment.id = cb?.id;
    comment.session = this;
    const thread = reply.thread;
    comment.thread = thread;
    if (thread.comments.length === 0 && cb?.label !== undefined) {
      thread.label = cb.label;
    }
    thread.comments = [...thread.comments, comment];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threadSet.add(thread);
    return comment;
  }

  wouldRemove(comment: GateComment): GateComment[] {
    const onThread = comment.thread?.comments as GateComment[] | undefined;
    return onThread?.[0] === comment ? [...onThread] : [comment];
  }

  remove(comment: GateComment): GateComment[] {
    const thread = comment.thread;
    if (!thread) {
      return [comment];
    }
    const removed = this.wouldRemove(comment);
    for (const item of removed) {
      item.thread = undefined;
    }
    const rest = (thread.comments as GateComment[]).filter((item) => !removed.includes(item));
    if (rest.length > 0) {
      thread.comments = rest;
      return removed;
    }
    this.threadSet.delete(thread);
    thread.dispose();
    return removed;
  }

  disposeThreads(select: (thread: vscode.CommentThread) => boolean): void {
    for (const thread of this.threads().filter(select)) {
      this.threadSet.delete(thread);
      thread.dispose();
    }
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
      const rest = old.comments.filter((item) => item !== comment);
      if (rest.length > 0) {
        old.comments = rest;
      } else {
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
