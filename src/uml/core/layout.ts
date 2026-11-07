import type { ElkExtendedEdge, ElkLabel, ElkNode, LayoutOptions } from "elkjs/lib/elk-api.js";

import type { FocusedView, LayoutMode, VisibleType } from "./focus.js";
import {
  changeSize,
  type LineCounts,
  type NotePlace,
  type UmlComment,
  type UmlCommentLink,
  type UmlFile,
  type UmlRelation,
  type UmlType,
} from "./model.js";
import { ROUTE_GAP, routeLine, type Block, type Port } from "./route.js";

export type FontRole = "title" | "code" | "small" | "smallBold";

export type Measure = (text: string, font: FontRole) => number;

export interface LayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export interface Point {
  x: number;
  y: number;
}

export interface RowLayout {
  memberId?: string;
  kind: "member" | "summary" | "more" | "less";
  text: string;
  full: string;
  y: number;
  counts?: string;
}

export interface NodeLayout {
  id: string;
  role: "primary" | "context";
  x: number;
  y: number;
  width: number;
  height: number;
  headerHeight: number;
  stereotype?: string;
  title: string;
  titleFull: string;
  counts?: string;
  threads?: number;
  readSlot: boolean;
  noDiff: boolean;
  outsideFocus: boolean;
  overview: boolean;
  rows: RowLayout[];
  dividers: number[];
}

export interface ContainerLayout {
  id: string;
  kind: "folder" | "file" | "group";
  title: string;
  titleFull: string;
  counts?: string;
  fileKey?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  typeIds?: string[];
}

export interface EdgeLayout {
  id: string;
  relation: UmlRelation;
  points: Point[];
  label?: { text: string; x: number; y: number; width: number; height: number; anchor?: Point };
}

export interface NoteLayout {
  id: string;
  comment: UmlComment;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  home: string;
  links: NoteLinkLayout[];
}

export interface NoteLinkLayout {
  index: number;
  points: Point[];
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: NodeLayout[];
  containers: ContainerLayout[];
  edges: EdgeLayout[];
  notes: NoteLayout[];
}

export interface LayoutInput {
  view: FocusedView;
  files: readonly UmlFile[];
  mode: LayoutMode;
  aspectRatio: number;
  repoCount: number;
  overview?: boolean;
  comments?: readonly UmlComment[];
}

export const NO_DIFF = "no diff";

export const NOTE_LINES = 4;

export const NOTE_METRICS = {
  width: 220,
  padX: 10,
  headHeight: 24,
  lineHeight: 16,
  padBottom: 10,
} as const;

export const OUTSIDE_FOCUS = "outside focus";

export const METRICS = {
  padX: 10,
  headerPadY: 7,
  stereotypeHeight: 14,
  nameHeight: 18,
  rowHeight: 20,
  compartmentPadY: 5,
  glyphWidth: 16,
  gap: 12,
  pillPadX: 6,
  minWidth: 150,
  contextMinWidth: 96,
  maxWidth: 380,
  containerTitleHeight: 24,
  containerPad: 8,
  frameInset: 14,
  containerMaxTitle: 360,
  labelHeight: 14,
  readSlot: 14,
  threadIcon: 20,
  kindTag: 16,
} as const;

const STEREOTYPES: Partial<Record<UmlType["kind"], string>> = {
  interface: "«interface»",
  enum: "«enumeration»",
  struct: "«struct»",
  module: "«module»",
  file: "«file»",
};

export function formatCounts(counts: LineCounts): string {
  return `+${counts.added} / −${counts.removed}`;
}

export function fitText(text: string, font: FontRole, maxWidth: number, measure: Measure): string {
  if (measure(text, font) <= maxWidth) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, mid)}…`, font) <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low)}…`;
}

export function wrapText(
  text: string,
  font: FontRole,
  maxWidth: number,
  measure: Measure,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, font) <= maxWidth) {
      line = next;
    } else if (line) {
      lines.push(line);
      line = fitText(word, font, maxWidth, measure);
    } else {
      lines.push(fitText(word, font, maxWidth, measure));
    }
  }
  if (line) {
    lines.push(line);
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  const rest = lines.slice(maxLines - 1).join(" ");
  return [...lines.slice(0, maxLines - 1), fitText(`${rest} …`, font, maxWidth, measure)];
}

