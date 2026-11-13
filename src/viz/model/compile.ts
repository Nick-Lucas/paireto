import { VizArgs } from "../../protocol/viz.js";
import type { VizFileRef, VizNode } from "../../protocol/viz.js";
import { normalizePath } from "../../review/guidedPlan.js";
import { buildVizIndex, refInStage, walkStage, type Stage, type VizIndex } from "./index.js";
import { edgeKey, formatVizRef, parseVizRef } from "./refs.js";
import { plural } from "./render.js";
import { closest, didYouMean } from "./similarity.js";
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

interface Files {
  env: VizEnv;
  refs: LocatedFileRef[];
  changed: Map<string, VizChangedFile>;
}

type Rule = { severity: "error" | "warning"; check(index: VizIndex, files: Files): Found[] };

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
  "focus-malformed": { severity: "error", check: (index) => focusIssues(index, "focus-malformed") },
  "focus-unknown": { severity: "error", check: (index) => focusIssues(index, "focus-unknown") },
  "unknown-flow": { severity: "error", check: (index) => focusIssues(index, "unknown-flow") },
  "focus-mixed-stage": {
    severity: "error",
    check: (index) => focusIssues(index, "focus-mixed-stage"),
  },
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
  const index = buildVizIndex(parsed.data);
  const files = collectFiles(parsed.data, env);
  const errors: VizIssue[] = [];
  const warnings: VizIssue[] = [];
  for (const code of VIZ_RULE_CODES) {
    const rule = RULES[code];
    for (const found of rule.check(index, files)) {
      (rule.severity === "error" ? errors : warnings).push({ code, ...found });
    }
  }
  return errors.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, viz: parsed.data, warnings };
}

function collectFiles(viz: VizArgs, env: VizEnv): Files {
  const refs: LocatedFileRef[] = [];
  const collect = (files: VizFileRef[] | undefined, at: VizIssuePath) =>
    (files ?? []).forEach((ref, index) => refs.push({ path: [...at, "files", index], ref }));
  viz.nodes.forEach((node, index) => collect(node.files, ["nodes", index]));
  (viz.edges ?? []).forEach((edge, index) => collect(edge.files, ["edges", index]));
  (viz.flows ?? []).forEach((flow, flowIndex) =>
    flow.steps.forEach((step, stepIndex) =>
      collect(step.files, ["flows", flowIndex, "steps", stepIndex]),
    ),
  );
  return {
    env,
    refs,
    changed: new Map(env.changed.map((file) => [changedKey(file.repo, file.path), file])),
  };
}

function changedKey(repo: string, path: string): string {
  return `${repo}\n${path}`;
}

function resolvedFile(env: VizEnv, ref: VizFileRef): { repo: string; path: string } | undefined {
  const repo = ref.repo ?? env.repoName;
  const path = normalizePath(ref.path);
  if (!path || !env.repos.some((candidate) => candidate.name === repo)) {
    return undefined;
  }
  return { repo, path };
}

function duplicateIds(index: VizIndex): Found[] {
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
    index.viz.lanes.map((lane) => lane.id),
  );
  scan(
    "nodes",
    index.viz.nodes.map((node) => node.id),
  );
  scan(
    "flows",
    index.flows.map((flow) => flow.id),
  );
  return found;
}

function flowIdIsNode(index: VizIndex): Found[] {
  return index.flows.flatMap((flow, at) =>
    index.nodeById.has(flow.id)
      ? [
          {
            path: ["flows", at, "id"],
            message: `flow id "${flow.id}" is also a node id. Walkthrough refs name both, so use a distinct id.`,
          },
        ]
      : [],
  );
}

function unknownLanes(index: VizIndex): Found[] {
  return index.nodes.flatMap((node, at) =>
    index.laneIndex.has(node.lane)
      ? []
      : [
          {
            path: ["nodes", at, "lane"],
            message: unknownMessage("lane", node.lane, [...index.laneIndex.keys()]),
          },
        ],
  );
}

function unknownEdgeNodes(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, at) =>
    (["from", "to"] as const).flatMap((end) =>
      index.nodeById.has(edge[end])
        ? []
        : [
            {
              path: ["edges", at, end],
              message: unknownMessage("node", edge[end], [...index.nodeById.keys()]),
            },
          ],
    ),
  );
}

function unknownParticipants(index: VizIndex): Found[] {
  return index.flows.flatMap((flow, flowIndex) =>
    flow.participants.flatMap((participant, at) =>
      index.nodeById.has(participant)
        ? []
        : [
            {
              path: ["flows", flowIndex, "participants", at],
              message: unknownMessage("node", participant, [...index.nodeById.keys()]),
            },
          ],
    ),
  );
}

