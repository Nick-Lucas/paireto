import { z } from "zod";

export const VIZ_LIMITS = {
  lanes: 8,
  nodes: 48,
  edges: 96,
  filesPerNode: 8,
  filesPerEdge: 4,
  filesPerStep: 4,
  flows: 6,
  participants: 10,
  steps: 32,
  walkthrough: 12,
  focus: 8,
} as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

const id = (what: string) =>
  z.string().regex(ID_PATTERN, "letters, digits, - and _ only, max 40").describe(what);

const text = (max: number) => z.string().trim().min(1).max(max);

export const VizDelta = z
  .enum(["added", "changed", "deleted", "unchanged"])
  .describe("What the diff did to this element. unchanged: context the change touches.");
export type VizDelta = z.infer<typeof VizDelta>;

export const VizNodeKind = z.enum([
  "actor",
  "ui",
  "service",
  "worker",
  "queue",
  "datastore",
  "cache",
  "external",
  "module",
  "component",
  "hook",
  "function",
  "class",
  "model",
  "route",
  "state",
  "config",
  "test",
]);
export type VizNodeKind = z.infer<typeof VizNodeKind>;

export const VizEdgeKind = z
  .enum(["call", "event", "data", "render", "uses"])
  .describe(
    "call: request, RPC, HTTP, function call. event: async message, queue, pub/sub. data: reads or writes a store. render: UI renders a child. uses: import or type dependency.",
  );
export type VizEdgeKind = z.infer<typeof VizEdgeKind>;

export const VizStepKind = z
  .enum(["sync", "async", "return"])
  .describe(
    "sync: call and wait (default). async: fire and forget. return: reply. from = to draws a self step.",
  );
export type VizStepKind = z.infer<typeof VizStepKind>;

export const VizFileRef = z.strictObject({
  path: z.string().trim().min(1).describe("Repo-relative path."),
  line: z.number().int().min(1).optional().describe("First line that matters."),
  endLine: z.number().int().min(1).optional(),
  repo: z.string().optional().describe("Repo name from paireto_get_changes. Omit for this repo."),
});
export type VizFileRef = z.infer<typeof VizFileRef>;

export const VizLane = z.strictObject({
  id: id("Lane id."),
  label: text(32),
});
export type VizLane = z.infer<typeof VizLane>;

export const VizNode = z.strictObject({
  id: id("Node id."),
  label: text(40),
  kind: VizNodeKind,
  delta: VizDelta,
  lane: id("Lane id."),
  group: text(40)
    .optional()
    .describe("Nodes sharing a group are boxed together, e.g. one service."),
  sub: text(48).optional().describe("Short qualifier: route, table, topic."),
  role: text(200)
    .optional()
    .describe("Its part in this change, one sentence. Required unless unchanged."),
  files: z
    .array(VizFileRef)
    .max(VIZ_LIMITS.filesPerNode)
    .optional()
    .describe("Where it lives in the diff. Required unless unchanged."),
  flowOnly: z.boolean().optional().describe("Shown only in flows, e.g. the user or the browser."),
});
export type VizNode = z.infer<typeof VizNode>;

export const VizEdge = z.strictObject({
  from: id("Node id."),
  to: id("Node id. One edge per from>to pair."),
  kind: VizEdgeKind,
  delta: VizDelta,
  label: text(48).optional().describe("Protocol or verb, e.g. POST /charges."),
  hero: z.boolean().optional().describe("The main new path of the change. At most one edge."),
  files: z.array(VizFileRef).max(VIZ_LIMITS.filesPerEdge).optional(),
});
export type VizEdge = z.infer<typeof VizEdge>;

export const VizStep = z.strictObject({
  from: id("Participant node id."),
  to: id("Participant node id."),
  label: text(60).describe("Message or action, e.g. POST /orders."),
  kind: VizStepKind.optional(),
  delta: VizDelta.optional().describe("Defaults to the flow delta."),
  request: text(240).optional().describe("Payload shape sent."),
  response: text(240).optional().describe("Payload shape returned."),
  note: text(200).optional(),
  phase: text(32).optional().describe("Starts a named phase that runs until the next phase."),
  files: z.array(VizFileRef).max(VIZ_LIMITS.filesPerStep).optional(),
});
export type VizStep = z.infer<typeof VizStep>;

export const VizFlow = z.strictObject({
  id: id("Flow id."),
  title: text(48),
  summary: text(240).optional().describe("The process or protocol, one or two sentences."),
  delta: VizDelta,
  participants: z
    .array(id("Node id."))
    .min(2)
    .max(VIZ_LIMITS.participants)
    .describe("Columns, left to right."),
  steps: z.array(VizStep).min(1).max(VIZ_LIMITS.steps).describe("Messages in time order."),
});
export type VizFlow = z.infer<typeof VizFlow>;

export const VizWalkStep = z.strictObject({
  title: text(48).describe("Change words: Adds, Routes, Drops."),
  body: text(200),
  focus: z
    .array(z.string())
    .min(1)
    .max(VIZ_LIMITS.focus)
    .describe("Node id, from>to edge, flow id, or flowId:N for step N (1-based). One stage only."),
});
export type VizWalkStep = z.infer<typeof VizWalkStep>;

export const VizArgs = z.strictObject({
  title: text(80),
  summary: text(400).describe("What changed and why it matters. 1-3 sentences."),
  level: z
    .enum(["service", "component"])
    .describe(
      "service: nodes are services, UIs, stores, queues. component: nodes are modules, components, functions, models inside one unit.",
    ),
  lanes: z
    .array(VizLane)
    .min(1)
    .max(VIZ_LIMITS.lanes)
    .describe("Columns, left to right, in the reader's mental order. Not folders."),
  nodes: z.array(VizNode).min(1).max(VIZ_LIMITS.nodes),
  edges: z.array(VizEdge).max(VIZ_LIMITS.edges).optional(),
  flows: z
    .array(VizFlow)
    .max(VIZ_LIMITS.flows)
    .optional()
    .describe("Key processes or protocols the change adds or alters."),
  walkthrough: z.array(VizWalkStep).max(VIZ_LIMITS.walkthrough).optional(),
});
export type VizArgs = z.infer<typeof VizArgs>;
