import type { VizNode } from "../../protocol/viz.js";
import type { VizIndex } from "./index.js";

export function nodeContextChips(
  node: VizNode,
  index: Pick<VizIndex, "lanes" | "nodeById">,
): string[] {
  const lane = index.lanes.find((candidate) => candidate.id === node.lane)?.label;
  const parent = node.parent && (index.nodeById.get(node.parent)?.label ?? node.parent);
  return [lane, parent].filter((label): label is string => Boolean(label));
}
