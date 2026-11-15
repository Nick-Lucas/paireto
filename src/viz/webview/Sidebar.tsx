import { useRef } from "react";

import type { VizIndex } from "../model/index";
import { fileKey, reviewFiles, seenProgress, type FileEntry } from "../model/review";
import type { UiAction, UiState } from "../model/ui";
import { changeSize, chipOf, type Chip } from "../model/visible";
import type { VizReviewFile, VizReviewState } from "../protocol";
import { UiIcon } from "./icons";
import { Inspector } from "./Inspector";
import { ChipMark, Counts } from "./parts";
import { vscode } from "./vscode";
import "./sidebar.css";

interface SidebarProps {
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
  dispatch: SidebarProps["dispatch"];
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

export function Sidebar({ index, ui, review, dispatch, onNext }: SidebarProps) {
  const entries = reviewFiles(index, review.files);
  const progress = seenProgress(review.files);
  const largest = Math.max(1, ...index.overviewNodes.map((node) => changeSize(node)));
  const dragRef = useRef<number>(0);
  return (
    <aside className="viz-sidebar" aria-label="Review" style={{ width: ui.sidebarWidth }}>
      <div
        className="viz-sidebar__resize"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          dragRef.current = event.clientX + ui.sidebarWidth;
          const move = (moved: PointerEvent) =>
            dispatch({ type: "sidebarWidth", width: dragRef.current - moved.clientX });
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      />
      <div className="viz-sidebar__scroll">
        <section className="viz-review">
          <header className="viz-sidebar__head">
            <span className="viz-sidebar__label">Where the changes are</span>
            <button
              type="button"
              className="viz-iconbtn"
              title="Hide the sidebar (b)"
              onClick={() => dispatch({ type: "toggleSidebar" })}
            >
              <UiIcon name="next" size={12} />
            </button>
          </header>
          {review.files.length === 0 ? (
            <p className="viz-review__empty viz-muted">No changed files in this review.</p>
          ) : (
            <div className="viz-review__actions">
              <div className="viz-review__progress">
                <span className="viz-progress" aria-hidden>
                  <span
                    style={{
                      width: `${progress.total ? (progress.seen / progress.total) * 100 : 0}%`,
                    }}
                  />
                </span>
                <span className="viz-muted">
                  {progress.seen} of {progress.total} files seen
                </span>
              </div>
              <div className="viz-review__buttons">
                <button
                  type="button"
                  className="viz-btn viz-review__next"
                  title="Go to the next change (n)"
                  onClick={onNext}
                >
                  Next change <kbd>N</kbd>
                </button>
                {progress.seen > 0 && (
                  <button
                    type="button"
                    className="viz-textbtn"
                    title="Mark every file not seen and start from the first change"
                    onClick={() => {
                      vscode.postMessage({ type: "resetSeen" });
                      dispatch({ type: "resetChanges" });
                    }}
                  >
                    Start again
                  </button>
                )}
              </div>
            </div>
          )}
          <ul className="viz-rfiles">
            {entries.map((entry) => (
              <FileRow
                key={fileKey(entry.file)}
                entry={entry}
                ui={ui}
                dispatch={dispatch}
                largest={largest}
              />
            ))}
          </ul>
        </section>
        <section className="viz-inspect">
          <header className="viz-sidebar__head">
            <span className="viz-sidebar__label">{ui.selection ? "Selection" : "Stage"}</span>
            {ui.selection && (
              <button
                type="button"
                className="viz-iconbtn"
                title="Clear selection (esc)"
                onClick={() => dispatch({ type: "select", ref: undefined })}
              >
                <UiIcon name="close" size={12} />
              </button>
            )}
          </header>
          <Inspector index={index} stage={ui.stage} selection={ui.selection} dispatch={dispatch} />
        </section>
      </div>
    </aside>
  );
}
