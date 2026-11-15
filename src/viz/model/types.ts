import type { CompareTo } from "../../protocol/guidedReview.js";
import type { VizFile } from "../../protocol/viz.js";

export const VIZ_DOC_FORMAT = 2;

export type VizRef =
  | { kind: "node"; id: string }
  | { kind: "member"; id: string; node: string }
  | { kind: "edge"; id: string }
  | { kind: "flow"; id: string }
  | { kind: "step"; flow: string; index: number };

export interface VizRepo {
  name: string;
  root: string;
}

export interface VizMeta {
  name: string;
  path: string;
  repoRoot: string;
  repoName: string;
  repos: VizRepo[];
  compareTo?: CompareTo;
  compareLabel?: string;
  checkedAt: string;
}

export interface VizDoc {
  format: typeof VIZ_DOC_FORMAT;
  meta: VizMeta;
  viz: VizFile;
}

export type VizIssueSeverity = "error" | "warning";

export interface VizIssue {
  severity: VizIssueSeverity;
  rule: string;
  path: string;
  message: string;
  suggestion?: string;
}
