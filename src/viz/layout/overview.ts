import type { VizNode } from "../../protocol/viz.js";
import type { VizIndex } from "../model/index.js";
import {
  changeSize,
  componentOf,
  formatCounts,
  type Component,
  type Grouping,
  type Show,
} from "../model/visible.js";
import { BOX, measureClassBox, type ClassBoxLayout } from "./classBox.js";
import type { ElkLabel, ElkLike, ElkNode } from "./elk.js";
import { union, type Point, type Rect } from "./geometry.js";
import { autoGroups } from "./grouping.js";
import { estimateMeasure, fitText, type Measure } from "./measure.js";
import { boxPorts, edgeEntry } from "./ports.js";

export const CARD = { width: 224, height: 76, subHeight: 20 } as const;
export const FRAME = { title: 26, inset: 14, maxTitle: 360 } as const;
const SCENE = { pad: 28, laneHeader: 40 } as const;

export interface OverviewOptions {
  readonly show: Show;
  readonly grouping: Grouping;
  readonly expanded: ReadonlySet<string>;
  readonly measure: Measure;
  readonly threads: ReadonlyMap<string, number>;
}

export const DEFAULT_OVERVIEW_OPTIONS: OverviewOptions = {
  show: "all",
  grouping: "links",
  expanded: new Set(),
  measure: estimateMeasure,
  threads: new Map(),
};

export interface LaneBand extends Rect {
  readonly id: string;
  readonly label: string;
  readonly index: number;
}

export type FrameKind = "parent" | "links" | "folder";

export interface PlacedFrame extends Rect {
  readonly id: string;
  readonly kind: FrameKind;
  readonly label: string;
  readonly counts: string | undefined;
  readonly depth: number;
  readonly node: VizNode | undefined;
  readonly members: readonly string[];
}

export interface PlacedNode extends Rect {
  readonly id: string;
  readonly component: "classBox" | "card";
  readonly box: ClassBoxLayout | undefined;
}

export interface RoutedEdge {
  readonly id: string;
  readonly points: readonly Point[];
  readonly label?: Rect;
  readonly fromLabel?: Rect;
  readonly toLabel?: Rect;
}

export interface OverviewScene {
  readonly lanes: readonly LaneBand[];
  readonly frames: readonly PlacedFrame[];
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly RoutedEdge[];
  readonly bounds: Rect;
}

const EDGE_SPACING: Record<string, string> = {
  "elk.spacing.edgeNode": "20",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.edgeEdge": "14",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.portPort": "14",
};

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.randomSeed": "1",
  "elk.partitioning.activate": "true",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
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
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

const FRAME_OPTIONS: Record<string, string> = {
  ...EDGE_SPACING,
  "elk.padding": `[top=${FRAME.title + 6},left=${FRAME.inset},bottom=${FRAME.inset},right=${FRAME.inset}]`,
  "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
  "elk.spacing.nodeNode": "20",
  "elk.spacing.componentComponent": "20",
  "elk.layered.spacing.nodeNodeBetweenLayers": "40",
};

interface FrameSpec {
  readonly kind: FrameKind;
  readonly label: string;
  readonly counts: string | undefined;
  readonly node: VizNode | undefined;
  readonly depth: number;
}

interface Build {
  readonly index: VizIndex;
  readonly options: OverviewOptions;
  readonly frames: Map<string, FrameSpec>;
  readonly leaves: Map<string, { component: Component; box: ClassBoxLayout | undefined }>;
  readonly ports: Set<string>;
}

export function laneOf(index: VizIndex, node: VizNode): string {
  let at: VizNode | undefined = node;
  while (at && at.lane === undefined && at.parent !== undefined) {
    at = index.nodeById.get(at.parent);
  }
  return at?.lane ?? node.lane ?? "";
}

function partitionOf(index: VizIndex, lane: string): Record<string, string> {
  return { "elk.partitioning.partition": String(index.laneIndex.get(lane) ?? 0) };
}

function frameMinWidth(label: string, counts: string | undefined, measure: Measure): number {
  const countsWidth = counts ? BOX.gap + measure(counts, "small") + BOX.pillPadX * 2 : 0;
  const title = fitText(label, "smallBold", FRAME.maxTitle - countsWidth, measure);
  return Math.ceil(FRAME.inset * 2 + 16 + measure(title, "smallBold") + countsWidth);
}

function frameNode(
  build: Build,
  id: string,
  spec: FrameSpec,
  children: ElkNode[],
  lane: string,
): ElkNode {
  build.frames.set(id, spec);
  const minWidth = frameMinWidth(spec.label, spec.counts, build.options.measure);
  return {
    id,
    layoutOptions: {
      ...FRAME_OPTIONS,
      ...partitionOf(build.index, lane),
      "elk.nodeSize.minimum": `(${minWidth},${FRAME.title + FRAME.inset * 2})`,
    },
    children,
  };
}

