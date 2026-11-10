import { NO_FILTERS, type LayoutMode, type ReviewFilters, type ReviewFocus } from "./focus.js";
import type { NotePlace, UmlCommentLink, UmlModel } from "./model.js";

export interface UmlViewState {
  focus: ReviewFocus;
  layout: LayoutMode;
  filters: ReviewFilters;
  changes: boolean;
  changesWidth: number;
}

export const DEFAULT_VIEW_STATE: UmlViewState = {
  focus: "all",
  layout: "relationships",
  filters: NO_FILTERS,
  changes: true,
  changesWidth: 260,
};

export interface FeedbackState {
  waiting: boolean;
  pending: number;
}

export type HostMessage =
  | { type: "init"; state: UmlViewState }
  | { type: "feedback"; feedback: FeedbackState }
  | { type: "loading"; message: string }
  | { type: "model"; model: UmlModel }
  | { type: "error"; message: string };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "open"; typeId: string; memberId?: string }
  | { type: "openFile"; fileKey: string; change?: number }
  | { type: "setRead"; fileKey: string; read: boolean }
  | { type: "resetReview" }
  | { type: "pickCompareTo" }
  | { type: "refresh" }
  | { type: "viewState"; state: UmlViewState }
  | { type: "addComment"; kind: "question" | "comment"; body: string; links: UmlCommentLink[] }
  | { type: "linkComment"; id: string; link: UmlCommentLink }
  | { type: "unlinkComment"; id: string; index: number }
  | { type: "moveComment"; id: string; place: NotePlace }
  | { type: "replyComment"; id: string; body: string }
  | { type: "readComment"; id: string }
  | {
      type: "editComment";
      id: string;
      kind: "question" | "comment";
      body: string;
      links: UmlCommentLink[];
    }
  | { type: "editReply"; id: string; body: string }
  | { type: "deleteComment"; id: string }
  | { type: "sendFeedback" }
  | { type: "approve" }
  | { type: "openComment"; id: string }
  | { type: "resolveComment"; id: string };
