import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { NOTE_KIND_LABELS, targetsTitle, timeAgo, type NoteKind } from "../model/notes";
import type { VizFeedbackState, VizNote, VizNoteItem, VizNoteTarget } from "../protocol";
import { Composer, type ChipProps, type MentionSource } from "./Composer";
import { UiIcon } from "./icons";
import { plural } from "./parts";
import "./thread.css";

export const THREAD_WIDTH = 360;
const THREAD_MAX_HEIGHT = 460;

export interface ThreadActions {
  searchTargets(query: string): VizNoteTarget[];
  onMention(target: VizNoteTarget): void;
  onShowTarget(target: VizNoteTarget): void;
  onLink(): void;
  onUnlink(index: number): void;
  onClose(): void;
}

function stop(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function mentionsFor(actions: ThreadActions): MentionSource {
  return { search: actions.searchTargets, onPick: actions.onMention };
}

function chipsFor(actions: ThreadActions, targets: readonly VizNoteTarget[]): ChipProps {
  return { targets, onShow: actions.onShowTarget, onRemove: actions.onUnlink };
}

function usePlacement(rootRef: React.RefObject<HTMLDivElement | null>, key: unknown) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const view = root?.parentElement?.getBoundingClientRect();
    if (!root || !view) {
      return;
    }
    root.style.transform = "";
    const box = root.getBoundingClientRect();
    const over = box.bottom - (view.bottom - 12);
    const room = box.top - (view.top + 64);
    const right = box.right - (view.right - 12);
    const dx = right > 0 ? -Math.min(right, Math.max(0, box.left - view.left - 12)) : 0;
    const dy = over > 0 ? -Math.min(over, Math.max(0, room)) : 0;
    root.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
  }, [rootRef, key]);
}

function useWindowDrag(): [{ x: number; y: number }, (event: React.PointerEvent) => void] {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const start = (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) {
      return;
    }
    event.preventDefault();
    const from = { x: event.clientX - offset.x, y: event.clientY - offset.y };
    const move = (moved: PointerEvent) =>
      setOffset({ x: moved.clientX - from.x, y: moved.clientY - from.y });
    const end = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
  };
  return [offset, start];
}

export function NewThread({
  kind,
  targets,
  left,
  top,
  actions,
  onKind,
  onPost,
}: {
  kind: NoteKind;
  targets: readonly VizNoteTarget[];
  left: number;
  top: number;
  actions: ThreadActions;
  onKind(kind: NoteKind): void;
  onPost(body: string): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [offset, startDrag] = useWindowDrag();
  usePlacement(rootRef, `${left}:${top}:${targets.length}:${offset.x}:${offset.y}`);
  return (
    <div
      ref={rootRef}
      className="viz-thread"
      role="dialog"
      aria-label="New comment"
      style={{
        left: left + offset.x,
        top: top + offset.y,
        width: THREAD_WIDTH,
        maxHeight: THREAD_MAX_HEIGHT,
      }}
      onPointerDown={stop}
      onPointerUp={stop}
      onContextMenu={stop}
      onDoubleClick={stop}
      onWheel={stop}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          actions.onClose();
        }
      }}
    >
      <div className="viz-thread__head" title="Drag to move the window" onPointerDown={startDrag}>
        <span className="viz-thread__title">New comment</span>
        <button
          type="button"
          className="viz-iconbtn"
          aria-label="Discard the new comment"
          title="Discard"
          onClick={actions.onClose}
        >
          <UiIcon name="close" />
        </button>
      </div>
      <Composer
        variant="post"
        initial=""
        focus
        placeholder="Type a comment or a question for the agent. Type @ to link a part."
        kind={kind}
        onKind={onKind}
        chips={chipsFor(actions, targets)}
        mentions={mentionsFor(actions)}
        onLink={actions.onLink}
        onSubmit={onPost}
      />
      <div className="viz-thread__hint">
        Saved in the review when you post. It goes to the agent with Send Feedback.
      </div>
    </div>
  );
}