function subtreeCounts(index: VizIndex, node: VizNode): string | undefined {
  let added = 0;
  let removed = 0;
  const walk = (id: string) => {
    const at = index.nodeById.get(id);
    if (at?.counts) {
      added += at.counts.added;
      removed += at.counts.removed;
    }
    for (const child of index.childrenByParent.get(id) ?? []) {
      walk(child);
    }
  };
  walk(node.id);
  return added + removed > 0 ? formatCounts({ added, removed }) : undefined;
}

function nodeEntry(build: Build, node: VizNode, depth: number): ElkNode {
  const { index, options } = build;
  const component = componentOf(index, node);
  const lane = laneOf(index, node);
  if (component === "frame") {
    const children = (index.childrenByParent.get(node.id) ?? [])
      .map((id) => index.nodeById.get(id))
      .filter((child): child is VizNode => child !== undefined && !child.flowOnly)
      .map((child) => nodeEntry(build, child, depth + 1));
    return frameNode(
      build,
      node.id,
      { kind: "parent", label: node.label, counts: subtreeCounts(index, node), node, depth },
      children,
      lane,
    );
  }
  if (component === "classBox") {
    const box = measureClassBox(
      node,
      options.show,
      options.expanded.has(node.id),
      options.measure,
      options.threads.get(node.id) ?? 0,
    );
    build.leaves.set(node.id, { component, box });
    return {
      id: node.id,
      width: box.width,
      height: box.height,
      ports: boxPorts(build.index, build.ports, node, box),
      layoutOptions: { ...partitionOf(index, lane), "elk.portConstraints": "FIXED_POS" },
    };
  }
  build.leaves.set(node.id, { component, box: undefined });
  return {
    id: node.id,
    width: CARD.width,
    height: CARD.height + (node.sub ? CARD.subHeight : 0),
    layoutOptions: partitionOf(index, lane),
  };
}

function sumCounts(index: VizIndex, ids: readonly string[]): string | undefined {
  let added = 0;
  let removed = 0;
  for (const id of ids) {
    const node = index.nodeById.get(id);
    if (node?.counts) {
      added += node.counts.added;
      removed += node.counts.removed;
    }
  }
  return added + removed > 0 ? formatCounts({ added, removed }) : undefined;
}

function toElk(index: VizIndex, options: OverviewOptions): { graph: ElkNode; build: Build } {
  const build: Build = { index, options, frames: new Map(), leaves: new Map(), ports: new Set() };
  const roots = index.overviewNodes.filter(
    (node) => node.parent === undefined || !index.nodeById.has(node.parent),
  );
  const entries = new Map(roots.map((node) => [node.id, nodeEntry(build, node, 0)] as const));
  const children: ElkNode[] = [];
  const grouped = new Set<string>();
  const groups = index.lanes.length === 0 ? autoGroups(index, options.grouping) : [];
  for (const group of groups) {
    const first = index.nodeById.get(group.members[0])!;
    children.push(
      frameNode(
        build,
        group.id,
        {
          kind: options.grouping === "links" ? "links" : "folder",
          label: group.title,
          counts: sumCounts(index, group.members),
          node: undefined,
          depth: 0,
        },
        group.members.map((id) => entries.get(id)!),
        laneOf(index, first),
      ),
    );
    group.members.forEach((id) => grouped.add(id));
  }
  for (const [id, entry] of entries) {
    if (!grouped.has(id)) {
      children.push(entry);
    }
  }
  const placed = new Set([...build.leaves.keys(), ...build.frames.keys()]);
  const edges = index.edges
    .filter((edge) => placed.has(edge.from) && placed.has(edge.to) && edge.from !== edge.to)
    .map((edge) => edgeEntry(build.index, build.ports, build.options.measure, edge));
  return { graph: { id: "root", layoutOptions: ROOT_OPTIONS, children, edges }, build };
}

function absoluteOrigins(root: ElkNode): Map<string, Point> {
  const origins = new Map<string, Point>([["root", { x: 0, y: 0 }]]);
  const walk = (node: ElkNode, origin: Point) => {
    for (const child of node.children ?? []) {
      const at = { x: origin.x + (child.x ?? 0), y: origin.y + (child.y ?? 0) };
      origins.set(child.id, at);
      walk(child, at);
    }
  };
  walk(root, { x: 0, y: 0 });
  return origins;
}

