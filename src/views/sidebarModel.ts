import * as path from "node:path";

import type { AgentState, FileGroup } from "../types.js";
import type { GateKind } from "../gate/GateCoordinator.js";
import type { PlanCommentData } from "../plan/planFeedback.js";
import { repoKey } from "../protocol/paths.js";
import { describeCompareTo } from "../protocol/guidedReview.js";
import type {
  RepoChangedFile,
  RepositoryReviewState,
  ReviewState,
} from "../review/ReviewController.js";
import type { GuidedChangesetState, GuidedFileRow } from "../review/guidedPlan.js";
import type { ReviewComment } from "../review/reviewTypes.js";
import type { SetupPrompt } from "../welcome/installStatus.js";
import { buildFileTree, type TreeEntry } from "./fileTree.js";
import type {
  SidebarAction,
  SidebarActionTarget,
  SidebarIcon,
  SidebarIconName,
  SidebarNode,
  SidebarOperation,
  SidebarState,
} from "./sidebarProtocol.js";

export interface SidebarAgentSnapshot {
  sessionId: string;
  displayName: string;
  repoRoot: string;
  state: AgentState;
  startedAt: number;
  lastEventAt: number;
  lastTool?: string;
  needsAttention: boolean;
  muted: boolean;
  gate?: { kind: GateKind; foreground: boolean };
}

export interface SidebarSnapshot {
  setupPrompt?: SetupPrompt;
  agents: SidebarAgentSnapshot[];
  review: ReviewState;
  planPending: boolean;
  planComments: PlanCommentData[];
  reviewSessionActive: boolean;
  reviewComments: ReviewComment[];
  activeDiff?: { repoRoot: string; group: FileGroup; path: string };
}

const GROUP_LABELS: Record<FileGroup, string> = {
  staged: "Staged",
  unstaged: "Working Tree",
  committed: "Committed",
};

const STATE_LABEL: Record<AgentState, string> = {
  idle: "idle",
  thinking: "thinking",
  toolRunning: "running tool",
  awaitingPlanApproval: "awaiting plan review",
  awaitingPermission: "awaiting permission",
  awaitingInput: "awaiting your input",
  stopped: "stopped",
  ended: "ended",
};

const STATE_ICON: Record<AgentState, SidebarIconName> = {
  idle: "circle",
  thinking: "circle",
  toolRunning: "tools",
  awaitingPlanApproval: "edit",
  awaitingPermission: "warning",
  awaitingInput: "question",
  stopped: "circle",
  ended: "missing",
};

const GATE_ROLE: Record<GateKind, string> = {
  plan: "plan review",
  review: "code review",
  guided: "guided review",
};

const KIND_ICON: Record<ReviewComment["kind"], SidebarIconName> = {
  comment: "edit",
  question: "question",
  problem: "warning",
};

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function agentLabel(displayName: string, sessionId: string): string {
  return `${displayName} (${shortSessionId(sessionId)})`;
}

export function changedFileCount(staged: { length: number }, unstaged: { length: number }): number {
  return staged.length + unstaged.length;
}

export function computeViewBadge(
  changedFiles: number,
): { value: number; tooltip: string } | undefined {
  if (changedFiles < 1) {
    return undefined;
  }
  return {
    value: changedFiles,
    tooltip: `${changedFiles} changed file${changedFiles === 1 ? "" : "s"}`,
  };
}

export function repositoryBranchLabel(branch: string | undefined): string {
  return branch ?? "(detached)";
}

export function fileNodeId(file: RepoChangedFile, scope = "changes"): string {
  return `file:${scope}:${repoKey(file.repoRoot)}:${file.group}:${file.path}`;
}

export function buildSidebarState(snapshot: SidebarSnapshot): SidebarState {
  const nodes: SidebarNode[] = [];
  if (snapshot.setupPrompt) {
    nodes.push(setupNotice(snapshot.setupPrompt));
  }
  nodes.push(agentSection(snapshot.agents));
  if (snapshot.review.guided) {
    nodes.push(guidedSection(snapshot.review));
  } else {
    nodes.push(filesSection(snapshot.review));
  }
  if (snapshot.planPending) {
    nodes.push(planSection(snapshot.planComments));
  }
  if (snapshot.reviewSessionActive || snapshot.reviewComments.length) {
    nodes.push(feedbackSection(snapshot.reviewComments));
  }

  const badge = snapshot.review.repositories.reduce(
    (total, repository) =>
      total + changedFileCount(repository.changes.staged, repository.changes.unstaged),
    0,
  );
  return {
    nodes,
    badge,
    selectedNodeId:
      snapshot.activeDiff && !snapshot.review.guided
        ? fileNodeId({ ...snapshot.activeDiff } as RepoChangedFile)
        : undefined,
  };
}

