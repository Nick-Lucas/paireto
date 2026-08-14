// Shared inline-comment machinery for both gate flows (Plan Review + Code Review). Each controller
// owns one CommentSession: it wraps a vscode.CommentController for a scheme, hands out comment
// instances, and owns reset. The add/save/delete *commands* are global (registered once) and operate
// on any GateComment via the callbacks the owning controller attaches — so editing and deleting work
// identically in plan and review, while each flow keeps its own model/collect logic.
//
// ONE THREAD, ONE COMMENT. Every GateComment gets its own vscode.CommentThread, even when two
// comments sit on the same line. VS Code stacks them, and the pairing means a comment can be deleted,
// moved or re-rendered without reasoning about what else is on its thread. The session owns thread
// lifetime — nothing outside disposes one — so a thread can never outlive the comment it carries, nor
// stay in `threadSet` after it is gone.

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
  /** The session that handed this comment out. It owns the thread, so the global delete command can
   *  take the thread down through the one place that also stops tracking it. */
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

/** Delete a comment and the thread it owns, then sync via onDeleted. */
export function deleteComment(comment: GateComment): void {
  comment.session?.remove(comment);
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

  /**
   * Start a comment on a thread of its own. The reply's thread is adopted only while it is empty —
   * that is the widget VS Code opens for a new comment. Typing into the reply box of a thread that
   * already carries a comment starts a second comment on the same line, and it gets its own thread.
   */
  add(reply: vscode.CommentReply, kind: CommentKind, cb?: CommentCallbacks): GateComment {
    const comment = new GateComment(reply.text, kind);
    comment.onSaved = cb?.onSaved;
    comment.onDeleted = cb?.onDeleted;
    comment.id = cb?.id;
    comment.session = this;
    const thread =
      reply.thread.comments.length === 0
        ? reply.thread
        : this.controller.createCommentThread(
            reply.thread.uri,
            reply.thread.range ?? new vscode.Range(0, 0, 0, 0),
            [],
          );
    comment.thread = thread;
    thread.comments = [comment];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threadSet.add(thread);
    return comment;
  }

  /** Take a comment's thread down and stop tracking it. The one place a thread is disposed. */
  remove(comment: GateComment): void {
    const thread = comment.thread;
    if (!thread) {
      return;
    }
    comment.thread = undefined;
    this.threadSet.delete(thread);
    thread.dispose();
  }

  /** Take down every tracked thread the predicate selects (a closing plan document, a repository
   *  leaving the window). Threads live only here, so this is how a caller drops a group of them. */
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
      // The old thread carried this comment and nothing else, so it goes with the move.
      this.threadSet.delete(old);
      old.dispose();
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
