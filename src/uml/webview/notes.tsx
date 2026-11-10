import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { linksTitle, noteStatus } from "../core/comments";
import {
  METRICS,
  NOTE_METRICS,
  type Box,
  type ContainerLayout,
  type DiagramLayout,
  type Measure,
  type NoteLayout,
  type Point,
} from "../core/layout";
import type { UmlCommentLink, UmlModel } from "../core/model";
import { iconPath } from "./icons";
import type { Target } from "./targets";

export type CommentKind = "comment" | "question";

export interface Draft {
  kind: CommentKind;
  links: UmlCommentLink[];
  x: number;
  y: number;
}

export interface MenuItem {
  label: string;
  run(): void;
}

export interface MenuState {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

export const DRAFT_WIDTH = NOTE_METRICS.width;
export const DRAFT_HEIGHT =
  NOTE_METRICS.headHeight + NOTE_METRICS.lineHeight + NOTE_METRICS.padBottom;
const NOTE_FOLD = 12;
const GAP = 24;

export function targetLink(model: UmlModel, target: Target): UmlCommentLink | undefined {
  if (target.kind === "file") {
    const file = model.files.find((f) => f.key === target.fileKey);
    return (
      file && {
        scope: "file",
        title: file.path,
        fileKey: file.key,
        typeIds: model.types.filter((t) => t.fileKey === file.key && !t.context).map((t) => t.id),
      }
    );
  }
  const type = model.types.find((t) => t.id === target.typeId);
  if (!type) {
    return undefined;
  }
  if (target.kind === "member") {
    const member = type.members.find((m) => m.id === target.memberId);
    return (
      member && {
        scope: "member",
        title: `${type.name}.${member.name}`,
        typeIds: [type.id],
        memberId: member.id,
      }
    );
  }
  return { scope: "type", title: type.name, typeIds: [type.id] };
}

export function frameLink(model: UmlModel, container: ContainerLayout): UmlCommentLink | undefined {
  if (container.kind === "group") {
    return { scope: "group", title: container.titleFull, typeIds: container.typeIds ?? [] };
  }
  return container.kind === "file" && container.fileKey
    ? targetLink(model, { kind: "file", fileKey: container.fileKey })
    : undefined;
}

export interface LinkHit {
  link: UmlCommentLink;
  box: Box;
}

export function linkAt(
  element: Element | null,
  model: UmlModel,
  layout: DiagramLayout,
): LinkHit | undefined {
  const nodeElement = element?.closest<SVGElement>("[data-node]");
  if (nodeElement) {
    const node = layout.nodes.find((n) => n.id === nodeElement.dataset.node);
    const memberId = element?.closest<SVGElement>("[data-member]")?.dataset.member;
    if (!node) {
      return undefined;
    }
    const row = memberId ? node.rows.find((r) => r.memberId === memberId) : undefined;
    const link = targetLink(
      model,
      row && memberId
        ? { kind: "member", typeId: node.id, memberId }
        : { kind: "type", typeId: node.id },
    );
    const box = row
      ? { x: node.x, y: node.y + row.y, width: node.width, height: METRICS.rowHeight }
      : node;
    return link && { link, box };
  }
  const frameId = element?.closest<SVGElement>("[data-frame]")?.dataset.frame;
  const frame = layout.containers.find((c) => c.id === frameId);
  const link = frame && frameLink(model, frame);
  return frame && link ? { link, box: frame } : undefined;
}

export function draftPlace(
  layout: DiagramLayout,
  near: Box | undefined,
  point: Point,
  view: Box | undefined,
): Point {
  const width = DRAFT_WIDTH;
  const height = DRAFT_HEIGHT;
  const gap = GAP;
  const area = view ?? { x: 0, y: 0, width: layout.width, height: layout.height };
  const fits = (x: number) => x >= area.x && x + width <= area.x + area.width;
  const right = near ? near.x + near.width + gap : point.x + gap / 2;
  const left = near ? near.x - gap - width : point.x - gap / 2 - width;
  const x = fits(right) || !fits(left) ? right : left;
  const y = near ? near.y : point.y;
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
  };
}

function foldPath(width: number, height: number): string {
  return `M0,0 H${width - NOTE_FOLD} L${width},${NOTE_FOLD} V${height} H0 Z`;
}

const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

const BADGE_HEIGHT = 16;

