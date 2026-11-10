import type { VizDelta, VizEdge, VizNode } from "../../protocol/viz.js";
import type { IndexedFlow, Stage, VizIndex } from "./index.js";

const GLYPH: Record<VizDelta, string> = { added: "+", changed: "~", deleted: "−", unchanged: "" };

function id(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, "_");
}

function quote(text: string): string {
  return `"${text.replace(/"/g, "#quot;")}"`;
}

function nodeLabel(node: VizNode): string {
  const glyph = GLYPH[node.delta];
  return glyph ? `${glyph} ${node.label}` : node.label;
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
  const lines = ["flowchart LR"];
  for (const lane of index.lanes) {
    const members = index.nodes.filter((node) => node.lane === lane.id && !node.flowOnly);
    if (members.length === 0) {
      continue;
    }
    lines.push(`  subgraph ${id(`lane_${lane.id}`)}[${quote(lane.label)}]`);
    lines.push("    direction LR");
    const groups = new Map<string, VizNode[]>();
    for (const node of members) {
      const key = node.group ?? "";
      groups.set(key, [...(groups.get(key) ?? []), node]);
    }
    for (const [group, nodes] of groups) {
      const indent = group ? "      " : "    ";
      if (group) {
        lines.push(`    subgraph ${id(`group_${lane.id}_${group}`)}[${quote(group)}]`);
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
  const lines = ["sequenceDiagram", `  title ${flow.title}`];
  for (const participant of flow.participants) {
    const node = index.nodeById.get(participant);
    const label = node ? node.label : participant;
    const keyword = node?.kind === "actor" ? "actor" : "participant";
    lines.push(`  ${keyword} ${id(participant)} as ${label}`);
  }
  const first = id(flow.participants[0]);
  const last = id(flow.participants[flow.participants.length - 1]);
  for (const step of flow.steps) {
    if (step.startsPhase && step.phase) {
      lines.push(`  Note over ${first},${last}: ${step.phase}`);
    }
    const op = step.kind === "return" ? "-->>" : step.kind === "async" ? "-)" : "->>";
    lines.push(`  ${id(step.from)}${op}${id(step.to)}: ${step.label}`);
    if (step.note) {
      lines.push(`  Note right of ${id(step.to)}: ${step.note}`);
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
