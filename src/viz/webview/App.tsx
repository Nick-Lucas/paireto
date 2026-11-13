import ELK from "elkjs/lib/elk.bundled.js";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { layoutOverview, type OverviewScene } from "../layout/overview";
import { layoutSequence } from "../layout/sequence";
import { emphasisOf } from "../model/emphasis";
import { buildVizIndex, type VizIndex } from "../model/index";
import { resolveKey } from "../model/keymap";
import { toMermaid } from "../model/mermaid";
import { toOverviewRf, toSequenceRf, type RfGraph } from "../model/rf";
import type { VizDoc } from "../model/types";
import { initialUi, reduceUi, type UiAction, type UiState } from "../model/ui";
import type { HostToWebview, VizHistoryEntry, VizWindowState } from "../protocol";
import { Canvas } from "./Canvas";
import { Header } from "./Header";
import { Inspector } from "./Inspector";
import { EmptyState, HelpOverlay, PlayBar, WalkCard } from "./overlays";
import { vscode } from "./vscode";

const elk = new ELK();
const PLAY_INTERVAL_MS = 1400;

interface Loaded {
  doc: VizDoc;
  index: VizIndex;
  history: VizHistoryEntry[];
  window: VizWindowState;
}

function useOverviewScene(index: VizIndex | undefined): { scene?: OverviewScene; error?: string } {
  const [state, setState] = useState<{ index?: VizIndex; scene?: OverviewScene; error?: string }>(
    {},
  );
  useEffect(() => {
    if (!index) {
      return;
    }
    let cancelled = false;
    layoutOverview(index, elk)
      .then((scene) => !cancelled && setState({ index, scene }))
      .catch((error: unknown) => !cancelled && setState({ index, error: String(error) }));
    return () => {
      cancelled = true;
    };
  }, [index]);
  return state.index === index ? state : {};
}

function Viz({ loaded }: { loaded: Loaded }) {
  const { doc, index, history, window: windowState } = loaded;
  const [ui, dispatch] = useReducer(
    (state: UiState, action: UiAction) => reduceUi(index, state, action),
    undefined,
    initialUi,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const { scene, error } = useOverviewScene(index);
  const emphasis = useMemo(() => emphasisOf(index, ui), [index, ui]);
  const sequence = useMemo(
    () => (ui.stage.kind === "flow" ? layoutSequence(index, ui.stage.flow) : undefined),
    [index, ui.stage],
  );
  const graph: RfGraph | undefined = useMemo(() => {
    if (ui.stage.kind === "flow" && sequence) {
      return toSequenceRf(sequence, index, emphasis, ui);
    }
    return scene ? toOverviewRf(scene, index, emphasis, ui) : undefined;
  }, [ui, sequence, scene, index, emphasis]);

  const onExport = useCallback(() => {
    vscode.postMessage({
      type: "copy",
      text: toMermaid(index, ui.stage),
      what: ui.stage.kind === "overview" ? "Mermaid flowchart" : "Mermaid sequence diagram",
    });
  }, [index, ui.stage]);

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
      if (command.effect === "search") {
        searchRef.current?.focus();
        searchRef.current?.select();
      } else {
        onExport();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExport]);

  const running = ui.mode.kind === "play" && ui.mode.running;
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => dispatch({ type: "tick" }), PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  const stageKey = ui.stage.kind === "overview" ? "overview" : `flow:${ui.stage.flow}`;
  return (
    <div className={`viz-app ${ui.mode.kind === "walk" ? "viz-app--walk" : ""}`}>
      <Header
        doc={doc}
        index={index}
        ui={ui}
        window={windowState}
        history={history}
        searchRef={searchRef}
        dispatch={dispatch}
        onExport={onExport}
      />
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
              dispatch={dispatch}
            />
          ) : (
            <div className="viz-loading">Laying out…</div>
          )}
          <PlayBar index={index} ui={ui} dispatch={dispatch} />
          <WalkCard index={index} ui={ui} dispatch={dispatch} />
        </main>
        <Inspector index={index} stage={ui.stage} selection={ui.selection} dispatch={dispatch} />
      </div>
      <HelpOverlay ui={ui} dispatch={dispatch} />
    </div>
  );
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const message = event.data;
      if (message.type === "load") {
        vscode.setState({ vizId: message.doc.meta.id });
        setLoaded({
          doc: message.doc,
          index: buildVizIndex(message.doc.viz),
          history: message.history,
          window: message.window,
        });
      } else if (message.type === "window") {
        setLoaded((current) => (current ? { ...current, window: message.window } : current));
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);
  if (!loaded) {
    return <EmptyState />;
  }
  return <Viz key={loaded.doc.meta.id + loaded.doc.meta.createdAt} loaded={loaded} />;
}
