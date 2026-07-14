// The single Paireto sidebar view. Top-level rows are collapsible section headers — Agents,
// Plan Review, Changed Files, Feedback. The Changed Files section nests group headers (Staged /
// Unstaged / Committed), each laid out flat or as a compressed folder tree. Section/group/file
// actions are inline buttons (see package.json view/item/context, keyed on contextValue).

import * as path from "node:path";

import * as vscode from "vscode";

import type { AgentSessionService } from "../agents/AgentSessionService.js";
import { kindColorId, kindIcon, kindLabel } from "../comments/kinds.js";
import { Commands, Views } from "../config.js";
import type { GateCoordinator } from "../gate/GateCoordinator.js";
import type { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import type { ChangedFile, FileStatus } from "../git/DiffService.js";
import type {
  RepoChangedFile,
  RepositoryChangesModel,
  RepositoryReviewState,
  ReviewState,
} from "../review/ReviewController.js";
import type { PlanReviewController } from "../plan/PlanReviewController.js";
import type { PlanCommentData } from "../plan/planFeedback.js";
import type { ReviewController } from "../review/ReviewController.js";
import type { ReviewComment } from "../review/reviewTypes.js";
import type { AgentSession } from "../agents/AgentSession.js";
import type { AgentState, FileGroup } from "../types.js";
import { repoKey } from "../protocol/paths.js";
import { buildFileTree, type TreeEntry } from "./fileTree.js";

// Status indicator: a coloured letter (A/M/D/R/C/U) in git's status colours, rendered as a
// per-status SVG so the colour stays on the indicator only (a FileDecoration would tint the whole
// filename label). Tree-item iconPath SVGs are shown as-is (not theme-tinted), so we ship light/dark
// variants. Maps each status to the basename under media/status/ (e.g. "m" -> m-{light,dark}.svg).
const STATUS_ICON_FILE: Record<FileStatus, string> = {
  A: "a",
  M: "m",
  D: "d",
  R: "r",
  C: "c",
  U: "u",
};

function statusIcon(
  extensionUri: vscode.Uri,
  status: FileStatus,
): { light: vscode.Uri; dark: vscode.Uri } {
  const name = STATUS_ICON_FILE[status] ?? "m";
  return {
    light: vscode.Uri.joinPath(extensionUri, "media", "status", `${name}-light.svg`),
    dark: vscode.Uri.joinPath(extensionUri, "media", "status", `${name}-dark.svg`),
  };
}

type SectionId = "agents" | "plan" | "files" | "feedback";

type Node =
  | { kind: "section"; id: SectionId; label: string; description?: string }
  | { kind: "repository"; repository: RepositoryReviewState }
  | {
      kind: "group";
      repoRoot: string;
      group: FileGroup;
      label: string;
      count: number;
      additions: number;
      deletions: number;
    }
  | {
      kind: "folder";
      repoRoot: string;
      group: FileGroup;
      entry: Extract<TreeEntry, { type: "folder" }>;
    }
  | { kind: "file"; file: RepoChangedFile }
  | { kind: "agent"; session: AgentSession }
  | { kind: "reviewComment"; comment: ReviewComment }
  | { kind: "planComment"; comment: PlanCommentData }
  | { kind: "placeholder"; label: string };

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

const STATE_ICON: Record<AgentState, string> = {
  idle: "circle-outline",
  thinking: "loading~spin",
  toolRunning: "tools",
  awaitingPlanApproval: "comment-discussion",
  awaitingPermission: "warning",
  awaitingInput: "question",
  stopped: "primitive-square",
  ended: "circle-slash",
};

function statusWord(s: ChangedFile["status"]): string {
  return { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked" }[s];
}

/**
 * A short, stable, per-agent label derived from the real Claude session id. The repo basename was
 * identical for every agent in a repo; the first 8 chars of the session UUID disambiguate them.
 */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** The Agents-row label: the harness display name + short session id, e.g. `Claude (a1b2c3d4)`. The
 *  display name comes from the session's harness strategy (via the locator), never a hardcoded name. */
export function agentLabel(displayName: string, sessionId: string): string {
  return `${displayName} (${shortSessionId(sessionId)})`;
}

/** What an agent command receives: the row's own `item.command` passes the raw session, but VS Code
 *  hands inline `view/item/context` buttons the tree Node — accept both. */
export type AgentCommandArg = AgentSession | { kind: "agent"; session: AgentSession };

export function commandSession(arg: AgentCommandArg): AgentSession {
  return "session" in arg ? arg.session : arg;
}

/**
 * The badge's changed-file count. A partially-staged file appears in BOTH staged and unstaged, and
 * the native Git panel counts it once per section — so we sum the section lengths rather than dedup
 * by path, matching that behaviour.
 */
export function changedFileCount(staged: { length: number }, unstaged: { length: number }): number {
  return staged.length + unstaged.length;
}

/**
 * The activity-bar view badge ("ticker") — the changed-file count, like the Git tab. VS Code's
 * ViewBadge is numeric only (no colour/icon API), so this is purely the count; agent "needs you" cues
 * live on the surfaces that can actually carry colour (status bar, agent rows, switcher). Returns
 * undefined to clear the badge when there's nothing to count.
 */
export function computeViewBadge(changedFiles: number): vscode.ViewBadge | undefined {
  if (changedFiles > 0) {
    const s = changedFiles === 1 ? "" : "s";
    return { value: changedFiles, tooltip: `${changedFiles} changed file${s}` };
  }
  return undefined;
}

/** Repository-row secondary label: the checked-out branch, with an explicit detached fallback. */
export function repositoryBranchLabel(branch: string | undefined): string {
  return branch ?? "(detached)";
}

export class MainTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private view?: vscode.TreeView<Node>;
  /** A diff whose row isn't in the tree yet (e.g. the unstaged row before save) — select on arrival. */
  private pendingReveal?: { repoRoot: string; group: FileGroup; path: string };

  constructor(
    private readonly agents: AgentSessionService,
    private readonly review: ReviewController,
    private readonly plan: PlanReviewController,
    private readonly coordinator: GateCoordinator,
    private readonly locator: AgentServiceLocator,
    private readonly extensionUri: vscode.Uri,
  ) {
    const fire = (): void => {
      this.emitter.fire();
      this.updateBadge();
    };
    this.subs.push(
      this.agents.onDidChange(fire),
      this.review.onDidChangeState(() => {
        this.emitter.fire();
        this.updateBadge();
        this.maybeRevealPending();
      }),
      this.plan.onDidChange(fire),
      this.review.onDidChangeActiveDiff((t) => this.syncSelection(t)),
      // Re-render when gate foreground/queue changes (agent rows show active/pending ownership).
      this.coordinator.onDidChange(fire),
      vscode.commands.registerCommand(Commands.agentSwitch, (arg: AgentCommandArg) =>
        this.switchToAgent(commandSession(arg)),
      ),
      vscode.commands.registerCommand(Commands.agentHide, (arg: AgentCommandArg) =>
        this.agents.setMuted(commandSession(arg).sessionId, true),
      ),
      vscode.commands.registerCommand(Commands.agentShow, (arg: AgentCommandArg) =>
        this.agents.setMuted(commandSession(arg).sessionId, false),
      ),
    );
  }

  /** Click an agent: switch the foreground gate to that agent's pending plan/review, else focus terminal. */
  private switchToAgent(session: AgentSession): void {
    // The user looked at this agent — drop its attention marker.
    this.agents.clearAttention(session.sessionId);
    const entry = this.coordinator.entryForSession(session.sessionId);
    if (entry) {
      void this.coordinator.switchTo(entry.id);
    } else {
      void vscode.commands.executeCommand("workbench.action.terminal.focus");
    }
  }

  /** Create the sidebar tree view (kept here so `reveal` can select the row of the focused diff). */
  register(): vscode.TreeView<Node> {
    this.view = vscode.window.createTreeView(Views.main, { treeDataProvider: this });
    this.subs.push(this.view);
    this.updateBadge();
    return this.view;
  }

  /** Refresh the activity-bar badge: the changed-file count, like the Git tab. */
  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    const changed = this.review
      .getState()
      .repositories.reduce(
        (total, repo) => total + changedFileCount(repo.changes.staged, repo.changes.unstaged),
        0,
      );
    this.view.badge = computeViewBadge(changed);
  }

  // ── Selection sync: keep the highlighted row pointed at the diff the editor is showing ──
  private syncSelection(target: { repoRoot: string; group: FileGroup; path: string }): void {
    if (this.rowFor(target)) {
      void this.revealRow(target);
      this.pendingReveal = undefined;
    } else {
      this.pendingReveal = target; // row not in the tree yet (e.g. unstaged before save)
    }
  }

  private maybeRevealPending(): void {
    if (this.pendingReveal && this.rowFor(this.pendingReveal)) {
      void this.revealRow(this.pendingReveal);
      this.pendingReveal = undefined;
    }
  }

  private rowFor(t: {
    repoRoot: string;
    group: FileGroup;
    path: string;
  }): RepoChangedFile | undefined {
    return this.review
      .getState()
      .repositories.find((repo) => repo.repoRoot === t.repoRoot)
      ?.changes[t.group].find((file) => file.path === t.path);
  }

  private async revealRow(t: { repoRoot: string; group: FileGroup; path: string }): Promise<void> {
    const file = this.rowFor(t);
    if (!file || !this.view) {
      return;
    }
    try {
      // select highlights the row; focus stays in the editor the user is working in.
      await this.view.reveal({ kind: "file", file }, { select: true, focus: false });
    } catch {
      /* tree not ready / row collapsed away — non-fatal */
    }
  }

  getParent(node: Node): Node | undefined {
    switch (node.kind) {
      case "repository":
        return { kind: "section", id: "files", label: "Changed Files" };
      case "group":
        if (this.review.getState().repositories.length > 1) {
          const repository = this.repository(node.repoRoot);
          return repository
            ? { kind: "repository", repository }
            : { kind: "section", id: "files", label: "Changed Files" };
        }
        return { kind: "section", id: "files", label: "Changed Files" };
      case "folder":
        return this.entryParent(
          node.repoRoot,
          node.group,
          (e) => e.type === "folder" && e.path === node.entry.path,
        );
      case "file":
        return this.entryParent(
          node.file.repoRoot,
          node.file.group,
          (e) => e.type === "file" && e.file.path === node.file.path,
        );
      case "agent":
        return { kind: "section", id: "agents", label: "Agents" };
      case "reviewComment":
        return { kind: "section", id: "feedback", label: "Feedback" };
      case "planComment":
        return { kind: "section", id: "plan", label: "Plan Review" };
      default:
        return undefined; // sections + placeholders are top-level
    }
  }

  /** Parent node of a file/folder entry: its containing folder (tree layout) or the group header. */
  private entryParent(
    repoRoot: string,
    group: FileGroup,
    matches: (e: TreeEntry) => boolean,
  ): Node {
    const { layout } = this.review.getState();
    const changes = this.repository(repoRoot)?.changes ?? emptyChanges();
    const groupHeader = groupNode(repoRoot, group, GROUP_LABELS[group], changes[group]);
    if (layout === "flat") {
      return groupHeader;
    }
    const parent = findEntryParent(buildFileTree(changes[group]), matches);
    return parent ? { kind: "folder", repoRoot, group, entry: parent } : groupHeader;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "section": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.id}`;
        item.contextValue = `section:${node.id}`;
        item.description = node.description;
        return item;
      }
      case "repository": {
        const item = new vscode.TreeItem(
          node.repository.displayName,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `repository:${repoKey(node.repository.repoRoot)}`;
        item.contextValue = "repository";
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = repositoryBranchLabel(node.repository.branch);
        item.tooltip = node.repository.repoRoot;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${repoKey(node.repoRoot)}:${node.group}`;
        item.contextValue = `group:${node.group}`;
        // No resourceUri here: it would force a (blank) icon slot, gapping the label off the chevron.
        // An explicit coloured icon fills that slot deliberately (see GROUP_ICON).
        const gi = GROUP_ICON[node.group];
        item.iconPath = new vscode.ThemeIcon(gi.icon, new vscode.ThemeColor(gi.color));
        const fileWord = node.count === 1 ? "file" : "files";
        item.description = `${node.count} ${fileWord} · +${node.additions} -${node.deletions}`;
        return item;
      }
      case "folder": {
        const item = new vscode.TreeItem(node.entry.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `folder:${repoKey(node.repoRoot)}:${node.group}:${node.entry.path}`;
        item.resourceUri = vscode.Uri.file(path.join(node.repoRoot, node.entry.path));
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = `folder:${node.group}`;
        return item;
      }
      case "file":
        return fileItem(node.file, this.extensionUri);
      case "agent": {
        const entry = this.coordinator.entryForSession(node.session.sessionId);
        const gate = entry
          ? { kind: entry.kind, foreground: this.coordinator.isForeground(entry.id) }
          : undefined;
        return agentItem(
          node.session,
          this.locator.strategyFor(node.session.harness).displayName,
          gate,
        );
      }
      case "reviewComment":
        return reviewCommentItem(node.comment);
      case "planComment":
        return planCommentItem(node.comment);
      case "placeholder": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "placeholder";
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.sections();
    }
    switch (node.kind) {
      case "section":
        return this.sectionChildren(node.id);
      case "repository":
        return this.repositoryChildren(node.repository);
      case "group":
        return this.groupChildren(node.repoRoot, node.group);
      case "folder":
        return node.entry.children.map((e) => entryToNode(e, node.repoRoot, node.group));
      default:
        return [];
    }
  }

  /** Every session delivered to this window, independent of editor/repository focus. */
  private scopedAgents(): AgentSession[] {
    return this.agents
      .allSessions()
      .filter((s) => s.state !== "ended")
      .sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  private sections(): Node[] {
    const out: Node[] = [];
    const agentCount = this.scopedAgents().length;
    out.push({ kind: "section", id: "agents", label: "Agents", description: count(agentCount) });

    out.push({
      kind: "section",
      id: "files",
      label: "Changed Files",
      description: changesDescription(this.review.getState()),
    });

    if (this.plan.hasPendingPlan()) {
      out.push({ kind: "section", id: "plan", label: "Plan Review" });
    }
    // The Feedback section appears once the user has left comments (the unclaimed bucket) or a review
    // is in progress — so commenting before any review still surfaces the comments.
    if (this.review.isSessionActive() || this.review.hasComments()) {
      out.push({
        kind: "section",
        id: "feedback",
        label: "Feedback",
        description: count(this.review.getComments().length),
      });
    }
    return out;
  }

  private sectionChildren(id: SectionId): Node[] {
    switch (id) {
      case "agents": {
        const sessions = this.scopedAgents();
        return sessions.length
          ? sessions.map((session) => ({ kind: "agent", session }) as Node)
          : [placeholder("No agents connected")];
      }
      case "files": {
        const repositories = this.review.getState().repositories;
        if (repositories.length > 1) {
          return repositories.map((repository) => ({ kind: "repository", repository }));
        }
        return repositories[0]
          ? this.repositoryChildren(repositories[0])
          : [placeholder("No changes")];
      }
      case "plan": {
        const comments = this.plan.getComments();
        return comments.length
          ? comments.map((comment) => ({ kind: "planComment", comment }) as Node)
          : [placeholder("No comments — Approve, or add feedback on the plan")];
      }
      case "feedback": {
        const comments = this.review.getComments();
        return comments.length
          ? comments.map((comment) => ({ kind: "reviewComment", comment }) as Node)
          : [placeholder("No comments yet — add them on the diff")];
      }
    }
  }

  private repositoryChildren(repository: RepositoryReviewState): Node[] {
    const { changes, repoRoot } = repository;
    const groups: Node[] = [];
    if (changes.committed.length) {
      groups.push(groupNode(repoRoot, "committed", GROUP_LABELS.committed, changes.committed));
    }
    if (changes.staged.length) {
      groups.push(groupNode(repoRoot, "staged", GROUP_LABELS.staged, changes.staged));
    }
    if (changes.unstaged.length) {
      groups.push(groupNode(repoRoot, "unstaged", GROUP_LABELS.unstaged, changes.unstaged));
    }
    return groups.length ? groups : [placeholder("No changes")];
  }

  private groupChildren(repoRoot: string, group: FileGroup): Node[] {
    const { layout } = this.review.getState();
    const changes = this.repository(repoRoot)?.changes ?? emptyChanges();
    const files = changes[group];
    if (layout === "flat") {
      return files.map((file) => ({ kind: "file", file }) as Node);
    }
    return buildFileTree(files).map((e) => entryToNode(e, repoRoot, group));
  }

  private repository(repoRoot: string): RepositoryReviewState | undefined {
    return this.review.getState().repositories.find((repo) => repo.repoRoot === repoRoot);
  }

  dispose(): void {
    for (const d of this.subs) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

const GROUP_LABELS: Record<FileGroup, string> = {
  staged: "Staged",
  unstaged: "Working Tree",
  committed: "Committed",
};

// A coloured left icon per section so the three git layers are scannable at a glance (TreeView has
// no right-aligned count badge like the SCM viewlet, so we lean on icon + colour + the count below).
const GROUP_ICON: Record<FileGroup, { icon: string; color: string }> = {
  committed: { icon: "git-commit", color: "charts.blue" },
  staged: { icon: "diff-added", color: "charts.blue" },
  unstaged: { icon: "diff-modified", color: "charts.blue" },
};

/**
 * The folder entry directly containing the entry matched by `matches`, or undefined when the match
 * is at the tree root (parent is the group header) or absent. The ambiguity is intentional — callers
 * fall back to the group header in both cases.
 */
function findEntryParent(
  entries: TreeEntry[],
  matches: (e: TreeEntry) => boolean,
  parent?: Extract<TreeEntry, { type: "folder" }>,
): Extract<TreeEntry, { type: "folder" }> | undefined {
  for (const e of entries) {
    if (matches(e)) {
      return parent;
    }
    if (e.type === "folder") {
      const found = findEntryParent(e.children, matches, e);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function groupNode(repoRoot: string, group: FileGroup, label: string, files: ChangedFile[]): Node {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { kind: "group", repoRoot, group, label, count: files.length, additions, deletions };
}

function emptyChanges(): RepositoryChangesModel {
  return {
    staged: [],
    unstaged: [],
    committed: [],
    compareLabel: "HEAD",
    compareRef: null,
  };
}

function changesDescription(state: ReviewState): string | undefined {
  if (state.repositories.length === 1) {
    return state.repositories[0].changes.compareLabel;
  }
  if (state.repositories.length > 1) {
    switch (state.compareTo.kind) {
      case "head":
        return "HEAD";
      case "mergeBase":
        return "Merge Base";
      case "default":
        return "Default Branch";
      case "ref":
        return state.compareTo.ref;
    }
  }
  return undefined;
}

function entryToNode(entry: TreeEntry, repoRoot: string, group: FileGroup): Node {
  return entry.type === "folder"
    ? { kind: "folder", repoRoot, group, entry }
    : { kind: "file", file: entry.file as RepoChangedFile };
}

function count(n: number): string | undefined {
  return n > 0 ? String(n) : undefined;
}

function placeholder(label: string): Node {
  return { kind: "placeholder", label };
}

function agentItem(
  s: AgentSession,
  displayName: string,
  gate?: { kind: "plan" | "review"; foreground: boolean },
): vscode.TreeItem {
  // Label by harness name + short session id; the absolute root in the tooltip disambiguates agents
  // from different repositories without making the flat list visually noisy.
  const item = new vscode.TreeItem(
    agentLabel(displayName, s.sessionId),
    vscode.TreeItemCollapsibleState.None,
  );
  const started = new Date(s.startedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const toolLine = s.lastTool ? `\nLast tool: ${s.lastTool}` : "";
  const ctx = `${s.repoRoot}\nSession ${s.sessionId}\nStarted ${started}${toolLine}`;
  if (gate) {
    const role = gate.kind === "plan" ? "plan review" : "code review";
    const slot = gate.foreground ? "active" : "pending";
    item.description = `awaiting ${role} · ${slot}`;
    item.iconPath = new vscode.ThemeIcon(
      gate.foreground ? "circle-large-filled" : "circle-large-outline",
    );
    item.tooltip = `${ctx}\nAwaiting ${role} (${slot}) — click to ${
      gate.foreground ? "keep viewing" : "switch to it"
    }`;
  } else {
    item.description = STATE_LABEL[s.state];
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[s.state]);
    item.tooltip = `${ctx}\n${STATE_LABEL[s.state]}`;
  }
  // Hidden (muted) rows show just the name + crossed eye — no status text, no needs-you bell.
  if (s.muted) {
    item.description = undefined;
    item.iconPath = new vscode.ThemeIcon("eye-closed");
    item.tooltip = `${ctx}\nHidden — pings muted`;
  } else if (s.needsAttention && !gate?.foreground) {
    // The agent has paused and wants the user (and they haven't looked yet) — flag it prominently.
    item.description = `${item.description} · needs you`;
    item.iconPath = new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.orange"));
  }
  item.contextValue = s.muted ? "agentSession:muted" : "agentSession";
  item.command = { command: Commands.agentSwitch, title: "Switch to Agent", arguments: [s] };
  return item;
}

function fileItem(file: RepoChangedFile, extensionUri: vscode.Uri): vscode.TreeItem {
  // Colour only the status indicator (a coloured letter, like git), leaving the filename default —
  // a FileDecoration would instead tint the whole label.
  const item = new vscode.TreeItem(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
  item.id = `file:${repoKey(file.repoRoot)}:${file.group}:${file.path}`;
  item.iconPath = statusIcon(extensionUri, file.status);
  const dir = path.dirname(file.path);
  const counts = `+${file.additions} -${file.deletions}`;
  item.description = dir === "." ? counts : `${dir}  ${counts}`;
  item.tooltip = `${file.path}\n${statusWord(file.status)} · ${counts}`;
  item.contextValue = `changedFile:${file.group}`;
  item.command = { command: Commands.reviewOpenDiff, title: "Open Diff", arguments: [file] };
  return item;
}

function reviewCommentItem(c: ReviewComment): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `${path.basename(c.filePath)}:${c.line + 1}`,
    vscode.TreeItemCollapsibleState.None,
  );
  const dir = path.dirname(c.filePath);
  const repo = path.basename(c.repoRoot);
  item.description = dir === "." ? `${repo} · ${c.body}` : `${repo}/${dir} · ${c.body}`;
  item.iconPath = kindThemeIcon(c.kind);
  item.tooltip = new vscode.MarkdownString(
    `**${kindLabel(c.kind)}** · ${path.join(c.repoRoot, c.filePath)}:${c.line + 1}\n\n> ${c.quote}\n\n${c.body}`,
  );
  item.contextValue = "reviewComment";
  item.command = { command: Commands.reviewRevealComment, title: "Reveal Comment", arguments: [c] };
  return item;
}

function planCommentItem(c: PlanCommentData): vscode.TreeItem {
  const item = new vscode.TreeItem(`Line ${c.line + 1}`, vscode.TreeItemCollapsibleState.None);
  item.description = c.body;
  item.iconPath = kindThemeIcon(c.kind);
  item.tooltip = new vscode.MarkdownString(
    `**${kindLabel(c.kind)}** · line ${c.line + 1}\n\n> ${c.quote}\n\n${c.body}`,
  );
  item.contextValue = "planComment";
  return item;
}

function kindThemeIcon(kind: ReviewComment["kind"]): vscode.ThemeIcon {
  const colorId = kindColorId(kind);
  return new vscode.ThemeIcon(kindIcon(kind), colorId ? new vscode.ThemeColor(colorId) : undefined);
}
