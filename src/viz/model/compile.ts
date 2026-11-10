import { VizArgs } from "../../protocol/viz.js";
import type { VizFileRef, VizFlow, VizNode } from "../../protocol/viz.js";
import { normalizePath } from "../../review/guidedPlan.js";
import { edgeKey, parseVizRef } from "./refs.js";
import type { EdgeKey, VizChangedFile, VizRef, VizRepo } from "./types.js";

export interface VizEnv {
  repoName: string;
  repos: VizRepo[];
  changed: VizChangedFile[];
  fileExists(repo: string, path: string): boolean;
}

export type VizIssueCode =
  | "schema"
  | "duplicate-id"
  | "flow-id-is-node"
  | "unknown-lane"
  | "unknown-node"
  | "unknown-participant"
  | "duplicate-participant"
  | "step-not-participant"
  | "duplicate-edge"
  | "self-edge"
  | "multiple-hero"
  | "missing-role"
  | "missing-files"
  | "flow-only-edge"
  | "focus-malformed"
  | "focus-unknown"
  | "unknown-flow"
  | "focus-mixed-stage"
  | "unknown-repo"
  | "path-outside-repo"
  | "file-not-found"
  | "line-range"
  | "coverage"
  | "delta-mismatch"
  | "isolated-node"
  | "no-edges"
  | "no-flows";

export type VizIssuePath = (string | number)[];

export interface VizIssue {
  code: VizIssueCode;
  path: VizIssuePath;
  message: string;
}

export type CompileResult =
  | { ok: true; viz: VizArgs; warnings: VizIssue[] }
  | { ok: false; errors: VizIssue[]; warnings: VizIssue[] };

export const MAX_RENDERED_ISSUES = 30;
const MAX_COVERAGE_PATHS = 10;
const MAX_LISTED_IDS = 20;
const NO_FILES_KINDS = new Set<VizNode["kind"]>(["actor", "external"]);

interface Found {
  path: VizIssuePath;
  message: string;
}

interface LocatedFileRef {
  path: VizIssuePath;
  ref: VizFileRef;
}

interface Model {
  viz: VizArgs;
  env: VizEnv;
  laneIds: Set<string>;
  nodes: Map<string, VizNode>;
  flows: Map<string, VizFlow>;
  edgeKeys: Set<EdgeKey>;
  fileRefs: LocatedFileRef[];
  changed: Map<string, VizChangedFile>;
  focus: FocusIssues;
}

type Rule = { severity: "error" | "warning"; check(model: Model): Found[] };

const RULES: Record<Exclude<VizIssueCode, "schema">, Rule> = {
  "duplicate-id": { severity: "error", check: duplicateIds },
  "flow-id-is-node": { severity: "error", check: flowIdIsNode },
  "unknown-lane": { severity: "error", check: unknownLanes },
  "unknown-node": { severity: "error", check: unknownEdgeNodes },
  "unknown-participant": { severity: "error", check: unknownParticipants },
  "duplicate-participant": { severity: "error", check: duplicateParticipants },
  "step-not-participant": { severity: "error", check: stepsOutsideParticipants },
  "duplicate-edge": { severity: "error", check: duplicateEdges },
  "self-edge": { severity: "error", check: selfEdges },
  "multiple-hero": { severity: "error", check: multipleHeroes },
  "missing-role": { severity: "error", check: missingRoles },
  "missing-files": { severity: "error", check: missingFiles },
  "flow-only-edge": { severity: "error", check: flowOnlyEdges },
  "focus-malformed": { severity: "error", check: (model) => model.focus.malformed },
  "focus-unknown": { severity: "error", check: (model) => model.focus.unknown },
  "unknown-flow": { severity: "error", check: (model) => model.focus.unknownFlow },
  "focus-mixed-stage": { severity: "error", check: (model) => model.focus.mixed },
  "unknown-repo": { severity: "error", check: unknownRepos },
  "path-outside-repo": { severity: "error", check: pathsOutsideRepo },
  "file-not-found": { severity: "error", check: filesNotFound },
  "line-range": { severity: "error", check: badLineRanges },
  coverage: { severity: "warning", check: coverage },
  "delta-mismatch": { severity: "warning", check: deltaMismatches },
  "isolated-node": { severity: "warning", check: isolatedNodes },
  "no-edges": { severity: "warning", check: noEdges },
  "no-flows": { severity: "warning", check: noFlows },
};

