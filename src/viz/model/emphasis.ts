import type { VizDelta } from "../../protocol/viz.js";
import { searchMatches, type VizIndex } from "./index.js";
import { edgeKey, formatVizRef } from "./refs.js";
import type { EdgeKey, VizRef } from "./types.js";
import type { UiState } from "./ui.js";

export type Level = "bright" | "normal" | "dim";

export interface Emphasis {
  readonly nodes: ReadonlyMap<string, Level>;
  readonly edges: ReadonlyMap<EdgeKey, Level>;
  readonly steps: ReadonlyMap<number, Level>;
  readonly camera: readonly VizRef[] | undefined;
  readonly veil: boolean;
  readonly cursor: number | undefined;
}

type Levels = {
  nodes: Map<string, Level>;
  edges: Map<EdgeKey, Level>;
  steps: Map<number, Level>;
};

function fill(levels: Levels, level: Level): void {
  for (const key of levels.nodes.keys()) {
    levels.nodes.set(key, level);
  }
  for (const key of levels.edges.keys()) {
    levels.edges.set(key, level);
  }
  for (const key of levels.steps.keys()) {
    levels.steps.set(key, level);
  }
}

function baseLevels(index: VizIndex, ui: UiState): Levels {
  const levels: Levels = { nodes: new Map(), edges: new Map(), steps: new Map() };
  const shown = (delta: VizDelta) => ui.deltaFilter.has(delta);
  if (ui.stage.kind === "overview") {
    for (const node of index.nodes) {
      if (!node.flowOnly) {
        levels.nodes.set(node.id, shown(node.delta) ? "normal" : "dim");
      }
    }
    for (const edge of index.edges) {
      const endpointsShown =
        levels.nodes.get(edge.from) !== "dim" && levels.nodes.get(edge.to) !== "dim";
      levels.edges.set(
        edgeKey(edge.from, edge.to),
        shown(edge.delta) && endpointsShown ? "normal" : "dim",
      );
    }
    return levels;
  }
  const flow = index.flowById.get(ui.stage.flow);
  if (!flow) {
    return levels;
  }
  for (const participant of flow.participants) {
    levels.nodes.set(participant, "normal");
  }
  for (const step of flow.steps) {
    levels.steps.set(step.index, shown(step.delta) ? "normal" : "dim");
  }
  return levels;
}

function applyRefs(levels: Levels, index: VizIndex, refs: readonly VizRef[]): void {
  fill(levels, "dim");
  for (const ref of refs) {
    switch (ref.kind) {
      case "node":
        if (levels.nodes.has(ref.id)) {
          levels.nodes.set(ref.id, "bright");
        }
        break;
      case "edge": {
        const edge = index.edgesByKey.get(ref.key);
        if (edge && levels.edges.has(ref.key)) {
          levels.edges.set(ref.key, "bright");
          for (const id of [edge.from, edge.to]) {
            if (levels.nodes.get(id) === "dim") {
              levels.nodes.set(id, "normal");
            }
          }
        }
        break;
      }
      case "flow":
        for (const key of levels.steps.keys()) {
          levels.steps.set(key, "bright");
        }
        for (const key of levels.nodes.keys()) {
          levels.nodes.set(key, "normal");
        }
        break;
      case "step":
        if (levels.steps.has(ref.index)) {
          levels.steps.set(ref.index, "bright");
        }
        break;
    }
  }
}

function applyPlay(levels: Levels, index: VizIndex, flow: string, cursor: number): void {
  const steps = index.flowById.get(flow)?.steps ?? [];
  for (const step of steps) {
    levels.steps.set(
      step.index,
      step.index < cursor ? "normal" : step.index === cursor ? "bright" : "dim",
    );
  }
  for (const key of levels.nodes.keys()) {
    levels.nodes.set(key, "normal");
  }
  const current = steps[cursor];
  if (current) {
    levels.nodes.set(current.from, "bright");
    levels.nodes.set(current.to, "bright");
  }
}

function neighbourhood(index: VizIndex, node: string): { nodes: Set<string>; edges: Set<EdgeKey> } {
  const nodes = new Set([node]);
  const edges = new Set<EdgeKey>();
  for (const key of [...(index.outEdges.get(node) ?? []), ...(index.inEdges.get(node) ?? [])]) {
    const edge = index.edgesByKey.get(key);
    if (edge) {
      edges.add(key);
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  }
  return { nodes, edges };
}

function applyQuery(levels: Levels, index: VizIndex, ui: UiState): void {
  const hits = searchMatches(index, ui.query);
  fill(levels, "dim");
  for (const key of levels.nodes.keys()) {
    if (hits.has(formatVizRef({ kind: "node", id: key }))) {
      levels.nodes.set(key, "bright");
    }
  }
  for (const key of levels.edges.keys()) {
    if (hits.has(formatVizRef({ kind: "edge", key }))) {
      levels.edges.set(key, "bright");
    }
  }
  if (ui.stage.kind === "flow") {
    for (const key of levels.steps.keys()) {
      if (hits.has(formatVizRef({ kind: "step", flow: ui.stage.flow, index: key }))) {
        levels.steps.set(key, "bright");
      }
    }
  }
}

export function emphasisOf(index: VizIndex, ui: UiState): Emphasis {
  const levels = baseLevels(index, ui);
  const { mode } = ui;
  if (mode.kind === "walk") {
    const step = index.walkthrough[mode.step];
    const refs = step?.refs ?? [];
    applyRefs(levels, index, refs);
    return { ...levels, camera: refs, veil: true, cursor: undefined };
  }
  if (mode.kind === "play" && ui.stage.kind === "flow" && ui.stage.flow === mode.flow) {
    applyPlay(levels, index, mode.flow, mode.step);
    const ref: VizRef = { kind: "step", flow: mode.flow, index: mode.step };
    return { ...levels, camera: [ref], veil: true, cursor: mode.step };
  }
  if (mode.kind === "focus" && ui.stage.kind === "overview") {
    const near = neighbourhood(index, mode.node);
    fill(levels, "dim");
    for (const id of near.nodes) {
      if (levels.nodes.has(id)) {
        levels.nodes.set(id, "bright");
      }
    }
    for (const key of near.edges) {
      levels.edges.set(key, "bright");
    }
    const camera = [...near.nodes].map((id): VizRef => ({ kind: "node", id }));
    return { ...levels, camera, veil: false, cursor: undefined };
  }
  if (ui.query.trim()) {
    applyQuery(levels, index, ui);
  }
  return { ...levels, camera: undefined, veil: false, cursor: undefined };
}
