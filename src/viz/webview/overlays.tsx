import type { VizDelta } from "../../protocol/viz";
import type { VizIndex } from "../model/index";
import { KEY_BINDINGS } from "../model/keymap";
import { renderIssue } from "../model/render";
import type { VizIssue } from "../model/types";
import { ALL_DELTAS, type UiAction, type UiState } from "../model/ui";
import { DELTA_GLYPH } from "../model/delta";
import type { VizListEntry } from "../protocol";
import { DELTA_LABEL, UiIcon } from "./icons";
import { ZOOM_KEY_LABEL } from "./platform";
import { vscode } from "./vscode";
import "./overlays.css";

interface OverlayProps {
  index: VizIndex;
  ui: UiState;
  dispatch: (action: UiAction) => void;
}

export function WalkCard({ index, ui, dispatch }: OverlayProps) {
  if (ui.mode.kind !== "walk") {
    return null;
  }
  const step = index.walkthrough[ui.mode.step];
  if (!step) {
    return null;
  }
  const last = ui.mode.step === index.walkthrough.length - 1;
  return (
    <div className="viz-walk" role="dialog" aria-label="Walkthrough">
      <div className="viz-walk__head">
        <span className="viz-walk__counter">
          Step {ui.mode.step + 1} of {index.walkthrough.length}
        </span>
        <button
          type="button"
          className="viz-iconbtn"
          title="Exit walkthrough (esc)"
          onClick={() => dispatch({ type: "escape" })}
        >
          <UiIcon name="close" />
        </button>
      </div>
      <h2>{step.title}</h2>
      <p>{step.body}</p>
      <div className="viz-walk__foot">
        <div className="viz-dots" aria-hidden="true">
          {index.walkthrough.map((_, i) => (
            <span
              key={i}
              className={`viz-walk-dot ${i === step.index ? "viz-walk-dot--on" : i < step.index ? "viz-walk-dot--done" : ""}`}
            />
          ))}
        </div>
        <div className="viz-walk__nav">
          <button
            type="button"
            className="viz-btn viz-btn--secondary"
            disabled={ui.mode.step === 0}
            onClick={() => dispatch({ type: "prev" })}
          >
            <UiIcon name="prev" size={12} /> Back
          </button>
          <button type="button" className="viz-btn" onClick={() => dispatch({ type: "next" })}>
            {last ? "Done" : "Next"} {!last && <UiIcon name="next" size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PlayBar({ index, ui, dispatch }: OverlayProps) {
  if (ui.stage.kind !== "flow") {
    return null;
  }
  const flow = index.flowById.get(ui.stage.flow);
  if (!flow) {
    return null;
  }
  const playing = ui.mode.kind === "play" ? ui.mode : undefined;
  const step = playing ? flow.steps[playing.step] : undefined;
  return (
    <div className={`viz-playbar ${playing ? "viz-playbar--on" : ""}`}>
      <button
        type="button"
        className="viz-iconbtn"
        title="Previous step (←)"
        disabled={!playing || playing.step === 0}
        onClick={() => dispatch({ type: "prev" })}
      >
        <UiIcon name="prev" />
      </button>
      <button
        type="button"
        className="viz-iconbtn viz-iconbtn--primary"
        title={playing?.running ? "Pause (space)" : "Play (space)"}
        onClick={() => dispatch({ type: "playToggle" })}
      >
        <UiIcon name={playing?.running ? "pause" : "play"} />
      </button>
      <button
        type="button"
        className="viz-iconbtn"
        title="Next step (→)"
        disabled={!playing || playing.step >= flow.steps.length - 1}
        onClick={() => dispatch({ type: "next" })}
      >
        <UiIcon name="next" />
      </button>
      <span className="viz-playbar__counter">
        {playing ? `${playing.step + 1} / ${flow.steps.length}` : `${flow.steps.length} steps`}
      </span>
      {step && <span className="viz-playbar__label">{step.label}</span>}
      {playing && (
        <button
          type="button"
          className="viz-iconbtn"
          title="Stop (esc)"
          onClick={() => dispatch({ type: "escape" })}
        >
          <UiIcon name="close" />
        </button>
      )}
    </div>
  );
}

export function Legend({ index, ui, dispatch }: OverlayProps) {
  return (
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
  );
}

export function HelpOverlay({ ui, dispatch }: Pick<OverlayProps, "ui" | "dispatch">) {
  if (!ui.help) {
    return null;
  }
  return (
    <div className="viz-scrim" onClick={() => dispatch({ type: "toggleHelp" })}>
      <div
        className="viz-help"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="viz-walk__head">
          <h2>Keyboard</h2>
          <button
            type="button"
            className="viz-iconbtn"
            title="Close (esc)"
            onClick={() => dispatch({ type: "toggleHelp" })}
          >
            <UiIcon name="close" />
          </button>
        </div>
        <dl className="viz-help__list">
          {KEY_BINDINGS.map((binding) => (
            <div key={binding.display} className="viz-help__row">
              <dt>
                <kbd>{binding.display}</kbd>
              </dt>
              <dd>{binding.label}</dd>
            </div>
          ))}
        </dl>
        <p className="viz-help__hint">
          Scroll or drag to pan. Pinch or hold {ZOOM_KEY_LABEL} and scroll to zoom. Click a part, a
          member, a link or a step to inspect it. Right-click to add a comment.
        </p>
      </div>
    </div>
  );
}

export function InvalidBanner({ name, issues }: { name: string; issues: VizIssue[] }) {
  const errors = issues.filter((issue) => issue.severity === "error");
  return (
    <div className="viz-banner" role="alert">
      <UiIcon name="warn" size={14} />
      <div className="viz-banner__text">
        <strong>
          {name}.viz.json has {errors.length} error{errors.length === 1 ? "" : "s"}.
        </strong>{" "}
        The last good version stays on screen.
        <ul>
          {errors.slice(0, 5).map((issue, i) => (
            <li key={i}>{renderIssue(issue)}</li>
          ))}
          {errors.length > 5 && <li>+{errors.length - 5} more</li>}
        </ul>
      </div>
    </div>
  );
}

export function EmptyState({ error, vizzes }: { error?: string; vizzes?: VizListEntry[] }) {
  return (
    <div className="viz-empty">
      <div className="viz-empty__art" aria-hidden="true">
        <span className="viz-empty__box viz-empty__box--a" />
        <span className="viz-empty__box viz-empty__box--b" />
        <span className="viz-empty__box viz-empty__box--c" />
      </div>
      {error ? (
        <>
          <h2>Could not draw this visualization</h2>
          <p className="viz-empty__error">{error}</p>
        </>
      ) : (
        <>
          <h2>No visualization yet</h2>
          <p>
            Ask your agent to run the paireto viz skill on the current changes. The picture appears
            here.
          </p>
          {vizzes && vizzes.length > 0 && (
            <ul className="viz-empty__list">
              {vizzes.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="viz-textbtn"
                    onClick={() => vscode.postMessage({ type: "switch", name: entry.name })}
                  >
                    {entry.title} ({entry.repoName})
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
