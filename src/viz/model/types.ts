import type { CompareTo } from "../../protocol/guidedReview.js";
import type { Harness } from "../../protocol/types.js";
import type { VizArgs } from "../../protocol/viz.js";

export const VIZ_DOC_FORMAT = 1;

export type EdgeKey = `${string}>${string}`;

export type VizRef =
  | { kind: "node"; id: string }
  | { kind: "edge"; key: EdgeKey }
  | { kind: "flow"; id: string }
  | { kind: "step"; flow: string; index: number };

export type ChangedFileStatus = "A" | "M" | "D" | "R";

export interface VizChangedFile {
  repo: string;
  path: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
}

export interface VizRepo {
  name: string;
  root: string;
}

export interface VizMeta {
  id: string;
  repoRoot: string;
  repoName: string;
  repos: VizRepo[];
  harness: Harness;
  compareTo: CompareTo;
  compareLabel: string;
  createdAt: string;
  changed: VizChangedFile[];
}

export interface VizDoc {
  format: typeof VIZ_DOC_FORMAT;
  meta: VizMeta;
  viz: VizArgs;
}
