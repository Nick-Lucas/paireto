import { useState, type RefObject } from "react";

import type { VizDelta } from "../../protocol/viz";
import type { VizIndex } from "../model/index";
import type { VizDoc } from "../model/types";
import { ALL_DELTAS, type UiAction, type UiState } from "../model/ui";
import type { VizHistoryEntry, VizWindowState } from "../protocol";
import { DELTA_GLYPH, DELTA_LABEL, UiIcon } from "./icons";
import { vscode } from "./vscode";

interface HeaderProps {
  doc: VizDoc;
  index: VizIndex;
  ui: UiState;
  window: VizWindowState;
  history: VizHistoryEntry[];
  searchRef: RefObject<HTMLInputElement | null>;
  dispatch: (action: UiAction) => void;
  onExport: () => void;
}

export function Header({
  doc,
  index,
  ui,
  window,
  history,
  searchRef,
  dispatch,
  onExport,
}: HeaderProps) {
  const [summaryOpen, setSummaryOpen] = useState(true);
  const stage = ui.stage;
  const stageNumber =
    stage.kind === "overview" ? 0 : index.flows.findIndex((flow) => flow.id === stage.flow) + 1;
  return (
    <header className="viz-header">
      <div className="viz-header__top">
        <div className="viz-header__title">
          <h1>{doc.viz.title}</h1>
          <span className="viz-kind-chip viz-kind-chip--level">{doc.viz.level}</span>
          <button
            type="button"
            className="viz-compare"
            title={
              window.aligned
                ? "Compared against this"
                : `This visualization was made against ${doc.meta.compareLabel}; the window now compares to ${window.compareLabel}`
            }
            onClick={() => !window.aligned && vscode.postMessage({ type: "align" })}
          >
            <span className="viz-compare__label">vs {doc.meta.compareLabel}</span>
            {!window.aligned && (
              <span className="viz-compare__mismatch">
                <UiIcon name="warn" size={12} /> window is on {window.compareLabel}. Align
              </span>
            )}
          </button>
        </div>
        <div className="viz-header__tools">
          <div className="viz-search">
            <UiIcon name="search" size={13} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search parts, files, steps  /"
              value={ui.query}
              onChange={(event) => dispatch({ type: "query", query: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
          {history.length > 1 && (
            <select
              className="viz-select"
              title="Earlier visualizations"
              value={doc.meta.id}
              onChange={(event) =>
                vscode.postMessage({ type: "showHistory", id: event.target.value })
              }
            >
              {history.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title} ({entry.repoName})
                </option>
              ))}
            </select>
          )}
          {index.walkthrough.length > 0 && (
            <button
              type="button"
              className={`viz-btn ${ui.mode.kind === "walk" ? "viz-btn--active" : ""}`}
              title="Walkthrough (w)"
              onClick={() => dispatch({ type: "walk" })}
            >
              <UiIcon name="walk" /> Walkthrough
            </button>
          )}
          <button
            type="button"
            className="viz-btn viz-btn--secondary"
            title="Copy as Mermaid (e)"
            onClick={onExport}
          >
            <UiIcon name="copy" /> Export
          </button>
          <button
            type="button"
            className={`viz-iconbtn ${ui.help ? "viz-iconbtn--active" : ""}`}
            title="Keyboard help (?)"
            onClick={() => dispatch({ type: "toggleHelp" })}
          >
            <UiIcon name="help" size={16} />
          </button>
        </div>
      </div>
      <div className={`viz-summary ${summaryOpen ? "" : "viz-summary--closed"}`}>
        <button
          type="button"
          className="viz-summary__toggle"
          onClick={() => setSummaryOpen((open) => !open)}
          title={summaryOpen ? "Hide summary" : "Show summary"}
        >
          <UiIcon name="chevron" size={12} />
        </button>
        <p>{doc.viz.summary}</p>
      </div>
      <div className="viz-header__bottom">
        <nav className="viz-tabs" aria-label="Stages">
          <button
            type="button"
            className={`viz-tab ${stageNumber === 0 ? "viz-tab--active" : ""}`}
            onClick={() => dispatch({ type: "stageAt", n: 0 })}
          >
            <kbd>0</kbd> Overview
          </button>
          {index.flows.map((flow, i) => (
            <button
              key={flow.id}
              type="button"
              className={`viz-tab ${stageNumber === i + 1 ? "viz-tab--active" : ""}`}
              onClick={() => dispatch({ type: "stageAt", n: i + 1 })}
            >
              <kbd>{i + 1}</kbd> {flow.title}
              <span className={`viz-tab__delta viz-delta--${flow.delta}`}>
                {DELTA_GLYPH[flow.delta]}
              </span>
            </button>
          ))}
        </nav>
        <div className="viz-legend" role="group" aria-label="Filter by change">
          {ALL_DELTAS.map((delta: VizDelta) => (
            <button
              key={delta}
              type="button"
              className={`viz-legend__item viz-delta--${delta} ${ui.deltaFilter.has(delta) ? "" : "viz-legend__item--off"}`}
              title={`${ui.deltaFilter.has(delta) ? "Dim" : "Show"} ${DELTA_LABEL[delta].toLowerCase()} parts`}
              onClick={() => dispatch({ type: "toggleDelta", delta })}
            >
              <span className="viz-legend__swatch">{DELTA_GLYPH[delta]}</span>
              {DELTA_LABEL[delta]}
              <span className="viz-legend__count">{index.deltaCounts[delta]}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
