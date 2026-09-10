import * as vscode from "vscode";

import { commentAuthorName } from "../comments/author.js";
import {
  buildThreadItemComment,
  GateComment,
  type CommentSession,
} from "../comments/CommentSession.js";
import { kindLabel, type CommentKind } from "../comments/kinds.js";
import { ThreadRenderer } from "../comments/ThreadRenderer.js";
import {
  appendReply,
  editComment,
  editReply,
  getOpeningComment,
  locateThreadItem,
  removeReply,
  serialiseConversation,
  type ThreadItem,
  type ThreadItems,
} from "../comments/threadModel.js";
import type { PlanCommentData } from "./planFeedback.js";

export interface PlanThread extends ThreadItems {
  uri: vscode.Uri;
  line: number;
}

let planThreadCounter = 0;

export class PlanThreads {
  private threads: PlanThread[] = [];
  private readonly sent = new Map<string, vscode.CommentThread[]>();
  private readonly renderer: ThreadRenderer<PlanThread>;

  constructor(
    private readonly comments: CommentSession,
    private readonly changed: () => void,
  ) {
    this.renderer = new ThreadRenderer({
      comments,
      uriFor: (thread) => thread.uri,
      labelFor: (thread) => kindLabel(getOpeningComment(thread).commentKind),
      resolved: () => false,
      edited: (id, body) => this.edit(id, body),
      deleted: (id) => this.remove(id),
    });
  }

  open(reply: vscode.CommentReply, kind: CommentKind, quote: string): void {
    const at = new Date().toISOString();
    const line = reply.thread.range?.start.line ?? 0;
    const thread: PlanThread = {
      id: `plan-${++planThreadCounter}`,
      uri: reply.thread.uri,
      line,
      items: [{ kind: "comment", commentKind: kind, body: reply.text, quote, at }],
    };
    this.threads.push(thread);
    this.renderer.adopt(thread.id, reply.thread);
    this.write();
  }

  addReply(reply: vscode.CommentReply): boolean {
    const id = this.threadAnsweredBy(reply);
    if (id === undefined) {
      return false;
    }
    const at = new Date().toISOString();
    this.threads = this.threads.map((thread) =>
      thread.id === id
        ? appendReply(thread, { body: reply.text, at, author: { kind: "reviewer" } })
        : thread,
    );
    this.write();
    return true;
  }

  threadAnsweredBy(reply: vscode.CommentReply): string | undefined {
    const opener = reply.thread.comments[0];
    const id = opener instanceof GateComment ? opener.id : undefined;
    return id !== undefined && this.threads.some((thread) => thread.id === id) ? id : undefined;
  }

  threadsFor(uri: vscode.Uri): PlanThread[] {
    const target = uri.toString();
    return this.threads.filter((thread) => thread.uri.toString() === target);
  }

  showSent(uri: vscode.Uri, sent: readonly PlanThread[]): void {
    this.dropSent(uri.toString());
    const placed = sent.map((thread) => {
      const opening = getOpeningComment(thread);
      const line = Math.max(0, thread.line);
      return this.comments.placeSent({
        uri,
        range: new vscode.Range(line, 0, line, opening.quote.length),
        label: `Sent ${kindLabel(opening.commentKind).toLowerCase()}`,
        comments: thread.items.map(sentComment),
        expanded: true,
      });
    });
    this.sent.set(uri.toString(), placed);
  }

  commentsFor(uri: vscode.Uri): PlanCommentData[] {
    const target = uri.toString();
    return this.threads
      .filter((thread) => thread.uri.toString() === target)
      .flatMap((thread) => {
        const opening = getOpeningComment(thread);
        const body = serialiseConversation(thread).trim();
        if (!body) {
          return [];
        }
        return [{ line: thread.line, quote: opening.quote, body, kind: opening.commentKind }];
      });
  }

  dropFor(uri: vscode.Uri): void {
    const target = uri.toString();
    this.dropSent(target);
    this.threads = this.threads.filter((thread) => thread.uri.toString() !== target);
    this.write();
  }

  dispose(): void {
    for (const target of Array.from(this.sent.keys())) {
      this.dropSent(target);
    }
    this.threads = [];
    this.renderer.dispose();
  }

  private dropSent(target: string): void {
    const placed = new Set(this.sent.get(target) ?? []);
    this.sent.delete(target);
    if (placed.size > 0) {
      this.comments.disposeThreads((thread) => placed.has(thread));
    }
  }

  private edit(id: string, body: string): void {
    const at = new Date().toISOString();
    const target = locateThreadItem(this.threads, id);
    if (!target) {
      return;
    }
    const { itemId } = target;
    const edited = (thread: PlanThread): PlanThread =>
      itemId ? editReply(thread, itemId, body, at) : editComment(thread, body, at);
    this.threads = this.threads.map((thread) =>
      thread.id === target.thread.id ? edited(thread) : thread,
    );
    this.write();
  }

  private remove(id: string): void {
    const target = locateThreadItem(this.threads, id);
    if (!target) {
      return;
    }
    const { itemId } = target;
    if (itemId) {
      this.threads = this.threads.map((thread) =>
        thread.id === target.thread.id ? removeReply(thread, itemId) : thread,
      );
    } else {
      this.threads = this.threads.filter((thread) => thread.id !== target.thread.id);
    }
    this.write();
  }

  private write(): void {
    this.renderer.render(this.threads);
    this.changed();
  }
}

function sentComment(item: ThreadItem): vscode.Comment {
  const author =
    item.kind === "comment" || item.author.kind === "reviewer"
      ? commentAuthorName()
      : `${item.author.harness} agent`;
  return buildThreadItemComment({ body: item.body, at: item.at, author, label: "Sent" });
}
