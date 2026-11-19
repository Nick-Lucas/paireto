import { useLayoutEffect, useRef, useState } from "react";

import { NOTE_KIND_LABELS, type NoteKind } from "../model/notes";
import type { VizNoteTarget } from "../protocol";
import { UiIcon, type UiIconName } from "./icons";

const TARGET_ICONS: Record<VizNoteTarget["kind"], UiIconName> = {
  node: "symbolClass",
  member: "symbolMethod",
  edge: "arrow",
  file: "file",
};

const TARGET_WORDS: Record<VizNoteTarget["kind"], string> = {
  node: "part",
  member: "member",
  edge: "link",
  file: "file",
};

export interface MentionSource {
  search(query: string): VizNoteTarget[];
  onPick(target: VizNoteTarget): void;
}

export interface ChipProps {
  targets: readonly VizNoteTarget[];
  onShow(target: VizNoteTarget): void;
  onRemove?(index: number): void;
}

function chipText(target: VizNoteTarget): { label: string; info: string } {
  if (target.kind === "file") {
    const cut = target.path.lastIndexOf("/");
    return { label: target.path.slice(cut + 1), info: cut > 0 ? target.path.slice(0, cut) : "" };
  }
  return { label: target.label, info: "" };
}

export function TargetChips({ targets, onShow, onRemove }: ChipProps) {
  if (targets.length === 0) {
    return null;
  }
  return (
    <div className="viz-ctx-chips">
      {targets.map((target, index) => {
        const text = chipText(target);
        return (
          <span key={index} className={`viz-ctx-chip viz-ctx-chip--${target.kind}`}>
            {onRemove && (
              <button
                type="button"
                className="viz-ctx-chip__remove"
                aria-label={`Remove the link to ${target.label}`}
                title="Remove this link"
                onClick={() => onRemove(index)}
              >
                <UiIcon name="close" size={10} />
              </button>
            )}
            <button
              type="button"
              className="viz-ctx-chip__label"
              title={`${TARGET_WORDS[target.kind]} ${target.label}. Click to show it on the diagram.`}
              onClick={() => onShow(target)}
            >
              <UiIcon name={TARGET_ICONS[target.kind]} size={12} />
              <span className="viz-ctx-chip__name">{text.label}</span>
              {text.info && <span className="viz-ctx-chip__info">{text.info}</span>}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function KindPicker({ kind, onKind }: { kind: NoteKind; onKind(kind: NoteKind): void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="viz-kind-picker">
      <button
        type="button"
        className="viz-kind-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Post it as a comment or as a question"
        onClick={() => setOpen(!open)}
      >
        {NOTE_KIND_LABELS[kind]}
        <UiIcon name="down" size={12} />
      </button>
      {open && (
        <span className="viz-kind-menu" role="listbox" aria-label="Kind">
          {(["comment", "question"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === kind}
              className="viz-kind-option"
              onClick={() => {
                onKind(option);
                setOpen(false);
              }}
            >
              <span className="viz-kind-tick">
                {option === kind && <UiIcon name="check" size={12} />}
              </span>
              {NOTE_KIND_LABELS[option]}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function mentionAt(value: string, caret: number): { start: number; query: string } | undefined {
  const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : undefined;
}

export function Composer({
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
  kind?: NoteKind;
  onKind?(kind: NoteKind): void;
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
  const pick = (target: VizNoteTarget) => {
    const text = textRef.current;
    if (!mention || !text) {
      return;
    }
    const caret = text.selectionStart;
    const label = chipText(target).label;
    const next = `${body.slice(0, mention.start)}@${label} ${body.slice(caret)}`;
    const at = mention.start + label.length + 2;
    setBody(next);
    setMention(undefined);
    mentions.onPick(target);
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
        : `Post ${NOTE_KIND_LABELS[kind ?? "comment"].toLowerCase()}`;
  return (
    <div
      className={`viz-composer viz-composer--${variant} ${disabled ? "viz-composer--disabled" : ""}`}
    >
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
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.nativeEvent.isComposing
          ) {
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
        <div className="viz-mention-menu" role="listbox" aria-label="Parts to link">
          {found.map((target, index) => {
            const text = chipText(target);
            return (
              <button
                key={`${target.kind}:${target.label}`}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`viz-mention-option viz-ctx-chip--${target.kind} ${index === active ? "viz-mention-option--active" : ""}`}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => pick(target)}
              >
                <UiIcon name={TARGET_ICONS[target.kind]} size={13} />
                <span className="viz-ctx-chip__name">{text.label}</span>
                <span className="viz-ctx-chip__info">{TARGET_WORDS[target.kind]}</span>
              </button>
            );
          })}
        </div>
      )}
      {chips && chips.targets.length > 0 && (
        <div className="viz-ctx-row">
          <TargetChips targets={chips.targets} onShow={chips.onShow} onRemove={chips.onRemove} />
        </div>
      )}
      <div className="viz-composer__bar">
        <button
          type="button"
          className="viz-bar-link"
          disabled={disabled}
          title="Link this thread to a part, a member, a frame or a file: click it on the diagram, or type @"
          onClick={onLink}
        >
          <UiIcon name="link" size={13} />
          Link a part…
        </button>
        {kind && onKind && <KindPicker kind={kind} onKind={onKind} />}
        <span className="viz-composer__gap" />
        <button
          type="button"
          className="viz-iconbtn viz-iconbtn--primary viz-send"
          aria-label={submitLabel}
          title={
            variant === "edit"
              ? "Save the change (Enter). Shift+Enter adds a line. Esc cancels."
              : `${submitLabel} (Enter). Shift+Enter adds a line. It is saved in the review and goes to the agent with Send comments.`
          }
          disabled={disabled || !body.trim()}
          onClick={submit}
        >
          <UiIcon name={variant === "edit" ? "check" : "send"} size={13} />
        </button>
      </div>
    </div>
  );
}
