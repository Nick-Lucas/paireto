import type { VizEdgeKind, VizMember, VizNode, VizNodeKind } from "../../protocol/viz.js";
import { DELTA_GLYPH } from "./delta.js";
import type { IndexedEdge, IndexedFlow, Stage, VizIndex } from "./index.js";

const ENTITY: Record<string, string> = {
  "#": "#35;",
  ";": "#59;",
  '"': "#quot;",
  "{": "#123;",
  "}": "#125;",
};

const CLASS_KINDS = new Set<VizNodeKind>([
  "class",
  "interface",
  "enum",
  "struct",
  "module",
  "file",
]);

const ANNOTATION: Partial<Record<VizNodeKind, string>> = {
  interface: "interface",
  enum: "enumeration",
  struct: "struct",
  module: "module",
  file: "file",
};

const VISIBILITY: Record<NonNullable<VizMember["visibility"]>, string> = {
  public: "+",
  private: "-",
  protected: "#",
  internal: "~",
};

const RELATION: Record<VizEdgeKind, { arrow: string; reverse: boolean }> = {
  extends: { arrow: "<|--", reverse: true },
  implements: { arrow: "<|..", reverse: true },
  association: { arrow: "-->", reverse: false },
  aggregation: { arrow: "o--", reverse: false },
  composition: { arrow: "*--", reverse: false },
  dependency: { arrow: "..>", reverse: false },
  call: { arrow: "-->", reverse: false },
  event: { arrow: "..>", reverse: false },
  data: { arrow: "-->", reverse: false },
  render: { arrow: "-->", reverse: false },
  uses: { arrow: "..>", reverse: false },
};

