import { createContext, useContext } from "react";

import type { VizFileRef } from "../../protocol/viz";
import type { Point } from "../layout/geometry";
import type { PlacedFrame } from "../layout/overview";
import type { VizIndex } from "../model/index";
import type { UiAction } from "../model/ui";
import type { VizNoteTarget } from "../protocol";

export type MenuTarget =
  | { kind: "node"; id: string; at?: Point }
  | { kind: "member"; id: string; node: string }
  | { kind: "frame"; frame: PlacedFrame }
  | { kind: "edge"; id: string }
  | { kind: "note"; id: string }
  | { kind: "pane"; at: Point };

export interface VizActions {
  readonly index: VizIndex;
  dispatch(action: UiAction): void;
  openFile(file: VizFileRef, mode: "file" | "diff"): void;
  openMenu(target: MenuTarget, screen: Point): void;
  startLink(noteId: string, pointerId: number): void;
}

export const VizContext = createContext<VizActions | undefined>(undefined);

export function useViz(): VizActions {
  const value = useContext(VizContext);
  if (!value) {
    throw new Error("VizContext is missing");
  }
  return value;
}

export function noteTargetAttr(target: VizNoteTarget): { "data-note-target": string } {
  return { "data-note-target": JSON.stringify(target) };
}

export function noteTargetAt(x: number, y: number): VizNoteTarget | undefined {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-note-target]");
  const raw = element?.dataset.noteTarget;
  return raw ? (JSON.parse(raw) as VizNoteTarget) : undefined;
}
