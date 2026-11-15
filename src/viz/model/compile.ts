import { VizFile } from "../../protocol/viz.js";
import type { VizFileRef, VizNode, VizStepRef } from "../../protocol/viz.js";
import { normalizePath } from "../../review/guidedPlan.js";
import type { VizFileStatus } from "../protocol.js";
import { buildVizIndex, refInStage, walkStage, type Stage, type VizIndex } from "./index.js";
import { resolveFocus } from "./refs.js";
import { plural } from "./render.js";
import { closest } from "./similarity.js";
import type { VizIssue, VizIssueSeverity, VizRef, VizRepo } from "./types.js";

export interface VizChangedFile {
  repo: string;
  path: string;
  status: VizFileStatus;
  additions: number;
  deletions: number;
}

export interface VizEnv {
  repoName: string;
  repos: VizRepo[];
  changed: VizChangedFile[];
  fileExists(repo: string, path: string): boolean;
}

export type CompileResult =
  | { ok: true; viz: VizFile; issues: VizIssue[] }
  | { ok: false; issues: VizIssue[] };

type IssuePath = (string | number)[];

interface Found {
  path: IssuePath;
  message: string;
  suggestion?: string;
}

interface LocatedFileRef {
  path: IssuePath;
  ref: VizFileRef;
}

interface Files {
  env: VizEnv;
  refs: LocatedFileRef[];
  changed: Map<string, VizChangedFile>;
}

interface Rule {
  severity: VizIssueSeverity;
  check(index: VizIndex, files: Files): Found[];
}

const MAX_COVERAGE_PATHS = 10;
const MAX_LISTED_IDS = 20;
const NO_FILES_KINDS = new Set<VizNode["kind"]>(["actor", "external", "package", "system"]);
const ENDS = ["from", "to"] as const;

const RULES = {
  "duplicate-id": { severity: "error", check: duplicateIds },
  "unknown-parent": { severity: "error", check: unknownParents },
  "parent-cycle": { severity: "error", check: parentCycles },
  "unknown-lane": { severity: "error", check: unknownLanes },
  "unknown-node": { severity: "error", check: unknownEdgeNodes },
  "unknown-member": { severity: "error", check: unknownEdgeMembers },
  "unknown-via": { severity: "error", check: unknownVia },
  "unknown-participant": { severity: "error", check: unknownParticipants },
  "duplicate-participant": { severity: "error", check: duplicateParticipants },
  "step-not-participant": { severity: "error", check: stepsOutsideParticipants },
  "step-edge": { severity: "error", check: stepEdges },
  "fragment-range": { severity: "error", check: fragmentRanges },
  "fragment-overlap": { severity: "error", check: fragmentOverlaps },
  "multiple-hero": { severity: "error", check: multipleHeroes },
  "flow-only-edge": { severity: "error", check: flowOnlyEdges },
  "focus-unknown": { severity: "error", check: (index) => focusIssues(index).unknown },
  "focus-mixed-stage": { severity: "error", check: (index) => focusIssues(index).offStage },
  "unknown-repo": { severity: "error", check: unknownRepos },
  "path-outside-repo": { severity: "error", check: pathsOutsideRepo },
  "file-not-found": { severity: "error", check: filesNotFound },
  "line-range": { severity: "error", check: badLineRanges },
  "self-edge": { severity: "warning", check: selfEdges },
  "missing-role": { severity: "warning", check: missingRoles },
  "missing-files": { severity: "warning", check: missingFiles },
  coverage: { severity: "warning", check: coverage },
  "delta-mismatch": { severity: "warning", check: deltaMismatches },
  "isolated-node": { severity: "warning", check: isolatedNodes },
  "no-edges": { severity: "warning", check: noEdges },
  "no-flows": { severity: "warning", check: noFlows },
} satisfies Record<string, Rule>;

export type VizRuleCode = keyof typeof RULES;

export const VIZ_RULE_CODES = Object.keys(RULES) as VizRuleCode[];