function action(
  operation: SidebarOperation,
  label: string,
  icon: SidebarIconName,
  target?: SidebarActionTarget,
): SidebarAction {
  return { operation, label, icon, target };
}

function icon(
  name: SidebarIconName,
  tone?: Extract<SidebarIcon, { kind: "icon" }>["tone"],
): SidebarIcon {
  return { kind: "icon", name, tone };
}

function sectionNode(
  id: string,
  label: string,
  children: SidebarNode[],
  options: Partial<SidebarNode> = {},
): SidebarNode {
  return {
    id: `section:${id}`,
    kind: "section",
    label,
    children,
    ...options,
  };
}

function setupNotice(prompt: SetupPrompt): SidebarNode {
  const update = prompt.kind === "update";
  return {
    id: "notice:agentSetup",
    kind: "notice",
    label: update ? "Update agent plugins" : "Set up an agent",
    description: update ? prompt.agentNames.join(", ") : undefined,
    tooltip: update
      ? `These agents have an old Paireto plugin: ${prompt.agentNames.join(", ")}\nOpen Welcome to update them.`
      : "No agent has the Paireto plugin yet.\nOpen Welcome to set one up.",
    icon: icon(update ? "warning" : "rocket", update ? "orange" : undefined),
    primaryAction: action("openWelcome", "Open Welcome", "open"),
  };
}

function agentSection(agents: SidebarAgentSnapshot[]): SidebarNode {
  const sorted = agents.slice().sort((a, b) => b.lastEventAt - a.lastEventAt);
  return sectionNode(
    "agents",
    "Agents",
    sorted.length ? sorted.map(agentNode) : [placeholder("agents", "No agents connected")],
    { description: sorted.length ? String(sorted.length) : undefined },
  );
}

