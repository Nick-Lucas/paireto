import type { VizFileRef } from "../../protocol/viz.js";
import { BOX } from "../layout/classBox.js";
import type { Point, Rect } from "../layout/geometry.js";
import type { OverviewScene, PlacedFrame } from "../layout/overview.js";
import type { SequenceScene } from "../layout/sequence.js";
import type { VizNote, VizNoteTarget, VizReviewFile } from "../protocol.js";
import type { VizIndex } from "./index.js";
import type { VizRef } from "./types.js";

export type NoteKind = VizNote["kind"];

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  comment: "Comment",
  question: "Question",
};

export function targetKey(target: VizNoteTarget): string {
  switch (target.kind) {
    case "node":
      return `n:${target.id}`;
    case "member":
      return `m:${target.id}`;
    case "edge":
      return `e:${target.id}`;
    case "step":
      return `s:${target.flow}:${target.index}`;
    case "file":
      return `f:${target.repo}:${target.path}`;
  }
}

export function sameTarget(a: VizNoteTarget | undefined, b: VizNoteTarget | undefined): boolean {
  return a !== undefined && b !== undefined && targetKey(a) === targetKey(b);
}

export function targetsTitle(targets: readonly { readonly label: string }[]): string {
  return targets.length === 0
    ? "the whole diagram"
    : targets.length === 1
      ? targets[0].label
      : `${targets[0].label} and ${targets.length - 1} more`;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function noteStatus(note: VizNote): { meta: string; badge: string } {
  const sent = note.sent ? (note.waiting ? "sent · waiting" : "sent") : "not sent";
  if (note.unread > 0) {
    return { meta: sent, badge: counted(note.unread, "new reply", "new replies") };
  }
  const replies = note.items.length - 1;
  const prefix = replies > 0 ? `${counted(replies, "reply", "replies")} · ` : "";
  return { meta: `${prefix}${sent}`, badge: "" };
}

export function timeAgo(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${counted(hours, "hour", "hours")} ago`;
  }
  return `${counted(Math.floor(hours / 24), "day", "days")} ago`;
}

export function nodeTarget(index: VizIndex, id: string): VizNoteTarget | undefined {
  const node = index.nodeById.get(id);
  return node && { kind: "node", id, label: node.label };
}

export function memberTarget(index: VizIndex, id: string): VizNoteTarget | undefined {
  const member = index.memberById.get(id);
  return (
    member && {
      kind: "member",
      id,
      node: member.node.id,
      label: `${member.node.label}.${member.member.short ?? member.member.label}`,
    }
  );
}

export function edgeTarget(index: VizIndex, id: string): VizNoteTarget | undefined {
  const edge = index.edgeById.get(id);
  if (!edge) {
    return undefined;
  }
  const from = index.nodeById.get(edge.from)?.label ?? edge.from;
  const to = index.nodeById.get(edge.to)?.label ?? edge.to;
  return {
    kind: "edge",
    id,
    label: edge.label ? `${from} → ${to} (${edge.label})` : `${from} → ${to}`,
  };
}

export function stepTarget(
  index: VizIndex,
  flowId: string,
  step: number,
): VizNoteTarget | undefined {
  const flow = index.flowById.get(flowId);
  const found = flow?.steps[step];
  return (
    flow &&
    found && {
      kind: "step",
      flow: flowId,
      index: step,
      label: `${flow.title}, step ${step + 1}: ${found.label}`,
    }
  );
}

export function refTarget(index: VizIndex, ref: VizRef): VizNoteTarget | undefined {
  switch (ref.kind) {
    case "node":
      return nodeTarget(index, ref.id);
    case "member":
      return memberTarget(index, ref.id);
    case "edge":
      return edgeTarget(index, ref.id);
    case "step":
      return stepTarget(index, ref.flow, ref.index);
    case "flow":
      return undefined;
  }
}

export function fileTarget(file: VizReviewFile): VizNoteTarget {
  return { kind: "file", repo: file.repo, path: file.path, label: file.path };
}

export function frameTarget(index: VizIndex, frame: PlacedFrame): VizNoteTarget | undefined {
  return frame.node && nodeTarget(index, frame.node.id);
}

function sameFile(ref: VizFileRef | undefined, target: { repo: string; path: string }): boolean {
  return (
    ref !== undefined &&
    ref.path === target.path &&
    (ref.repo === undefined || ref.repo === target.repo)
  );
}

export function targetRect(
  scene: OverviewScene,
  index: VizIndex,
  target: VizNoteTarget,
): Rect | undefined {
  const nodeRect = (id: string) =>
    scene.nodes.find((node) => node.id === id) ?? scene.frames.find((frame) => frame.id === id);
  switch (target.kind) {
    case "node":
      return nodeRect(target.id);
    case "member": {
      const node = scene.nodes.find((candidate) => candidate.id === target.node);
      const row = node?.box?.rows.find(
        (candidate) => candidate.kind === "member" && candidate.memberId === target.id,
      );
      if (!node) {
        return undefined;
      }
      return row
        ? { x: node.x, y: node.y + row.y, width: node.width, height: BOX.rowHeight }
        : node;
    }
    case "edge": {
      const edge = scene.edges.find((candidate) => candidate.id === target.id);
      if (!edge) {
        return undefined;
      }
      if (edge.label) {
        return edge.label;
      }
      const mid = edge.points[Math.floor(edge.points.length / 2)];
      return mid ? { x: mid.x - 4, y: mid.y - 4, width: 8, height: 8 } : undefined;
    }
    case "step": {
      const ref = index.flowById.get(target.flow)?.steps[target.index]?.overviewRef;
      switch (ref?.kind) {
        case "edge":
          return targetRect(scene, index, { kind: "edge", id: ref.id, label: "" });
        case "node":
          return nodeRect(ref.id);
        default:
          return undefined;
      }
    }
    case "file": {
      const node = index.overviewNodes.find((candidate) => sameFile(candidate.files?.[0], target));
      return node ? nodeRect(node.id) : undefined;
    }
  }
}

export interface Bubble {
  readonly key: string;
  readonly target: VizNoteTarget;
  readonly at: Point;
  readonly notes: readonly VizNote[];
}

function topRight(rect: Rect): Point {
  return { x: rect.x + rect.width, y: rect.y };
}

function collectBubbles(
  notes: readonly VizNote[],
  extra: readonly VizNoteTarget[],
  spot: (target: VizNoteTarget) => Point | undefined,
): Bubble[] {
  const byKey = new Map<string, { target: VizNoteTarget; at: Point; notes: VizNote[] }>();
  const add = (target: VizNoteTarget, note: VizNote | undefined) => {
    const key = targetKey(target);
    let bubble = byKey.get(key);
    if (!bubble) {
      const at = spot(target);
      if (!at) {
        return;
      }
      bubble = { target, at, notes: [] };
      byKey.set(key, bubble);
    }
    if (note) {
      bubble.notes.push(note);
    }
  };
  for (const note of notes) {
    if (!note.resolved) {
      for (const target of note.targets) {
        add(target, note);
      }
    }
  }
  for (const target of extra) {
    add(target, undefined);
  }
  return [...byKey].map(([key, bubble]) => ({ key, ...bubble }));
}

export function overviewBubbles(
  scene: OverviewScene,
  index: VizIndex,
  notes: readonly VizNote[],
  extra: readonly VizNoteTarget[],
): Bubble[] {
  return collectBubbles(notes, extra, (target) => {
    if (target.kind === "step" || target.kind === "file") {
      return undefined;
    }
    const rect = targetRect(scene, index, target);
    if (!rect) {
      return undefined;
    }
    return target.kind === "member"
      ? { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
      : topRight(rect);
  });
}

export const STEP_BUBBLE_GAP = 16;

export function sequenceBubbles(
  scene: SequenceScene,
  index: VizIndex,
  notes: readonly VizNote[],
  extra: readonly VizNoteTarget[],
): Bubble[] {
  return collectBubbles(notes, extra, (target) => {
    if (target.kind === "node") {
      const head = scene.participants.find((candidate) => candidate.id === target.id);
      return head && topRight(head);
    }
    if (target.kind === "step" && target.flow === scene.flow) {
      const message = scene.messages.find((candidate) => candidate.index === target.index);
      return message && { x: message.x + message.width + STEP_BUBBLE_GAP, y: message.y };
    }
    return undefined;
  });
}

export function commentedMembers(notes: readonly VizNote[]): ReadonlySet<string> {
  return new Set(
    notes
      .filter((note) => !note.resolved)
      .flatMap((note) => note.targets)
      .flatMap((target) => (target.kind === "member" ? [target.id] : [])),
  );
}

export const DIAGRAM_KEY = "diagram";

export function diagramNotes(notes: readonly VizNote[]): VizNote[] {
  return notes.filter((note) => !note.resolved && note.targets.length === 0);
}
