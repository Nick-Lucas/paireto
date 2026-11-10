import type { EdgeKey, VizRef } from "./types.js";

const NODE_OR_FLOW = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EDGE = /^([A-Za-z0-9][A-Za-z0-9_-]*)>([A-Za-z0-9][A-Za-z0-9_-]*)$/;
const STEP = /^([A-Za-z0-9][A-Za-z0-9_-]*):([1-9][0-9]*)$/;

export function edgeKey(from: string, to: string): EdgeKey {
  return `${from}>${to}`;
}

export function parseVizRef(raw: string, flowIds: ReadonlySet<string>): VizRef | undefined {
  const value = raw.trim();
  const edge = EDGE.exec(value);
  if (edge) {
    return { kind: "edge", key: edgeKey(edge[1], edge[2]) };
  }
  const step = STEP.exec(value);
  if (step) {
    return { kind: "step", flow: step[1], index: Number(step[2]) - 1 };
  }
  if (!NODE_OR_FLOW.test(value)) {
    return undefined;
  }
  return flowIds.has(value) ? { kind: "flow", id: value } : { kind: "node", id: value };
}

export function formatVizRef(ref: VizRef): string {
  switch (ref.kind) {
    case "node":
    case "flow":
      return ref.id;
    case "edge":
      return ref.key;
    case "step":
      return `${ref.flow}:${ref.index + 1}`;
  }
}
