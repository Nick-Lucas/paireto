// The single Paireto sidebar view. Top-level rows are collapsible section headers — Agents,
// Plan Review, Changed Files, Feedback. The Changed Files section nests group headers (Staged /
// Unstaged / Committed), each laid out flat or as a compressed folder tree. Section/group/file
// actions are inline buttons (see package.json view/item/context, keyed on contextValue).

import * as path from "node:path";

import * as vscode from "vscode";

import type { AgentSessionService } from "../agents/AgentSessionService.js";
import { kindColorId, kindIcon, kindLabel, type CommentKind } from "../comments/kinds.js";
import { Commands, Views } from "../config.js";
import type { GateCoordinator, GateKind } from "../gate/GateCoordinator.js";
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
import type {
  GuidedChangesetState,
  GuidedFileRow,
  GuidedReviewState,
} from "../review/guidedPlan.js";
import { getOpeningComment, type ThreadItem, type ReviewThread } from "../review/reviewTypes.js";
import type { AgentInstallStatus } from "../welcome/AgentInstallStatus.js";
import type { SetupPrompt } from "../welcome/installStatus.js";
import type { AgentSession } from "../agents/AgentSession.js";
import type { AgentState, ChangesMode, FileGroup } from "../types.js";
import { buildDelta, stagingFlags, type DeltaFile, type StageState } from "../review/delta.js";
import type { SeenFiles } from "../review/SeenFiles.js";
import { repoKey } from "../protocol/paths.js";
import { describeCompareTo } from "../protocol/guidedReview.js";
import { buildFileTree, filesInEntry, type TreeEntry } from "./fileTree.js";

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
  "!": "conflict",
};

type StatusIconVariant = "worktree" | "staged" | "partial";

function statusIcon(
  extensionUri: vscode.Uri,
  status: FileStatus,
  tone: StatusIconVariant = "worktree",
): { light: vscode.Uri; dark: vscode.Uri } {
  const name = STATUS_ICON_FILE[status] ?? "m";
  const variant = tone === "worktree" || status === "!" ? name : `${name}-${tone}`;
  return {
    light: vscode.Uri.joinPath(extensionUri, "media", "status", `${variant}-light.svg`),
    dark: vscode.Uri.joinPath(extensionUri, "media", "status", `${variant}-dark.svg`),
  };
}

type SectionId = "agents" | "plan" | "changesets" | "files" | "feedback";

