import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import type { VizIndex } from "../model/index";
import type { UiAction, UiState } from "../model/ui";
import { GROUPINGS, SHOWS, showCounts } from "../model/visible";
import type { VizReviewState } from "../protocol";
import { reviewMarks } from "../model/review";
import { UiIcon } from "./icons";
import "./toolbar.css";

interface ToolbarProps {
  index: VizIndex;
  ui: UiState;
  review: VizReviewState;
  searchRef: RefObject<HTMLInputElement | null>;
  dispatch: (action: UiAction) => void;
}

function Menu({
  icon,
  caption,
  value,
  count,
  active,
  title,
  children,
}: {
  icon: ReactNode;
  caption: string;
  value: string;
  count?: number;
  active?: boolean;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="viz-tb__menu">
      <button
        type="button"
        className={`viz-tb__dd ${open ? "viz-tb__dd--open" : ""} ${active ? "viz-tb__dd--on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="viz-tb__text">
          <span className="viz-tb__caption">{caption}</span>
          <span className="viz-tb__value">{value}</span>
          {count !== undefined && <span className="viz-option__count">· {count}</span>}
        </span>
        <UiIcon name="down" size={12} />
      </button>
      {open && (
        <div className="viz-pop viz-tb__pop" role="group" aria-label={caption}>
          <div className="viz-pop__head">{caption}</div>
          {children}
        </div>
      )}
    </div>
  );
}

function Option({
  type,
  name,
  checked,
  label,
  count,
  note,
  icon,
  disabled,
  onChange,
}: {
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  label: string;
  count?: number;
  note: string;
  icon?: ReactNode;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className={`viz-option ${disabled ? "viz-option--disabled" : ""}`}>
      <input
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="viz-option__name">
          {icon}
          {label}
          {count !== undefined && <span className="viz-option__count">{count}</span>}
        </span>
        <span className="viz-option__note">{note}</span>
      </span>
    </label>
  );
}

function filterValue(filters: UiState["filters"]): string {
  const parts = [
    filters.notSeen ? "Not seen" : "",
    filters.openThreads ? "Open threads" : "",
  ].filter(Boolean);
  return parts.length === 0 ? "None" : parts.join(" + ");
}

export function Toolbar({ index, ui, review, searchRef, dispatch }: ToolbarProps) {
  const counts = showCounts(index);
  const showInfo = SHOWS.find((info) => info.id === ui.show) ?? SHOWS[0];
  const groupingInfo = GROUPINGS.find((info) => info.id === ui.grouping) ?? GROUPINGS[0];
  const filtered = ui.filters.notSeen || ui.filters.openThreads;
  const marks = reviewMarks(index, review);
  const notSeenCount = index.overviewNodes.filter(
    (node) => node.delta !== "unchanged" && !marks.seen.has(node.id),
  ).length;
  const threadCount = marks.threads.size;
  const onOverview = ui.stage.kind === "overview";
  return (
    <div className="viz-tb" role="toolbar" aria-label="Diagram settings">
      {onOverview && (
        <>
          <Menu
            icon={<UiIcon name="eye" size={15} />}
            caption="Show"
            value={showInfo.label}
            count={counts[ui.show]}
            title={`Show: ${showInfo.description}`}
          >
            {SHOWS.map((info) => (
              <Option
                key={info.id}
                type="radio"
                name="viz-show"
                checked={info.id === ui.show}
                label={info.label}
                count={counts[info.id]}
                note={info.description}
                onChange={() => dispatch({ type: "show", show: info.id })}
              />
            ))}
          </Menu>
          <span className="viz-tb__dot" aria-hidden />
          <Menu
            icon={<UiIcon name="filter" size={15} />}
            caption="Filter"
            value={filterValue(ui.filters)}
            active={filtered}
            title="Filter: dim parts that do not match"
          >
            <Option
              type="checkbox"
              name="viz-not-seen"
              checked={ui.filters.notSeen}
              icon={<span className="viz-dot" aria-hidden />}
              label="Not seen"
              count={notSeenCount}
              note="Dim the parts in files you marked seen."
              onChange={(notSeen) => dispatch({ type: "filters", filters: { notSeen } })}
            />
            <Option
              type="checkbox"
              name="viz-open-threads"
              checked={ui.filters.openThreads}
              icon={<UiIcon name="comment" size={13} />}
              label="Open threads"
              count={threadCount}
              note="Keep only the parts with review comments not yet resolved."
              onChange={(openThreads) => dispatch({ type: "filters", filters: { openThreads } })}
            />
            {filtered && (
              <button
                type="button"
                className="viz-textbtn viz-tb__clear"
                onClick={() =>
                  dispatch({ type: "filters", filters: { notSeen: false, openThreads: false } })
                }
              >
                Clear filters
              </button>
            )}
          </Menu>
          <span className="viz-tb__dot" aria-hidden />
          <Menu
            icon={<UiIcon name={ui.grouping === "folders" ? "folder" : "group"} size={15} />}
            caption="View"
            value={groupingInfo.label}
            title={`View: ${groupingInfo.description}`}
          >
            {GROUPINGS.map((info) => (
              <Option
                key={info.id}
                type="radio"
                name="viz-grouping"
                checked={info.id === ui.grouping}
                icon={<UiIcon name={info.id === "folders" ? "folder" : "group"} size={13} />}
                label={info.label}
                note={info.description}
                onChange={() => dispatch({ type: "grouping", grouping: info.id })}
              />
            ))}
          </Menu>
          <span className="viz-tb__line" aria-hidden />
        </>
      )}
      <label className="viz-tb__find" title="Type part of a name, file or step (/)">
        <UiIcon name="search" size={14} />
        <input
          ref={searchRef}
          type="search"
          aria-label="Find"
          placeholder="Find"
          value={ui.query}
          onChange={(event) => dispatch({ type: "query", query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              dispatch({ type: "query", query: "" });
              event.currentTarget.blur();
            }
          }}
        />
        <kbd>/</kbd>
      </label>
    </div>
  );
}
