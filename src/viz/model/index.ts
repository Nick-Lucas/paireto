import type {
  VizDelta,
  VizEdge,
  VizFile,
  VizFileRef,
  VizFragment,
  VizLane,
  VizMember,
  VizNode,
  VizStepKind,
} from "../../protocol/viz.js";
import { edgeId, formatVizRef, resolveFocus } from "./refs.js";
import type { VizRef } from "./types.js";

export type Stage = { kind: "overview" } | { kind: "flow"; flow: string };

export const OVERVIEW: Stage = { kind: "overview" };

export function sameStage(a: Stage, b: Stage): boolean {
  return a.kind === "overview" ? b.kind === "overview" : b.kind === "flow" && a.flow === b.flow;
}

export type IndexedEdge = VizEdge & { readonly id: string };

export interface IndexedMember {
  readonly node: VizNode;
  readonly member: VizMember;
}

export interface IndexedStep {
  readonly flow: string;
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind: VizStepKind;
  readonly delta: VizDelta;
  readonly request?: string;
  readonly response?: string;
  readonly note?: string;
  readonly phase?: string;
  readonly startsPhase: boolean;
  readonly files: readonly VizFileRef[];
  readonly edge?: string;
  readonly overviewRef: VizRef;
}

export interface IndexedFlow {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly delta: VizDelta;
  readonly participants: readonly string[];
  readonly steps: readonly IndexedStep[];
  readonly fragments: readonly VizFragment[];
}

export interface IndexedWalkStep {
  readonly index: number;
  readonly title: string;
  readonly body: string;
  readonly refs: readonly VizRef[];
  readonly stage: Stage;
}

export interface StepLocator {
  readonly flow: string;
  readonly index: number;
}

