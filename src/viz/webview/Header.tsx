import { stageNumber, type VizIndex } from "../model/index";
import type { VizDoc } from "../model/types";
import type { UiAction, UiState } from "../model/ui";
import { overviewKind } from "../model/visible";
import type { VizListEntry, VizReviewState, VizWindowState } from "../protocol";
import type { VizDelta } from "../../protocol/viz.js";
import { ChangedFiles } from "./ChangedFiles";
import { UiIcon, type UiIconName } from "./icons";
import { vscode } from "./vscode";
import "./header.css";

interface HeaderProps {
  doc: VizDoc;
  index: VizIndex;
  ui: UiState;
  window: VizWindowState;
  vizzes: VizListEntry[];
  review: VizReviewState;
  dispatch: (action: UiAction) => void;
  onExport: () => void;
  onNext: () => void;
}

const CHANGE_LETTER: Record<VizDelta, string> = {
  added: "A",
  changed: "M",
  removed: "D",
  unchanged: "",
};

const CHANGE_WORD: Record<VizDelta, string> = {
  added: "new",
  changed: "modified",
  removed: "removed",
  unchanged: "unchanged",
};

function compareTitle(doc: VizDoc, window: VizWindowState): string {
  const made = `This viz was made against ${doc.meta.compareLabel ?? "the compare target"}. The window now compares to ${window.compareLabel}.`;
  switch (window.alignment.kind) {
    case "aligned":
      return "The window compares against the same target as this viz.";
    case "available":
      return `${made} Align moves the window to this viz's target.`;
    case "blocked":
      return `${made} ${window.alignment.reason}`;
  }
}

function RowLabel({ icon, children }: { icon: UiIconName; children: string }) {
  return (
    <span className="viz-header__label">
      <UiIcon name={icon} size={14} />
      {children}
    </span>
  );
}

function VizTitle({ doc, vizzes }: { doc: VizDoc; vizzes: VizListEntry[] }) {
  if (vizzes.length < 2) {
    return (
      <h1 className="viz-header__title" title={doc.viz.summary}>
        {doc.viz.title}
      </h1>
    );
  }
  return (
    <div className="viz-header__switch" title={doc.viz.summary}>
      <h1 className="viz-header__title">{doc.viz.title}</h1>
      <UiIcon name="down" size={12} />
      <select
        className="viz-header__select"
        aria-label="Open another visualization"
        value={doc.meta.name}
        onChange={(event) => vscode.postMessage({ type: "switch", name: event.target.value })}
      >
        {vizzes.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.title} ({entry.repoName})
          </option>
        ))}
      </select>
    </div>
  );
}

interface DiagramTabProps {
  active: boolean;
  icon: UiIconName;
  name: string;
  kind: string;
  delta?: VizDelta;
  title: string;
  onClick: () => void;
}

function DiagramTab({ active, icon, name, kind, delta, title, onClick }: DiagramTabProps) {
  const letter = delta ? CHANGE_LETTER[delta] : "";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`viz-tab ${active ? "viz-tab--active" : ""} ${delta ? `viz-tab--${delta}` : ""}`}
      title={title}
      onClick={onClick}
    >
      <UiIcon name={icon} size={14} />
      <span className="viz-tab__name">{name}</span>
      <span className="viz-tab__kind">{kind}</span>
      {letter && <span className="viz-tab__letter">{letter}</span>}
    </button>
  );
}

function Chevron() {
  return (
    <span className="viz-crumbs__sep" aria-hidden>
      <UiIcon name="next" size={12} />
    </span>
  );
}

function agentStatus(waiting: boolean, comments: string, pending: number): string {
  if (waiting) {
    return "Waiting for your review";
  }
  if (pending > 0) {
    return `${comments} not sent yet`;
  }
  return "Not waiting for you";
}