function pillWidth(text: string, measure: Measure): number {
  return measure(text, "small") + METRICS.pillPadX * 2;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function summaryRows(visible: VisibleType): { kind: RowLayout["kind"]; full: string }[] {
  const { hidden } = visible;
  const rows: { kind: RowLayout["kind"]; full: string }[] = [];
  if (hidden.smaller > 0) {
    rows.push({ kind: "more", full: `… ${plural(hidden.smaller, "smaller change")} · show all` });
  } else if (visible.expandable) {
    rows.push({ kind: "less", full: "Show fewer" });
  }
  if (hidden.outside > 0) {
    rows.push({
      kind: "summary",
      full: `… ${plural(hidden.outside, "other change")} outside this focus`,
    });
  }
  if (hidden.unchanged > 0) {
    rows.push({ kind: "summary", full: `… ${hidden.unchanged} unchanged` });
  }
  return rows;
}

export interface MeasureOptions {
  overview: boolean;
}

export function measureType(
  visible: VisibleType,
  measure: Measure,
  options: MeasureOptions,
): Omit<NodeLayout, "x" | "y"> {
  const { type } = visible;
  const stereotype = options.overview ? undefined : STEREOTYPES[type.kind];
  const noDiff = !!type.context || type.change === "unchanged";
  const outsideFocus = visible.role === "context" && !noDiff;
  const counts = !noDiff && changeSize(type.counts) > 0 ? formatCounts(type.counts) : undefined;
  const readSlot = visible.role === "primary" && type.change !== "unchanged";
  const threads = type.openThreads > 0 ? type.openThreads : undefined;
  const headerExtras =
    (counts ? METRICS.gap + pillWidth(counts, measure) : 0) +
    (noDiff ? METRICS.gap + pillWidth(NO_DIFF, measure) : 0) +
    (outsideFocus ? METRICS.gap + pillWidth(OUTSIDE_FOCUS, measure) : 0) +
    (readSlot ? METRICS.readSlot : 0) +
    (threads ? measure(String(threads), "small") + METRICS.threadIcon : 0) +
    (options.overview && type.kind !== "class" ? METRICS.kindTag : 0);
  const titleWidth = measure(type.name, "title");
  const headerNeed =
    METRICS.padX * 2 +
    Math.max(
      METRICS.glyphWidth + titleWidth + headerExtras,
      METRICS.glyphWidth + (stereotype ? measure(stereotype, "small") : 0),
    );

  const rowSpecs: {
    memberId?: string;
    kind: RowLayout["kind"];
    text: string;
    full: string;
    counts?: string;
    compartment: string;
  }[] = [];
  if (!options.overview) {
    for (const compartment of ["field", "method"]) {
      for (const member of visible.members.filter((m) => m.compartment === compartment)) {
        rowSpecs.push({
          memberId: member.id,
          kind: "member",
          text: member.short,
          full: member.label,
          counts: changeSize(member.counts) > 0 ? formatCounts(member.counts) : undefined,
          compartment,
        });
      }
    }
    for (const row of summaryRows(visible)) {
      rowSpecs.push({ ...row, text: row.full, compartment: "summary" });
    }
  }
  const rowNeed = Math.max(
    0,
    ...rowSpecs.map((row) =>
      row.kind === "member"
        ? METRICS.padX * 2 +
          METRICS.glyphWidth +
          measure(row.text, "code") +
          (row.counts ? METRICS.gap + measure(row.counts, "small") : 0)
        : METRICS.padX * 2 + METRICS.glyphWidth + measure(row.text, "small"),
    ),
  );
  const minWidth = visible.role === "context" ? METRICS.contextMinWidth : METRICS.minWidth;
  const width = Math.round(Math.min(METRICS.maxWidth, Math.max(minWidth, headerNeed, rowNeed)));

  const titleRoom = width - METRICS.padX * 2 - METRICS.glyphWidth - headerExtras;
  const title = fitText(type.name, "title", titleRoom, measure);
  const headerHeight =
    METRICS.headerPadY * 2 + METRICS.nameHeight + (stereotype ? METRICS.stereotypeHeight : 0);

  const rows: RowLayout[] = [];
  const dividers: number[] = [];
  let y = headerHeight;
  let previous: string | undefined;
  for (const spec of rowSpecs) {
    if (spec.compartment !== previous && spec.compartment !== "summary") {
      if (previous !== undefined) {
        y += METRICS.compartmentPadY;
      }
      dividers.push(y);
      y += METRICS.compartmentPadY;
      previous = spec.compartment;
    } else if (spec.compartment === "summary" && previous === undefined) {
      dividers.push(y);
      y += METRICS.compartmentPadY;
      previous = "summary";
    }
    const room =
      width -
      METRICS.padX * 2 -
      METRICS.glyphWidth -
      (spec.counts ? METRICS.gap + measure(spec.counts, "small") : 0);
    rows.push({
      memberId: spec.memberId,
      kind: spec.kind,
      full: spec.full,
      text: fitText(spec.text, spec.kind === "member" ? "code" : "small", room, measure),
      counts: spec.counts,
      y,
    });
    y += METRICS.rowHeight;
  }
  if (rows.length > 0) {
    y += METRICS.compartmentPadY;
  }
  return {
    id: type.id,
    role: visible.role,
    width,
    height: y,
    headerHeight,
    stereotype,
    title,
    titleFull: type.name,
    counts,
    threads,
    readSlot,
    noDiff,
    outsideFocus,
    overview: options.overview,
    rows,
    dividers,
  };
}

const EDGE_SPACING: LayoutOptions = {
  "elk.spacing.edgeNode": "20",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.edgeEdge": "14",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.portPort": "14",
};

const BASE_OPTIONS: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.randomSeed": "1",
  "elk.layered.unnecessaryBendpoints": "true",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.thoroughness": "12",
  "elk.layered.mergeEdges": "false",
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  ...EDGE_SPACING,
  "elk.spacing.edgeLabel": "4",
  "elk.spacing.labelNode": "6",
  "elk.spacing.componentComponent": "36",
  "elk.separateConnectedComponents": "true",
  "elk.padding": "[top=16,left=16,bottom=16,right=16]",
};

export function containerMinimum(width: number, direction: string): string {
  return direction === "UP" || direction === "DOWN" ? `(0,${width})` : `(${width},0)`;
}

interface ContainerSpec {
  id: string;
  kind: ContainerLayout["kind"];
  title: string;
  counts?: string;
  fileKey?: string;
  depth: number;
  children: (ContainerSpec | string)[];
  relations?: UmlRelation[];
}

