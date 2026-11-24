import type { CompareTo } from "../protocol/guidedReview.js";
import type { VizFileRef, VizFocus } from "../protocol/viz.js";
import type { VizDoc, VizIssue } from "./model/types.js";

export type VizAlignment =
  | { kind: "aligned" }
  | { kind: "available" }
  | { kind: "blocked"; reason: string };

export interface VizWindowState {
  compareTo: CompareTo;
  compareLabel: string;
  alignment: VizAlignment;
}

export interface VizListEntry {
  name: string;
  title: string;
  repoName: string;
  modifiedAt: string;
}

export type VizFileStatus = "A" | "M" | "D" | "R";

export interface VizReviewFile {
  repo: string;
  path: string;
  status: VizFileStatus;
  additions: number;
  deletions: number;
  seen: boolean;
}

export type VizNoteTarget =
  | { kind: "node"; id: string; label: string }
  | { kind: "member"; id: string; node: string; label: string }
  | { kind: "edge"; id: string; label: string }
  | { kind: "step"; flow: string; index: number; label: string }
  | { kind: "file"; repo: string; path: string; label: string };

export interface VizNoteItem {
  id: string;
  who: "you" | "agent";
  body: string;
  at: string;
  sent: boolean;
}

export interface VizNote {
  id: string;
  kind: "question" | "comment";
  title: string;
  body: string;
  items: VizNoteItem[];
  sent: boolean;
  unread: number;
  waiting: boolean;
  resolved: boolean;
  targets: VizNoteTarget[];
}

export interface VizFeedbackState {
  waiting: boolean;
  pending: number;
}

export interface VizReviewState {
  files: VizReviewFile[];
  notes: VizNote[];
  feedback: VizFeedbackState;
}

export interface VizViewState {
  stage: string;
  show: "all" | "api" | "implementation" | "fields";
  filters: { notSeen: boolean; openThreads: boolean };
  grouping: "links" | "folders";
  sidebar: boolean;
  sidebarWidth: number;
}

export const DEFAULT_VIZ_VIEW_STATE: VizViewState = {
  stage: "diagram",
  show: "all",
  filters: { notSeen: false, openThreads: false },
  grouping: "links",
  sidebar: true,
  sidebarWidth: 280,
};

export type HostToWebview =
  | {
      type: "load";
      doc: VizDoc;
      window: VizWindowState;
      vizzes: VizListEntry[];
      review: VizReviewState;
      view: VizViewState;
    }
  | { type: "invalid"; name: string; issues: VizIssue[] }
  | { type: "empty"; vizzes: VizListEntry[] }
  | { type: "window"; window: VizWindowState }
  | { type: "vizzes"; vizzes: VizListEntry[] }
  | { type: "review"; review: VizReviewState }
  | { type: "focus"; focus: VizFocus }
  | { type: "showNote"; id: string };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "open"; file: VizFileRef; mode: "file" | "diff" }
  | { type: "align" }
  | { type: "regenerate" }
  | { type: "switch"; name: string }
  | { type: "copy"; text: string; what: string }
  | { type: "seen"; repo: string; path: string; seen: boolean }
  | { type: "resetSeen" }
  | { type: "viewState"; state: VizViewState }
  | {
      type: "note.add";
      kind: "question" | "comment";
      title: string;
      body: string;
      targets: VizNoteTarget[];
    }
  | {
      type: "note.edit";
      id: string;
      kind: "question" | "comment";
      body: string;
      targets: VizNoteTarget[];
    }
  | { type: "note.reply"; id: string; body: string }
  | { type: "note.editReply"; id: string; body: string }
  | { type: "note.read"; id: string }
  | { type: "note.resolve"; id: string }
  | { type: "note.delete"; id: string }
  | { type: "gate"; action: "sendFeedback" | "approve" };
