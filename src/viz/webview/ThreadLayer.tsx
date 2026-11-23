import { useReactFlow, useStore } from "@xyflow/react";
import { useCallback, useEffect, useState } from "react";

import type { Point } from "../layout/geometry";
import type { OverviewScene } from "../layout/overview";
import type { VizIndex } from "../model/index";
import {
  refTarget,
  relativePlace,
  searchTargets,
  targetsTitle,
  type PlacedNote,
} from "../model/notes";
import type { UiAction, UiState } from "../model/ui";
import type { VizNoteTarget, VizReviewState } from "../protocol";
import { noteTargetAt, noteTargetElementAt } from "./context";
import { UiIcon } from "./icons";
import { NewThread, ThreadPopup, type ThreadActions } from "./Thread";
import { vscode } from "./vscode";

export type Linking =
  | { readonly note: string; readonly kind: "drag"; readonly pointerId: number }
  | { readonly note: string; readonly kind: "pick" };

interface ThreadLayerProps {
  ui: UiState;
  index: VizIndex;
  scene: OverviewScene | undefined;
  notes: readonly PlacedNote[];
  review: VizReviewState;
  targets: readonly VizNoteTarget[];
  spot: Point | undefined;
  linking: Linking | undefined;
  setLinking(linking: Linking | undefined): void;
  dispatch: (action: UiAction) => void;
}

const GAP = 16;