function containerNode(
  spec: ContainerSpec,
  leaves: Map<string, ElkNode>,
  measure: Measure,
  titles: Map<string, string>,
  direction: string,
): ElkNode {
  const countsWidth = spec.counts ? METRICS.gap + pillWidth(spec.counts, measure) : 0;
  const titleRoom = METRICS.containerMaxTitle - countsWidth;
  const title = fitText(spec.title, "smallBold", titleRoom, measure);
  titles.set(spec.id, title);
  const minWidth = Math.ceil(
    METRICS.containerPad * 2 + measure(title, "smallBold") + countsWidth + METRICS.glyphWidth,
  );
  return {
    id: spec.id,
    layoutOptions: {
      ...EDGE_SPACING,
      "elk.padding": `[top=${METRICS.containerTitleHeight + 4},left=${METRICS.frameInset},bottom=${METRICS.frameInset},right=${METRICS.frameInset}]`,
      "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
      "elk.nodeSize.minimum": containerMinimum(minWidth, direction),
      "elk.spacing.nodeNode": "20",
      "elk.spacing.componentComponent": "20",
      "elk.layered.spacing.nodeNodeBetweenLayers": "36",
    },
    children: spec.children.map((child) =>
      typeof child === "string"
        ? (leaves.get(child) as ElkNode)
        : containerNode(child, leaves, measure, titles, direction),
    ),
  };
}

function sumCounts(list: readonly LineCounts[]): LineCounts {
  return list.reduce(
    (sum, c) => ({ added: sum.added + c.added, removed: sum.removed + c.removed }),
    {
      added: 0,
      removed: 0,
    },
  );
}

function folderTree(
  input: LayoutInput,
  ordered: readonly VisibleType[],
): (ContainerSpec | string)[] {
  const files = new Map(input.files.map((f) => [f.key, f]));
  const displayPath = (file: UmlFile): string =>
    input.repoCount > 1 ? `${file.repoName}/${file.path}` : file.path;
  interface Folder {
    name: string;
    folders: Map<string, Folder>;
    files: Map<string, string[]>;
  }
  const root: Folder = { name: "", folders: new Map(), files: new Map() };
  for (const visible of ordered) {
    const file = files.get(visible.type.fileKey);
    const parts = file ? displayPath(file).split("/") : [visible.type.fileKey];
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { name: part, folders: new Map(), files: new Map() };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    const list = folder.files.get(visible.type.fileKey) ?? [];
    list.push(visible.type.id);
    folder.files.set(visible.type.fileKey, list);
  }
  const fileCounts = (key: string): LineCounts =>
    files.get(key)?.counts ?? { added: 0, removed: 0 };
  const allFiles = (folder: Folder): string[] => [
    ...folder.files.keys(),
    ...[...folder.folders.values()].flatMap(allFiles),
  ];
  const build = (folder: Folder, path: string, depth: number): (ContainerSpec | string)[] => {
    const children: (ContainerSpec | string)[] = [];
    for (const sub of folder.folders.values()) {
      let name = sub.name;
      let current = sub;
      while (current.files.size === 0 && current.folders.size === 1) {
        const only = [...current.folders.values()][0];
        name = `${name}/${only.name}`;
        current = only;
      }
      const subPath = path === "" ? name : `${path}/${name}`;
      const counts = sumCounts(allFiles(current).map(fileCounts));
      children.push({
        id: `folder:${subPath}`,
        kind: "folder",
        title: `${name}/`,
        counts: changeSize(counts) > 0 ? formatCounts(counts) : undefined,
        depth,
        children: build(current, subPath, depth + 1),
      });
    }
    for (const [fileKey, typeIds] of folder.files) {
      const file = files.get(fileKey);
      const only = ordered.find((t) => t.type.id === typeIds[0]);
      if (typeIds.length === 1 && only?.type.kind === "file") {
        children.push(typeIds[0]);
        continue;
      }
      const counts = fileCounts(fileKey);
      children.push({
        id: `file:${fileKey}`,
        kind: "file",
        title: file ? (displayPath(file).split("/").pop() ?? file.path) : fileKey,
        counts: changeSize(counts) > 0 ? formatCounts(counts) : undefined,
        fileKey,
        depth,
        children: typeIds,
      });
    }
    return children;
  };
  return build(root, "", 0);
}

function orderTypes(input: LayoutInput): VisibleType[] {
  const files = new Map(input.files.map((f) => [f.key, f]));
  const pathOf = (t: VisibleType): string => files.get(t.type.fileKey)?.path ?? t.type.fileKey;
  return [...input.view.types].sort(
    (a, b) => pathOf(a).localeCompare(pathOf(b)) || a.type.name.localeCompare(b.type.name),
  );
}

export const FOLDER_DIRECTION = "RIGHT";

function linkedGroups(input: LayoutInput, ordered: readonly VisibleType[]): ContainerSpec[] {
  const parent = new Map(ordered.map((t) => [t.type.id, t.type.id]));
  const root = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) {
      at = parent.get(at) as string;
    }
    return at;
  };
  for (const relation of input.view.relations) {
    if (parent.has(relation.source) && parent.has(relation.target)) {
      parent.set(root(relation.source), root(relation.target));
    }
  }
  const members = new Map<string, VisibleType[]>();
  for (const visible of ordered) {
    const key = root(visible.type.id);
    members.set(key, [...(members.get(key) ?? []), visible]);
  }
  const groups = [...members.values()]
    .filter((list) => list.length > 1)
    .map((list) => {
      const primary = list.filter((t) => t.role === "primary");
      const counts = sumCounts(primary.map((t) => t.type.counts));
      const largest = [...(primary.length > 0 ? primary : list)].sort(
        (a, b) => changeSize(b.type.counts) - changeSize(a.type.counts),
      )[0];
      const ids = new Set(list.map((t) => t.type.id));
      return {
        list,
        counts,
        title: `${largest.type.name} and ${plural(list.length - 1, "linked type")}`,
        relations: input.view.relations.filter((r) => ids.has(r.source)),
      };
    })
    .sort(
      (a, b) =>
        changeSize(b.counts) - changeSize(a.counts) ||
        b.list.length - a.list.length ||
        a.title.localeCompare(b.title),
    );
  return groups.map((group, index) => ({
    id: `group:${index}`,
    kind: "group",
    title: group.title,
    counts: changeSize(group.counts) > 0 ? formatCounts(group.counts) : undefined,
    depth: 0,
    children: group.list.map((t) => t.type.id),
    relations: group.relations,
  }));
}

