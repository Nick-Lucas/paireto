import type { Edge, Node } from "@xyflow/react";

import type { VizNode } from "../../protocol/viz.js";
import type { ClassBoxLayout } from "../layout/classBox.js";
import type { Point, Rect } from "../layout/geometry.js";
import type { Measure } from "../layout/measure.js";
import { frameTitle, type OverviewScene, type PlacedFrame } from "../layout/overview.js";
import type { FragmentBox, MessageDirection, SequenceScene } from "../layout/sequence.js";
import type { Emphasis, Level } from "./emphasis.js";
import type { IndexedEdge, IndexedStep, VizIndex } from "./index.js";
import { formatVizRef } from "./refs.js";
import { NO_MARKS, type ReviewMarks } from "./review.js";
import type { VizRef } from "./types.js";
import type { UiState } from "./ui.js";

export type LaneData = { kind: "lane"; label: string; even: boolean };
export type FrameData = {
  kind: "frame";
  frame: PlacedFrame;
  title: string;
  level: Level;
  selected: boolean;
};
export type ClassBoxData = {
  kind: "classBox";
  node: VizNode;
  box: ClassBoxLayout;
  level: Level;
  selected: boolean;
  selectedMember: string | undefined;
  seen: boolean;
};
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
export type FragmentData = { kind: "fragment"; fragment: FragmentBox };
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
  | FrameData
  | ClassBoxData
  | CardData
  | ParticipantData
  | LifelineData
  | ActivationData
  | PhaseData
  | FragmentData
  | MessageData;

export type RfNode = Node<RfNodeData, RfNodeData["kind"]> & {
  width: number;
  height: number;
  selectable: boolean;
  draggable: boolean;
  zIndex: number;
};

export type EdgeData = {
  kind: "edge";
  edge: IndexedEdge;
  points: readonly Point[];
  label?: Rect;
  fromLabel?: Rect;
  toLabel?: Rect;
  level: Level;
  selected: boolean;
  steps: number;
};

export type RfEdgeData = EdgeData;

export type RfEdge = Edge<RfEdgeData, "viz"> & {
  data: RfEdgeData;
  selectable: boolean;
  zIndex: number;
};

export interface RfGraph {
  readonly nodes: RfNode[];
  readonly edges: RfEdge[];
}

const Z = {
  lane: -2,
  phase: -1,
  fragment: -1,
  frame: 1,
  lifeline: 2,
  activation: 3,
  card: 4,
  message: 5,
  edge: 0,
} as const;

function isSelected(selection: VizRef | undefined, ref: VizRef): boolean {
  return selection !== undefined && formatVizRef(selection) === formatVizRef(ref);
}

export function decorId(kind: string, ...keys: (string | number)[]): string {
  return [kind, ...keys].join("/");
}

function rect(r: Rect): { position: Point; width: number; height: number } {
  return { position: { x: r.x, y: r.y }, width: r.width, height: r.height };
}

function fixed(zIndex: number) {
  return { selectable: false, draggable: false, zIndex };
}

export interface OverviewExtras {
  readonly marks: ReviewMarks;
  readonly measure: Measure;
}

export function toOverviewRf(
  scene: OverviewScene,
  index: VizIndex,
  emphasis: Emphasis,
  ui: UiState,
  extras: OverviewExtras,
): RfGraph {
  const { marks } = extras;
  const nodes: RfNode[] = [];
  for (const [i, lane] of scene.lanes.entries()) {
    nodes.push({
      id: decorId("lane", lane.id),
      type: "lane",
      ...rect(lane),
      data: { kind: "lane", label: lane.label, even: i % 2 === 0 },
      ...fixed(Z.lane),
    });
  }
  for (const frame of scene.frames) {
    const level: Level =
      frame.members.length > 0 &&
      frame.members.every((member) => emphasis.nodes.get(member) === "dim")
        ? "dim"
        : "normal";
    nodes.push({
      id: frame.id,
      type: "frame",
      ...rect(frame),
      data: {
        kind: "frame",
        frame,
        title: frameTitle(frame, extras.measure),
        level,
        selected: frame.node
          ? isSelected(ui.selection, { kind: "node", id: frame.node.id })
          : false,
      },
      selectable: frame.node !== undefined,
      draggable: false,
      zIndex: Z.frame + frame.depth,
    });
  }
  const selectedMember = ui.selection?.kind === "member" ? ui.selection : undefined;
  for (const placed of scene.nodes) {
    const node = index.nodeById.get(placed.id);
    if (!node) {
      continue;
    }
    const level = emphasis.nodes.get(node.id) ?? "normal";
    const selected =
      isSelected(ui.selection, { kind: "node", id: node.id }) || selectedMember?.node === node.id;
    const shared = { id: formatVizRef({ kind: "node", id: node.id }), ...rect(placed) };
    if (placed.component === "classBox" && placed.box) {
      nodes.push({
        ...shared,
        type: "classBox",
        data: {
          kind: "classBox",
          node,
          box: placed.box,
          level,
          selected,
          selectedMember: selectedMember?.node === node.id ? selectedMember.id : undefined,
          seen: marks.seen.has(node.id),
        },
        selectable: true,
        draggable: false,
        zIndex: Z.card,
      });
    } else {
      nodes.push({
        ...shared,
        type: "card",
        data: {
          kind: "card",
          node,
          level,
          selected,
          flows: index.flowsByNode.get(node.id)?.length ?? 0,
          files: node.files?.length ?? 0,
        },
        selectable: true,
        draggable: false,
        zIndex: Z.card,
      });
    }
  }

  const edges: RfEdge[] = [];
  for (const routed of scene.edges) {
    const edge = index.edgeById.get(routed.id);
    if (!edge) {
      continue;
    }
    const selected = isSelected(ui.selection, { kind: "edge", id: routed.id });
    const level = emphasis.edges.get(routed.id) ?? "normal";
    edges.push({
      id: formatVizRef({ kind: "edge", id: routed.id }),
      source: edge.from,
      target: edge.to,
      type: "viz",
      data: {
        kind: "edge",
        edge,
        points: routed.points,
        label: routed.label,
        fromLabel: routed.fromLabel,
        toLabel: routed.toLabel,
        level,
        selected,
        steps: index.stepsByEdge.get(routed.id)?.length ?? 0,
      },
      selectable: true,
      zIndex: selected || level === "bright" ? Z.card + 1 : Z.edge,
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
      ...fixed(Z.phase),
    });
  }
  for (const fragment of scene.fragments) {
    nodes.push({
      id: decorId("fragment", fragment.from, fragment.to, fragment.depth),
      type: "fragment",
      ...rect(fragment),
      data: { kind: "fragment", fragment },
      ...fixed(Z.fragment),
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
      ...fixed(Z.lifeline),
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
      ...fixed(Z.activation),
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

export const NO_EXTRAS: Omit<OverviewExtras, "measure"> = { marks: NO_MARKS };
