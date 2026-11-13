import type { VizDelta } from "../../protocol/viz.js";
import { OVERVIEW, refInStage, sameStage, type Stage, type VizIndex } from "./index.js";
import type { VizRef } from "./types.js";

export type Mode =
  | { readonly kind: "explore" }
  | { readonly kind: "focus"; readonly node: string }
  | { readonly kind: "walk"; readonly step: number }
  | {
      readonly kind: "play";
      readonly flow: string;
      readonly step: number;
      readonly running: boolean;
    };

export const ALL_DELTAS: readonly VizDelta[] = ["added", "changed", "deleted", "unchanged"];

export interface UiState {
  readonly stage: Stage;
  readonly mode: Mode;
  readonly selection: VizRef | undefined;
  readonly deltaFilter: ReadonlySet<VizDelta>;
  readonly query: string;
  readonly help: boolean;
  readonly minimap: boolean;
}

export type UiAction =
  | { readonly type: "stage"; readonly stage: Stage }
  | { readonly type: "stageAt"; readonly n: number }
  | { readonly type: "select"; readonly ref: VizRef | undefined }
  | { readonly type: "goto"; readonly ref: VizRef; readonly stage?: Stage }
  | { readonly type: "focus" }
  | { readonly type: "walk" }
  | { readonly type: "next" }
  | { readonly type: "prev" }
  | { readonly type: "playToggle" }
  | { readonly type: "tick" }
  | { readonly type: "toggleDelta"; readonly delta: VizDelta }
  | { readonly type: "query"; readonly query: string }
  | { readonly type: "toggleHelp" }
  | { readonly type: "toggleMinimap" }
  | { readonly type: "escape" };

const EXPLORE: Mode = { kind: "explore" };

export function initialUi(): UiState {
  return {
    stage: OVERVIEW,
    mode: EXPLORE,
    selection: undefined,
    deltaFilter: new Set(ALL_DELTAS),
    query: "",
    help: false,
    minimap: true,
  };
}

function stageOfRef(index: VizIndex, ref: VizRef, current: Stage): Stage {
  switch (ref.kind) {
    case "node":
      return refInStage(index, ref, current) ? current : OVERVIEW;
    case "edge":
      return OVERVIEW;
    case "flow":
      return { kind: "flow", flow: ref.id };
    case "step":
      return { kind: "flow", flow: ref.flow };
  }
}

function enterStage(index: VizIndex, ui: UiState, stage: Stage): UiState {
  const selection =
    ui.selection && refInStage(index, ui.selection, stage) ? ui.selection : undefined;
  return { ...ui, stage, mode: EXPLORE, selection };
}

function walkTo(index: VizIndex, ui: UiState, step: number): UiState {
  const target = index.walkthrough[step];
  if (!target) {
    return { ...ui, mode: EXPLORE };
  }
  return { ...ui, stage: target.stage, mode: { kind: "walk", step }, selection: undefined };
}

function playAt(ui: UiState, flow: string, step: number, running: boolean): UiState {
  return {
    ...ui,
    mode: { kind: "play", flow, step, running },
    selection: { kind: "step", flow, index: step },
  };
}

function stepCount(index: VizIndex, flow: string): number {
  return index.flowById.get(flow)?.steps.length ?? 0;
}

function move(index: VizIndex, ui: UiState, by: 1 | -1): UiState {
  const { mode } = ui;
  switch (mode.kind) {
    case "walk":
      return mode.step + by < 0 ? ui : walkTo(index, ui, mode.step + by);
    case "play": {
      const next = mode.step + by;
      if (next < 0 || next >= stepCount(index, mode.flow)) {
        return ui;
      }
      return playAt(ui, mode.flow, next, false);
    }
    case "explore":
    case "focus":
      if (ui.stage.kind !== "flow" || stepCount(index, ui.stage.flow) === 0) {
        return ui;
      }
      return playAt(ui, ui.stage.flow, 0, false);
  }
}

export function reduceUi(index: VizIndex, ui: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "stage":
      return sameStage(ui.stage, action.stage) && ui.mode.kind === "explore"
        ? ui
        : enterStage(index, ui, action.stage);
    case "stageAt": {
      if (action.n === 0) {
        return reduceUi(index, ui, { type: "stage", stage: OVERVIEW });
      }
      const flow = index.flows[action.n - 1];
      return flow
        ? reduceUi(index, ui, { type: "stage", stage: { kind: "flow", flow: flow.id } })
        : ui;
    }
    case "select": {
      if (action.ref && !refInStage(index, action.ref, ui.stage)) {
        return ui;
      }
      if (ui.mode.kind === "play" && action.ref?.kind === "step") {
        return playAt(ui, ui.mode.flow, action.ref.index, false);
      }
      const mode = ui.mode.kind === "walk" ? EXPLORE : ui.mode;
      return { ...ui, mode, selection: action.ref };
    }
    case "goto": {
      const stage = action.stage ?? stageOfRef(index, action.ref, ui.stage);
      const entered = sameStage(stage, ui.stage)
        ? { ...ui, mode: EXPLORE }
        : enterStage(index, ui, stage);
      return reduceUi(index, entered, { type: "select", ref: action.ref });
    }
    case "focus": {
      if (ui.mode.kind === "focus") {
        return { ...ui, mode: EXPLORE };
      }
      if (ui.stage.kind !== "overview" || ui.selection?.kind !== "node") {
        return ui;
      }
      return { ...ui, mode: { kind: "focus", node: ui.selection.id } };
    }
    case "walk":
      return index.walkthrough.length === 0 ? ui : walkTo(index, ui, 0);
    case "next":
      return move(index, ui, 1);
    case "prev":
      return move(index, ui, -1);
    case "playToggle": {
      if (ui.mode.kind === "play") {
        return { ...ui, mode: { ...ui.mode, running: !ui.mode.running } };
      }
      if (ui.stage.kind !== "flow" || stepCount(index, ui.stage.flow) === 0) {
        return ui;
      }
      return playAt(ui, ui.stage.flow, 0, true);
    }
    case "tick": {
      if (ui.mode.kind !== "play" || !ui.mode.running) {
        return ui;
      }
      const next = ui.mode.step + 1;
      if (next >= stepCount(index, ui.mode.flow)) {
        return { ...ui, mode: { ...ui.mode, running: false } };
      }
      return playAt(ui, ui.mode.flow, next, true);
    }
    case "toggleDelta": {
      const deltaFilter = new Set(ui.deltaFilter);
      if (deltaFilter.has(action.delta)) {
        deltaFilter.delete(action.delta);
      } else {
        deltaFilter.add(action.delta);
      }
      return { ...ui, deltaFilter };
    }
    case "query":
      return { ...ui, query: action.query };
    case "toggleHelp":
      return { ...ui, help: !ui.help };
    case "toggleMinimap":
      return { ...ui, minimap: !ui.minimap };
    case "escape": {
      if (ui.help) {
        return { ...ui, help: false };
      }
      if (ui.query) {
        return { ...ui, query: "" };
      }
      if (ui.mode.kind !== "explore") {
        return { ...ui, mode: EXPLORE };
      }
      if (ui.selection) {
        return { ...ui, selection: undefined };
      }
      return ui;
    }
  }
}
