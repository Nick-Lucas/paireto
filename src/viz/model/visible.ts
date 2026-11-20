import type { VizDelta, VizMember, VizNode, VizNodeKind } from "../../protocol/viz.js";
import type { VizIndex } from "./index.js";

export type Show = "all" | "api" | "implementation" | "fields";

export interface ShowInfo {
  readonly id: Show;
  readonly label: string;
  readonly description: string;
}

export const SHOWS: readonly ShowInfo[] = [
  { id: "all", label: "All changes", description: "Every changed part and member." },
  {
    id: "api",
    label: "API",
    description: "Members that were added, removed or given a new signature.",
  },
  {
    id: "implementation",
    label: "Implementation",
    description: "Methods whose body changed but whose signature did not.",
  },
  { id: "fields", label: "Fields", description: "Fields and properties that changed." },
];

export type Grouping = "links" | "folders";

export interface GroupingInfo {
  readonly id: Grouping;
  readonly label: string;
  readonly description: string;
}

export const GROUPINGS: readonly GroupingInfo[] = [
  {
    id: "links",
    label: "By links",
    description: "Linked parts sit together in one frame. Lines run left to right.",
  },
  {
    id: "folders",
    label: "By folder",
    description: "Parts sit in a frame for the folder of their first file.",
  },
];

export type Component = "classBox" | "frame" | "card";

const CLASS_KINDS: ReadonlySet<VizNodeKind> = new Set([
  "class",
  "interface",
  "enum",
  "struct",
  "module",
  "file",
]);

export function componentOf(index: VizIndex, node: VizNode): Component {
  if (node.kind === "package" || node.kind === "system" || index.childrenByParent.has(node.id)) {
    return "frame";
  }
  return CLASS_KINDS.has(node.kind) ? "classBox" : "card";
}

export type Chip = "A" | "D" | "M" | "S";

export function chipOf(item: {
  readonly delta?: VizDelta;
  readonly detail?: "signature" | "body";
}): Chip | undefined {
  switch (item.delta ?? "unchanged") {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "changed":
      return item.detail === "signature" ? "S" : "M";
    case "unchanged":
      return undefined;
  }
}

export const CHIP_WORDS: Record<Chip, string> = {
  A: "Added",
  D: "Removed",
  M: "Changed",
  S: "Signature changed",
};

export const MAX_ROWS = 6;

export type Compartment = "fields" | "methods";

export function compartmentOf(member: VizMember): Compartment {
  return member.kind === "method" || member.kind === "constructor" ? "methods" : "fields";
}

export function changeSize(item: { readonly counts?: { added: number; removed: number } }): number {
  return item.counts ? item.counts.added + item.counts.removed : 0;
}

export function memberMatches(member: VizMember, show: Show): boolean {
  const delta = member.delta ?? "unchanged";
  if (delta === "unchanged") {
    return false;
  }
  switch (show) {
    case "all":
      return true;
    case "api":
      return delta !== "changed" || member.detail === "signature";
    case "implementation":
      return (
        compartmentOf(member) === "methods" && delta === "changed" && member.detail !== "signature"
      );
    case "fields":
      return compartmentOf(member) === "fields";
  }
}

export function nodeMatches(node: VizNode, show: Show): boolean {
  if (node.delta === "unchanged") {
    return false;
  }
  switch (show) {
    case "all":
      return true;
    case "api":
      return (
        node.delta !== "changed" ||
        node.detail === "signature" ||
        (node.members ?? []).some((member) => memberMatches(member, "api"))
      );
    case "implementation":
    case "fields":
      return (node.members ?? []).some((member) => memberMatches(member, show));
  }
}

export function showCounts(index: VizIndex): Record<Show, number> {
  const counts: Record<Show, number> = { all: 0, api: 0, implementation: 0, fields: 0 };
  for (const node of index.overviewNodes) {
    for (const show of SHOWS) {
      if (nodeMatches(node, show.id)) {
        counts[show.id] += 1;
      }
    }
  }
  return counts;
}

export type SummaryRow =
  | { readonly kind: "more"; readonly count: number }
  | { readonly kind: "less" }
  | { readonly kind: "outside"; readonly count: number }
  | { readonly kind: "unchanged"; readonly count: number };

export interface BoxRows {
  readonly fields: readonly VizMember[];
  readonly methods: readonly VizMember[];
  readonly summary: readonly SummaryRow[];
  readonly expandable: boolean;
}

function largest(members: readonly VizMember[], keep: number): VizMember[] {
  const kept = new Set([...members].sort((a, b) => changeSize(b) - changeSize(a)).slice(0, keep));
  return members.filter((member) => kept.has(member));
}

export function boxRows(node: VizNode, show: Show, expanded: boolean): BoxRows {
  const members = node.members ?? [];
  const changed = members.filter((member) => (member.delta ?? "unchanged") !== "unchanged");
  const matching = changed.filter((member) => memberMatches(member, show));
  const summary: SummaryRow[] = [];
  let shown: readonly VizMember[];
  if (expanded) {
    shown = members;
    summary.push({ kind: "less" });
  } else {
    const base = changed.length === 0 ? members : matching;
    shown = base.length > MAX_ROWS ? largest(base, MAX_ROWS) : base;
    if (base.length > shown.length) {
      summary.push({ kind: "more", count: base.length - shown.length });
    }
    if (changed.length > matching.length) {
      summary.push({ kind: "outside", count: changed.length - matching.length });
    }
    if (changed.length > 0 && members.length > changed.length) {
      summary.push({ kind: "unchanged", count: members.length - changed.length });
    }
  }
  const expandable = members.length > shown.length || summary.some((row) => row.kind !== "outside");
  return {
    fields: shown.filter((member) => compartmentOf(member) === "fields"),
    methods: shown.filter((member) => compartmentOf(member) === "methods"),
    summary,
    expandable,
  };
}

export function summaryText(row: SummaryRow): string {
  switch (row.kind) {
    case "more":
      return `… ${row.count} smaller change${row.count === 1 ? "" : "s"} · show all`;
    case "less":
      return "Show fewer";
    case "outside":
      return `… ${row.count} other change${row.count === 1 ? "" : "s"} outside this view`;
    case "unchanged":
      return `… ${row.count} unchanged`;
  }
}

export function formatCounts(counts: { added: number; removed: number }): string {
  return `+${counts.added} / −${counts.removed}`;
}

export function folderOf(node: VizNode): string | undefined {
  const path = node.files?.[0]?.path;
  if (!path) {
    return undefined;
  }
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : ".";
}

export function overviewKind(index: VizIndex): string {
  const kinds = new Set(
    index.overviewNodes
      .map((node) => componentOf(index, node))
      .filter((component) => component !== "frame"),
  );
  if (kinds.has("classBox") && kinds.has("card")) {
    return "class and component diagram";
  }
  return kinds.has("classBox") ? "class diagram" : "component diagram";
}
