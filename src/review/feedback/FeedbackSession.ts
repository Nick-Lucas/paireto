// The feedback for one commenting context: its buckets on disk, and its comment threads in the
// editor. Every change goes into a bucket first, then one render() makes the editor agree. Nothing
// else creates, moves or removes a feedback comment thread.

import * as vscode from "vscode";

import {
  buildThreadItemComment,
  GateComment,
  type CommentSession,
} from "../../comments/CommentSession.js";
import { kindLabel, type CommentKind } from "../../comments/kinds.js";
import type { FeedbackRef } from "../../git/gitCli.js";
import { log } from "../../log.js";
import { canonicalize } from "../../protocol/paths.js";
import { openFeedbackBucket, type FeedbackBucket } from "../../storage/FeedbackStore.js";
import {
  appendFeedbackReply,
  editFeedback,
  editFeedbackReply,
  removeFeedbackReply,
} from "../feedbackState.js";
import {
  getReviewerItems,
  getOpeningComment,
  type ThreadItem,
  type ReviewThread,
} from "../reviewTypes.js";

export interface FeedbackContext {
  roots: ReadonlyArray<{ repoRoot: string; ref: FeedbackRef }>;
}

export function contextKey(context: FeedbackContext): string {
  return context.roots
    .map((root) => `${canonicalize(root.repoRoot)}@${root.ref.kind}:${root.ref.value}`)
    .join("|");
}

/** What the session needs from its owner to put a comment on a document. */
export interface FeedbackHost {
  readonly comments: CommentSession;
  /** The document this model's thread belongs on now. */
  uriFor(model: ReviewThread): vscode.Uri;
  labelFor(model: ReviewThread): string;
  /** A changeset description is a virtual document. Its content must exist before its thread does. */
  registerDoc(uri: vscode.Uri, markdown: string): void;
  changed(): void;
}

/** Where a comment moved to, after its file changed under it. */
export interface RelocatePatch {
  line: number;
  sourceUri: string;
  filePath?: string;
  attachment?: ReviewThread["attachment"];
}

export class FeedbackSession {
  /** Keyed by canonical repository root. */
  private readonly buckets = new Map<string, FeedbackBucket>();
  /** Keyed by feedback id. The only index; thread grouping is recomputed on every render. */
  private readonly live = new Map<string, GateComment>();

  private constructor(private readonly host: FeedbackHost) {}

  /**
   * Open the buckets of a context. A bucket the outgoing session already holds for the same
   * repository and ref is taken over, not opened again: two adapters on one file would share one
   * temporary path, and the second would read the file before the first had written it.
   */
  static async open(
    context: FeedbackContext,
    host: FeedbackHost,
    outgoing?: FeedbackSession,
  ): Promise<FeedbackSession> {
    const session = new FeedbackSession(host);
    const opened = await Promise.all(
      context.roots.map((root) => {
        const held = outgoing?.take(root.repoRoot, root.ref);
        return held ?? openFeedbackBucket(root.repoRoot, root.ref);
      }),
    );
    for (const bucket of opened) {
      session.buckets.set(bucket.repoRoot, bucket);
    }
    session.render();
    return session;
  }

