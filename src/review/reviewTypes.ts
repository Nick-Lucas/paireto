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

export interface DiagramTarget {
  repoRoot: string;
  name: string;
  filePath: string;
  line: number;
}

export interface DiagramLink {
  scope: "type" | "member" | "group" | "file";
  title: string;
  typeIds: string[];
  memberId?: string;
  fileKey?: string;
  targets: DiagramTarget[];
}

export interface DiagramAnchor {
  title: string;
  links: DiagramLink[];
  place?: { typeId?: string; x: number; y: number };
  readAt?: string;
}

export interface ReviewThread extends ThreadItems {
  sourceUri?: string;

  repoRoot: string;
  filePath: string;
  changeset?: { id: string; title: string };
  diagram?: DiagramAnchor;
  side: "base" | "modified";
  line: number; // 0-based on the side's document
  anchor: ReviewAnchor;
  delivery: "pending" | "sent";
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  sentAt?: string;
  sourceDocument?: { uri: string; markdown: string };
  attachment?: {
    group: FileGroup;
    baseRef: string;
    baseLabel?: string;
    sourceUri: string;
  };
}
