import { stageNumber, type VizIndex } from "../model/index";
import type { VizDoc } from "../model/types";
import { hasChanges } from "../model/review";
import type { UiAction, UiState } from "../model/ui";
import { overviewKind } from "../model/visible";
import type { VizListEntry, VizReviewState, VizWindowState } from "../protocol";
import type { VizDelta } from "../../protocol/viz.js";
import { AgentBar } from "./AgentControls";
import { ChangedFiles } from "./ChangedFiles";
import { DiagramBubble } from "./DiagramBubble";
import { UiIcon, type UiIconName } from "./icons";
import { BarLabel, plural } from "./parts";
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

function Mismatch({ doc, window }: { doc: VizDoc; window: VizWindowState }) {
  if (window.alignment.kind === "aligned") {
    return null;
  }
  return (
    <span className="viz-mismatch" title={compareTitle(doc, window)}>
      <UiIcon name="warn" size={12} />
      Made against {doc.meta.compareLabel ?? "base"}, VS Code is on {window.compareLabel}
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
  const walkDiagrams = new Set(
    index.walkthrough.map((step) =>
      step.stage.kind === "overview" ? "overview" : `flow:${step.stage.flow}`,
    ),
  ).size;
  return (
    <header className="viz-header">
      <div className="viz-changebar">
        <span
          className="viz-changebar__name"
          title={`The changes from ${doc.meta.compareLabel ?? "base"} to the files on disk now, with the changes not yet committed.`}
        >
          <BarLabel>Change</BarLabel>
          <UiIcon name="graph" size={14} />
          <VizTitle doc={doc} vizzes={vizzes} />
        </span>
        <Mismatch doc={doc} window={window} />
        <span className="viz-header__spacer" />
        {index.walkthrough.length > 0 && (
          <button
            type="button"
            className={`viz-action viz-action--walk ${walking ? "viz-action--on" : ""}`}
            title={`A guided tour of this one change, step by step. It moves across ${plural(walkDiagrams, "diagram")}. (w)`}
            aria-pressed={walking}
            onClick={() => dispatch({ type: "walk" })}
          >
            <UiIcon name="play" size={14} />
            <span className="viz-action__label">Walk through this change</span>
            {walkDiagrams > 1 && (
              <span className="viz-action__note">{plural(walkDiagrams, "diagram")}</span>
            )}
          </button>
        )}
      </div>
      <nav className="viz-tabbar viz-tabs" role="tablist" aria-label="Diagrams">
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
      <div className="viz-diagrambar" aria-label="Diagram toolbar">
        <BarLabel title="Tools for the open diagram">Diagram toolbar</BarLabel>
        {open ? (
          <span className="viz-diagrambar__about">
            {plural(open.steps.length, "step")} · {plural(open.participants.length, "participant")}
            <span className={`viz-diagrambar__change viz-diagrambar__change--${open.delta}`}>
              {CHANGE_WORD[open.delta]}
            </span>
          </span>
        ) : (
          !walking &&
          hasChanges(index, review.files) && (
            <ChangedFiles
              index={index}
              ui={ui}
              review={review}
              dispatch={dispatch}
              onNext={onNext}
            />
          )
        )}
        <span className="viz-diagrambar__sep" aria-hidden />
        <DiagramBubble ui={ui} review={review} dispatch={dispatch} />
        <span className="viz-header__spacer" />
        <button
          type="button"
          className="viz-action viz-action--copy"
          title="Copy the open diagram as Mermaid text (e)"
          onClick={onExport}
        >
          <UiIcon name="copy" size={14} />
          <span className="viz-action__label">Copy as Mermaid</span>
        </button>
      </div>
      <AgentBar review={review} />
    </header>
  );
}
