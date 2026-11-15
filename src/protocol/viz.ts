import { z } from "zod";
import { CompareTo } from "./guidedReview.js";

export const VIZ_FILE_VERSION = 1;

export const VIZ_LIMITS = {
  nodes: 400,
  edges: 800,
  members: 120,
  lanes: 8,
  filesPerItem: 8,
  flows: 12,
  participants: 12,
  steps: 48,
  fragments: 16,
  walkthrough: 16,
  focus: 12,
} as const;

const ID_PATTERN = /^\S{1,240}$/;

const id = (what: string) =>
  z.string().regex(ID_PATTERN, "no spaces, 1 to 240 characters").describe(what);

const text = (max: number) => z.string().trim().min(1).max(max);

export const VizDelta = z
  .enum(["added", "changed", "removed", "unchanged"])
  .describe("What the diff did to this item. unchanged: context the change touches.");
export type VizDelta = z.infer<typeof VizDelta>;

export const VizChangeDetail = z
  .enum(["signature", "body"])
  .describe("signature: the declaration changed. body: only the implementation changed.");
export type VizChangeDetail = z.infer<typeof VizChangeDetail>;

export const VizLineCounts = z.strictObject({
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});
export type VizLineCounts = z.infer<typeof VizLineCounts>;

export const VizStructureKind = z.enum([
  "class",
  "interface",
  "enum",
  "struct",
  "module",
  "file",
  "package",
]);
export type VizStructureKind = z.infer<typeof VizStructureKind>;

export const VizArchitectureKind = z.enum([
  "system",
  "actor",
  "ui",
  "service",
  "worker",
  "queue",
  "topic",
  "datastore",
  "cache",
  "external",
  "endpoint",
  "component",
  "hook",
  "function",
  "model",
  "route",
  "state",
  "config",
  "test",
]);
export type VizArchitectureKind = z.infer<typeof VizArchitectureKind>;

export const VizNodeKind = z
  .enum([...VizStructureKind.options, ...VizArchitectureKind.options])
  .describe(
    "The component that draws the node. class, interface, enum, struct, module and file draw a UML class box with members. package and system draw a frame for child nodes. The rest draw an architecture card.",
  );
export type VizNodeKind = z.infer<typeof VizNodeKind>;

export const VizEdgeKind = z
  .enum([
    "call",
    "event",
    "data",
    "render",
    "uses",
    "extends",
    "implements",
    "association",
    "aggregation",
    "composition",
    "dependency",
  ])
  .describe(
    "call: request, RPC, HTTP, function call. event: async message, queue, pub/sub. data: reads or writes a store. render: UI renders a child. uses: import. extends: UML generalization. implements: UML realization. association, aggregation, composition: a field holds the target. dependency: a parameter or return type uses the target.",
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
  line: z.number().int().min(1).optional().describe("First line that matters, 1-based."),
  endLine: z.number().int().min(1).optional(),
  side: z
    .enum(["base", "modified"])
    .optional()
    .describe(
      "Which side of the diff the lines are on. Default modified. Use base for removed code.",
    ),
  repo: z.string().optional().describe("Repo name. Omit for the main repo."),
});
export type VizFileRef = z.infer<typeof VizFileRef>;

export const VizLane = z.strictObject({
  id: id("Lane id."),
  label: text(32),
});
export type VizLane = z.infer<typeof VizLane>;

export const VizMemberKind = z.enum(["field", "property", "method", "constructor", "variant"]);
export type VizMemberKind = z.infer<typeof VizMemberKind>;

export const VizMember = z.strictObject({
  id: id("Member id, unique in the file."),
  kind: VizMemberKind,
  label: text(200).describe(
    "Signature as it reads in the class box, e.g. send(body: string): void.",
  ),
  short: text(80).optional().describe("Name only, for tight spaces."),
  previous: text(200)
    .optional()
    .describe("The label before the change, when the signature changed."),
  visibility: z.enum(["public", "private", "protected", "internal"]).optional(),
  isStatic: z.boolean().optional(),
  isAbstract: z.boolean().optional(),
  delta: VizDelta.optional().describe("Defaults to unchanged."),
  detail: VizChangeDetail.optional(),
  counts: VizLineCounts.optional(),
  file: VizFileRef.optional(),
});
export type VizMember = z.infer<typeof VizMember>;

export const VizNode = z.strictObject({
  id: id("Node id, unique across nodes, members, edges and flows."),
  label: text(80),
  kind: VizNodeKind,
  delta: VizDelta,
  parent: id("Id of a package, system or other node that frames this one.").optional(),
  lane: id("Lane id. Lanes are columns, left to right.").optional(),
  stereotype: text(40).optional().describe("UML stereotype text without guillemets, e.g. record."),
  sub: text(60).optional().describe("Short qualifier: route, table, topic."),
  role: text(240).optional().describe("Its part in this change, one sentence."),
  isAbstract: z.boolean().optional(),
  detail: VizChangeDetail.optional(),
  counts: VizLineCounts.optional(),
  members: z.array(VizMember).max(VIZ_LIMITS.members).optional(),
  files: z
    .array(VizFileRef)
    .max(VIZ_LIMITS.filesPerItem)
    .optional()
    .describe("Where it lives. Required unless unchanged."),
  flowOnly: z.boolean().optional().describe("Shown only in flows, e.g. the user or the browser."),
});
export type VizNode = z.infer<typeof VizNode>;

