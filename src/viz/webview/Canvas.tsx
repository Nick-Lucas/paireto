import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { VizFileRef } from "../../protocol/viz";
import { union, type Point } from "../layout/geometry";
import type { OverviewScene } from "../layout/overview";
import { openingFrames, type Emphasis } from "../model/emphasis";
import type { VizIndex } from "../model/index";
import {
  edgeTarget,
  frameTargets,
  memberTarget,
  nodeTarget,
  relativePlace,
  stepTarget,
  type NoteKind,
  type PlacedNote,
} from "../model/notes";
import { parseVizRef } from "../model/refs";
import type { RfGraph } from "../model/rf";
import type { UiAction, UiState } from "../model/ui";
import type { VizNoteTarget, VizReviewState } from "../protocol";
import { VizContext, type MenuTarget, type VizActions } from "./context";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { UiIcon } from "./icons";
import { NODE_TYPES, EDGE_TYPES } from "./nodes";
import { ZOOM_KEY } from "./platform";
import { ThreadLayer, type Linking } from "./ThreadLayer";
import { reducedMotion, vscode } from "./vscode";
import "./canvas.css";

export interface CanvasProps {
  stageKey: string;
  graph: RfGraph;
  index: VizIndex;
  emphasis: Emphasis;
  ui: UiState;
  scene: OverviewScene | undefined;
  notes: readonly PlacedNote[];
  review: VizReviewState;
  targets: readonly VizNoteTarget[];
  dispatch: (action: UiAction) => void;
  openFile(file: VizFileRef, mode: "file" | "diff"): void;
}

const FIT = { padding: 0.08, duration: reducedMotion ? 0 : 500 };
const READABLE_ZOOM = 0.8;
const MIN_ZOOM = 0.2;

function Camera({
  camera,
  frames,
  graph,
}: {
  camera: Emphasis["camera"];
  frames: string[][];
  graph: RfGraph;
}) {
  const { fitView, setViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const opened = useRef(false);
  const key = camera?.join("|") ?? "";
  useEffect(() => {
    if (key || opened.current || width === 0 || height === 0) {
      return;
    }
    opened.current = true;
    const boxes = new Map(
      graph.nodes.map((node) => [
        node.id,
        { ...node.position, width: node.width, height: node.height },
      ]),
    );
    const view = (frame: string[], minZoom: number, maxZoom: number) =>
      getViewportForBounds(
        union(frame.flatMap((id) => boxes.get(id) ?? [])),
        width,
        height,
        minZoom,
        maxZoom,
        FIT.padding,
      );
    const [all, ...parts] = frames;
    if (!all) {
      return;
    }
    const whole = view(all, MIN_ZOOM, 1.2);
    if (whole.zoom >= READABLE_ZOOM) {
      void setViewport(whole);
      return;
    }
    const part =
      parts.find((frame) => view(frame, MIN_ZOOM, 1.2).zoom >= READABLE_ZOOM) ??
      parts.at(-1) ??
      all;
    void setViewport(view(part, READABLE_ZOOM, READABLE_ZOOM));
  }, [key, frames, graph, width, height, setViewport]);
  useEffect(() => {
    if (!key) {
      return;
    }
    opened.current = true;
    const nodes = key.split("|").map((id) => ({ id }));
    const frame = requestAnimationFrame(() => {
      void fitView({ ...FIT, padding: 0.35, maxZoom: 1.1, nodes });
    });
    return () => cancelAnimationFrame(frame);
  }, [key, fitView]);
  return null;
}

function Reveal({ reveal, graph }: { reveal: UiState["reveal"]; graph: RfGraph }) {
  const { getViewport, setCenter } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    if (!reveal) {
      return;
    }
    const node = graph.nodes.find((candidate) => candidate.id === reveal.id);
    if (!node || width === 0) {
      return;
    }
    const { x, y, zoom } = getViewport();
    const left = node.position.x * zoom + x;
    const top = node.position.y * zoom + y;
    const inside =
      left >= 0 &&
      top >= 0 &&
      left + node.width * zoom <= width &&
      top + node.height * zoom <= height;
    if (inside) {
      return;
    }
    void setCenter(node.position.x + node.width / 2, node.position.y + node.height / 2, {
      zoom: Math.min(1.2, Math.max(zoom, 0.8)),
      duration: FIT.duration,
    });
  }, [reveal, graph, width, height, getViewport, setCenter]);
  return null;
}