export function compileViz(raw: unknown, env: VizEnv): CompileResult {
  const parsed = VizFile.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        severity: "error",
        rule: "schema",
        path: formatIssuePath(
          issue.path.map((key) => (typeof key === "number" ? key : String(key))),
        ),
        message: issue.message,
      })),
    };
  }
  const index = buildVizIndex(parsed.data);
  const files = collectFiles(parsed.data, env);
  const issues: VizIssue[] = [];
  for (const rule of VIZ_RULE_CODES) {
    const { severity, check }: Rule = RULES[rule];
    for (const { path, ...found } of check(index, files)) {
      issues.push({ severity, rule, path: formatIssuePath(path), ...found });
    }
  }
  return issues.some((issue) => issue.severity === "error")
    ? { ok: false, issues }
    : { ok: true, viz: parsed.data, issues };
}

export function formatIssuePath(path: readonly (string | number)[]): string {
  return path
    .map((key, at) => (typeof key === "number" ? `[${key}]` : at === 0 ? key : `.${key}`))
    .join("");
}

function collectFiles(viz: VizFile, env: VizEnv): Files {
  const refs: LocatedFileRef[] = [];
  const collect = (files: VizFileRef[] | undefined, at: IssuePath) =>
    (files ?? []).forEach((ref, index) => refs.push({ path: [...at, "files", index], ref }));
  viz.nodes.forEach((node, nodeIndex) => {
    collect(node.files, ["nodes", nodeIndex]);
    node.members?.forEach((member, memberIndex) => {
      if (member.file) {
        refs.push({ path: ["nodes", nodeIndex, "members", memberIndex, "file"], ref: member.file });
      }
    });
  });
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

function unknown(
  path: IssuePath,
  what: string,
  value: string,
  valid: readonly string[],
  hint = "",
): Found {
  const listed = valid.slice(0, MAX_LISTED_IDS).join(", ");
  const more = valid.length > MAX_LISTED_IDS ? `, +${valid.length - MAX_LISTED_IDS} more` : "";
  const known = valid.length > 0 ? `Valid: ${listed}${more}.` : "There are none.";
  return {
    path,
    message: `unknown ${what} "${value}". ${hint}${known}`,
    suggestion: closest(value, valid),
  };
}

function duplicateIds(index: VizIndex): Found[] {
  const found: Found[] = [];
  const first = new Map<string, string>();
  const claim = (id: string, path: IssuePath, owner: string, isDefault = false) => {
    const earlier = first.get(id);
    if (earlier === undefined) {
      first.set(id, owner);
      return;
    }
    found.push({
      path,
      message: isDefault
        ? `edge has the default id "${id}", already used by ${earlier}. Give it its own id, or merge the two edges.`
        : `duplicate id "${id}", already used by ${earlier}. Ids are unique across nodes, members, edges and flows.`,
    });
  };
  index.viz.nodes.forEach((node, nodeIndex) => {
    claim(node.id, ["nodes", nodeIndex, "id"], `nodes[${nodeIndex}]`);
    node.members?.forEach((member, memberIndex) =>
      claim(
        member.id,
        ["nodes", nodeIndex, "members", memberIndex, "id"],
        `nodes[${nodeIndex}].members[${memberIndex}]`,
      ),
    );
  });
  index.edges.forEach((edge, at) =>
    index.viz.edges?.[at].id === undefined
      ? claim(edge.id, ["edges", at], `edges[${at}]`, true)
      : claim(edge.id, ["edges", at, "id"], `edges[${at}]`),
  );
  index.flows.forEach((flow, at) => claim(flow.id, ["flows", at, "id"], `flows[${at}]`));
  const lanes = new Map<string, number>();
  index.lanes.forEach((lane, at) => {
    const earlier = lanes.get(lane.id);
    if (earlier === undefined) {
      lanes.set(lane.id, at);
      return;
    }
    found.push({
      path: ["lanes", at, "id"],
      message: `duplicate lane id "${lane.id}", already used by lanes[${earlier}].`,
    });
  });
  return found;
}

function unknownParents(index: VizIndex): Found[] {
  return index.nodes.flatMap((node, at) =>
    node.parent === undefined || index.nodeById.has(node.parent)
      ? []
      : [unknown(["nodes", at, "parent"], "node", node.parent, [...index.nodeById.keys()])],
  );
}

function parentCycles(index: VizIndex): Found[] {
  return index.nodes.flatMap((node, at) => {
    const chain = [node.id];
    let parent = node.parent;
    while (parent !== undefined && !chain.includes(parent)) {
      chain.push(parent);
      parent = index.nodeById.get(parent)?.parent;
    }
    if (parent !== node.id) {
      return [];
    }
    const message =
      chain.length === 1
        ? `node "${node.id}" is its own parent. Name the node that frames it, or drop parent.`
        : `parent chain loops: ${[...chain, node.id].join(" -> ")}. Nest nodes as a tree.`;
    return [{ path: ["nodes", at, "parent"], message }];
  });
}

function unknownLanes(index: VizIndex): Found[] {
  return index.nodes.flatMap((node, at) =>
    node.lane === undefined || index.laneIndex.has(node.lane)
      ? []
      : [unknown(["nodes", at, "lane"], "lane", node.lane, [...index.laneIndex.keys()])],
  );
}

function unknownEdgeNodes(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, at) =>
    ENDS.flatMap((end) =>
      index.nodeById.has(edge[end])
        ? []
        : [unknown(["edges", at, end], "node", edge[end], [...index.nodeById.keys()])],
    ),
  );
}

