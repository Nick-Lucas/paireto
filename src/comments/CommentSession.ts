import * as vscode from "vscode";

import { Commands } from "../config.js";
import { commentAuthorName } from "./author.js";
import { wholeDocumentRange } from "./commentingRanges.js";
import { kindLabel, type CommentKind } from "./kinds.js";

/** A reviewer comment shared across both flows. The owner attaches onSaved/onDelete to sync state. */
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
  /** Asks the owner to delete this comment and everything that goes down with it. */
  onDelete?: () => void;

  constructor(
    public body: string | vscode.MarkdownString,
    public kind: CommentKind,
  ) {
    this.label = kindLabel(kind);
  }
}

/** An agent's reply or resolution, shown under the comment it answers. */
export function feedbackActivityComment(
  activity:
    | { kind: "reply"; body: string; at: string; author: string }
    | { kind: "resolved"; at: string; author: string },
): vscode.Comment {
  return {
    body: activity.kind === "reply" ? activity.body : "Marked this feedback as resolved.",
    mode: vscode.CommentMode.Preview,
    author: { name: activity.author },
    contextValue: "activity",
    label: activity.kind === "reply" ? "Agent reply" : "Resolved",
    timestamp: new Date(activity.at),
  };
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

/** Ask the comment's owner to delete it. The owner decides what else goes down with it. */
export function deleteComment(comment: GateComment): void {
  comment.onDelete?.();
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
  onDelete?: () => void;
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
    comment.onDelete = cb?.onDelete;
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

  /**
   * Put a whole thread group on its document. The uri, range and label always come from the comment
   * that opens the thread, so a reply never moves or re-labels the thread it sits on.
   */
  place(args: {
    uri: vscode.Uri;
    range: vscode.Range;
    label: string;
    /** Each reviewer comment, and the agent's answers that sit under it. Only the reviewer's own
     *  comments are owned: an agent's answer has no owner to point back to. */
    comments: Array<{ comment: GateComment; activity?: vscode.Comment[] }>;
    previous?: vscode.CommentThread;
    resolved?: boolean;
  }): vscode.CommentThread {
    const { uri, range, label, comments, previous, resolved } = args;
    const state = resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    const rendered = comments.flatMap(({ comment, activity }) => [comment, ...(activity ?? [])]);
    if (previous && previous.uri.toString() === uri.toString()) {
      previous.range = range;
      previous.label = label;
      previous.state = state;
      // VS Code redraws a changed body only when the array is new.
      previous.comments = rendered;
      this.own(comments, previous);
      this.threadSet.add(previous);
      return previous;
    }

    // Create first: if VS Code refuses the new attachment, the old thread stays whole.
    const thread = this.controller.createCommentThread(uri, range, rendered);
    thread.label = label;
    thread.state = state;
    thread.collapsibleState =
      previous?.collapsibleState ?? vscode.CommentThreadCollapsibleState.Expanded;
    this.threadSet.add(thread);
    this.own(comments, thread);
    if (previous) {
      this.threadSet.delete(previous);
      previous.dispose();
    }
    return thread;
  }

  private own(comments: Array<{ comment: GateComment }>, thread: vscode.CommentThread): void {
    for (const { comment } of comments) {
      comment.thread = thread;
      comment.session = this;
    }
  }

  /** What a delete of this comment takes: the whole thread if it opens it, else itself. An agent's
   *  answers go down with the thread, but they are nobody's to hand back. */
  private findCommentsDeletedWith(comment: GateComment): GateComment[] {
    const onThread = comment.thread?.comments.filter((item) => item instanceof GateComment);
    return onThread?.[0] === comment ? [...onThread] : [comment];
  }

  remove(comment: GateComment): GateComment[] {
    const thread = comment.thread;
    if (!thread) {
      return [comment];
    }
    const removed = this.findCommentsDeletedWith(comment);
    for (const item of removed) {
      item.thread = undefined;
    }
    const rest = thread.comments.filter(
      (item) => !(item instanceof GateComment && removed.includes(item)),
    );
    // An agent's answer has no life without the words it answers, so it never keeps a thread up.
    if (rest.some((item) => item instanceof GateComment)) {
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
