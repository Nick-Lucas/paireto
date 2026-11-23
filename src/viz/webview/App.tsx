import ELK from "elkjs/lib/elk.bundled.js";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { VizFileRef } from "../../protocol/viz";
import { layoutOverview, type OverviewScene } from "../layout/overview";
import { layoutSequence } from "../layout/sequence";
import { emphasisOf } from "../model/emphasis";
import { buildVizIndex, type VizIndex } from "../model/index";
import { resolveKey } from "../model/keymap";
import { toMermaid } from "../model/mermaid";
import { allTargets, placeNotes, placeSequenceNotes, type NoteDraft } from "../model/notes";
import { resolveFocus } from "../model/refs";
import { toOverviewRf, toSequenceRf, type RfGraph } from "../model/rf";
import { nextChange, reviewMarks } from "../model/review";
import type { VizDoc, VizIssue } from "../model/types";
import { initialUi, reduceUi, viewStateOf, type UiAction, type UiState } from "../model/ui";
import type {
  HostToWebview,
  VizListEntry,
  VizReviewState,
  VizViewState,
  VizWindowState,
} from "../protocol";
import { AgentBar } from "./AgentControls";
import { Canvas } from "./Canvas";
import { Header } from "./Header";
import { UiIcon } from "./icons";
import { createMeasure } from "./measure";
import { EmptyState, HelpOverlay, InvalidBanner, Legend, PlayBar, WalkCard } from "./overlays";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { vscode } from "./vscode";

const elk = new ELK();
const PLAY_INTERVAL_MS = 1400;

interface Loaded {
  doc: VizDoc;
  index: VizIndex;
  vizzes: VizListEntry[];
  window: VizWindowState;
  review: VizReviewState;
  view: VizViewState;
  invalid?: { name: string; issues: VizIssue[] };
}

type Screen =
  | { kind: "blank" }
  | { kind: "empty"; vizzes: VizListEntry[] }
  | { kind: "loaded"; loaded: Loaded };

function useOverviewScene(
  index: VizIndex,
  ui: UiState,
  measure: ReturnType<typeof createMeasure>,
  threads: ReadonlyMap<string, number>,
) {
  const [state, setState] = useState<{ scene?: OverviewScene; error?: string }>({});
  const { show, grouping, expanded } = ui;
  useEffect(() => {
    let cancelled = false;
    layoutOverview(index, elk, { show, grouping, expanded, measure, threads })
      .then((scene) => !cancelled && setState({ scene }))
      .catch((error: unknown) => !cancelled && setState({ error: String(error) }));
    return () => {
      cancelled = true;
    };
  }, [index, show, grouping, expanded, measure, threads]);
  return state;
}

type Request = { seq: number; message: Extract<HostToWebview, { type: "focus" | "showNote" }> };

