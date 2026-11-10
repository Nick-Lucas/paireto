import type { CompareTo } from "../protocol/guidedReview.js";
import type { VizFileRef } from "../protocol/viz.js";
import type { VizDoc } from "./model/types.js";

export interface VizWindowState {
  compareTo: CompareTo;
  compareLabel: string;
  aligned: boolean;
}

export interface VizHistoryEntry {
  id: string;
  title: string;
  createdAt: string;
  repoName: string;
}

export type HostToWebview =
  | { type: "load"; doc: VizDoc; history: VizHistoryEntry[]; window: VizWindowState }
  | { type: "window"; window: VizWindowState };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "open"; file: VizFileRef; mode: "file" | "diff" }
  | { type: "align" }
  | { type: "showHistory"; id: string }
  | { type: "copy"; text: string; what: string };
