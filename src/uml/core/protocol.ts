import { NO_FILTERS, type LayoutMode, type ReviewFilters, type ReviewFocus } from "./focus.js";
import type { UmlCommentLink, UmlModel } from "./model.js";

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

export type HostMessage =
  | { type: "init"; state: UmlViewState }
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
  | { type: "openComment"; id: string }
  | { type: "resolveComment"; id: string };