function Viz({ loaded, request }: { loaded: Loaded; request: Request | undefined }) {
  const { doc, index, vizzes, window: windowState, review } = loaded;
  const measure = useMemo(() => createMeasure(), []);
  const [ui, dispatch] = useReducer(
    (state: UiState, action: UiAction) => reduceUi(index, state, action),
    loaded.view,
    (view) => initialUi(index, view),
  );
  useEffect(() => {
    if (!request) {
      return;
    }
    if (request.message.type === "showNote") {
      dispatch({ type: "openThread", id: request.message.id });
      return;
    }
    const ref = resolveFocus(request.message.focus, index);
    if (ref) {
      dispatch({ type: "goto", ref });
    }
  }, [request, index]);
  const searchRef = useRef<HTMLInputElement>(null);
  const marks = useMemo(() => reviewMarks(index, review), [index, review]);
  const { scene, error } = useOverviewScene(index, ui, measure, marks.threads);
  const emphasis = useMemo(() => emphasisOf(index, ui, marks), [index, ui, marks]);
  const sequence = useMemo(
    () => (ui.stage.kind === "flow" ? layoutSequence(index, ui.stage.flow) : undefined),
    [index, ui.stage],
  );
  const thread = ui.thread;
  const notes = useMemo(() => {
    const draft: NoteDraft | undefined =
      thread.kind === "draft"
        ? { kind: thread.noteKind, targets: thread.targets, place: thread.place }
        : undefined;
    if (sequence) {
      return placeSequenceNotes(sequence, index, review.notes, draft, measure);
    }
    return scene ? placeNotes(scene, index, review.notes, draft, measure) : [];
  }, [sequence, scene, index, review.notes, thread, measure]);
  const targets = useMemo(() => allTargets(index, review.files), [index, review.files]);
  const graph: RfGraph | undefined = useMemo(() => {
    if (ui.stage.kind === "flow" && sequence) {
      return toSequenceRf(sequence, index, emphasis, ui, notes);
    }
    return scene ? toOverviewRf(scene, index, emphasis, ui, { notes, marks, measure }) : undefined;
  }, [ui, sequence, scene, index, emphasis, notes, marks, measure]);

  const openFile = useCallback(
    (file: VizFileRef, mode: "file" | "diff") => vscode.postMessage({ type: "open", file, mode }),
    [],
  );
  const onExport = useCallback(() => {
    vscode.postMessage({
      type: "copy",
      text: toMermaid(index, ui.stage),
      what: ui.stage.kind === "overview" ? "Mermaid diagram" : "Mermaid sequence diagram",
    });
  }, [index, ui.stage]);
  const onNext = useCallback(() => {
    const step = nextChange(index, review.files, { cursor: ui.cursor, selection: ui.selection });
    if (step.seen) {
      vscode.postMessage({ type: "seen", repo: step.seen.repo, path: step.seen.path, seen: true });
    }
    if (step.stop) {
      dispatch({ type: "changeStop", cursor: step.stop.cursor, ref: step.stop.ref });
    } else {
      dispatch({ type: "resetChanges" });
    }
  }, [index, review.files, ui.cursor, ui.selection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inTextField = Boolean(target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const command = resolveKey({
        key: event.key,
        modifier: event.metaKey || event.ctrlKey || event.altKey,
        inTextField,
      });
      if (!command) {
        return;
      }
      event.preventDefault();
      if (command.kind === "ui") {
        if (inTextField && target) {
          target.blur();
        }
        dispatch(command.action);
        return;
      }
      switch (command.effect) {
        case "search":
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case "export":
          onExport();
          break;
        case "nextChange":
          onNext();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExport, onNext]);

  const running = ui.mode.kind === "play" && ui.mode.running;
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => dispatch({ type: "tick" }), PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  const view = viewStateOf(ui);
  const viewKey = JSON.stringify(view);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    vscode.postMessage({ type: "viewState", state: JSON.parse(viewKey) as VizViewState });
  }, [viewKey]);

  const stageKey = ui.stage.kind === "overview" ? "overview" : `flow:${ui.stage.flow}`;
  return (
    <div className={`viz-app ${ui.mode.kind === "walk" ? "viz-app--walk" : ""}`}>
      <Header
        doc={doc}
        index={index}
        ui={ui}
        window={windowState}
        vizzes={vizzes}
        review={review}
        dispatch={dispatch}
        onExport={onExport}
        onNext={onNext}
      />
      {loaded.invalid && (
        <InvalidBanner name={loaded.invalid.name} issues={loaded.invalid.issues} />
      )}
      <div className="viz-body">
        <main className="viz-stage">
          {error ? (
            <EmptyState error={error} />
          ) : graph ? (
            <Canvas
              stageKey={stageKey}
              graph={graph}
              index={index}
              emphasis={emphasis}
              ui={ui}
              scene={sequence ? undefined : scene}
              sequence={sequence}
              notes={notes}
              review={review}
              targets={targets}
              dispatch={dispatch}
              openFile={openFile}
            />
          ) : (
            <div className="viz-loading">Laying out…</div>
          )}
          <Toolbar
            index={index}
            ui={ui}
            review={review}
            searchRef={searchRef}
            dispatch={dispatch}
          />
          {ui.stage.kind === "overview" && ui.mode.kind !== "walk" && (
            <Legend index={index} ui={ui} dispatch={dispatch} />
          )}
          <PlayBar index={index} ui={ui} dispatch={dispatch} />
          <WalkCard index={index} ui={ui} dispatch={dispatch} />
          {!ui.sidebar && (
            <button
              type="button"
              className="viz-show-side"
              title="Show the selection side bar (b)"
              onClick={() => dispatch({ type: "toggleSidebar" })}
            >
              <UiIcon name="sidebar" size={14} /> Show selection
            </button>
          )}
        </main>
        {ui.sidebar && <Sidebar index={index} ui={ui} review={review} dispatch={dispatch} />}
      </div>
      <AgentBar review={review} placing={ui.thread.kind === "placing"} dispatch={dispatch} />
      <HelpOverlay ui={ui} dispatch={dispatch} />
    </div>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "blank" });
  const [request, setRequest] = useState<Request>();
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const message = event.data;
      switch (message.type) {
        case "load":
          vscode.setState({ vizId: message.doc.meta.name });
          setScreen({
            kind: "loaded",
            loaded: {
              doc: message.doc,
              index: buildVizIndex(message.doc.viz),
              vizzes: message.vizzes,
              window: message.window,
              review: message.review,
              view: message.view,
            },
          });
          break;
        case "empty":
          setScreen({ kind: "empty", vizzes: message.vizzes });
          break;
        case "invalid":
          setScreen((current) =>
            current.kind === "loaded"
              ? {
                  ...current,
                  loaded: {
                    ...current.loaded,
                    invalid: { name: message.name, issues: message.issues },
                  },
                }
              : current,
          );
          break;
        case "window":
        case "vizzes":
        case "review":
          setScreen((current) => {
            if (current.kind !== "loaded") {
              return current;
            }
            const loaded = { ...current.loaded };
            if (message.type === "window") {
              loaded.window = message.window;
            } else if (message.type === "vizzes") {
              loaded.vizzes = message.vizzes;
            } else {
              loaded.review = message.review;
            }
            return { kind: "loaded", loaded };
          });
          break;
        case "focus":
        case "showNote":
          setRequest((current) => ({ seq: (current?.seq ?? 0) + 1, message }));
          break;
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);
  if (screen.kind === "blank") {
    return <EmptyState />;
  }
  if (screen.kind === "empty") {
    return <EmptyState vizzes={screen.vizzes} />;
  }
  const { loaded } = screen;
  return (
    <Viz key={loaded.doc.meta.name + loaded.doc.meta.checkedAt} loaded={loaded} request={request} />
  );
}