export interface VizIndex {
  readonly viz: VizFile;
  readonly lanes: readonly VizLane[];
  readonly laneIndex: ReadonlyMap<string, number>;
  readonly nodes: readonly VizNode[];
  readonly overviewNodes: readonly VizNode[];
  readonly nodeById: ReadonlyMap<string, VizNode>;
  readonly memberById: ReadonlyMap<string, IndexedMember>;
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
  readonly edges: readonly IndexedEdge[];
  readonly edgeById: ReadonlyMap<string, IndexedEdge>;
  readonly outEdges: ReadonlyMap<string, readonly string[]>;
  readonly inEdges: ReadonlyMap<string, readonly string[]>;
  readonly flows: readonly IndexedFlow[];
  readonly flowById: ReadonlyMap<string, IndexedFlow>;
  readonly flowsByNode: ReadonlyMap<string, readonly string[]>;
  readonly stepsByEdge: ReadonlyMap<string, readonly StepLocator[]>;
  readonly walkthrough: readonly IndexedWalkStep[];
  readonly haystack: ReadonlyMap<string, string>;
  readonly deltaCounts: Readonly<Record<VizDelta, number>>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function words(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

export function walkStage(refs: readonly VizRef[]): Stage {
  for (const ref of refs) {
    if (ref.kind === "flow") {
      return { kind: "flow", flow: ref.id };
    }
    if (ref.kind === "step") {
      return { kind: "flow", flow: ref.flow };
    }
  }
  return OVERVIEW;
}

export function buildVizIndex(viz: VizFile): VizIndex {
  const lanes = viz.lanes ?? [];
  const laneIndex = new Map(lanes.map((lane, i) => [lane.id, i] as const));
  const nodeById = new Map(viz.nodes.map((node) => [node.id, node] as const));
  const memberById = new Map<string, IndexedMember>();
  const childrenByParent = new Map<string, string[]>();
  for (const node of viz.nodes) {
    for (const member of node.members ?? []) {
      memberById.set(member.id, { node, member });
    }
    if (node.parent !== undefined) {
      push(childrenByParent, node.parent, node.id);
    }
  }

  const edges = (viz.edges ?? []).map((edge): IndexedEdge => ({ ...edge, id: edgeId(edge) }));
  const edgeById = new Map(edges.map((edge) => [edge.id, edge] as const));
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();
  for (const edge of edges) {
    push(outEdges, edge.from, edge.id);
    push(inEdges, edge.to, edge.id);
  }
  const between = (from: string, to: string) =>
    edges.find((edge) => edge.from === from && edge.to === to)?.id;

  const flowsByNode = new Map<string, string[]>();
  const stepsByEdge = new Map<string, StepLocator[]>();
  const flows: IndexedFlow[] = (viz.flows ?? []).map((flow) => {
    for (const participant of flow.participants) {
      push(flowsByNode, participant, flow.id);
    }
    let phase: string | undefined;
    const steps = flow.steps.map((step, index): IndexedStep => {
      const startsPhase = step.phase !== undefined;
      phase = step.phase ?? phase;
      const edge =
        step.edge !== undefined
          ? edgeById.has(step.edge)
            ? step.edge
            : undefined
          : (between(step.from, step.to) ?? between(step.to, step.from));
      if (edge) {
        push(stepsByEdge, edge, { flow: flow.id, index });
      }
      return {
        flow: flow.id,
        index,
        from: step.from,
        to: step.to,
        label: step.label,
        kind: step.kind ?? "sync",
        delta: step.delta ?? flow.delta,
        request: step.request,
        response: step.response,
        note: step.note,
        phase,
        startsPhase,
        files: step.files ?? [],
        edge,
        overviewRef: edge
          ? { kind: "edge", id: edge }
          : { kind: "node", id: nodeById.get(step.from)?.flowOnly ? step.to : step.from },
      };
    });
    return {
      id: flow.id,
      title: flow.title,
      summary: flow.summary,
      delta: flow.delta,
      participants: flow.participants,
      steps,
      fragments: flow.fragments ?? [],
    };
  });
  const flowById = new Map(flows.map((flow) => [flow.id, flow] as const));
  const lookup = { nodeById, memberById, edgeById, flowById };

  const walkthrough = (viz.walkthrough ?? []).map((step, index): IndexedWalkStep => {
    const refs = step.focus
      .map((focus) => resolveFocus(focus, lookup))
      .filter((ref): ref is VizRef => ref !== undefined);
    return { index, title: step.title, body: step.body, refs, stage: walkStage(refs) };
  });

  const haystack = new Map<string, string>();
  for (const node of viz.nodes) {
    haystack.set(
      formatVizRef({ kind: "node", id: node.id }),
      words([
        node.id,
        node.label,
        node.sub,
        node.role,
        node.kind,
        node.stereotype,
        ...(node.members ?? []).map((member) => member.label),
        ...(node.files ?? []).map((file) => file.path),
      ]),
    );
    for (const member of node.members ?? []) {
      haystack.set(
        formatVizRef({ kind: "member", id: member.id, node: node.id }),
        words([member.id, member.label, member.previous, member.file?.path]),
      );
    }
  }
  for (const edge of edges) {
    haystack.set(
      formatVizRef({ kind: "edge", id: edge.id }),
      words([edge.from, edge.to, edge.label, edge.kind]),
    );
  }
  for (const flow of flows) {
    haystack.set(
      formatVizRef({ kind: "flow", id: flow.id }),
      words([flow.id, flow.title, flow.summary]),
    );
    for (const step of flow.steps) {
      haystack.set(
        formatVizRef({ kind: "step", flow: flow.id, index: step.index }),
        words([step.from, step.to, step.label, step.note, step.request, step.response, step.phase]),
      );
    }
  }

  const overviewNodes = viz.nodes.filter((node) => !node.flowOnly);
  const deltaCounts: Record<VizDelta, number> = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  for (const node of overviewNodes) {
    deltaCounts[node.delta] += 1;
  }

  return {
    viz,
    lanes,
    laneIndex,
    nodes: viz.nodes,
    overviewNodes,
    nodeById,
    memberById,
    childrenByParent,
    edges,
    edgeById,
    outEdges,
    inEdges,
    flows,
    flowById,
    flowsByNode,
    stepsByEdge,
    walkthrough,
    haystack,
    deltaCounts,
  };
}

export function refInStage(index: VizIndex, ref: VizRef, stage: Stage): boolean {
  switch (ref.kind) {
    case "node": {
      const node = index.nodeById.get(ref.id);
      if (!node) {
        return false;
      }
      return stage.kind === "overview"
        ? !node.flowOnly
        : (index.flowById.get(stage.flow)?.participants.includes(ref.id) ?? false);
    }
    case "member":
      return stage.kind === "overview" && index.nodeById.get(ref.node)?.flowOnly !== true;
    case "edge":
      return stage.kind === "overview" && index.edgeById.has(ref.id);
    case "flow":
      return stage.kind === "flow" && stage.flow === ref.id;
    case "step":
      return stage.kind === "flow" && stage.flow === ref.flow;
  }
}

export function stageNumber(index: VizIndex, stage: Stage): number {
  return stage.kind === "overview"
    ? 0
    : index.flows.findIndex((flow) => flow.id === stage.flow) + 1;
}

export function stepAt(index: VizIndex, locator: StepLocator): IndexedStep | undefined {
  return index.flowById.get(locator.flow)?.steps[locator.index];
}

export function searchMatches(index: VizIndex, query: string): ReadonlySet<string> {
  const needle = query.trim().toLowerCase();
  const hits = new Set<string>();
  if (!needle) {
    return hits;
  }
  for (const [ref, text] of index.haystack) {
    if (text.includes(needle)) {
      hits.add(ref);
    }
  }
  return hits;
}
