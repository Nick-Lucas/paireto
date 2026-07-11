// Data shapes for code-review comments and their re-attachment anchors.

import type { CommentKind } from "../comments/kinds.js";
import type { FileGroup } from "../types.js";

export interface ReviewAnchor {
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
  lineHash: string;
}

export interface ReviewComment {
  id: string;
  filePath: string; // repo-relative
  side: "base" | "modified";
  line: number; // 0-based on the side's document
  kind: CommentKind;
  body: string;
  quote: string;
  anchor: ReviewAnchor;
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
