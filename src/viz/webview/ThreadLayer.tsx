import { useReactFlow, useStore } from "@xyflow/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import type { Point } from "../layout/geometry";
import type { VizIndex } from "../model/index";
import { DIAGRAM_KEY, diagramNotes, targetKey, targetsTitle, type Bubble } from "../model/notes";
import type { UiAction, UiState } from "../model/ui";
import type { VizNote, VizNoteTarget, VizReviewState } from "../protocol";
import { noteTargetAt, noteTargetElementAt } from "./context";
import { onWholeDiagram, wholeDiagramAt } from "./DiagramBubble";
import { UiIcon } from "./icons";
import { NewThread, THREAD_WIDTH, ThreadList, ThreadPopup, type ThreadActions } from "./Thread";
import { vscode } from "./vscode";
import "./notes.css";

interface ThreadLayerProps {
  ui: UiState;
  index: VizIndex;
  bubbles: readonly Bubble[];
  review: VizReviewState;
  dispatch: (action: UiAction) => void;
}

const GAP = 14;

function activeKey(
  ui: UiState,
  bubbles: readonly Bubble[],
  notes: readonly VizNote[],
): string | undefined {
  if (onWholeDiagram(ui, notes)) {
    return DIAGRAM_KEY;
  }
  const thread = ui.thread;
  switch (thread.kind) {
    case "open":
      return (
        thread.anchor ??
        bubbles.find((bubble) => bubble.notes.some((note) => note.id === thread.id))?.key
      );
    case "list":
      return thread.key;
    case "draft":
      return thread.targets[0] && targetKey(thread.targets[0]);
    default:
      return undefined;
  }
}

function BubbleButton({
  bubble,
  at,
  active,
  onClick,
}: {
  bubble: Bubble;
  at: Point;
  active: boolean;
  onClick(): void;
}) {
  const count = bubble.notes.length;
  const questions = count > 0 && bubble.notes.every((note) => note.kind === "question");
  const unread = bubble.notes.some((note) => note.unread > 0);
  const classes = [
    "viz-bubble",
    bubble.target.kind === "member" ? "viz-bubble--member" : "",
    count === 0 ? "viz-bubble--add" : "",
    questions ? "viz-bubble--question" : "",
    active ? "viz-bubble--active" : "",
  ].join(" ");
  const label =
    count === 0
      ? `Comment on ${bubble.target.label}`
      : `${count} ${questions ? "question" : "thread"}${count === 1 ? "" : "s"} on ${bubble.target.label}`;
  return (
    <button
      type="button"
      className={classes}
      style={{ left: at.x, top: at.y }}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {count === 0 ? (
        <>
          <UiIcon name="comment" size={12} />
          <UiIcon name="plus" size={10} />
        </>
      ) : (
        <>
          <UiIcon name={questions ? "help" : "comment"} size={12} />
          <span className="viz-bubble__count">{count}</span>
          {unread && <span className="viz-bubble__dot" aria-hidden />}
        </>
      )}
    </button>
  );
}