export const VizMultiplicity = z.strictObject({
  from: text(12).optional(),
  to: text(12).optional(),
});
export type VizMultiplicity = z.infer<typeof VizMultiplicity>;

export const VizEdge = z.strictObject({
  id: id(
    "Edge id. Default: from>to:kind. Give one to refer to the edge from the walkthrough.",
  ).optional(),
  from: id("Node id."),
  to: id("Node id."),
  fromMember: id("Member id on the from node where the edge starts.").optional(),
  toMember: id("Member id on the to node where the edge ends.").optional(),
  kind: VizEdgeKind,
  delta: VizDelta,
  label: text(60).optional().describe("Protocol or verb, e.g. POST /charges."),
  hero: z.boolean().optional().describe("The main new path of the change. At most one edge."),
  multiplicity: VizMultiplicity.optional(),
  via: z.array(id("Member id.")).optional().describe("Members that cause this edge."),
  files: z.array(VizFileRef).max(VIZ_LIMITS.filesPerItem).optional(),
});
export type VizEdge = z.infer<typeof VizEdge>;

export const VizStep = z.strictObject({
  from: id("Participant node id."),
  to: id("Participant node id."),
  label: text(80).describe("Message or action, e.g. POST /orders."),
  kind: VizStepKind.optional(),
  delta: VizDelta.optional().describe("Defaults to the flow delta."),
  edge: id("Id of the edge this step travels, so the diagram can play it back.").optional(),
  request: text(400).optional().describe("Payload shape sent."),
  response: text(400).optional().describe("Payload shape returned."),
  note: text(240).optional(),
  phase: text(40).optional().describe("Starts a named phase that runs until the next phase."),
  files: z.array(VizFileRef).max(VIZ_LIMITS.filesPerItem).optional(),
});
export type VizStep = z.infer<typeof VizStep>;

export const VizFragment = z.strictObject({
  kind: z.enum(["alt", "opt", "loop", "par", "break"]),
  label: text(60).optional().describe("Guard or loop condition, e.g. card declined."),
  from: z.number().int().min(1).describe("First step in the fragment, 1-based."),
  to: z.number().int().min(1).describe("Last step in the fragment, 1-based."),
});
export type VizFragment = z.infer<typeof VizFragment>;

export const VizFlow = z.strictObject({
  id: id("Flow id."),
  title: text(60),
  summary: text(400).optional().describe("The process or protocol, one or two sentences."),
  delta: VizDelta,
  participants: z
    .array(id("Node id."))
    .min(2)
    .max(VIZ_LIMITS.participants)
    .describe("Columns, left to right."),
  steps: z.array(VizStep).min(1).max(VIZ_LIMITS.steps).describe("Messages in time order."),
  fragments: z.array(VizFragment).max(VIZ_LIMITS.fragments).optional(),
});
export type VizFlow = z.infer<typeof VizFlow>;

export const VizStepRef = z.strictObject({
  flow: id("Flow id."),
  step: z.number().int().min(1).describe("Step number, 1-based."),
});
export type VizStepRef = z.infer<typeof VizStepRef>;

export const VizFocus = z.union([id("Node, member, edge or flow id."), VizStepRef]);
export type VizFocus = z.infer<typeof VizFocus>;

export const VizWalkStep = z.strictObject({
  title: text(60).describe("Change words: Adds, Routes, Drops."),
  body: text(400),
  focus: z
    .array(VizFocus)
    .min(1)
    .max(VIZ_LIMITS.focus)
    .describe("Ids to show. All on the diagram, or all in one flow."),
});
export type VizWalkStep = z.infer<typeof VizWalkStep>;

export const VizBase = z
  .enum(["changes", "none"])
  .describe(
    "changes: Paireto builds nodes from the diff with the language servers. none: you draw every node.",
  );
export type VizBase = z.infer<typeof VizBase>;

export const VizFile = z.strictObject({
  version: z.literal(VIZ_FILE_VERSION),
  title: text(80),
  summary: text(600).describe("What changed and why it matters. 1-3 sentences."),
  base: VizBase,
  compareTo: CompareTo.optional().describe("The diff this viz shows. Paireto sets it."),
  generatedAt: z.string().optional().describe("When Paireto generated the file. Paireto sets it."),
  lanes: z
    .array(VizLane)
    .max(VIZ_LIMITS.lanes)
    .optional()
    .describe("Columns, left to right, in the reader's mental order. Not folders."),
  nodes: z.array(VizNode).max(VIZ_LIMITS.nodes),
  edges: z.array(VizEdge).max(VIZ_LIMITS.edges).optional(),
  flows: z
    .array(VizFlow)
    .max(VIZ_LIMITS.flows)
    .optional()
    .describe("Key processes or protocols the change adds or alters."),
  walkthrough: z.array(VizWalkStep).max(VIZ_LIMITS.walkthrough).optional(),
});
export type VizFile = z.infer<typeof VizFile>;

export const VizGenerateArgs = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and -, max 63")
    .describe("File name without extension. Paireto writes .paireto/viz/<name>.viz.json."),
  base: VizBase,
  title: text(80).optional(),
});
export type VizGenerateArgs = z.infer<typeof VizGenerateArgs>;

export const VizPresentArgs = z.strictObject({
  name: z.string().min(1).describe("The name you gave paireto_viz_generate."),
});
export type VizPresentArgs = z.infer<typeof VizPresentArgs>;