function edgeFor(relation: UmlRelation, measure: Measure): ElkExtendedEdge {
  const structural = relation.kind === "generalization" || relation.kind === "realization";
  const labels: ElkLabel[] = relation.multiplicity
    ? [
        {
          id: `${relation.id}:label`,
          text: relation.multiplicity,
          width: Math.ceil(measure(relation.multiplicity, "small")) + 4,
          height: METRICS.labelHeight,
          layoutOptions: { "elk.edgeLabels.placement": "HEAD" },
        },
      ]
    : [];
  return {
    id: relation.id,
    sources: [relation.source],
    targets: [relation.target],
    labels,
    layoutOptions: structural
      ? { "elk.layered.priority.direction": "10", "elk.layered.priority.straightness": "10" }
      : relation.kind === "dependency"
        ? { "elk.layered.priority.direction": "0" }
        : {},
  };
}

interface NoteSpec {
  comment: UmlComment;
  width: number;
  height: number;
  lines: string[];
  home: string;
  place?: NotePlace;
}

function parentsOf(node: ElkNode, parents = new Map<string, ElkNode>()): Map<string, ElkNode> {
  for (const child of node.children ?? []) {
    parents.set(child.id, node);
    parentsOf(child, parents);
  }
  return parents;
}

export function noteSize(body: string, measure: Measure): { height: number; lines: string[] } {
  const lines = wrapText(
    body,
    "small",
    NOTE_METRICS.width - NOTE_METRICS.padX * 2,
    measure,
    NOTE_LINES,
  );
  return {
    lines,
    height:
      NOTE_METRICS.headHeight + lines.length * NOTE_METRICS.lineHeight + NOTE_METRICS.padBottom,
  };
}