export function ThreadLayer(props: ThreadLayerProps) {
  const { ui, index, scene, notes, review, targets, spot, linking, setLinking, dispatch } = props;
  const [tx, ty, zoom] = useStore((state) => state.transform);
  const domNode = useStore((state) => state.domNode);
  const { screenToFlowPosition } = useReactFlow();
  const placing = ui.thread.kind === "placing";
  const [pointer, setPointer] = useState<Point>();
  const toScreen = (p: Point): Point => ({ x: p.x * zoom + tx, y: p.y * zoom + ty });

  const applyTarget = useCallback(
    (noteId: string, target: VizNoteTarget) => {
      if (noteId === "draft") {
        dispatch({ type: "draftLink", target });
      } else {
        vscode.postMessage({ type: "note.link", id: noteId, target });
      }
    },
    [dispatch],
  );

  useEffect(() => {
    if (!linking || !domNode) {
      return;
    }
    const rect = () => domNode.getBoundingClientRect();
    const finish = (x: number, y: number) => {
      const target = noteTargetAt(x, y);
      if (target) {
        applyTarget(linking.note, target);
      }
      setLinking(undefined);
      setPointer(undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setLinking(undefined);
        setPointer(undefined);
      }
    };
    window.addEventListener("keydown", key, true);
    if (linking.kind === "drag") {
      const move = (event: PointerEvent) => {
        const box = rect();
        setPointer({ x: event.clientX - box.left, y: event.clientY - box.top });
      };
      const up = (event: PointerEvent) => finish(event.clientX, event.clientY);
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      return () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("keydown", key, true);
      };
    }
    const click = (event: MouseEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.closest(".viz-thread")) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      finish(event.clientX, event.clientY);
    };
    domNode.addEventListener("click", click, true);
    return () => {
      domNode.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [linking, domNode, applyTarget, setLinking]);

  useEffect(() => {
    if (!placing || !domNode) {
      return;
    }
    let lit: HTMLElement | undefined;
    const light = (element: HTMLElement | undefined) => {
      lit?.classList.remove("viz-target--lit");
      lit = element;
      lit?.classList.add("viz-target--lit");
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
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      dispatch({
        type: "startDraft",
        noteKind: "comment",
        targets: target ? [target] : [],
        place: !target && scene ? relativePlace(scene, at) : undefined,
        at,
      });
    };
    domNode.addEventListener("pointermove", move, true);
    domNode.addEventListener("click", click, true);
    return () => {
      light(undefined);
      domNode.removeEventListener("pointermove", move, true);
      domNode.removeEventListener("click", click, true);
    };
  }, [placing, domNode, scene, screenToFlowPosition, dispatch]);

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
  const actionsFor = (noteId: string): ThreadActions => ({
    searchTargets: (query) => searchTargets(targets, query),
    onMention: (target) => applyTarget(noteId, target),
    onShowTarget: show,
    onLink: () => setLinking({ note: noteId, kind: "pick" }),
    onUnlink: (unlinkIndex) =>
      noteId === "draft"
        ? dispatch({ type: "draftUnlink", index: unlinkIndex })
        : vscode.postMessage({ type: "note.unlink", id: noteId, index: unlinkIndex }),
    onClose: () => dispatch({ type: "closeThread" }),
  });

  const placedFor = (id: string) => notes.find((note) => note.id === id);
  const windowAt = (note: PlacedNote): Point => {
    const at = toScreen({ x: note.x + note.width, y: note.y });
    return { x: at.x + GAP, y: at.y };
  };

  let thread: React.ReactNode = null;
  if (ui.thread.kind === "draft") {
    const ghost = placedFor("draft");
    const draft = ui.thread;
    const at = ghost ? windowAt(ghost) : toScreen(draft.at);
    thread = (
      <NewThread
        kind={draft.noteKind}
        targets={draft.targets}
        left={at.x}
        top={at.y}
        actions={actionsFor("draft")}
        onKind={(noteKind) => dispatch({ type: "draftKind", noteKind })}
        onPost={(body) => {
          vscode.postMessage({
            type: "note.add",
            kind: draft.noteKind,
            title: targetsTitle(draft.targets),
            body,
            targets: [...draft.targets],
            place: ghost && scene ? relativePlace(scene, ghost) : draft.place,
          });
          dispatch({ type: "closeThread" });
        }}
      />
    );
  } else if (ui.thread.kind === "open") {
    const id = ui.thread.id;
    const note = review.notes.find((candidate) => candidate.id === id);
    const placed = placedFor(id);
    if (note && placed) {
      const at = windowAt(placed);
      thread = (
        <ThreadPopup
          note={note}
          left={at.x}
          top={at.y}
          linking={linking !== undefined}
          feedback={review.feedback}
          actions={actionsFor(id)}
          onReply={(body) => vscode.postMessage({ type: "note.reply", id, body })}
          onRead={() => vscode.postMessage({ type: "note.read", id })}
          onResolve={() => {
            vscode.postMessage({ type: "note.resolve", id });
            dispatch({ type: "closeThread" });
          }}
          onEditOpening={(kind, body) =>
            vscode.postMessage({ type: "note.edit", id, kind, body, targets: [...note.targets] })
          }
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

  const dragFrom = linking?.kind === "drag" ? placedFor(linking.note) : undefined;
  const from = dragFrom
    ? toScreen({ x: dragFrom.x + dragFrom.width, y: dragFrom.y + dragFrom.height / 2 })
    : undefined;
  const spotTarget = ui.selection && refTarget(index, ui.selection);
  const spotAt =
    spot && spotTarget && ui.thread.kind === "closed" && !linking ? toScreen(spot) : undefined;
  return (
    <>
      {thread}
      {spotAt && spotTarget && (
        <button
          type="button"
          className="viz-spot-comment"
          style={{ left: spotAt.x, top: spotAt.y }}
          title={`Comment on ${spotTarget.label} (c)`}
          aria-label={`Comment on ${spotTarget.label}`}
          onClick={(event) => {
            event.stopPropagation();
            dispatch({
              type: "startDraft",
              noteKind: "comment",
              targets: [spotTarget],
              place: undefined,
              at: spot ?? { x: 0, y: 0 },
            });
          }}
        >
          <UiIcon name="comment" size={13} />
        </button>
      )}
      {placing && (
        <div className="viz-link-hint" role="status">
          Click a part to comment on it, or empty space for a free comment. Esc cancels.
        </div>
      )}
      {linking && (
        <div className="viz-link-hint" role="status">
          {linking.kind === "drag"
            ? "Drop on a part, a member, a frame or a step to link it. Esc cancels."
            : "Click a part, a member, a frame or a step to link it. Esc cancels."}
        </div>
      )}
      {from && pointer && (
        <svg className="viz-link-drag" aria-hidden="true">
          <line x1={from.x} y1={from.y} x2={pointer.x} y2={pointer.y} />
        </svg>
      )}
    </>
  );
}
