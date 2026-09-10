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

export interface FeedbackHost {
  readonly comments: CommentSession;

  uriFor(model: ReviewThread): vscode.Uri;
  labelFor(model: ReviewThread): string;

  registerDoc(uri: vscode.Uri, markdown: string): void;
  changed(): void;
}

export interface RelocatePatch {
  line: number;
  sourceUri: string;
  filePath?: string;
  attachment?: ReviewThread["attachment"];
}

export class FeedbackSession {
  private readonly buckets = new Map<string, FeedbackBucket>();
  private readonly renderer: ThreadRenderer<ReviewThread>;

  private constructor(private readonly host: FeedbackHost) {
    this.renderer = new ThreadRenderer({
      comments: host.comments,
      uriFor: (thread) => host.uriFor(thread),
      labelFor: (thread) => host.labelFor(thread),
      resolved: (thread) => thread.resolvedAt !== undefined,
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

  async flush(): Promise<void> {
    await Promise.all(Array.from(this.buckets.values(), (bucket) => bucket.flush()));
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.buckets.values(), (bucket) => bucket.close()));
  }

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