function placeNotes(
  graph: ElkNode,
  comments: readonly UmlComment[],
  sized: ReadonlyMap<string, unknown>,
  measure: Measure,
): Map<string, NoteSpec> {
  const notes = new Map<string, NoteSpec>();
  const parents = parentsOf(graph);
  for (const comment of comments) {
    const shown = comment.links.flatMap((link) => link.typeIds.filter((id) => sized.has(id)));
    if (comment.links.length > 0 && shown.length === 0) {
      continue;
    }
    const id = `note:${comment.id}`;
    const { lines, height } = noteSize(comment.body, measure);
    const place =
      comment.place && (comment.place.typeId === undefined || sized.has(comment.place.typeId))
        ? comment.place
        : undefined;
    const home = shown.length > 0 ? (parents.get(shown[0]) ?? graph) : graph;
    home.children = [...(home.children ?? []), { id, width: NOTE_METRICS.width, height }];
    const near = comment.links
      .filter((link) => link.scope === "type" || link.scope === "member")
      .map((link) => link.typeIds[0])
      .filter((target, index, all) => all.indexOf(target) === index)
      .filter((target) => sized.has(target) && parents.get(target) === home);
    home.edges = [
      ...(home.edges ?? []),
      ...near.map((target) => ({ id: `${id}:${target}`, sources: [id], targets: [target] })),
    ];
    notes.set(id, { comment, width: NOTE_METRICS.width, height, lines, home: home.id, place });
  }
  return notes;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

function noteLink(note: Box, box: Box, y: number): Point[] {
  const startY = clamp(y, note.y + 8, note.y + note.height - 8);
  if (note.x + note.width <= box.x || box.x + box.width <= note.x) {
    const leftOfBox = note.x + note.width <= box.x;
    const start = { x: leftOfBox ? note.x + note.width : note.x, y: startY };
    const end = { x: leftOfBox ? box.x : box.x + box.width, y };
    const middle = (start.x + end.x) / 2;
    return simplifyPath([start, { x: middle, y: start.y }, { x: middle, y: end.y }, end]);
  }
  const above = note.y + note.height <= box.y;
  const x = clamp(note.x + note.width / 2, box.x + 12, box.x + box.width - 12);
  const start = { x, y: above ? note.y + note.height : note.y };
  const end = { x, y: above ? box.y : box.y + box.height };
  return [start, end];
}

function linkFrame(
  link: UmlCommentLink,
  containers: readonly ContainerLayout[],
): ContainerLayout | undefined {
  return link.scope === "file"
    ? containers.find((c) => c.kind === "file" && c.fileKey === link.fileKey)
    : link.scope === "group"
      ? containers.find((c) => c.kind === "group" && c.typeIds?.includes(link.typeIds[0]))
      : undefined;
}

export type NoteScene = Pick<DiagramLayout, "nodes" | "containers" | "edges" | "notes">;

function notePorts(note: Box, toward: Point): Port[] {
  const ys = [note.y + note.height / 2, clamp(toward.y, note.y + 8, note.y + note.height - 8)];
  const xs = [note.x + note.width / 2, clamp(toward.x, note.x + 12, note.x + note.width - 12)];
  return [
    ...ys.flatMap((y): Port[] => [
      { x: note.x, y, side: "left" },
      { x: note.x + note.width, y, side: "right" },
    ]),
    ...xs.flatMap((x): Port[] => [
      { x, y: note.y, side: "up" },
      { x, y: note.y + note.height, side: "down" },
    ]),
  ];
}

function targetPorts(box: Box, y: number, toward: number, ends: boolean): Port[] {
  const x = clamp(toward, box.x + 12, box.x + box.width - 12);
  return [
    { x: box.x, y, side: "left" },
    { x: box.x + box.width, y, side: "right" },
    { x, y: box.y, side: "up" },
    ...(ends ? [{ x, y: box.y + box.height, side: "down" as const }] : []),
  ];
}

export function noteLinks(
  note: Box & { id?: string; home: string },
  links: readonly UmlCommentLink[],
  scene: NoteScene,
): NoteLinkLayout[] {
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const lines = [
    ...scene.edges.map((edge) => edge.points),
    ...scene.notes.filter((n) => n.id !== note.id).flatMap((n) => n.links.map((l) => l.points)),
  ];
  const soft = scene.edges.flatMap((edge) => (edge.label ? [edge.label] : []));
  const frames = scene.containers.map((c) => ({
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
  }));
  const route = (target: Box & { id: string }, y: number, ends: boolean): Point[] => {
    const blocks: Block[] = [
      { ...boxOf(note), pad: 0 },
      ...scene.nodes.map((n) => ({ ...boxOf(n), pad: n.id === target.id ? 0 : ROUTE_GAP })),
      ...scene.notes.filter((n) => n.id !== note.id).map((n) => ({ ...boxOf(n), pad: ROUTE_GAP })),
    ];
    const points = routeLine(
      notePorts(note, { x: target.x + target.width / 2, y }),
      targetPorts(target, y, note.x + note.width / 2, ends),
      { blocks, soft, frames, lines },
    );
    const result = points ? simplifyPath(points) : noteLink(note, target, y);
    lines.push(result);
    return result;
  };
  return links.flatMap((link, index) => {
    if (link.scope === "type" || link.scope === "member") {
      const node = byId.get(link.typeIds[0]);
      if (!node) {
        return [];
      }
      const row = link.memberId ? node.rows.find((r) => r.memberId === link.memberId) : undefined;
      const y = row ? node.y + row.y + METRICS.rowHeight / 2 : node.y + node.headerHeight / 2;
      return [{ index, points: route(node, y, !row) }];
    }
    const frame = linkFrame(link, scene.containers);
    if (frame) {
      return frame.id === note.home
        ? []
        : [{ index, points: route(frame, frame.y + METRICS.containerTitleHeight / 2, false) }];
    }
    return link.typeIds.flatMap((id) => {
      const node = byId.get(id);
      return node ? [{ index, points: route(node, node.y + node.headerHeight / 2, true) }] : [];
    });
  });
}

function boxOf(item: Box): Box {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

export function notePlace(
  note: Point,
  links: readonly UmlCommentLink[],
  nodes: readonly NodeLayout[],
): NotePlace {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = links.flatMap((link) => link.typeIds).flatMap((id) => byId.get(id) ?? [])[0];
  return node
    ? { typeId: node.id, x: Math.round(note.x - node.x), y: Math.round(note.y - node.y) }
    : { x: Math.round(note.x), y: Math.round(note.y) };
}

export function noteHome(note: Box, containers: readonly ContainerLayout[]): string {
  const holder = containers
    .filter(
      (c) =>
        note.x >= c.x &&
        note.y >= c.y &&
        note.x + note.width <= c.x + c.width &&
        note.y + note.height <= c.y + c.height,
    )
    .sort((a, b) => b.depth - a.depth)[0];
  return holder?.id ?? "root";
}

export function buildGraph(
  input: LayoutInput,
  measure: Measure,
): {
  graph: ElkNode;
  sized: Map<string, Omit<NodeLayout, "x" | "y">>;
  specs: ContainerSpec[];
  titles: Map<string, string>;
  notes: Map<string, NoteSpec>;
} {
  const ordered = orderTypes(input);
  const sized = new Map<string, Omit<NodeLayout, "x" | "y">>();
  const leaves = new Map<string, ElkNode>();
  for (const visible of ordered) {
    const node = measureType(visible, measure, { overview: !!input.overview });
    sized.set(node.id, node);
    leaves.set(node.id, { id: node.id, width: node.width, height: node.height });
  }
  const options: LayoutOptions = {
    ...BASE_OPTIONS,
    "elk.aspectRatio": input.aspectRatio.toFixed(2),
  };
  const titles = new Map<string, string>();
  let specs: ContainerSpec[] = [];
  let children: ElkNode[];
  if (input.mode === "folders") {
    const top = folderTree(input, ordered);
    specs = top.filter((child): child is ContainerSpec => typeof child !== "string");
    options["elk.hierarchyHandling"] = "INCLUDE_CHILDREN";
    options["elk.direction"] = FOLDER_DIRECTION;
    children = top.map((child) =>
      typeof child === "string"
        ? (leaves.get(child) as ElkNode)
        : containerNode(child, leaves, measure, titles, FOLDER_DIRECTION),
    );
  } else {
    specs = linkedGroups(input, ordered);
    const grouped = new Set(specs.flatMap((spec) => spec.children as string[]));
    children = [
      ...specs.map((spec) => {
        const node = containerNode(spec, leaves, measure, titles, BASE_OPTIONS["elk.direction"]);
        node.layoutOptions = {
          ...BASE_OPTIONS,
          "elk.aspectRatio": options["elk.aspectRatio"],
          ...node.layoutOptions,
          "elk.spacing.nodeNode": BASE_OPTIONS["elk.spacing.nodeNode"],
          "elk.layered.spacing.nodeNodeBetweenLayers":
            BASE_OPTIONS["elk.layered.spacing.nodeNodeBetweenLayers"],
        };
        node.edges = (spec.relations ?? []).map((r) => edgeFor(r, measure));
        return node;
      }),
      ...ordered
        .filter((t) => !grouped.has(t.type.id))
        .map((t) => leaves.get(t.type.id) as ElkNode),
    ];
  }
  const inGroups = new Set(specs.flatMap((spec) => (spec.relations ?? []).map((r) => r.id)));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: options,
    children,
    edges: input.view.relations.filter((r) => !inGroups.has(r.id)).map((r) => edgeFor(r, measure)),
  };
  const notes = placeNotes(graph, input.comments ?? [], sized, measure);
  return { graph, sized, specs, titles, notes };
}

export function simplifyPath(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) {
      continue;
    }
    const before = result[result.length - 2];
    if (
      before &&
      last &&
      ((Math.abs(before.x - last.x) < 0.01 && Math.abs(last.x - point.x) < 0.01) ||
        (Math.abs(before.y - last.y) < 0.01 && Math.abs(last.y - point.y) < 0.01))
    ) {
      result[result.length - 1] = point;
      continue;
    }
    result.push(point);
  }
  return result;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const LABEL_GAP = 4;
