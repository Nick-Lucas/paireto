import type {
  VizArgs,
  VizDelta,
  VizEdge,
  VizFileRef,
  VizLane,
  VizNode,
  VizStepKind,
} from "../../protocol/viz.js";
import { edgeKey, formatVizRef, parseVizRef } from "./refs.js";
import type { EdgeKey, VizRef } from "./types.js";

export type Stage = { kind: "overview" } | { kind: "flow"; flow: string };

export const OVERVIEW: Stage = { kind: "overview" };

export function sameStage(a: Stage, b: Stage): boolean {
  return a.kind === "overview" ? b.kind === "overview" : b.kind === "flow" && a.flow === b.flow;
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
  readonly edge?: EdgeKey;
  readonly overviewRef: VizRef;
}

export interface IndexedFlow {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly delta: VizDelta;
  readonly participants: readonly string[];
  readonly steps: readonly IndexedStep[];
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
  readonly viz: VizArgs;
  readonly lanes: readonly VizLane[];
  readonly laneIndex: ReadonlyMap<string, number>;
  readonly nodes: readonly VizNode[];
  readonly overviewNodes: readonly VizNode[];
  readonly nodeById: ReadonlyMap<string, VizNode>;
  readonly edges: readonly VizEdge[];
  readonly edgesByKey: ReadonlyMap<EdgeKey, VizEdge>;
  readonly outEdges: ReadonlyMap<string, readonly EdgeKey[]>;
  readonly inEdges: ReadonlyMap<string, readonly EdgeKey[]>;
  readonly flows: readonly IndexedFlow[];
  readonly flowById: ReadonlyMap<string, IndexedFlow>;
  readonly flowsByNode: ReadonlyMap<string, readonly string[]>;
  readonly stepsByEdge: ReadonlyMap<EdgeKey, readonly StepLocator[]>;
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

export function buildVizIndex(viz: VizArgs): VizIndex {
  const laneIndex = new Map(viz.lanes.map((lane, i) => [lane.id, i] as const));
  const nodeById = new Map(viz.nodes.map((node) => [node.id, node] as const));
  const edges = viz.edges ?? [];
  const edgesByKey = new Map(edges.map((edge) => [edgeKey(edge.from, edge.to), edge] as const));
  const outEdges = new Map<string, EdgeKey[]>();
  const inEdges = new Map<string, EdgeKey[]>();
  for (const edge of edges) {
    const key = edgeKey(edge.from, edge.to);
    push(outEdges, edge.from, key);
    push(inEdges, edge.to, key);
  }

  const flowsByNode = new Map<string, string[]>();
  const stepsByEdge = new Map<EdgeKey, StepLocator[]>();
  const flows: IndexedFlow[] = (viz.flows ?? []).map((flow) => {
    for (const participant of flow.participants) {
      push(flowsByNode, participant, flow.id);
    }
    let phase: string | undefined;
    const steps = flow.steps.map((step, index): IndexedStep => {
      const startsPhase = step.phase !== undefined;
      phase = step.phase ?? phase;
      const forward = edgeKey(step.from, step.to);
      const backward = edgeKey(step.to, step.from);
      const edge = edgesByKey.has(forward)
        ? forward
        : edgesByKey.has(backward)
          ? backward
          : undefined;
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
          ? { kind: "edge", key: edge }
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
    };
  });
  const flowById = new Map(flows.map((flow) => [flow.id, flow] as const));
  const flowIds = new Set(flowById.keys());

  const walkthrough = (viz.walkthrough ?? []).map((step, index): IndexedWalkStep => {
    const refs = step.focus
      .map((raw) => parseVizRef(raw, flowIds))
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
        ...(node.files ?? []).map((file) => file.path),
      ]),
    );
  }
  for (const edge of edges) {
    haystack.set(
      formatVizRef({ kind: "edge", key: edgeKey(edge.from, edge.to) }),
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
  const deltaCounts: Record<VizDelta, number> = { added: 0, changed: 0, deleted: 0, unchanged: 0 };
  for (const node of overviewNodes) {
    deltaCounts[node.delta] += 1;
  }

  return {
    viz,
    lanes: viz.lanes,
    laneIndex,
    nodes: viz.nodes,
    overviewNodes,
    nodeById,
    edges,
    edgesByKey,
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
    case "edge":
      return stage.kind === "overview" && index.edgesByKey.has(ref.key);
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
