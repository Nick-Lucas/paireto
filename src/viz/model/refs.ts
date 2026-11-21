import type { VizEdge, VizFileRef, VizFocus } from "../../protocol/viz.js";
import type { VizRef } from "./types.js";

export interface VizRefLookup {
  readonly nodeById: { has(id: string): boolean };
  readonly memberById: ReadonlyMap<string, { readonly node: { readonly id: string } }>;
  readonly edgeById: { has(id: string): boolean };
  readonly flowById: ReadonlyMap<string, { readonly steps: { readonly length: number } }>;
}

export function edgeId(edge: Pick<VizEdge, "id" | "from" | "to" | "kind">): string {
  return edge.id ?? `${edge.from}>${edge.to}:${edge.kind}`;
}

export function formatVizRef(ref: VizRef): string {
  return ref.kind === "step" ? `${ref.flow} ${ref.index + 1}` : ref.id;
}

export function fileRefLabel(ref: VizFileRef): string {
  const name = ref.path.slice(ref.path.lastIndexOf("/") + 1);
  return ref.line === undefined ? name : `${name}:${ref.line}`;
}

export function fileRefTitle(ref: VizFileRef): string {
  const place = ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`;
  return ref.repo ? `${ref.repo}:${place}` : place;
}

export function resolveId(id: string, lookup: VizRefLookup): VizRef | undefined {
  if (lookup.nodeById.has(id)) {
    return { kind: "node", id };
  }
  const member = lookup.memberById.get(id);
  if (member) {
    return { kind: "member", id, node: member.node.id };
  }
  if (lookup.edgeById.has(id)) {
    return { kind: "edge", id };
  }
  if (lookup.flowById.has(id)) {
    return { kind: "flow", id };
  }
  return undefined;
}

export function resolveFocus(focus: VizFocus, lookup: VizRefLookup): VizRef | undefined {
  if (typeof focus === "string") {
    return resolveId(focus, lookup);
  }
  const flow = lookup.flowById.get(focus.flow);
  return flow && focus.step <= flow.steps.length
    ? { kind: "step", flow: focus.flow, index: focus.step - 1 }
    : undefined;
}

export function parseVizRef(key: string, lookup: VizRefLookup): VizRef | undefined {
  const step = /^(\S+) ([1-9][0-9]*)$/.exec(key);
  return step
    ? resolveFocus({ flow: step[1], step: Number(step[2]) }, lookup)
    : resolveId(key, lookup);
}
