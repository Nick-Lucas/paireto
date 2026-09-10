import * as vscode from "vscode";

import { buildThreadItemComment, GateComment, type CommentSession } from "./CommentSession.js";
import { kindLabel, type CommentKind } from "./kinds.js";
import { getOpeningComment, type ThreadItem, type ThreadItems } from "./threadModel.js";
import { log } from "../log.js";

export type RenderableThread = ThreadItems & { line: number };

export interface ThreadRenderHost<T extends RenderableThread> {
  readonly comments: CommentSession;
  uriFor(thread: T): vscode.Uri;
  labelFor(thread: T): string;
  resolved(thread: T): boolean;
  prepare?(threads: readonly T[]): void;
  edited(id: string, body: string): void;
  deleted(id: string): void;
}

export class ThreadRenderer<T extends RenderableThread> {
  private readonly live = new Map<string, GateComment>();
  private readonly adopted = new Map<string, vscode.CommentThread>();

  constructor(private readonly host: ThreadRenderHost<T>) {}

  commentFor(id: string): GateComment | undefined {
    return this.live.get(id);
  }

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
      log.error(`comment thread rendering failed: ${String(error)}`);
    }
  }

  dispose(): void {
    const mine = new Set([...this.live.values()].map((comment) => comment.thread));
    this.host.comments.disposeThreads((thread) => mine.has(thread));
    this.live.clear();
  }

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
      comment.id = id;
      comment.session = this.host.comments;
      comment.onSaved = (next) => this.host.edited(id, next);
      comment.onDelete = () => this.host.deleted(id);
      this.live.set(id, comment);
    } else if (comment.mode !== vscode.CommentMode.Editing) {
      comment.body = body;
    }
    comment.kind = kind;
    comment.label = kindLabel(kind);
    return comment;
  }
}

function agentComment(item: Extract<ThreadItem, { kind: "reply" }>): vscode.Comment {
  const author = item.author.kind === "agent" ? `${item.author.harness} agent` : "You";
  return buildThreadItemComment({ body: item.body, at: item.at, author, label: "Agent reply" });
}
