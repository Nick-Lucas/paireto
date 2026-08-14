// Data shapes for code-review feedback and its re-attachment anchors.

import type { CommentKind } from "../comments/kinds.js";
import type { Harness } from "../protocol/types.js";
import type { FileGroup } from "../types.js";

export type FeedbackActivity =
  | {
      kind: "feedback";
      feedbackKind: CommentKind;
      body: string;
      quote: string;
      at: string;
    }
  | {
      kind: "reply";
      body: string;
      at: string;
      harness: Harness;
      sessionId?: string;
    }
  | {
      kind: "resolved";
      at: string;
      harness: Harness;
      sessionId?: string;
    };

export interface ReviewAnchor {
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
  lineHash: string;
}

export interface ReviewThread {
  id: string;
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
  activities: [Extract<FeedbackActivity, { kind: "feedback" }>, ...FeedbackActivity[]];
  /** The changeset description as it read when the comment was left. The document is virtual and
   *  only exists while the plan is open, so the copy travels with the feedback. */
  sourceDocument?: { uri: string; markdown: string };
  /** Durable location metadata. Optional for compatibility with older exported review artifacts. */
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

/** The reviewer's own words — always the first activity, so this never fails. */
export function userFeedback(
  thread: ReviewThread,
): Extract<FeedbackActivity, { kind: "feedback" }> {
  return thread.activities[0];
}
