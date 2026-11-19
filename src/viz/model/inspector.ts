import type { VizChangeDetail, VizDelta, VizMultiplicity, VizNode } from "../../protocol/viz.js";
import type { VizNote } from "../protocol.js";
import type { IndexedEdge, VizIndex } from "./index.js";
import type { VizRef } from "./types.js";

export function nodeContextChips(
  node: VizNode,
  index: Pick<VizIndex, "lanes" | "nodeById">,
): string[] {
  const lane = index.lanes.find((candidate) => candidate.id === node.lane)?.label;
  const parent = node.parent && (index.nodeById.get(node.parent)?.label ?? node.parent);
  return [lane, parent].filter((label): label is string => Boolean(label));
}

export function changeWord(item: {
  readonly delta?: VizDelta;
  readonly detail?: VizChangeDetail;
}): string {
  switch (item.delta ?? "unchanged") {
    case "added":
      return "new";
    case "removed":
      return "removed";
    case "unchanged":
      return "unchanged";
    case "changed":
      return item.detail ? `${item.detail} changed` : "modified";
  }
}

export function linksCausedBy(index: VizIndex, memberId: string): IndexedEdge[] {
  return index.edges.filter(
    (edge) => edge.fromMember === memberId || (edge.via ?? []).includes(memberId),
  );
}

const MULTIPLICITY_WORDS: Record<string, string> = {
  "1": "one",
  "0..1": "zero or one",
  "1..*": "one or more",
  "0..*": "any number",
  "*": "any number",
};

function multiplicityWord(value: string): string {
  return MULTIPLICITY_WORDS[value] ?? value;
}

export function multiplicityText(multiplicity: VizMultiplicity | undefined): string | undefined {
  if (!multiplicity || (!multiplicity.from && !multiplicity.to)) {
    return undefined;
  }
  const from = multiplicity.from ? multiplicityWord(multiplicity.from) : "";
  const to = multiplicity.to ? `to ${multiplicityWord(multiplicity.to)}` : "";
  return [from, to].filter(Boolean).join(" ");
}

export function notesAbout(notes: readonly VizNote[], ref: VizRef): VizNote[] {
  return notes.filter(
    (note) =>
      !note.resolved &&
      note.targets.some((target) => {
        switch (ref.kind) {
          case "node":
            return (
              (target.kind === "node" && target.id === ref.id) ||
              (target.kind === "member" && target.node === ref.id)
            );
          case "member":
            return target.kind === "member" && target.id === ref.id;
          case "edge":
            return target.kind === "edge" && target.id === ref.id;
          case "step":
            return target.kind === "step" && target.flow === ref.flow && target.index === ref.index;
          default:
            return false;
        }
      }),
  );
}
