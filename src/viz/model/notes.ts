import type { VizFileRef } from "../../protocol/viz.js";
import { BOX } from "../layout/classBox.js";
import type { Point, Rect } from "../layout/geometry.js";
import { wrapText, type Measure } from "../layout/measure.js";
import type { OverviewScene, PlacedFrame } from "../layout/overview.js";
import type { ParticipantColumn, PlacedMessage, SequenceScene } from "../layout/sequence.js";
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
  for (const flow of index.flows) {
    flow.steps.forEach((_, step) => {
      const target = stepTarget(index, flow.id, step);
      if (target) {
        targets.push(target);
      }
    });
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

function linkEnd(scene: OverviewScene, target: VizNoteTarget, rect: Rect, from: Point): Point {
  if (target.kind !== "member") {
    return clipToRect(rect, from);
  }
  const node = scene.nodes.find((candidate) => candidate.id === target.node);
  if (!node) {
    return clipToRect(rect, from);
  }
  const left = from.x < node.x + node.width / 2;
  return { x: left ? node.x : node.x + node.width, y: rect.y + rect.height / 2 };
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

const SEARCH_RINGS = 60;

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
  const blockers = [...scene.nodes, ...taken];
  const free = (at: Point) =>
    !blockers.some((blocker) =>
      overlaps({ ...at, width: NOTE.width, height: size.height }, blocker, 6),
    );
  for (let ring = 0; ring <= SEARCH_RINGS; ring++) {
    const found = spotsAround(anchor, home.y, size.height, ring * NOTE.gap).find(free);
    if (found) {
      return found;
    }
  }
  return spotsAround(anchor, home.y, size.height, 0)[0];
}

function spotsAround(anchor: Rect, rowY: number, height: number, reach: number): Point[] {
  const right = anchor.x + anchor.width + NOTE.gap;
  const left = anchor.x - NOTE.gap - NOTE.width;
  const above = anchor.y - NOTE.gap - height;
  const below = anchor.y + anchor.height + NOTE.gap;
  if (reach === 0) {
    return [
      { x: right, y: rowY },
      { x: left, y: rowY },
      { x: anchor.x, y: above },
      { x: anchor.x, y: below },
    ];
  }
  return [
    { x: right, y: rowY + reach },
    { x: right, y: rowY - reach },
    { x: left, y: rowY + reach },
    { x: left, y: rowY - reach },
    { x: anchor.x + reach, y: above },
    { x: anchor.x - reach, y: above },
    { x: anchor.x + reach, y: below },
    { x: anchor.x - reach, y: below },
    { x: right + reach, y: rowY },
    { x: left - reach, y: rowY },
    { x: anchor.x, y: above - reach },
    { x: anchor.x, y: below + reach },
  ];
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
      const to = linkEnd(scene, target, rect, centre(box));
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

type SequenceAnchor =
  | { readonly kind: "step"; readonly message: PlacedMessage }
  | { readonly kind: "head"; readonly head: ParticipantColumn };

const SELF_LOOP = { width: 36, drop: 12 } as const;

function sequenceAnchor(
  scene: SequenceScene,
  index: VizIndex,
  target: VizNoteTarget,
): SequenceAnchor | undefined {
  const head = (id: string): SequenceAnchor | undefined => {
    const found = scene.participants.find((candidate) => candidate.id === id);
    return found && { kind: "head", head: found };
  };
  const step = (at: number): SequenceAnchor | undefined => {
    const found = scene.messages.find((candidate) => candidate.index === at);
    return found && { kind: "step", message: found };
  };
  switch (target.kind) {
    case "step":
      return target.flow === scene.flow ? step(target.index) : undefined;
    case "node":
      return head(target.id);
    case "member":
      return head(target.node);
    case "edge": {
      const travel = (index.stepsByEdge.get(target.id) ?? []).find(
        (locator) => locator.flow === scene.flow,
      );
      return travel ? step(travel.index) : undefined;
    }
    case "file":
      return undefined;
  }
}

function anchorPoint(anchor: SequenceAnchor): Point {
  if (anchor.kind === "head") {
    return { x: anchor.head.x + anchor.head.width / 2, y: anchor.head.y };
  }
  const { message } = anchor;
  return message.direction === "self"
    ? { x: message.fromX + SELF_LOOP.width, y: message.lineY + SELF_LOOP.drop }
    : { x: Math.max(message.fromX, message.toX), y: message.lineY };
}

function firstFree(at: Point, height: number, taken: readonly Rect[], up: boolean): Point {
  let y = at.y;
  for (;;) {
    const box = { x: at.x, y, width: NOTE.width, height };
    const hits = taken.filter((other) => overlaps(box, other, NOTE.gap / 3));
    if (hits.length === 0) {
      return { x: at.x, y };
    }
    y = up
      ? Math.min(...hits.map((other) => other.y)) - NOTE.gap / 2 - height
      : Math.max(...hits.map((other) => other.y + other.height)) + NOTE.gap / 2;
  }
}

export function placeSequenceNotes(
  scene: SequenceScene,
  index: VizIndex,
  notes: readonly VizNote[],
  draft: NoteDraft | undefined,
  measure: Measure,
): PlacedNote[] {
  const placed: PlacedNote[] = [];
  const column = scene.bounds.x + scene.bounds.width + NOTE.gap * 2;
  const add = (
    id: string,
    note: VizNote | undefined,
    kind: NoteKind,
    body: string,
    targets: readonly VizNoteTarget[],
  ) => {
    const anchors = targets.map((target) => sequenceAnchor(scene, index, target));
    const first = anchors.find((anchor) => anchor?.kind === "step") ?? anchors.find(Boolean);
    if (!first) {
      return;
    }
    const size = noteSize(body, measure);
    const at =
      first.kind === "step"
        ? firstFree(
            { x: column, y: anchorPoint(first).y - NOTE.headHeight / 2 },
            size.height,
            placed,
            false,
          )
        : firstFree(
            {
              x: first.head.x + first.head.width / 2 - NOTE.width / 2,
              y: first.head.y - NOTE.gap - size.height,
            },
            size.height,
            placed,
            true,
          );
    const box: Rect = { ...at, width: NOTE.width, height: size.height };
    const links = targets.flatMap((target, linkIndex): NoteLink[] => {
      const anchor = anchors[linkIndex];
      if (!anchor) {
        return [];
      }
      const to = anchorPoint(anchor);
      return [{ index: linkIndex, target, from: clipToRect(box, to), to }];
    });
    placed.push({ id, note, kind, lines: size.lines, links, ...box });
  };
  for (const note of notes) {
    if (!note.resolved) {
      add(note.id, note, note.kind, note.body, note.targets);
    }
  }
  if (draft) {
    add("draft", undefined, draft.kind, "Type it in the thread beside it.", draft.targets);
  }
  return placed;
}
