import { useEffect, useRef, useState } from "react";

import type { VizIndex } from "../model/index";
import { fileKey, reviewFiles, seenProgress, type FileEntry } from "../model/review";
import type { UiAction, UiState } from "../model/ui";
import { changeSize, chipOf, type Chip } from "../model/visible";
import type { VizReviewFile, VizReviewState } from "../protocol";
import { UiIcon } from "./icons";
import { ChipMark, Counts } from "./parts";
import { vscode } from "./vscode";
import "./sidebar.css";

interface ChangedFilesProps {
  index: VizIndex;
  ui: UiState;
  review: VizReviewState;
  dispatch: (action: UiAction) => void;
  onNext(): void;
}

const STATUS_CHIP: Record<VizReviewFile["status"], Chip> = { A: "A", M: "M", D: "D", R: "M" };

function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

function FileRow({
  entry,
  ui,
  dispatch,
  largest,
}: {
  entry: FileEntry;
  ui: UiState;
  dispatch: (action: UiAction) => void;
  largest: number;
}) {
  const { file } = entry;
  const { name, dir } = splitPath(file.path);
  const selectedNode =
    ui.selection?.kind === "node"
      ? ui.selection.id
      : ui.selection?.kind === "member"
        ? ui.selection.node
        : undefined;
  const selectedMember = ui.selection?.kind === "member" ? ui.selection.id : undefined;
  return (
    <li className={`viz-rfile ${file.seen ? "viz-rfile--seen" : ""}`}>
      <div className="viz-rfile__row">
        <ChipMark chip={STATUS_CHIP[file.status]} soft />
        <span className="viz-rfile__name" title={file.path}>
          {name}
          {dir && <span className="viz-rfile__dir"> {dir}</span>}
        </span>
        <Counts counts={{ added: file.additions, removed: file.deletions }} />
        <button
          type="button"
          className={`viz-seen ${file.seen ? "viz-seen--on" : ""}`}
          title={
            file.seen ? "Seen. Click to mark it not seen." : "Not seen yet. Click to mark it seen."
          }
          aria-pressed={file.seen}
          onClick={() =>
            vscode.postMessage({ type: "seen", repo: file.repo, path: file.path, seen: !file.seen })
          }
        >
          <UiIcon name="check" size={11} />
        </button>
      </div>
      {entry.nodes.length > 0 && (
        <ul className="viz-rfile__nodes">
          {entry.nodes.map(({ node, members }) => (
            <li key={node.id}>
              <button
                type="button"
                className={`viz-change ${selectedNode === node.id && !selectedMember ? "viz-change--selected" : ""}`}
                onClick={() => dispatch({ type: "goto", ref: { kind: "node", id: node.id } })}
              >
                <ChipMark chip={chipOf(node)} />
                <span className="viz-change__name">{node.label}</span>
                {node.counts && <Counts counts={node.counts} />}
                <span className="viz-change__bar">
                  <span
                    className="viz-change__fill"
                    style={{ width: `${Math.round((changeSize(node) / largest) * 100)}%` }}
                  >
                    {node.counts && changeSize(node) > 0 && (
                      <span
                        className="viz-change__fill-removed"
                        style={{
                          width: `${Math.round((node.counts.removed / changeSize(node)) * 100)}%`,
                        }}
                      />
                    )}
                  </span>
                </span>
              </button>
              {members.length > 0 && (
                <ul className="viz-change__members">
                  {members.map((member) => (
                    <li key={member.id}>
                      <button
                        type="button"
                        className={`viz-member ${selectedMember === member.id ? "viz-member--selected" : ""}`}
                        title={member.label}
                        onClick={() =>
                          dispatch({
                            type: "goto",
                            ref: { kind: "member", id: member.id, node: node.id },
                          })
                        }
                      >
                        <ChipMark chip={chipOf(member)} soft />
                        <span className="viz-member__name">{member.short ?? member.label}</span>
                        {member.counts && <Counts counts={member.counts} />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ChangedFiles({ index, ui, review, dispatch, onNext }: ChangedFilesProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const entries = reviewFiles(index, review.files);
  const progress = seenProgress(review.files);
  const largest = Math.max(1, ...index.overviewNodes.map((node) => changeSize(node)));
  const pick = (action: UiAction) => {
    dispatch(action);
    setOpen(false);
  };
  return (
    <div className="viz-filepick" ref={boxRef}>
      <span className="viz-filepick__label">Review</span>
      <button
        type="button"
        className={`viz-filepick__toggle ${open ? "viz-filepick__toggle--open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Open the list of changed files in this Overview. Tick a file when you have seen it."
        onClick={() => setOpen(!open)}
      >
        <UiIcon name="files" size={14} />
        {progress.seen} of {progress.total} files seen
        <UiIcon name="down" size={12} />
      </button>
      <button
        type="button"
        className="viz-filepick__next"
        title="Go to the next change in the Overview (n)"
        onClick={onNext}
      >
        <UiIcon name="arrowDown" size={14} />
        Next change
        <kbd>N</kbd>
      </button>
      {open && (
        <div className="viz-filepick__pop" role="dialog" aria-label="Changed files in the Overview">
          <header className="viz-sidebar__head">
            <span className="viz-sidebar__label">Changed files in the Overview</span>
            {progress.seen > 0 && (
              <button
                type="button"
                className="viz-textbtn"
                title="Mark every file not seen and start from the first change"
                onClick={() => {
                  vscode.postMessage({ type: "resetSeen" });
                  pick({ type: "resetChanges" });
                }}
              >
                Start again
              </button>
            )}
          </header>
          {review.files.length === 0 ? (
            <p className="viz-review__empty viz-muted">No changed files in this review.</p>
          ) : (
            <>
              <div className="viz-filepick__progress">
                <span className="viz-progress" aria-hidden>
                  <span
                    style={{
                      width: `${progress.total ? (progress.seen / progress.total) * 100 : 0}%`,
                    }}
                  />
                </span>
              </div>
              <ul className="viz-rfiles">
                {entries.map((entry) => (
                  <FileRow
                    key={fileKey(entry.file)}
                    entry={entry}
                    ui={ui}
                    dispatch={pick}
                    largest={largest}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