function escape(text: string): string {
  return text.replace(/\r?\n/g, "<br/>").replace(/[#;"{}]/g, (char) => ENTITY[char]);
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
    case "topic":
      return ["[[", "]]"];
    case "actor":
    case "external":
      return ["([", "])"];
    default:
      return ["[", "]"];
  }
}

function arrow(edge: IndexedEdge): string {
  if (edge.hero) {
    return "==>";
  }
  switch (edge.kind) {
    case "event":
    case "implements":
    case "dependency":
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
  const visible = (node: VizNode | undefined): node is VizNode =>
    node !== undefined && !node.flowOnly;
  const children = (node: VizNode) =>
    (index.childrenByParent.get(node.id) ?? [])
      .map((child) => index.nodeById.get(child))
      .filter(visible);
  const emit = (node: VizNode, indent: string) => {
    const inner = children(node);
    if (inner.length === 0) {
      const [open, close] = shape(node);
      lines.push(`${indent}${id(node.id)}${open}${quote(nodeLabel(node))}${close}`);
      return;
    }
    lines.push(`${indent}subgraph ${id(node.id)}[${quote(nodeLabel(node))}]`);
    inner.forEach((child) => emit(child, `${indent}  `));
    lines.push(`${indent}end`);
  };
  const roots = index.nodes.filter(
    (node) => visible(node) && (node.parent === undefined || !index.nodeById.has(node.parent)),
  );
  for (const [laneAt, lane] of index.lanes.entries()) {
    const inLane = roots.filter((node) => node.lane === lane.id);
    if (inLane.length === 0) {
      continue;
    }
    lines.push(`  subgraph lane${laneAt}[${quote(lane.label)}]`);
    lines.push("    direction LR");
    inLane.forEach((node) => emit(node, "    "));
    lines.push("  end");
  }
  roots
    .filter((node) => node.lane === undefined || !index.laneIndex.has(node.lane))
    .forEach((node) => emit(node, "  "));
  for (const edge of index.edges) {
    const label = edge.label ? `|${quote(edge.label)}|` : "";
    lines.push(`  ${id(edge.from)} ${arrow(edge)}${label} ${id(edge.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

function memberLine(member: VizMember): string {
  const visibility = member.visibility ? VISIBILITY[member.visibility] : "";
  const text = member.label
    .replace(/\r?\n/g, " ")
    .replace(/[<>]/g, "~")
    .replace(/[{}]/g, (char) => ENTITY[char]);
  return `${visibility}${text}${member.isStatic ? "$" : ""}${member.isAbstract ? "*" : ""}`;
}

function namespaceName(label: string, taken: Set<string>): string {
  const base = label.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=[0-9_]|$)/, "ns");
  let name = base;
  for (let n = 2; taken.has(name); n++) {
    name = `${base}_${n}`;
  }
  taken.add(name);
  return name;
}

export function toClassDiagram(index: VizIndex): string {
  const id = nodeIds(index);
  const classes = index.nodes.filter((node) => CLASS_KINDS.has(node.kind) && !node.flowOnly);
  const drawn = new Set(classes.map((node) => node.id));
  const lines = ["classDiagram"];
  const emit = (node: VizNode, indent: string) => {
    const annotation =
      node.stereotype ?? ANNOTATION[node.kind] ?? (node.isAbstract ? "abstract" : undefined);
    const body = [
      ...(annotation ? [`<<${escape(annotation)}>>`] : []),
      ...(node.members ?? []).map(memberLine),
    ];
    const head = `${indent}class ${id(node.id)}[${quote(nodeLabel(node))}]`;
    if (body.length === 0) {
      lines.push(head);
      return;
    }
    lines.push(`${head} {`, ...body.map((line) => `${indent}  ${line}`), `${indent}}`);
  };
  const namespaces = new Map<string, VizNode[]>();
  const loose: VizNode[] = [];
  for (const node of classes) {
    const parent = node.parent === undefined ? undefined : index.nodeById.get(node.parent);
    if (parent && !CLASS_KINDS.has(parent.kind)) {
      namespaces.set(parent.id, [...(namespaces.get(parent.id) ?? []), node]);
    } else {
      loose.push(node);
    }
  }
  const taken = new Set<string>();
  for (const [parent, nodes] of namespaces) {
    const label = index.nodeById.get(parent)?.label ?? parent;
    lines.push(`  namespace ${namespaceName(label, taken)} {`);
    nodes.forEach((node) => emit(node, "    "));
    lines.push("  }");
  }
  loose.forEach((node) => emit(node, "  "));
  for (const edge of index.edges) {
    if (!drawn.has(edge.from) || !drawn.has(edge.to)) {
      continue;
    }
    const relation = RELATION[edge.kind];
    const [left, right] = relation.reverse ? [edge.to, edge.from] : [edge.from, edge.to];
    const multiplicity = edge.multiplicity ?? {};
    const [leftCount, rightCount] = relation.reverse
      ? [multiplicity.to, multiplicity.from]
      : [multiplicity.from, multiplicity.to];
    const parts = [
      id(left),
      ...(leftCount ? [quote(leftCount)] : []),
      relation.arrow,
      ...(rightCount ? [quote(rightCount)] : []),
      id(right),
    ];
    const label = edge.label ? ` : ${escape(edge.label)}` : "";
    lines.push(`  ${parts.join(" ")}${label}`);
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
  const open: number[] = [];
  for (const step of flow.steps) {
    const number = step.index + 1;
    const starting = flow.fragments
      .filter((fragment) => fragment.from === number)
      .sort((a, b) => b.to - a.to);
    for (const fragment of starting) {
      const label = fragment.label ? ` ${escape(fragment.label)}` : "";
      lines.push(`${"  ".repeat(open.length + 1)}${fragment.kind}${label}`);
      open.push(fragment.to);
    }
    const indent = "  ".repeat(open.length + 1);
    if (step.startsPhase && step.phase) {
      lines.push(`${indent}Note over ${first},${last}: ${escape(step.phase)}`);
    }
    const op = step.kind === "return" ? "-->>" : step.kind === "async" ? "-)" : "->>";
    lines.push(`${indent}${id(step.from)}${op}${id(step.to)}: ${escape(step.label)}`);
    if (step.note) {
      lines.push(`${indent}Note right of ${id(step.to)}: ${escape(step.note)}`);
    }
    while (open.length > 0 && open[open.length - 1] <= number) {
      open.pop();
      lines.push(`${"  ".repeat(open.length + 1)}end`);
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