function agentNode(agent: SidebarAgentSnapshot): SidebarNode {
  const target = { kind: "agent", sessionId: agent.sessionId } as const;
  const started = new Date(agent.startedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const toolLine = agent.lastTool ? `\nLast tool: ${agent.lastTool}` : "";
  const context = `${agent.repoRoot}\nSession ${agent.sessionId}\nStarted ${started}${toolLine}`;
  let description = STATE_LABEL[agent.state];
  let rowIcon = icon(STATE_ICON[agent.state]);
  let tooltip = `${context}\n${description}`;
  if (agent.gate) {
    const role = GATE_ROLE[agent.gate.kind];
    const slot = agent.gate.foreground ? "active" : "pending";
    description = `awaiting ${role} · ${slot}`;
    rowIcon = icon("circle", agent.gate.foreground ? "blue" : "default");
    tooltip = `${context}\nAwaiting ${role} (${slot})`;
  }
  if (agent.muted) {
    description = "";
    rowIcon = icon("eyeClosed", "muted");
    tooltip = `${context}\nHidden — pings muted`;
  } else if (agent.needsAttention && !agent.gate?.foreground) {
    description = `${description} · needs you`;
    rowIcon = icon("bell", "orange");
  }
  return {
    id: `agent:${agent.sessionId}`,
    kind: "agent",
    label: agentLabel(agent.displayName, agent.sessionId),
    description: description || undefined,
    tooltip,
    icon: rowIcon,
    muted: agent.muted,
    attention: agent.needsAttention && !agent.muted,
    primaryAction: action("switchAgent", "Switch to Agent", "open", target),
    inlineActions: [
      action("focusAgent", "Focus Agent", "terminal"),
      action(
        agent.muted ? "showAgent" : "hideAgent",
        agent.muted ? "Show Agent" : "Hide Agent",
        agent.muted ? "eyeClosed" : "eye",
        target,
      ),
    ],
  };
}

function filesSection(review: ReviewState): SidebarNode {
  const repositories = review.repositories;
  const children =
    repositories.length > 1
      ? repositories.map((repository) => repositoryNode(repository, review.layout, true))
      : repositories[0]
        ? repositoryChildren(repositories[0], review.layout)
        : [placeholder("files", "No changes")];
  return sectionNode("files", "Changed Files", children, {
    description: changesDescription(review),
    inlineActions: [
      action("pickCompareTo", "Compare To…", "compare"),
      action("toggleLayout", "Toggle Flat / Tree View", "layout"),
    ],
  });
}

function repositoryNode(
  repository: RepositoryReviewState,
  layout: ReviewState["layout"],
  showHeader: boolean,
): SidebarNode {
  return {
    id: `repository:${repoKey(repository.repoRoot)}`,
    kind: "repository",
    label: repository.displayName,
    description: repositoryBranchLabel(repository.branch),
    tooltip: repository.repoRoot,
    icon: icon("folder"),
    children: showHeader ? repositoryChildren(repository, layout) : undefined,
  };
}

function repositoryChildren(
  repository: RepositoryReviewState,
  layout: ReviewState["layout"],
): SidebarNode[] {
  const nodes: SidebarNode[] = [];
  for (const group of ["committed", "staged", "unstaged"] as const) {
    const files = repository.changes[group];
    if (files.length) {
      nodes.push(groupNode(repository.repoRoot, group, files, layout));
    }
  }
  return nodes.length ? nodes : [placeholder(repoKey(repository.repoRoot), "No changes")];
}

function groupNode(
  repoRoot: string,
  group: FileGroup,
  files: RepoChangedFile[],
  layout: ReviewState["layout"],
): SidebarNode {
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const target = { kind: "files", repoRoot, group } as const;
  const actions =
    group === "unstaged"
      ? [
          action("discardFiles", "Discard All Changes", "discard", target),
          action("stageFiles", "Stage All Changes", "add", target),
        ]
      : group === "staged"
        ? [action("unstageFiles", "Unstage All Changes", "remove", target)]
        : [];
  return {
    id: `group:${repoKey(repoRoot)}:${group}`,
    kind: "group",
    label: GROUP_LABELS[group],
    description: `${files.length} ${files.length === 1 ? "file" : "files"} · +${additions} -${deletions}`,
    icon: icon(group === "committed" ? "commit" : "file", "blue"),
    children:
      layout === "flat"
        ? files.map((file) => fileNode(file))
        : buildFileTree(files).map((entry) => treeEntryNode(entry, repoRoot, group)),
    inlineActions: actions,
    menuActions: actions,
  };
}

function treeEntryNode(entry: TreeEntry, repoRoot: string, group: FileGroup): SidebarNode {
  if (entry.type === "file") {
    return fileNode(entry.file as RepoChangedFile);
  }
  const target = { kind: "files", repoRoot, group, pathPrefix: entry.path } as const;
  const actions =
    group === "unstaged"
      ? [
          action("discardFiles", "Discard Changes", "discard", target),
          action("stageFiles", "Stage Changes", "add", target),
        ]
      : group === "staged"
        ? [action("unstageFiles", "Unstage Changes", "remove", target)]
        : [];
  return {
    id: `folder:${repoKey(repoRoot)}:${group}:${entry.path}`,
    kind: "folder",
    label: entry.name,
    tooltip: entry.path,
    icon: icon("folder"),
    children: entry.children.map((child) => treeEntryNode(child, repoRoot, group)),
    inlineActions: actions,
    menuActions: actions,
  };
}

function fileNode(file: RepoChangedFile, scope = "changes", planned?: GuidedFileRow): SidebarNode {
  const target = { kind: "file", file } as const;
  const fileActions = [action("openFile", "Open File", "open", target)];
  const gitActions =
    file.group === "unstaged"
      ? [
          action("discardFiles", "Discard Changes", "discard", target),
          action("stageFiles", "Stage Changes", "add", target),
        ]
      : file.group === "staged"
        ? [action("unstageFiles", "Unstage Changes", "remove", target)]
        : [];
  const directory = path.dirname(file.path);
  const counts = `+${file.additions} -${file.deletions}`;
  const plannedTarget = planned
    ? ({ kind: "plannedFile", changesetId: planned.changesetId, path: planned.path } as const)
    : undefined;
  return {
    id: fileNodeId(file, scope),
    kind: "file",
    label: path.basename(file.path),
    description: directory === "." ? counts : `${directory}  ${counts}`,
    tooltip: `${file.path}\n${statusWord(file.status)} · ${counts}${planned ? `\n${GROUP_LABELS[file.group]}` : ""}`,
    icon:
      planned && file.group === "committed"
        ? icon("commit", "blue")
        : { kind: "status", status: file.status, muted: !!planned && file.group === "staged" },
    primaryAction: planned
      ? action("openPlannedFile", "Open Diff", "open", plannedTarget)
      : action("openDiff", "Open Diff", "open", target),
    inlineActions: [...fileActions, ...gitActions],
    menuActions: [
      ...fileActions,
      action("openDiff", "Open Changes", "edit", target),
      ...gitActions,
    ],
  };
}

function guidedSection(review: ReviewState): SidebarNode {
  const guided = review.guided!;
  return sectionNode(
    "changesets",
    "Review Plan",
    guided.changesets.map((changeset) => changesetNode(guided.repoRoot, changeset)),
    {
      description: guidedDescription(guided),
      tooltip: [guided.summary, `Compared against ${describeCompareTo(guided.compareTo)}`]
        .filter(Boolean)
        .join("\n\n"),
      primaryAction: action("openReviewPlan", "Open Review Plan", "open"),
    },
  );
}

function changesetNode(repoRoot: string, changeset: GuidedChangesetState): SidebarNode {
  const target = { kind: "changeset", changesetId: changeset.id } as const;
  const actions: SidebarAction[] = [];
  if (changeset.unstageableCount) {
    actions.push(action("unstageChangeset", "Unstage All Changes", "remove", target));
  }
  if (changeset.stageableCount) {
    actions.push(action("stageChangeset", "Stage All Changes", "add", target));
  }
  return {
    id: `changeset:${repoKey(repoRoot)}:${changeset.id}`,
    kind: "changeset",
    label: changeset.title,
    description: `${changeset.files.length} ${changeset.files.length === 1 ? "file" : "files"}`,
    tooltip: `${changeset.title}\n\n${changeset.description || "No description."}`,
    icon: icon("layers"),
    children: changeset.files.map((row) => changesetFileNode(repoRoot, row)),
    primaryAction: action("openChangeset", "Open Changeset", "open", target),
    inlineActions: actions,
    menuActions: actions,
  };
}

function changesetFileNode(repoRoot: string, row: GuidedFileRow): SidebarNode {
  if (row.file) {
    return fileNode(row.file, row.changesetId, row);
  }
  return {
    id: `changesetFile:${repoKey(repoRoot)}:${row.changesetId}:${row.path}`,
    kind: "file",
    label: path.basename(row.path),
    description: "no longer in the changes",
    tooltip: `${row.path}\nNot in the current comparison`,
    icon: icon("missing", "muted"),
  };
}

function planSection(comments: PlanCommentData[]): SidebarNode {
  return sectionNode(
    "plan",
    "Plan Review",
    comments.length
      ? comments.map((comment, index) => ({
          id: `planComment:${comment.line}:${index}`,
          kind: "comment" as const,
          label: `Line ${comment.line + 1}`,
          description: comment.body,
          tooltip: `${kindLabel(comment.kind)} · line ${comment.line + 1}\n\n${comment.quote}\n\n${comment.body}`,
          icon: icon(KIND_ICON[comment.kind]),
        }))
      : [placeholder("plan", "No comments — Approve, or add feedback on the plan")],
  );
}

function feedbackSection(comments: ReviewComment[]): SidebarNode {
  return sectionNode(
    "feedback",
    "Feedback",
    comments.length
      ? comments.map(reviewCommentNode)
      : [placeholder("feedback", "No comments yet — add them on the diff")],
    { description: comments.length ? String(comments.length) : undefined },
  );
}

function reviewCommentNode(comment: ReviewComment): SidebarNode {
  const target = { kind: "comment", id: comment.id } as const;
  const label = comment.changeset
    ? comment.changeset.title
    : `${path.basename(comment.filePath)}:${comment.line + 1}`;
  const where = comment.changeset
    ? `Changeset: ${comment.changeset.title}`
    : `${path.join(comment.repoRoot, comment.filePath)}:${comment.line + 1}`;
  return {
    id: `reviewComment:${comment.id}`,
    kind: "comment",
    label,
    description: `${commentScope(comment)} · ${comment.body}`,
    tooltip: `${kindLabel(comment.kind)} · ${where}\n\n${comment.quote}\n\n${comment.body}`,
    icon: icon(KIND_ICON[comment.kind]),
    primaryAction: action("revealComment", "Reveal Comment", "open", target),
    inlineActions: [action("deleteComment", "Delete Comment", "trash", target)],
    menuActions: [action("deleteComment", "Delete Comment", "trash", target)],
  };
}

function placeholder(scope: string, label: string): SidebarNode {
  return { id: `placeholder:${scope}:${label}`, kind: "placeholder", label };
}

function changesDescription(review: ReviewState): string | undefined {
  if (review.repositories.length === 1) {
    return review.repositories[0].changes.compareLabel;
  }
  if (review.repositories.length < 2) {
    return undefined;
  }
  switch (review.compareTo.kind) {
    case "head":
      return "HEAD";
    case "mergeBase":
      return "Merge Base";
    case "stackBase":
      return "Stack Base";
    case "default":
      return "Default Branch";
    case "ref":
      return review.compareTo.ref;
  }
}

function guidedDescription(guided: NonNullable<ReviewState["guided"]>): string {
  const changesets = plural(guided.changesets.length, "changeset");
  const summary = `${changesets} · ${plural(guided.fileTotal, "file")}`;
  return guided.missingTotal
    ? `${summary} · ${guided.missingTotal} not in the current comparison`
    : summary;
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function statusWord(status: RepoChangedFile["status"]): string {
  return { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked" }[
    status
  ];
}

function kindLabel(kind: ReviewComment["kind"]): string {
  return { comment: "Comment", question: "Question", problem: "Problem" }[kind];
}

function commentScope(comment: ReviewComment): string {
  if (comment.changeset) {
    return "Changeset";
  }
  const directory = path.dirname(comment.filePath);
  const repository = path.basename(comment.repoRoot);
  return directory === "." ? repository : `${repository}/${directory}`;
}