function unknownEdgeMembers(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, at) =>
    ENDS.flatMap((end): Found[] => {
      const key = end === "from" ? "fromMember" : "toMember";
      const memberId = edge[key];
      const node = index.nodeById.get(edge[end]);
      if (memberId === undefined || !node) {
        return [];
      }
      const owner = index.memberById.get(memberId)?.node;
      if (owner?.id === node.id) {
        return [];
      }
      const valid = (node.members ?? []).map((member) => member.id);
      if (owner) {
        return [
          {
            path: ["edges", at, key],
            message: `member "${memberId}" belongs to node "${owner.id}", not "${node.id}". Name a member of "${node.id}".`,
            suggestion: closest(memberId, valid),
          },
        ];
      }
      return [unknown(["edges", at, key], `member of "${node.id}"`, memberId, valid)];
    }),
  );
}

function unknownVia(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, edgeIndex) =>
    (edge.via ?? []).flatMap((memberId, at) =>
      index.memberById.has(memberId)
        ? []
        : [
            unknown(["edges", edgeIndex, "via", at], "member", memberId, [
              ...index.memberById.keys(),
            ]),
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
            unknown(["flows", flowIndex, "participants", at], "node", participant, [
              ...index.nodeById.keys(),
            ]),
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
      ENDS.flatMap((end) =>
        participants.has(step[end])
          ? []
          : [
              {
                path: ["flows", flowIndex, "steps", stepIndex, end],
                message: `"${step[end]}" is not a participant of ${flow.id}. Participants: ${flow.participants.join(", ")}.`,
                suggestion: closest(step[end], flow.participants),
              },
            ],
      ),
    );
  });
}

function stepEdges(index: VizIndex): Found[] {
  return (index.viz.flows ?? []).flatMap((flow, flowIndex) =>
    flow.steps.flatMap((step, stepIndex): Found[] => {
      if (step.edge === undefined) {
        return [];
      }
      const path = ["flows", flowIndex, "steps", stepIndex, "edge"];
      const edge = index.edgeById.get(step.edge);
      if (!edge) {
        return [unknown(path, "edge", step.edge, [...index.edgeById.keys()])];
      }
      const same = edge.from === step.from && edge.to === step.to;
      const reversed = edge.from === step.to && edge.to === step.from;
      return same || reversed
        ? []
        : [
            {
              path,
              message: `step goes ${step.from} -> ${step.to}, but edge "${edge.id}" joins ${edge.from} and ${edge.to}. Name an edge between the step's ends, or drop edge.`,
            },
          ];
    }),
  );
}

