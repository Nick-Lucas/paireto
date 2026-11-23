import type { VizDelta } from "../../protocol/viz.js";
import type { Point } from "../layout/geometry.js";
import {
  DEFAULT_VIZ_VIEW_STATE,
  type VizNotePlace,
  type VizNoteTarget,
  type VizViewState,
} from "../protocol.js";
import { OVERVIEW, refInStage, sameStage, type Stage, type VizIndex } from "./index.js";
import { sameTarget, type NoteKind } from "./notes.js";
import { formatVizRef } from "./refs.js";
import type { ChangeCursor } from "./review.js";
import type { VizRef } from "./types.js";
import type { Grouping, Show } from "./visible.js";

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

export type Thread =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly id: string }
  | { readonly kind: "placing" }
  | {
      readonly kind: "draft";
      readonly noteKind: NoteKind;
      readonly targets: readonly VizNoteTarget[];
      readonly place: VizNotePlace | undefined;
      readonly at: Point;
    };

export const ALL_DELTAS: readonly VizDelta[] = ["added", "changed", "removed", "unchanged"];

export interface Filters {
  readonly notSeen: boolean;
  readonly openThreads: boolean;
}

export interface UiState {
  readonly stage: Stage;
  readonly mode: Mode;
  readonly selection: VizRef | undefined;
  readonly deltaFilter: ReadonlySet<VizDelta>;
  readonly query: string;
  readonly help: boolean;
  readonly minimap: boolean;
  readonly show: Show;
  readonly filters: Filters;
  readonly grouping: Grouping;
  readonly sidebar: boolean;
  readonly sidebarWidth: number;
  readonly expanded: ReadonlySet<string>;
  readonly cursor: ChangeCursor | undefined;
  readonly thread: Thread;
  readonly reveal: { readonly id: string; readonly seq: number } | undefined;
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
  | { readonly type: "show"; readonly show: Show }
  | { readonly type: "filters"; readonly filters: Partial<Filters> }
  | { readonly type: "grouping"; readonly grouping: Grouping }
  | { readonly type: "toggleSidebar" }
  | { readonly type: "sidebarWidth"; readonly width: number }
  | { readonly type: "toggleExpanded"; readonly node: string }
  | { readonly type: "changeStop"; readonly cursor: ChangeCursor; readonly ref: VizRef }
  | { readonly type: "resetChanges" }
  | { readonly type: "openThread"; readonly id: string }
  | { readonly type: "closeThread" }
  | { readonly type: "placeComment" }
  | {
      readonly type: "startDraft";
      readonly noteKind: NoteKind;
      readonly targets: readonly VizNoteTarget[];
      readonly place: VizNotePlace | undefined;
      readonly at: Point;
    }
  | { readonly type: "draftKind"; readonly noteKind: NoteKind }
  | { readonly type: "draftLink"; readonly target: VizNoteTarget }
  | { readonly type: "draftUnlink"; readonly index: number }
  | { readonly type: "escape" };

const EXPLORE: Mode = { kind: "explore" };
const CLOSED: Thread = { kind: "closed" };

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;

export function stageFromView(index: VizIndex, stage: string): Stage {
  return index.flowById.has(stage) ? { kind: "flow", flow: stage } : OVERVIEW;
}

export function initialUi(index: VizIndex, view: VizViewState = DEFAULT_VIZ_VIEW_STATE): UiState {
  return {
    stage: stageFromView(index, view.stage),
    mode: EXPLORE,
    selection: undefined,
    deltaFilter: new Set(ALL_DELTAS),
    query: "",
    help: false,
    minimap: true,
    show: view.show,
    filters: view.filters,
    grouping: view.grouping,
    sidebar: view.sidebar,
    sidebarWidth: view.sidebarWidth,
    expanded: new Set(),
    cursor: undefined,
    thread: CLOSED,
    reveal: undefined,
  };
}

export function viewStateOf(ui: UiState): VizViewState {
  return {
    stage: ui.stage.kind === "overview" ? "diagram" : ui.stage.flow,
    show: ui.show,
    filters: ui.filters,
    grouping: ui.grouping,
    sidebar: ui.sidebar,
    sidebarWidth: ui.sidebarWidth,
  };
}

function stageOfRef(index: VizIndex, ref: VizRef, current: Stage): Stage {
  switch (ref.kind) {
    case "node":
      return refInStage(index, ref, current) ? current : OVERVIEW;
    case "member":
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
  return { ...ui, stage, mode: EXPLORE, selection, thread: CLOSED };
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

function reveal(ui: UiState, ref: VizRef): UiState {
  return { ...ui, reveal: { id: formatVizRef(ref), seq: (ui.reveal?.seq ?? 0) + 1 } };
}

function toggleIn(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
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
      const selected = reduceUi(index, entered, { type: "select", ref: action.ref });
      return selected.selection ? reveal(selected, action.ref) : selected;
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
    case "show":
      return { ...ui, show: action.show };
    case "filters":
      return { ...ui, filters: { ...ui.filters, ...action.filters } };
    case "grouping":
      return { ...ui, grouping: action.grouping };
    case "toggleSidebar":
      return { ...ui, sidebar: !ui.sidebar };
    case "sidebarWidth":
      return {
        ...ui,
        sidebarWidth: Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, action.width))),
      };
    case "toggleExpanded":
      return { ...ui, expanded: toggleIn(ui.expanded, action.node) };
    case "changeStop": {
      const moved = reduceUi(
        index,
        { ...ui, cursor: action.cursor },
        { type: "goto", ref: action.ref },
      );
      return { ...moved, sidebar: true };
    }
    case "resetChanges":
      return { ...ui, cursor: undefined };
    case "openThread":
      return {
        ...ui,
        thread: { kind: "open", id: action.id },
        reveal: { id: `note/${action.id}`, seq: (ui.reveal?.seq ?? 0) + 1 },
      };
    case "closeThread":
      return ui.thread.kind === "closed" ? ui : { ...ui, thread: CLOSED };
    case "placeComment":
      return { ...ui, thread: ui.thread.kind === "placing" ? CLOSED : { kind: "placing" } };
    case "startDraft":
      return {
        ...ui,
        thread: {
          kind: "draft",
          noteKind: action.noteKind,
          targets: action.targets,
          place: action.place,
          at: action.at,
        },
      };
    case "draftKind":
      return ui.thread.kind === "draft"
        ? { ...ui, thread: { ...ui.thread, noteKind: action.noteKind } }
        : ui;
    case "draftLink": {
      if (ui.thread.kind !== "draft") {
        return ui;
      }
      if (ui.thread.targets.some((target) => sameTarget(target, action.target))) {
        return ui;
      }
      return { ...ui, thread: { ...ui.thread, targets: [...ui.thread.targets, action.target] } };
    }
    case "draftUnlink":
      return ui.thread.kind === "draft"
        ? {
            ...ui,
            thread: {
              ...ui.thread,
              targets: ui.thread.targets.filter((_, i) => i !== action.index),
            },
          }
        : ui;
    case "escape": {
      if (ui.help) {
        return { ...ui, help: false };
      }
      if (ui.thread.kind !== "closed") {
        return { ...ui, thread: CLOSED };
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