  /** Give up the bucket for this repository and ref, so the next session can keep using it. */
  private take(repoRoot: string, ref: FeedbackRef): FeedbackBucket | undefined {
    const key = canonicalize(repoRoot);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.ref.kind !== ref.kind || bucket.ref.value !== ref.value) {
      return undefined;
    }
    this.buckets.delete(key);
    return bucket;
  }

  allThreads(): ReviewThread[] {
    return Array.from(this.buckets.values()).flatMap((bucket) => bucket.threads());
  }

  hasBucketFor(repoRoot: string): boolean {
    return this.buckets.has(canonicalize(repoRoot));
  }

  commentFor(id: string): GateComment | undefined {
    return this.live.get(id);
  }

  repliesFor(id: string): ThreadItem[] {
    const model = this.allThreads().find((item) => item.id === id);
    return (model ? getReviewerItems(model) : []).slice(1);
  }

  /** Answers false when this session holds no bucket for the model's repository. */
  add(model: ReviewThread): boolean {
    return this.write(model.repoRoot, (draft) => {
      draft.threads.push(model);
    });
  }

  edit(id: string, body: string): boolean {
    const at = new Date().toISOString();
    const target = this.locate(id);
    if (!target) {
      log.error(`feedback ${id} is not held by this session`);
      return false;
    }
    const { thread, itemId } = target;
    return this.write(thread.repoRoot, (draft) => {
      const model = draft.threads.find((item) => item.id === thread.id);
      if (model) {
        Object.assign(
          model,
          itemId ? editFeedbackReply(model, itemId, body, at) : editFeedback(model, body, at),
        );
      }
    });
  }

  removeCommentOrThread(id: string): boolean {
    const at = new Date().toISOString();
    const target = this.locate(id);
    if (!target) {
      log.error(`feedback ${id} is not held by this session`);
      return false;
    }
    const { thread, itemId } = target;
    return this.write(thread.repoRoot, (draft) => {
      if (!itemId) {
        draft.threads = draft.threads.filter((model) => model.id !== thread.id);
        return;
      }
      const model = draft.threads.find((item) => item.id === thread.id);
      if (model) {
        Object.assign(model, removeFeedbackReply(model, itemId, at));
      }
    });
  }

  addReply(id: string, body: string): boolean {
    const thread = this.allThreads().find((item) => item.id === id);
    if (!thread) {
      log.error(`feedback ${id} is not held by this session`);
      return false;
    }
    const at = new Date().toISOString();
    return this.write(thread.repoRoot, (draft) => {
      const model = draft.threads.find((item) => item.id === id);
      if (model) {
        Object.assign(
          model,
          appendFeedbackReply(model, { body, at, author: { kind: "reviewer" } }),
        );
      }
    });
  }

  private locate(id: string): { thread: ReviewThread; itemId?: string } | undefined {
    for (const thread of this.allThreads()) {
      if (thread.id === id) {
        return { thread };
      }
      if (thread.items.some((a) => a.kind !== "comment" && a.id === id)) {
        return { thread, itemId: id };
      }
    }
    return undefined;
  }

  amend(repoRoot: string, id: string, change: (item: ReviewThread) => ReviewThread): boolean {
    const bucket = this.buckets.get(canonicalize(repoRoot));
    if (!bucket?.threads().some((model) => model.id === id)) {
      return false;
    }
    return this.write(repoRoot, (draft) => {
      const model = draft.threads.find((item) => item.id === id);
      if (model) {
        Object.assign(model, change(model));
      }
    });
  }

  relocate(id: string, patch: RelocatePatch): boolean {
    return this.writeTo(id, (draft) => {
      const model = draft.threads.find((item) => item.id === id);
      if (!model) {
        return;
      }
      model.line = patch.line;
      model.sourceUri = patch.sourceUri;
      if (patch.filePath !== undefined) {
        model.filePath = patch.filePath;
      }
      if (patch.attachment !== undefined) {
        model.attachment = patch.attachment;
      }
    });
  }

  markSent(ids: Set<string>, at: string): ReviewThread[] {
    const roots = new Set(
      this.allThreads()
        .filter((model) => ids.has(model.id))
        .map((model) => model.repoRoot),
    );
    for (const repoRoot of roots) {
      this.write(repoRoot, (draft) => {
        for (const model of draft.threads) {
          // A second send must not re-stamp something already delivered.
          if (ids.has(model.id) && model.delivery === "pending") {
            model.delivery = "sent";
            model.updatedAt = at;
          }
        }
      });
    }
    return this.allThreads().filter((model) => ids.has(model.id));
  }

  clear(): void {
    for (const repoRoot of Array.from(this.buckets.keys())) {
      this.write(repoRoot, (draft) => {
        draft.threads = [];
      });
    }
  }

  render(): void {
    try {
      const models = this.allThreads();
      const ids = new Set(models.map((model) => model.id));
      for (const [id, comment] of this.live) {
        if (!ids.has(id)) {
          this.host.comments.remove(comment);
          this.live.delete(id);
        }
      }

      // The provider is cleared when a review ends, so every saved description is registered again.
      for (const model of models) {
        if (model.sourceDocument) {
          this.host.registerDoc(this.host.uriFor(model), model.sourceDocument.markdown);
        }
      }

      for (const model of models) {
        const feedback = getOpeningComment(model);
        this.host.comments.place({
          uri: this.host.uriFor(model),
          range: new vscode.Range(
            Math.max(0, model.line),
            0,
            Math.max(0, model.line),
            Math.max(0, feedback.quote.length),
          ),
          label: this.host.labelFor(model),
          comments: this.getConversation(model),
          previous: this.live.get(model.id)?.thread,
          resolved: model.resolvedAt !== undefined,
        });
      }
    } catch (error) {
      // The write is already scheduled, so a drawing fault cannot lose the user's change.
      log.error(`feedback rendering failed: ${String(error)}`);
    }
  }

  /** Answers when every waiting disk write has landed. Nothing in the UI waits on this. */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.buckets.values(), (bucket) => bucket.flush()));
  }

  /** Write out and give up every bucket this session still holds. */
  async close(): Promise<void> {
    await Promise.all(Array.from(this.buckets.values(), (bucket) => bucket.close()));
  }

  /** Take every thread this session put up out of the editor. */
  dispose(): void {
    const mine = new Set([...this.live.values()].map((comment) => comment.thread));
    // Only this session's threads. The CommentSession is shared and outlives the session.
    this.host.comments.disposeThreads((thread) => mine.has(thread));
    this.live.clear();
  }

  private getConversation(
    model: ReviewThread,
  ): Array<{ comment: GateComment; replies?: vscode.Comment[] }> {
    const feedback = getOpeningComment(model);
    const out: Array<{ comment: GateComment; replies?: vscode.Comment[] }> = [
      { comment: this.draw(model.id, feedback.body, feedback.commentKind) },
    ];
    for (const item of model.items.slice(1)) {
      // Only the first item is ever the comment.
      if (item.kind === "comment") {
        continue;
      }
      if (item.kind === "reply" && item.author.kind === "reviewer") {
        out.push({ comment: this.draw(item.id, item.body, feedback.commentKind) });
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
      comment.onSaved = (next) => this.edit(id, next);
      comment.onDelete = () => this.removeCommentOrThread(id);
      this.live.set(id, comment);
    } else if (comment.mode !== vscode.CommentMode.Editing) {
      // Text the user is still typing is theirs until they save it.
      comment.body = body;
    }
    comment.kind = kind;
    comment.label = kindLabel(kind);
    return comment;
  }

  private writeTo(id: string, recipe: (draft: { threads: ReviewThread[] }) => void): boolean {
    const model = this.allThreads().find((item) => item.id === id);
    if (!model) {
      log.error(`feedback ${id} is not held by this session`);
      return false;
    }
    return this.write(model.repoRoot, recipe);
  }

  /** The one ordering rule: store, then editor, then tree. The disk write follows on its own. */
  private write(repoRoot: string, recipe: (draft: { threads: ReviewThread[] }) => void): boolean {
    const bucket = this.buckets.get(canonicalize(repoRoot));
    if (!bucket) {
      log.error(`no feedback bucket is open for ${repoRoot}`);
      return false;
    }
    bucket.update(recipe);
    this.render();
    this.host.changed();
    return true;
  }
}

function agentComment(item: Exclude<ThreadItem, { kind: "comment" }>): vscode.Comment {
  const author = item.author.kind === "agent" ? `${item.author.harness} agent` : "You";
  return buildThreadItemComment(
    item.kind === "reply"
      ? { kind: "reply", body: item.body, at: item.at, author }
      : { kind: "resolved", at: item.at, author },
  );
}