const LABEL_STEP = 4;
const LABEL_REACH = 120;

function boxesMeet(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function lineMeets(from: Point, to: Point, box: Box): boolean {
  return (
    Math.max(from.x, to.x) > box.x &&
    Math.min(from.x, to.x) < box.x + box.width &&
    Math.max(from.y, to.y) > box.y &&
    Math.min(from.y, to.y) < box.y + box.height
  );
}

function labelSpots(points: readonly Point[], width: number, height: number): Box[] {
  const spots: Box[] = [];
  let walked = 0;
  for (let i = points.length - 1; i > 0 && walked < LABEL_REACH; i--) {
    const end = points[i];
    const before = points[i - 1];
    const vertical = Math.abs(end.x - before.x) < 0.5;
    const length = vertical ? Math.abs(end.y - before.y) : Math.abs(end.x - before.x);
    const extent = vertical ? height : width;
    for (
      let along = LABEL_GAP / 2;
      along + extent <= length || along === LABEL_GAP / 2;
      along += LABEL_STEP
    ) {
      if (vertical) {
        const y = end.y < before.y ? end.y + along : end.y - along - height;
        spots.push({ x: end.x + LABEL_GAP, y, width, height });
        spots.push({ x: end.x - LABEL_GAP - width, y, width, height });
      } else {
        const x = end.x < before.x ? end.x + along : end.x - along - width;
        spots.push({ x, y: end.y + LABEL_GAP, width, height });
        spots.push({ x, y: end.y - LABEL_GAP - height, width, height });
      }
    }
    walked += length;
  }
  return spots;
}

function placeLabels(edges: EdgeLayout[], nodes: readonly NodeLayout[]): void {
  const placed: Box[] = [];
  const crowded: EdgeLayout[] = [];
  const free = (box: Box): boolean =>
    !nodes.some((node) => boxesMeet(node, box)) &&
    !placed.some((other) => boxesMeet(other, box)) &&
    !edges.some((edge) =>
      edge.points.some((p, i) => i > 0 && lineMeets(edge.points[i - 1], p, box)),
    );
  for (const edge of edges) {
    const label = edge.label;
    if (!label || edge.points.length < 2) {
      continue;
    }
    const spot = labelSpots(edge.points, label.width, label.height).find(free);
    if (spot) {
      label.x = spot.x;
      label.y = spot.y;
      placed.push(label);
    } else {
      crowded.push(edge);
    }
  }
  const leaders = placeRoleLabels(
    crowded.map((edge) => ({
      id: edge.id,
      points: edge.points,
      width: edge.label?.width ?? 0,
      height: edge.label?.height ?? 0,
      atEnd: true,
    })),
    [...nodes, ...placed],
    edges.map((edge) => ({ id: edge.id, points: edge.points, strong: true })),
  );
  for (const edge of crowded) {
    const place = leaders.get(edge.id);
    if (edge.label && place?.anchor) {
      edge.label.x = place.x;
      edge.label.y = place.y;
      edge.label.anchor = place.anchor;
    }
  }
}

export interface RoleLabel {
  id: string;
  points: readonly Point[];
  width: number;
  height: number;
  atEnd?: boolean;
}

export interface RolePlace extends Box {
  anchor?: Point;
}

export interface RoleLine {
  id: string;
  points: readonly Point[];
  strong: boolean;
}

const ROLE_END_GAP = 14;
const ROLE_BEND_GAP = 4;
const ROLE_STEP = 4;
const ROLE_MARGIN = 3;
const ROLE_LEADER_STEP = 6;
const ROLE_LEADER_REACH = 160;

function roleSpots(points: readonly Point[], width: number, height: number): Box[] {
  const last = points.length - 2;
  const spots: { box: Box; overhang: number; length: number; offset: number }[] = [];
  for (let i = 0; i <= last; i++) {
    const a = points[i];
    const b = points[i + 1];
    const vertical = Math.abs(a.x - b.x) < 0.5;
    const length = vertical ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
    const extent = vertical ? height : width;
    const low = ROLE_BEND_GAP;
    const high = length - (i === last ? ROLE_END_GAP : ROLE_BEND_GAP);
    if (high < low) {
      continue;
    }
    const middle = (low + high) / 2;
    for (let offset = 0; middle - offset >= low; offset += ROLE_STEP) {
      for (const along of offset === 0 ? [middle] : [middle + offset, middle - offset]) {
        const cx = a.x + ((b.x - a.x) * along) / length;
        const cy = a.y + ((b.y - a.y) * along) / length;
        spots.push({
          box: { x: cx - width / 2, y: cy - height / 2, width, height },
          overhang: Math.max(0, extent / 2 - along, along + extent / 2 - length),
          length,
          offset,
        });
      }
    }
  }
  return spots
    .sort(
      (p, q) =>
        Number(p.overhang > 0) - Number(q.overhang > 0) ||
        p.overhang - q.overhang ||
        q.length - p.length ||
        p.offset - q.offset,
    )
    .map((spot) => spot.box);
}

interface LeaderSide {
  anchor: Point;
  vertical: boolean;
  side: number;
}

function leaderSides(points: readonly Point[], atEnd: boolean): LeaderSide[] {
  const anchors: { anchor: Point; vertical: boolean; middle: number }[] = [];
  const lengths = points
    .slice(1)
    .map((b, i) => Math.abs(b.x - points[i].x) + Math.abs(b.y - points[i].y));
  let walked = lengths.reduce((sum, length) => sum + length, 0);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const vertical = Math.abs(a.x - b.x) < 0.5;
    const length = vertical ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
    for (let along = ROLE_BEND_GAP; along <= length - ROLE_BEND_GAP; along += ROLE_LEADER_STEP) {
      anchors.push({
        anchor: {
          x: a.x + ((b.x - a.x) * along) / length,
          y: a.y + ((b.y - a.y) * along) / length,
        },
        vertical,
        middle: atEnd ? walked - along : Math.abs(along - length / 2),
      });
    }
    walked -= length;
  }
  return anchors
    .sort((p, q) => p.middle - q.middle)
    .flatMap(({ anchor, vertical }) => [
      { anchor, vertical, side: 1 },
      { anchor, vertical, side: -1 },
    ]);
}

