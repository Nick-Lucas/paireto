import type { CompareTo } from "../../protocol/guidedReview.js";
import { VIZ_FILE_VERSION, type VizBase, type VizFile } from "../../protocol/viz.js";

export interface VizGeneratorRequest {
  repoRoot: string;
  compareTo: CompareTo;
  title?: string;
}

export type VizGenerator = (req: VizGeneratorRequest) => Promise<VizFile>;

export const SUMMARY_PLACEHOLDER =
  "TODO: replace this summary. Say what changed and why it matters in 1-3 sentences.";

export const DEFAULT_VIZ_TITLE = "Change visualization";

export function skeletonViz(base: VizBase, compareTo: CompareTo, title?: string): VizFile {
  return {
    version: VIZ_FILE_VERSION,
    title: title ?? DEFAULT_VIZ_TITLE,
    summary: SUMMARY_PLACEHOLDER,
    base,
    compareTo,
    generatedAt: new Date().toISOString(),
    nodes: [],
  };
}