export const VIZ_RULE_CODES = Object.keys(RULES) as Exclude<VizIssueCode, "schema">[];

export function compileViz(raw: unknown, env: VizEnv): CompileResult {
  const parsed = VizArgs.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "schema",
        path: issue.path.map((key) => (typeof key === "number" ? key : String(key))),
        message: issue.message,
      })),
      warnings: [],
    };
  }
  const model = buildModel(parsed.data, env);
  const errors: VizIssue[] = [];
  const warnings: VizIssue[] = [];
  for (const code of VIZ_RULE_CODES) {
    const rule = RULES[code];
    for (const found of rule.check(model)) {
      (rule.severity === "error" ? errors : warnings).push({ code, ...found });
    }
  }
  return errors.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, viz: parsed.data, warnings };
}

export function renderAccepted(viz: VizArgs, warnings: VizIssue[]): string {
  const counts = [
    plural(viz.nodes.length, "node"),
    plural(viz.edges?.length ?? 0, "edge"),
    plural(viz.flows?.length ?? 0, "flow"),
    plural(viz.walkthrough?.length ?? 0, "walkthrough step"),
  ].join(", ");
  const head = `Viz "${viz.title}" is open in VS Code: ${counts}.`;
  if (warnings.length === 0) {
    return head;
  }
  return [
    head,
    "Warnings. Fix them and call paireto_show_viz again if they matter:",
    ...renderIssues(warnings),
  ].join("\n");
}

export function renderRejected(errors: VizIssue[], warnings: VizIssue[]): string {
  const lines = [
    `Viz rejected. Fix all ${errors.length} and call paireto_show_viz again. Do not remove elements to pass.`,
    ...renderIssues(errors),
  ];
  if (warnings.length > 0) {
    lines.push("Warnings:", ...renderIssues(warnings));
  }
  return lines.join("\n");
}

export function formatIssuePath(path: VizIssuePath): string {
  return path
    .map((key, index) => (typeof key === "number" ? `[${key}]` : index === 0 ? key : `.${key}`))
    .join("");
}

