// Data shapes for a review thread and its re-attachment anchors.

import type { ThreadItems } from "../comments/threadModel.js";
import type { FileGroup } from "../types.js";

export type { ThreadItem, ThreadItemAuthor } from "../comments/threadModel.js";
export { getOpeningComment, getReviewerItems } from "../comments/threadModel.js";

export interface ReviewAnchor {
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
  lineHash: string;
}

/** One thread: one place in the diff, and the whole conversation held there. */
export interface ReviewThread extends ThreadItems {
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
