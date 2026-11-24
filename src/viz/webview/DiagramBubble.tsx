import type { Point } from "../layout/geometry";
import { DIAGRAM_KEY, diagramNotes } from "../model/notes";
import type { UiAction, UiState } from "../model/ui";
import type { VizNote, VizReviewState } from "../protocol";
import { UiIcon } from "./icons";
import "./notes.css";

const BUTTON = ".viz-diagrambar .viz-bubble--diagram";

export function onWholeDiagram(ui: UiState, notes: readonly VizNote[]): boolean {
  const thread = ui.thread;
  switch (thread.kind) {
    case "list":
      return thread.key === DIAGRAM_KEY;
    case "draft":
      return thread.targets.length === 0;
    case "open":
      return (
        thread.anchor === undefined &&
        notes.find((note) => note.id === thread.id)?.targets.length === 0
      );
    default:
      return false;
  }
}

export function wholeDiagramAt(stage: HTMLElement | undefined): Point {
  const button = document.querySelector(BUTTON);
  if (!stage || !button) {
    return { x: 12, y: 8 };
  }
  const from = button.getBoundingClientRect();
  const view = stage.getBoundingClientRect();
  return { x: Math.max(12, from.left - view.left), y: 8 };
}

export function DiagramBubble({
  ui,
  review,
  dispatch,
}: {
  ui: UiState;
  review: VizReviewState;
  dispatch: (action: UiAction) => void;
}) {
  const notes = diagramNotes(review.notes);
  const count = notes.length;
  const active = onWholeDiagram(ui, review.notes);
  const label =
    count === 0
      ? "Comment on the whole diagram, not on one part"
      : `${count} ${count === 1 ? "thread" : "threads"} on the whole diagram`;
  const press = () => {
    if (active && ui.thread.kind !== "draft") {
      dispatch({ type: "closeThread" });
    } else if (count === 0) {
      dispatch({ type: "startDraft", noteKind: "comment", targets: [] });
    } else if (count === 1) {
      dispatch({ type: "openThread", id: notes[0].id });
    } else {
      dispatch({ type: "openList", key: DIAGRAM_KEY });
    }
  };
  return (
    <button
      type="button"
      className={`viz-bubble viz-bubble--diagram ${count === 0 ? "viz-bubble--add" : ""} ${active ? "viz-bubble--active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={(event) => {
        event.stopPropagation();
        press();
      }}
    >
      <UiIcon name="comment" size={12} />
      {count === 0 ? (
        <UiIcon name="plus" size={10} />
      ) : (
        <span className="viz-bubble__count">{count}</span>
      )}
      {notes.some((note) => note.unread > 0) && <span className="viz-bubble__dot" aria-hidden />}
      <span className="viz-bubble__label">Whole diagram</span>
    </button>
  );
}
