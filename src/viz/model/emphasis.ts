import type { VizDelta } from "../../protocol/viz.js";
import { searchMatches, stepAt, type Stage, type VizIndex } from "./index.js";
import { formatVizRef } from "./refs.js";
import { NO_MARKS, type ReviewMarks } from "./review.js";
import type { VizRef } from "./types.js";
import type { UiState } from "./ui.js";

export type Level = "bright" | "normal" | "dim";

export interface Emphasis {
  readonly nodes: ReadonlyMap<string, Level>;
  readonly edges: ReadonlyMap<string, Level>;
  readonly steps: ReadonlyMap<number, Level>;
  readonly camera: readonly string[] | undefined;
  readonly veil: boolean;
  readonly cursor: number | undefined;
}

type Levels = {
  nodes: Map<string, Level>;
  edges: Map<string, Level>;
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

function baseLevels(index: VizIndex, ui: UiState, marks: ReviewMarks): Levels {
  const levels: Levels = { nodes: new Map(), edges: new Map(), steps: new Map() };
  const shown = (delta: VizDelta) => ui.deltaFilter.has(delta);
  if (ui.stage.kind === "overview") {
    for (const node of index.overviewNodes) {
      if (index.childrenByParent.has(node.id)) {
        continue;
      }
      const passes =
        shown(node.delta) &&
        !(ui.filters.notSeen && marks.seen.has(node.id)) &&
        !(ui.filters.openThreads && !marks.threads.has(node.id));
      levels.nodes.set(node.id, passes ? "normal" : "dim");
    }
    for (const edge of index.edges) {
      const endpointsShown =
        levels.nodes.get(edge.from) !== "dim" && levels.nodes.get(edge.to) !== "dim";
      levels.edges.set(edge.id, shown(edge.delta) && endpointsShown ? "normal" : "dim");
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
      case "member": {
        const node = ref.kind === "node" ? ref.id : ref.node;
        if (levels.nodes.has(node)) {
          levels.nodes.set(node, "bright");
        }
        break;
      }
      case "edge": {
        const edge = index.edgeById.get(ref.id);
        if (edge && levels.edges.has(ref.id)) {
          levels.edges.set(ref.id, "bright");
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

function cameraIds(index: VizIndex, refs: readonly VizRef[]): string[] {
  const ids = new Set<string>();
  const node = (id: string) => ids.add(formatVizRef({ kind: "node", id }));
  for (const ref of refs) {
    switch (ref.kind) {
      case "node":
        node(ref.id);
        break;
      case "member":
        node(ref.node);
        break;
      case "edge": {
        const edge = index.edgeById.get(ref.id);
        if (edge) {
          node(edge.from);
          node(edge.to);
        }
        break;
      }
      case "flow":
        index.flowById.get(ref.id)?.participants.forEach(node);
        break;
      case "step": {
        const step = stepAt(index, ref);
        if (step) {
          ids.add(formatVizRef(ref));
          node(step.from);
          node(step.to);
        }
        break;
      }
    }
  }
  return [...ids];
}

export function openingFrames(index: VizIndex, stage: Stage): string[][] {
  if (stage.kind === "flow") {
    const flow = index.flowById.get(stage.flow);
    if (!flow) {
      return [];
    }
    const steps = flow.steps.map((step): VizRef => ({
      kind: "step",
      flow: flow.id,
      index: step.index,
    }));
    return [cameraIds(index, steps), cameraIds(index, steps.slice(0, 4))];
  }
  const nodes = (list: readonly { id: string }[]) =>
    cameraIds(
      index,
      list.map(({ id }): VizRef => ({ kind: "node", id })),
    );
  const hero = index.edges.find((edge) => edge.hero);
  return [
    nodes(index.overviewNodes),
    nodes(index.overviewNodes.filter((node) => node.delta !== "unchanged")),
    hero ? cameraIds(index, [{ kind: "edge", id: hero.id }]) : [],
  ].filter((frame) => frame.length > 0);
}

function neighbourhood(index: VizIndex, node: string): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set([node]);
  const edges = new Set<string>();
  for (const key of [...(index.outEdges.get(node) ?? []), ...(index.inEdges.get(node) ?? [])]) {
    const edge = index.edgeById.get(key);
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
    if (hits.has(formatVizRef({ kind: "edge", id: key }))) {
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

function applySelection(levels: Levels, index: VizIndex, selection: VizRef): void {
  const node =
    selection.kind === "node"
      ? selection.id
      : selection.kind === "member"
        ? selection.node
        : undefined;
  if (node === undefined) {
    if (selection.kind === "edge" && levels.edges.has(selection.id)) {
      for (const key of levels.edges.keys()) {
        if (levels.edges.get(key) !== "dim") {
          levels.edges.set(key, key === selection.id ? "bright" : "dim");
        }
      }
    }
    return;
  }
  const near = neighbourhood(index, node);
  if (near.edges.size === 0) {
    return;
  }
  for (const key of levels.edges.keys()) {
    if (levels.edges.get(key) !== "dim") {
      levels.edges.set(key, near.edges.has(key) ? "bright" : "dim");
    }
  }
}

export function emphasisOf(index: VizIndex, ui: UiState, marks: ReviewMarks = NO_MARKS): Emphasis {
  const levels = baseLevels(index, ui, marks);
  const { mode } = ui;
  if (mode.kind === "walk") {
    const step = index.walkthrough[mode.step];
    const refs = step?.refs ?? [];
    applyRefs(levels, index, refs);
    return { ...levels, camera: cameraIds(index, refs), veil: true, cursor: undefined };
  }
  if (mode.kind === "play" && ui.stage.kind === "flow" && ui.stage.flow === mode.flow) {
    applyPlay(levels, index, mode.flow, mode.step);
    const ref: VizRef = { kind: "step", flow: mode.flow, index: mode.step };
    return { ...levels, camera: cameraIds(index, [ref]), veil: true, cursor: mode.step };
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
    const camera = cameraIds(
      index,
      [...near.nodes].map((id): VizRef => ({ kind: "node", id })),
    );
    return { ...levels, camera, veil: false, cursor: undefined };
  }
  if (ui.query.trim()) {
    applyQuery(levels, index, ui);
  } else if (ui.selection && ui.stage.kind === "overview") {
    applySelection(levels, index, ui.selection);
  }
  return { ...levels, camera: undefined, veil: false, cursor: undefined };
}