export function ThreadLayer(props: ThreadLayerProps) {
  const { ui, index, bubbles, review, dispatch } = props;
  const [tx, ty, zoom] = useStore((state) => state.transform);
  const domNode = useStore((state) => state.domNode);
  const paneWidth = useStore((state) => state.width);
  const { getViewport, setViewport } = useReactFlow();
  const placing = ui.thread.kind === "placing";
  const toScreen = (p: Point): Point => ({ x: p.x * zoom + tx, y: p.y * zoom + ty });
  const lit = activeKey(ui, bubbles, review.notes);

  useEffect(() => {
    if (!placing || !domNode) {
      return;
    }
    let hovered: HTMLElement | undefined;
    const light = (element: HTMLElement | undefined) => {
      hovered?.classList.remove("viz-target--lit");
      hovered = element;
      hovered?.classList.add("viz-target--lit");
    };
    const move = (event: PointerEvent) => light(noteTargetElementAt(event.clientX, event.clientY));
    const click = (event: MouseEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.closest(".viz-thread, .react-flow__controls, .react-flow__minimap")) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      const target = noteTargetAt(event.clientX, event.clientY);
      if (target) {
        dispatch({ type: "startDraft", noteKind: "comment", targets: [target] });
      }
    };
    domNode.addEventListener("pointermove", move, true);
    domNode.addEventListener("click", click, true);
    return () => {
      light(undefined);
      domNode.removeEventListener("pointermove", move, true);
      domNode.removeEventListener("click", click, true);
    };
  }, [placing, domNode, dispatch]);

  useEffect(() => {
    if (!lit || !domNode) {
      return;
    }
    const found = [...domNode.querySelectorAll<HTMLElement>("[data-note-target]")].filter(
      (element) =>
        element.dataset.noteTarget !== undefined &&
        targetKey(JSON.parse(element.dataset.noteTarget) as VizNoteTarget) === lit,
    );
    for (const element of found) {
      element.classList.add("viz-target--open");
    }
    return () => {
      for (const element of found) {
        element.classList.remove("viz-target--open");
      }
    };
  }, [lit, domNode, bubbles]);

  const show = (target: VizNoteTarget) => {
    switch (target.kind) {
      case "node":
        dispatch({ type: "goto", ref: { kind: "node", id: target.id } });
        break;
      case "member":
        dispatch({ type: "goto", ref: { kind: "member", id: target.id, node: target.node } });
        break;
      case "edge":
        dispatch({ type: "goto", ref: { kind: "edge", id: target.id } });
        break;
      case "step":
        dispatch({ type: "goto", ref: { kind: "step", flow: target.flow, index: target.index } });
        break;
      case "file": {
        const node = index.overviewNodes.find(
          (candidate) => candidate.files?.[0]?.path === target.path,
        );
        if (node) {
          dispatch({ type: "goto", ref: { kind: "node", id: node.id } });
        }
        break;
      }
    }
  };
  const actions: ThreadActions = {
    onShowTarget: show,
    onClose: () => dispatch({ type: "closeThread" }),
  };

  const bubbleByKey = (key: string | undefined) =>
    key === undefined ? undefined : bubbles.find((bubble) => bubble.key === key);
  const anchor =
    ui.thread.kind === "closed" || ui.thread.kind === "placing" ? undefined : bubbleByKey(lit);
  const opened = anchor && `${ui.thread.kind}:${anchor.key}`;
  const anchorX = anchor?.at.x;
  useEffect(() => {
    if (!opened || anchorX === undefined) {
      return;
    }
    const { x, y, zoom: scale } = getViewport();
    const over = anchorX * scale + x + GAP + THREAD_WIDTH - (paneWidth - 16);
    if (over > 0) {
      void setViewport({ x: x - over, y, zoom: scale }, { duration: 200 });
    }
  }, [opened, anchorX, paneWidth, getViewport, setViewport]);
  const stage = domNode?.parentElement ?? undefined;
  const diagramAt = wholeDiagramAt(stage);
  const windowAt = (bubble: Bubble | undefined): Point => {
    if (!bubble) {
      return diagramAt;
    }
    const at = toScreen(bubble.at);
    return { x: at.x + GAP, y: at.y - GAP };
  };
  const press = (bubble: Bubble) => {
    if (lit === bubble.key && ui.thread.kind !== "draft") {
      dispatch({ type: "closeThread" });
      return;
    }
    const [only] = bubble.notes;
    if (bubble.notes.length === 0) {
      dispatch({ type: "startDraft", noteKind: "comment", targets: [bubble.target] });
    } else if (bubble.notes.length === 1 && only) {
      dispatch({ type: "openThread", id: only.id, anchor: bubble.target });
    } else {
      dispatch({ type: "openList", key: bubble.key });
    }
  };

  let thread: React.ReactNode = null;
  if (ui.thread.kind === "draft") {
    const draft = ui.thread;
    const at = windowAt(bubbleByKey(lit));
    thread = (
      <NewThread
        kind={draft.noteKind}
        targets={draft.targets}
        left={at.x}
        top={at.y}
        actions={actions}
        onKind={(noteKind) => dispatch({ type: "draftKind", noteKind })}
        onPost={(body) => {
          vscode.postMessage({
            type: "note.add",
            kind: draft.noteKind,
            title: targetsTitle(draft.targets),
            body,
            targets: [...draft.targets],
          });
          dispatch({ type: "closeThread" });
        }}
      />
    );
  } else if (ui.thread.kind === "list" && ui.thread.key === DIAGRAM_KEY) {
    thread = (
      <ThreadList
        title="The whole diagram"
        notes={diagramNotes(review.notes)}
        left={diagramAt.x}
        top={diagramAt.y}
        onOpen={(id) => dispatch({ type: "openThread", id })}
        onNew={() => dispatch({ type: "startDraft", noteKind: "comment", targets: [] })}
        onClose={() => dispatch({ type: "closeThread" })}
      />
    );
  } else if (ui.thread.kind === "list") {
    const bubble = bubbleByKey(ui.thread.key);
    if (bubble) {
      const at = windowAt(bubble);
      thread = (
        <ThreadList
          title={bubble.target.label}
          notes={bubble.notes}
          left={at.x}
          top={at.y}
          onOpen={(id) => dispatch({ type: "openThread", id, anchor: bubble.target })}
          onNew={() =>
            dispatch({ type: "startDraft", noteKind: "comment", targets: [bubble.target] })
          }
          onClose={() => dispatch({ type: "closeThread" })}
        />
      );
    }
  } else if (ui.thread.kind === "open") {
    const id = ui.thread.id;
    const note: VizNote | undefined = review.notes.find((candidate) => candidate.id === id);
    if (note) {
      const at = windowAt(bubbleByKey(lit));
      thread = (
        <ThreadPopup
          note={note}
          left={at.x}
          top={at.y}
          feedback={review.feedback}
          actions={actions}
          onReply={(body) => vscode.postMessage({ type: "note.reply", id, body })}
          onRead={() => vscode.postMessage({ type: "note.read", id })}
          onResolve={() => {
            vscode.postMessage({ type: "note.resolve", id });
            dispatch({ type: "closeThread" });
          }}
          onEditOpening={(kind, body) => vscode.postMessage({ type: "note.edit", id, kind, body })}
          onEditReply={(itemId, body) =>
            vscode.postMessage({ type: "note.editReply", id: itemId, body })
          }
          onDelete={(itemId) => {
            const first = note.items[0]?.id === itemId;
            vscode.postMessage({ type: "note.delete", id: first ? id : itemId });
            if (first) {
              dispatch({ type: "closeThread" });
            }
          }}
          onSendFeedback={() => vscode.postMessage({ type: "gate", action: "sendFeedback" })}
        />
      );
    }
  }

  return (
    <>
      {bubbles.map((bubble) => (
        <BubbleButton
          key={bubble.key}
          bubble={bubble}
          at={toScreen(bubble.at)}
          active={lit === bubble.key}
          onClick={() => press(bubble)}
        />
      ))}
      {lit === DIAGRAM_KEY && stage ? createPortal(thread, stage) : thread}
      {placing && (
        <div className="viz-link-hint" role="status">
          Click a part, a member or a step to comment on it. Esc cancels.
        </div>
      )}
    </>
  );
}
