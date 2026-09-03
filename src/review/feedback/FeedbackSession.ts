// The feedback for one commenting context: its buckets on disk, and its comment threads in the
// editor. Every change goes into a bucket first, then one render() makes the editor agree. Nothing
// else creates, moves or removes a feedback comment thread.

import * as vscode from "vscode";

import {
  feedbackActivityComment,
  GateComment,
  type CommentSession,
} from "../../comments/CommentSession.js";
import { kindLabel } from "../../comments/kinds.js";
import type { FeedbackRef } from "../../git/gitCli.js";
import { log } from "../../log.js";
import { canonicalize } from "../../protocol/paths.js";
import { openFeedbackBucket, type FeedbackBucket } from "../../storage/FeedbackStore.js";
import { editFeedback } from "../feedbackState.js";
import { userFeedback, type ReviewThread } from "../reviewTypes.js";

/** The repositories the window comments on, and the ref each one is on. */
export interface FeedbackContext {
  roots: ReadonlyArray<{ repoRoot: string; ref: FeedbackRef }>;
}

/** A stable name for a context, so an unchanged one can be recognised. */
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

  /** The models a delete of `id` takes: itself, and every reply on its thread. */
  repliesOf(id: string): ReviewThread[] {
    return this.allThreads().filter((model) => takenWithId(model, id));
  }

  /** Answers false when this session holds no bucket for the model's repository. */
  add(model: ReviewThread): boolean {
    return this.write(model.repoRoot, (draft) => {
      draft.threads.push(model);
    });
  }

  edit(id: string, body: string): boolean {
    const at = new Date().toISOString();
    return this.writeTo(id, (draft) => {
      const model = draft.threads.find((item) => item.id === id);
      if (model) {
        Object.assign(model, editFeedback(model, body, at));
      }
    });
  }

  remove(id: string): boolean {
    return this.writeTo(id, (draft) => {
      draft.threads = draft.threads.filter((model) => !takenWithId(model, id));
    });
  }

  /**
   * Apply an agent's answer to one item. Answers false when this session holds no bucket for the
   * repository, or when the id is not in it — an agent that quoted a wrong id must be told.
   */
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

  /** A thread has one range, so a move applies to every comment on it. */
  relocate(id: string, patch: RelocatePatch): boolean {
    return this.writeTo(id, (draft) => {
      const target = draft.threads.find((item) => item.id === id);
      if (!target) {
        return;
      }
      const group = threadKey(target);
      for (const model of draft.threads) {
        if (threadKey(model) !== group) {
          continue;
        }
        model.line = patch.line;
        model.sourceUri = patch.sourceUri;
        if (patch.filePath !== undefined) {
          model.filePath = patch.filePath;
        }
        if (patch.attachment !== undefined) {
          model.attachment = patch.attachment;
        }
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

  /** Make the editor agree with the store. Safe to call at any time. */
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

      for (const [openerId, group] of groupThreads(models)) {
        for (const model of group) {
          this.draw(model);
        }
        const opener = group.find((model) => model.id === openerId) ?? group[0];
        const feedback = userFeedback(opener);

        this.host.comments.place({
          uri: this.host.uriFor(opener),
          range: new vscode.Range(
            Math.max(0, opener.line),
            0,
            Math.max(0, opener.line),
            Math.max(0, feedback.quote.length),
          ),
          label: this.host.labelFor(opener),
          comments: group.map((model) => ({
            comment: this.live.get(model.id)!,
            activity: activityComments(model),
          })),
          resolved: opener.resolvedAt !== undefined,
          previous: group
            .map((model) => this.live.get(model.id)?.thread)
            .find((thread) => thread !== undefined),
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

  /** One GateComment per model, kept in step with what the store says. */
  private draw(model: ReviewThread): void {
    const feedback = userFeedback(model);
    let comment = this.live.get(model.id);
    if (!comment) {
      comment = new GateComment(feedback.body, feedback.feedbackKind);
      // A reply reads the opener's id to work out which thread it joins.
      comment.id = model.id;
      comment.session = this.host.comments;
      comment.onSaved = (body) => this.edit(model.id, body);
      comment.onDelete = () => this.remove(model.id);
      this.live.set(model.id, comment);
    } else if (comment.mode !== vscode.CommentMode.Editing) {
      // Text the user is still typing is theirs until they save it.
      comment.body = feedback.body;
    }
    comment.kind = feedback.feedbackKind;
    comment.label = kindLabel(feedback.feedbackKind);
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

/** An agent's answers on one item, in the order they arrived, ready to sit under the comment. */
function activityComments(model: ReviewThread): vscode.Comment[] {
  return model.activities.flatMap((activity) =>
    activity.kind === "feedback"
      ? []
      : [feedbackActivityComment({ ...activity, author: `${activity.harness} agent` })],
  );
}

/** A delete of `id` takes the comment itself and every reply that answers it. */
function takenWithId(model: ReviewThread, id: string): boolean {
  return model.id === id || model.threadId === id;
}

/** The thread a comment sits on: the id of the comment that opened it. */
function threadKey(model: ReviewThread): string {
  return model.threadId ?? model.id;
}

/** Group the models by the thread they sit on, oldest comment first. */
function groupThreads(models: ReviewThread[]): Map<string, ReviewThread[]> {
  const groups = new Map<string, ReviewThread[]>();
  for (const model of models) {
    const key = threadKey(model);
    const group = groups.get(key);
    if (group) {
      group.push(model);
    } else {
      groups.set(key, [model]);
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  return groups;
}
