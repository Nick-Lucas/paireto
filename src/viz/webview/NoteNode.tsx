import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { NOTE, NOTE_KIND_LABELS, noteStatus, targetsTitle } from "../model/notes";
import type { NoteData } from "../model/rf";
import { useViz } from "./context";
import { UiIcon } from "./icons";
import { vscode } from "./vscode";
import "./notes.css";

function foldPath(width: number, height: number): string {
  return `M0,0 H${width - NOTE.fold} L${width},${NOTE.fold} V${height} H0 Z`;
}

export function NoteNode({ data }: NodeProps<Node<NoteData, "note">>) {
  const viz = useViz();
  const { note } = data;
  const ghost = note.note === undefined;
  const kind = NOTE_KIND_LABELS[note.kind];
  const status = note.note ? noteStatus(note.note) : { meta: "new", badge: "" };
  const title = targetsTitle(note.note?.targets ?? []);
  const classes = [
    "viz-note",
    `viz-note--${note.kind}`,
    ghost ? "viz-note--ghost" : "",
    data.open ? "viz-note--open" : "",
  ].join(" ");
  const show = () => {
    if (note.note) {
      viz.dispatch({ type: "openThread", id: note.id });
    }
  };
  return (
    <div
      className={classes}
      style={{ width: note.width, height: note.height }}
      role="button"
      tabIndex={0}
      title={
        ghost
          ? "New comment. Type it in the thread beside it."
          : `${kind} on ${title}\n\n${note.note?.body ?? ""}\n\nClick to show the thread. Drag the note to move it. Drag the dot to link it to a part.`
      }
      onClick={show}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          show();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (note.note) {
          viz.openMenu({ kind: "note", id: note.id }, { x: event.clientX, y: event.clientY });
        }
      }}
    >
      <Handle type="source" position={Position.Right} className="viz-handle" />
      <Handle type="target" position={Position.Left} className="viz-handle" />
      <svg className="viz-note__shape" width={note.width} height={note.height} aria-hidden="true">
        <path className="viz-note__box" d={foldPath(note.width, note.height)} />
        <path
          className="viz-note__fold"
          d={`M${note.width - NOTE.fold},0 V${NOTE.fold} H${note.width}`}
        />
      </svg>
      <div className="viz-note__head" style={{ height: NOTE.headHeight }}>
        <UiIcon name="comment" size={13} />
        <span className="viz-note__kind">{kind}</span>
        {status.badge ? (
          <span className="viz-note__badge">
            <span className="viz-dot viz-dot--agent" /> {status.badge}
          </span>
        ) : (
          <span className="viz-note__meta">{status.meta}</span>
        )}
        <span className="viz-note__gap" />
        {!ghost && (
          <button
            type="button"
            className="viz-note__resolve"
            title="Resolve"
            aria-label={`Resolve this ${kind.toLowerCase()}`}
            onClick={(event) => {
              event.stopPropagation();
              vscode.postMessage({ type: "note.resolve", id: note.id });
            }}
          >
            <UiIcon name="check" size={13} />
          </button>
        )}
      </div>
      <div className="viz-note__body">
        {note.lines.map((line, i) => (
          <div key={i} className="viz-note__line" style={{ height: NOTE.lineHeight }}>
            {line}
          </div>
        ))}
      </div>
      {!ghost && (
        <span
          className="viz-note__handle nodrag"
          title="Drag to a part, a member or a frame to link this note to it"
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            event.stopPropagation();
            event.preventDefault();
            viz.startLink(note.id, event.pointerId);
          }}
        />
      )}
    </div>
  );
}
