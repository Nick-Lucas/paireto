import type { VizEdge, VizNode } from "../../protocol/viz.js";
import type { Point, Rect } from "../layout/geometry.js";
import type { OverviewScene } from "../layout/overview.js";
import type { MessageDirection, SequenceScene } from "../layout/sequence.js";
import type { Emphasis, Level } from "./emphasis.js";
import type { IndexedStep, VizIndex } from "./index.js";
import { formatVizRef } from "./refs.js";
import type { VizRef } from "./types.js";
import type { UiState } from "./ui.js";

export type LaneData = { kind: "lane"; label: string; even: boolean };
export type GroupData = { kind: "group"; label: string; level: Level };
export type CardData = {
  kind: "card";
  node: VizNode;
  level: Level;
  selected: boolean;
  flows: number;
  files: number;
};
export type ParticipantData = {
  kind: "participant";
  node: VizNode;
  level: Level;
  selected: boolean;
};
export type LifelineData = { kind: "lifeline"; participant: string };
export type ActivationData = { kind: "activation"; participant: string; level: Level };
export type PhaseData = { kind: "phase"; label: string };
export type MessageData = {
  kind: "message";
  step: IndexedStep;
  direction: MessageDirection;
  fromX: number;
  toX: number;
  lineY: number;
  level: Level;
  selected: boolean;
  current: boolean;
};

export type RfNodeData =
  | LaneData
  | GroupData
  | CardData
  | ParticipantData
  | LifelineData
  | ActivationData
  | PhaseData
  | MessageData;

export interface RfNode<D extends RfNodeData = RfNodeData> {
  readonly id: string;
  readonly type: D["kind"];
  readonly position: Point;
  readonly width: number;
  readonly height: number;
  readonly data: D;
  readonly selectable: boolean;
  readonly draggable: false;
  readonly zIndex: number;
}

export type EdgeData = {
  kind: "edge";
  edge: VizEdge;
  points: readonly Point[];
  label?: Rect;
  level: Level;
  selected: boolean;
  steps: number;
};

export interface RfEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: "viz";
  readonly data: EdgeData;
  readonly selectable: boolean;
  readonly zIndex: number;
}

export interface RfGraph {
  readonly nodes: readonly RfNode[];
  readonly edges: readonly RfEdge[];
}

const Z = {
  lane: -2,
  phase: -1,
  group: 1,
  lifeline: 2,
  activation: 3,
  card: 4,
  message: 5,
  edge: 0,
} as const;

function isSelected(selection: VizRef | undefined, ref: VizRef): boolean {
  return selection !== undefined && formatVizRef(selection) === formatVizRef(ref);
}

function decorId(kind: string, ...keys: (string | number)[]): string {
  return [kind, ...keys].join("/");
}

function rect(r: Rect): Pick<RfNode, "position" | "width" | "height"> {
  return { position: { x: r.x, y: r.y }, width: r.width, height: r.height };
}