export function NoteView({
  note,
  measure,
  moving,
  ghost,
  onShow,
  onStartMove,
  onNudge,
  onResolve,
  onMenu,
  onStartLink,
}: {
  note: NoteLayout;
  measure: Measure;
  moving: boolean;
  ghost?: boolean;
  onShow(): void;
  onStartMove(from: Point): void;
  onNudge(dx: number, dy: number): void;
  onResolve(id: string): void;
  onMenu(note: NoteLayout, at: Point): void;
  onStartLink(id: string, from: Point, pointerId: number): void;
}) {
  const { comment, width, height } = note;
  const headY = NOTE_METRICS.headHeight / 2 + 1;
  const kind = comment.kind === "question" ? "Question" : "Comment";
  const title = linksTitle(comment.links);
  const status = noteStatus(comment);
  const kindRight = NOTE_METRICS.padX + 18 + measure(kind, "smallBold");
  const badgeRoom = width - NOTE_FOLD - 30 - (kindRight + 8);
  const badgeText =
    status.badge && measure(status.badge, "smallBold") + 22 <= badgeRoom
      ? status.badge
      : `${comment.unread} new`;
  const badgeWidth = status.badge ? measure(badgeText, "smallBold") + 22 : 0;
  const metaRoom = width - NOTE_FOLD - 30 - (kindRight + 6);
  const meta = ghost
    ? "new"
    : status.badge
      ? ""
      : measure(status.meta, "small") <= metaRoom
        ? status.meta
        : status.meta.replace(/^\d+ repl(y|ies) · /, "");
  return (
    <g
      className={`uml-note kind-${comment.kind}${comment.sent ? " is-sent" : ""}${moving ? " is-moving" : ""}${ghost ? " is-ghost" : ""}`}
      transform={`translate(${note.x},${note.y})`}
      data-note={comment.id}
      role="button"
      tabIndex={0}
      aria-label={
        ghost
          ? "New comment. Type it in the thread beside it."
          : `${kind} on ${title}: ${comment.body}. ${status.badge ? `${status.badge}. ` : ""}Press Enter to show the thread, where you can reply or edit it. Press Alt and an arrow key to move it. Press the menu key to link it or resolve it.`
      }
      onClick={onShow}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onShow();
      }}
      onPointerDown={(event) => {
        if (event.button === 0 && !(event.target as Element).closest(".note-resolve")) {
          onStartMove({ x: event.clientX, y: event.clientY });
        }
      }}
      onKeyDown={(event) => {
        const arrow = ARROWS[event.key];
        if (arrow && event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          onNudge(arrow.x, arrow.y);
        } else if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onShow();
        } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(note, { x: rect.left + 12, y: rect.top + 12 });
        }
      }}
    >
      <title>{`${kind} on ${title}\n\n${comment.body}\n\nClick to show the thread, where you can reply or edit it. Drag the note to move it. Drag the dot to link it to a type or a frame.`}</title>
      <path className="note-box" d={foldPath(width, height)} />
      <path className="note-fold" d={`M${width - NOTE_FOLD},0 V${NOTE_FOLD} H${width}`} />
      <path
        className="note-icon"
        d={iconPath("comment")}
        transform={`translate(${NOTE_METRICS.padX - 1},${headY - 7}) scale(0.875)`}
      />
      <text
        x={NOTE_METRICS.padX + 18}
        y={headY}
        className="t-small-bold note-kind"
        dominantBaseline="central"
      >
        {kind}
        <tspan className="note-meta" dx={6}>
          {meta}
        </tspan>
      </text>
      {status.badge && (
        <g
          className="note-badge"
          transform={`translate(${kindRight + 8},${headY - BADGE_HEIGHT / 2})`}
        >
          <rect width={badgeWidth} height={BADGE_HEIGHT} rx={BADGE_HEIGHT / 2} />
          <circle cx={9} cy={BADGE_HEIGHT / 2} r={3} />
          <text x={16} y={BADGE_HEIGHT / 2} className="t-small-bold" dominantBaseline="central">
            {badgeText}
          </text>
        </g>
      )}
      <g
        className="note-resolve"
        role="button"
        aria-label={`Resolve this ${kind.toLowerCase()}`}
        transform={`translate(${width - NOTE_FOLD - 26},${headY - 9})`}
        onClick={(event) => {
          event.stopPropagation();
          onResolve(comment.id);
        }}
      >
        <title>Resolve</title>
        <rect width={18} height={18} rx={4} />
        <path d={iconPath("check")} transform="translate(1,1)" />
      </g>
      {note.lines.map((line, index) => (
        <text
          key={index}
          x={NOTE_METRICS.padX}
          y={
            NOTE_METRICS.headHeight + index * NOTE_METRICS.lineHeight + NOTE_METRICS.lineHeight / 2
          }
          className="t-small note-text"
          dominantBaseline="central"
        >
          {line}
        </text>
      ))}
      <g
        className="note-handle"
        transform={`translate(${width},${height / 2})`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.stopPropagation();
          event.preventDefault();
          onStartLink(comment.id, { x: note.x + width, y: note.y + height / 2 }, event.pointerId);
        }}
      >
        <title>Drag to a type, a member or a frame to link this note to it</title>
        <circle className="handle-hit" r={10} />
        <circle className="handle-dot" r={5} />
      </g>
    </g>
  );
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    setAt({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
    });
    element.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={menu.title ?? "Diagram"}
      style={{ left: at.x, top: at.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = [...(ref.current?.querySelectorAll("button") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          buttons[(index + step + buttons.length) % buttons.length]?.focus();
        }
      }}
    >
      {menu.title && <div className="tb-pop-head context-title">{menu.title}</div>}
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="context-item"
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