function leaderPlaceAt(
  { anchor, vertical, side }: LeaderSide,
  reach: number,
  width: number,
  height: number,
): RolePlace {
  return vertical
    ? {
        x: side > 0 ? anchor.x + reach : anchor.x - reach - width,
        y: anchor.y - height / 2,
        width,
        height,
        anchor,
      }
    : {
        x: anchor.x - width / 2,
        y: side > 0 ? anchor.y + reach : anchor.y - reach - height,
        width,
        height,
        anchor,
      };
}

function leaderOf(place: RolePlace): Box | undefined {
  const anchor = place.anchor;
  if (!anchor) {
    return undefined;
  }
  const endX = Math.min(Math.max(anchor.x, place.x), place.x + place.width);
  const endY = Math.min(Math.max(anchor.y, place.y), place.y + place.height);
  return {
    x: Math.min(anchor.x, endX) - 0.5,
    y: Math.min(anchor.y, endY) - 0.5,
    width: Math.abs(endX - anchor.x) + 1,
    height: Math.abs(endY - anchor.y) + 1,
  };
}

function grown(box: Box): Box {
  return {
    x: box.x - ROLE_MARGIN,
    y: box.y - ROLE_MARGIN,
    width: box.width + ROLE_MARGIN * 2,
    height: box.height + ROLE_MARGIN * 2,
  };
}

const GRID_CELL = 160;

function gridOf<T>(
  items: readonly T[],
  boxOf: (item: T) => Box,
): (box: Box, test: (item: T) => boolean) => boolean {
  const cells = new Map<number, T[]>();
  const span = (from: number, size: number): [number, number] => [
    Math.floor(from / GRID_CELL),
    Math.floor((from + size) / GRID_CELL),
  ];
  const keyOf = (cx: number, cy: number): number => (cx + 4096) * 8192 + cy + 4096;
  for (const item of items) {
    const box = boxOf(item);
    const [x0, x1] = span(box.x, box.width);
    const [y0, y1] = span(box.y, box.height);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = cells.get(keyOf(cx, cy));
        if (list) {
          list.push(item);
        } else {
          cells.set(keyOf(cx, cy), [item]);
        }
      }
    }
  }
  return (box, test) => {
    const [x0, x1] = span(box.x, box.width);
    const [y0, y1] = span(box.y, box.height);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        if (cells.get(keyOf(cx, cy))?.some(test)) {
          return true;
        }
      }
    }
    return false;
  };
}

export function placeRoleLabels(
  labels: readonly RoleLabel[],
  boxes: readonly Box[],
  lines: readonly RoleLine[],
): Map<string, RolePlace> {
  const placed = new Map<string, RolePlace>();
  const taken: Box[] = [];
  const nearBoxes = gridOf(boxes, (box) => box);
  const segments = lines.flatMap((line) =>
    line.points.slice(1).map((to, i) => ({ line, from: line.points[i], to })),
  );
  const nearSegments = gridOf(segments, ({ from, to }) => ({
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  }));
  for (const label of labels) {
    const crosses = (box: Box, avoid: (line: RoleLine) => boolean): boolean =>
      nearSegments(
        box,
        ({ line, from, to }) => line.id !== label.id && avoid(line) && lineMeets(from, to, box),
      );
    const runsAlong = (leader: Box): boolean => {
      const room = grown(leader);
      const upright = leader.width <= 1.5;
      return nearSegments(
        room,
        ({ line, from, to }) =>
          line.id !== label.id &&
          line.strong &&
          upright === Math.abs(to.x - from.x) < 0.5 &&
          lineMeets(from, to, room),
      );
    };
    const meetsBox = (box: Box): boolean =>
      nearBoxes(box, (other) => boxesMeet(other, box)) ||
      taken.some((other) => boxesMeet(other, box));
    const clear = (spot: Box, avoid: (line: RoleLine) => boolean): boolean =>
      !meetsBox(grown(spot)) && !crosses(spot, avoid);
    let sides: LeaderSide[] | undefined;
    const leaderPlace = (
      avoid: (line: RoleLine) => boolean,
      leaderMayCross = false,
    ): RolePlace | undefined => {
      sides ??= leaderSides(label.points, !!label.atEnd);
      let open = sides;
      for (let reach = ROLE_LEADER_STEP; reach <= ROLE_LEADER_REACH; reach += ROLE_LEADER_STEP) {
        const still: LeaderSide[] = [];
        for (const side of open) {
          const place = leaderPlaceAt(side, reach, label.width, label.height);
          const leader = leaderOf(place) as Box;
          if (meetsBox(leader) || (leaderMayCross ? runsAlong(leader) : crosses(leader, avoid))) {
            continue;
          }
          if (clear(place, avoid)) {
            return place;
          }
          still.push(side);
        }
        open = still;
      }
      return undefined;
    };
    const spots = label.atEnd ? [] : roleSpots(label.points, label.width, label.height);
    const all = (): boolean => true;
    const strong = (line: RoleLine): boolean => line.strong;
    const none = (): boolean => false;
    const place =
      spots.find((s) => clear(s, all)) ??
      spots.find((s) => clear(s, strong)) ??
      leaderPlace(strong) ??
      leaderPlace(strong, true) ??
      spots.find((s) => clear(s, none)) ??
      leaderPlace(none) ??
      spots[0] ??
      middleSpot(label);
    placed.set(label.id, place);
    taken.push(place);
    const leader = leaderOf(place);
    if (leader) {
      taken.push(leader);
    }
  }
  return placed;
}

