// Data shapes for a review thread and its re-attachment anchors.

import type { CommentKind } from "../comments/kinds.js";
import type { Harness } from "../protocol/types.js";
import type { FileGroup } from "../types.js";

export type ThreadItemAuthor =
  | { kind: "reviewer" }
  | { kind: "agent"; harness: Harness; sessionId?: string };

export type ThreadItem =
  | {
      kind: "comment";
      commentKind: CommentKind;
      body: string;
      quote: string;
      at: string;
    }
  | {
      id: string;
      kind: "reply";
      author: ThreadItemAuthor;
      body: string;
      at: string;
    };

export interface ReviewAnchor {
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
  lineHash: string;
}

/** One thread: one place in the diff, and the whole conversation held there. */
export interface ReviewThread {
  id: string;
  sourceUri?: string;
  /** Canonical repository root; filePath is relative to this root. */
  repoRoot: string;
  /** Repo-relative file the comment sits on. Empty for a comment left on a changeset description,
   *  which is about a group of changes rather than a line of code — see {@link changeset}. */
  filePath: string;
  /** Set when the comment was left on a changeset's description document. */
  changeset?: { id: string; title: string };
  side: "base" | "modified";
  line: number; // 0-based on the side's document
  anchor: ReviewAnchor;
  delivery: "pending" | "sent";
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  items: [Extract<ThreadItem, { kind: "comment" }>, ...ThreadItem[]];
  /** The changeset description as it read when the comment was left. The document is virtual and
   *  only exists while the plan is open, so the copy travels with the thread. */
  sourceDocument?: { uri: string; markdown: string };
  /** Durable location metadata. Absent on a thread whose diff tab was never opened. */
  attachment?: {
    /** Git layer where the comment was last attached. */
    group: FileGroup;
    /** Pinned base ContentRef token carried by the diff tab. */
    baseRef: string;
    baseLabel?: string;
    /** Exact document URI used as a final historical fallback. */
    sourceUri: string;
  };
}

export function getReviewerItems(thread: ReviewThread): ThreadItem[] {
  return thread.items.filter((item) => item.kind === "comment" || item.author.kind === "reviewer");
}

/** The comment that opens a thread — always the first item, so this never fails. */
export function getOpeningComment(thread: ReviewThread): Extract<ThreadItem, { kind: "comment" }> {
  return thread.items[0];
}
