import { useRef } from "react";

import type { VizIndex } from "../model/index";
import type { UiAction, UiState } from "../model/ui";
import type { VizReviewState } from "../protocol";
import { UiIcon } from "./icons";
import { Inspector } from "./Inspector";
import "./sidebar.css";

interface SidebarProps {
  index: VizIndex;
  ui: UiState;
  review: VizReviewState;
  dispatch: (action: UiAction) => void;
}

export function Sidebar({ index, ui, review, dispatch }: SidebarProps) {
  const dragRef = useRef<number>(0);
  return (
    <aside className="viz-sidebar" aria-label="Selection" style={{ width: ui.sidebarWidth }}>
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
        <section className="viz-inspect">
          <header className="viz-sidebar__head">
            <span className="viz-sidebar__label">Selection</span>
            {ui.selection && (
              <button
                type="button"
                className="viz-minibtn"
                title="Clear the selection (esc)"
                onClick={() => dispatch({ type: "select", ref: undefined })}
              >
                <UiIcon name="close" size={11} />
                Clear
              </button>
            )}
            <button
              type="button"
              className="viz-iconbtn"
              title="Hide the side bar (b)"
              aria-label="Hide the side bar"
              onClick={() => dispatch({ type: "toggleSidebar" })}
            >
              <UiIcon name="sidebar" size={14} />
            </button>
          </header>
          <Inspector
            index={index}
            stage={ui.stage}
            selection={ui.selection}
            review={review}
            dispatch={dispatch}
          />
        </section>
      </div>
    </aside>
  );
}