function middleSpot(label: RoleLabel): Box {
  const a = label.points[0];
  const b = label.points[label.points.length - 1];
  return {
    x: (a.x + b.x) / 2 - label.width / 2,
    y: (a.y + b.y) / 2 - label.height / 2,
    width: label.width,
    height: label.height,
  };
}

export async function layoutDiagram(
  input: LayoutInput,
  measure: Measure,
  engine: LayoutEngine,
): Promise<DiagramLayout> {
  const { graph, sized, specs, titles, notes: noteSpecs } = buildGraph(input, measure);
  const result = await engine.layout(graph);
  const absolute = new Map<string, Point>();
  const nodes: NodeLayout[] = [];
  const notes: NoteLayout[] = [];
  const containers: ContainerLayout[] = [];
  const specById = new Map<string, ContainerSpec>();
  const index = (list: readonly ContainerSpec[]): void => {
    for (const spec of list) {
      specById.set(spec.id, spec);
      index(spec.children.filter((c): c is ContainerSpec => typeof c !== "string"));
    }
  };
  index(specs);
  const visit = (node: ElkNode, offset: Point): void => {
    const at = { x: offset.x + (node.x ?? 0), y: offset.y + (node.y ?? 0) };
    absolute.set(node.id, at);
    const spec = specById.get(node.id);
    const leaf = sized.get(node.id);
    const note = noteSpecs.get(node.id);
    if (note?.place) {
      return;
    }
    if (note) {
      notes.push({
        id: note.comment.id,
        comment: note.comment,
        x: at.x,
        y: at.y,
        width: note.width,
        height: note.height,
        lines: note.lines,
        home: note.home,
        links: [],
      });
    } else if (spec) {
      containers.push({
        id: spec.id,
        kind: spec.kind,
        title: titles.get(spec.id) ?? spec.title,
        titleFull: spec.title,
        counts: spec.counts,
        fileKey: spec.fileKey,
        depth: spec.depth,
        typeIds: spec.kind === "group" ? (spec.children as string[]) : undefined,
        x: at.x,
        y: at.y,
        width: node.width ?? 0,
        height: node.height ?? 0,
      });
    } else if (leaf) {
      nodes.push({ ...leaf, x: at.x, y: at.y });
    }
    for (const edge of node.edges ?? []) {
      owned.push({ edge, owner: node.id });
    }
    for (const child of node.children ?? []) {
      visit(child, at);
    }
  };
  const owned: { edge: ElkExtendedEdge & { container?: string }; owner: string }[] = (
    result.edges ?? []
  ).map((edge) => ({ edge, owner: "root" }));
  absolute.set("root", { x: 0, y: 0 });
  for (const child of result.children ?? []) {
    visit(child, { x: 0, y: 0 });
  }
  const relations = new Map(input.view.relations.map((r) => [r.id, r]));
  const edges: EdgeLayout[] = [];
  for (const { edge, owner } of owned) {
    const relation = relations.get(edge.id);
    const section = edge.sections?.[0];
    if (!relation || !section) {
      continue;
    }
    const offset = absolute.get(edge.container ?? owner) ?? { x: 0, y: 0 };
    const shift = (p: Point): Point => ({ x: p.x + offset.x, y: p.y + offset.y });
    const points = simplifyPath(
      [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(shift),
    );
    const label = edge.labels?.[0];
    edges.push({
      id: edge.id,
      relation,
      points,
      label:
        label && label.text
          ? {
              text: label.text,
              x: (label.x ?? 0) + offset.x,
              y: (label.y ?? 0) + offset.y,
              width: label.width ?? 0,
              height: label.height ?? 0,
            }
          : undefined,
    });
  }
  containers.sort((a, b) => a.depth - b.depth);
  placeLabels(edges, nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const note of noteSpecs.values()) {
    const place = note.place;
    if (!place) {
      continue;
    }
    const anchor = place.typeId === undefined ? { x: 0, y: 0 } : byId.get(place.typeId);
    if (!anchor) {
      continue;
    }
    const at = {
      x: Math.max(0, anchor.x + place.x),
      y: Math.max(0, anchor.y + place.y),
      width: note.width,
      height: note.height,
    };
    notes.push({
      id: note.comment.id,
      comment: note.comment,
      ...at,
      lines: note.lines,
      home: noteHome(at, containers),
      links: [],
    });
  }
  const scene = { nodes, containers, edges, notes };
  for (const note of notes) {
    note.links = noteLinks(note, note.comment.links, scene);
  }
  const reach = notes.flatMap((note) => [
    { x: note.x + note.width, y: note.y + note.height },
    ...note.links.flatMap((link) => link.points),
  ]);
  return {
    width: Math.ceil(Math.max(result.width ?? 0, ...reach.map((p) => p.x + 16))),
    height: Math.ceil(Math.max(result.height ?? 0, ...reach.map((p) => p.y + 16))),
    nodes,
    containers,
    edges,
    notes,
  };
}
