import type { VizEdge, VizNode } from "../../protocol/viz.js";
import { DELTA_GLYPH } from "./delta.js";
import type { IndexedFlow, Stage, VizIndex } from "./index.js";

const ENTITY: Record<string, string> = { "#": "#35;", ";": "#59;", '"': "#quot;" };

function escape(text: string): string {
  return text.replace(/\r?\n/g, "<br/>").replace(/[#;"]/g, (char) => ENTITY[char]);
}

function quote(text: string): string {
  return `"${escape(text)}"`;
}

function nodeIds(index: VizIndex): (node: string) => string {
  const ids = new Map(index.nodes.map((node, at) => [node.id, `n${at}`] as const));
  return (node) => ids.get(node) ?? node;
}

function nodeLabel(node: VizNode): string {
  return node.delta === "unchanged" ? node.label : `${DELTA_GLYPH[node.delta]} ${node.label}`;
}

function shape(node: VizNode): [string, string] {
  switch (node.kind) {
    case "datastore":
    case "cache":
      return ["[(", ")]"];
    case "queue":
      return ["[[", "]]"];
    case "actor":
    case "external":
      return ["([", "])"];
    default:
      return ["[", "]"];
  }
}

function arrow(edge: VizEdge): string {
  if (edge.hero) {
    return "==>";
  }
  switch (edge.kind) {
    case "event":
      return "-.->";
    case "uses":
      return "---";
    default:
      return "-->";
  }
}

function overview(index: VizIndex): string {
  const id = nodeIds(index);
  const lines = ["flowchart LR"];
  let groupCount = 0;
  for (const [laneAt, lane] of index.lanes.entries()) {
    const members = index.nodes.filter((node) => node.lane === lane.id && !node.flowOnly);
    if (members.length === 0) {
      continue;
    }
    lines.push(`  subgraph lane${laneAt}[${quote(lane.label)}]`);
    lines.push("    direction LR");
    const groups = new Map<string, VizNode[]>();
    for (const node of members) {
      const key = node.group ?? "";
      groups.set(key, [...(groups.get(key) ?? []), node]);
    }
    for (const [group, nodes] of groups) {
      const indent = group ? "      " : "    ";
      if (group) {
        lines.push(`    subgraph group${groupCount}[${quote(group)}]`);
        groupCount += 1;
      }
      for (const node of nodes) {
        const [open, close] = shape(node);
        lines.push(`${indent}${id(node.id)}${open}${quote(nodeLabel(node))}${close}`);
      }
      if (group) {
        lines.push("    end");
      }
    }
    lines.push("  end");
  }
  for (const edge of index.edges) {
    const label = edge.label
      ? `${arrow(edge).slice(0, -1)} ${quote(edge.label)} ${arrow(edge)}`
      : arrow(edge);
    lines.push(`  ${id(edge.from)} ${label} ${id(edge.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

function sequence(index: VizIndex, flow: IndexedFlow): string {
  const id = nodeIds(index);
  const lines = ["sequenceDiagram", `  title ${escape(flow.title)}`];
  for (const participant of flow.participants) {
    const node = index.nodeById.get(participant);
    const label = node ? node.label : participant;
    const keyword = node?.kind === "actor" ? "actor" : "participant";
    lines.push(`  ${keyword} ${id(participant)} as ${escape(label)}`);
  }
  const first = id(flow.participants[0]);
  const last = id(flow.participants[flow.participants.length - 1]);
  for (const step of flow.steps) {
    if (step.startsPhase && step.phase) {
      lines.push(`  Note over ${first},${last}: ${escape(step.phase)}`);
    }
    const op = step.kind === "return" ? "-->>" : step.kind === "async" ? "-)" : "->>";
    lines.push(`  ${id(step.from)}${op}${id(step.to)}: ${escape(step.label)}`);
    if (step.note) {
      lines.push(`  Note right of ${id(step.to)}: ${escape(step.note)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function toMermaid(index: VizIndex, stage: Stage): string {
  if (stage.kind === "overview") {
    return overview(index);
  }
  const flow = index.flowById.get(stage.flow);
  return flow ? sequence(index, flow) : overview(index);
}
