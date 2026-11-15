import type { VizFragment } from "../../protocol/viz.js";
import type { IndexedStep, VizIndex } from "../model/index.js";
import { estimateTextWidth, type Rect } from "./geometry.js";

export const SEQ = {
  pad: 24,
  columnWidth: 192,
  minGap: 48,
  headerHeight: 56,
  firstRow: 44,
  pitch: 56,
  selfPitch: 76,
  selfWidth: 56,
  phaseHeight: 26,
  phaseGap: 14,
  activationWidth: 12,
  nestOffset: 6,
  messageHeight: 40,
  tail: 36,
  fragmentHead: 26,
  fragmentTail: 12,
  fragmentInset: 10,
} as const;

export interface ParticipantColumn extends Rect {
  readonly id: string;
  readonly column: number;
  readonly lifelineX: number;
}

export interface ActivationBar extends Rect {
  readonly participant: string;
  readonly depth: number;
  readonly opener: number;
}

export type MessageDirection = "right" | "left" | "self";

export interface PlacedMessage extends Rect {
  readonly index: number;
  readonly step: IndexedStep;
  readonly fromX: number;
  readonly toX: number;
  readonly lineY: number;
  readonly direction: MessageDirection;
}

export interface PhaseBand extends Rect {
  readonly label: string;
  readonly firstStep: number;
}

export interface FragmentBox extends Rect {
  readonly kind: VizFragment["kind"];
  readonly label: string | undefined;
  readonly from: number;
  readonly to: number;
  readonly depth: number;
}

export interface SequenceScene {
  readonly flow: string;
  readonly participants: readonly ParticipantColumn[];
  readonly lifelineTop: number;
  readonly lifelineBottom: number;
  readonly activations: readonly ActivationBar[];
  readonly messages: readonly PlacedMessage[];
  readonly phases: readonly PhaseBand[];
  readonly fragments: readonly FragmentBox[];
  readonly bounds: Rect;
}

interface OpenActivation {
  participant: string;
  depth: number;
  opener: number;
  caller: string;
  top: number;
}

interface OpenFragment {
  readonly fragment: VizFragment;
  readonly depth: number;
  readonly top: number;
}

function fragmentDepths(fragments: readonly VizFragment[]): Map<VizFragment, number> {
  const depths = new Map<VizFragment, number>();
  const ordered = [...fragments].sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from);
  for (const fragment of ordered) {
    let depth = 0;
    for (const [other, otherDepth] of depths) {
      if (other.from <= fragment.from && other.to >= fragment.to) {
        depth = Math.max(depth, otherDepth + 1);
      }
    }
    depths.set(fragment, depth);
  }
  return depths;
}

