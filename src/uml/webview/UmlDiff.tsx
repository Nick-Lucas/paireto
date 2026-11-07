import ELK from "elkjs/lib/elk.bundled.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import {
  applyFocus,
  focusCount,
  FOCI,
  LAYOUTS,
  type FocusedView,
  type ReviewFilters,
  type ReviewFocus,
} from "../core/focus";
import { hotspots, type Hotspot } from "../core/hotspots";
import { layoutDiagram, type DiagramLayout } from "../core/layout";
import { nextChange, type ChangeStop } from "../core/nextChange";
import { panelWidth } from "../core/panel";
import type {
  LineCounts,
  UmlComment,
  UmlFile,
  UmlModel,
  UmlRelation,
  UmlType,
} from "../core/model";
import {
  DEFAULT_VIEW_STATE,
  type HostMessage,
  type UmlViewState,
  type WebviewMessage,
} from "../core/protocol";
import { Diagram } from "./Diagram";
import type { Draft } from "./notes";
import { Icon } from "./icons";
import { createMeasure } from "./measure";
import {
  KIND_WORDS,
  MEMBER_CHANGE_WORDS,
  RELATION_WORDS,
  TYPE_CHANGE_WORDS,
  memberGlyph,
  sameTarget,
  type Target,
  targetKey,
} from "./targets";