function duplicateParticipants(index: VizIndex): Found[] {
  return index.flows.flatMap((flow, flowIndex) =>
    flow.participants.flatMap((participant, at) =>
      flow.participants.indexOf(participant) < at
        ? [
            {
              path: ["flows", flowIndex, "participants", at],
              message: `"${participant}" is listed twice. List each participant once.`,
            },
          ]
        : [],
    ),
  );
}

function stepsOutsideParticipants(index: VizIndex): Found[] {
  return index.flows.flatMap((flow, flowIndex) => {
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

function duplicateEdges(index: VizIndex): Found[] {
  const first = new Map<EdgeKey, number>();
  return index.edges.flatMap((edge, at) => {
    const key = edgeKey(edge.from, edge.to);
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, at);
      return [];
    }
    return [
      {
        path: ["edges", at],
        message: `second edge ${key}, first at edges[${earlier}]. Merge into one edge, combine the labels.`,
      },
    ];
  });
}

function selfEdges(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, at) =>
    edge.from === edge.to
      ? [
          {
            path: ["edges", at],
            message: `edge ${edgeKey(edge.from, edge.to)} points at itself. Show self calls as a flow step instead.`,
          },
        ]
      : [],
  );
}

function multipleHeroes(index: VizIndex): Found[] {
  const heroes = index.edges.flatMap((edge, at) => (edge.hero ? [at] : []));
  return heroes.slice(1).map((at) => ({
    path: ["edges", at, "hero"],
    message: `edges[${heroes[0]}] is already the hero. Mark only the main new path.`,
  }));
}

function missingRoles(index: VizIndex): Found[] {
  return index.nodes.flatMap((node, at) =>
    node.delta !== "unchanged" && !node.role
      ? [
          {
            path: ["nodes", at, "role"],
            message: `node "${node.id}" is ${node.delta}, so it needs a role: one sentence on its part in this change.`,
          },
        ]
      : [],
  );
}

function missingFiles(index: VizIndex): Found[] {
  return index.nodes.flatMap((node, at) =>
    node.delta !== "unchanged" && !NO_FILES_KINDS.has(node.kind) && !node.files?.length
      ? [
          {
            path: ["nodes", at, "files"],
            message: `node "${node.id}" is ${node.delta}, so it needs files: where it lives in the diff, with lines.`,
          },
        ]
      : [],
  );
}

function flowOnlyEdges(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, at) =>
    (["from", "to"] as const).flatMap((end) =>
      index.nodeById.get(edge[end])?.flowOnly
        ? [
            {
              path: ["edges", at, end],
              message: `node "${edge[end]}" is flowOnly, so it is not in the overview. Drop flowOnly or drop the edge.`,
            },
          ]
        : [],
    ),
  );
}

type FocusCode = "focus-malformed" | "focus-unknown" | "unknown-flow" | "focus-mixed-stage";

function focusIssues(index: VizIndex, code: FocusCode): Found[] {
  return (
    index.viz.walkthrough?.flatMap((walk, walkIndex) => {
      const found: (Found & { code: FocusCode })[] = [];
      const known: { ref: VizRef; at: number }[] = [];
      walk.focus.forEach((raw, at) => {
        const path = ["walkthrough", walkIndex, "focus", at];
        const ref = parseVizRef(raw, new Set(index.flowById.keys()));
        if (!ref) {
          found.push({
            code: "focus-malformed",
            path,
            message: `"${raw}" is not a ref. Use a node id, from>to, a flow id, or flowId:N.`,
          });
          return;
        }
        const problem = unknownRef(index, ref);
        if (problem) {
          const flowMissing = ref.kind === "step" && !index.flowById.has(ref.flow);
          found.push({
            code: flowMissing ? "unknown-flow" : "focus-unknown",
            path,
            message: problem,
          });
          return;
        }
        known.push({ ref, at });
      });
      const stage = walkStage(known.map(({ ref }) => ref));
      for (const { ref, at } of known) {
        if (!refInStage(index, ref, stage)) {
          found.push({
            code: "focus-mixed-stage",
            path: ["walkthrough", walkIndex, "focus", at],
            message: offStage(index, ref, stage),
          });
        }
      }
      return found
        .filter((issue) => issue.code === code)
        .map(({ path, message }) => ({ path, message }));
    }) ?? []
  );
}