function renderIssues(issues: VizIssue[]): string[] {
  const shown = issues.slice(0, MAX_RENDERED_ISSUES).map((issue) => {
    const where = formatIssuePath(issue.path);
    return where ? `- ${where}: ${issue.message}` : `- ${issue.message}`;
  });
  if (issues.length > MAX_RENDERED_ISSUES) {
    shown.push(`- +${issues.length - MAX_RENDERED_ISSUES} more`);
  }
  return shown;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function buildModel(viz: VizArgs, env: VizEnv): Model {
  const nodes = new Map<string, VizNode>();
  for (const node of viz.nodes) {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  }
  const flows = new Map<string, VizFlow>();
  for (const flow of viz.flows ?? []) {
    if (!flows.has(flow.id)) {
      flows.set(flow.id, flow);
    }
  }
  const fileRefs: LocatedFileRef[] = [];
  const collect = (refs: VizFileRef[] | undefined, at: VizIssuePath) =>
    (refs ?? []).forEach((ref, index) => fileRefs.push({ path: [...at, "files", index], ref }));
  viz.nodes.forEach((node, index) => collect(node.files, ["nodes", index]));
  (viz.edges ?? []).forEach((edge, index) => collect(edge.files, ["edges", index]));
  (viz.flows ?? []).forEach((flow, flowIndex) =>
    flow.steps.forEach((step, stepIndex) =>
      collect(step.files, ["flows", flowIndex, "steps", stepIndex]),
    ),
  );
  const model = {
    viz,
    env,
    laneIds: new Set(viz.lanes.map((lane) => lane.id)),
    nodes,
    flows,
    edgeKeys: new Set((viz.edges ?? []).map((edge) => edgeKey(edge.from, edge.to))),
    fileRefs,
    changed: new Map(env.changed.map((file) => [changedKey(file.repo, file.path), file])),
  };
  return { ...model, focus: focusIssues(model) };
}

function changedKey(repo: string, path: string): string {
  return `${repo}\n${path}`;
}

function resolvedFile(
  model: RefModel,
  ref: VizFileRef,
): { repo: string; path: string } | undefined {
  const repo = ref.repo ?? model.env.repoName;
  const path = normalizePath(ref.path);
  if (!path || !model.env.repos.some((candidate) => candidate.name === repo)) {
    return undefined;
  }
  return { repo, path };
}

function duplicateIds(model: Model): Found[] {
  const found: Found[] = [];
  const scan = (collection: string, ids: string[]) => {
    const first = new Map<string, number>();
    ids.forEach((id, index) => {
      const earlier = first.get(id);
      if (earlier === undefined) {
        first.set(id, index);
        return;
      }
      found.push({
        path: [collection, index, "id"],
        message: `duplicate id "${id}", already used by ${collection}[${earlier}]. Give each one its own id.`,
      });
    });
  };
  scan(
    "lanes",
    model.viz.lanes.map((lane) => lane.id),
  );
  scan(
    "nodes",
    model.viz.nodes.map((node) => node.id),
  );
  scan(
    "flows",
    (model.viz.flows ?? []).map((flow) => flow.id),
  );
  return found;
}

function flowIdIsNode(model: Model): Found[] {
  return (model.viz.flows ?? []).flatMap((flow, index) =>
    model.nodes.has(flow.id)
      ? [
          {
            path: ["flows", index, "id"],
            message: `flow id "${flow.id}" is also a node id. Walkthrough refs name both, so use a distinct id.`,
          },
        ]
      : [],
  );
}

function unknownLanes(model: Model): Found[] {
  return model.viz.nodes.flatMap((node, index) =>
    model.laneIds.has(node.lane)
      ? []
      : [
          {
            path: ["nodes", index, "lane"],
            message: unknownMessage("lane", node.lane, [...model.laneIds]),
          },
        ],
  );
}

function unknownEdgeNodes(model: Model): Found[] {
  return (model.viz.edges ?? []).flatMap((edge, index) =>
    (["from", "to"] as const).flatMap((end) =>
      model.nodes.has(edge[end])
        ? []
        : [
            {
              path: ["edges", index, end],
              message: unknownMessage("node", edge[end], [...model.nodes.keys()]),
            },
          ],
    ),
  );
}

function unknownParticipants(model: Model): Found[] {
  return (model.viz.flows ?? []).flatMap((flow, flowIndex) =>
    flow.participants.flatMap((participant, index) =>
      model.nodes.has(participant)
        ? []
        : [
            {
              path: ["flows", flowIndex, "participants", index],
              message: unknownMessage("node", participant, [...model.nodes.keys()]),
            },
          ],
    ),
  );
}

function duplicateParticipants(model: Model): Found[] {
  return (model.viz.flows ?? []).flatMap((flow, flowIndex) =>
    flow.participants.flatMap((participant, index) =>
      flow.participants.indexOf(participant) < index
        ? [
            {
              path: ["flows", flowIndex, "participants", index],
              message: `"${participant}" is listed twice. List each participant once.`,
            },
          ]
        : [],
    ),
  );
}

function stepsOutsideParticipants(model: Model): Found[] {
  return (model.viz.flows ?? []).flatMap((flow, flowIndex) => {
    const participants = new Set(flow.participants);
    return flow.steps.flatMap((step, stepIndex) =>
      (["from", "to"] as const).flatMap((end) =>
        participants.has(step[end])
          ? []
          : [
              {
                path: ["flows", flowIndex, "steps", stepIndex, end],
                message: `"${step[end]}" is not a participant of ${flow.id}. ${didYouMean(step[end], flow.participants)}Participants: ${flow.participants.join(", ")}.`,
              },
            ],
      ),
    );
  });
}

function duplicateEdges(model: Model): Found[] {
  const first = new Map<EdgeKey, number>();
  return (model.viz.edges ?? []).flatMap((edge, index) => {
    const key = edgeKey(edge.from, edge.to);
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, index);
      return [];
    }
    return [
      {
        path: ["edges", index],
        message: `second edge ${key}, first at edges[${earlier}]. Merge into one edge, combine the labels.`,
      },
    ];
  });
}

