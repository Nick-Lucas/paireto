import type { VizNode } from "../../protocol/viz.js";
import type { VizIndex } from "../model/index.js";
import { edgeKey } from "../model/refs.js";
import type { EdgeKey } from "../model/types.js";
import { estimateTextWidth, union, type Point, type Rect } from "./geometry.js";

export interface ElkLabel {
  text?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface ElkNode {
  id: string;
  layoutOptions?: Record<string, string>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  labels?: ElkLabel[];
}

export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  container?: string;
  labels?: ElkLabel[];
  sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[];
}

export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

const CARD = { width: 212, height: 64, subHeight: 18 } as const;
const SCENE = { pad: 28, laneHeader: 40, groupTab: 30, groupPad: 16 } as const;

function cardSize(node: VizNode): { width: number; height: number } {
  return { width: CARD.width, height: CARD.height + (node.sub ? CARD.subHeight : 0) };
}

export interface LaneBand extends Rect {
  readonly id: string;
  readonly label: string;
  readonly index: number;
}

export interface GroupBox extends Rect {
  readonly id: string;
  readonly label: string;
  readonly lane: string;
  readonly members: readonly string[];
}

export interface PlacedNode extends Rect {
  readonly id: string;
}

export interface RoutedEdge {
  readonly key: EdgeKey;
  readonly points: readonly Point[];
  readonly label?: Rect;
}

export interface OverviewScene {
  readonly lanes: readonly LaneBand[];
  readonly groups: readonly GroupBox[];
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly RoutedEdge[];
  readonly bounds: Rect;
}

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.partitioning.activate": "true",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.layered.spacing.edgeNodeBetweenLayers": "32",
  "elk.spacing.nodeNode": "32",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "16",
  "elk.spacing.edgeLabel": "4",
  "elk.edgeLabels.inline": "true",
  "elk.edgeLabels.placement": "CENTER",
};

function groupId(lane: string, group: string): string {
  return `group:${lane}:${group}`;
}

function toElk(index: VizIndex): ElkNode {
  const children: ElkNode[] = [];
  const groups = new Map<string, ElkNode>();
  for (const node of index.nodes) {
    if (node.flowOnly) {
      continue;
    }
    const partition = String(index.laneIndex.get(node.lane) ?? 0);
    const child: ElkNode = {
      id: node.id,
      ...cardSize(node),
      layoutOptions: { "elk.partitioning.partition": partition },
    };
    if (!node.group) {
      children.push(child);
      continue;
    }
    const id = groupId(node.lane, node.group);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        children: [],
        layoutOptions: {
          "elk.partitioning.partition": partition,
          "elk.padding": `[top=${SCENE.groupTab},left=${SCENE.groupPad},bottom=${SCENE.groupPad},right=${SCENE.groupPad}]`,
          "elk.spacing.nodeNode": "28",
          "elk.layered.spacing.nodeNodeBetweenLayers": "64",
        },
      };
      groups.set(id, group);
      children.push(group);
    }
    group.children?.push(child);
  }
  const placed = new Set(index.nodes.filter((node) => !node.flowOnly).map((node) => node.id));
  const edges: ElkEdge[] = index.edges
    .filter((edge) => placed.has(edge.from) && placed.has(edge.to))
    .map((edge) => ({
      id: edgeKey(edge.from, edge.to),
      sources: [edge.from],
      targets: [edge.to],
      labels: edge.label
        ? [
            {
              text: edge.label,
              width: Math.min(96, estimateTextWidth(edge.label, 10.5) + 14),
              height: 20,
            },
          ]
        : [],
    }));
  return { id: "root", layoutOptions: ROOT_OPTIONS, children, edges };
}

function absolutePositions(root: ElkNode): Map<string, Point> {
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

export async function layoutOverview(index: VizIndex, elk: ElkLike): Promise<OverviewScene> {
  const graph = toElk(index);
  const laid = await elk.layout(graph);
  const origins = absolutePositions(laid);
  const offset = { x: SCENE.pad, y: SCENE.pad + SCENE.laneHeader };
  const at = (id: string): Point => {
    const origin = origins.get(id) ?? { x: 0, y: 0 };
    return { x: origin.x + offset.x, y: origin.y + offset.y };
  };

  const nodes: PlacedNode[] = [];
  const groups: GroupBox[] = [];
  for (const child of laid.children ?? []) {
    if (child.children) {
      const [, lane, label] = child.id.split(":");
      groups.push({
        id: child.id,
        label,
        lane,
        members: child.children.map((member) => member.id),
        ...at(child.id),
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      for (const member of child.children) {
        nodes.push({
          id: member.id,
          ...at(member.id),
          width: member.width ?? 0,
          height: member.height ?? 0,
        });
      }
    } else {
      nodes.push({
        id: child.id,
        ...at(child.id),
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
    }
  }

  const edges: RoutedEdge[] = (laid.edges ?? []).map((edge) => {
    const origin = at(edge.container ?? "root");
    const shift = (p: Point): Point => ({ x: p.x + origin.x, y: p.y + origin.y });
    const points = (edge.sections ?? []).flatMap((section) => [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]);
    const label = edge.labels?.[0];
    return {
      key: edge.id as EdgeKey,
      points: points.map(shift),
      label:
        label && label.x !== undefined && label.y !== undefined
          ? {
              ...shift({ x: label.x, y: label.y }),
              width: label.width ?? 0,
              height: label.height ?? 0,
            }
          : undefined,
    };
  });

  const content = union([...nodes, ...groups, ...edges.flatMap((edge) => edge.label ?? [])]);
  const bounds: Rect = {
    x: 0,
    y: 0,
    width: content.x + content.width + SCENE.pad,
    height: content.y + content.height + SCENE.pad,
  };

  const extents = new Map<string, { min: number; max: number }>();
  for (const node of nodes) {
    const lane = index.nodeById.get(node.id)?.lane ?? "";
    const extent = extents.get(lane) ?? { min: Infinity, max: -Infinity };
    extent.min = Math.min(extent.min, node.x - SCENE.groupPad);
    extent.max = Math.max(extent.max, node.x + node.width + SCENE.groupPad);
    extents.set(lane, extent);
  }
  const populated = index.lanes.filter((lane) => extents.has(lane.id));
  const lanes: LaneBand[] = populated.map((lane, i) => {
    const extent = extents.get(lane.id)!;
    const prev = i > 0 ? extents.get(populated[i - 1].id)! : undefined;
    const next = i + 1 < populated.length ? extents.get(populated[i + 1].id)! : undefined;
    const left = prev ? (prev.max + extent.min) / 2 : bounds.x;
    const right = next ? (extent.max + next.min) / 2 : bounds.x + bounds.width;
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

  return { lanes, groups, nodes, edges, bounds };
}