export function toOverviewRf(
  scene: OverviewScene,
  index: VizIndex,
  emphasis: Emphasis,
  ui: UiState,
): RfGraph {
  const nodes: RfNode[] = [];
  for (const [i, lane] of scene.lanes.entries()) {
    nodes.push({
      id: decorId("lane", lane.id),
      type: "lane",
      ...rect(lane),
      data: { kind: "lane", label: lane.label, even: i % 2 === 0 },
      selectable: false,
      draggable: false,
      zIndex: Z.lane,
    });
  }
  for (const group of scene.groups) {
    const level: Level = group.members.every((member) => emphasis.nodes.get(member) === "dim")
      ? "dim"
      : "normal";
    nodes.push({
      id: group.id,
      type: "group",
      ...rect(group),
      data: { kind: "group", label: group.label, level },
      selectable: false,
      draggable: false,
      zIndex: Z.group,
    });
  }
  for (const placed of scene.nodes) {
    const node = index.nodeById.get(placed.id);
    if (!node) {
      continue;
    }
    nodes.push({
      id: formatVizRef({ kind: "node", id: node.id }),
      type: "card",
      ...rect(placed),
      data: {
        kind: "card",
        node,
        level: emphasis.nodes.get(node.id) ?? "normal",
        selected: isSelected(ui.selection, { kind: "node", id: node.id }),
        flows: index.flowsByNode.get(node.id)?.length ?? 0,
        files: node.files?.length ?? 0,
      },
      selectable: true,
      draggable: false,
      zIndex: Z.card,
    });
  }
  const edges: RfEdge[] = [];
  for (const routed of scene.edges) {
    const edge = index.edgesByKey.get(routed.key);
    if (!edge) {
      continue;
    }
    const selected = isSelected(ui.selection, { kind: "edge", key: routed.key });
    edges.push({
      id: formatVizRef({ kind: "edge", key: routed.key }),
      source: edge.from,
      target: edge.to,
      type: "viz",
      data: {
        kind: "edge",
        edge,
        points: routed.points,
        label: routed.label,
        level: emphasis.edges.get(routed.key) ?? "normal",
        selected,
        steps: index.stepsByEdge.get(routed.key)?.length ?? 0,
      },
      selectable: true,
      zIndex: selected ? Z.card + 1 : Z.edge,
    });
  }
  return { nodes, edges };
}

export function toSequenceRf(
  scene: SequenceScene,
  index: VizIndex,
  emphasis: Emphasis,
  ui: UiState,
): RfGraph {
  const nodes: RfNode[] = [];
  for (const phase of scene.phases) {
    nodes.push({
      id: decorId("phase", phase.firstStep),
      type: "phase",
      ...rect(phase),
      data: { kind: "phase", label: phase.label },
      selectable: false,
      draggable: false,
      zIndex: Z.phase,
    });
  }
  for (const participant of scene.participants) {
    const node = index.nodeById.get(participant.id);
    if (!node) {
      continue;
    }
    nodes.push({
      id: formatVizRef({ kind: "node", id: participant.id }),
      type: "participant",
      ...rect(participant),
      data: {
        kind: "participant",
        node,
        level: emphasis.nodes.get(participant.id) ?? "normal",
        selected: isSelected(ui.selection, { kind: "node", id: participant.id }),
      },
      selectable: true,
      draggable: false,
      zIndex: Z.card,
    });
    nodes.push({
      id: decorId("lifeline", participant.id),
      type: "lifeline",
      position: { x: participant.lifelineX - 1, y: scene.lifelineTop },
      width: 2,
      height: scene.lifelineBottom - scene.lifelineTop,
      data: { kind: "lifeline", participant: participant.id },
      selectable: false,
      draggable: false,
      zIndex: Z.lifeline,
    });
  }
  for (const bar of scene.activations) {
    nodes.push({
      id: decorId("activation", bar.participant, bar.opener),
      type: "activation",
      ...rect(bar),
      data: {
        kind: "activation",
        participant: bar.participant,
        level: emphasis.steps.get(bar.opener) ?? "normal",
      },
      selectable: false,
      draggable: false,
      zIndex: Z.activation,
    });
  }
  for (const message of scene.messages) {
    const ref: VizRef = { kind: "step", flow: scene.flow, index: message.index };
    nodes.push({
      id: formatVizRef(ref),
      type: "message",
      ...rect(message),
      data: {
        kind: "message",
        step: message.step,
        direction: message.direction,
        fromX: message.fromX - message.x,
        toX: message.toX - message.x,
        lineY: message.lineY - message.y,
        level: emphasis.steps.get(message.index) ?? "normal",
        selected: isSelected(ui.selection, ref),
        current: emphasis.cursor === message.index,
      },
      selectable: true,
      draggable: false,
      zIndex: Z.message,
    });
  }
  return { nodes, edges: [] };
}
