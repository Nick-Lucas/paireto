import type { VizFileRef } from "../../protocol/viz.js";
import { BOX } from "../layout/classBox.js";
import type { Point, Rect } from "../layout/geometry.js";
import { wrapText, type Measure } from "../layout/measure.js";
import type { OverviewScene, PlacedFrame } from "../layout/overview.js";
import type { VizNote, VizNoteTarget, VizNotePlace, VizReviewFile } from "../protocol.js";
import type { VizIndex } from "./index.js";

export const NOTE = {
  width: 220,
  padX: 10,
  headHeight: 24,
  lineHeight: 16,
  padBottom: 10,
  lines: 4,
  fold: 12,
  gap: 24,
} as const;

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
    case "file":
      return `f:${target.repo}:${target.path}`;
  }
}

export function sameTarget(a: VizNoteTarget | undefined, b: VizNoteTarget | undefined): boolean {
  return a !== undefined && b !== undefined && targetKey(a) === targetKey(b);
}

export function targetsTitle(targets: readonly { readonly label: string }[]): string {
  return targets.length === 0
    ? "Not linked"
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

export function fileTarget(file: VizReviewFile): VizNoteTarget {
  return { kind: "file", repo: file.repo, path: file.path, label: file.path };
}

export function frameTargets(index: VizIndex, frame: PlacedFrame): VizNoteTarget[] {
  if (frame.node) {
    const target = nodeTarget(index, frame.node.id);
    return target ? [target] : [];
  }
  return frame.members
    .map((id) => nodeTarget(index, id))
    .filter((target): target is VizNoteTarget => target !== undefined);
}

export function allTargets(index: VizIndex, files: readonly VizReviewFile[]): VizNoteTarget[] {
  const targets: VizNoteTarget[] = [];
  for (const node of index.overviewNodes) {
    targets.push({ kind: "node", id: node.id, label: node.label });
    for (const member of node.members ?? []) {
      targets.push({
        kind: "member",
        id: member.id,
        node: node.id,
        label: `${node.label}.${member.short ?? member.label}`,
      });
    }
  }
  for (const file of files) {
    targets.push(fileTarget(file));
  }
  return targets;
}

function targetRank(target: VizNoteTarget, query: string): number {
  const title = target.label.toLowerCase();
  const name = target.kind === "file" ? title.slice(title.lastIndexOf("/") + 1) : title;
  if (name.startsWith(query)) {
    return 0;
  }
  if (title.split(/[^a-z0-9_$]+/).some((word) => word.startsWith(query))) {
    return 1;
  }
  return title.includes(query) ? 2 : -1;
}

export function searchTargets(
  targets: readonly VizNoteTarget[],
  query: string,
  limit = 8,
): VizNoteTarget[] {
  const text = query.toLowerCase();
  return targets
    .map((target, index) => ({ target, index, rank: targetRank(target, text) }))
    .filter((hit) => hit.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((hit) => hit.target);
}

export function noteSize(body: string, measure: Measure): { height: number; lines: string[] } {
  const lines = wrapText(
    body,
    "small",
    NOTE.width - NOTE.padX * 2 - NOTE.fold / 2,
    measure,
    NOTE.lines,
  );
  return {
    height: NOTE.headHeight + Math.max(1, lines.length) * NOTE.lineHeight + NOTE.padBottom,
    lines,
  };
}

export interface NoteLink {
  readonly index: number;
  readonly target: VizNoteTarget;
  readonly from: Point;
  readonly to: Point;
}

export interface PlacedNote extends Rect {
  readonly id: string;
  readonly note: VizNote | undefined;
  readonly kind: NoteKind;
  readonly lines: readonly string[];
  readonly links: readonly NoteLink[];
}

export interface NoteDraft {
  readonly kind: NoteKind;
  readonly targets: readonly VizNoteTarget[];
  readonly place: VizNotePlace | undefined;
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
    case "file": {
      const node = index.overviewNodes.find((candidate) => sameFile(candidate.files?.[0], target));
      return node ? nodeRect(node.id) : undefined;
    }
  }
}

function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function clipToRect(rect: Rect, from: Point): Point {
  const to = centre(rect);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return to;
  }
  const scaleX = dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: to.x - dx * scale, y: to.y - dy * scale };
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

