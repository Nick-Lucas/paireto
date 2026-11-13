import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  METRICS,
  NO_DIFF,
  noteHome,
  noteLinks,
  notePlace,
  OUTSIDE_FOCUS,
  placeRoleLabels,
  type Box,
  type ContainerLayout,
  type DiagramLayout,
  type EdgeLayout,
  type Measure,
  type NodeLayout,
  type NoteLayout,
  type Point,
} from "../core/layout";
import { linksTitle, sameLink, searchParts } from "../core/comments";
import type { FeedbackState } from "../core/protocol";
import type {
  NotePlace,
  UmlCommentLink,
  UmlFile,
  UmlMember,
  UmlModel,
  UmlType,
} from "../core/model";
import { fitStep, READABLE_ZOOM, type FitStep } from "../core/fit";
import { Icon, iconPath } from "./icons";
import {
  ContextMenu,
  DRAFT_HEIGHT,
  DRAFT_WIDTH,
  draftPlace,
  frameLink,
  linkAt,
  NoteView,
  targetLink,
  type CommentKind,
  type Draft,
  type LinkHit,
  type MenuState,
  type ShowNote,
} from "./notes";
import { NewThread, THREAD_WIDTH, ThreadPopup, type ThreadActions } from "./thread";
import {
  describeMember,
  describeType,
  KIND_WORDS,
  memberGlyph,
  RELATION_WORDS,
  sameTarget,
  type Target,
  targetKey,
} from "./targets";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.2;
const PAN_STEP = 160;
const EDGE_RADIUS = 8;
const CANVAS_PAD_X = 24;
const CANVAS_PAD_Y = 132;
const FIT_PASSES = 6;
const HOLD_DELAY_MS = 300;
const HOLD_SPEED = 12;
const LINKS_MARGIN = 60;

type LinkLevel = "hot" | "warm" | "cold" | "";