function selfEdges(model: Model): Found[] {
  return (model.viz.edges ?? []).flatMap((edge, index) =>
    edge.from === edge.to
      ? [
          {
            path: ["edges", index],
            message: `edge ${edgeKey(edge.from, edge.to)} points at itself. Show self calls as a flow step instead.`,
          },
        ]
      : [],
  );
}

function multipleHeroes(model: Model): Found[] {
  const heroes = (model.viz.edges ?? []).flatMap((edge, index) => (edge.hero ? [index] : []));
  return heroes.slice(1).map((index) => ({
    path: ["edges", index, "hero"],
    message: `edges[${heroes[0]}] is already the hero. Mark only the main new path.`,
  }));
}

function missingRoles(model: Model): Found[] {
  return model.viz.nodes.flatMap((node, index) =>
    node.delta !== "unchanged" && !node.role
      ? [
          {
            path: ["nodes", index, "role"],
            message: `node "${node.id}" is ${node.delta}, so it needs a role: one sentence on its part in this change.`,
          },
        ]
      : [],
  );
}

function missingFiles(model: Model): Found[] {
  return model.viz.nodes.flatMap((node, index) =>
    node.delta !== "unchanged" && !NO_FILES_KINDS.has(node.kind) && !node.files?.length
      ? [
          {
            path: ["nodes", index, "files"],
            message: `node "${node.id}" is ${node.delta}, so it needs files: where it lives in the diff, with lines.`,
          },
        ]
      : [],
  );
}

function flowOnlyEdges(model: Model): Found[] {
  return (model.viz.edges ?? []).flatMap((edge, index) =>
    (["from", "to"] as const).flatMap((end) =>
      model.nodes.get(edge[end])?.flowOnly
        ? [
            {
              path: ["edges", index, end],
              message: `node "${edge[end]}" is flowOnly, so it is not in the overview. Drop flowOnly or drop the edge.`,
            },
          ]
        : [],
    ),
  );
}

interface FocusIssues {
  malformed: Found[];
  unknown: Found[];
  unknownFlow: Found[];
  mixed: Found[];
}

type RefModel = Omit<Model, "focus">;

function focusIssues(model: RefModel): FocusIssues {
  const issues: FocusIssues = { malformed: [], unknown: [], unknownFlow: [], mixed: [] };
  const flowIds = new Set(model.flows.keys());
  (model.viz.walkthrough ?? []).forEach((walk, walkIndex) => {
    const known: { ref: VizRef; index: number }[] = [];
    walk.focus.forEach((raw, index) => {
      const path = ["walkthrough", walkIndex, "focus", index];
      const ref = parseVizRef(raw, flowIds);
      if (!ref) {
        issues.malformed.push({
          path,
          message: `"${raw}" is not a ref. Use a node id, from>to, a flow id, or flowId:N.`,
        });
        return;
      }
      const problem = unknownRef(model, ref);
      if (problem) {
        (ref.kind === "step" && !model.flows.has(ref.flow)
          ? issues.unknownFlow
          : issues.unknown
        ).push({ path, message: problem });
        return;
      }
      known.push({ ref, index });
    });
    issues.mixed.push(...mixedStage(model, walkIndex, known));
  });
  return issues;
}

