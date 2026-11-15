import type { VizNode } from "../../protocol/viz.js";
import type { IndexedEdge, VizIndex } from "../model/index.js";
import { rowCentre, type ClassBoxLayout } from "./classBox.js";
import type { ElkEdge, ElkLabel, ElkPort } from "./elk.js";
import type { Measure } from "./measure.js";

export function portId(node: string, member: string, side: "out" | "in"): string {
  return `port/${side}/${node}/${member}`;
}

export function boxPorts(
  index: VizIndex,
  known: Set<string>,
  node: VizNode,
  box: ClassBoxLayout,
): ElkPort[] {
  const ports: ElkPort[] = [];
  const add = (id: string, side: "out" | "in", y: number) => {
    if (known.has(id)) {
      return;
    }
    known.add(id);
    ports.push({
      id,
      x: side === "out" ? box.width : 0,
      y,
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": side === "out" ? "EAST" : "WEST" },
    });
  };
  add(portId(node.id, "", "out"), "out", box.headerHeight / 2);
  add(portId(node.id, "", "in"), "in", box.headerHeight / 2);
  const addMember = (member: string, side: "out" | "in") => {
    const y = rowCentre(box, member);
    if (y !== undefined) {
      add(portId(node.id, member, side), side, y);
    }
  };
  for (const edgeId of index.outEdges.get(node.id) ?? []) {
    const edge = index.edgeById.get(edgeId);
    if (edge?.fromMember) {
      addMember(edge.fromMember, "out");
    }
  }
  for (const edgeId of index.inEdges.get(node.id) ?? []) {
    const edge = index.edgeById.get(edgeId);
    if (edge?.toMember) {
      addMember(edge.toMember, "in");
    }
  }
  return ports;
}

export function textLabel(index: VizIndex, edge: IndexedEdge, measure: Measure): ElkLabel {
  const text = edge.label ?? "";
  const extras =
    22 + (edge.delta === "unchanged" ? 0 : 16) + (index.stepsByEdge.has(edge.id) ? 26 : 0);
  return {
    text,
    width: Math.min(220, measure(text, "small") + extras),
    height: 22,
    layoutOptions: { "elk.edgeLabels.placement": "CENTER" },
  };
}

function endLabel(text: string, end: "HEAD" | "TAIL", measure: Measure): ElkLabel {
  return {
    text,
    width: measure(text, "small") + 10,
    height: 14,
    layoutOptions: { "elk.edgeLabels.placement": end },
  };
}

export function edgeEntry(
  index: VizIndex,
  ports: ReadonlySet<string>,
  measure: Measure,
  edge: IndexedEdge,
): ElkEdge {
  const end = (node: string, member: string | undefined, side: "out" | "in"): string => {
    const candidates = [member ? portId(node, member, side) : undefined, portId(node, "", side)];
    return candidates.find((id): id is string => id !== undefined && ports.has(id)) ?? node;
  };
  const source = end(edge.from, edge.fromMember, "out");
  const target = end(edge.to, edge.toMember, "in");
  const labels: ElkLabel[] = [];
  if (edge.label) {
    labels.push(textLabel(index, edge, measure));
  }
  if (edge.multiplicity?.to) {
    labels.push(endLabel(edge.multiplicity.to, "HEAD", measure));
  }
  if (edge.multiplicity?.from) {
    labels.push(endLabel(edge.multiplicity.from, "TAIL", measure));
  }
  const structural = edge.kind === "extends" || edge.kind === "implements";
  return {
    id: edge.id,
    sources: [source],
    targets: [target],
    labels,
    layoutOptions: structural
      ? { "elk.layered.priority.direction": "10", "elk.layered.priority.straightness": "10" }
      : edge.kind === "dependency"
        ? { "elk.layered.priority.direction": "0" }
        : {},
  };
}