interface FocusItem {
  target: Target;
  nodeId: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface DiagramProps {
  layout: DiagramLayout;
  model: UmlModel;
  measure: Measure;
  selection?: Target;
  fitRequest: number;
  linksRequest: number;
  centerRequest: number;
  find: string;
  hoverRelation?: string;
  onSelect(target: Target | undefined): void;
  onOpen(target: Target): void;
  onFollow(typeId: string): void;
  onExpand(typeId: string): void;
  onOverview(overview: boolean): void;
  draft?: Draft;
  noteRequest: number;
  showNote?: ShowNote;
  onDraft(draft: Draft | undefined): void;
  onAddComment(draft: Draft, body: string): void;
  onResolveComment(id: string): void;
  onLinkComment(id: string, link: UmlCommentLink): void;
  onUnlinkComment(id: string, index: number): void;
  onMoveComment(id: string, place: NotePlace): void;
  onReplyComment(id: string, body: string): void;
  onReadComment(id: string): void;
  onEditComment(id: string, kind: CommentKind, body: string): void;
  onEditReply(itemId: string, body: string): void;
  onDeleteComment(itemId: string): void;
  onSendFeedback(): void;
  feedback: FeedbackState;
}

interface Moving {
  id: string;
  from: Point;
  origin: Point;
  x: number;
  y: number;
  moved: boolean;
  held: boolean;
  layout: DiagramLayout;
}

const NUDGE = 16;

interface Linking {
  from: string;
  start: Point;
  end: Point;
  sticky: boolean;
  hit?: LinkHit;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

type PanDirection = "up" | "down" | "left" | "right";

const PAN_VECTORS: Record<PanDirection, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const PAN_LABELS: Record<PanDirection, string> = {
  up: "Pan up (Shift+↑)",
  down: "Pan down (Shift+↓)",
  left: "Pan left (Shift+←)",
  right: "Pan right (Shift+→)",
};

function JoyPad({
  onStep,
  onGlide,
  onCentre,
  centreLabel,
}: {
  onStep(vector: Point): void;
  onGlide(vector: Point): void;
  onCentre(): void;
  centreLabel: string;
}) {
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; frame?: number }>({});
  const stop = useCallback(() => {
    clearTimeout(hold.current.timer);
    if (hold.current.frame !== undefined) {
      cancelAnimationFrame(hold.current.frame);
    }
    hold.current = {};
  }, []);
  useEffect(() => stop, [stop]);
  const start = (direction: PanDirection) => {
    stop();
    const vector = PAN_VECTORS[direction];
    onStep(vector);
    const glide = () => {
      onGlide(vector);
      hold.current.frame = requestAnimationFrame(glide);
    };
    hold.current.timer = setTimeout(glide, HOLD_DELAY_MS);
  };
  return (
    <div className="joypad" role="group" aria-label="Pan the diagram">
      {(Object.keys(PAN_VECTORS) as PanDirection[]).map((direction) => (
        <button
          key={direction}
          type="button"
          className={`joypad-button is-${direction}`}
          title={`${PAN_LABELS[direction]}. Hold to keep moving.`}
          aria-label={PAN_LABELS[direction]}
          onPointerDown={(event) => {
            if (event.button === 0) {
              start(direction);
            }
          }}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onClick={(event) => {
            if (event.detail === 0) {
              onStep(PAN_VECTORS[direction]);
            }
          }}
        >
          <Icon name={direction} />
        </button>
      ))}
      <button
        type="button"
        className="joypad-centre"
        title={centreLabel}
        aria-label={centreLabel}
        onClick={onCentre}
      >
        <Icon name="target" />
      </button>
    </div>
  );
}

function roundedPath(points: readonly Point[]): string {
  if (points.length === 0) {
    return "";
  }
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const at = points[i];
    const next = points[i + 1];
    const inLength = Math.hypot(at.x - prev.x, at.y - prev.y);
    const outLength = Math.hypot(next.x - at.x, next.y - at.y);
    const r = Math.min(EDGE_RADIUS, inLength / 2, outLength / 2);
    const from = {
      x: at.x - ((at.x - prev.x) / (inLength || 1)) * r,
      y: at.y - ((at.y - prev.y) / (inLength || 1)) * r,
    };
    const to = {
      x: at.x + ((next.x - at.x) / (outLength || 1)) * r,
      y: at.y + ((next.y - at.y) / (outLength || 1)) * r,
    };
    d += ` L${from.x},${from.y} Q${at.x},${at.y} ${to.x},${to.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

function selectedTypeOf(selection: Target | undefined): string | undefined {
  return selection && selection.kind !== "file" ? selection.typeId : undefined;
}

function buildFocusItems(layout: DiagramLayout): FocusItem[] {
  const items: FocusItem[] = [];
  const blocks: { y: number; x: number; items: FocusItem[] }[] = [];
  for (const container of layout.containers) {
    if (container.kind === "file" && container.fileKey) {
      blocks.push({
        y: container.y,
        x: container.x,
        items: [
          {
            target: { kind: "file", fileKey: container.fileKey },
            nodeId: container.id,
            rect: {
              x: container.x,
              y: container.y,
              width: container.width,
              height: METRICS.containerTitleHeight,
            },
          },
        ],
      });
    }
  }
  for (const node of layout.nodes) {
    const nodeItems: FocusItem[] = [
      {
        target: { kind: "type", typeId: node.id },
        nodeId: node.id,
        rect: { x: node.x, y: node.y, width: node.width, height: node.headerHeight },
      },
    ];
    for (const row of node.rows) {
      if (row.memberId) {
        nodeItems.push({
          target: { kind: "member", typeId: node.id, memberId: row.memberId },
          nodeId: node.id,
          rect: { x: node.x, y: node.y + row.y, width: node.width, height: METRICS.rowHeight },
        });
      }
    }
    blocks.push({ y: node.y, x: node.x, items: nodeItems });
  }
  blocks.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const block of blocks) {
    items.push(...block.items);
  }
  return items;
}

function nearest(
  items: readonly FocusItem[],
  from: FocusItem,
  direction: "up" | "down" | "left" | "right",
): FocusItem | undefined {
  const cx = from.rect.x + from.rect.width / 2;
  const cy = from.rect.y + from.rect.height / 2;
  let best: FocusItem | undefined;
  let bestScore = Infinity;
  for (const item of items) {
    if (item.nodeId === from.nodeId || item.target.kind === "member") {
      continue;
    }
    const r = item.rect;
    const dx =
      direction === "left"
        ? from.rect.x - (r.x + r.width)
        : direction === "right"
          ? r.x - (from.rect.x + from.rect.width)
          : 0;
    const dy =
      direction === "up"
        ? from.rect.y - (r.y + r.height)
        : direction === "down"
          ? r.y - (from.rect.y + from.rect.height)
          : 0;
    const ix = r.x + r.width / 2;
    const iy = r.y + r.height / 2;
    let primary: number;
    let secondary: number;
    if (direction === "left" || direction === "right") {
      if (dx < -1) {
        continue;
      }
      primary = dx;
      secondary = Math.max(0, Math.abs(iy - cy) - r.height / 2);
    } else {
      if (dy < -1) {
        continue;
      }
      primary = dy;
      secondary = Math.max(0, Math.abs(ix - cx) - r.width / 2);
    }
    const score = primary + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

export interface LinkLevels {
  levels: Map<string, LinkLevel>;
  ends: Set<string>;
  hotEnds: Set<string>;
}

export function linkLevels(
  edges: readonly EdgeLayout[],
  selection: Target | undefined,
): LinkLevels {
  const levels = new Map<string, LinkLevel>();
  const ends = new Set<string>();
  const hotEnds = new Set<string>();
  const typeId = selectedTypeOf(selection);
  if (!typeId) {
    return { levels, ends, hotEnds };
  }
  const memberId = selection?.kind === "member" ? selection.memberId : undefined;
  const own = edges.filter((e) => e.relation.source === typeId || e.relation.target === typeId);
  const viaMember = memberId ? own.filter((e) => e.relation.via.includes(memberId)) : [];
  for (const edge of edges) {
    const mine = own.includes(edge);
    const level: LinkLevel = !mine
      ? "cold"
      : viaMember.length > 0 && !viaMember.includes(edge)
        ? "warm"
        : "hot";
    levels.set(edge.id, level);
    if (mine) {
      const other = edge.relation.source === typeId ? edge.relation.target : edge.relation.source;
      ends.add(other);
      if (level === "hot") {
        hotEnds.add(other);
      }
    }
  }
  return { levels, ends, hotEnds };
}

export function roleText(edge: EdgeLayout, members: ReadonlyMap<string, UmlMember>): string {
  const r = edge.relation;
  if (r.kind === "realization") {
    return "implements";
  }
  if (r.kind === "generalization") {
    return "extends";
  }
  const names = r.via.map((id, i) =>
    members.get(id)?.compartment === "method" ? `${r.roles[i]}()` : r.roles[i],
  );
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

function CountsText({
  counts,
  x,
  y,
  anchor,
  className,
}: {
  counts: string;
  x: number;
  y: number;
  anchor: "middle" | "end";
  className: string;
}) {
  const [added, removed] = counts.split(" / ");
  return (
    <text x={x} y={y} textAnchor={anchor} className={className} dominantBaseline="central">
      <tspan className={added === "+0" ? "c-added is-zero" : "c-added"}>{added}</tspan>
      <tspan className="c-sep"> / </tspan>
      <tspan className={removed === "−0" ? "c-removed is-zero" : "c-removed"}>{removed}</tspan>
    </text>
  );
}

const TYPE_BADGE: Record<string, string> = { added: "A", removed: "D", modified: "M" };

const KIND_TAGS: Partial<Record<UmlType["kind"], string>> = {
  interface: "I",
  enum: "E",
  struct: "S",
  module: "M",
  file: "F",
};

const NODE_RADIUS = 6;
const FRAME_RADIUS = 8;

function NodeView({
  node,
  type,
  file,
  measure,
  selection,
  tabTarget,
  related,
  hotEnd,
  dimmed,
  endHover,
  findHit,
  onSelect,
  onOpen,
  onExpand,
  onKey,
  registerRef,
}: {
  node: NodeLayout;
  type: UmlType;
  file: UmlFile | undefined;
  measure: Measure;
  selection?: Target;
  tabTarget?: Target;
  related: boolean;
  hotEnd: boolean;
  dimmed: boolean;
  endHover: boolean;
  findHit: boolean;
  onSelect(target: Target): void;
  onOpen(target: Target): void;
  onExpand(typeId: string): void;
  onKey(event: ReactKeyboardEvent, target: Target): void;
  registerRef(key: string, element: SVGGElement | null): void;
}) {
  const members = new Map(type.members.map((m) => [m.id, m]));
  const headerTarget: Target = { kind: "type", typeId: node.id };
  const selectedType = selectedTypeOf(selection) === node.id;
  const stereotypeY = METRICS.headerPadY + METRICS.stereotypeHeight / 2;
  const titleY =
    METRICS.headerPadY + (node.stereotype ? METRICS.stereotypeHeight : 0) + METRICS.nameHeight / 2;
  const kindTag = node.overview ? KIND_TAGS[type.kind] : undefined;
  const titleX = METRICS.padX + METRICS.glyphWidth + (kindTag ? METRICS.kindTag : 0);
  let right = node.width - METRICS.padX;
  const extras: ReactNode[] = [];
  const note = node.noDiff
    ? { text: NO_DIFF, title: "No lines changed in this type" }
    : node.outsideFocus
      ? { text: OUTSIDE_FOCUS, title: "Changed, but not part of this review focus" }
      : undefined;
  if (note) {
    const width = measure(note.text, "small") + METRICS.pillPadX * 2;
    right -= width;
    extras.push(
      <g key="note" className="pill note-pill" transform={`translate(${right},${titleY - 8})`}>
        <title>{note.title}</title>
        <rect width={width} height={16} rx={8} />
        <text
          x={width / 2}
          y={8}
          textAnchor="middle"
          dominantBaseline="central"
          className="t-small"
        >
          {note.text}
        </text>
      </g>,
    );
    right -= METRICS.gap - 4;
  }
  if (node.counts) {
    const width = measure(node.counts, "small") + METRICS.pillPadX * 2;
    right -= width;
    extras.push(
      <g key="pill" className="pill" transform={`translate(${right},${titleY - 8})`}>
        <title>{`Whole ${type.kind === "module" ? "module" : type.kind}: ${type.counts.added} lines added, ${type.counts.removed} removed`}</title>
        <rect width={width} height={16} rx={8} />
        <CountsText
          counts={node.counts}
          x={width / 2}
          y={8}
          anchor="middle"
          className="t-small pill-text"
        />
      </g>,
    );
    right -= METRICS.gap - 4;
  }
  if (node.threads) {
    const width = measure(String(node.threads), "small") + METRICS.threadIcon;
    right -= width;
    extras.push(
      <g key="threads" className="threads" transform={`translate(${right},${titleY - 8})`}>
        <title>{`${node.threads} open review ${node.threads === 1 ? "thread" : "threads"}`}</title>
        <path d={iconPath("comment")} transform="scale(0.875)" />
        <text x={17} y={8} className="t-small" dominantBaseline="central">
          {node.threads}
        </text>
      </g>,
    );
  }
  if (node.readSlot) {
    right -= METRICS.readSlot;
    const read = !!file?.read;
    extras.push(
      <g
        key="read"
        className={read ? "read-mark is-read" : "read-mark"}
        transform={`translate(${right + 7},${titleY})`}
      >
        <title>{read ? "File marked as seen" : "File not seen yet"}</title>
        {read ? <path d="M-3.5,0.5 L-1,3 L3.5,-2.5" /> : <circle r={3.5} />}
      </g>,
    );
  }
  const quiet = node.noDiff || node.outsideFocus;
  const changeClass = node.noDiff
    ? "is-quiet no-diff"
    : node.outsideFocus
      ? "is-quiet outside-focus"
      : `change-${type.change}`;
  const badge = node.noDiff ? "U" : TYPE_BADGE[type.change];
  const classes = [
    "uml-node",
    changeClass,
    selectedType ? "is-selected" : "",
    related ? "is-related" : "",
    hotEnd ? "is-hot-end" : "",
    dimmed ? "is-dimmed" : "",
    endHover ? "is-end-hover" : "",
    findHit ? "is-find-hit" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <g className={classes} transform={`translate(${node.x},${node.y})`} data-node={node.id}>
      {findHit && (
        <rect
          className="find-ring"
          x={-4}
          y={-4}
          width={node.width + 8}
          height={node.height + 8}
          rx={NODE_RADIUS + 4}
        />
      )}
      <rect className="node-box" width={node.width} height={node.height} rx={NODE_RADIUS} />
      <path
        className="node-header"
        d={`M0,${NODE_RADIUS} a${NODE_RADIUS},${NODE_RADIUS} 0 0 1 ${NODE_RADIUS},-${NODE_RADIUS} h${node.width - NODE_RADIUS * 2} a${NODE_RADIUS},${NODE_RADIUS} 0 0 1 ${NODE_RADIUS},${NODE_RADIUS} v${node.headerHeight - NODE_RADIUS} h${-node.width} z`}
      />
      {node.dividers.map((y) => (
        <line key={y} className="node-divider" x1={0} x2={node.width} y1={y} y2={y} />
      ))}
      <g
        className="focusable header-hit"
        tabIndex={sameTarget(tabTarget, headerTarget) ? 0 : -1}
        role="button"
        aria-label={describeType(type, file)}
        ref={(el) => registerRef(targetKey(headerTarget), el)}
        onClick={() => onSelect(headerTarget)}
        onDoubleClick={() => onOpen(headerTarget)}
        onKeyDown={(event) => onKey(event, headerTarget)}
        onFocus={() => onSelect(headerTarget)}
      >
        <rect className="hit" width={node.width} height={node.headerHeight} rx={NODE_RADIUS} />
        <rect
          className="focus-ring"
          x={1.5}
          y={1.5}
          width={node.width - 3}
          height={node.headerHeight - 3}
          rx={NODE_RADIUS - 1}
        />
        {node.stereotype && (
          <text
            x={METRICS.padX + METRICS.glyphWidth}
            y={stereotypeY}
            className="t-small stereotype"
            dominantBaseline="central"
          >
            {node.stereotype}
          </text>
        )}
        {badge && (
          <g
            className={`badge badge-${quiet ? "unchanged" : type.change}`}
            transform={`translate(${METRICS.padX - 1},${titleY - 6})`}
          >
            <rect width={12} height={12} rx={3} />
            <text
              x={6}
              y={6.5}
              textAnchor="middle"
              dominantBaseline="central"
              className="t-small-bold"
            >
              {badge}
            </text>
          </g>
        )}
        {kindTag && (
          <g
            className="kind-tag"
            transform={`translate(${METRICS.padX + METRICS.glyphWidth},${titleY - 6})`}
          >
            <title>{KIND_WORDS[type.kind]}</title>
            <rect width={12} height={12} rx={3} />
            <text
              x={6}
              y={6.5}
              textAnchor="middle"
              dominantBaseline="central"
              className="t-small-bold"
            >
              {kindTag}
            </text>
          </g>
        )}
        <text
          x={titleX}
          y={titleY}
          className={`t-title title${type.isAbstract ? " is-abstract" : ""}`}
          dominantBaseline="central"
        >
          {node.title}
        </text>
        {extras}
        <title>{file ? `${node.titleFull}\n${file.path}` : node.titleFull}</title>
      </g>
      {node.rows.map((row, index) => {
        if (row.kind === "more" || row.kind === "less") {
          return (
            <g
              key={`row-${row.kind}`}
              className="focusable uml-fold"
              transform={`translate(0,${row.y})`}
              role="button"
              tabIndex={-1}
              aria-label={row.kind === "more" ? `Show all members of ${type.name}` : "Show fewer"}
              onClick={(event) => {
                event.stopPropagation();
                onExpand(node.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onExpand(node.id);
                }
              }}
            >
              <rect className="hit" x={1} width={node.width - 2} height={METRICS.rowHeight} />
              <text
                x={METRICS.padX + METRICS.glyphWidth}
                y={METRICS.rowHeight / 2}
                className="t-small summary fold-link"
                dominantBaseline="central"
              >
                {row.text}
              </text>
            </g>
          );
        }
        if (!row.memberId) {
          return (
            <text
              key={`summary-${index}`}
              x={METRICS.padX + METRICS.glyphWidth}
              y={row.y + METRICS.rowHeight / 2}
              className="t-small summary"
              dominantBaseline="central"
            >
              {row.text}
            </text>
          );
        }
        const member = members.get(row.memberId) as UmlMember;
        const target: Target = { kind: "member", typeId: node.id, memberId: row.memberId };
        const selected = sameTarget(selection, target);
        const countsWidth = row.counts ? measure(row.counts, "small") : 0;
        return (
          <g
            key={row.memberId}
            className={`focusable uml-row member-${member.change}${selected ? " is-selected" : ""}`}
            transform={`translate(0,${row.y})`}
            data-member={row.memberId}
            tabIndex={sameTarget(tabTarget, target) ? 0 : -1}
            role="button"
            aria-label={describeMember(member, type)}
            ref={(el) => registerRef(targetKey(target), el)}
            onClick={() => onSelect(target)}
            onDoubleClick={() => onOpen(target)}
            onKeyDown={(event) => onKey(event, target)}
            onFocus={() => onSelect(target)}
          >
            <rect className="hit" x={1} width={node.width - 2} height={METRICS.rowHeight} />
            <rect
              className="focus-ring"
              x={2}
              y={1}
              width={node.width - 4}
              height={METRICS.rowHeight - 2}
              rx={2}
            />
            {member.change !== "unchanged" && (
              <g
                className={`badge badge-${member.change}`}
                transform={`translate(${METRICS.padX - 1},${METRICS.rowHeight / 2 - 6})`}
              >
                <rect width={12} height={12} rx={3} />
                <text
                  x={6}
                  y={6.5}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="t-small-bold"
                >
                  {memberGlyph(member.change)}
                </text>
              </g>
            )}
            <text
              x={METRICS.padX + METRICS.glyphWidth}
              y={METRICS.rowHeight / 2}
              className={`t-code label${member.isStatic ? " is-static" : ""}${member.isAbstract ? " is-abstract" : ""}`}
              dominantBaseline="central"
            >
              {row.text}
            </text>
            {member.openThreads > 0 && (
              <path
                className="row-thread"
                d={iconPath("comment")}
                transform={`translate(${node.width - METRICS.padX - countsWidth - 20},${METRICS.rowHeight / 2 - 7}) scale(0.875)`}
              />
            )}
            {row.counts && (
              <CountsText
                counts={row.counts}
                x={node.width - METRICS.padX}
                y={METRICS.rowHeight / 2}
                anchor="end"
                className="t-small member-counts"
              />
            )}
            <title>
              {member.previousLabel ? `${row.full}\nBefore: ${member.previousLabel}` : row.full}
              {row.counts
                ? `\nThis member: ${member.counts.added} added, ${member.counts.removed} removed`
                : ""}
            </title>
          </g>
        );
      })}
    </g>
  );
}

function ContainerView({
  container,
  file,
  measure,
  selection,
  tabTarget,
  onSelect,
  onOpen,
  onKey,
  registerRef,
}: {
  container: ContainerLayout;
  file?: UmlFile;
  measure: Measure;
  selection?: Target;
  tabTarget?: Target;
  onSelect(target: Target): void;
  onOpen(target: Target): void;
  onKey(event: ReactKeyboardEvent, target: Target): void;
  registerRef(key: string, element: SVGGElement | null): void;
}) {
  const titleY = METRICS.containerTitleHeight / 2 + 1;
  const pillWidth = container.counts
    ? measure(container.counts, "small") + METRICS.pillPadX * 2
    : 0;
  const target: Target | undefined = container.fileKey
    ? { kind: "file", fileKey: container.fileKey }
    : undefined;
  const title = (
    <>
      <path
        className="container-icon"
        d={iconPath(container.kind)}
        transform={`translate(${METRICS.containerPad - 1},${titleY - 7}) scale(0.875)`}
      />
      <text
        x={METRICS.containerPad + 17}
        y={titleY}
        className="t-small-bold container-title"
        dominantBaseline="central"
      >
        {container.title}
      </text>
      {container.counts && (
        <g
          className="pill"
          transform={`translate(${container.width - METRICS.containerPad - pillWidth},${titleY - 8})`}
        >
          <rect width={pillWidth} height={16} rx={8} />
          <CountsText
            counts={container.counts}
            x={pillWidth / 2}
            y={8}
            anchor="middle"
            className="t-small pill-text"
          />
        </g>
      )}
      <title>
        {container.kind === "file"
          ? `${file?.path ?? container.titleFull}: whole file ${container.counts ?? "unchanged"}`
          : container.kind === "group"
            ? `${container.titleFull}: types joined by relationship lines. Changes: ${container.counts ?? "none"}`
            : `${container.titleFull} all changed files below: ${container.counts ?? "unchanged"}`}
      </title>
    </>
  );
  return (
    <g
      className={`uml-container kind-${container.kind} depth-${Math.min(container.depth, 3)}`}
      transform={`translate(${container.x},${container.y})`}
      data-frame={container.id}
    >
      <rect
        className="container-box"
        width={container.width}
        height={container.height}
        rx={FRAME_RADIUS}
      />
      {target ? (
        <g
          className={`focusable container-head${sameTarget(selection, target) ? " is-selected" : ""}`}
          tabIndex={sameTarget(tabTarget, target) ? 0 : -1}
          role="button"
          aria-label={`File ${file?.path ?? container.titleFull}, ${container.counts ?? "no line changes"}. Open the whole file diff.`}
          ref={(el) => registerRef(targetKey(target), el)}
          onClick={() => onSelect(target)}
          onDoubleClick={() => onOpen(target)}
          onFocus={() => onSelect(target)}
          onKeyDown={(event) => onKey(event, target)}
        >
          <rect
            className="hit"
            width={container.width}
            height={METRICS.containerTitleHeight}
            rx={FRAME_RADIUS}
          />
          <rect
            className="focus-ring"
            x={1.5}
            y={1.5}
            width={container.width - 3}
            height={METRICS.containerTitleHeight - 3}
            rx={FRAME_RADIUS - 1}
          />
          {title}
        </g>
      ) : (
        title
      )}
    </g>
  );
}

function markerFor(edge: EdgeLayout, lit: boolean): string {
  const shape =
    edge.relation.kind === "generalization" || edge.relation.kind === "realization"
      ? "triangle"
      : "arrow";
  const tone = edge.relation.change === "unchanged" ? "plain" : edge.relation.change;
  return `url(#m-${shape}-${tone}${lit ? "-lit" : ""})`;
}

function Markers() {
  const tones = ["plain", "added", "removed", "plain-lit", "added-lit", "removed-lit"];
  return (
    <defs>
      {tones.map((tone) => (
        <marker
          key={`t-${tone}`}
          id={`m-triangle-${tone}`}
          className={`marker tone-${tone}`}
          viewBox="0 0 14 14"
          refX={13}
          refY={7}
          markerWidth={14}
          markerHeight={14}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1,1 L13,7 L1,13 Z" className="marker-triangle" />
        </marker>
      ))}
      {tones.map((tone) => (
        <marker
          key={`a-${tone}`}
          id={`m-arrow-${tone}`}
          className={`marker tone-${tone}`}
          viewBox="0 0 12 12"
          refX={11}
          refY={6}
          markerWidth={12}
          markerHeight={12}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1,1.5 L11,6 L1,10.5" className="marker-arrow" />
        </marker>
      ))}
      {["comment", "question", "lit"].map((kind) => (
        <marker
          key={`n-${kind}`}
          id={`m-note-${kind}`}
          className={`marker note-${kind}`}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={9}
          markerHeight={9}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1,1 L9,5 L1,9 Z" className="marker-note" />
        </marker>
      ))}
    </defs>
  );
}

const LEVEL_ORDER: Record<LinkLevel, number> = { cold: 0, "": 1, warm: 2, hot: 3 };

export function Diagram({
  layout,
  model,
  measure,
  selection,
  fitRequest,
  linksRequest,
  centerRequest,
  find,
  hoverRelation,
  onSelect,
  onOpen,
  onFollow,
  onExpand,
  onOverview,
  draft,
  noteRequest,
  showNote,
  onDraft,
  onAddComment,
  onResolveComment,
  onLinkComment,
  onUnlinkComment,
  onMoveComment,
  onReplyComment,
  onReadComment,
  onEditComment,
  onEditReply,
  onDeleteComment,
  onSendFeedback,
  feedback,
}: DiagramProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [menu, setMenu] = useState<MenuState | undefined>();
  const [linking, setLinking] = useState<Linking | undefined>();
  const [moving, setMoving] = useState<Moving | undefined>();
  const [thread, setThread] = useState<{ id: string; left: boolean } | undefined>();
  const [litLink, setLitLink] = useState<{ from: string; index: number } | undefined>();
  const moveRef = useRef<Moving | undefined>(undefined);
  const justMoved = useRef<string | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [fitView, setFitView] = useState<{ zoom: number; overview: boolean } | undefined>();
  const anchorRef = useRef<{ cx: number; cy: number; fx: number; fy: number } | undefined>(
    undefined,
  );
  const elements = useRef(new Map<string, SVGGElement>());
  const [hoverEdge, setHoverEdge] = useState<string | undefined>();
  const dragRef = useRef<
    { x: number; y: number; left: number; top: number; id: number } | undefined
  >(undefined);
  const pinchRef = useRef<{ distance: number; zoom: number } | undefined>(undefined);
  const linksPending = useRef(false);
  const fitting = useRef(0);
  const measuredFull = useRef(false);
  const [dragging, setDragging] = useState(false);
  const overview =
    fitView && Math.abs(fitView.zoom - zoom) < 0.0001 ? fitView.overview : zoom < READABLE_ZOOM;

  const types = useMemo(() => new Map(model.types.map((t) => [t.id, t])), [model]);
  const files = useMemo(() => new Map(model.files.map((f) => [f.key, f])), [model]);
  const members = useMemo(
    () => new Map(model.types.flatMap((t) => t.members.map((m) => [m.id, m] as const))),
    [model],
  );
  const items = useMemo(() => buildFocusItems(layout), [layout]);
  const parts = useMemo(
    () =>
      [
        ...model.types
          .filter((type) => !type.context)
          .flatMap((type) => [
            targetLink(model, { kind: "type", typeId: type.id }),
            ...type.members.map((member) =>
              targetLink(model, { kind: "member", typeId: type.id, memberId: member.id }),
            ),
          ]),
        ...model.files
          .filter((file) => file.status !== "context")
          .map((file) => targetLink(model, { kind: "file", fileKey: file.key })),
        ...layout.containers
          .filter((container) => container.kind === "group")
          .map((container) => frameLink(model, container)),
      ].filter((link): link is UmlCommentLink => !!link),
    [model, layout],
  );
  const tabTarget = useMemo(() => {
    if (selection && items.some((item) => sameTarget(item.target, selection))) {
      return selection;
    }
    return items[0]?.target;
  }, [items, selection]);

  const registerRef = useCallback((key: string, element: SVGGElement | null) => {
    if (element) {
      elements.current.set(key, element);
    } else {
      elements.current.delete(key);
    }
  }, []);

  const svgOffset = useCallback((viewport: HTMLDivElement): Point => {
    const svg = viewport.querySelector("svg");
    if (!svg) {
      return { x: 0, y: 0 };
    }
    const outer = viewport.getBoundingClientRect();
    const inner = svg.getBoundingClientRect();
    return {
      x: inner.left - outer.left + viewport.scrollLeft,
      y: inner.top - outer.top + viewport.scrollTop,
    };
  }, []);

  const zoomTo = useCallback(
    (next: number, focal?: { x: number; y: number }) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }
      fitting.current = 0;
      const clamped = clampZoom(next);
      const fx = focal?.x ?? viewport.clientWidth / 2;
      const fy = focal?.y ?? viewport.clientHeight / 2;
      const offset = svgOffset(viewport);
      anchorRef.current = {
        cx: (viewport.scrollLeft + fx - offset.x) / zoom,
        cy: (viewport.scrollTop + fy - offset.y) / zoom,
        fx,
        fy,
      };
      setZoom(clamped);
    },
    [zoom, svgOffset],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    if (!viewport || !anchor) {
      return;
    }
    anchorRef.current = undefined;
    const offset = svgOffset(viewport);
    viewport.scrollLeft = anchor.cx * zoom + offset.x - anchor.fx;
    viewport.scrollTop = anchor.cy * zoom + offset.y - anchor.fy;
  }, [zoom, svgOffset]);

  useEffect(() => {
    onOverview(overview);
  }, [overview, onOverview]);

  const applyView = useCallback(
    (mode: "reset" | "fit") => {
      const viewport = viewportRef.current;
      if (!viewport || layout.width === 0) {
        return false;
      }
      const roomX = viewport.clientWidth - CANVAS_PAD_X;
      const roomY = viewport.clientHeight - CANVAS_PAD_Y;
      if (roomX <= 0 || roomY <= 0) {
        return false;
      }
      const layoutOverview = layout.nodes.some((n) => n.overview);
      const room = Math.min(roomX / layout.width, roomY / layout.height);
      const step: FitStep =
        mode === "reset"
          ? { kind: "show", zoom: 1, overview: false }
          : fitStep({ room, layoutOverview, measuredFull: measuredFull.current });
      if (!layoutOverview) {
        measuredFull.current = true;
      }
      if (step.kind !== "show") {
        setFitView({ zoom, overview: step.kind === "overview" });
        return true;
      }
      const next = clampZoom(step.zoom);
      setFitView(mode === "fit" ? { zoom: next, overview: step.overview } : undefined);
      setZoom(next);
      requestAnimationFrame(() => {
        viewport.scrollTo({ left: 0, top: 0 });
      });
      return true;
    },
    [layout, zoom],
  );

  const fit = useCallback(() => {
    fitting.current = FIT_PASSES;
    measuredFull.current = false;
    applyView("fit");
  }, [applyView]);
  const resetView = useCallback(() => {
    fitting.current = 0;
    return applyView("reset");
  }, [applyView]);

  const applyRef = useRef(applyView);
  useEffect(() => {
    applyRef.current = applyView;
  });
  useEffect(() => {
    if (fitting.current > 0) {
      fitting.current--;
      applyRef.current("fit");
    }
  }, [layout]);

  const resetRef = useRef(resetView);
  useEffect(() => {
    resetRef.current = resetView;
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (resetRef.current() || !viewport) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (resetRef.current()) {
        observer.disconnect();
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitRequest]);

  const reveal = useCallback(
    (target: Target | undefined, center: boolean) => {
      const viewport = viewportRef.current;
      const item = target ? items.find((i) => sameTarget(i.target, target)) : undefined;
      if (!viewport) {
        return;
      }
      const offset = svgOffset(viewport);
      const node = item ? layout.nodes.find((n) => n.id === item.nodeId) : undefined;
      const rect = node
        ? { x: node.x, y: node.y, width: node.width, height: node.height }
        : (item?.rect ?? { x: 0, y: 0, width: layout.width, height: layout.height });
      const left = rect.x * zoom + offset.x;
      const top = rect.y * zoom + offset.y;
      const width = rect.width * zoom;
      const height = rect.height * zoom;
      const margin = 24;
      if (center) {
        viewport.scrollTo({
          left: left + width / 2 - viewport.clientWidth / 2,
          top: top + Math.min(height, viewport.clientHeight) / 2 - viewport.clientHeight / 2,
          behavior: "smooth",
        });
        return;
      }
      const focusRect = item
        ? { top: item.rect.y * zoom + offset.y, height: item.rect.height * zoom }
        : { top, height };
      let nextLeft = viewport.scrollLeft;
      let nextTop = viewport.scrollTop;
      if (left < nextLeft + margin) {
        nextLeft = left - margin;
      } else if (
        left + Math.min(width, viewport.clientWidth - margin * 2) >
        nextLeft + viewport.clientWidth - margin
      ) {
        nextLeft =
          left + Math.min(width, viewport.clientWidth - margin * 2) - viewport.clientWidth + margin;
      }
      if (focusRect.top < nextTop + margin) {
        nextTop = focusRect.top - margin;
      } else if (focusRect.top + focusRect.height > nextTop + viewport.clientHeight - margin) {
        nextTop = focusRect.top + focusRect.height - viewport.clientHeight + margin;
      }
      if (nextLeft !== viewport.scrollLeft || nextTop !== viewport.scrollTop) {
        viewport.scrollTo({ left: nextLeft, top: nextTop });
      }
    },
    [items, layout, zoom, svgOffset],
  );

  const links = useMemo(() => linkLevels(layout.edges, selection), [layout, selection]);

  const revealRef = useRef(reveal);
  useEffect(() => {
    revealRef.current = reveal;
  });
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  });
  useEffect(() => {
    if (centerRequest > 0) {
      requestAnimationFrame(() => revealRef.current(selectionRef.current, true));
    }
  }, [centerRequest]);

  const linkedBox = useCallback(() => {
    const typeId = selectedTypeOf(selection);
    if (!typeId) {
      return undefined;
    }
    const ids = new Set([typeId, ...links.ends]);
    const nodes = layout.nodes.filter((n) => ids.has(n.id));
    if (nodes.length === 0) {
      return undefined;
    }
    const x1 = Math.min(...nodes.map((n) => n.x));
    const y1 = Math.min(...nodes.map((n) => n.y));
    const x2 = Math.max(...nodes.map((n) => n.x + n.width));
    const y2 = Math.max(...nodes.map((n) => n.y + n.height));
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }, [layout, links, selection]);

  const scrollToBox = useCallback(
    (box: { x: number; y: number; width: number; height: number }, scale: number) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }
      requestAnimationFrame(() => {
        const offset = svgOffset(viewport);
        viewport.scrollTo({
          left: box.x * scale + offset.x - (viewport.clientWidth - box.width * scale) / 2,
          top: box.y * scale + offset.y - (viewport.clientHeight - box.height * scale) / 2,
          behavior: "smooth",
        });
      });
    },
    [svgOffset],
  );

  const linkedBoxRef = useRef(linkedBox);
  const scrollToBoxRef = useRef(scrollToBox);
  const zoomRef = useRef(zoom);
  useEffect(() => {
    linkedBoxRef.current = linkedBox;
    scrollToBoxRef.current = scrollToBox;
    zoomRef.current = zoom;
  });

  useEffect(() => {
    if (linksRequest === 0) {
      return;
    }
    const viewport = viewportRef.current;
    const box = linkedBoxRef.current();
    if (!viewport || !box) {
      return;
    }
    const next = clampZoom(
      Math.min(
        1,
        (viewport.clientWidth - LINKS_MARGIN) / box.width,
        (viewport.clientHeight - LINKS_MARGIN) / box.height,
      ),
    );
    if (Math.abs(next - zoomRef.current) < 0.001) {
      scrollToBoxRef.current(box, next);
      return;
    }
    linksPending.current = true;
    setZoom(next);
  }, [linksRequest]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!linksPending.current || !viewport) {
      return;
    }
    if (!layout.nodes.every((n) => n.overview === overview)) {
      return;
    }
    linksPending.current = false;
    const box = linkedBox();
    if (!box) {
      return;
    }
    let scale = zoom;
    const fits =
      box.width * zoom <= viewport.clientWidth - LINKS_MARGIN &&
      box.height * zoom <= viewport.clientHeight - LINKS_MARGIN;
    if (!fits) {
      scale = clampZoom(
        Math.min(
          (viewport.clientWidth - LINKS_MARGIN) / box.width,
          (viewport.clientHeight - LINKS_MARGIN) / box.height,
        ),
      );
      setZoom(scale);
    }
    scrollToBox(box, scale);
  }, [layout, zoom, overview, linkedBox, scrollToBox]);

  const pan = useCallback((dx: number, dy: number) => {
    fitting.current = 0;
    viewportRef.current?.scrollBy({ left: dx, top: dy, behavior: "smooth" });
  }, []);
  const glide = useCallback((vector: Point) => {
    fitting.current = 0;
    viewportRef.current?.scrollBy({ left: vector.x * HOLD_SPEED, top: vector.y * HOLD_SPEED });
  }, []);

  const focusTarget = useCallback(
    (target: Target | undefined) => {
      if (!target) {
        return;
      }
      onSelect(target);
      requestAnimationFrame(() => {
        elements.current.get(targetKey(target))?.focus({ preventScroll: true });
        reveal(target, false);
      });
    },
    [onSelect, reveal],
  );

  const toDiagram = useCallback(
    (client: Point): Point => {
      const rect = svgRef.current?.getBoundingClientRect();
      return rect
        ? { x: (client.x - rect.left) / zoom, y: (client.y - rect.top) / zoom }
        : { x: 0, y: 0 };
    },
    [zoom],
  );

  const nearBox = useCallback(
    (hit: LinkHit | undefined): Box | undefined => {
      if (!hit || (hit.link.scope !== "type" && hit.link.scope !== "member")) {
        return undefined;
      }
      const node = layout.nodes.find((n) => n.id === hit.link.typeIds[0]);
      return node && { ...node, y: hit.box.y };
    },
    [layout],
  );

  const visibleBox = useCallback((): Box | undefined => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) {
      return undefined;
    }
    const start = toDiagram({ x: rect.left + 12, y: rect.top + 64 });
    const end = toDiagram({ x: rect.right - 12, y: rect.bottom - 12 });
    return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
  }, [toDiagram]);

  const threadSide = useCallback(
    (box: Box) => {
      const view = visibleBox();
      const room = view ? view.x + view.width - (box.x + box.width) : Infinity;
      return room * zoom < THREAD_WIDTH + 24;
    },
    [visibleBox, zoom],
  );

  const newDraft = useCallback(
    (hit: LinkHit | undefined, point: Point) => {
      const place = draftPlace(layout, nearBox(hit), point, visibleBox());
      onDraft({ kind: "comment", links: hit ? [hit.link] : [], ...place });
      setThread({
        id: "draft",
        left: threadSide({ ...place, width: DRAFT_WIDTH, height: DRAFT_HEIGHT }),
      });
    },
    [layout, nearBox, onDraft, visibleBox, threadSide],
  );

  const addLink = useCallback(
    (from: string, link: UmlCommentLink) => {
      if (from !== "draft") {
        onLinkComment(from, link);
      } else if (draft && !draft.links.some((held) => sameLink(held, link))) {
        onDraft({ ...draft, links: [...draft.links, link] });
      }
    },
    [draft, onDraft, onLinkComment],
  );

  const startLink = useCallback((from: string, start: Point, sticky: boolean) => {
    setMenu(undefined);
    setLinking({ from, start, end: start, sticky });
  }, []);

  const showThread = useCallback(
    (note: NoteLayout) => {
      setMenu(undefined);
      setThread({ id: note.id, left: threadSide(note) });
    },
    [threadSide],
  );

  const shownNote = useRef(0);
  useEffect(() => {
    const viewport = viewportRef.current;
    const note = showNote && layout.notes.find((n) => n.id === showNote.id);
    if (!showNote || showNote.seq === shownNote.current || !note || !viewport) {
      return;
    }
    shownNote.current = showNote.seq;
    const offset = svgOffset(viewport);
    viewport.scrollTo({
      left: (note.x + note.width / 2) * zoom + offset.x - viewport.clientWidth / 2,
      top: (note.y + note.height / 2) * zoom + offset.y - viewport.clientHeight / 2,
    });
    showThread(note);
  }, [showNote, layout, zoom, svgOffset, showThread]);

  const openMenu = (element: Element | null, client: Point) => {
    const point = toDiagram(client);
    const lineElement = element?.closest<SVGElement>("[data-note-link]");
    if (lineElement) {
      const from = lineElement.dataset.noteLink as string;
      const index = Number(lineElement.dataset.linkIndex);
      const links =
        from === "draft" ? draft?.links : layout.notes.find((n) => n.id === from)?.comment.links;
      setMenu({
        ...client,
        title: `Link to ${links?.[index]?.title ?? "this part"}`,
        items: [
          {
            label: "Remove this link",
            run: () =>
              from === "draft"
                ? draft && onDraft({ ...draft, links: draft.links.filter((_, i) => i !== index) })
                : onUnlinkComment(from, index),
          },
        ],
      });
      return;
    }
    const noteId = element?.closest<SVGElement>("[data-note]")?.dataset.note;
    const note = layout.notes.find((n) => n.id === noteId);
    if (note) {
      const kind = note.comment.kind === "question" ? "Question" : "Comment";
      setMenu({
        ...client,
        title: `${kind} on ${linksTitle(note.comment.links)}`,
        items: [
          { label: "Show thread", run: () => showThread(note) },
          {
            label: "Link to a type, member or frame…",
            run: () =>
              startLink(note.id, { x: note.x + note.width, y: note.y + note.height / 2 }, true),
          },
          { label: "Resolve", run: () => onResolveComment(note.id) },
        ],
      });
      return;
    }
    const hit = linkAt(element, model, layout);
    const items = [{ label: "Add comment", run: () => newDraft(hit, point) }];
    if (draft && hit && !draft.links.some((held) => sameLink(held, hit.link))) {
      items.push({
        label: "Link the new comment here",
        run: () => addLink("draft", hit.link),
      });
    }
    setMenu({ ...client, title: hit?.link.title, items });
  };
  const openMenuRef = useRef(openMenu);
  useLayoutEffect(() => {
    openMenuRef.current = openMenu;
  });

  const linkFrom = linking?.from;
  const linkSticky = linking?.sticky ?? false;
  useEffect(() => {
    if (linkFrom === undefined) {
      return;
    }
    const hitAt = (event: PointerEvent) =>
      linkAt(document.elementFromPoint(event.clientX, event.clientY), model, layout);
    const move = (event: PointerEvent) => {
      const end = toDiagram({ x: event.clientX, y: event.clientY });
      const hit = hitAt(event);
      setLinking((current) => current && { ...current, end, hit });
    };
    const finish = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const hit = hitAt(event);
      setLinking(undefined);
      if (hit) {
        addLink(linkFrom, hit.link);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setLinking(undefined);
      }
    };
    const end = linkSticky ? "pointerdown" : "pointerup";
    window.addEventListener("pointermove", move);
    window.addEventListener(end, finish, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener(end, finish, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [linkFrom, linkSticky, model, layout, toDiagram, addLink]);

  const lastNoteRequest = useRef(noteRequest);
  useEffect(() => {
    if (noteRequest === lastNoteRequest.current) {
      return;
    }
    lastNoteRequest.current = noteRequest;
    const link = selection && targetLink(model, selection);
    const element = selection && elements.current.get(targetKey(selection));
    const rect = element?.getBoundingClientRect();
    const hit = link && rect && linkAt(element ?? null, model, layout);
    newDraft(hit, toDiagram({ x: rect?.right ?? 0, y: rect?.top ?? 0 }));
  }, [noteRequest, selection, model, layout, newDraft, toDiagram]);

  const notes = useMemo(() => {
    if (!moving || moving.id === "draft" || moving.layout !== layout) {
      return layout.notes;
    }
    return layout.notes.map((note): NoteLayout => {
      if (note.id !== moving.id || !moving.moved) {
        return note;
      }
      const at = { ...note, x: moving.x, y: moving.y };
      const home = noteHome(at, layout.containers);
      return {
        ...at,
        home,
        links: moving.held ? noteLinks({ ...at, home }, note.comment.links, layout) : [],
      };
    });
  }, [layout, moving]);

  const startMove = useCallback(
    (id: string, origin: Point, from: Point) => {
      setMenu(undefined);
      const start = { id, origin, from, ...origin, moved: false, held: false, layout };
      moveRef.current = start;
      setMoving(start);
    },
    [layout],
  );

  const nudge = useCallback(
    (note: NoteLayout, dx: number, dy: number) => {
      const at = { x: Math.max(0, note.x + dx), y: Math.max(0, note.y + dy) };
      setMoving({ id: note.id, origin: at, from: at, ...at, moved: true, held: true, layout });
      onMoveComment(note.id, notePlace(at, note.comment.links, layout.nodes));
    },
    [layout, onMoveComment],
  );

  const moveId = moving && !moving.held ? moving.id : undefined;
  useEffect(() => {
    if (moveId === undefined) {
      return;
    }
    const move = (event: PointerEvent) => {
      const current = moveRef.current;
      if (!current) {
        return;
      }
      const dx = event.clientX - current.from.x;
      const dy = event.clientY - current.from.y;
      if (!current.moved && Math.hypot(dx, dy) <= 4) {
        return;
      }
      const next = {
        ...current,
        moved: true,
        x: Math.max(0, current.origin.x + dx / zoom),
        y: Math.max(0, current.origin.y + dy / zoom),
      };
      moveRef.current = next;
      setMoving(next);
    };
    const finish = () => {
      const current = moveRef.current;
      moveRef.current = undefined;
      if (!current?.moved) {
        setMoving(undefined);
        return;
      }
      justMoved.current = current.id;
      window.setTimeout(() => {
        justMoved.current = undefined;
      }, 0);
      if (current.id === "draft") {
        setMoving(undefined);
        if (draft) {
          onDraft({ ...draft, x: current.x, y: current.y });
        }
        return;
      }
      const note = current.layout.notes.find((n) => n.id === current.id);
      if (note) {
        onMoveComment(note.id, notePlace(current, note.comment.links, current.layout.nodes));
      }
      setMoving({ ...current, held: true });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        moveRef.current = undefined;
        setMoving(undefined);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [moveId, zoom, draft, onDraft, onMoveComment]);

  const shownDraft =
    draft && moving?.id === "draft" ? { ...draft, x: moving.x, y: moving.y } : draft;
  const shownNotes = notes;
  const threadNote = thread && shownNotes.find((note) => note.id === thread.id);
  const threadComment = thread && model.comments.find((c) => c.id === thread.id);
  const threadId = thread?.id;
  const readThread = useCallback(() => {
    if (threadId) {
      onReadComment(threadId);
    }
  }, [threadId, onReadComment]);

  const draftBox = {
    x: shownDraft?.x ?? 0,
    y: shownDraft?.y ?? 0,
    width: DRAFT_WIDTH,
    height: DRAFT_HEIGHT,
    home: "",
  };
  const draftDragging = moving?.id === "draft" && moving.moved && !moving.held;
  const draftLines =
    shownDraft && !draftDragging ? noteLinks(draftBox, shownDraft.links, { ...layout, notes }) : [];
  const ghostNote: NoteLayout | undefined = shownDraft && {
    id: "draft",
    comment: {
      id: "draft",
      kind: shownDraft.kind,
      body: "",
      replies: 0,
      sent: false,
      items: [],
      unread: 0,
      waiting: false,
      links: shownDraft.links,
    },
    x: shownDraft.x,
    y: shownDraft.y,
    width: DRAFT_WIDTH,
    height: DRAFT_HEIGHT,
    lines: ["Type in the thread…"],
    home: "",
    links: [],
  };
  const threadActions = (id: string, note: Box): ThreadActions => ({
    nameOf: (typeId) => types.get(typeId)?.name ?? typeId,
    searchParts: (query) => searchParts(parts, query),
    onMention: (link) => addLink(id, link),
    onHoverLink: (index) => setLitLink(index === undefined ? undefined : { from: id, index }),
    onShowLink: (link) => {
      const target: Target =
        link.scope === "file" && link.fileKey
          ? { kind: "file", fileKey: link.fileKey }
          : link.scope === "member" && link.memberId
            ? { kind: "member", typeId: link.typeIds[0], memberId: link.memberId }
            : { kind: "type", typeId: link.typeIds[0] };
      onSelect(target);
      reveal(target, false);
    },
    onLink: () => startLink(id, { x: note.x + note.width, y: note.y + note.height / 2 }, true),
    onUnlink: (index) =>
      id === "draft"
        ? draft && onDraft({ ...draft, links: draft.links.filter((_, i) => i !== index) })
        : onUnlinkComment(id, index),
    onClose: () => {
      setThread(undefined);
      if (id === "draft") {
        onDraft(undefined);
      }
    },
  });

  const onKey = useCallback(
    (event: ReactKeyboardEvent, target: Target) => {
      const index = items.findIndex((item) => sameTarget(item.target, target));
      const current = items[index];
      if (!current) {
        return;
      }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const element = elements.current.get(targetKey(target));
        const rect = element?.getBoundingClientRect();
        openMenuRef.current(element ?? null, {
          x: (rect?.left ?? 0) + 16,
          y: (rect?.top ?? 0) + 16,
        });
        return;
      }
      if (event.shiftKey && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const dx =
          event.key === "ArrowLeft" ? -PAN_STEP : event.key === "ArrowRight" ? PAN_STEP : 0;
        const dy = event.key === "ArrowUp" ? -PAN_STEP : event.key === "ArrowDown" ? PAN_STEP : 0;
        pan(dx, dy);
        return;
      }
      const sameNode = items.filter((item) => item.nodeId === current.nodeId);
      const position = sameNode.indexOf(current);
      let next: FocusItem | undefined;
      switch (event.key) {
        case "ArrowDown":
          next = sameNode[position + 1] ?? nearest(items, current, "down");
          break;
        case "ArrowUp":
          next = position > 0 ? sameNode[position - 1] : nearest(items, current, "up");
          break;
        case "ArrowLeft":
          next = nearest(items, current, "left");
          break;
        case "ArrowRight":
          next = nearest(items, current, "right");
          break;
        case "Home":
          next = items[0];
          break;
        case "End":
          next = [...items].reverse().find((item) => item.target.kind !== "member");
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          onOpen(target);
          return;
        case "Escape":
          event.preventDefault();
          onSelect(undefined);
          return;
        case "+":
        case "=":
          event.preventDefault();
          zoomTo(zoom * ZOOM_STEP);
          return;
        case "-":
          event.preventDefault();
          zoomTo(zoom / ZOOM_STEP);
          return;
        case "0":
          event.preventDefault();
          resetView();
          return;
        case "f":
        case "F":
          event.preventDefault();
          fit();
          return;
        case "c":
        case "C":
          event.preventDefault();
          reveal(target, true);
          return;
        default:
          return;
      }
      event.preventDefault();
      if (next) {
        focusTarget(next.target);
      }
    },
    [items, pan, onOpen, onSelect, zoom, zoomTo, fit, resetView, focusTarget, reveal],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      zoomTo(zoom * Math.exp(-event.deltaY * 0.01), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    };
    const distance = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        pinchRef.current = { distance: distance(event.touches), zoom };
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      const pinch = pinchRef.current;
      if (event.touches.length !== 2 || !pinch) {
        return;
      }
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      zoomTo(pinch.zoom * (distance(event.touches) / pinch.distance), {
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2 - bounds.left,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2 - bounds.top,
      });
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        pinchRef.current = undefined;
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: false });
    viewport.addEventListener("touchend", onTouchEnd);
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("touchend", onTouchEnd);
    };
  }, [zoom, zoomTo]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) {
      return;
    }
    if (
      (event.target as Element).closest(
        ".focusable, .controls, .uml-edge, .uml-note, .note-link-hit",
      )
    ) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    fitting.current = 0;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      id: event.pointerId,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!dragging && Math.hypot(dx, dy) > 4) {
      setDragging(true);
      viewport.setPointerCapture(event.pointerId);
    }
    viewport.scrollLeft = drag.left - dx;
    viewport.scrollTop = drag.top - dy;
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (dragging) {
      setDragging(false);
      viewportRef.current?.releasePointerCapture(event.pointerId);
    } else if (
      drag &&
      !(event.target as Element).closest(
        ".focusable, .controls, .uml-edge, .uml-note, .note-link-hit",
      )
    ) {
      onSelect(undefined);
    }
  };

  const selectedType = selectedTypeOf(selection);
  const activeHover = hoverEdge ?? hoverRelation;
  const edgeChanges = new Map(layout.edges.map((edge) => [edge.id, edge.relation.change]));
  const hovered = activeHover ? layout.edges.find((e) => e.id === activeHover) : undefined;
  const hoverEnds = new Set(hovered ? [hovered.relation.source, hovered.relation.target] : []);
  const shownEdges = layout.edges
    .map((edge) => ({ edge, level: links.levels.get(edge.id) ?? ("" as LinkLevel) }))
    .sort(
      (a, b) =>
        Number(a.edge.id === activeHover) - Number(b.edge.id === activeHover) ||
        LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
    );

  const { roleTexts, rolePlaces } = useMemo(() => {
    const texts = new Map(
      layout.edges
        .filter((edge) => links.levels.get(edge.id) === "hot")
        .map((edge) => [edge.id, roleText(edge, members)] as const)
        .filter(([, text]) => text !== ""),
    );
    const places = placeRoleLabels(
      layout.edges
        .filter((edge) => texts.has(edge.id))
        .map((edge) => ({
          id: edge.id,
          points: edge.points,
          width: measure(texts.get(edge.id) as string, "small") + 12,
          height: 18,
        })),
      [...layout.nodes, ...layout.edges.flatMap((edge) => (edge.label ? [edge.label] : []))],
      layout.edges.map((edge) => ({
        id: edge.id,
        points: edge.points,
        strong: links.levels.get(edge.id) === "hot",
      })),
    );
    return { roleTexts: texts, rolePlaces: places };
  }, [layout, links, members, measure]);

  const follow = (edge: EdgeLayout) => {
    const other =
      selectedType === edge.relation.source
        ? edge.relation.target
        : selectedType === edge.relation.target
          ? edge.relation.source
          : edge.relation.target;
    onFollow(other);
  };

  return (
    <div className="diagram-frame">
      <div
        ref={viewportRef}
        className={`viewport${dragging ? " is-dragging" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = undefined;
          setDragging(false);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!linking) {
            openMenu(event.target as Element, { x: event.clientX, y: event.clientY });
          }
        }}
      >
        <div className="canvas">
          <div className={`canvas-stage${linking ? " is-linking" : ""}`}>
            <svg
              ref={svgRef}
              width={Math.max(1, layout.width * zoom)}
              height={Math.max(1, layout.height * zoom)}
              viewBox={`0 0 ${Math.max(1, layout.width)} ${Math.max(1, layout.height)}`}
              role="application"
              aria-roledescription="UML class diagram"
              aria-label="UML class diagram. Click to select, double-click or press Enter to open the diff. Use the arrow keys to move between types and members, Shift and an arrow key to pan."
            >
              <Markers />
              {layout.containers.map((container) => (
                <ContainerView
                  key={container.id}
                  container={container}
                  file={container.fileKey ? files.get(container.fileKey) : undefined}
                  measure={measure}
                  selection={selection}
                  tabTarget={tabTarget}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onKey={onKey}
                  registerRef={registerRef}
                />
              ))}
              <g className="note-links">
                {[
                  ...shownNotes.flatMap((note) =>
                    note.links.map((line) => ({ from: note.id, kind: note.comment.kind, line })),
                  ),
                  ...draftLines.map((line) => ({
                    from: "draft",
                    kind: draft?.kind ?? "comment",
                    line,
                  })),
                ].map(({ from, kind, line }, order) => {
                  const d = roundedPath(line.points);
                  return (
                    <g
                      key={`${from}:${line.index}:${order}`}
                      className={`note-line kind-${kind}${litLink?.from === from && litLink.index === line.index ? " is-lit" : ""}`}
                      data-note-link={from}
                      data-link-index={line.index}
                    >
                      <path className="note-link" d={d} />
                      <path className="note-link-hit" d={d} />
                      <title>Right-click to remove this link</title>
                    </g>
                  );
                })}
              </g>
              <g className="edges">
                {shownEdges.map(({ edge, level }) => {
                  const d = roundedPath(edge.points);
                  const isHover = edge.id === activeHover;
                  return (
                    <g
                      key={edge.id}
                      className={`uml-edge kind-${edge.relation.kind} rel-${edge.relation.change}${level ? ` is-${level}` : ""}${isHover ? " is-hover" : ""}`}
                      onPointerEnter={() => setHoverEdge(edge.id)}
                      onPointerLeave={() => setHoverEdge(undefined)}
                      onClick={() => follow(edge)}
                    >
                      <path className="edge-casing" d={d} />
                      <path
                        className="edge-line"
                        d={d}
                        markerEnd={markerFor(edge, level === "hot" || isHover)}
                      />
                      {edge.label?.anchor && (
                        <line
                          className="edge-label-leader"
                          x1={edge.label.anchor.x}
                          y1={edge.label.anchor.y}
                          x2={Math.min(
                            Math.max(edge.label.anchor.x, edge.label.x),
                            edge.label.x + edge.label.width,
                          )}
                          y2={Math.min(
                            Math.max(edge.label.anchor.y, edge.label.y),
                            edge.label.y + edge.label.height,
                          )}
                        />
                      )}
                      {edge.label && (
                        <text
                          x={edge.label.x + edge.label.width / 2}
                          y={edge.label.y + edge.label.height / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          className="t-small edge-label"
                        >
                          {edge.label.text}
                        </text>
                      )}
                      <path className="edge-hit" d={d} />
                      <title>{`${edgeTitle(edge, types)}. Click to go to the other end.`}</title>
                    </g>
                  );
                })}
              </g>
              {layout.nodes.map((node) => {
                const type = types.get(node.id);
                if (!type) {
                  return null;
                }
                return (
                  <NodeView
                    key={node.id}
                    node={node}
                    type={type}
                    file={files.get(type.fileKey)}
                    measure={measure}
                    selection={selection}
                    tabTarget={tabTarget}
                    related={links.ends.has(node.id)}
                    hotEnd={links.hotEnds.has(node.id)}
                    dimmed={!!selectedType && node.id !== selectedType && !links.ends.has(node.id)}
                    endHover={hoverEnds.has(node.id)}
                    findHit={find !== "" && type.name.toLowerCase().includes(find.toLowerCase())}
                    onSelect={onSelect}
                    onOpen={onOpen}
                    onExpand={onExpand}
                    onKey={onKey}
                    registerRef={registerRef}
                  />
                );
              })}
              <g className="notes">
                {shownNotes.map((note) => (
                  <NoteView
                    key={note.id}
                    note={note}
                    measure={measure}
                    moving={moving?.id === note.id && moving.moved && !moving.held}
                    onShow={() => {
                      if (justMoved.current !== note.id) {
                        showThread(note);
                      }
                    }}
                    onStartMove={(from) => startMove(note.id, { x: note.x, y: note.y }, from)}
                    onNudge={(dx, dy) => nudge(note, dx * NUDGE, dy * NUDGE)}
                    onResolve={onResolveComment}
                    onMenu={(target, at) =>
                      openMenu(
                        svgRef.current?.querySelector(`[data-note="${CSS.escape(target.id)}"]`) ??
                          null,
                        at,
                      )
                    }
                    onStartLink={(id, from) => startLink(id, from, false)}
                  />
                ))}
                {ghostNote && (
                  <NoteView
                    key="draft"
                    note={ghostNote}
                    measure={measure}
                    ghost
                    moving={moving?.id === "draft" && moving.moved}
                    onShow={() => {
                      if (ghostNote) {
                        setThread({ id: "draft", left: threadSide(ghostNote) });
                      }
                    }}
                    onStartMove={(from) =>
                      draft && startMove("draft", { x: draft.x, y: draft.y }, from)
                    }
                    onNudge={(dx, dy) =>
                      draft &&
                      onDraft({
                        ...draft,
                        x: Math.max(0, draft.x + dx * NUDGE),
                        y: Math.max(0, draft.y + dy * NUDGE),
                      })
                    }
                    onResolve={() => onDraft(undefined)}
                    onMenu={() => undefined}
                    onStartLink={(_, from) => startLink("draft", from, false)}
                  />
                )}
              </g>
              <g className="role-labels">
                {[...rolePlaces].map(([id, place]) => {
                  const anchor = place.anchor;
                  const endX = anchor
                    ? Math.min(Math.max(anchor.x, place.x), place.x + place.width)
                    : 0;
                  const endY = anchor
                    ? Math.min(Math.max(anchor.y, place.y), place.y + place.height)
                    : 0;
                  return (
                    <g
                      key={id}
                      className={`role-label rel-${edgeChanges.get(id) ?? "unchanged"}${id === activeHover ? " is-hover" : ""}`}
                    >
                      {anchor && (
                        <>
                          <line
                            className="role-leader"
                            x1={anchor.x}
                            y1={anchor.y}
                            x2={endX}
                            y2={endY}
                          />
                          <circle className="role-anchor" cx={anchor.x} cy={anchor.y} r={2.5} />
                        </>
                      )}
                      <g transform={`translate(${place.x},${place.y})`}>
                        <rect width={place.width} height={place.height} rx={place.height / 2} />
                        <text
                          x={place.width / 2}
                          y={place.height / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          className="t-small"
                        >
                          {roleTexts.get(id)}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </g>
              {linking && (
                <g className="linking">
                  {linking.hit && (
                    <rect
                      className="link-target"
                      x={linking.hit.box.x - 2}
                      y={linking.hit.box.y - 2}
                      width={linking.hit.box.width + 4}
                      height={linking.hit.box.height + 4}
                      rx={6}
                    />
                  )}
                  <line
                    className="link-drag"
                    x1={linking.start.x}
                    y1={linking.start.y}
                    x2={linking.end.x}
                    y2={linking.end.y}
                  />
                </g>
              )}
            </svg>
            {thread?.id === "draft" && draft && ghostNote && (
              <NewThread
                kind={draft.kind}
                links={draft.links}
                left={
                  thread.left
                    ? ghostNote.x * zoom - THREAD_WIDTH - 12
                    : (ghostNote.x + ghostNote.width) * zoom + 12
                }
                top={ghostNote.y * zoom}
                actions={threadActions("draft", ghostNote)}
                onKind={(kind) => onDraft({ ...draft, kind })}
                onPost={(body) => {
                  setThread(undefined);
                  onAddComment(draft, body);
                }}
              />
            )}
            {threadNote && threadComment && thread && (
              <ThreadPopup
                key={threadNote.id}
                comment={threadComment}
                left={
                  thread.left
                    ? threadNote.x * zoom - THREAD_WIDTH - 12
                    : (threadNote.x + threadNote.width) * zoom + 12
                }
                top={threadNote.y * zoom}
                linking={!!linking}
                feedback={feedback}
                actions={threadActions(threadNote.id, threadNote)}
                onReply={(body) => onReplyComment(threadNote.id, body)}
                onRead={readThread}
                onResolve={() => {
                  setThread(undefined);
                  onResolveComment(threadNote.id);
                }}
                onEditOpening={(kind, body) => onEditComment(threadNote.id, kind, body)}
                onEditReply={onEditReply}
                onDelete={(itemId) => {
                  if (itemId === threadNote.id) {
                    setThread(undefined);
                  }
                  onDeleteComment(itemId);
                }}
                onSendFeedback={onSendFeedback}
              />
            )}
          </div>
        </div>
      </div>
      <div className="view-controls">
        <div className="controls" role="toolbar" aria-label="Diagram view">
          <button
            type="button"
            className="icon-button"
            title="Fit all (F)"
            aria-label="Fit the whole diagram in the view"
            onClick={fit}
          >
            <Icon name="fit" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Reset to 100% (0)"
            aria-label="Reset the view to 100 percent at the top"
            onClick={resetView}
          >
            <Icon name="reset" />
          </button>
          <span className="control-sep" aria-hidden />
          <button
            type="button"
            className="icon-button"
            title="Zoom out (−)"
            aria-label="Zoom out"
            onClick={() => zoomTo(zoom / ZOOM_STEP)}
          >
            <Icon name="zoomOut" />
          </button>
          <button
            type="button"
            className="zoom-value"
            title="Reset to 100%"
            aria-label={`Zoom ${Math.round(zoom * 100)} percent. Reset to 100 percent`}
            onClick={() => zoomTo(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="icon-button"
            title="Zoom in (+)"
            aria-label="Zoom in"
            onClick={() => zoomTo(zoom * ZOOM_STEP)}
          >
            <Icon name="zoomIn" />
          </button>
        </div>
        <JoyPad
          onStep={(vector) => pan(vector.x * PAN_STEP, vector.y * PAN_STEP)}
          onGlide={glide}
          onCentre={() => reveal(selection, true)}
          centreLabel={selection ? "Centre the selection (C)" : "Centre the diagram"}
        />
      </div>
      {linking && (
        <div className="link-hint" role="status">
          {linking.hit
            ? `Link to ${linking.hit.link.title}`
            : linking.sticky
              ? "Click a type, a member, a frame or a file to link it. Esc to stop."
              : "Drop on a type, a member, a frame or a file. Esc cancels."}
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(undefined)} />}
    </div>
  );
}

function edgeTitle(edge: EdgeLayout, types: Map<string, UmlType>): string {
  const source = types.get(edge.relation.source)?.name ?? "?";
  const target = types.get(edge.relation.target)?.name ?? "?";
  const change = edge.relation.change === "unchanged" ? "" : ` (${edge.relation.change})`;
  const multiplicity = edge.relation.multiplicity ? ` ${edge.relation.multiplicity}` : "";
  const via = edge.relation.roles.length > 0 ? ` via ${edge.relation.roles.join(", ")}` : "";
  return `${source} ${RELATION_WORDS[edge.relation.kind]}${multiplicity} ${target}${via}${change}`;
}