export function Canvas(props: CanvasProps) {
  const { stageKey, graph, index, emphasis, ui, scene, dispatch, openFile } = props;
  const frames = useMemo(() => {
    const [all, ...parts] = openingFrames(index, ui.stage);
    const notes = graph.nodes.filter((node) => node.type === "note").map((node) => node.id);
    return all ? [[...all, ...notes], ...parts] : [];
  }, [index, ui.stage, graph]);
  const [menu, setMenu] = useState<MenuState>();
  const [linking, setLinking] = useState<Linking>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const select = (id: string) => {
    const ref = parseVizRef(id, index);
    if (ref) {
      dispatch({ type: "select", ref });
    }
  };
  const noteItems = (targets: VizNoteTarget[], at: Point): MenuItem[] =>
    (["comment", "question"] as NoteKind[]).map((noteKind) => ({
      label: noteKind === "comment" ? "Add comment" : "Add question",
      run: () =>
        dispatch({
          type: "startDraft",
          noteKind,
          targets,
          place: targets.length === 0 && scene ? relativePlace(scene, at) : undefined,
          at,
        }),
    }));
  const fileItems = (file: VizFileRef | undefined): MenuItem[] =>
    file
      ? [
          { label: "Open diff", run: () => openFile(file, "diff") },
          { label: "Open file", run: () => openFile(file, "file") },
        ]
      : [];
  const openMenu = (target: MenuTarget, screen: Point) => {
    let title: string | undefined;
    let items: MenuItem[] = [];
    switch (target.kind) {
      case "node": {
        const node = index.nodeById.get(target.id);
        const noteTarget = nodeTarget(index, target.id);
        title = node?.label;
        items = [
          ...noteItems(noteTarget ? [noteTarget] : [], target.at ?? { x: 0, y: 0 }),
          ...fileItems(node?.files?.[0]),
          { label: "Focus on its links", run: () => dispatch({ type: "focus" }) },
        ];
        break;
      }
      case "member": {
        const member = index.memberById.get(target.id);
        const noteTarget = memberTarget(index, target.id);
        title = noteTarget?.label;
        items = [
          ...noteItems(noteTarget ? [noteTarget] : [], { x: 0, y: 0 }),
          ...fileItems(member?.member.file ?? member?.node.files?.[0]),
        ];
        break;
      }
      case "frame":
        title = target.frame.label;
        items = noteItems(frameTargets(index, target.frame), {
          x: target.frame.x,
          y: target.frame.y,
        });
        break;
      case "edge": {
        const noteTarget = edgeTarget(index, target.id);
        title = noteTarget?.label;
        items = noteItems(noteTarget ? [noteTarget] : [], { x: 0, y: 0 });
        break;
      }
      case "step": {
        const step = index.flowById.get(target.flow)?.steps[target.index];
        const noteTarget = stepTarget(index, target.flow, target.index);
        title = noteTarget?.label;
        items = [
          ...noteItems(noteTarget ? [noteTarget] : [], { x: 0, y: 0 }),
          ...fileItems(step?.files[0]),
          ...(step
            ? [
                {
                  label: "Show in Overview",
                  run: () => dispatch({ type: "goto", ref: step.overviewRef }),
                },
              ]
            : []),
        ];
        break;
      }
      case "pane":
        title = "Diagram";
        items =
          ui.stage.kind === "overview"
            ? noteItems([], target.at).map((item) => ({ ...item, label: `${item.label} here` }))
            : [];
        break;
      case "note":
        items = [
          { label: "Link to a part…", run: () => setLinking({ note: target.id, kind: "pick" }) },
          { label: "Show the thread", run: () => dispatch({ type: "openThread", id: target.id }) },
          {
            label: "Resolve",
            run: () => vscode.postMessage({ type: "note.resolve", id: target.id }),
          },
          {
            label: "Delete",
            run: () => vscode.postMessage({ type: "note.delete", id: target.id }),
          },
        ];
        break;
    }
    if (items.length > 0) {
      setMenu({ x: screen.x, y: screen.y, title, items });
    }
  };
  const actions: VizActions = {
    index,
    dispatch,
    openFile,
    openMenu,
    startLink: (noteId, pointerId) => setLinking({ note: noteId, kind: "drag", pointerId }),
  };
  return (
    <VizContext.Provider value={actions}>
      <ReactFlowProvider key={stageKey}>
        <ReactFlow
          className={`viz-canvas ${emphasis.veil ? "viz-canvas--veiled" : ""} ${linking ? "viz-linking" : ""}`}
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          minZoom={MIN_ZOOM}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          selectNodesOnDrag={false}
          zoomOnDoubleClick={false}
          panOnScroll
          panOnScrollSpeed={1}
          zoomOnScroll={false}
          zoomActivationKeyCode={ZOOM_KEY}
          onNodeClick={(_, node) => {
            if (node.type !== "note") {
              select(node.id);
            }
          }}
          onEdgeClick={(_, edge) => select(edge.id)}
          onPaneClick={() => dispatch({ type: "select", ref: undefined })}
          onNodeDoubleClick={(_, node) => {
            if (node.type === "card" || node.type === "classBox") {
              dispatch({ type: "select", ref: { kind: "node", id: node.id } });
              dispatch({ type: "focus" });
            }
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            if (node.type === "message" && node.data.kind === "message") {
              select(node.id);
              openMenu(
                { kind: "step", flow: node.data.step.flow, index: node.data.step.index },
                { x: event.clientX, y: event.clientY },
              );
              return;
            }
            if (node.type === "classBox" || node.type === "card" || node.type === "participant") {
              select(node.id);
              openMenu(
                { kind: "node", id: node.id, at: node.position },
                { x: event.clientX, y: event.clientY },
              );
            }
          }}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            if (edge.type === "viz") {
              select(edge.id);
              openMenu({ kind: "edge", id: edge.id }, { x: event.clientX, y: event.clientY });
            }
          }}
          onNodeDragStop={(_, node) => {
            if (node.type === "note" && scene && node.data.kind === "note" && node.data.note.note) {
              vscode.postMessage({
                type: "note.move",
                id: node.data.note.id,
                place: relativePlace(scene, node.position),
              });
            }
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.2}
            className="viz-dots-bg"
          />
          <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT}>
            <ControlButton
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
              onClick={() => dispatch({ type: "toggleHelp" })}
            >
              <UiIcon name="help" size={14} />
            </ControlButton>
          </Controls>
          {ui.minimap && (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              className="viz-minimap"
              nodeStrokeWidth={2}
            />
          )}
          <Camera camera={emphasis.camera} frames={frames} graph={graph} />
          <Reveal reveal={ui.reveal} graph={graph} />
          <PaneMenu openMenu={openMenu} />
          <ThreadLayer
            ui={ui}
            index={index}
            scene={scene}
            notes={props.notes}
            review={props.review}
            targets={props.targets}
            linking={linking}
            setLinking={setLinking}
            dispatch={dispatch}
          />
        </ReactFlow>
      </ReactFlowProvider>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </VizContext.Provider>
  );
}

function PaneMenu({ openMenu }: { openMenu(target: MenuTarget, screen: Point): void }) {
  const { screenToFlowPosition } = useReactFlow();
  const domNode = useStore((state) => state.domNode);
  useEffect(() => {
    if (!domNode) {
      return;
    }
    const onContext = (event: MouseEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.closest(".react-flow__node, .react-flow__edge, .viz-thread, .viz-tb")) {
        return;
      }
      event.preventDefault();
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      openMenu({ kind: "pane", at }, { x: event.clientX, y: event.clientY });
    };
    domNode.addEventListener("contextmenu", onContext);
    return () => domNode.removeEventListener("contextmenu", onContext);
  }, [domNode, openMenu, screenToFlowPosition]);
  return null;
}