function AgentRow({ review }: { review: VizReviewState }) {
  const { waiting, pending } = review.feedback;
  const comments = `${pending} ${pending === 1 ? "comment" : "comments"}`;
  return (
    <section
      className={`viz-header__row viz-agent ${waiting ? "viz-agent--waiting" : ""}`}
      aria-label="Agent"
    >
      <RowLabel icon="agent">Agent</RowLabel>
      {waiting && <span className="viz-agent__pulse" aria-hidden />}
      <span className="viz-agent__status">{agentStatus(waiting, comments, pending)}</span>
      {waiting && pending > 0 && <span className="viz-agent__notes">· {comments} not sent</span>}
      <span className="viz-header__spacer" />
      <button
        type="button"
        className="viz-tool"
        title="Add a note that asks the agent to make this diagram again. It goes to the agent with Send comments."
        onClick={() => vscode.postMessage({ type: "regenerate" })}
      >
        <UiIcon name="reset" size={14} /> Ask to redraw
      </button>
      {pending > 0 && (
        <button
          type="button"
          className="viz-btn"
          title={`Send ${comments} to the agent`}
          onClick={() => vscode.postMessage({ type: "gate", action: "sendFeedback" })}
        >
          <UiIcon name="send" size={13} /> Send comments · {pending}
        </button>
      )}
      {waiting && (
        <button
          type="button"
          className={`viz-btn ${pending > 0 ? "viz-btn--secondary" : ""}`}
          title="Tell the agent the change is good"
          onClick={() => vscode.postMessage({ type: "gate", action: "approve" })}
        >
          <UiIcon name="check" size={13} /> Approve
        </button>
      )}
    </section>
  );
}

export function Header({
  doc,
  index,
  ui,
  window,
  vizzes,
  review,
  dispatch,
  onExport,
  onNext,
}: HeaderProps) {
  const current = stageNumber(index, ui.stage);
  const walking = ui.mode.kind === "walk";
  const kind = overviewKind(index);
  const open = current > 0 ? index.flows[current - 1] : undefined;
  return (
    <header className="viz-header">
      <div className="viz-tabbar">
        <nav className="viz-tabs" role="tablist" aria-label="Diagrams">
          <DiagramTab
            active={current === 0 && !walking}
            icon="hierarchy"
            name="Overview"
            kind={kind}
            title={`Overview: every changed part and how they connect, as a ${kind} (0)`}
            onClick={() => dispatch({ type: "stageAt", n: 0 })}
          />
          {index.flows.map((flow, i) => (
            <DiagramTab
              key={flow.id}
              active={current === i + 1 && !walking}
              icon="flow"
              name={flow.title}
              kind="sequence diagram"
              delta={flow.delta}
              title={`${flow.title}: one flow, call by call, as a sequence diagram. This flow is ${CHANGE_WORD[flow.delta]}. (${i + 1})`}
              onClick={() => dispatch({ type: "stageAt", n: i + 1 })}
            />
          ))}
        </nav>
        {index.walkthrough.length > 0 && (
          <button
            type="button"
            className={`viz-action viz-action--walk ${walking ? "viz-action--on" : ""}`}
            title="A guided tour through the changes, one step at a time (w)"
            aria-pressed={walking}
            onClick={() => dispatch({ type: "walk" })}
          >
            <UiIcon name="play" size={14} /> Walk through the changes
          </button>
        )}
      </div>
      <div className="viz-crumbs">
        <span className="viz-crumbs__part" title={compareTitle(doc, window)}>
          <UiIcon name="compare" size={14} />
          <VizTitle doc={doc} vizzes={vizzes} />
        </span>
        <Chevron />
        {open ? (
          <>
            <span className="viz-crumbs__part">Sequence diagrams</span>
            <Chevron />
            <span className="viz-crumbs__part viz-crumbs__here">{open.title}</span>
            <span className={`viz-crumbs__change viz-crumbs__change--${open.delta}`}>
              {CHANGE_WORD[open.delta]}
            </span>
          </>
        ) : (
          <>
            <span className="viz-crumbs__part viz-crumbs__here">Overview</span>
            <span className="viz-crumbs__kind">{kind}</span>
            <ChangedFiles
              index={index}
              ui={ui}
              review={review}
              dispatch={dispatch}
              onNext={onNext}
            />
          </>
        )}
        <span className="viz-compare" title={compareTitle(doc, window)}>
          · working tree compared with <strong>{doc.meta.compareLabel ?? "base"}</strong>
        </span>
        {window.alignment.kind !== "aligned" && (
          <span className="viz-mismatch" title={compareTitle(doc, window)}>
            <UiIcon name="warn" size={12} />
            <span>window is on {window.compareLabel}</span>
            {window.alignment.kind === "available" && (
              <button
                type="button"
                className="viz-textbtn"
                onClick={() => vscode.postMessage({ type: "align" })}
              >
                Align
              </button>
            )}
          </span>
        )}
        <span className="viz-header__spacer" />
        <button
          type="button"
          className="viz-action"
          title="Copy the open diagram as Mermaid text (e)"
          onClick={onExport}
        >
          <UiIcon name="copy" size={14} /> Copy this diagram as Mermaid
        </button>
      </div>
      <AgentRow review={review} />
    </header>
  );
}