interface VsCodeApi {
  postMessage(msg: WebviewMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const elk = new ELK();
const TOAST_MS = 7000;

function layoutKey(
  view: FocusedView,
  mode: string,
  overview: boolean,
  comments: readonly UmlComment[],
): string {
  return JSON.stringify([
    mode,
    overview,
    comments.map((c) => [
      c.id,
      c.kind,
      c.body,
      c.replies,
      c.sent,
      c.unread,
      c.waiting,
      c.links,
      c.place,
    ]),
    view.types.map((t) => [
      t.type.id,
      t.role,
      t.type.name,
      t.type.kind,
      t.type.change,
      t.type.counts,
      t.type.openThreads,
      t.members.map((m) => [m.id, m.short, m.change, m.counts]),
      t.hidden,
    ]),
    view.relations.map((r) => [r.id, r.change, r.multiplicity]),
  ]);
}

function withReadSnapshot(
  model: UmlModel,
  snapshot: ReadonlyMap<string, boolean> | undefined,
): UmlModel {
  if (!snapshot) {
    return model;
  }
  return {
    ...model,
    files: model.files.map((file) =>
      snapshot.has(file.key) ? { ...file, read: snapshot.get(file.key) as boolean } : file,
    ),
  };
}

function snapshotOf(model: UmlModel | undefined): Map<string, boolean> | undefined {
  return model ? new Map(model.files.map((f) => [f.key, f.read])) : undefined;
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="counts">
      <span className="c-added">+{added.toLocaleString()}</span>
      <span className="c-sep"> / </span>
      <span className="c-removed">
        {"−"}
        {removed.toLocaleString()}
      </span>
    </span>
  );
}

function ToolbarMenu({
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
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const classes = ["tb-dd", active && "is-on", open && "is-open"].filter(Boolean).join(" ");
  return (
    <div className="tb-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={classes}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        <span className="tb-dd-text">
          <span className="tb-dd-caption">{caption}</span>
          <span className="tb-dd-value">
            {value}
            {count !== undefined && <span className="tb-dd-count"> · {count}</span>}
          </span>
        </span>
        <Icon name="down" />
      </button>
      {open && (
        <div
          className="tb-pop"
          role="dialog"
          aria-label={caption}
          onClick={(event) => {
            if (event.target instanceof HTMLInputElement && event.target.type === "radio") {
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
        >
          <div className="tb-pop-head">{caption}</div>
          {children}
        </div>
      )}
    </div>
  );
}

function TbOption({
  type,
  name,
  checked,
  icon,
  label,
  count,
  note,
  disabled,
  onChange,
}: {
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  icon?: ReactNode;
  label: string;
  count?: number;
  note: string;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className={disabled ? "tb-option is-disabled" : "tb-option"}>
      <input
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => type === "checkbox" && onChange(event.target.checked)}
        onClick={() => type === "radio" && onChange(true)}
      />
      <span>
        <span className="tb-option-name">
          {icon}
          {label}
          {count !== undefined && <span className="tb-count">{count}</span>}
        </span>
        <span className="tb-option-note">{note}</span>
      </span>
    </label>
  );
}

function filterValue(filters: ReviewFilters): string {
  if (filters.notSeen && filters.openThreads) {
    return "2 on";
  }
  return filters.notSeen ? "Not seen" : filters.openThreads ? "Open threads" : "None";
}

function GraphToolbar({
  focus,
  counts,
  filters,
  notSeenCount,
  threadCount,
  layout,
  find,
  findRef,
  onFocus,
  onFilters,
  onLayout,
  onFind,
  onFindSubmit,
}: {
  focus: ReviewFocus;
  counts: Record<ReviewFocus, number>;
  filters: ReviewFilters;
  notSeenCount: number;
  threadCount: number;
  layout: UmlViewState["layout"];
  find: string;
  findRef: RefObject<HTMLInputElement | null>;
  onFocus(focus: ReviewFocus): void;
  onFilters(filters: Partial<ReviewFilters>): void;
  onLayout(layout: UmlViewState["layout"]): void;
  onFind(text: string): void;
  onFindSubmit(): void;
}) {
  const focusInfo = FOCI.find((f) => f.id === focus) ?? FOCI[0];
  const layoutInfo = LAYOUTS.find((l) => l.id === layout) ?? LAYOUTS[0];
  const filtered = filters.notSeen || filters.openThreads;
  const barRef = useRef<HTMLDivElement>(null);
  const fit = useCallback(() => {
    const bar = barRef.current;
    if (!bar) {
      return;
    }
    const overflows = () => bar.scrollWidth > bar.clientWidth + 1;
    bar.classList.remove("is-compact", "is-stacked");
    if (overflows()) {
      bar.classList.add("is-compact");
      bar.classList.toggle("is-stacked", overflows());
    }
  }, []);
  useLayoutEffect(fit);
  useEffect(() => {
    const area = barRef.current?.parentElement;
    if (!area) {
      return;
    }
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    return () => observer.disconnect();
  }, [fit]);
  return (
    <div ref={barRef} className="graph-toolbar" role="toolbar" aria-label="Diagram settings">
      <ToolbarMenu
        icon={<Icon name="eye" />}
        caption="Show"
        value={focusInfo.label}
        count={counts[focus]}
        title={`Show: ${focusInfo.description}`}
      >
        {FOCI.map((info) => (
          <TbOption
            key={info.id}
            type="radio"
            name="uml-focus"
            checked={info.id === focus}
            label={info.label}
            count={counts[info.id]}
            note={info.description}
            disabled={counts[info.id] === 0 && info.id !== focus}
            onChange={() => onFocus(info.id)}
          />
        ))}
      </ToolbarMenu>
      <span className="tb-dot" aria-hidden />
      <ToolbarMenu
        icon={<Icon name="filter" />}
        caption="Filter"
        value={filterValue(filters)}
        active={filtered}
        title="Filter: show only some types"
      >
        <>
          <TbOption
            type="checkbox"
            name="uml-not-seen"
            checked={filters.notSeen}
            icon={<span className="dot" aria-hidden />}
            label="Not seen"
            count={notSeenCount}
            note="Hide files you marked seen. A file you mark seen stays until you change this."
            onChange={(notSeen) => onFilters({ notSeen })}
          />
          <TbOption
            type="checkbox"
            name="uml-open-threads"
            checked={filters.openThreads}
            icon={<Icon name="comment" />}
            label="Open threads"
            count={threadCount}
            note="Types with review comments not yet resolved."
            onChange={(openThreads) => onFilters({ openThreads })}
          />
          {filtered && (
            <button
              type="button"
              className="text-button tb-clear"
              onClick={() => onFilters({ notSeen: false, openThreads: false })}
            >
              Clear filters
            </button>
          )}
        </>
      </ToolbarMenu>
      <span className="tb-dot" aria-hidden />
      <ToolbarMenu
        icon={<Icon name={layout === "folders" ? "folder" : "group"} />}
        caption="View"
        value={layoutInfo.label}
        title={`View: ${layoutInfo.description}`}
      >
        {LAYOUTS.map((info) => (
          <TbOption
            key={info.id}
            type="radio"
            name="uml-layout"
            checked={info.id === layout}
            icon={<Icon name={info.id === "folders" ? "folder" : "group"} />}
            label={info.label}
            note={info.description}
            onChange={() => onLayout(info.id)}
          />
        ))}
      </ToolbarMenu>
      <div className="tb-end">
        <span className="tb-line" aria-hidden />
        <label className="tb-find" title="Type part of a class or file name, then press Enter (/)">
          <Icon name="search" />
          <input
            ref={findRef}
            type="search"
            aria-label="Find type"
            placeholder="Find"
            value={find}
            onChange={(event) => onFind(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onFindSubmit();
              } else if (event.key === "Escape") {
                onFind("");
                event.currentTarget.blur();
              }
            }}
          />
          <kbd>/</kbd>
        </label>
      </div>
    </div>
  );
}

const TYPE_LETTERS: Record<UmlType["change"], string> = {
  added: "A",
  removed: "D",
  modified: "M",
  unchanged: "U",
};

const PANEL_STEP = 16;

function ChangeBar({ share, counts, size }: { share: number; counts: LineCounts; size: number }) {
  return (
    <span className="change-bar" aria-hidden>
      <span className="change-fill" style={{ width: `${share * 100}%` }}>
        <span
          className="change-fill-removed"
          style={{ width: `${size > 0 ? (counts.removed / size) * 100 : 0}%` }}
        />
      </span>
    </span>
  );
}

interface ReviewState {
  seen: number;
  total: number;
  lines: LineCounts;
  step?: ChangeStop;
  onNext(): void;
  onReset(): void;
}

const NEXT_CHANGE_TITLE =
  "Select the next change in this file. After the last one, mark the file seen and go to the next file not seen, in the order of this list (N)";

function SeenProgress({ seen, total }: { seen: number; total: number }) {
  return (
    <span className="seen-progress" aria-hidden>
      <span style={{ width: `${(100 * seen) / Math.max(1, total)}%` }} />
    </span>
  );
}

function ChangesPanel({
  spots,
  width,
  room,
  files,
  selection,
  review,
  onWidth,
  onCollapse,
  onPick,
  onOpen,
}: {
  spots: readonly Hotspot[];
  width: number;
  room(): number;
  files: ReadonlyMap<string, UmlFile>;
  selection?: Target;
  review: ReviewState;
  onWidth(width: number): void;
  onCollapse(): void;
  onPick(target: Target): void;
  onOpen(target: Target): void;
}) {
  const { step } = review;
  const stepTag = (
    <span
      className="step-tag"
      title={`Change ${(step?.index ?? 0) + 1} of ${step?.count ?? 0} in this file`}
    >
      {(step?.index ?? 0) + 1} of {step?.count ?? 0}
    </span>
  );
  const stepAt = (spot: Hotspot, memberId?: string) =>
    !!step &&
    step.count > 0 &&
    step.typeId === spot.typeId &&
    (memberId
      ? step.memberId === memberId
      : !spot.members.some((m) => m.memberId === step.memberId));
  const listRef = useRef<HTMLOListElement>(null);
  const dragRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const [dragWidth, setDragWidth] = useState<number | undefined>();
  const shown = panelWidth(dragWidth ?? width, room());
  const selectedKey = selection ? targetKey(selection) : undefined;
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".is-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);
  const row = (target: Target, className: string, title: string, children: ReactNode) => (
    <button
      type="button"
      className={sameTarget(selection, target) ? `${className} is-selected` : className}
      title={title}
      onClick={() => onPick(target)}
      onDoubleClick={() => onOpen(target)}
    >
      {children}
    </button>
  );
  const typeRow = (spot: Hotspot, className: string) =>
    row(
      { kind: "type", typeId: spot.typeId },
      files.get(spot.fileKey)?.read ? `${className} is-seen` : className,
      `${spot.name}: ${spot.counts.added} lines added, ${spot.counts.removed} removed. Click to go to it, double-click to open its diff.`,
      <>
        <span className={`badge-sample badge-${spot.change}`}>{TYPE_LETTERS[spot.change]}</span>
        <span className="change-title">
          <span className="change-name">{spot.name}</span>
          {files.get(spot.fileKey)?.read ? (
            <span className="seen-mark" aria-label="Seen">
              <Icon name="check" />
            </span>
          ) : (
            <span className="dot" aria-label="Not seen" />
          )}
          {stepAt(spot) && stepTag}
        </span>
        <span className="change-counts">
          <Counts added={spot.counts.added} removed={spot.counts.removed} />
        </span>
        {className === "change-row" && (
          <ChangeBar share={spot.share} counts={spot.counts} size={spot.size} />
        )}
      </>,
    );
  const resize = (next: number) => onWidth(panelWidth(next, room()));
  return (
    <aside className="changes-panel" aria-label="Where the changes are" style={{ width: shown }}>
      <div
        className={dragWidth === undefined ? "changes-resize" : "changes-resize is-dragging"}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the changes list"
        aria-valuenow={shown}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, width: shown };
          setDragWidth(shown);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag) {
            setDragWidth(panelWidth(drag.width + drag.x - event.clientX, room()));
          }
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = undefined;
          if (dragWidth !== undefined) {
            resize(dragWidth);
          }
          setDragWidth(undefined);
        }}
        onDoubleClick={() => resize(DEFAULT_VIEW_STATE.changesWidth)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            resize(shown + (event.key === "ArrowLeft" ? PANEL_STEP : -PANEL_STEP));
          }
        }}
      />
      <header className="changes-head">
        <span className="field-label">Where the changes are</span>
        <button
          type="button"
          className="icon-button"
          title="Hide the changes list"
          aria-label="Hide the changes list"
          onClick={onCollapse}
        >
          <Icon name="right" />
        </button>
      </header>
      <div className="changes-review">
        <div
          className="review-progress"
          title={`${review.seen} of ${review.total} changed files are marked seen, ${review.lines.added} lines added and ${review.lines.removed} removed. Next change marks a file seen after its last change.`}
        >
          <SeenProgress seen={review.seen} total={review.total} />
          <span>
            <strong>
              {review.seen} of {review.total}
            </strong>{" "}
            {review.total === 1 ? "file" : "files"} seen
          </span>
        </div>
        <div className="review-actions">
          <button
            type="button"
            className="button next-change"
            title={NEXT_CHANGE_TITLE}
            onClick={review.onNext}
          >
            Next change
            <kbd>N</kbd>
          </button>
          {review.seen > 0 && (
            <button
              type="button"
              className="icon-button"
              title="Start again: mark every file not seen, so you can review from the start"
              aria-label="Start again"
              onClick={review.onReset}
            >
              <Icon name="reset" />
            </button>
          )}
        </div>
      </div>
      {spots.length === 0 && <p className="changes-empty muted">No changes in focus.</p>}
      <ol className="changes-list" ref={listRef}>
        {spots.map((spot) => (
          <li key={spot.typeId}>
            {typeRow(spot, "change-row")}
            {spot.members.length > 0 && (
              <ul className="change-members">
                {spot.members.map((member) => (
                  <li key={member.memberId}>
                    {row(
                      { kind: "member", typeId: spot.typeId, memberId: member.memberId },
                      "change-member",
                      `${member.short}: ${member.counts.added} lines added, ${member.counts.removed} removed`,
                      <>
                        <span className={`badge-sample badge-${member.change}`}>
                          {memberGlyph(member.change)}
                        </span>
                        <span className="change-title">
                          <code className="change-name">{member.short}</code>
                          {stepAt(spot, member.memberId) && stepTag}
                        </span>
                        <span className="change-counts">
                          <Counts added={member.counts.added} removed={member.counts.removed} />
                        </span>
                      </>,
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}

function ChangesRail({
  count,
  review,
  onExpand,
}: {
  count: number;
  review: ReviewState;
  onExpand(): void;
}) {
  return (
    <aside className="changes-rail">
      <button
        type="button"
        className="rail-next"
        title={NEXT_CHANGE_TITLE}
        aria-label="Next change"
        onClick={review.onNext}
      >
        <Icon name="next" />
      </button>
      <span
        className="rail-seen"
        title={`${review.seen} of ${review.total} changed files are marked seen`}
      >
        {review.seen}/{review.total}
        <span className="rail-progress" aria-hidden>
          <span style={{ height: `${(100 * review.seen) / Math.max(1, review.total)}%` }} />
        </span>
      </span>
      <button
        type="button"
        className="changes-rail-button"
        title="Show where the changes are"
        aria-label="Show where the changes are"
        onClick={onExpand}
      >
        <Icon name="left" />
        <span className="changes-rail-label">Where the changes are · {count}</span>
      </button>
    </aside>
  );
}

function Legend({ onClose }: { onClose(): void }) {
  return (
    <div className="legend" role="dialog" aria-label="Legend and keyboard keys">
      <div className="legend-head">
        <strong>Legend</strong>
        <button type="button" className="text-button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="legend-grid">
        <section>
          <h3>Types and members</h3>
          <ul>
            <li>
              <span className="badge-sample badge-added">A</span> Added type or member
            </li>
            <li>
              <span className="badge-sample badge-modified">M</span> Changed type
            </li>
            <li>
              <span className="badge-sample badge-removed">D</span> Removed type or member
            </li>
            <li>
              <span className="badge-sample badge-signature">S</span> Signature changed
            </li>
            <li>
              <span className="badge-sample badge-body">M</span> Body changed, same signature
            </li>
            <li>
              <span className="badge-sample badge-unchanged">U</span> No diff: a related type with
              no change, shown with a dotted outline
            </li>
            <li>
              <span className="badge-sample badge-unchanged">M</span> Outside focus: a related type
              with changes outside this focus, shown grey with a dotted outline
            </li>
          </ul>
        </section>
        <section>
          <h3>Line counts</h3>
          <ul>
            <li>
              <span className="pill-sample">
                <Counts added={12} removed={3} />
              </span>{" "}
              Pill in a header: every changed line inside the whole type, file or folder
            </li>
            <li>
              <span className="row-sample">
                <Counts added={4} removed={1} />
              </span>{" "}
              Number on a row: that member only
            </li>
            <li>Change size is lines added plus lines removed.</li>
          </ul>
          <h3>Review state</h3>
          <ul>
            <li>
              <span className="read-sample" /> File not seen ·{" "}
              <span className="read-sample is-read">✓</span> File seen
            </li>
            <li>
              <span className="thread-sample">
                <Icon name="comment" />
              </span>{" "}
              Open review threads (separate from seen)
            </li>
          </ul>
        </section>
        <section>
          <h3>Relationships</h3>
          <ul className="relations">
            <li>
              <RelationSample dashed={false} head="triangle" /> Generalization (extends)
            </li>
            <li>
              <RelationSample dashed head="triangle" /> Realization (implements)
            </li>
            <li>
              <RelationSample dashed={false} head="arrow" /> Association (field), with multiplicity
            </li>
            <li>
              <RelationSample dashed head="arrow" /> Dependency (parameter or return type)
            </li>
            <li>
              <span className="c-added">Green</span> line: added in this change ·{" "}
              <span className="c-removed">Red</span> line: removed
            </li>
          </ul>
        </section>
        <section>
          <h3>Keys</h3>
          <ul className="keys">
            <li>
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <kbd>←</kbd>
              <kbd>→</kbd> Move between types and members · <kbd>Enter</kbd> Open the diff
            </li>
            <li>
              <kbd>N</kbd> Open the next change in this file; after the last one, mark the file seen
              and go to the next file not seen · <kbd>L</kbd> Fit the selection and its links
            </li>
            <li>
              <kbd>Shift</kbd>+<kbd>↑↓←→</kbd> Pan · <kbd>C</kbd> Centre the selection
            </li>
            <li>
              <kbd>+</kbd> <kbd>−</kbd> Zoom · <kbd>0</kbd> Reset · <kbd>F</kbd> Fit all ·{" "}
              <kbd>Esc</kbd> Clear selection
            </li>
            <li>
              <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + scroll or pinch to zoom. Scroll and drag the background
              to pan.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function RelationSample({ dashed, head }: { dashed: boolean; head: "triangle" | "arrow" }) {
  return (
    <svg className="relation-sample" width="40" height="12" viewBox="0 0 40 12" aria-hidden>
      <line
        x1="1"
        y1="6"
        x2={head === "triangle" ? 28 : 37}
        y2="6"
        strokeDasharray={dashed ? "4 3" : undefined}
      />
      {head === "triangle" ? (
        <path d="M28,1 L38,6 L28,11 Z" className="tri" />
      ) : (
        <path d="M30,2 L38,6 L30,10" className="arr" />
      )}
    </svg>
  );
}

interface LinkRow {
  relation: UmlRelation;
  otherId: string;
  out: boolean;
}

type LinkMenuId = "uses" | "usedBy" | "links";

const KIND_ORDER = ["generalization", "realization", "association", "dependency"];

function linkRows(relations: readonly UmlRelation[], typeId: string, out: boolean): LinkRow[] {
  return relations
    .filter((r) => (out ? r.source === typeId : r.target === typeId) && r.source !== r.target)
    .map((relation) => ({ relation, otherId: out ? relation.target : relation.source, out }));
}

function sortRows(rows: LinkRow[], types: ReadonlyMap<string, UmlType>): LinkRow[] {
  const name = (row: LinkRow) => types.get(row.otherId)?.name ?? row.otherId;
  return [...rows].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.relation.kind) - KIND_ORDER.indexOf(b.relation.kind) ||
      name(a).localeCompare(name(b)),
  );
}

function LinkList({
  title,
  rows,
  types,
  files,
  left,
  onFollow,
  onHover,
  onClose,
}: {
  title: string;
  rows: readonly LinkRow[];
  types: ReadonlyMap<string, UmlType>;
  files: ReadonlyMap<string, UmlFile>;
  left: number;
  onFollow(typeId: string): void;
  onHover(relationId: string | undefined): void;
  onClose(): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>(".link-row")?.focus();
  }, []);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(".link-row") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? at + 1 : at - 1;
      items[(next + items.length) % items.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div
      ref={listRef}
      className="link-list"
      role="dialog"
      aria-label={title}
      style={{ left }}
      onKeyDown={move}
      onPointerLeave={() => onHover(undefined)}
    >
      <div className="link-list-title">{title}</div>
      {rows.map((row) => {
        const other = types.get(row.otherId);
        const file = other ? files.get(other.fileKey) : undefined;
        const word = RELATION_WORDS[row.relation.kind];
        const multiplicity = row.relation.multiplicity ? ` ${row.relation.multiplicity}` : "";
        const via = row.relation.roles.join(", ");
        return (
          <button
            key={row.relation.id}
            type="button"
            className="link-row"
            title={`${row.out ? "" : `${other?.name ?? row.otherId} `}${word}${multiplicity}${row.out ? ` ${other?.name ?? row.otherId}` : " this type"}${via ? ` via ${via}` : ""}${file ? `\n${file.path}` : ""}\nClick to go to ${other?.name ?? row.otherId}.`}
            onPointerEnter={() => onHover(row.relation.id)}
            onFocus={() => onHover(row.relation.id)}
            onClick={() => onFollow(row.otherId)}
          >
            <span className="link-arrow" aria-hidden>
              {row.out ? "→" : "←"}
            </span>
            <span className="link-name">
              {other?.name ?? row.otherId}
              {other?.context && <span className="muted"> unchanged</span>}
            </span>
            <span className="link-rel">
              {row.out ? `${word}${multiplicity}` : `${word}${multiplicity} this`}
              {row.relation.change !== "unchanged" && (
                <span className={`link-change is-${row.relation.change}`}>
                  {row.relation.change === "added" ? " · new link" : " · removed link"}
                </span>
              )}
            </span>
            <code className="link-via">{via}</code>
          </button>
        );
      })}
    </div>
  );
}

function SelectionBar({
  model,
  selection,
  view,
  linkCount,
  legendOpen,
  onRead,
  onLinks,
  onFollow,
  onHoverRelation,
  onLegend,
  onComment,
}: {
  model: UmlModel;
  selection?: Target;
  view?: FocusedView;
  linkCount: number;
  legendOpen: boolean;
  onRead(fileKey: string, read: boolean): void;
  onLinks(): void;
  onFollow(typeId: string): void;
  onHoverRelation(relationId: string | undefined): void;
  onLegend(): void;
  onComment?: () => void;
}) {
  const barRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<{ key: string; id: LinkMenuId; left: number } | undefined>();
  const files = new Map(model.files.map((f) => [f.key, f]));
  const types = new Map(model.types.map((t) => [t.id, t]));
  const type = selection && selection.kind !== "file" ? types.get(selection.typeId) : undefined;
  const member =
    type && selection?.kind === "member"
      ? type.members.find((m) => m.id === selection.memberId)
      : undefined;
  const file: UmlFile | undefined =
    selection?.kind === "file"
      ? files.get(selection.fileKey)
      : type
        ? files.get(type.fileKey)
        : undefined;
  const selectionKey = selection ? targetKey(selection) : "";
  const menus: { id: LinkMenuId; label: string; title: string; rows: LinkRow[] }[] = [];
  if (member && type) {
    const rows = linkRows(model.relations, type.id, true).filter((r) =>
      r.relation.via.includes(member.id),
    );
    menus.push({
      id: "links",
      label: "Links to",
      title: `Types that ${member.name} links to`,
      rows: sortRows(rows, types),
    });
  } else if (type) {
    menus.push(
      {
        id: "uses",
        label: "Uses",
        title: `Types that ${type.name} uses`,
        rows: sortRows(linkRows(model.relations, type.id, true), types),
      },
      {
        id: "usedBy",
        label: "Used by",
        title: `Types that use ${type.name}`,
        rows: sortRows(linkRows(model.relations, type.id, false), types),
      },
    );
  }
  const shown = menu && menu.key === selectionKey ? menus.find((m) => m.id === menu.id) : undefined;

  const close = useCallback(() => {
    setMenu(undefined);
    onHoverRelation(undefined);
  }, [onHoverRelation]);

  useEffect(() => {
    if (!shown) {
      return;
    }
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".link-list, .link-count")) {
        close();
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [shown, close]);

  const toggle = (id: LinkMenuId, button: HTMLButtonElement) => {
    if (shown?.id === id) {
      close();
      return;
    }
    const bar = barRef.current?.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    const width = Math.min(420, (bar?.width ?? 420) - 24);
    const left = Math.max(12, Math.min(at.left - (bar?.left ?? 0), (bar?.width ?? 0) - width - 12));
    setMenu({ key: selectionKey, id, left });
  };

  let body: ReactNode;
  if (member && type) {
    body = (
      <>
        {member.change !== "unchanged" && (
          <span className={`badge-sample badge-${member.change}`}>
            {memberGlyph(member.change)}
          </span>
        )}
        <code
          className="selection-name"
          title={member.previousLabel ? `Before: ${member.previousLabel}` : member.label}
        >
          {type.kind !== "module" && <span className="muted">{type.name}.</span>}
          {member.label}
        </code>
        <span className="fixed">
          {MEMBER_CHANGE_WORDS[member.change]} ·{" "}
          <Counts added={member.counts.added} removed={member.counts.removed} />
        </span>
        {file && (
          <span className="muted path" title={`${file.path}:${member.span.start + 1}`}>
            {file.path}:{member.span.start + 1}
          </span>
        )}
      </>
    );
  } else if (type) {
    body = (
      <>
        {type.change !== "unchanged" && !type.context && (
          <span className={`badge-sample badge-${type.change}`}>
            {type.change === "added" ? "A" : type.change === "removed" ? "D" : "M"}
          </span>
        )}
        <span className="muted fixed">{KIND_WORDS[type.kind]}</span>
        <strong className="selection-name" title={type.name}>
          {type.name}
        </strong>
        <span className="fixed">
          {type.context ? (
            <span className="muted">Unchanged, related to the change</span>
          ) : (
            <>
              {TYPE_CHANGE_WORDS[type.change]} ·{" "}
              <Counts added={type.counts.added} removed={type.counts.removed} />
            </>
          )}
        </span>
        {file && (
          <span className="muted path" title={file.path}>
            {file.path}
          </span>
        )}
      </>
    );
  } else if (file) {
    body = (
      <>
        <Icon name="file" />
        <code className="selection-name" title={file.path}>
          {file.path}
        </code>
        <span className="fixed">
          <Counts added={file.counts.added} removed={file.counts.removed} />
        </span>
      </>
    );
  } else {
    body = (
      <span className="muted selection-note">
        {view?.primaryCount ?? 0} types in focus. Click a member, a type header or a file frame to
        select it. Double-click it, or press Enter, to open its diff beside this panel.
        {model.notes.map((note) => ` ${note}`).join("")}
      </span>
    );
  }
  return (
    <footer ref={barRef} className="selection-bar" aria-live="polite">
      <div className="selection-body">{body}</div>
      {menus.length > 0 && (
        <div className="link-counts">
          {menus.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`link-count${shown?.id === m.id ? " is-open" : ""}`}
              aria-expanded={shown?.id === m.id}
              aria-haspopup="dialog"
              disabled={m.rows.length === 0}
              title={m.rows.length === 0 ? `${m.label}: none` : m.title}
              onClick={(event) => toggle(m.id, event.currentTarget)}
            >
              {m.label} <strong>{m.rows.length}</strong>
              <span className="caret" aria-hidden>
                ▾
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="selection-actions">
        {file && file.status !== "context" && (
          <label
            className="check"
            title="Seen is per file, the same check box as in Changed Files."
          >
            <input
              type="checkbox"
              checked={file.read}
              onChange={(event) => onRead(file.key, event.target.checked)}
            />
            <span>Seen</span>
          </label>
        )}
        {onComment && (
          <button
            type="button"
            className="button secondary"
            title="Add a note on this to the diagram, for the agent. You can also right-click a part of the diagram."
            onClick={onComment}
          >
            <Icon name="comment" /> Comment
          </button>
        )}
        {linkCount > 0 && (
          <button
            type="button"
            className="button secondary"
            title="Fit this type and every type it links to (L)"
            onClick={onLinks}
          >
            Show {linkCount} {linkCount === 1 ? "link" : "links"} <kbd>L</kbd>
          </button>
        )}
        <button
          type="button"
          className={legendOpen ? "icon-button is-active" : "icon-button"}
          aria-expanded={legendOpen}
          title="Legend and keys"
          aria-label="Legend and keys"
          onClick={onLegend}
        >
          <Icon name="help" />
        </button>
      </div>
      {shown && menu && (
        <LinkList
          title={shown.title}
          rows={shown.rows}
          types={types}
          files={files}
          left={menu.left}
          onFollow={(typeId) => {
            close();
            onFollow(typeId);
          }}
          onHover={onHoverRelation}
          onClose={close}
        />
      )}
    </footer>
  );
}

export function UmlDiff() {
  const [viewState, setViewState] = useState<UmlViewState>(DEFAULT_VIEW_STATE);
  const [model, setModel] = useState<UmlModel | undefined>();
  const [loading, setLoading] = useState<string | undefined>("Starting…");
  const [error, setError] = useState<string | undefined>();
  const [diagram, setDiagram] = useState<DiagramLayout | undefined>();
  const [layoutError, setLayoutError] = useState<string | undefined>();
  const [selection, setSelection] = useState<Target | undefined>();
  const [fitRequest, setFitRequest] = useState(0);
  const [linksRequest, setLinksRequest] = useState(0);
  const [centerRequest, setCenterRequest] = useState(0);
  const [step, setStep] = useState<ChangeStop | undefined>();
  const [legendOpen, setLegendOpen] = useState(false);
  const [readSnapshot, setReadSnapshot] = useState<Map<string, boolean> | undefined>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [overview, setOverview] = useState(false);
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const [hoverRelation, setHoverRelation] = useState<string | undefined>();
  const [toast, setToast] = useState<string | undefined>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [noteRequest, setNoteRequest] = useState(0);
  const measure = useMemo(() => createMeasure(), []);
  const mainRef = useRef<HTMLDivElement>(null);
  const mainAreaRef = useRef<HTMLElement>(null);
  const lastKey = useRef<string | undefined>(undefined);
  const lastView = useRef<string | undefined>(undefined);
  const layoutSeq = useRef(0);
  const modelRef = useRef<UmlModel | undefined>(undefined);
  const notSeenRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    toastTimer.current = setTimeout(() => setToast(undefined), TOAST_MS);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case "init":
          notSeenRef.current = msg.state.filters.notSeen;
          setViewState(msg.state);
          return;
        case "loading":
          setLoading(msg.message);
          return;
        case "model":
          modelRef.current = msg.model;
          setReadSnapshot(
            (prev) => prev ?? (notSeenRef.current ? snapshotOf(msg.model) : undefined),
          );
          setModel(msg.model);
          setLoading(undefined);
          setError(undefined);
          return;
        case "error":
          setError(msg.message);
          setLoading(undefined);
          return;
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const layoutModel = useMemo(
    () => (model ? withReadSnapshot(model, readSnapshot) : undefined),
    [model, readSnapshot],
  );

  const view = useMemo(
    () =>
      layoutModel
        ? applyFocus(layoutModel, viewState.focus, {
            filters: viewState.filters,
            expanded,
          })
        : undefined,
    [layoutModel, viewState.focus, viewState.filters, expanded],
  );

  const focusCounts = useMemo(() => {
    const counts = {} as Record<ReviewFocus, number>;
    for (const focus of FOCI) {
      counts[focus.id] = model ? focusCount(model, focus.id) : 0;
    }
    return counts;
  }, [model]);

  useEffect(() => {
    if (!view || !layoutModel) {
      return;
    }
    const key = layoutKey(view, viewState.layout, overview, layoutModel.comments);
    if (key === lastKey.current) {
      return;
    }
    lastKey.current = key;
    const viewKey = JSON.stringify([viewState.focus, viewState.layout, viewState.filters]);
    const refit = lastView.current !== viewKey;
    lastView.current = viewKey;
    const seq = ++layoutSeq.current;
    const main = mainRef.current;
    const aspectRatio =
      main && main.clientHeight > 0
        ? Math.max(0.8, Math.min(3, main.clientWidth / main.clientHeight))
        : 1.6;
    layoutDiagram(
      {
        view,
        files: layoutModel.files,
        mode: viewState.layout,
        aspectRatio,
        repoCount: layoutModel.repoCount,
        overview,
        comments: layoutModel.comments,
      },
      measure,
      elk,
    ).then(
      (result) => {
        if (seq !== layoutSeq.current) {
          return;
        }
        setDiagram(result);
        setLayoutError(undefined);
        if (refit) {
          setFitRequest((n) => n + 1);
        }
      },
      (err: unknown) => {
        if (seq === layoutSeq.current) {
          setLayoutError(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }, [view, layoutModel, viewState, measure, overview]);

  const liveSelection = useMemo(() => {
    if (!selection || !model) {
      return undefined;
    }
    const exists =
      selection.kind === "file"
        ? model.files.some((f) => f.key === selection.fileKey)
        : model.types.some(
            (t) =>
              t.id === selection.typeId &&
              (selection.kind === "type" || t.members.some((m) => m.id === selection.memberId)),
          );
    return exists ? selection : undefined;
  }, [model, selection]);

  const updateView = useCallback((patch: Partial<UmlViewState>) => {
    if (patch.filters) {
      notSeenRef.current = patch.filters.notSeen;
      setReadSnapshot(patch.filters.notSeen ? snapshotOf(modelRef.current) : undefined);
    }
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      vscode.postMessage({ type: "viewState", state: next });
      return next;
    });
  }, []);

  const setFilters = useCallback(
    (patch: Partial<ReviewFilters>) => updateView({ filters: { ...viewState.filters, ...patch } }),
    [updateView, viewState.filters],
  );

  const open = useCallback((target: Target) => {
    if (target.kind === "file") {
      vscode.postMessage({ type: "openFile", fileKey: target.fileKey });
    } else {
      vscode.postMessage({
        type: "open",
        typeId: target.typeId,
        memberId: target.kind === "member" ? target.memberId : undefined,
      });
    }
  }, []);

  const follow = useCallback((typeId: string) => {
    setSelection({ kind: "type", typeId });
    setCenterRequest((n) => n + 1);
  }, []);

  const pick = useCallback((target: Target) => {
    setSelection(target);
    setCenterRequest((n) => n + 1);
  }, []);

  const spots = useMemo(() => (view ? hotspots(view) : []), [view]);
  const files = useMemo(() => new Map((model?.files ?? []).map((f) => [f.key, f])), [model]);

  const setRead = useCallback((fileKey: string, read: boolean) => {
    vscode.postMessage({ type: "setRead", fileKey, read });
  }, []);

  const expand = useCallback((typeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(typeId)) {
        next.delete(typeId);
      } else {
        next.add(typeId);
      }
      return next;
    });
  }, []);

  const nextNotSeen = useCallback(() => {
    if (!model || !view) {
      return;
    }
    const result = nextChange(view, model.files, {
      cursor: step,
      typeId: liveSelection && liveSelection.kind !== "file" ? liveSelection.typeId : undefined,
      memberId: liveSelection?.kind === "member" ? liveSelection.memberId : undefined,
      fileKey: liveSelection?.kind === "file" ? liveSelection.fileKey : undefined,
    });
    if (result.seen) {
      setRead(result.seen, true);
    }
    const stop = result.stop;
    setStep(stop);
    if (!stop) {
      setSelection(undefined);
      showToast("Every type in focus is seen.");
      return;
    }
    setSelection(
      stop.typeId && stop.memberId
        ? { kind: "member", typeId: stop.typeId, memberId: stop.memberId }
        : stop.typeId
          ? { kind: "type", typeId: stop.typeId }
          : { kind: "file", fileKey: stop.fileKey },
    );
    setCenterRequest((n) => n + 1);
  }, [model, view, step, liveSelection, setRead, showToast]);

  const findType = useCallback(() => {
    const text = find.trim().toLowerCase();
    const hit = view?.types.find((t) => t.type.name.toLowerCase().includes(text));
    if (text && hit) {
      follow(hit.type.id);
    }
  }, [find, view, follow]);

  const linkCount = useMemo(() => {
    const typeId =
      liveSelection && liveSelection.kind !== "file" ? liveSelection.typeId : undefined;
    if (!typeId || !view) {
      return 0;
    }
    return new Set(
      view.relations.flatMap((r) =>
        r.source === typeId ? [r.target] : r.target === typeId ? [r.source] : [],
      ),
    ).size;
  }, [liveSelection, view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest("input, textarea, select, .draft-note, .thread-popup, .context-menu")
      ) {
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        findRef.current?.focus();
      } else if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        nextNotSeen();
      } else if ((event.key === "l" || event.key === "L") && linkCount > 0) {
        event.preventDefault();
        setLinksRequest((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextNotSeen, linkCount]);

  const onOverview = useCallback((value: boolean) => setOverview(value), []);

  const focusInfo = FOCI.find((f) => f.id === viewState.focus) ?? FOCI[0];
  const changedFiles = model?.files.filter((f) => f.status !== "context") ?? [];
  const seenFiles = changedFiles.filter((f) => f.read).length;
  const total = changedFiles.reduce(
    (sum, f) => ({ added: sum.added + f.counts.added, removed: sum.removed + f.counts.removed }),
    { added: 0, removed: 0 },
  );
  const review: ReviewState = {
    seen: seenFiles,
    total: changedFiles.length,
    lines: total,
    step,
    onNext: nextNotSeen,
    onReset: () => {
      setStep(undefined);
      vscode.postMessage({ type: "resetReview" });
    },
  };
  const notSeenCount =
    model?.types.filter(
      (t) =>
        !t.context &&
        t.change !== "unchanged" &&
        !model.files.find((f) => f.key === t.fileKey)?.read,
    ).length ?? 0;
  const threadCount = model?.types.filter((t) => !t.context && t.openThreads > 0).length ?? 0;
  const filterWords = [
    viewState.filters.notSeen ? "Not seen only." : "",
    viewState.filters.openThreads ? "Open threads only." : "",
  ].filter(Boolean);

  let content: ReactNode;
  if (error) {
    content = (
      <div className="state">
        <p>The diagram could not be built.</p>
        <p className="muted">{error}</p>
        <button
          type="button"
          className="button"
          onClick={() => vscode.postMessage({ type: "refresh" })}
        >
          Try again
        </button>
      </div>
    );
  } else if (!model) {
    content = (
      <div className="state" role="status">
        <p>{loading ?? "Loading…"}</p>
      </div>
    );
  } else if (changedFiles.length === 0) {
    content = (
      <div className="state">
        <p>No changes compared with {model.comparison}.</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => vscode.postMessage({ type: "pickCompareTo" })}
        >
          Compare to another ref…
        </button>
      </div>
    );
  } else if (view && view.types.length === 0) {
    content = (
      <div className="state">
        <p>
          Nothing matches “{focusInfo.label}”{filterWords.length > 0 ? " with these filters" : ""}.
        </p>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            updateView({ focus: "all", filters: { notSeen: false, openThreads: false } })
          }
        >
          Show all changes
        </button>
      </div>
    );
  } else if (layoutError) {
    content = (
      <div className="state">
        <p>The layout failed.</p>
        <p className="muted">{layoutError}</p>
      </div>
    );
  } else if (diagram && layoutModel) {
    content = (
      <Diagram
        layout={diagram}
        model={model}
        measure={measure}
        selection={liveSelection}
        fitRequest={fitRequest}
        linksRequest={linksRequest}
        centerRequest={centerRequest}
        find={find.trim()}
        hoverRelation={hoverRelation}
        onSelect={setSelection}
        onOpen={open}
        onFollow={follow}
        onExpand={expand}
        onOverview={onOverview}
        draft={draft}
        noteRequest={noteRequest}
        onDraft={setDraft}
        onAddComment={(added, body) => {
          if (added.id) {
            vscode.postMessage({
              type: "editComment",
              id: added.id,
              kind: added.kind,
              body,
              links: added.links,
            });
          } else {
            vscode.postMessage({ type: "addComment", kind: added.kind, body, links: added.links });
          }
          setDraft(undefined);
          showToast(
            added.id
              ? "Note saved. It goes to the agent with Send Feedback."
              : "Note added to the diagram. It goes to the agent with Send Feedback.",
          );
        }}
        onOpenComment={(id) => vscode.postMessage({ type: "openComment", id })}
        onResolveComment={(id) => vscode.postMessage({ type: "resolveComment", id })}
        onLinkComment={(id, link) => vscode.postMessage({ type: "linkComment", id, link })}
        onUnlinkComment={(id, index) => vscode.postMessage({ type: "unlinkComment", id, index })}
        onMoveComment={(id, place) => vscode.postMessage({ type: "moveComment", id, place })}
        onReplyComment={(id, body) => {
          vscode.postMessage({ type: "replyComment", id, body });
          showToast("Reply saved. It goes to the agent with Send Feedback.");
        }}
        onReadComment={(id) => vscode.postMessage({ type: "readComment", id })}
      />
    );
  } else {
    content = (
      <div className="state" role="status">
        <p>Placing boxes…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-row">
          <button
            type="button"
            className="comparison"
            title="The diagram shows what changed between the working tree and this branch or commit. Click to choose another."
            onClick={() => vscode.postMessage({ type: "pickCompareTo" })}
          >
            <Icon name="compare" />
            <span>
              Working tree <span className="muted">vs</span>{" "}
              <strong>{model?.comparison ?? "…"}</strong>
            </span>
            <Icon name="down" />
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="icon-button refresh-button"
            title="Reload symbols and relayout"
            aria-label="Reload symbols and relayout"
            onClick={() => vscode.postMessage({ type: "refresh" })}
          >
            <Icon name="refresh" />
          </button>
        </div>
        {overview && (
          <p className="hint" aria-live="polite">
            Boxes show their headers only. Zoom in to see their members.
          </p>
        )}
        {loading && model && <div className="progress" role="progressbar" aria-label={loading} />}
      </header>
      <main className="main" ref={mainAreaRef}>
        <div className="canvas-area" ref={mainRef}>
          {content}
          {model && (
            <GraphToolbar
              focus={viewState.focus}
              counts={focusCounts}
              filters={viewState.filters}
              notSeenCount={notSeenCount}
              threadCount={threadCount}
              layout={viewState.layout}
              find={find}
              findRef={findRef}
              onFocus={(focus) => updateView({ focus })}
              onFilters={setFilters}
              onLayout={(layout) => updateView({ layout })}
              onFind={setFind}
              onFindSubmit={findType}
            />
          )}
          {legendOpen && <Legend onClose={() => setLegendOpen(false)} />}
        </div>
        {model &&
          changedFiles.length > 0 &&
          (viewState.changes ? (
            <ChangesPanel
              spots={spots}
              width={viewState.changesWidth}
              room={() => mainAreaRef.current?.clientWidth ?? window.innerWidth}
              files={files}
              selection={liveSelection}
              review={review}
              onWidth={(changesWidth) => updateView({ changesWidth })}
              onCollapse={() => updateView({ changes: false })}
              onPick={pick}
              onOpen={open}
            />
          ) : (
            <ChangesRail
              count={spots.length}
              review={review}
              onExpand={() => updateView({ changes: true })}
            />
          ))}
      </main>
      {model && (
        <SelectionBar
          model={model}
          selection={liveSelection}
          view={view}
          linkCount={linkCount}
          legendOpen={legendOpen}
          onRead={setRead}
          onLinks={() => setLinksRequest((n) => n + 1)}
          onFollow={follow}
          onHoverRelation={setHoverRelation}
          onLegend={() => setLegendOpen((v) => !v)}
          onComment={() => setNoteRequest((n) => n + 1)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Icon name="help" />
          <span>{toast}</span>
          <button type="button" className="text-button" onClick={() => setToast(undefined)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