function placeOf(
  scene: OverviewScene,
  index: VizIndex,
  place: VizNotePlace | undefined,
  targets: readonly VizNoteTarget[],
  size: { height: number },
  taken: readonly Rect[],
): Point {
  if (place) {
    const home = place.node
      ? targetRect(scene, index, { kind: "node", id: place.node, label: "" })
      : undefined;
    return home ? { x: home.x + place.x, y: home.y + place.y } : { x: place.x, y: place.y };
  }
  const first = targets
    .map((target) => targetRect(scene, index, target))
    .find((rect) => rect !== undefined);
  const home = first ?? { x: scene.bounds.x + 16, y: scene.bounds.y + 16, width: 0, height: 0 };
  const node =
    targets[0]?.kind === "member"
      ? scene.nodes.find((candidate) => candidate.id === (targets[0] as { node: string }).node)
      : undefined;
  const anchor = node ?? home;
  const candidates: Point[] = [
    { x: anchor.x + anchor.width + NOTE.gap, y: home.y },
    { x: anchor.x - NOTE.gap - NOTE.width, y: home.y },
    { x: anchor.x, y: anchor.y - NOTE.gap - size.height },
    { x: anchor.x, y: anchor.y + anchor.height + NOTE.gap },
  ];
  const blockers = [...scene.nodes, ...taken];
  for (const at of candidates) {
    const box: Rect = { ...at, width: NOTE.width, height: size.height };
    if (!blockers.some((blocker) => overlaps(box, blocker, 6))) {
      return at;
    }
  }
  const last = taken[taken.length - 1];
  return last ? { x: last.x, y: last.y + last.height + 10 } : candidates[0];
}

export function placeNotes(
  scene: OverviewScene,
  index: VizIndex,
  notes: readonly VizNote[],
  draft: NoteDraft | undefined,
  measure: Measure,
): PlacedNote[] {
  const placed: PlacedNote[] = [];
  const add = (
    id: string,
    note: VizNote | undefined,
    kind: NoteKind,
    body: string,
    targets: readonly VizNoteTarget[],
    place: VizNotePlace | undefined,
  ) => {
    const size = noteSize(body, measure);
    const at = placeOf(scene, index, place, targets, size, placed);
    const box: Rect = { ...at, width: NOTE.width, height: size.height };
    const links = targets.flatMap((target, linkIndex): NoteLink[] => {
      const rect = targetRect(scene, index, target);
      if (!rect) {
        return [];
      }
      const to = clipToRect(rect, centre(box));
      const from = clipToRect(box, to);
      return [{ index: linkIndex, target, from, to }];
    });
    placed.push({ id, note, kind, lines: size.lines, links, ...box });
  };
  for (const note of notes) {
    if (!note.resolved) {
      add(note.id, note, note.kind, note.body, note.targets, note.place);
    }
  }
  if (draft) {
    add(
      "draft",
      undefined,
      draft.kind,
      "Type it in the thread beside it.",
      draft.targets,
      draft.place,
    );
  }
  return placed;
}

function gapTo(rect: Rect, at: Point): number {
  const dx = Math.max(rect.x - at.x, 0, at.x - rect.x - rect.width);
  const dy = Math.max(rect.y - at.y, 0, at.y - rect.y - rect.height);
  return Math.hypot(dx, dy);
}

export function relativePlace(scene: OverviewScene, at: Point): VizNotePlace {
  const reach = NOTE.width + NOTE.gap * 2;
  const home = scene.nodes
    .map((node) => ({ node, gap: gapTo(node, at) }))
    .filter((near) => near.gap <= reach)
    .sort((a, b) => a.gap - b.gap)[0]?.node;
  return home ? { node: home.id, x: at.x - home.x, y: at.y - home.y } : { x: at.x, y: at.y };
}
