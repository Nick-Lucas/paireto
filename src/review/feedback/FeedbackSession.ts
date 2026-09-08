// The feedback for one commenting context: its buckets on disk, and its comment threads in the
// editor. Every change goes into a bucket first, then one render() makes the editor agree. Nothing
// else creates, moves or removes a feedback comment thread.

import * as vscode from "vscode";

import type { GateComment, CommentSession } from "../../comments/CommentSession.js";
import { ThreadRenderer } from "../../comments/ThreadRenderer.js";
import type { FeedbackRef } from "../../git/gitCli.js";
import { log } from "../../log.js";
import { locateThreadItem } from "../../comments/threadModel.js";
import { canonicalize } from "../../protocol/paths.js";
import { openFeedbackBucket, type FeedbackBucket } from "../../storage/FeedbackStore.js";
import {
  appendFeedbackReply,
  editFeedback,
  editFeedbackReply,
  removeFeedbackReply,
} from "../feedbackState.js";
import {
  getOpeningComment,
  getReviewerItems,
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
  private readonly renderer: ThreadRenderer<ReviewThread>;

  private constructor(private readonly host: FeedbackHost) {
    this.renderer = new ThreadRenderer({
      comments: host.comments,
      uriFor: (thread) => host.uriFor(thread),
      labelFor: (thread) => host.labelFor(thread),
      resolved: (thread) => thread.resolvedAt !== undefined,
      // The provider is cleared when a review ends, so every saved description is registered again.
      prepare: (threads) => {
        for (const thread of threads) {
          if (thread.sourceDocument) {
            host.registerDoc(host.uriFor(thread), thread.sourceDocument.markdown);
          }
        }
      },
      edited: (id, body) => void this.edit(id, body),
      deleted: (id) => void this.removeCommentOrThread(id),
    });
  }

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
    return this.renderer.commentFor(id);
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
    const target = locateThreadItem(this.allThreads(), id);
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
    const target = locateThreadItem(this.allThreads(), id);
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

  amendThread(id: string, change: (thread: ReviewThread) => ReviewThread): boolean {
    const thread = this.allThreads().find((item) => item.id === id);
    if (!thread) {
      log.error(`feedback ${id} is not held by this session`);
      return false;
    }
    return this.write(thread.repoRoot, (draft) => {
      const model = draft.threads.find((item) => item.id === id);
      if (model) {
        Object.assign(model, change(model));
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

  markResolved(ids: Set<string>, at: string): ReviewThread[] {
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

            if (getOpeningComment(model).commentKind === "comment") {
              model.resolvedAt = at;
            }
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
    this.renderer.render(this.allThreads());
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
    this.renderer.dispose();
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
