import type { VizIndex } from "../model/index";
import { KEY_BINDINGS } from "../model/keymap";
import type { UiAction, UiState } from "../model/ui";
import { UiIcon } from "./icons";
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
              className={`viz-dot ${i === step.index ? "viz-dot--on" : i < step.index ? "viz-dot--done" : ""}`}
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
        <p className="viz-inspector__hint">
          Drag to pan, scroll to zoom. Click a part, connection or step to inspect it.
        </p>
      </div>
    </div>
  );
}

export function EmptyState({ error }: { error?: string }) {
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
        </>
      )}
    </div>
  );
}
