import type { Edge, Node, NodeChange } from "@xyflow/react";

import type { VizNode } from "../../protocol/viz.js";
import type { ClassBoxLayout } from "../layout/classBox.js";
import type { Point, Rect } from "../layout/geometry.js";
import type { Measure } from "../layout/measure.js";
import { frameTitle, type OverviewScene, type PlacedFrame } from "../layout/overview.js";
import type { FragmentBox, MessageDirection, SequenceScene } from "../layout/sequence.js";
import type { Emphasis, Level } from "./emphasis.js";
import type { IndexedEdge, IndexedStep, VizIndex } from "./index.js";
import type { NoteLink, PlacedNote } from "./notes.js";
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
  threads: number;
};
export type CardData = {
  kind: "card";
  node: VizNode;
  level: Level;
  selected: boolean;
  flows: number;
  files: number;
  threads: number;
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
export type NoteData = { kind: "note"; note: PlacedNote; open: boolean };

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
  | MessageData
  | NoteData;

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

export type NoteLinkData = {
  kind: "noteLink";
  note: string;
  link: NoteLink;
  noteKind: PlacedNote["kind"];
  lit: boolean;
};

export type RfEdgeData = EdgeData | NoteLinkData;

export type RfEdge = Edge<RfEdgeData, "viz" | "noteLink"> & {
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
  note: 6,
  edge: 0,
} as const;

function isSelected(selection: VizRef | undefined, ref: VizRef): boolean {
  return selection !== undefined && formatVizRef(selection) === formatVizRef(ref);
}

export function decorId(kind: string, ...keys: (string | number)[]): string {
  return [kind, ...keys].join("/");
}

export function noteNodeId(id: string): string {
  return decorId("note", id);
}

function rect(r: Rect): { position: Point; width: number; height: number } {
  return { position: { x: r.x, y: r.y }, width: r.width, height: r.height };
}

function fixed(zIndex: number) {
  return { selectable: false, draggable: false, zIndex };
}

export interface OverviewExtras {
  readonly notes: readonly PlacedNote[];
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
  const { notes, marks } = extras;
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
    const threads = marks.threads.get(node.id) ?? 0;
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
          threads,
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
          threads,
        },
        selectable: true,
        draggable: false,
        zIndex: Z.card,
      });
    }
  }
  const noteParts = notesRf(notes, ui, true, (link) =>
    link.target.kind === "member"
      ? link.target.node
      : link.target.kind === "node"
        ? link.target.id
        : undefined,
  );
  nodes.push(...noteParts.nodes);

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
  edges.push(...noteParts.edges);
  return { nodes, edges };
}

function notesRf(
  notes: readonly PlacedNote[],
  ui: UiState,
  draggable: boolean,
  targetNode: (link: NoteLink) => string | undefined,
): RfGraph {
  const openNote = ui.thread.kind === "open" ? ui.thread.id : undefined;
  const nodes: RfNode[] = notes.map((note) => ({
    id: noteNodeId(note.id),
    type: "note",
    ...rect(note),
    data: { kind: "note", note, open: note.id === openNote },
    selectable: false,
    draggable: draggable && note.note !== undefined,
    zIndex: Z.note,
  }));
  const edges: RfEdge[] = notes.flatMap((note) =>
    note.links.map((link): RfEdge => ({
      id: decorId("notelink", note.id, link.index),
      source: noteNodeId(note.id),
      target: targetNode(link) ?? noteNodeId(note.id),
      type: "noteLink",
      data: {
        kind: "noteLink",
        note: note.id,
        link,
        noteKind: note.kind,
        lit: note.id === openNote,
      },
      selectable: false,
      zIndex: Z.note - 1,
    })),
  );
  return { nodes, edges };
}

export function toSequenceRf(
  scene: SequenceScene,
  index: VizIndex,
  emphasis: Emphasis,
  ui: UiState,
  notes: readonly PlacedNote[],
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
  const noteParts = notesRf(notes, ui, false, () => undefined);
  return { nodes: [...nodes, ...noteParts.nodes], edges: noteParts.edges };
}

export const NO_EXTRAS: Omit<OverviewExtras, "measure"> = { notes: [], marks: NO_MARKS };

export interface NoteDrag {
  readonly from: Point;
  readonly to: Point;
  readonly dragging: boolean;
}

export type NoteDrags = ReadonlyMap<string, NoteDrag>;

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function holds(node: RfNode | undefined, drag: NoteDrag): node is RfNode {
  return node !== undefined && (drag.dragging || samePoint(node.position, drag.from));
}

export function dragNotes(
  nodes: readonly RfNode[],
  drags: NoteDrags,
  changes: readonly NodeChange<RfNode>[],
): NoteDrags {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const next = new Map([...drags].filter(([id, drag]) => holds(byId.get(id), drag)));
  let changed = next.size !== drags.size;
  for (const change of changes) {
    if (change.type !== "position" || !change.position) {
      continue;
    }
    const node = byId.get(change.id);
    if (!node) {
      continue;
    }
    changed = true;
    next.set(change.id, {
      from: next.get(change.id)?.from ?? node.position,
      to: change.position,
      dragging: change.dragging ?? false,
    });
  }
  return changed ? next : drags;
}

export function withNoteDrags(nodes: RfNode[], drags: NoteDrags): RfNode[] {
  let moved = false;
  const placed = nodes.map((node) => {
    const drag = drags.get(node.id);
    if (!drag || !holds(node, drag) || samePoint(node.position, drag.to)) {
      return node;
    }
    moved = true;
    return { ...node, position: drag.to };
  });
  return moved ? placed : nodes;
}