function unknownRef(model: RefModel, ref: VizRef): string | undefined {
  switch (ref.kind) {
    case "node":
      return model.nodes.has(ref.id)
        ? undefined
        : unknownMessage("node or flow", ref.id, [...model.nodes.keys(), ...model.flows.keys()]);
    case "flow":
      return undefined;
    case "edge":
      return model.edgeKeys.has(ref.key)
        ? undefined
        : unknownMessage("edge", ref.key, [...model.edgeKeys]);
    case "step": {
      const flow = model.flows.get(ref.flow);
      if (!flow) {
        return unknownMessage("flow", ref.flow, [...model.flows.keys()]);
      }
      return ref.index < flow.steps.length
        ? undefined
        : `${ref.flow}:${ref.index + 1} is past the last step of ${ref.flow} (${flow.steps.length}).`;
    }
  }
}

function mixedStage(
  model: RefModel,
  walkIndex: number,
  known: { ref: VizRef; index: number }[],
): Found[] {
  const flowsNamed = [
    ...new Set(
      known.flatMap(({ ref }) =>
        ref.kind === "flow" ? [ref.id] : ref.kind === "step" ? [ref.flow] : [],
      ),
    ),
  ];
  if (flowsNamed.length === 0) {
    return [];
  }
  if (flowsNamed.length > 1) {
    return [
      {
        path: ["walkthrough", walkIndex, "focus"],
        message: `refs name ${flowsNamed.length} flows (${flowsNamed.join(", ")}). One step shows one stage, so split it into one step per flow.`,
      },
    ];
  }
  const flow = model.flows.get(flowsNamed[0])!;
  const participants = new Set(flow.participants);
  return known.flatMap(({ ref, index }): Found[] => {
    const path = ["walkthrough", walkIndex, "focus", index];
    if (ref.kind === "edge") {
      return [
        {
          path,
          message: `edge ${ref.key} is an overview ref, but this step shows flow ${flow.id}. Name a step of ${flow.id} instead, or move the edge to its own step.`,
        },
      ];
    }
    if (ref.kind === "node" && !participants.has(ref.id)) {
      return [
        {
          path,
          message: `"${ref.id}" is not a participant of ${flow.id}, which this step shows. Participants: ${flow.participants.join(", ")}.`,
        },
      ];
    }
    return [];
  });
}

function unknownRepos(model: Model): Found[] {
  const names = model.env.repos.map((repo) => repo.name);
  return model.fileRefs.flatMap(({ path, ref }) =>
    ref.repo === undefined || names.includes(ref.repo)
      ? []
      : [{ path: [...path, "repo"], message: unknownMessage("repo", ref.repo, names) }],
  );
}

function pathsOutsideRepo(model: Model): Found[] {
  return model.fileRefs.flatMap(({ path, ref }) =>
    normalizePath(ref.path)
      ? []
      : [
          {
            path: [...path, "path"],
            message: `"${ref.path}" is not a path inside the repo. Use a repo-relative path without "..".`,
          },
        ],
  );
}

function filesNotFound(model: Model): Found[] {
  return model.fileRefs.flatMap(({ path, ref }) => {
    const file = resolvedFile(model, ref);
    if (
      !file ||
      model.changed.has(changedKey(file.repo, file.path)) ||
      model.env.fileExists(file.repo, file.path)
    ) {
      return [];
    }
    const changedPaths = model.env.changed
      .filter((changed) => changed.repo === file.repo)
      .map((changed) => changed.path);
    const base = file.path.split("/").pop();
    const suggestion =
      changedPaths.find((candidate) => candidate.split("/").pop() === base) ??
      closest(file.path, changedPaths);
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
    return [
      {
        path: [...path, "path"],
        message: `"${file.path}" is not in the changes and not on disk in ${file.repo}.${hint}`,
      },
    ];
  });
}

function badLineRanges(model: Model): Found[] {
  return model.fileRefs.flatMap(({ path, ref }) =>
    ref.line !== undefined && ref.endLine !== undefined && ref.endLine < ref.line
      ? [
          {
            path: [...path, "endLine"],
            message: `endLine ${ref.endLine} is before line ${ref.line}.`,
          },
        ]
      : [],
  );
}