function fragmentRanges(index: VizIndex): Found[] {
  return index.flows.flatMap((flow, flowIndex) =>
    flow.fragments.flatMap((fragment, at): Found[] => {
      const path = ["flows", flowIndex, "fragments", at];
      if (fragment.from > fragment.to) {
        return [
          { path: [...path, "to"], message: `to ${fragment.to} is before from ${fragment.from}.` },
        ];
      }
      return fragment.to > flow.steps.length
        ? [
            {
              path: [...path, "to"],
              message: `to ${fragment.to} is past the last step of ${flow.id} (${flow.steps.length}). Steps are 1-based.`,
            },
          ]
        : [];
    }),
  );
}

function fragmentOverlaps(index: VizIndex): Found[] {
  return index.flows.flatMap((flow, flowIndex) => {
    const valid = flow.fragments.flatMap((fragment, at) =>
      fragment.from <= fragment.to && fragment.to <= flow.steps.length ? [{ fragment, at }] : [],
    );
    return valid.flatMap(({ fragment: b, at }, position) => {
      const crossed = valid
        .slice(0, position)
        .find(
          ({ fragment: a }) =>
            (a.from < b.from && b.from <= a.to && a.to < b.to) ||
            (b.from < a.from && a.from <= b.to && b.to < a.to),
        );
      return crossed
        ? [
            {
              path: ["flows", flowIndex, "fragments", at],
              message: `steps ${b.from}-${b.to} cross fragments[${crossed.at}] (steps ${crossed.fragment.from}-${crossed.fragment.to}). Fragments nest inside each other or do not touch.`,
            },
          ]
        : [];
    });
  });
}

function multipleHeroes(index: VizIndex): Found[] {
  const heroes = index.edges.flatMap((edge, at) => (edge.hero ? [at] : []));
  return heroes.slice(1).map((at) => ({
    path: ["edges", at, "hero"],
    message: `edges[${heroes[0]}] is already the hero. Mark only the main new path.`,
  }));
}

function flowOnlyEdges(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, at) =>
    ENDS.flatMap((end) =>
      index.nodeById.get(edge[end])?.flowOnly
        ? [
            {
              path: ["edges", at, end],
              message: `node "${edge[end]}" is flowOnly, so it is not on the diagram. Drop flowOnly or drop the edge.`,
            },
          ]
        : [],
    ),
  );
}

function focusIssues(index: VizIndex): { unknown: Found[]; offStage: Found[] } {
  const ids = [
    ...index.nodeById.keys(),
    ...index.memberById.keys(),
    ...index.edgeById.keys(),
    ...index.flowById.keys(),
  ];
  const result = { unknown: [] as Found[], offStage: [] as Found[] };
  index.viz.walkthrough?.forEach((walk, walkIndex) => {
    const known: { ref: VizRef; at: number }[] = [];
    walk.focus.forEach((focus, at) => {
      const path = ["walkthrough", walkIndex, "focus", at];
      const ref = resolveFocus(focus, index);
      if (ref) {
        known.push({ ref, at });
      } else if (typeof focus === "string") {
        result.unknown.push(unknown(path, "node, member, edge or flow", focus, ids));
      } else {
        result.unknown.push(unknownStep(index, path, focus));
      }
    });
    const stage = walkStage(known.map(({ ref }) => ref));
    for (const { ref, at } of known) {
      if (!refInStage(index, ref, stage)) {
        result.offStage.push({
          path: ["walkthrough", walkIndex, "focus", at],
          message: offStage(index, ref, stage),
        });
      }
    }
  });
  return result;
}

function unknownStep(index: VizIndex, path: IssuePath, focus: VizStepRef): Found {
  const flow = index.flowById.get(focus.flow);
  return flow
    ? {
        path: [...path, "step"],
        message: `step ${focus.step} is past the last step of ${focus.flow} (${flow.steps.length}). Steps are 1-based.`,
      }
    : unknown([...path, "flow"], "flow", focus.flow, [...index.flowById.keys()]);
}