function unknownRef(index: VizIndex, ref: VizRef): string | undefined {
  switch (ref.kind) {
    case "node":
      return index.nodeById.has(ref.id)
        ? undefined
        : unknownMessage("node or flow", ref.id, [
            ...index.nodeById.keys(),
            ...index.flowById.keys(),
          ]);
    case "flow":
      return undefined;
    case "edge":
      return index.edgesByKey.has(ref.key)
        ? undefined
        : unknownMessage("edge", ref.key, [...index.edgesByKey.keys()]);
    case "step": {
      const flow = index.flowById.get(ref.flow);
      if (!flow) {
        return unknownMessage("flow", ref.flow, [...index.flowById.keys()]);
      }
      return ref.index < flow.steps.length
        ? undefined
        : `${formatVizRef(ref)} is past the last step of ${ref.flow} (${flow.steps.length}).`;
    }
  }
}

function offStage(index: VizIndex, ref: VizRef, stage: Stage): string {
  if (stage.kind === "overview") {
    return `"${formatVizRef(ref)}" is flowOnly, so it is not in the overview. Name a step of a flow it is in, or drop flowOnly.`;
  }
  const flow = stage.flow;
  switch (ref.kind) {
    case "edge":
      return `edge ${ref.key} is an overview ref, but this step shows flow ${flow}. Name a step of ${flow} instead, or move the edge to its own step.`;
    case "node":
      return `"${ref.id}" is not a participant of ${flow}, which this step shows. Participants: ${index.flowById.get(flow)?.participants.join(", ")}.`;
    case "flow":
    case "step":
      return `"${formatVizRef(ref)}" names another flow, but this step shows ${flow}. One step shows one stage, so split it into one step per flow.`;
  }
}

function unknownRepos(_index: VizIndex, files: Files): Found[] {
  const names = files.env.repos.map((repo) => repo.name);
  return files.refs.flatMap(({ path, ref }) =>
    ref.repo === undefined || names.includes(ref.repo)
      ? []
      : [{ path: [...path, "repo"], message: unknownMessage("repo", ref.repo, names) }],
  );
}

function pathsOutsideRepo(_index: VizIndex, files: Files): Found[] {
  return files.refs.flatMap(({ path, ref }) =>
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

function filesNotFound(_index: VizIndex, files: Files): Found[] {
  return files.refs.flatMap(({ path, ref }) => {
    const file = resolvedFile(files.env, ref);
    if (
      !file ||
      files.changed.has(changedKey(file.repo, file.path)) ||
      files.env.fileExists(file.repo, file.path)
    ) {
      return [];
    }
    const changedPaths = files.env.changed
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

function badLineRanges(_index: VizIndex, files: Files): Found[] {
  return files.refs.flatMap(({ path, ref }) =>
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

function coverage(_index: VizIndex, files: Files): Found[] {
  const referenced = new Set(
    files.refs.flatMap(({ ref }) => {
      const file = resolvedFile(files.env, ref);
      return file ? [changedKey(file.repo, file.path)] : [];
    }),
  );
  const missing = files.env.changed
    .filter((file) => !referenced.has(changedKey(file.repo, file.path)))
    .map((file) => (file.repo === files.env.repoName ? file.path : `${file.repo}:${file.path}`));
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

function deltaMismatches(index: VizIndex, files: Files): Found[] {
  return index.nodes.flatMap((node, at): Found[] => {
    const statuses = (node.files ?? []).flatMap((ref) => {
      const file = resolvedFile(files.env, ref);
      const changed = file && files.changed.get(changedKey(file.repo, file.path));
      return changed ? [{ path: changed.path, status: changed.status }] : [];
    });
    const path = ["nodes", at, "delta"];
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

function isolatedNodes(index: VizIndex): Found[] {
  const linked = new Set<string>();
  for (const edge of index.edges) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  for (const flow of index.flows) {
    flow.participants.forEach((participant) => linked.add(participant));
  }
  return index.nodes.flatMap((node, at) =>
    linked.has(node.id)
      ? []
      : [
          {
            path: ["nodes", at],
            message: `node "${node.id}" is on no edge and in no flow. Connect it to the parts it talks to.`,
          },
        ],
  );
}

function noEdges(index: VizIndex): Found[] {
  return index.nodes.length > 1 && index.edges.length === 0
    ? [{ path: ["edges"], message: "no edges. Edges say how the parts interact." }]
    : [];
}

function noFlows(index: VizIndex): Found[] {
  const changedNodes = index.nodes.filter((node) => node.delta !== "unchanged").length;
  return changedNodes >= 3 && index.flows.length === 0
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
