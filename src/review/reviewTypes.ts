// Data shapes for code-review comments and their re-attachment anchors.

import type { CommentKind } from "../comments/kinds.js";

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
  resolved: boolean;
  quote: string;
  anchor: ReviewAnchor;
}