function offStage(index: VizIndex, ref: VizRef, stage: Stage): string {
  if (stage.kind === "overview") {
    const node = ref.kind === "member" ? ref.node : ref.kind === "node" ? ref.id : "";
    return `node "${node}" is flowOnly, so it is not on the diagram. Name a step of a flow it is in, or drop flowOnly.`;
  }
  const flow = stage.flow;
  switch (ref.kind) {
    case "edge":
    case "member":
      return `${ref.kind} "${ref.id}" is on the diagram, but this step shows flow ${flow}. Name a step of ${flow} instead, or move it to its own walkthrough step.`;
    case "node":
      return `"${ref.id}" is not a participant of ${flow}, which this step shows. Participants: ${index.flowById.get(flow)?.participants.join(", ")}.`;
    case "flow":
      return `flow "${ref.id}" is another flow, but this step shows ${flow}. One step shows one stage, so split it into one step per flow.`;
    case "step":
      return `a step of flow "${ref.flow}" is in another flow, but this step shows ${flow}. One step shows one stage, so split it into one step per flow.`;
  }
}

function unknownRepos(_index: VizIndex, files: Files): Found[] {
  const names = files.env.repos.map((repo) => repo.name);
  return files.refs.flatMap(({ path, ref }) =>
    ref.repo === undefined || names.includes(ref.repo)
      ? []
      : [unknown([...path, "repo"], "repo", ref.repo, names)],
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
      ref.side === "base" ||
      files.changed.has(changedKey(file.repo, file.path)) ||
      files.env.fileExists(file.repo, file.path)
    ) {
      return [];
    }
    const changedPaths = files.env.changed
      .filter((changed) => changed.repo === file.repo)
      .map((changed) => changed.path);
    const name = file.path.split("/").pop();
    return [
      {
        path: [...path, "path"],
        message: `"${file.path}" is not in the changes and not on disk in ${file.repo}. For removed code, set side to base.`,
        suggestion:
          changedPaths.find((candidate) => candidate.split("/").pop() === name) ??
          closest(file.path, changedPaths),
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

function selfEdges(index: VizIndex): Found[] {
  return index.edges.flatMap((edge, at) =>
    edge.from === edge.to
      ? [
          {
            path: ["edges", at],
            message: `edge "${edge.id}" points at its own node. Show a self call as a flow step instead, unless the type refers to itself.`,
          },
        ]
      : [],
  );
}

function missingRoles(index: VizIndex): Found[] {
  return index.nodes.flatMap((node, at) =>
    node.delta !== "unchanged" && !node.role
      ? [
          {
            path: ["nodes", at, "role"],
            message: `node "${node.id}" is ${node.delta}, but has no role: one sentence on its part in this change.`,
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
            message: `node "${node.id}" is ${node.delta}, but has no files: where it lives in the diff, with lines.`,
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
      message: `${plural(missing.length, "changed file")} on no node, member, edge or step: ${listed}${more}`,
    },
  ];
}

function deltaMismatches(index: VizIndex, files: Files): Found[] {
  return index.nodes.flatMap((node, at): Found[] => {
    const resolved = (node.files ?? []).flatMap((ref) => resolvedFile(files.env, ref) ?? []);
    const statuses = resolved.flatMap(
      (file) => files.changed.get(changedKey(file.repo, file.path)) ?? [],
    );
    const path = ["nodes", at, "delta"];
    const all = (status: VizFileStatus) =>
      statuses.length > 0 && statuses.every((file) => file.status === status);
    if (node.delta !== "unchanged" && resolved.length > 0 && statuses.length === 0) {
      return [
        { path, message: `node "${node.id}" is ${node.delta}, but none of its files changed.` },
      ];
    }
    if (node.delta === "added" && all("D")) {
      return [{ path, message: `node "${node.id}" is added, but all of its files are deleted.` }];
    }
    if (node.delta === "removed" && all("A")) {
      return [{ path, message: `node "${node.id}" is removed, but all of its files are new.` }];
    }
    const whole = statuses.find((file) => file.status === "A" || file.status === "D");
    if (node.delta === "unchanged" && whole) {
      const verb = whole.status === "A" ? "added" : "deleted";
      return [
        { path, message: `node "${node.id}" is unchanged, but its file ${whole.path} is ${verb}.` },
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
    linked.has(node.id) || index.childrenByParent.has(node.id)
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
