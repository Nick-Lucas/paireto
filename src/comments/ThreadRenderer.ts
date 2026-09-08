// Draws thread models into a CommentSession and keeps the drawing in step with them.
//
// A plan thread and a review thread are the same conversation: the reviewer's comment opens it, the
// reviewer's own replies are theirs to edit and delete, and an agent's replies are read-only. Both
// sides hand their models here, so both are drawn the same way.

import * as vscode from "vscode";

import { buildThreadItemComment, GateComment, type CommentSession } from "./CommentSession.js";
import { kindLabel, type CommentKind } from "./kinds.js";
import { getOpeningComment, type ThreadItem, type ThreadItems } from "./threadModel.js";
import { log } from "../log.js";

/** A model this renderer can draw: a conversation that sits on a line of some document. */
export type RenderableThread = ThreadItems & { line: number };

export interface ThreadRenderHost<T extends RenderableThread> {
  readonly comments: CommentSession;
  /** The document this thread belongs on now. */
  uriFor(thread: T): vscode.Uri;
  labelFor(thread: T): string;
  resolved(thread: T): boolean;
  /** Runs before anything is placed, for content a thread's document needs first. */
  prepare?(threads: readonly T[]): void;
  /** The reviewer saved an edit to the comment or reply named by this id. */
  edited(id: string, body: string): void;
  /** The reviewer deleted the comment or reply named by this id. */
  deleted(id: string): void;
}

export class ThreadRenderer<T extends RenderableThread> {
  /** Keyed by the id of the comment or reply drawn, in the order they were drawn. */
  private readonly live = new Map<string, GateComment>();
  /** Threads the editor put up itself, to draw on at the next render. Keyed by model id. */
  private readonly adopted = new Map<string, vscode.CommentThread>();

  constructor(private readonly host: ThreadRenderHost<T>) {}

  commentFor(id: string): GateComment | undefined {
    return this.live.get(id);
  }

  /**
   * Draw this thread onto one the editor has already put up — the widget the reviewer typed their
   * comment into — rather than opening a second thread on the same line and taking that one down.
   */
  adopt(id: string, thread: vscode.CommentThread): void {
    this.adopted.set(id, thread);
  }

  render(threads: readonly T[]): void {
    try {
      this.dropVanished(threads);
      this.host.prepare?.(threads);
      for (const thread of threads) {
        const opening = getOpeningComment(thread);
        const line = Math.max(0, thread.line);
        const previous = this.live.get(thread.id)?.thread ?? this.adopted.get(thread.id);
        this.adopted.delete(thread.id);
        this.host.comments.place({
          uri: this.host.uriFor(thread),
          range: new vscode.Range(line, 0, line, opening.quote.length),
          label: this.host.labelFor(thread),
          comments: this.conversation(thread),
          previous,
          resolved: this.host.resolved(thread),
        });
      }
    } catch (error) {
      // The model already holds the change, so a drawing fault cannot lose the user's words.
      log.error(`comment thread rendering failed: ${String(error)}`);
    }
  }

  /** Take every thread this renderer put up out of the editor. */
  dispose(): void {
    const mine = new Set([...this.live.values()].map((comment) => comment.thread));
    // Only these threads. The CommentSession is shared and outlives the renderer.
    this.host.comments.disposeThreads((thread) => mine.has(thread));
    this.live.clear();
  }

  /**
   * Take down what the models no longer say. Removing the comment that opens a thread takes the
   * whole thread with it, and the replies under it are drawn again from scratch next time.
   */
  private dropVanished(threads: readonly T[]): void {
    const ids = new Set<string>();
    for (const thread of threads) {
      ids.add(thread.id);
      for (const item of thread.items) {
        if (item.kind === "reply" && item.author.kind === "reviewer") {
          ids.add(item.id);
        }
      }
    }
    for (const [id, comment] of this.live) {
      if (ids.has(id)) {
        continue;
      }
      if (comment.thread) {
        this.host.comments.remove(comment);
      }
      this.live.delete(id);
    }
  }

  private conversation(thread: T): Array<{ comment: GateComment; replies?: vscode.Comment[] }> {
    const opening = getOpeningComment(thread);
    const out: Array<{ comment: GateComment; replies?: vscode.Comment[] }> = [
      { comment: this.draw(thread.id, opening.body, opening.commentKind) },
    ];
    for (const item of thread.items.slice(1)) {
      if (item.kind === "comment") {
        continue;
      }
      if (item.author.kind === "reviewer") {
        out.push({ comment: this.draw(item.id, item.body, opening.commentKind) });
        continue;
      }
      const last = out.at(-1)!;
      last.replies = [...(last.replies ?? []), agentComment(item)];
    }
    return out;
  }

  private draw(id: string, body: string, kind: CommentKind): GateComment {
    let comment = this.live.get(id);
    if (!comment) {
      comment = new GateComment(body, kind);
      // A reply reads the id of the comment it answers to find its thread.
      comment.id = id;
      comment.session = this.host.comments;
      comment.onSaved = (next) => this.host.edited(id, next);
      comment.onDelete = () => this.host.deleted(id);
      this.live.set(id, comment);
    } else if (comment.mode !== vscode.CommentMode.Editing) {
      // Text the user is still typing is theirs until they save it.
      comment.body = body;
    }
    comment.kind = kind;
    comment.label = kindLabel(kind);
    return comment;
  }
}

function agentComment(item: Extract<ThreadItem, { kind: "reply" }>): vscode.Comment {
  const author = item.author.kind === "agent" ? `${item.author.harness} agent` : "You";
  return buildThreadItemComment({ body: item.body, at: item.at, author });
}