function labelRect(label: ElkLabel | undefined, shift: (p: Point) => Point): Rect | undefined {
  return label && label.x !== undefined && label.y !== undefined
    ? { ...shift({ x: label.x, y: label.y }), width: label.width ?? 0, height: label.height ?? 0 }
    : undefined;
}

export async function layoutOverview(
  index: VizIndex,
  elk: ElkLike,
  options: OverviewOptions = DEFAULT_OVERVIEW_OPTIONS,
): Promise<OverviewScene> {
  const { graph, build } = toElk(index, options);
  const laid = await elk.layout(graph);
  const origins = absoluteOrigins(laid);
  const offset = { x: SCENE.pad, y: SCENE.pad + (index.lanes.length > 0 ? SCENE.laneHeader : 0) };
  const at = (id: string): Point => {
    const origin = origins.get(id) ?? { x: 0, y: 0 };
    return { x: origin.x + offset.x, y: origin.y + offset.y };
  };

  const nodes: PlacedNode[] = [];
  const frames: PlacedFrame[] = [];
  const walk = (node: ElkNode) => {
    for (const child of node.children ?? []) {
      const rect = { ...at(child.id), width: child.width ?? 0, height: child.height ?? 0 };
      const frame = build.frames.get(child.id);
      if (frame) {
        frames.push({
          id: child.id,
          ...frame,
          ...rect,
          members: (child.children ?? []).map((member) => member.id),
        });
        walk(child);
        continue;
      }
      const leaf = build.leaves.get(child.id);
      if (leaf && leaf.component !== "frame") {
        nodes.push({ id: child.id, component: leaf.component, box: leaf.box, ...rect });
      }
    }
  };
  walk(laid);

  const edges: RoutedEdge[] = (laid.edges ?? []).map((edge) => {
    const origin = at(edge.container ?? "root");
    const shift = (p: Point): Point => ({ x: p.x + origin.x, y: p.y + origin.y });
    const points = (edge.sections ?? []).flatMap((section) => [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]);
    const source = index.edgeById.get(edge.id);
    const labels = edge.labels ?? [];
    let next = 0;
    const take = (present: unknown) => (present ? labels[next++] : undefined);
    return {
      id: edge.id,
      points: points.map(shift),
      label: labelRect(take(source?.label), shift),
      toLabel: labelRect(take(source?.multiplicity?.to), shift),
      fromLabel: labelRect(take(source?.multiplicity?.from), shift),
    };
  });

  const content = union([
    ...nodes,
    ...frames,
    ...edges
      .flatMap((edge) => [edge.label, edge.fromLabel, edge.toLabel])
      .filter((rect): rect is Rect => rect !== undefined),
  ]);
  const bounds: Rect = {
    x: 0,
    y: 0,
    width: content.x + content.width + SCENE.pad,
    height: content.y + content.height + SCENE.pad,
  };

  const extents = new Map<string, { min: number; max: number }>();
  for (const node of nodes) {
    const placedNode = index.nodeById.get(node.id);
    const lane = placedNode ? laneOf(index, placedNode) : "";
    const extent = extents.get(lane) ?? { min: Infinity, max: -Infinity };
    extent.min = Math.min(extent.min, node.x - FRAME.inset);
    extent.max = Math.max(extent.max, node.x + node.width + FRAME.inset);
    extents.set(lane, extent);
  }
  const populated = index.lanes.filter((lane) => extents.has(lane.id));
  const lanes: LaneBand[] = populated.map((lane, i) => {
    const extent = extents.get(lane.id)!;
    const prev = i > 0 ? extents.get(populated[i - 1].id)! : undefined;
    const after = i + 1 < populated.length ? extents.get(populated[i + 1].id)! : undefined;
    const left = prev ? (prev.max + extent.min) / 2 : bounds.x;
    const right = after ? (extent.max + after.min) / 2 : bounds.x + bounds.width;
    return {
      id: lane.id,
      label: lane.label,
      index: index.laneIndex.get(lane.id) ?? i,
      x: left,
      y: bounds.y,
      width: right - left,
      height: bounds.height,
    };
  });

  return { lanes, frames, nodes, edges, bounds };
}

export function frameTitle(frame: PlacedFrame, measure: Measure): string {
  const countsWidth = frame.counts
    ? BOX.gap + measure(frame.counts, "small") + BOX.pillPadX * 2
    : 0;
  const room = Math.max(40, frame.width - FRAME.inset * 2 - 16 - countsWidth);
  return fitText(frame.label, "smallBold", room, measure);
}

export function changedShare(index: VizIndex, node: VizNode): number {
  const largest = Math.max(1, ...index.overviewNodes.map((candidate) => changeSize(candidate)));
  return changeSize(node) / largest;
}
