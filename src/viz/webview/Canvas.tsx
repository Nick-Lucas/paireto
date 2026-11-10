import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import type { Emphasis } from "../model/emphasis";
import type { VizIndex } from "../model/index";
import { formatVizRef, parseVizRef } from "../model/refs";
import type { RfGraph } from "../model/rf";
import type { VizRef } from "../model/types";
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

function cameraNodeIds(
  index: VizIndex,
  refs: readonly VizRef[],
  stage: UiState["stage"],
): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    switch (ref.kind) {
      case "node":
        ids.add(ref.id);
        break;
      case "edge": {
        const edge = index.edgesByKey.get(ref.key);
        if (edge) {
          ids.add(edge.from);
          ids.add(edge.to);
        }
        break;
      }
      case "flow":
        for (const participant of index.flowById.get(ref.id)?.participants ?? []) {
          ids.add(participant);
        }
        break;
      case "step":
        if (stage.kind === "flow" && stage.flow === ref.flow) {
          ids.add(formatVizRef(ref));
          const step = index.flowById.get(ref.flow)?.steps[ref.index];
          if (step) {
            ids.add(step.from);
            ids.add(step.to);
          }
        }
        break;
    }
  }
  return [...ids];
}

function Camera({ index, emphasis, ui }: Pick<CanvasProps, "index" | "emphasis" | "ui">) {
  const { fitView } = useReactFlow();
  const key = useMemo(
    () => (emphasis.camera ? cameraNodeIds(index, emphasis.camera, ui.stage).join("|") : ""),
    [index, emphasis.camera, ui.stage],
  );
  useEffect(() => {
    if (!key) {
      return;
    }
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
  const nodes = graph.nodes as unknown as Node[];
  const edges = graph.edges as unknown as Edge[];
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
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={FIT}
        minZoom={0.2}
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
        <Controls showInteractive={false} position="bottom-left" />
        {ui.minimap && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="viz-minimap"
            nodeStrokeWidth={2}
          />
        )}
        <Camera index={index} emphasis={emphasis} ui={ui} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
