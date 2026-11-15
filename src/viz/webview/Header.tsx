import { stageNumber, type VizIndex } from "../model/index";
import type { VizDoc } from "../model/types";
import type { UiAction, UiState } from "../model/ui";
import type { VizListEntry, VizReviewState, VizWindowState } from "../protocol";
import { DELTA_GLYPH } from "../model/delta";
import { UiIcon } from "./icons";
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
}

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

export function Header({
  doc,
  index,
  ui,
  window,
  vizzes,
  review,
  dispatch,
  onExport,
}: HeaderProps) {
  const current = stageNumber(index, ui.stage);
  const { feedback } = review;
  return (
    <header className="viz-header">
      <div className="viz-header__row">
        <h1 className="viz-header__title" title={doc.viz.summary}>
          {doc.viz.title}
        </h1>
        <span className="viz-compare" title={compareTitle(doc, window)}>
          <UiIcon name="compare" size={14} />
          <span className="viz-compare__label">
            Working tree <span className="viz-muted">vs</span> {doc.meta.compareLabel ?? "base"}
          </span>
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
            <button
              type="button"
              className="viz-textbtn"
              onClick={() => vscode.postMessage({ type: "regenerate" })}
            >
              Ask agent to regenerate
            </button>
          </span>
        )}
        {vizzes.length > 1 && (
          <select
            className="viz-select"
            title="Other visualizations"
            value={doc.meta.name}
            onChange={(event) => vscode.postMessage({ type: "switch", name: event.target.value })}
          >
            {vizzes.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.title} ({entry.repoName})
              </option>
            ))}
          </select>
        )}
        <span className="viz-header__spacer" />
        {feedback.waiting && (
          <span className="viz-feedback-state">The agent is waiting for your review</span>
        )}
        {feedback.pending > 0 && (
          <button
            type="button"
            className="viz-btn"
            title="Send the notes that were not sent yet to the agent"
            onClick={() => vscode.postMessage({ type: "gate", action: "sendFeedback" })}
          >
            Send Feedback · {feedback.pending}
          </button>
        )}
        {feedback.waiting && (
          <button
            type="button"
            className={`viz-btn ${feedback.pending > 0 ? "viz-btn--secondary" : ""}`}
            title="Tell the agent the change is good"
            onClick={() => vscode.postMessage({ type: "gate", action: "approve" })}
          >
            Approve
          </button>
        )}
        {index.walkthrough.length > 0 && (
          <button
            type="button"
            className={`viz-btn viz-btn--secondary ${ui.mode.kind === "walk" ? "viz-btn--active" : ""}`}
            title="Walkthrough (w)"
            onClick={() => dispatch({ type: "walk" })}
          >
            <UiIcon name="walk" /> Walkthrough
          </button>
        )}
        <button
          type="button"
          className="viz-iconbtn"
          title="Copy as Mermaid (e)"
          onClick={onExport}
        >
          <UiIcon name="copy" size={15} />
        </button>
        <button
          type="button"
          className={`viz-iconbtn ${ui.help ? "viz-iconbtn--active" : ""}`}
          title="Keyboard help (?)"
          onClick={() => dispatch({ type: "toggleHelp" })}
        >
          <UiIcon name="help" size={15} />
        </button>
        <button
          type="button"
          className={`viz-iconbtn ${ui.sidebar ? "viz-iconbtn--active" : ""}`}
          title="Toggle the sidebar (b)"
          onClick={() => dispatch({ type: "toggleSidebar" })}
        >
          <UiIcon name="sidebar" size={15} />
        </button>
      </div>
      <nav className="viz-tabs" aria-label="Stages">
        <button
          type="button"
          className={`viz-tab ${current === 0 ? "viz-tab--active" : ""}`}
          onClick={() => dispatch({ type: "stageAt", n: 0 })}
        >
          <kbd>0</kbd> Diagram
        </button>
        {index.flows.map((flow, i) => (
          <button
            key={flow.id}
            type="button"
            className={`viz-tab ${current === i + 1 ? "viz-tab--active" : ""}`}
            onClick={() => dispatch({ type: "stageAt", n: i + 1 })}
          >
            <kbd>{i + 1}</kbd> {flow.title}
            <span className={`viz-tab__delta viz-delta--${flow.delta}`}>
              {DELTA_GLYPH[flow.delta]}
            </span>
          </button>
        ))}
        <span className="viz-header__spacer" />
        <p className="viz-summary" title={doc.viz.summary}>
          {doc.viz.summary}
        </p>
      </nav>
    </header>
  );
}
