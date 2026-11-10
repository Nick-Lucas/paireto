import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { linksTitle, timeAgo } from "../core/comments";
import type { UmlComment, UmlCommentItem, UmlCommentLink } from "../core/model";
import type { FeedbackState } from "../core/protocol";
import { Icon, type IconName } from "./icons";
import type { CommentKind } from "./notes";

export const THREAD_WIDTH = 360;
const THREAD_MAX_HEIGHT = 460;

const KIND_LABELS: Record<CommentKind, string> = { comment: "Comment", question: "Question" };

const SCOPE_WORDS: Record<UmlCommentLink["scope"], string> = {
  type: "type",
  member: "member",
  group: "frame of linked types",
  file: "file",
};

interface MentionSource {
  nameOf(typeId: string): string;
  search(query: string): UmlCommentLink[];
  onPick(link: UmlCommentLink): void;
}

const SCOPE_ICONS: Record<UmlCommentLink["scope"], IconName> = {
  type: "symbolClass",
  member: "symbolMethod",
  group: "group",
  file: "file",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function chipText(
  link: UmlCommentLink,
  nameOf: (typeId: string) => string,
): { label: string; info: string; title: string } {
  if (link.scope === "file") {
    const cut = link.title.lastIndexOf("/");
    return {
      label: link.title.slice(cut + 1),
      info: cut > 0 ? link.title.slice(0, cut) : "",
      title: `The types in ${link.title}. Click to show the file on the diagram.`,
    };
  }
  if (link.scope === "group") {
    const names = link.typeIds.map(nameOf);
    const shown = names.slice(0, 5).join(", ");
    const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
    return {
      label: link.title,
      info: "frame",
      title: `Frame of ${plural(names.length, "linked type", "linked types")}: ${shown}${more}. Click to show it on the diagram.`,
    };
  }
  return {
    label: link.title,
    info: "",
    title: `${link.scope === "member" ? "Member" : "Type"} ${link.title}. Click to show it on the diagram.`,
  };
}

function ContextChips({
  links,
  nameOf,
  onShow,
  onHover,
  onRemove,
}: {
  links: readonly UmlCommentLink[];
  nameOf(typeId: string): string;
  onShow(link: UmlCommentLink): void;
  onHover(index: number | undefined): void;
  onRemove?(index: number): void;
}) {
  if (links.length === 0) {
    return null;
  }
  return (
    <div className="ctx-chips">
      {links.map((link, index) => {
        const text = chipText(link, nameOf);
        return (
          <span
            key={index}
            className={`ctx-chip scope-${link.scope}`}
            onPointerEnter={() => onHover(index)}
            onPointerLeave={() => onHover(undefined)}
          >
            {onRemove && (
              <button
                type="button"
                className="ctx-remove"
                aria-label={`Remove the link to ${link.title}`}
                title="Remove this link"
                onClick={() => onRemove(index)}
              >
                <Icon name="close" />
              </button>
            )}
            <button
              type="button"
              className="ctx-label"
              title={text.title}
              onClick={() => onShow(link)}
            >
              <Icon name={SCOPE_ICONS[link.scope]} />
              <span className="ctx-name">{text.label}</span>
              {text.info && <span className="ctx-info">{text.info}</span>}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function KindPicker({ kind, onKind }: { kind: CommentKind; onKind(kind: CommentKind): void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="kind-picker">
      <button
        type="button"
        className="kind-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Post it as a comment or as a question"
        onClick={() => setOpen(!open)}
      >
        {KIND_LABELS[kind]}
        <Icon name="down" />
      </button>
      {open && (
        <span className="kind-menu" role="listbox" aria-label="Kind">
          {(["comment", "question"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === kind}
              className={option === kind ? "kind-option is-on" : "kind-option"}
              onClick={() => {
                onKind(option);
                setOpen(false);
              }}
            >
              <span className="kind-tick">{option === kind && <Icon name="check" />}</span>
              {KIND_LABELS[option]}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

interface ChipProps {
  links: readonly UmlCommentLink[];
  nameOf(typeId: string): string;
  onShow(link: UmlCommentLink): void;
  onHover(index: number | undefined): void;
  onRemove(index: number): void;
}

function mentionAt(value: string, caret: number): { start: number; query: string } | undefined {
  const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : undefined;
}

function Composer({
  variant,
  initial,
  placeholder,
  kind,
  onKind,
  chips,
  disabled,
  focus,
  mentions,
  onLink,
  onSubmit,
  onCancel,
}: {
  variant: "post" | "reply" | "edit";
  initial: string;
  placeholder: string;
  kind?: CommentKind;
  onKind?(kind: CommentKind): void;
  chips?: ChipProps;
  disabled?: boolean;
  focus?: boolean;
  mentions: MentionSource;
  onLink(): void;
  onSubmit(body: string): void;
  onCancel?(): void;
}) {
  const [body, setBody] = useState(initial);
  const [mention, setMention] = useState<{ start: number; query: string } | undefined>();
  const [active, setActive] = useState(0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (focus && text) {
      text.focus({ preventScroll: true });
      text.setSelectionRange(text.value.length, text.value.length);
    }
  }, [focus]);
  const found = mention ? mentions.search(mention.query) : [];
  const track = (value: string, caret: number) => {
    const next = mentionAt(value, caret);
    setMention(next);
    if (next?.query !== mention?.query) {
      setActive(0);
    }
  };
  const pick = (link: UmlCommentLink) => {
    const text = textRef.current;
    if (!mention || !text) {
      return;
    }
    const caret = text.selectionStart;
    const label = chipText(link, mentions.nameOf).label;
    const next = `${body.slice(0, mention.start)}@${label} ${body.slice(caret)}`;
    const at = mention.start + label.length + 2;
    setBody(next);
    setMention(undefined);
    mentions.onPick(link);
    requestAnimationFrame(() => {
      text.focus({ preventScroll: true });
      text.setSelectionRange(at, at);
    });
  };
  const submit = () => {
    if (body.trim()) {
      onSubmit(body.trim());
      if (variant === "reply") {
        setBody("");
      }
    }
  };
  const submitLabel =
    variant === "reply"
      ? "Reply"
      : variant === "edit"
        ? "Save the change"
        : `Post ${KIND_LABELS[kind ?? "comment"].toLowerCase()}`;
  return (
    <div className={`composer is-${variant}${disabled ? " is-disabled" : ""}`}>
      <textarea
        ref={textRef}
        aria-label={
          variant === "reply" ? "Reply" : variant === "edit" ? "Edit the message" : "Comment"
        }
        aria-autocomplete="list"
        aria-expanded={found.length > 0}
        value={body}
        rows={variant === "reply" ? 1 : 2}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          setBody(event.target.value);
          track(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) => track(event.currentTarget.value, event.currentTarget.selectionStart)}
        onBlur={() => setMention(undefined)}
        onKeyDown={(event) => {
          if (found.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((active + step + found.length) % found.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              event.stopPropagation();
              pick(found[Math.min(active, found.length - 1)]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setMention(undefined);
              return;
            }
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            submit();
          } else if (event.key === "Escape" && onCancel) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {found.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label="Parts to link">
          {found.map((link, index) => {
            const text = chipText(link, mentions.nameOf);
            return (
              <button
                key={`${link.scope}:${link.title}`}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`mention-option scope-${link.scope}${index === active ? " is-active" : ""}`}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => pick(link)}
              >
                <Icon name={SCOPE_ICONS[link.scope]} />
                <span className="ctx-name">{text.label}</span>
                <span className="ctx-info">{SCOPE_WORDS[link.scope]}</span>
              </button>
            );
          })}
        </div>
      )}
      {chips && chips.links.length > 0 && (
        <div className="ctx-row">
          <ContextChips
            links={chips.links}
            nameOf={chips.nameOf}
            onShow={chips.onShow}
            onHover={chips.onHover}
            onRemove={chips.onRemove}
          />
        </div>
      )}
      <div className="composer-bar">
        <button
          type="button"
          className="bar-link"
          disabled={disabled}
          title="Link this thread to a type, a member, a frame or a file: click it on the diagram, or type @"
          onClick={onLink}
        >
          <Icon name="link" />
          Link a part…
        </button>
        {kind && onKind && <KindPicker kind={kind} onKind={onKind} />}
        <span className="composer-gap" />
        <button
          type="button"
          className="send-button"
          aria-label={submitLabel}
          title={
            variant === "edit"
              ? "Save the change (⌘↵). Esc cancels."
              : `${submitLabel} (⌘↵). It is saved in the review and goes to the agent with Send Feedback.`
          }
          disabled={disabled || !body.trim()}
          onClick={submit}
        >
          <Icon name={variant === "edit" ? "check" : "send"} />
        </button>
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
  item: UmlCommentItem;
  first: boolean;
  now: number;
  onEdit(): void;
  onDelete(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  if (item.who === "agent") {
    return (
      <div className="msg from-agent">
        <div className="msg-who">
          <span className="msg-avatar" aria-hidden>
            <Icon name="sparkle" />
          </span>
          <span className="msg-name">Agent</span>
          <span className="msg-time">{timeAgo(item.at, now)}</span>
        </div>
        <div className="msg-body">{item.body}</div>
      </div>
    );
  }
  return (
    <div className="msg from-you">
      <div className="msg-bubble">
        {item.body}
        {!confirm && (
          <span className="msg-tools">
            <button type="button" aria-label="Edit this message" title="Edit" onClick={onEdit}>
              <Icon name="edit" />
            </button>
            <button
              type="button"
              aria-label={first ? "Delete the thread" : "Delete this message"}
              title="Delete"
              onClick={() => (first ? setConfirm(true) : onDelete())}
            >
              <Icon name="trash" />
            </button>
          </span>
        )}
      </div>
      {confirm ? (
        <div className="msg-confirm" role="alert">
          <span>Delete the whole thread?</span>
          <button type="button" className="text-button" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button type="button" className="button danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      ) : (
        <div className="msg-meta">
          {`${timeAgo(item.at, now)} · `}
          <span className={item.sent ? "msg-sent" : "msg-not-sent"}>
            {item.sent ? "sent" : "not sent"}
          </span>
        </div>
      )}
    </div>
  );
}

export interface ThreadActions {
  nameOf(typeId: string): string;
  searchParts(query: string): UmlCommentLink[];
  onMention(link: UmlCommentLink): void;
  onShowLink(link: UmlCommentLink): void;
  onHoverLink(index: number | undefined): void;
  onLink(): void;
  onUnlink(index: number): void;
  onClose(): void;
}

function usePlacement(rootRef: React.RefObject<HTMLDivElement | null>, key: unknown) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    const view = root?.closest(".viewport")?.getBoundingClientRect();
    if (!root || !view) {
      return;
    }
    root.style.transform = "";
    const box = root.getBoundingClientRect();
    const over = box.bottom - (view.bottom - 12);
    const room = box.top - (view.top + 64);
    root.style.transform = over > 0 ? `translateY(${-Math.min(over, Math.max(0, room))}px)` : "";
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

function stop(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function mentionsFor(actions: ThreadActions): MentionSource {
  return { nameOf: actions.nameOf, search: actions.searchParts, onPick: actions.onMention };
}

function chipsFor(actions: ThreadActions, links: readonly UmlCommentLink[]): ChipProps {
  return {
    links,
    nameOf: actions.nameOf,
    onShow: actions.onShowLink,
    onHover: actions.onHoverLink,
    onRemove: actions.onUnlink,
  };
}

export function NewThread({
  kind,
  links,
  left,
  top,
  actions,
  onKind,
  onPost,
}: {
  kind: CommentKind;
  links: readonly UmlCommentLink[];
  left: number;
  top: number;
  actions: ThreadActions;
  onKind(kind: CommentKind): void;
  onPost(body: string): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [offset, startDrag] = useWindowDrag();
  usePlacement(rootRef, `${top}:${links.length}:${offset.x}:${offset.y}`);
  return (
    <div
      ref={rootRef}
      className="thread-popup"
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
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          actions.onClose();
        }
      }}
    >
      <div className="thread-head" title="Drag to move the window" onPointerDown={startDrag}>
        <span className="thread-title">New comment</span>
        <button
          type="button"
          className="thread-icon"
          aria-label="Discard the new comment"
          title="Discard"
          onClick={actions.onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <Composer
        variant="post"
        initial=""
        focus
        placeholder="Type a comment or a question for the agent. Type @ to link a part."
        kind={kind}
        onKind={onKind}
        chips={chipsFor(actions, links)}
        mentions={mentionsFor(actions)}
        onLink={actions.onLink}
        onSubmit={onPost}
      />
      <div className="thread-hint">
        Saved in the review when you post. It goes to the agent with Send Feedback.
      </div>
    </div>
  );
}

export function ThreadPopup({
  comment,
  left,
  top,
  linking,
  feedback,
  actions,
  onReply,
  onRead,
  onResolve,
  onOpenEditor,
  onEditOpening,
  onEditReply,
  onDelete,
  onSendFeedback,
}: {
  comment: UmlComment;
  left: number;
  top: number;
  linking: boolean;
  feedback: FeedbackState;
  actions: ThreadActions;
  onReply(body: string): void;
  onRead(): void;
  onResolve(): void;
  onOpenEditor(): void;
  onEditOpening(kind: CommentKind, body: string): void;
  onEditReply(itemId: string, body: string): void;
  onDelete(itemId: string): void;
  onSendFeedback(): void;
}) {
  const [now] = useState(() => Date.now());
  const [editing, setEditing] = useState<string | undefined>();
  const [editKind, setEditKind] = useState<CommentKind>(comment.kind);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [offset, startDrag] = useWindowDrag();
  const kind = KIND_LABELS[comment.kind];
  const unread = comment.unread;
  useEffect(() => {
    if (unread > 0) {
      onRead();
    }
  }, [unread, onRead]);
  const count = comment.items.length;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && count > 0) {
      list.scrollTop = list.scrollHeight;
    }
  }, [count]);
  usePlacement(rootRef, `${top}:${count}:${editing ?? ""}:${offset.x}:${offset.y}`);
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
        !target?.closest(`[data-note="${CSS.escape(comment.id)}"]`) &&
        !target?.closest(".context-menu")
      ) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [comment.id, onClose]);
  const editIndex = editing === undefined ? -1 : comment.items.findIndex((i) => i.id === editing);
  const notSent = comment.items.filter((item) => item.who === "you" && !item.sent).length;
  return (
    <div
      ref={rootRef}
      className="thread-popup"
      role="dialog"
      aria-label={`${kind} on ${linksTitle(comment.links)}`}
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
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="thread-head" title="Drag to move the window" onPointerDown={startDrag}>
        <span className="thread-title">{`${kind} on ${linksTitle(comment.links)}`}</span>
        <button
          type="button"
          className="thread-icon"
          aria-label="Open the thread in the editor"
          title="Open in editor"
          onClick={onOpenEditor}
        >
          <Icon name="open" />
        </button>
        <button
          type="button"
          className="thread-icon"
          aria-label="Resolve the thread"
          title="Resolve"
          onClick={onResolve}
        >
          <Icon name="check" />
        </button>
        <button
          type="button"
          className="thread-icon"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="thread-list" ref={listRef}>
        {comment.items.map((item, index) =>
          item.id === editing ? (
            <div key={item.id} className="msg is-editing">
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
              <div className="thread-hint">
                {`Editing. ⌘↵ saves, Esc cancels.${item.sent ? " This was sent: saving marks it not sent again." : ""}`}
              </div>
            </div>
          ) : (
            <div
              key={item.id}
              className={editIndex >= 0 && index > editIndex ? "msg-wrap is-dim" : "msg-wrap"}
            >
              <Message
                item={item}
                first={index === 0}
                now={now}
                onEdit={() => {
                  setEditKind(comment.kind);
                  setEditing(item.id);
                }}
                onDelete={() => onDelete(item.id)}
              />
            </div>
          ),
        )}
        {comment.waiting && (
          <div className="thread-waiting">Sent. The agent has not answered yet.</div>
        )}
      </div>
      {notSent > 0 && (
        <div className="thread-status" role="status">
          <span className="status-dot" aria-hidden />
          <span>{`${plural(notSent, "message", "messages")} not sent.`}</span>
          <span className="composer-gap" />
          {feedback.waiting ? (
            <button type="button" className="link-button" onClick={onSendFeedback}>
              Send Feedback
            </button>
          ) : (
            <span className="thread-later">They go at the agent's next review.</span>
          )}
        </div>
      )}
      <Composer
        variant="reply"
        initial=""
        focus={editing === undefined}
        disabled={editing !== undefined}
        placeholder="Reply to the agent. Type @ to link a part."
        chips={chipsFor(actions, comment.links)}
        mentions={mentionsFor(actions)}
        onLink={actions.onLink}
        onSubmit={onReply}
      />
    </div>
  );
}
