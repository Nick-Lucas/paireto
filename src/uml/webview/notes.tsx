import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { linksTitle } from "../core/comments";
import {
  METRICS,
  NOTE_METRICS,
  type Box,
  type ContainerLayout,
  type DiagramLayout,
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
export const DRAFT_HEIGHT = 138;
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

export function NoteView({
  note,
  onOpen,
  onResolve,
  onMenu,
  onStartLink,
}: {
  note: NoteLayout;
  onOpen(id: string): void;
  onResolve(id: string): void;
  onMenu(note: NoteLayout, at: Point): void;
  onStartLink(id: string, from: Point, pointerId: number): void;
}) {
  const { comment, width, height } = note;
  const headY = NOTE_METRICS.headHeight / 2 + 1;
  const kind = comment.kind === "question" ? "Question" : "Comment";
  const title = linksTitle(comment.links);
  const meta = [
    comment.replies > 0 ? `${comment.replies} ${comment.replies === 1 ? "reply" : "replies"}` : "",
    comment.sent ? "sent" : "not sent",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <g
      className={`uml-note kind-${comment.kind}${comment.sent ? " is-sent" : ""}`}
      transform={`translate(${note.x},${note.y})`}
      data-note={comment.id}
      role="button"
      tabIndex={0}
      aria-label={`${kind} on ${title}: ${comment.body}. Open the thread to reply, edit or delete it. Press the menu key to link it.`}
      onClick={() => onOpen(comment.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(comment.id);
        } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(note, { x: rect.left + 12, y: rect.top + 12 });
        }
      }}
    >
      <title>{`${kind} on ${title}\n\n${comment.body}\n\nClick to open the thread. Drag the dot to link it to a type or a frame.`}</title>
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

export function DraftNote({
  draft,
  zoom,
  onKind,
  onDone,
  onCancel,
  onStartLink,
}: {
  draft: Draft;
  zoom: number;
  onKind(kind: CommentKind): void;
  onDone(body: string): void;
  onCancel(): void;
  onStartLink(from: Point, pointerId: number): void;
}) {
  const [body, setBody] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headY = NOTE_METRICS.headHeight / 2 + 1;
  const done = () => {
    if (body.trim()) {
      onDone(body.trim());
    }
  };
  return (
    <div
      className={`uml-note draft-note kind-${draft.kind}`}
      role="dialog"
      aria-label="New note on the diagram"
      style={{
        left: draft.x * zoom,
        top: draft.y * zoom,
        width: DRAFT_WIDTH,
        height: DRAFT_HEIGHT,
        transform: `scale(${zoom})`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          done();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <svg width={DRAFT_WIDTH} height={DRAFT_HEIGHT} aria-hidden>
        <path className="note-box" d={foldPath(DRAFT_WIDTH, DRAFT_HEIGHT)} />
        <path
          className="note-fold"
          d={`M${DRAFT_WIDTH - NOTE_FOLD},0 V${NOTE_FOLD} H${DRAFT_WIDTH}`}
        />
        <path
          className="note-icon"
          d={iconPath("comment")}
          transform={`translate(${NOTE_METRICS.padX - 1},${headY - 7}) scale(0.875)`}
        />
      </svg>
      <div className="draft-head" role="radiogroup" aria-label="Kind of note">
        {(["comment", "question"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === draft.kind}
            className={k === draft.kind ? "draft-kind is-on" : "draft-kind"}
            onClick={() => {
              onKind(k);
              textRef.current?.focus();
            }}
          >
            {k === "comment" ? "Comment" : "Question"}
          </button>
        ))}
      </div>
      <textarea
        ref={textRef}
        autoFocus
        aria-label="Note text"
        value={body}
        placeholder={
          draft.kind === "question"
            ? "Type a question for the agent…"
            : "Type what the agent should change…"
        }
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="draft-links" title={draft.links.map((l) => l.title).join("\n")}>
        {draft.links.length > 0
          ? `Linked to ${linksTitle(draft.links)}`
          : "Not linked. Drag the dot to link it."}
      </div>
      <div className="draft-actions">
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          disabled={!body.trim()}
          title="Save the note (⌘↵). It goes to the agent with Send Feedback."
          onClick={done}
        >
          Done
        </button>
      </div>
      <button
        type="button"
        className="draft-handle"
        aria-label="Drag to a type, a member or a frame to link this note to it"
        title="Drag to a type, a member or a frame to link this note to it"
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.stopPropagation();
          event.preventDefault();
          onStartLink({ x: draft.x + DRAFT_WIDTH, y: draft.y + DRAFT_HEIGHT / 2 }, event.pointerId);
        }}
      />
    </div>
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