export function layoutSequence(index: VizIndex, flowId: string): SequenceScene {
  const flow = index.flowById.get(flowId);
  if (!flow) {
    return {
      flow: flowId,
      participants: [],
      lifelineTop: 0,
      lifelineBottom: 0,
      activations: [],
      messages: [],
      phases: [],
      fragments: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
  }
  const column = new Map(flow.participants.map((id, i) => [id, i] as const));
  let widestAdjacent = 0;
  for (const step of flow.steps) {
    if (Math.abs((column.get(step.from) ?? 0) - (column.get(step.to) ?? 0)) === 1) {
      widestAdjacent = Math.max(widestAdjacent, estimateTextWidth(step.label, 12) + 28);
    }
  }
  const gap = Math.max(SEQ.minGap, widestAdjacent - SEQ.columnWidth);
  const pitchX = SEQ.columnWidth + gap;
  const participants: ParticipantColumn[] = flow.participants.map((id, i) => ({
    id,
    column: i,
    x: SEQ.pad + i * pitchX,
    y: SEQ.pad,
    width: SEQ.columnWidth,
    height: SEQ.headerHeight,
    lifelineX: SEQ.pad + i * pitchX + SEQ.columnWidth / 2,
  }));
  const lifelineX = (id: string) => participants[column.get(id) ?? 0].lifelineX;
  const width =
    SEQ.pad * 2 + flow.participants.length * SEQ.columnWidth + (flow.participants.length - 1) * gap;

  const lifelineTop = SEQ.pad + SEQ.headerHeight;
  const phases: PhaseBand[] = [];
  const activations: ActivationBar[] = [];
  const open = new Map<string, OpenActivation[]>();
  const stack = (id: string) => {
    const list = open.get(id) ?? [];
    open.set(id, list);
    return list;
  };
  const close = (bar: OpenActivation, bottom: number) => {
    activations.push({
      participant: bar.participant,
      depth: bar.depth,
      opener: bar.opener,
      x: lifelineX(bar.participant) - SEQ.activationWidth / 2 + bar.depth * SEQ.nestOffset,
      y: bar.top,
      width: SEQ.activationWidth,
      height: Math.max(bottom - bar.top, SEQ.pitch / 2),
    });
  };
  const edgeX = (id: string, towards: number): number => {
    const bars = open.get(id) ?? [];
    const top = bars[bars.length - 1];
    const centre = lifelineX(id);
    if (!top) {
      return centre;
    }
    const barX = centre - SEQ.activationWidth / 2 + top.depth * SEQ.nestOffset;
    return towards > centre ? barX + SEQ.activationWidth : barX;
  };

  const depths = fragmentDepths(flow.fragments);
  const byStart = new Map<number, VizFragment[]>();
  const byEnd = new Map<number, VizFragment[]>();
  for (const fragment of depths.keys()) {
    byStart.set(fragment.from - 1, [...(byStart.get(fragment.from - 1) ?? []), fragment]);
    byEnd.set(fragment.to - 1, [...(byEnd.get(fragment.to - 1) ?? []), fragment]);
  }
  const openFragments: OpenFragment[] = [];
  const fragments: FragmentBox[] = [];

  const messages: PlacedMessage[] = [];
  let y = lifelineTop + SEQ.firstRow;
  for (const step of flow.steps) {
    if (step.startsPhase && step.phase) {
      const bandY = y - SEQ.phaseHeight / 2 - SEQ.phaseGap;
      phases.push({
        label: step.phase,
        firstStep: step.index,
        x: 0,
        y: bandY,
        width,
        height: SEQ.phaseHeight,
      });
      y += SEQ.phaseHeight + SEQ.phaseGap;
    }
    for (const fragment of byStart.get(step.index) ?? []) {
      openFragments.push({
        fragment,
        depth: depths.get(fragment) ?? 0,
        top: y - SEQ.pitch / 2 + 6,
      });
      y += SEQ.fragmentHead;
    }
    const lineY = y;
    const self = step.from === step.to;
    const fromCentre = lifelineX(step.from);
    const toCentre = lifelineX(step.to);
    const direction: MessageDirection = self ? "self" : toCentre > fromCentre ? "right" : "left";
    const fromX = edgeX(step.from, self ? fromCentre + 1 : toCentre);
    if (step.kind === "return" && !self) {
      const returned = stack(step.from).pop();
      if (returned) {
        close(returned, lineY);
      }
    }
    if (!self) {
      for (const bars of open.values()) {
        while (bars.length > 0 && bars[bars.length - 1].caller === step.from) {
          close(bars.pop()!, lineY);
        }
      }
    }
    if (step.kind === "sync" && !self) {
      const bars = stack(step.to);
      bars.push({
        participant: step.to,
        depth: bars.length,
        opener: step.index,
        caller: step.from,
        top: lineY,
      });
    }
    const toX = self ? fromX : edgeX(step.to, fromCentre);
    const height = self ? SEQ.selfPitch - 16 : SEQ.messageHeight;
    const left = self ? fromX : Math.min(fromX, toX);
    messages.push({
      index: step.index,
      step,
      fromX,
      toX,
      lineY,
      direction,
      x: left,
      y: lineY - SEQ.messageHeight / 2,
      width: self
        ? SEQ.selfWidth + Math.max(estimateTextWidth(step.label, 12), 40)
        : Math.abs(toX - fromX),
      height,
    });
    y += self ? SEQ.selfPitch : SEQ.pitch;
    for (const fragment of byEnd.get(step.index) ?? []) {
      const at = openFragments.findIndex((candidate) => candidate.fragment === fragment);
      const opened = at >= 0 ? openFragments.splice(at, 1)[0] : undefined;
      if (!opened) {
        continue;
      }
      const inset = SEQ.pad / 2 + opened.depth * SEQ.fragmentInset;
      const bottom = y - SEQ.pitch / 2 + 2;
      fragments.push({
        kind: fragment.kind,
        label: fragment.label,
        from: fragment.from,
        to: fragment.to,
        depth: opened.depth,
        x: inset,
        y: opened.top,
        width: width - inset * 2,
        height: bottom - opened.top,
      });
      y += SEQ.fragmentTail;
    }
  }
  const lifelineBottom = y + SEQ.tail;
  for (const bars of open.values()) {
    for (const bar of bars.reverse()) {
      close(bar, lifelineBottom - SEQ.pad);
    }
  }
  activations.sort((a, b) => a.opener - b.opener);
  fragments.sort((a, b) => a.depth - b.depth || a.from - b.from);

  return {
    flow: flowId,
    participants,
    lifelineTop,
    lifelineBottom,
    activations,
    messages,
    phases,
    fragments,
    bounds: { x: 0, y: 0, width, height: lifelineBottom + SEQ.pad },
  };
}