function Message({
  item,
  first,
  now,
  onEdit,
  onDelete,
}: {
  item: VizNoteItem;
  first: boolean;
  now: number;
  onEdit(): void;
  onDelete(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  if (item.who === "agent") {
    return (
      <div className="viz-msg viz-msg--agent">
        <div className="viz-msg__who">
          <span className="viz-msg__avatar" aria-hidden>
            <UiIcon name="sparkle" size={12} />
          </span>
          <span className="viz-msg__name">Agent</span>
          <span className="viz-msg__time">{timeAgo(item.at, now)}</span>
        </div>
        <div className="viz-msg__body">{item.body}</div>
      </div>
    );
  }
  return (
    <div className="viz-msg viz-msg--you">
      <div className="viz-msg__bubble">
        {item.body}
        {!confirm && (
          <span className="viz-msg__tools">
            <button
              type="button"
              className="viz-iconbtn"
              aria-label="Edit this message"
              title="Edit"
              onClick={onEdit}
            >
              <UiIcon name="edit" size={13} />
            </button>
            <button
              type="button"
              className="viz-iconbtn"
              aria-label={first ? "Delete the thread" : "Delete this message"}
              title="Delete"
              onClick={() => (first ? setConfirm(true) : onDelete())}
            >
              <UiIcon name="trash" size={13} />
            </button>
          </span>
        )}
      </div>
      {confirm ? (
        <div className="viz-msg__confirm" role="alert">
          <span>Delete the whole thread?</span>
          <button type="button" className="viz-textbtn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button type="button" className="viz-btn viz-btn--danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      ) : (
        <div className="viz-msg__meta">
          {`${timeAgo(item.at, now)} · `}
          <span className={item.sent ? "" : "viz-msg__notsent"}>
            {item.sent ? "sent" : "not sent"}
          </span>
        </div>
      )}
    </div>
  );
}

export function ThreadPopup({
  note,
  left,
  top,
  linking,
  feedback,
  actions,
  onReply,
  onRead,
  onResolve,
  onEditOpening,
  onEditReply,
  onDelete,
  onSendFeedback,
}: {
  note: VizNote;
  left: number;
  top: number;
  linking: boolean;
  feedback: VizFeedbackState;
  actions: ThreadActions;
  onReply(body: string): void;
  onRead(): void;
  onResolve(): void;
  onEditOpening(kind: NoteKind, body: string): void;
  onEditReply(itemId: string, body: string): void;
  onDelete(itemId: string): void;
  onSendFeedback(): void;
}) {
  const [now] = useState(() => Date.now());
  const [editing, setEditing] = useState<string | undefined>();
  const [editKind, setEditKind] = useState<NoteKind>(note.kind);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [offset, startDrag] = useWindowDrag();
  const kind = NOTE_KIND_LABELS[note.kind];
  const unread = note.unread;
  useEffect(() => {
    if (unread > 0) {
      onRead();
    }
  }, [unread, onRead]);
  const count = note.items.length;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && count > 0) {
      list.scrollTop = list.scrollHeight;
    }
  }, [count]);
  usePlacement(rootRef, `${left}:${top}:${count}:${editing ?? ""}:${offset.x}:${offset.y}`);
  const linkingRef = useRef(linking);
  useEffect(() => {
    linkingRef.current = linking;
  }, [linking]);
  const onClose = actions.onClose;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        !linkingRef.current &&
        !rootRef.current?.contains(target) &&
        !target?.closest(".viz-note") &&
        !target?.closest(".viz-context-menu")
      ) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [onClose]);
  const editIndex = editing === undefined ? -1 : note.items.findIndex((i) => i.id === editing);
  const notSent = note.items.filter((item) => item.who === "you" && !item.sent).length;
  return (
    <div
      ref={rootRef}
      className="viz-thread"
      role="dialog"
      aria-label={`${kind} on ${targetsTitle(note.targets)}`}
      style={{
        left: left + offset.x,
        top: top + offset.y,
        width: THREAD_WIDTH,
        maxHeight: THREAD_MAX_HEIGHT,
      }}
      onPointerDown={stop}
      onPointerUp={stop}
      onContextMenu={stop}
      onDoubleClick={stop}
      onWheel={stop}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="viz-thread__head" title="Drag to move the window" onPointerDown={startDrag}>
        <span className="viz-thread__title">{`${kind} on ${targetsTitle(note.targets)}`}</span>
        <button
          type="button"
          className="viz-iconbtn"
          aria-label="Resolve the thread"
          title="Resolve"
          onClick={onResolve}
        >
          <UiIcon name="check" />
        </button>
        <button
          type="button"
          className="viz-iconbtn"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <UiIcon name="close" />
        </button>
      </div>
      <div className="viz-thread__list" ref={listRef}>
        {note.items.map((item, index) =>
          item.id === editing ? (
            <div key={item.id} className="viz-msg viz-msg--editing">
              <Composer
                variant="edit"
                initial={item.body}
                focus
                placeholder="Type the message…"
                kind={index === 0 ? editKind : undefined}
                onKind={index === 0 ? setEditKind : undefined}
                mentions={mentionsFor(actions)}
                onLink={actions.onLink}
                onSubmit={(body) => {
                  if (index === 0) {
                    onEditOpening(editKind, body);
                  } else {
                    onEditReply(item.id, body);
                  }
                  setEditing(undefined);
                }}
                onCancel={() => setEditing(undefined)}
              />
              <div className="viz-thread__hint">
                {`Editing. Enter saves, Shift+Enter adds a line, Esc cancels.${item.sent ? " This was sent: saving marks it not sent again." : ""}`}
              </div>
            </div>
          ) : (
            <div
              key={item.id}
              className={
                editIndex >= 0 && index > editIndex
                  ? "viz-msg-wrap viz-msg-wrap--dim"
                  : "viz-msg-wrap"
              }
            >
              <Message
                item={item}
                first={index === 0}
                now={now}
                onEdit={() => {
                  setEditKind(note.kind);
                  setEditing(item.id);
                }}
                onDelete={() => onDelete(item.id)}
              />
            </div>
          ),
        )}
        {note.waiting && (
          <div className="viz-thread__waiting">Sent. The agent has not answered yet.</div>
        )}
      </div>
      {notSent > 0 && (
        <div className="viz-thread__status" role="status">
          <span className="viz-status-dot" aria-hidden />
          <span>{`${plural(notSent, "message")} not sent.`}</span>
          <span className="viz-composer__gap" />
          {feedback.waiting ? (
            <button type="button" className="viz-textbtn" onClick={onSendFeedback}>
              Send Feedback
            </button>
          ) : (
            <span className="viz-thread__later">They go at the agent's next review.</span>
          )}
        </div>
      )}
      <Composer
        variant="reply"
        initial=""
        focus={editing === undefined}
        disabled={editing !== undefined}
        placeholder="Reply to the agent. Type @ to link a part."
        chips={chipsFor(actions, note.targets)}
        mentions={mentionsFor(actions)}
        onLink={actions.onLink}
        onSubmit={onReply}
      />
    </div>
  );
}
