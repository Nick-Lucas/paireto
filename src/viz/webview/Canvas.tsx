import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";

import { union } from "../layout/geometry";
import { openingFrames, type Emphasis } from "../model/emphasis";
import type { VizIndex } from "../model/index";
import { parseVizRef } from "../model/refs";
import type { RfGraph } from "../model/rf";
import type { UiAction, UiState } from "../model/ui";
import { NODE_TYPES } from "./nodes";
import { EDGE_TYPES } from "./VizEdge";
import { reducedMotion } from "./vscode";
import "./canvas.css";

interface CanvasProps {
  stageKey: string;
  graph: RfGraph;
  index: VizIndex;
  emphasis: Emphasis;
  ui: UiState;
  dispatch: (action: UiAction) => void;
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

export function Canvas(props: CanvasProps) {
  const { stageKey, graph, index, emphasis, ui, dispatch } = props;
  const frames = useMemo(() => openingFrames(index, ui.stage), [index, ui.stage]);
  const select = (id: string) => {
    const ref = parseVizRef(id, index.flowById);
    if (ref) {
      dispatch({ type: "select", ref });
    }
  };
  return (
    <ReactFlowProvider key={stageKey}>
      <ReactFlow
        className={`viz-canvas ${emphasis.veil ? "viz-canvas--veiled" : ""}`}
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
        attributionPosition="top-right"
        onNodeClick={(_, node) => select(node.id)}
        onEdgeClick={(_, edge) => select(edge.id)}
        onPaneClick={() => dispatch({ type: "select", ref: undefined })}
        onNodeDoubleClick={(_, node) => {
          if (node.type === "card") {
            dispatch({ type: "select", ref: { kind: "node", id: node.id } });
            dispatch({ type: "focus" });
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} className="viz-dots-bg" />
        <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT} />
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
      </ReactFlow>
    </ReactFlowProvider>
  );
}