function coverage(model: Model): Found[] {
  const referenced = new Set(
    model.fileRefs.flatMap(({ ref }) => {
      const file = resolvedFile(model, ref);
      return file ? [changedKey(file.repo, file.path)] : [];
    }),
  );
  const missing = model.env.changed
    .filter((file) => !referenced.has(changedKey(file.repo, file.path)))
    .map((file) => (file.repo === model.env.repoName ? file.path : `${file.repo}:${file.path}`));
  if (missing.length === 0) {
    return [];
  }
  const listed = missing.slice(0, MAX_COVERAGE_PATHS).join(", ");
  const more =
    missing.length > MAX_COVERAGE_PATHS ? ` +${missing.length - MAX_COVERAGE_PATHS} more` : "";
  return [
    {
      path: [],
      message: `${plural(missing.length, "changed file")} on no node, edge or step: ${listed}${more}`,
    },
  ];
}

function deltaMismatches(model: Model): Found[] {
  return model.viz.nodes.flatMap((node, index): Found[] => {
    const statuses = (node.files ?? []).flatMap((ref) => {
      const file = resolvedFile(model, ref);
      const changed = file && model.changed.get(changedKey(file.repo, file.path));
      return changed ? [{ path: changed.path, status: changed.status }] : [];
    });
    const path = ["nodes", index, "delta"];
    if (node.delta === "added" && statuses.length > 0 && !statuses.some((s) => s.status === "A")) {
      return [{ path, message: `node "${node.id}" is added, but none of its files is added.` }];
    }
    if (
      node.delta === "deleted" &&
      statuses.length > 0 &&
      !statuses.some((s) => s.status === "D")
    ) {
      return [{ path, message: `node "${node.id}" is deleted, but none of its files is deleted.` }];
    }
    if (node.delta === "unchanged" && statuses.length > 0) {
      return [
        {
          path,
          message: `node "${node.id}" is unchanged, but its file ${statuses[0].path} changed (${statuses[0].status}).`,
        },
      ];
    }
    return [];
  });
}

function isolatedNodes(model: Model): Found[] {
  const linked = new Set<string>();
  for (const edge of model.viz.edges ?? []) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  for (const flow of model.viz.flows ?? []) {
    flow.participants.forEach((participant) => linked.add(participant));
  }
  return model.viz.nodes.flatMap((node, index) =>
    linked.has(node.id)
      ? []
      : [
          {
            path: ["nodes", index],
            message: `node "${node.id}" is on no edge and in no flow. Connect it to the parts it talks to.`,
          },
        ],
  );
}

function noEdges(model: Model): Found[] {
  return model.viz.nodes.length > 1 && (model.viz.edges ?? []).length === 0
    ? [{ path: ["edges"], message: "no edges. Edges say how the parts interact." }]
    : [];
}

function noFlows(model: Model): Found[] {
  const changedNodes = model.viz.nodes.filter((node) => node.delta !== "unchanged").length;
  return changedNodes >= 3 && (model.viz.flows ?? []).length === 0
    ? [
        {
          path: ["flows"],
          message: `no flows, but ${changedNodes} nodes changed. Add the key processes the change adds or alters.`,
        },
      ]
    : [];
}

function unknownMessage(what: string, value: string, valid: string[]): string {
  const listed = valid.slice(0, MAX_LISTED_IDS).join(", ");
  const more = valid.length > MAX_LISTED_IDS ? `, +${valid.length - MAX_LISTED_IDS} more` : "";
  const known = valid.length > 0 ? `Valid: ${listed}${more}.` : `There are none.`;
  return `unknown ${what} "${value}". ${didYouMean(value, valid)}${known}`;
}

function didYouMean(value: string, candidates: string[]): string {
  const best = closest(value, candidates);
  return best === undefined ? "" : `Did you mean "${best}"? `;
}

function closest(value: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(value, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