type Node =
  | { kind: "setupNotice"; prompt: SetupPrompt }
  | {
      kind: "section";
      id: SectionId;
      label: string;
      description?: string;
      tooltip?: string;
      command?: vscode.Command;
    }
  | { kind: "changeset"; repoRoot: string; changeset: GuidedChangesetState }
  | { kind: "changesetFile"; repoRoot: string; row: GuidedFileRow }
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
  | {
      kind: "deltaFolder";
      repoRoot: string;
      entry: Extract<TreeEntry<DeltaFile>, { type: "folder" }>;
    }
  | { kind: "deltaFile"; delta: DeltaFile }
  | { kind: "agent"; session: AgentSession }
  | { kind: "reviewComment"; thread: ReviewThread }
  | {
      kind: "threadItem";
      threadId: string;
      item: Exclude<ThreadItem, { kind: "comment" }>;
    }
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
  return {
    A: "Added",
    M: "Modified",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    U: "Untracked",
    "!": "Conflicted",
  }[s];
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

  constructor(
    private readonly agents: AgentSessionService,
    private readonly review: ReviewController,
    private readonly seen: SeenFiles,
    private readonly plan: PlanReviewController,
    private readonly coordinator: GateCoordinator,
    private readonly locator: AgentServiceLocator,
    private readonly installStatus: AgentInstallStatus,
    private readonly extensionUri: vscode.Uri,
  ) {
    const fire = (): void => {
      this.emitter.fire();
      this.updateBadge();
    };
    this.subs.push(
      this.agents.onDidChange(fire),
      this.review.onDidChangeState(() => this.onStateChanged()),
      this.seen.onDidChange(() => this.emitter.fire()),
      this.plan.onDidChange(fire),
      this.installStatus.onDidChange(() => this.emitter.fire()),
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

  private onStateChanged(): void {
    this.emitter.fire();
    this.updateBadge();
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
    this.view = vscode.window.createTreeView(Views.main, {
      treeDataProvider: this,
      canSelectMany: true,
      manageCheckboxStateManually: true,
    });
    this.subs.push(
      this.view,
      this.view.onDidChangeCheckboxState((event) => this.onCheckboxes(event.items)),
    );
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

  private async onCheckboxes(
    items: ReadonlyArray<[Node, vscode.TreeItemCheckboxState]>,
  ): Promise<void> {
    for (const [node, state] of items) {
      await this.seen.setSeen(
        this.deltaFilesUnder(node),
        state === vscode.TreeItemCheckboxState.Checked,
      );
    }
  }

  private deltaFilesUnder(node: Node): DeltaFile[] {
    switch (node.kind) {
      case "deltaFile":
        return [node.delta];
      case "deltaFolder":
        return filesInEntry(node.entry);
      case "repository":
        return this.deltaFor(node.repository);
      case "section":
        return node.id === "files" ? this.allDeltaFiles() : [];
      default:
        return [];
    }
  }

  private allDeltaFiles(): DeltaFile[] {
    return this.review.getState().repositories.flatMap((repository) => this.deltaFor(repository));
  }

  private deltaFor(repository: RepositoryReviewState): DeltaFile[] {
    return buildDelta(repository.repoRoot, repository.changes);
  }

  // ── Selection sync: keep the highlighted row pointed at the diff the editor is showing ──
  private syncSelection(target: { repoRoot: string; group: FileGroup; path: string }): void {
    // A review plan replaces the Changed Files list, so there is no `file` row to reveal — and
    // revealing one would drag the selection off the changeset row the user just clicked.
    const state = this.review.getState();
    if (state.guided) {
      return;
    }
    if (state.mode !== "staging") {
      void this.revealDeltaRow(target);
      return;
    }
    if (this.rowFor(target)) {
      void this.revealRow(target);
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

  private async revealDeltaRow(t: { repoRoot: string; path: string }): Promise<void> {
    const repository = this.repository(t.repoRoot);
    const delta = repository && this.deltaFor(repository).find((row) => row.path === t.path);
    if (!delta || !this.view) {
      return;
    }
    await this.view
      .reveal({ kind: "deltaFile", delta }, { select: true, focus: false })
      .then(undefined, () => undefined);
  }

  getParent(node: Node): Node | undefined {
    switch (node.kind) {
      case "changeset":
        return { kind: "section", id: "changesets", label: "Review Plan" };
      case "changesetFile": {
        const changeset = this.review
          .getState()
          .guided?.changesets.find((c) => c.id === node.row.changesetId);
        return changeset
          ? { kind: "changeset", repoRoot: node.repoRoot, changeset }
          : { kind: "section", id: "changesets", label: "Review Plan" };
      }
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
      case "deltaFolder":
        return this.deltaParent(
          node.repoRoot,
          (e) => e.type === "folder" && e.path === node.entry.path,
        );
      case "deltaFile":
        return this.deltaParent(
          node.delta.repoRoot,
          (e) => e.type === "file" && e.file.path === node.delta.path,
        );
      case "agent":
        return { kind: "section", id: "agents", label: "Agents" };
      case "reviewComment":
      case "threadItem":
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

  private deltaParent(repoRoot: string, matches: (e: TreeEntry<DeltaFile>) => boolean): Node {
    const state = this.review.getState();
    const repository = this.repository(repoRoot);
    const top: Node =
      state.repositories.length > 1 && repository
        ? { kind: "repository", repository }
        : { kind: "section", id: "files", label: "Changed Files" };
    if (state.layout === "flat" || !repository) {
      return top;
    }
    const parent = findEntryParent(buildFileTree(this.deltaFor(repository)), matches);
    return parent ? { kind: "deltaFolder", repoRoot, entry: parent } : top;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "setupNotice":
        return setupNoticeItem(node.prompt);
      case "section": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.id}`;
        item.contextValue = node.id === "files" ? this.filesSectionContext() : `section:${node.id}`;
        if (node.id === "files" && this.review.getState().mode === "review") {
          item.checkboxState = this.checkboxFor(this.allDeltaFiles());
        }
        item.description = node.description;
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
      case "changeset":
        return changesetItem(node.repoRoot, node.changeset);
      case "changesetFile":
        return changesetFileItem(node.repoRoot, node.row, this.extensionUri);
      case "repository": {
        const item = new vscode.TreeItem(
          node.repository.displayName,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `repository:${repoKey(node.repository.repoRoot)}`;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = repositoryBranchLabel(node.repository.branch);
        item.tooltip = node.repository.repoRoot;
        const { mode } = this.review.getState();
        const files = mode === "staging" ? [] : this.deltaFor(node.repository);
        item.contextValue = deltaContainerContext("repository", mode, files);
        if (mode === "review") {
          item.checkboxState = this.checkboxFor(files);
        }
        return item;
      }
      case "deltaFolder": {
        const { mode } = this.review.getState();
        const files = filesInEntry(node.entry);
        const item = new vscode.TreeItem(node.entry.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `deltaFolder:${repoKey(node.repoRoot)}:${node.entry.path}`;
        item.resourceUri = vscode.Uri.file(path.join(node.repoRoot, node.entry.path));
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = deltaContainerContext("deltaFolder", mode, files);
        if (mode === "review") {
          item.checkboxState = this.checkboxFor(files);
        }
        return item;
      }
      case "deltaFile":
        return deltaFileItem(
          node.delta,
          this.review.getState().mode,
          this.seen.isSeen(node.delta),
          this.extensionUri,
        );
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
        return reviewCommentItem(node.thread);
      case "threadItem":
        return createThreadItemRow(node.item);
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
      case "changeset":
        return changesetFileNodes(node.repoRoot, node.changeset);
      case "repository":
        return this.repositoryChildren(node.repository);
      case "group":
        return this.groupChildren(node.repoRoot, node.group);
      case "folder":
        return node.entry.children.map((e) => entryToNode(e, node.repoRoot, node.group));
      case "deltaFolder":
        return node.entry.children.map((e) => deltaEntryToNode(e, node.repoRoot));
      case "reviewComment":
        return node.thread.items.flatMap((item) =>
          item.kind === "comment"
            ? []
            : [{ kind: "threadItem" as const, threadId: node.thread.id, item }],
        );
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
    // Cached only — probing here would block the render (the Codex probe calls its CLI).
    const prompt = this.installStatus.prompt();
    if (prompt) {
      out.push({ kind: "setupNotice", prompt });
    }
    const agentCount = this.scopedAgents().length;
    out.push({ kind: "section", id: "agents", label: "Agents", description: count(agentCount) });

    // While a review plan is open it REPLACES the raw file list: the plan covers every change (the
    // trailing "Other changes" group catches anything it did not name), so showing both would list
    // the same files twice and leave the reviewer unsure which one to work from.
    const guided = this.review.getState().guided;
    if (guided) {
      out.push({
        kind: "section",
        id: "changesets",
        label: "Review Plan",
        description: guidedDescription(guided),
        tooltip: guidedTooltip(guided),
        // The agent's summary is a paragraph about the whole branch; the row can only hold a
        // tooltip, so clicking it opens the summary as a document, like a changeset description.
        command: { command: Commands.guidedReviewOpenPlan, title: "Open Review Plan" },
      });
    } else {
      out.push({
        kind: "section",
        id: "files",
        label: "Changed Files",
        description: this.filesDescription(),
      });
    }

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
      case "changesets": {
        const guided = this.review.getState().guided;
        if (!guided) {
          return [];
        }
        return guided.changesets.map((changeset) => ({
          kind: "changeset",
          repoRoot: guided.repoRoot,
          changeset,
        }));
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
          ? comments.map((thread) => ({ kind: "reviewComment", thread }) as Node)
          : [placeholder("No comments yet — add them on the diff")];
      }
    }
  }

  private filesSectionContext(): string {
    const { mode } = this.review.getState();
    const files = mode === "staging" ? [] : this.allDeltaFiles();
    return deltaContainerContext("section:files", mode, files);
  }

  private checkboxFor(files: DeltaFile[]): vscode.TreeItemCheckboxState {
    return files.length > 0 && files.every((file) => this.seen.isSeen(file))
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }

  private repositoryChildren(repository: RepositoryReviewState): Node[] {
    const { mode, layout } = this.review.getState();
    if (mode !== "staging") {
      const deltas = this.deltaFor(repository);
      if (!deltas.length) {
        return [placeholder("No changes")];
      }
      return layout === "flat"
        ? deltas.map((delta) => ({ kind: "deltaFile", delta }) as Node)
        : buildFileTree(deltas).map((e) => deltaEntryToNode(e, repository.repoRoot));
    }
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

  private filesDescription(): string | undefined {
    const state = this.review.getState();
    const compare = changesDescription(state);
    if (state.mode !== "review") {
      return compare;
    }
    const files = this.allDeltaFiles();
    const seen = files.filter((file) => this.seen.isSeen(file)).length;
    const progress = `${seen}/${files.length} seen`;
    return compare ? `${compare} · ${progress}` : progress;
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
function findEntryParent<F extends { path: string }>(
  entries: TreeEntry<F>[],
  matches: (e: TreeEntry<F>) => boolean,
  parent?: Extract<TreeEntry<F>, { type: "folder" }>,
): Extract<TreeEntry<F>, { type: "folder" }> | undefined {
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
    net: [],
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
      case "stackBase":
        return "Stack Base";
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

function deltaEntryToNode(entry: TreeEntry<DeltaFile>, repoRoot: string): Node {
  return entry.type === "folder"
    ? { kind: "deltaFolder", repoRoot, entry }
    : { kind: "deltaFile", delta: entry.file };
}

export function deltaContainerContext(
  prefix: string,
  mode: ChangesMode,
  files: DeltaFile[],
): string {
  switch (mode) {
    case "staging":
      return prefix;
    case "delta":
      return `${prefix}:delta${stagingFlags(files)}`;
    case "review":
      return `${prefix}:review`;
  }
}

const STAGE_LABEL: Record<StageState, string> = {
  unstaged: "Not staged",
  partial: "Partly staged",
  staged: "Staged",
  committed: "Committed",
};

function deletedFlag(status: ChangedFile["status"]): string {
  return status === "D" ? ":deleted" : "";
}

export function stageIcon(
  delta: DeltaFile,
  extensionUri: vscode.Uri,
): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
  switch (delta.stage) {
    case "committed":
      return new vscode.ThemeIcon(
        GROUP_ICON.committed.icon,
        new vscode.ThemeColor(GROUP_ICON.committed.color),
      );
    case "staged":
      return statusIcon(extensionUri, delta.status, "staged");
    case "partial":
      return statusIcon(extensionUri, delta.status, "partial");
    case "unstaged":
      return statusIcon(extensionUri, delta.status);
  }
}

export function deltaFileItem(
  delta: DeltaFile,
  mode: ChangesMode,
  seen: boolean,
  extensionUri: vscode.Uri,
): vscode.TreeItem {
  const item = new vscode.TreeItem(path.basename(delta.path), vscode.TreeItemCollapsibleState.None);
  item.id = `deltaFile:${repoKey(delta.repoRoot)}:${delta.path}`;
  item.iconPath =
    mode === "review"
      ? statusIcon(extensionUri, delta.status, seen ? "staged" : "worktree")
      : stageIcon(delta, extensionUri);
  const dir = path.dirname(delta.path);
  const counts = `+${delta.additions} -${delta.deletions}`;
  item.description = dir === "." ? counts : `${dir}  ${counts}`;
  item.tooltip = `${delta.path}\n${statusWord(delta.status)} · ${counts}\n${STAGE_LABEL[delta.stage]}`;
  item.contextValue = `${deltaContainerContext("deltaFile", mode, [delta])}${deletedFlag(delta.status)}`;
  item.command = { command: Commands.reviewOpenDelta, title: "Open Changes", arguments: [delta] };
  if (mode === "review") {
    item.checkboxState = seen
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
  return item;
}

function count(n: number): string | undefined {
  return n > 0 ? String(n) : undefined;
}

function placeholder(label: string): Node {
  return { kind: "placeholder", label };
}

/**
 * The top row that sends the user to the Welcome screen: either no agent has the Paireto plugin yet,
 * or one has a stale copy that will not speak to this extension.
 */
export function setupNoticeItem(prompt: SetupPrompt): vscode.TreeItem {
  const item = new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None);
  item.id = "notice:agentSetup";
  item.contextValue = "setupNotice";
  item.command = { command: Commands.openWelcome, title: "Open Welcome" };
  if (prompt.kind === "install") {
    item.label = "Set up an agent";
    item.iconPath = new vscode.ThemeIcon("rocket");
    item.tooltip =
      "No agent has the Paireto plugin yet.\nClick to open the Welcome screen and set one up.";
    return item;
  }
  item.label = "Update agent plugins";
  item.description = prompt.agentNames.join(", ");
  item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.orange"));
  item.tooltip = `These agents have an old Paireto plugin: ${prompt.agentNames.join(
    ", ",
  )}.\nClick to open the Welcome screen and update them.`;
  return item;
}

/** How an agent row names the gate it is waiting on. */
const GATE_ROLE: Record<GateKind, string> = {
  plan: "plan review",
  review: "code review",
  guided: "guided review",
};

function agentItem(
  s: AgentSession,
  displayName: string,
  gate?: { kind: GateKind; foreground: boolean },
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
    const role = GATE_ROLE[gate.kind];
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

/** `scope` namespaces the row id. The same file can legitimately appear under two changesets and in
 *  Changed Files, and VS Code rejects a tree with a duplicate TreeItem.id. */
export function fileItem(
  file: RepoChangedFile,
  extensionUri: vscode.Uri,
  scope = "changes",
): vscode.TreeItem {
  // Colour only the status indicator (a coloured letter, like git), leaving the filename default —
  // a FileDecoration would instead tint the whole label.
  const item = new vscode.TreeItem(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
  item.id = `file:${scope}:${repoKey(file.repoRoot)}:${file.group}:${file.path}`;
  item.iconPath = statusIcon(extensionUri, file.status);
  const dir = path.dirname(file.path);
  const counts = `+${file.additions} -${file.deletions}`;
  item.description = dir === "." ? counts : `${dir}  ${counts}`;
  item.tooltip = `${file.path}\n${statusWord(file.status)} · ${counts}`;
  item.contextValue = `changedFile:${file.group}${deletedFlag(file.status)}`;
  item.command = { command: Commands.reviewOpenDiff, title: "Open Diff", arguments: [file] };
  return item;
}

/**
 * A changeset's rows, in the order the agent submitted them. Deliberately NOT through
 * `buildFileTree`, and independent of the flat/tree layout: both sort alphabetically, and the
 * reading order is the whole point of the plan — losing it is a silent failure that still looks fine.
 */
export function changesetFileNodes(repoRoot: string, changeset: GuidedChangesetState): Node[] {
  return changeset.files.map((row) => ({ kind: "changesetFile", repoRoot, row }));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function guidedDescription(guided: GuidedReviewState): string {
  const changesets = plural(guided.changesets.length, "changeset");
  const summary = `${changesets} · ${plural(guided.fileTotal, "file")}`;
  return guided.missingTotal
    ? `${summary} · ${guided.missingTotal} not in the current comparison`
    : summary;
}

/**
 * Which bulk git actions a changeset row offers, encoded in its contextValue so the menu can hide the
 * one that would do nothing. A changeset of purely committed files offers neither.
 */
export function changesetContextValue(changeset: GuidedChangesetState): string {
  if (changeset.stageableCount && changeset.unstageableCount) {
    return "changeset:both";
  }
  if (changeset.stageableCount) {
    return "changeset:stage";
  }
  return changeset.unstageableCount ? "changeset:unstage" : "changeset";
}

function guidedTooltip(guided: GuidedReviewState): string | undefined {
  const against = describeCompareTo(guided.compareTo);
  const lines = [guided.summary, `Compared against ${against}`];
  return lines.filter(Boolean).join("\n\n") || undefined;
}

export function changesetItem(repoRoot: string, changeset: GuidedChangesetState): vscode.TreeItem {
  const item = new vscode.TreeItem(changeset.title, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `changeset:${repoKey(repoRoot)}:${changeset.id}`;
  item.contextValue = changesetContextValue(changeset);
  item.iconPath = new vscode.ThemeIcon("layers");
  item.description = plural(changeset.files.length, "file");
  item.tooltip = new vscode.MarkdownString(
    `**${changeset.title}**\n\n${changeset.description || "_No description._"}`,
  );
  item.command = {
    command: Commands.guidedReviewOpenChangeset,
    title: "Open Changeset",
    arguments: [{ changesetId: changeset.id }],
  };
  return item;
}

export function changesetFileItem(
  repoRoot: string,
  row: GuidedFileRow,
  extensionUri: vscode.Uri,
): vscode.TreeItem {
  if (!row.file) {
    // The plan named it but it has no change now (already committed away, reverted, or outside the
    // current Compare To). Say so rather than dropping the row and leaving a gap in the reading list.
    const item = new vscode.TreeItem(path.basename(row.path), vscode.TreeItemCollapsibleState.None);
    item.id = `changesetFile:${repoKey(repoRoot)}:${row.changesetId}:${row.path}`;
    item.contextValue = "changesetFile:missing";
    item.iconPath = new vscode.ThemeIcon("circle-slash");
    item.description = "no longer in the changes";
    item.tooltip = `${row.path}\nNot in the current comparison`;
    return item;
  }
  const item = fileItem(row.file, extensionUri, row.changesetId);
  item.contextValue = `changedFile:${row.file.group}:planned${deletedFlag(row.file.status)}`;
  // The plan lists a file wherever it currently sits, so the row itself has to say which git layer
  // that is — unlike Changed Files, where the group header already does. A committed change gets the
  // commit glyph; the working tree keeps the usual coloured status letter, and the index the same
  // letter muted, so staged reads as "already dealt with" without losing what changed.
  item.iconPath =
    row.file.group === "committed"
      ? new vscode.ThemeIcon(
          GROUP_ICON.committed.icon,
          new vscode.ThemeColor(GROUP_ICON.committed.color),
        )
      : statusIcon(
          extensionUri,
          row.file.status,
          row.file.group === "staged" ? "staged" : "worktree",
        );
  item.tooltip = `${item.tooltip}\n${GROUP_LABELS[row.file.group]}`;
  item.command = {
    command: Commands.guidedReviewOpenFile,
    title: "Open Diff",
    arguments: [{ changesetId: row.changesetId, path: row.path }],
  };
  return item;
}

export function reviewCommentItem(c: ReviewThread): vscode.TreeItem {
  const feedback = getOpeningComment(c);
  // A comment on a changeset description is about the grouping, not about a line of code: it carries
  // no file path, so it is named by the changeset it belongs to.
  const [label, where] = c.changeset
    ? [c.changeset.title, `Changeset: ${c.changeset.title}`]
    : [
        `${path.basename(c.filePath)}:${c.line + 1}`,
        `${path.join(c.repoRoot, c.filePath)}:${c.line + 1}`,
      ];
  // Expandable only when something was said after the comment, so a lone comment has no
  // twisty to open onto nothing.
  const hasReplies = c.items.length > 1;
  const item = new vscode.TreeItem(
    label,
    hasReplies ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  );
  item.description = `${commentScope(c)} · ${feedback.body}`;
  item.iconPath = kindThemeIcon(feedback.commentKind);
  item.tooltip = new vscode.MarkdownString(
    `**${kindLabel(feedback.commentKind)}** · ${where}\n\n> ${feedback.quote}\n\n${feedback.body}`,
  );
  item.contextValue = "reviewComment";
  item.command = { command: Commands.reviewRevealComment, title: "Reveal Comment", arguments: [c] };
  return item;
}

export function createThreadItemRow(
  item: Exclude<ThreadItem, { kind: "comment" }>,
): vscode.TreeItem {
  const who = item.author.kind === "agent" ? `${item.author.harness} agent` : "You";
  const row = new vscode.TreeItem(
    item.kind === "reply" ? `${who} replied` : "Resolved",
    vscode.TreeItemCollapsibleState.None,
  );
  row.description = item.kind === "reply" ? item.body : who;
  row.iconPath = new vscode.ThemeIcon(item.kind === "reply" ? "reply" : "pass-filled");
  row.tooltip = new vscode.MarkdownString(
    item.kind === "reply" ? `**Reply** · ${who}\n\n${item.body}` : `**Resolved** · ${who}`,
  );
  row.contextValue = "threadItem";
  return row;
}

/** Where a feedback row sits, shown ahead of its body: the changeset, or the file's directory. */
function commentScope(c: ReviewThread): string {
  if (c.changeset) {
    return "Changeset";
  }
  const dir = path.dirname(c.filePath);
  const repo = path.basename(c.repoRoot);
  return dir === "." ? repo : `${repo}/${dir}`;
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

function kindThemeIcon(kind: CommentKind): vscode.ThemeIcon {
  const colorId = kindColorId(kind);
  return new vscode.ThemeIcon(kindIcon(kind), colorId ? new vscode.ThemeColor(colorId) : undefined);
}
