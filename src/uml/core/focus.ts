import {
  changeSize,
  type UmlFile,
  type UmlMember,
  type UmlModel,
  type UmlRelation,
  type UmlType,
} from "./model.js";

export type ReviewFocus = "all" | "api" | "implementation" | "fields";

export type LayoutMode = "relationships" | "folders";

export interface ReviewFilters {
  notSeen: boolean;
  openThreads: boolean;
}

export const NO_FILTERS: ReviewFilters = { notSeen: false, openThreads: false };

export const MAX_ROWS = 6;

export interface FocusInfo {
  id: ReviewFocus;
  label: string;
  description: string;
}

export const FOCI: readonly FocusInfo[] = [
  { id: "all", label: "All changes", description: "Every changed type and member." },
  {
    id: "api",
    label: "API",
    description: "Types and members that were added, removed or given a new signature.",
  },
  {
    id: "implementation",
    label: "Implementation",
    description: "Methods whose body changed but whose signature did not.",
  },
  {
    id: "fields",
    label: "Fields",
    description: "Fields and properties that were added, removed or changed.",
  },
];

export interface LayoutInfo {
  id: LayoutMode;
  label: string;
  description: string;
}

export const LAYOUTS: readonly LayoutInfo[] = [
  {
    id: "relationships",
    label: "By links",
    description:
      "Connected types sit together. Lines run left to right: subtypes and users on the left, supertypes and used types on the right.",
  },
  {
    id: "folders",
    label: "By folder",
    description:
      "Types sit in a frame for their folder and file. Double-click a file frame for its whole diff.",
  },
];

export interface HiddenMembers {
  smaller: number;
  outside: number;
  unchanged: number;
}

export interface VisibleType {
  type: UmlType;
  role: "primary" | "context";
  members: UmlMember[];
  hidden: HiddenMembers;
  expandable: boolean;
  rank?: number;
}

export interface FocusedView {
  types: VisibleType[];
  relations: UmlRelation[];
  primaryCount: number;
}

export interface FocusOptions {
  filters: ReviewFilters;
  expanded: ReadonlySet<string>;
}

export function memberMatches(member: UmlMember, focus: ReviewFocus): boolean {
  if (member.change === "unchanged") {
    return false;
  }
  switch (focus) {
    case "api":
      return (
        member.change === "added" || member.change === "removed" || member.change === "signature"
      );
    case "implementation":
      return member.compartment === "method" && member.change === "body";
    case "fields":
      return member.compartment === "field";
    default:
      return true;
  }
}

export function typeMatches(type: UmlType, focus: ReviewFocus): boolean {
  if (type.context || type.change === "unchanged") {
    return false;
  }
  switch (focus) {
    case "api":
      return (
        type.kind !== "file" &&
        (type.change === "added" ||
          type.change === "removed" ||
          type.headerChanged ||
          type.members.some((m) => memberMatches(m, "api")))
      );
    case "implementation":
    case "fields":
      return type.members.some((m) => memberMatches(m, focus));
    default:
      return true;
  }
}

function passesFilters(type: UmlType, file: UmlFile | undefined, filters: ReviewFilters): boolean {
  if (filters.notSeen && (!file || file.read)) {
    return false;
  }
  if (filters.openThreads && type.openThreads === 0) {
    return false;
  }
  return true;
}

export function rankTypes(types: readonly UmlType[]): Map<string, number> {
  const ranked = [...types].sort(
    (a, b) => changeSize(b.counts) - changeSize(a.counts) || a.name.localeCompare(b.name),
  );
  return new Map(ranked.map((t, i) => [t.id, i + 1]));
}

function foldMembers(
  type: UmlType,
  focus: ReviewFocus,
  expanded: boolean,
): { members: UmlMember[]; hidden: HiddenMembers; expandable: boolean } {
  const matching = type.members.filter((m) => memberMatches(m, focus));
  const changed = type.members.filter((m) => m.change !== "unchanged").length;
  const ordered = [
    ...matching.filter((m) => m.compartment === "field"),
    ...matching.filter((m) => m.compartment === "method"),
  ];
  let members = ordered;
  if (!expanded && ordered.length > MAX_ROWS) {
    const keep = new Set(
      [...ordered].sort((a, b) => changeSize(b.counts) - changeSize(a.counts)).slice(0, MAX_ROWS),
    );
    members = ordered.filter((m) => keep.has(m));
  }
  return {
    members,
    hidden: {
      smaller: ordered.length - members.length,
      outside: changed - matching.length,
      unchanged: type.members.length - changed,
    },
    expandable: ordered.length > MAX_ROWS,
  };
}

export function applyFocus(
  model: UmlModel,
  focus: ReviewFocus,
  options: FocusOptions,
): FocusedView {
  const files = new Map(model.files.map((f) => [f.key, f]));
  const primaryTypes = model.types.filter(
    (t) => typeMatches(t, focus) && passesFilters(t, files.get(t.fileKey), options.filters),
  );
  const primary = new Set(primaryTypes.map((t) => t.id));
  const ranks = rankTypes(primaryTypes);
  const context = new Set<string>();
  for (const relation of model.relations) {
    if (primary.has(relation.source) && !primary.has(relation.target)) {
      context.add(relation.target);
    }
    if (primary.has(relation.target) && !primary.has(relation.source)) {
      context.add(relation.source);
    }
  }
  const types: VisibleType[] = [];
  for (const type of model.types) {
    if (primary.has(type.id)) {
      types.push({
        type,
        role: "primary",
        ...foldMembers(type, focus, options.expanded.has(type.id)),
        rank: ranks.get(type.id),
      });
    } else if (context.has(type.id) && type.kind !== "module" && type.kind !== "file") {
      types.push({
        type,
        role: "context",
        members: [],
        hidden: { smaller: 0, outside: 0, unchanged: 0 },
        expandable: false,
      });
    }
  }
  const visible = new Set(types.map((t) => t.type.id));
  return {
    types,
    relations: model.relations.filter((r) => visible.has(r.source) && visible.has(r.target)),
    primaryCount: primary.size,
  };
}

export function focusCount(model: UmlModel, focus: ReviewFocus): number {
  return model.types.filter((t) => typeMatches(t, focus)).length;
}
