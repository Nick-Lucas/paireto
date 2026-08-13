// Orchestrates the Changes view + code-review session: tracks the grouped changes (Staged /
// Unstaged / Committed) for the window's Git roots and shared Compare-To point, opens diffs, runs git write-ops
// (stage/unstage/discard), hosts inline comments, and ships feedback to the waiting agent.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import * as vscode from "vscode";

import type { ReviewGateResult, StopGateResult } from "../bridge/types.js";
import { CommentSession, type GateComment } from "../comments/CommentSession.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
import { GateCoordinator, type GateEntry, type GateKind } from "../gate/GateCoordinator.js";
import { repoRelativePath } from "../protocol/paths.js";
import { closeTabsWhere } from "../gate/tabs.js";
import {
  DiffService,
  singlePaneSide,
  withBaseComparison,
  type ChangedFile,
  type ChangesModel,
  type ContentRef,
  type FileSides,
} from "../git/DiffService.js";
import type { WorkspaceRootCatalog } from "../git/WorkspaceRootCatalog.js";
import { currentBranch } from "../git/gitCli.js";
import { log } from "../log.js";
import type { ReviewStore } from "../storage/ReviewStore.js";
import type { CompareTo, FileGroup, FileLayout } from "../types.js";
import { getAutoRevealSetting } from "../util/editorSettings.js";
import { ReviewContentProvider } from "./ReviewContentProvider.js";
import { ReviewPath } from "./ReviewPath.js";
import { ReviewGateRegistry } from "./ReviewGateRegistry.js";
import { relocateReviewAnchor } from "./commentAnchors.js";
import {
  BulkTargetArg,
  ChangesetIdArg,
  CommentIdArg,
  CommentReplyArg,
  FileArg,
  FilesArg,
  GuidedRowArg,
  ShowOptionsArg,
  readArg,
  withArg,
} from "./commandArgs.js";
import {
  ChangesetDocProvider,
  changesetDocUri,
  changesetIdFromDocUri,
  PLAN_DOC_ID,
  renderChangesetDoc,
  renderPlanDoc,
} from "./ChangesetDocProvider.js";
import {
  buildGuidedState,
  GuidedPlanError,
  parseChangesets,
  toGuidedPlan,
  verifyGuidedCompareTo,
  type GuidedChangesetState,
  type GuidedFileRow,
  type GuidedPlan,
  type GuidedReviewState,
} from "./guidedPlan.js";
import { resolveRenameTarget } from "./renamePath.js";
import { renderReviewFeedback } from "./reviewFeedback.js";
import { dirtyTargetDocs } from "./stageSaves.js";
import { pickCompareTo, pickFileCompareTo, pickMultiCompareTo } from "./reviewSelectors.js";
import type { ReviewComment } from "./reviewTypes.js";

/** A review comment: the VS Code comment instance paired with its serializable model. */
interface ReviewEntry {
  comment: GateComment;
  model: ReviewComment;
}

const EMPTY_CHANGES: ChangesModel = {
  staged: [],
  unstaged: [],
  committed: [],
  compareLabel: "HEAD",
  compareRef: null,
};

const GROUP_LABEL: Record<FileGroup, string> = {
  staged: "Staged",
  unstaged: "Working Tree",
  committed: "Committed",
};

/** Groups strictly "below" a given group, from highest (committed) to lowest (unstaged). */
const LOWER_GROUPS: Record<FileGroup, FileGroup[]> = {
  committed: ["staged", "unstaged"],
  staged: ["unstaged"],
  unstaged: [],
};

export interface ReviewState {
  compareTo: CompareTo;
  layout: FileLayout;
  repositories: RepositoryReviewState[];
  /** The agent's changeset plan resolved against the live changes, while a guided review is open. */
  guided?: GuidedReviewState;
}

export interface RepoChangedFile extends ChangedFile {
  repoRoot: string;
}

export interface RepositoryChangesModel extends Omit<ChangesModel, FileGroup> {
  staged: RepoChangedFile[];
  unstaged: RepoChangedFile[];
  committed: RepoChangedFile[];
}

export interface RepositoryReviewState {
  repoRoot: string;
  displayName: string;
  branch?: string;
  changes: RepositoryChangesModel;
}

/** State belonging to an open tab: its tree location may move, but its comparison stays pinned. */
export interface OpenDiffState {
  repoRoot: string;
  path: string;
  group: FileGroup;
  /** Encoded ContentRef token (HEAD, INDEX, a git ref, etc.) used by the base URI. */
  baseRef: string;
  baseLabel?: string;
}

interface OpenedReviewFile {
  baseUri: vscode.Uri;
  modifiedUri: vscode.Uri;
  /** One URI for a single-pane add/delete, otherwise both diff sides. */
  visibleUris: vscode.Uri[];
}

/** Editing always lands in the Working Tree; it must never silently rewrite the tab's baseline. */
export function markOpenDiffEdited(open: OpenDiffState): OpenDiffState {
  return { ...open, group: "unstaged" };
}

export class ReviewController implements vscode.Disposable {
  private readonly commentSession: CommentSession;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.changeEmitter.event;
  /** Fires the (group, path) of the diff the editor is now showing, so the tree can select its row. */
  private readonly activeDiffEmitter = new vscode.EventEmitter<{
    repoRoot: string;
    group: FileGroup;
    path: string;
  }>();
  readonly onDidChangeActiveDiff = this.activeDiffEmitter.event;

  private reviewId = newReviewId();
  private compareTo: CompareTo;
  private layout: FileLayout;
  private readonly repositoryStates = new Map<string, RepositoryReviewState>();
  private readonly comments = new Map<string, ReviewEntry>();
  private readonly gate = new ReviewGateRegistry();
  private activeRequestId?: string;
  /** Owning agent session of the active review (best-effort; drives the Agents panel). */
  private activeSessionId?: string;
  /** The agent's changeset plan for the active guided review. Held OUTSIDE `repositoryStates`, which
   *  `refresh()` rebuilds wholesale — so it stores paths and resolves them fresh on every read. */
  private guidedPlan?: GuidedPlan;
  /** The open plan's comparison point, scoped to the repository it describes. The window's shared
   *  Compare To cannot hold a raw ref while several Git roots are open, so a multi-root window would
   *  otherwise resolve the plan against the default branch instead of what the agent diffed. */
  private guidedCompareTo?: { repoRoot: string; compareTo: CompareTo };
  /** Read-only markdown for each changeset the reviewer has opened; cleared with the plan. */
  private readonly changesetDocs = new ChangesetDocProvider();
  /** The review slot: held while a review is in progress. A second agent review waits in
   *  `reviewWaiters` until the one ahead resolves (at most one review pending at a time). */
  private reviewBusy = false;
  private readonly reviewWaiters: Array<() => void> = [];
  /** The file currently shown in the diff editor, including its independently pinned baseline. */
  private openDiffFile?: OpenDiffState;
  /** Each open diff's state, keyed by its virtual tab URI — lets a tab switch re-select its row. */
  private readonly openDiffs = new Map<string, OpenDiffState>();
  /** Monotonic refresh id so a slow/stale `getChanges` can't overwrite a newer result. */
  private readonly refreshSeq = new Map<string, number>();
  /** Narrow seam `openDiff` syncs through (one scoped git check, not the full refresh). */
  private readonly openDiffSync: OpenDiffSync = {
    changesForPath: (repoRoot, relPaths, compareRef) =>
      this.diff.changesForPath(repoRoot, relPaths, compareRef),
    getRepository: (repoRoot) => this.repositoryStates.get(repoRoot),
    setRepository: (state) => this.repositoryStates.set(state.repoRoot, state),
    getRefreshSeq: (repoRoot) => this.refreshSeq.get(repoRoot) ?? 0,
    fullRefresh: (reason) => this.refresh(reason),
    fireChange: () => this.changeEmitter.fire(),
  };
  /** Per-reason refresh() tally, read by the env-gated test control plane (nothing else). */
  private readonly refreshCounts = new Map<string, number>();

  constructor(
    private readonly roots: WorkspaceRootCatalog,
    private readonly diff: DiffService,
    private readonly store: ReviewStore,
    private readonly reviewContent: ReviewContentProvider,
    private readonly coordinator: GateCoordinator,
  ) {
    this.compareTo = store.getCompareTo();
    this.layout = store.getLayout();
    // Commenting is always available on the Changes diffs — on the review-scheme side of a locked
    // diff AND on the editable working-tree (file:) side of an editable one, so it works regardless
    // of whether the file can be edited. Comments remain queued until an agent review consumes them.
    this.commentSession = new CommentSession(
      "paireto.review",
      "Paireto: Add Comment",
      Schemes.review,
      { prompt: "Add a review comment", placeHolder: "Leave a comment for Claude" },
      (doc) =>
        doc.uri.scheme === Schemes.review ||
        (doc.uri.scheme === Schemes.changeset && changesetIdFromDocUri(doc.uri) !== PLAN_DOC_ID) ||
        (doc.uri.scheme === "file" && this.isChangedFileDoc(doc.uri)),
    );

    const reg = vscode.commands.registerCommand;
    this.disposables.push(
      this.commentSession,
      this.changesetDocs,
      vscode.workspace.registerFileSystemProvider(Schemes.changeset, this.changesetDocs, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
      this.changeEmitter,
      this.activeDiffEmitter,
      reg(Commands.reviewRefresh, () => this.refresh()),
      reg(Commands.reviewPickCompareTo, () => this.changeCompareTo()),
      reg(Commands.reviewPickDiffCompareTo, () => this.changeActiveDiffCompareTo()),
      reg(Commands.reviewToggleLayout, () => this.toggleLayout()),
      reg(
        Commands.reviewOpenDiff,
        withArg(FileArg, (file, show) => this.openDiff(file, readArg(ShowOptionsArg, show))),
      ),
      reg(
        Commands.reviewOpenFile,
        withArg(FileArg, (file) => this.openFile(file)),
      ),
      reg(
        Commands.reviewStage,
        withArg(FilesArg, (files) => this.stageFiles(files)),
      ),
      reg(
        Commands.reviewUnstage,
        withArg(FilesArg, (files) => this.unstageFiles(files)),
      ),
      reg(
        Commands.reviewDiscard,
        withArg(FilesArg, (files) => this.discardFiles(files)),
      ),
      reg(
        Commands.guidedReviewOpenFile,
        withArg(GuidedRowArg, (row) => this.openPlannedFile(row)),
      ),
      reg(
        Commands.guidedReviewOpenChangeset,
        withArg(ChangesetIdArg, (id) => this.guidedReviewOpenChangeset(id)),
      ),
      reg(Commands.guidedReviewOpenPlan, () => void this.guidedReviewOpenPlan()),
      reg(
        Commands.reviewStageAll,
        withArg(BulkTargetArg, (target) => this.stageAll(target)),
      ),
      reg(
        Commands.reviewUnstageAll,
        withArg(BulkTargetArg, (target) => this.unstageAll(target)),
      ),
      reg(
        Commands.reviewDiscardAll,
        withArg(BulkTargetArg, (target) => this.discardAll(target)),
      ),
      reg(
        Commands.reviewAddQuestion,
        withArg(CommentReplyArg, (reply) => this.addComment(reply, "question")),
      ),
      reg(
        Commands.reviewAddComment,
        withArg(CommentReplyArg, (reply) => this.addComment(reply, "comment")),
      ),
      reg(
        Commands.reviewAddProblem,
        withArg(CommentReplyArg, (reply) => this.addComment(reply, "problem")),
      ),
      reg(
        Commands.reviewRevealComment,
        withArg(CommentIdArg, (id) => this.revealComment(id)),
      ),
      reg(
        Commands.reviewDeleteComment,
        withArg(CommentIdArg, (id) => this.deleteComment(id)),
      ),
      // Editing an editable staged/committed diff routes the change to the working tree. Track that
      // location immediately, but keep the tab's comparison point pinned.
      vscode.workspace.onDidChangeTextDocument((e) => this.maybeMarkAsUnstaged(e.document.uri)),
      // Saving writes to the working tree — keep the Changes view in sync.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === "file" && this.roots.gitRootForPath(doc.uri.fsPath)) {
          void this.refresh("save");
        }
      }),
      // Keep the open-tab index and editor-title context in sync with tab lifecycle changes.
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.pruneClosedDiffs();
        this.syncActiveDiffContext();
      }),
      // Switching between already-open diff tabs re-selects that file's row in the tree.
      vscode.window.onDidChangeActiveTextEditor(() => this.syncSelectionToActiveTab()),
    );
    this.syncActiveDiffContext();
  }

  /**
   * Begin a blocking review (invoked by the MCP paireto_review tool via the bridge). Waits for any
   * in-progress review to finish (at most one at a time), then opens a review — which automatically
   * consumes the bucket of unclaimed comments the user already left — and blocks until they resolve it.
   */
  async startSession(
    requestId: string,
    sessionId: string | undefined,
    repoRoot: string,
    signal: AbortSignal,
  ): Promise<ReviewGateResult> {
    if (this.roots.gitRoots.length === 0) {
      void vscode.window.showWarningMessage("Paireto code review requires a Git repository.");
      return { status: "cancelled", feedback: "" };
    }
    if (!(await this.acquireReviewSlot(signal))) {
      return { status: "cancelled", feedback: "" }; // connection dropped while queued
    }
    log.info(
      `review opened for agent ${sessionId?.slice(0, 8) ?? "unknown"}: manual (/paireto-review)`,
    );
    return this.runReview(requestId, sessionId, repoRoot, signal, (result) => result);
  }

  /**
   * Begin a guided review (invoked by the `paireto_start_guided_review` tool via the bridge). The
   * agent's changeset plan becomes a sidebar section over the ordinary Changes surfaces, and the
   * agent blocks until the user approves or sends feedback — the same two outcomes as any review.
   * Takes the review slot: `reviewId` feeds the `paireto-review://` URIs, so two review-like
   * sessions at once would mint colliding tabs.
   */
  async startGuidedSession(
    requestId: string,
    sessionId: string | undefined,
    repoRoot: string,
    submitted: { summary?: string; compareTo?: unknown; changesets: unknown },
    displayName: string,
    signal: AbortSignal,
  ): Promise<ReviewGateResult> {
    const who = sessionId?.slice(0, 8) ?? "unknown";
    if (this.roots.gitRoots.length === 0) {
      void vscode.window.showWarningMessage("Paireto guided review requires a Git repository.");
      return { status: "cancelled", feedback: "" };
    }
    // The plan is model output. A plan we cannot render goes back to the agent as feedback saying
    // exactly what was wrong, so it fixes the payload and submits again — no gate opens meanwhile.
    const reject = (message: string): ReviewGateResult => {
      log.error(`guided review rejected for agent ${who}: ${message}`);
      return {
        status: "submitted",
        feedback: `Your review plan was rejected — ${message}. Fix it and submit again.`,
      };
    };
    let guidedPlan: GuidedPlan;
    try {
      guidedPlan = toGuidedPlan(repoRoot, parseChangesets(submitted.changesets), submitted);
    } catch (error) {
      if (!(error instanceof GuidedPlanError)) {
        throw error;
      }
      return reject(error.message);
    }
    const unresolved = await verifyGuidedCompareTo(guidedPlan, (root, ref) =>
      this.diff.refExists(root, ref),
    );
    if (unresolved) {
      return reject(unresolved);
    }
    const changesets = guidedPlan.changesets;
    if (!(await this.acquireReviewSlot(signal))) {
      return { status: "cancelled", feedback: "" }; // connection dropped while queued
    }
    this.guidedPlan = guidedPlan;
    this.guidedCompareTo = { repoRoot: guidedPlan.repoRoot, compareTo: guidedPlan.compareTo };
    await this.setGuidedContext(true);
    // Align the window to what the agent actually diffed against. Otherwise the two disagree and
    // every change between the two points arrives as an unclaimed "Other changes" row. Where the
    // shared Compare To cannot hold the plan's comparison, the scoped one above is the alignment,
    // and the other repositories keep the point the user chose.
    if (sharedCompareToHolds(this.roots.gitRoots.length, guidedPlan.compareTo)) {
      await this.applyCompareTo(guidedPlan.compareTo, "guided review");
    }
    const fileCount = changesets.reduce((total, c) => total + c.files.length, 0);
    log.info(
      `guided review opened for agent ${who}: ${changesets.length} changeset(s), ${fileCount} file(s)`,
    );
    const plural = changesets.length === 1 ? "" : "s";
    this.notifyReviewOpened(
      requestId,
      `${displayName} prepared a review plan — ${changesets.length} changeset${plural}.`,
    );
    return this.runReview(requestId, sessionId, repoRoot, signal, (result) => result, "guided");
  }

  /**
   * The turn-end gate. Allows the agent to stop immediately unless there's something to review —
   * the turn touched files, there are uncommitted changes, or the user has left comments — in which
   * case it opens a review (consuming any unclaimed comments) and blocks until the user resolves it.
   * Never auto-submits: feedback reaches the agent only via an explicit Send Feedback.
   */
  async awaitStopOutcome(
    sessionId: string | undefined,
    changedThisTurn: boolean,
    displayName: string,
    repoRoot: string,
    signal: AbortSignal,
  ): Promise<StopGateResult> {
    const who = sessionId?.slice(0, 8) ?? "unknown";
    const hasComments = this.hasComments();
    const automatic =
      vscode.workspace.getConfiguration("paireto").get<string>("review.mode", "automatic") ===
      "automatic";
    // Only park if there's something to review: this agent's turn edited files (per the PostToolUse
    // hook) or the user has comments to deliver — and no review already owns the surface. Whether a
    // subagent/background task is still pending is decided by the caller (extension.ts, using
    // AgentSession's own state) BEFORE this is even invoked — that's not this function's concern.
    const open = shouldOpenTurnEndReview({
      reviewInProgress: this.reviewBusy,
      changedThisTurn,
      hasComments,
      automatic,
    });
    if (!open) {
      log.debug(`review gate: agent ${who} stop allowed, nothing to review`);
      return { block: false };
    }
    if (this.roots.gitRoots.length === 0) {
      log.info(`review gate: agent ${who} stop allowed, no Git repositories in window`);
      return { block: false };
    }
    // Technical, not narrative: the raw decision inputs, for debugging exactly why the gate opened.
    const reason = `changedThisTurn=${changedThisTurn} hasComments=${hasComments} automatic=${automatic} reviewInProgress=${this.reviewBusy}`;
    log.info(`review opened for agent ${who}: turn-end (${reason})`);
    this.reviewBusy = true;
    const requestId = newReviewId();
    this.notifyReviewOpened(
      requestId,
      `${displayName} finished its turn and is waiting for your review.`,
    );
    return this.runReview(requestId, sessionId, repoRoot, signal, (r) =>
      r.status === "submitted" ? { block: true, reason: r.feedback } : { block: false },
    );
  }

  /**
   * Non-blocking toast announcing a review that opened by itself — a turn-end gate or a guided
   * review, never /paireto-review, which the user asked for and so stays silent. One-click actions:
   * go and review it, or approve as-is.
   */
  private notifyReviewOpened(requestId: string, message: string): void {
    const REVIEW = "Start Reviewing";
    const APPROVE = "Approve Immediately";
    void vscode.window.showInformationMessage(message, REVIEW, APPROVE).then(async (choice) => {
      if (this.activeRequestId !== requestId) {
        return; // resolved/dropped while the toast was up
      }
      if (choice === REVIEW) {
        await this.coordinator.switchTo(requestId);
        await this.focusView();
      } else if (choice === APPROVE) {
        this.approve();
      }
    });
  }

  /**
   * Register a review gate, block until the user resolves it (or the connection drops), tear it down,
   * and map the gate result to the caller's reply type. Shared by /paireto-review and the turn-end
   * gate. The caller must already hold the review slot.
   */
  private async runReview<T>(
    requestId: string,
    sessionId: string | undefined,
    repoRoot: string,
    signal: AbortSignal,
    map: (result: ReviewGateResult) => T,
    kind: GateKind = "review",
  ): Promise<T> {
    // Take the pending slot BEFORE the UI goes up: registering foregrounds the gate, so Approve and
    // Send Feedback reach this review while that registration is still running, and fulfill() drops
    // an answer for an id nothing is waiting on yet — leaving the agent blocked on a resolved review.
    const decision = this.gate.awaitDecision(requestId);
    // A dropped connection ends the review (resolve the gate so this unblocks, then reset).
    const onAbort = (): void => {
      this.gate.fulfill(requestId, { status: "cancelled", feedback: "" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    await this.registerReviewGate(requestId, sessionId, repoRoot, kind);
    const result = await decision;
    signal.removeEventListener("abort", onAbort);
    if (this.activeRequestId === requestId) {
      await this.cleanupReview(requestId);
    }
    return map(result);
  }

  /** Register a review gate (foregrounded if nothing else is) and mark it active. Caller owns the slot. */
  private async registerReviewGate(
    requestId: string,
    sessionId: string | undefined,
    repoRoot: string,
    kind: GateKind,
  ): Promise<void> {
    this.activeRequestId = requestId;
    this.activeSessionId = sessionId;
    await this.refresh();
    const entry: GateEntry = {
      id: requestId,
      sessionId,
      kind,
      repoRoot,
      session: {
        kind,
        approve: () => this.approve(),
        sendFeedback: () => this.sendFeedback(),
        hasFeedback: () => this.hasFeedback(),
      },
      foreground: () => this.foreground(),
      background: () => this.background(),
    };
    await this.coordinator.register(entry);
  }

  /** Tear down the active review: drop its comments, unregister its gate, release the slot. */
  private async cleanupReview(requestId: string): Promise<void> {
    if (this.activeRequestId !== requestId) {
      return;
    }
    this.activeRequestId = undefined;
    this.activeSessionId = undefined;
    this.guidedPlan = undefined;
    this.guidedCompareTo = undefined;
    this.changesetDocs.clear();
    await this.setGuidedContext(false);
    await closeTabsWhere((tab) => tabUriScheme(tab.input) === Schemes.changeset);
    await this.setReviewContext(false);
    this.clearComments();
    await this.coordinator.unregister(requestId);
    this.releaseReviewSlot();
    this.changeEmitter.fire();
  }

  /** Foreground: commenting on, Feedback section shown, view focused. */
  private async foreground(): Promise<void> {
    await this.setReviewContext(true);
    await this.refresh();
    await this.focusView();
    this.changeEmitter.fire();
  }

  private async focusView(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${Views.main}.focus`);
    } catch {
      /* view may not be registered yet — non-fatal */
    }
  }

  /** Background: hide the Feedback section without resolving; comments are preserved. */
  private async background(): Promise<void> {
    await this.setReviewContext(false);
    this.changeEmitter.fire();
  }

  /** True while a review is in progress (drives the gate buttons), even if backgrounded. */
  isSessionActive(): boolean {
    return this.activeRequestId !== undefined;
  }

  /** Per-reason refresh() tally for `paireto.test.inspect` — lets a test pin that a flow (e.g.
   *  openDiff's scoped sync) never ran the full refresh. */
  getRefreshCounts(): Record<string, number> {
    return Object.fromEntries(this.refreshCounts);
  }

  /** Adopt a Compare To point and persist it, so the Changes model and anything reading it agree. */
  private async applyCompareTo(compareTo: CompareTo, reason: string): Promise<void> {
    if (this.compareTo.kind === compareTo.kind && this.compareTo.ref === compareTo.ref) {
      return;
    }
    log.info(
      `compare-to set to ${compareTo.kind}${compareTo.ref ? ` ${compareTo.ref}` : ""} by ${reason}`,
    );
    this.compareTo = compareTo;
    await this.store.setCompareTo(compareTo);
  }

  /** Drives whether the sidebar shows the Review Plan in place of the raw Changed Files list. */
  private async setGuidedContext(active: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", ContextKeys.guidedReviewDiffActive, active);
  }

  private async setReviewContext(foreground: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", ContextKeys.reviewSessionActive, foreground);
  }

  /** Acquire the single review slot, waiting if busy. Returns false if `signal` aborts while queued. */
  private acquireReviewSlot(signal: AbortSignal): Promise<boolean> {
    if (!this.reviewBusy) {
      this.reviewBusy = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.reviewBusy = true;
        resolve(true);
      };
      const onAbort = (): void => {
        const i = this.reviewWaiters.indexOf(grant);
        if (i >= 0) {
          this.reviewWaiters.splice(i, 1);
        }
        resolve(false);
      };
      this.reviewWaiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaseReviewSlot(): void {
    this.reviewBusy = false;
    const next = this.reviewWaiters.shift();
    if (next) {
      next();
    }
  }

  drainGate(): void {
    this.gate.drain({ status: "cancelled", feedback: "" });
  }

  getState(): ReviewState {
    const repositories = this.roots.gitRoots.map(
      (root) =>
        this.repositoryStates.get(root.repoRoot) ?? {
          repoRoot: root.repoRoot,
          displayName: root.displayName,
          changes: scopedChanges(root.repoRoot, EMPTY_CHANGES),
        },
    );
    return {
      compareTo: this.compareTo,
      layout: this.layout,
      repositories,
      guided: this.guidedPlan && this.buildGuided(this.guidedPlan, repositories),
    };
  }

  /** Resolve the plan against the current model. Rebuilt on every read, never cached: `refresh()`
   *  replaces the repository models wholesale, so a held `ChangedFile` goes stale on the next save. */
  private buildGuided(plan: GuidedPlan, repositories: RepositoryReviewState[]): GuidedReviewState {
    return buildGuidedState(
      plan,
      repositories,
      (repository, path) =>
        selectCommentFile(repository.changes, path) as RepoChangedFile | undefined,
    );
  }

  async refresh(reason = "manual"): Promise<void> {
    this.refreshCounts.set(reason, (this.refreshCounts.get(reason) ?? 0) + 1);
    const roots = this.roots.gitRoots;
    if (!sharedCompareToHolds(roots.length, this.compareTo)) {
      this.compareTo = { kind: "default" };
      await this.store.setCompareTo(this.compareTo);
    }
    const desired = new Set(roots.map((root) => root.repoRoot));
    let changed = false;
    const removedTabKeys = new Set<string>();
    for (const root of this.repositoryStates.keys()) {
      if (!desired.has(root)) {
        this.repositoryStates.delete(root);
        this.refreshSeq.delete(root);
        for (const [key, open] of this.openDiffs) {
          if (open.repoRoot === root) {
            this.openDiffs.delete(key);
            removedTabKeys.add(key);
          }
        }
        if (this.openDiffFile?.repoRoot === root) {
          this.openDiffFile = undefined;
        }
        for (const entry of this.comments.values()) {
          if (entry.model.repoRoot === root) {
            this.deleteComment(entry.model.id);
          }
        }
        changed = true;
      }
    }
    if (removedTabKeys.size > 0) {
      await closeTabsWhere((tab) => {
        const key = reviewTabKey(tab.input);
        return key !== undefined && removedTabKeys.has(key);
      });
    }

    await Promise.all(
      roots.map(async (root) => {
        const seq = (this.refreshSeq.get(root.repoRoot) ?? 0) + 1;
        this.refreshSeq.set(root.repoRoot, seq);
        let next: ChangesModel;
        let branch: string | undefined;
        try {
          [next, branch] = await Promise.all([
            this.diff.getChanges(
              root.repoRoot,
              compareToForRepo(this.compareTo, this.guidedCompareTo, root.repoRoot),
            ),
            currentBranch(root.repoRoot),
          ]);
        } catch {
          this.debug(`refresh(${reason}) ${root.repoRoot} #${seq}: failed — keeping last model`);
          return;
        }
        if (
          this.refreshSeq.get(root.repoRoot) !== seq ||
          !this.roots.gitRoots.some((candidate) => candidate.repoRoot === root.repoRoot)
        ) {
          this.debug(`refresh(${reason}) ${root.repoRoot} #${seq}: superseded`);
          return;
        }
        const previous = this.repositoryStates.get(root.repoRoot);
        if (
          !previous ||
          previous.displayName !== root.displayName ||
          previous.branch !== branch ||
          !changesEqual(previous.changes, next)
        ) {
          this.repositoryStates.set(root.repoRoot, {
            repoRoot: root.repoRoot,
            displayName: root.displayName,
            branch,
            changes: scopedChanges(root.repoRoot, next),
          });
          changed = true;
        }
        this.debug(
          `refresh(${reason}) ${root.repoRoot} #${seq}: staged=${next.staged.length} unstaged=${next.unstaged.length} committed=${next.committed.length}`,
        );
      }),
    );

    this.reviewContent.refreshAllOpen();
    if (changed) {
      this.changeEmitter.fire();
    }
  }

  private debug(msg: string): void {
    log.info(msg);
  }

  private async changeCompareTo(): Promise<void> {
    const repositories = this.getState().repositories;
    if (repositories.length === 0) {
      return;
    }
    const choice =
      repositories.length > 1
        ? await pickMultiCompareTo(this.compareTo)
        : await pickCompareTo(
            repositories[0].repoRoot,
            this.diff,
            this.store.getRecentRefs(),
            this.compareTo,
          );
    if (!choice) {
      return;
    }
    // An explicit choice outranks the open plan's comparison, in its repository too.
    this.guidedCompareTo = undefined;
    await this.applyCompareTo(choice, "user");
    if (choice.kind === "ref" && choice.ref) {
      await this.store.addRecentRef(choice.ref);
    }
    await this.refresh();
  }

  /** Change only the active tab's pinned base; the Changes view's global Compare-To is untouched. */
  private async changeActiveDiffCompareTo(): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const activeKey = reviewTabKey(input);
    const open = activeKey ? this.openDiffs.get(activeKey) : undefined;
    if (!open) {
      return;
    }
    const choice = await pickFileCompareTo(
      open.repoRoot,
      this.diff,
      this.store.getRecentRefs(),
      open.baseRef,
      open.baseLabel,
    );
    if (!choice) {
      return;
    }

    let base: ContentRef;
    let label: string;
    if (choice.kind === "empty") {
      base = { kind: "empty" };
      label = "Empty";
    } else if (choice.kind === "index") {
      base = { kind: "index" };
      label = "Index";
    } else if (choice.kind === "head") {
      base = { kind: "ref", ref: "HEAD" };
      label = "HEAD";
    } else {
      const resolved = await this.diff.resolveCompareTo(open.repoRoot, choice);
      base = { kind: "ref", ref: resolved.ref ?? "HEAD" };
      label = resolved.label;
    }
    if (choice.kind === "ref" && choice.ref) {
      await this.store.addRecentRef(choice.ref);
    }

    const encoded = DiffService.encodeRef(base);
    if (encoded === open.baseRef) {
      if (input instanceof vscode.TabInputTextDiff) {
        this.reviewContent.refresh(input.original);
      } else if (input instanceof vscode.TabInputText) {
        this.reviewContent.refresh(input.uri);
      }
      return;
    }
    const changes = this.changesFor(open.repoRoot);
    const file =
      changes?.[open.group].find((f) => f.path === open.path) ??
      this.allFiles(open.repoRoot).find((f) => f.path === open.path);
    if (!file) {
      return;
    }
    const oldTabKey = activeKey!;
    const located = this.locateReviewTab(oldTabKey);
    await this.openDiff(file, {
      baseComparison: { ref: base, label },
      trackedGroup: open.group,
      viewColumn: located?.viewColumn,
      preserveFocus: false,
      preview: located?.preview ?? true,
    });
    await closeTabsWhere((tab) => reviewTabKey(tab.input) === oldTabKey);
    this.openDiffs.delete(oldTabKey);
  }

  private async toggleLayout(): Promise<void> {
    this.layout = this.layout === "tree" ? "flat" : "tree";
    await this.store.setLayout(this.layout);
    this.changeEmitter.fire();
  }

  // ── Git write-ops ──────────────────────────────────────────────────────────
  private async stageFiles(files: RepoChangedFile[]): Promise<void> {
    if (!files.length) {
      return;
    }
    if (!(await this.saveBeforeStage(files))) {
      return;
    }
    for (const [repoRoot, repoFiles] of filesByRoot(files)) {
      const paths = repoFiles.map((f) => f.path);
      await this.diff.stage(repoRoot, paths);
      await this.refresh();
      await this.reconcileOpenDiffsAfterWrite(repoRoot, paths, "staged");
    }
  }

  /**
   * Git stages the file as it is on disk, so a stage means "stage the version I am looking at" only
   * when the editor's unsaved edits are written first. Returns whether the stage may run.
   */
  private async saveBeforeStage(files: RepoChangedFile[]): Promise<boolean> {
    for (const { doc, path } of dirtyTargetDocs(vscode.workspace.textDocuments, files)) {
      if (!(await doc.save())) {
        void vscode.window.showErrorMessage(`Could not save ${path}. Nothing was staged.`);
        return false;
      }
    }
    return true;
  }

  private async unstageFiles(files: RepoChangedFile[]): Promise<void> {
    for (const [repoRoot, repoFiles] of filesByRoot(files)) {
      const paths = repoFiles.map((f) => f.path);
      await this.diff.unstage(repoRoot, paths);
      await this.refresh();
      await this.reconcileOpenDiffsAfterWrite(repoRoot, paths, "unstaged");
    }
  }

  private async discardFiles(files: RepoChangedFile[]): Promise<void> {
    if (!files.length) {
      return;
    }
    const label =
      files.length === 1 ? `the changes in ${files[0].path}` : `changes in ${files.length} files`;
    const choice = await vscode.window.showWarningMessage(
      `Discard ${label}? This cannot be undone.`,
      { modal: true },
      "Discard Changes",
    );
    if (choice !== "Discard Changes") {
      return;
    }
    for (const [repoRoot, repoFiles] of filesByRoot(files)) {
      await this.diff.discard(
        repoRoot,
        repoFiles.map((f) => ({ path: f.path, untracked: f.status === "U" })),
      );
      await this.refresh();
      await this.reconcileOpenDiffsAfterWrite(
        repoRoot,
        repoFiles.map((f) => f.path),
      );
    }
  }

  /**
   * Rename — or, with a `/` in the typed text, move — the file behind a Changed Files row, the way
   * the explorer's F2 does. The move goes through a WorkspaceEdit rather than the filesystem so VS
   * Code runs its file-operation participants: undo keeps working, open editors follow the file, and
   * a language server can update the imports that name it.
   */
  async renameFile(file?: RepoChangedFile): Promise<void> {
    // A deleted file is not on disk, so there is nothing to rename.
    if (!file || file.status === "D") {
      return;
    }
    const { repoRoot } = file;
    const oldPath = file.path;
    const name = basename(oldPath);
    const stem = name.slice(0, name.length - extname(name).length);
    const typed = await vscode.window.showInputBox({
      title: `Rename ${name}`,
      value: name,
      // Pre-select the stem only, so typing replaces the name and keeps the extension.
      valueSelection: [0, stem.length],
      prompt: "Type a new name. A path with / moves the file.",
      validateInput: (value) => this.renameProblem(repoRoot, oldPath, value),
    });
    if (typed === undefined) {
      return;
    }
    const target = resolveRenameTarget(oldPath, typed);
    // An unchanged name is a cancel, and a rejected one already showed its message in the box.
    if (!target.ok || target.path === oldPath) {
      return;
    }
    const newPath = target.path;
    const oldUri = vscode.Uri.file(join(repoRoot, oldPath));
    const newUri = vscode.Uri.file(join(repoRoot, newPath));

    // A WorkspaceEdit cannot create a folder, so a move into a new one has to make it first.
    const parent = vscode.Uri.file(dirname(join(repoRoot, newPath)));
    try {
      await vscode.workspace.fs.stat(parent);
    } catch {
      await vscode.workspace.fs.createDirectory(parent);
    }

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(oldUri, newUri, { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage(`Could not rename ${name}.`);
      return;
    }
    this.debug(`rename: ${oldPath} -> ${newPath}`);
    this.repointComments(repoRoot, oldPath, newPath);
    // Nothing else rebuilds the groups: there is no file watcher here, and applyEdit fires no save.
    await this.refresh("rename");
    await this.moveOpenDiffsToRenamedFile(repoRoot, oldPath, newPath);
  }

  /** What is wrong with the text in the rename box, or nothing when it can be applied. */
  private async renameProblem(
    repoRoot: string,
    currentPath: string,
    value: string,
  ): Promise<string | undefined> {
    const target = resolveRenameTarget(currentPath, value);
    if (!target.ok) {
      return target.message;
    }
    if (target.path === currentPath) {
      return undefined;
    }
    const to = join(repoRoot, target.path);
    // A case-only rename on a case-insensitive filesystem finds the file itself, not a clash.
    if (join(repoRoot, currentPath).toLowerCase() === to.toLowerCase()) {
      return undefined;
    }
    try {
      await fs.access(to);
      return `A file called ${target.path} already exists.`;
    } catch {
      return undefined;
    }
  }

  /** Move review comments on the renamed file onto its new path, so their Feedback rows and their
   *  reveal still land on the file the user renamed. */
  private repointComments(repoRoot: string, oldPath: string, newPath: string): void {
    let moved = false;
    for (const { model } of this.comments.values()) {
      if (model.repoRoot === repoRoot && model.filePath === oldPath) {
        model.filePath = newPath;
        moved = true;
      }
    }
    if (moved) {
      this.changeEmitter.fire();
    }
  }

  /**
   * Re-point every open diff tab of the renamed file at its new path. Deliberately NOT
   * `reconcileOpenDiffsAfterWrite`: git reports the old path as an unstaged delete after a rename, so
   * that route would keep the tab showing the file's deletion.
   */
  private async moveOpenDiffsToRenamedFile(
    repoRoot: string,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    if (this.openDiffs.size === 0) {
      return;
    }
    // Snapshot so we can mutate openDiffs (delete re-pointed entries) while iterating.
    const snapshot = Array.from(this.openDiffs.entries());
    for (const [key, open] of snapshot) {
      if (open.repoRoot !== repoRoot || open.path !== oldPath) {
        continue;
      }
      const located = this.locateReviewTab(key);
      // Closing a tab with unsaved edits makes VS Code raise its own save dialog and can drop the
      // buffer, so that tab is left where it is.
      if (located?.dirty) {
        continue;
      }
      this.openDiffs.delete(key);
      if (this.openDiffFile?.repoRoot === repoRoot && this.openDiffFile.path === oldPath) {
        this.openDiffFile = undefined;
      }
      await closeTabsWhere((tab) => reviewTabKey(tab.input) === key);
      const file = this.allFiles(repoRoot).find((f) => f.path === newPath);
      if (file) {
        await this.openDiff(file, {
          viewColumn: located?.viewColumn,
          preserveFocus: !located?.active,
          preview: located?.preview ?? true,
          skipRefresh: true,
        });
      }
    }
  }

  private async stageAll(target: BulkTargetArg): Promise<void> {
    const changeset = this.guidedChangeset(target.changesetId);
    if (changeset) {
      await this.stageFiles(filesInGroup(changeset, "unstaged"));
      return;
    }
    const repo = await this.repositoryOrPick(target.repoRoot);
    if (repo) {
      await this.stageFiles(repo.changes.unstaged);
    }
  }

  private async unstageAll(target: BulkTargetArg): Promise<void> {
    const changeset = this.guidedChangeset(target.changesetId);
    if (changeset) {
      await this.unstageFiles(filesInGroup(changeset, "staged"));
      return;
    }
    const repo = await this.repositoryOrPick(target.repoRoot);
    if (repo) {
      await this.unstageFiles(repo.changes.staged);
    }
  }

  private async discardAll(target: BulkTargetArg): Promise<void> {
    const repo = await this.repositoryOrPick(target.repoRoot);
    if (repo) {
      await this.discardFiles(repo.changes.unstaged);
    }
  }

  /** The repository a command names, or the one the user picks when it names none. */
  private async repositoryOrPick(
    repoRoot: string | undefined,
  ): Promise<RepositoryReviewState | undefined> {
    if (repoRoot) {
      return this.repositoryStates.get(repoRoot);
    }
    const repositories = this.getState().repositories;
    if (repositories.length <= 1) {
      return repositories[0];
    }
    const choice = await vscode.window.showQuickPick(
      repositories.map((repo) => ({ label: repo.displayName, description: repo.repoRoot, repo })),
      { title: "Choose Repository" },
    );
    return choice?.repo;
  }

  /**
   * After a stage/unstage/discard, an open diff tab may now point at the wrong git layer. For each
   * affected path with an open diff: if its change is gone (discarded) close the tab; if it moved to a
   * different group (e.g. unstaged→staged), re-point the tab by closing it and reopening the diff at
   * its new location (preserving the column); if it's still present at the same level, leave it (the
   * refresh()'s content re-render already covers it). A file that already has a comment is left
   * untouched so we never yank a diff the user is reviewing.
   */
  private async reconcileOpenDiffsAfterWrite(
    repoRoot: string,
    paths: string[],
    preferredGroup?: FileGroup,
  ): Promise<void> {
    if (this.openDiffs.size === 0) {
      return;
    }
    const affected = new Set(paths);
    const order: FileGroup[] = ["committed", "staged", "unstaged"];
    // Snapshot so we can mutate openDiffs (delete re-pointed entries) while iterating.
    const snapshot = Array.from(this.openDiffs.entries());
    for (const [baseKey, open] of snapshot) {
      const { group: oldGroup, path: relPath } = open;
      if (
        open.repoRoot !== repoRoot ||
        !affected.has(relPath) ||
        this.hasCommentOnPath(repoRoot, relPath)
      ) {
        continue;
      }
      const changes = this.changesFor(repoRoot);
      if (!changes) {
        continue;
      }
      const candidates = order.filter((g) => changes[g].some((f) => f.path === relPath));
      const target = reconcileDiffTarget(oldGroup, candidates, preferredGroup);
      if (target === "keep") {
        continue; // still present at the same level — content refresh handles it
      }
      const located = this.locateReviewTab(baseKey);
      // Closing a tab with unsaved edits makes VS Code raise its own save dialog and can drop the
      // buffer. The working-tree side of the diff still shows live content where it is.
      if (located?.dirty) {
        continue;
      }
      this.openDiffs.delete(baseKey);
      if (
        this.openDiffFile?.repoRoot === repoRoot &&
        this.openDiffFile.path === relPath &&
        this.openDiffFile.group === oldGroup
      ) {
        this.openDiffFile = undefined;
      }
      await closeTabsWhere((tab) => reviewTabKey(tab.input) === baseKey);
      if (target === "close") {
        this.debug(`reconcile: ${relPath} gone — closed diff tab`);
        continue;
      }
      const file = changes[target].find((f) => f.path === relPath);
      if (file) {
        await this.openDiff(file, {
          baseComparison: {
            ref: DiffService.decodeRef(open.baseRef),
            label: open.baseLabel ?? comparisonLabel(DiffService.decodeRef(open.baseRef)),
          },
          viewColumn: located?.viewColumn,
          preserveFocus: !located?.active,
          preview: located?.preview ?? true,
          suppressActiveDiffEvent: true,
          skipRefresh: true,
        });
        this.debug(`reconcile: ${relPath} ${oldGroup} -> ${target}`);
      }
    }
  }

  /** The open review tab whose virtual URI matches `tabKey`: its column, active, preview and dirty state. */
  private locateReviewTab(
    tabKey: string,
  ):
    | { viewColumn: vscode.ViewColumn; active: boolean; preview: boolean; dirty: boolean }
    | undefined {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (reviewTabKey(tab.input) === tabKey) {
          return {
            viewColumn: group.viewColumn,
            active: tab.isActive,
            preview: tab.isPreview,
            dirty: tab.isDirty,
          };
        }
      }
    }
    return undefined;
  }

  /**
   * Editing the working-tree side of an editable staged/committed diff puts the change at the
   * unstaged level. Update only its tree location: the base URI and comparison remain unchanged, so
   * the tab, dirty buffer, caret, focus, and—most importantly—the user's chosen baseline are stable.
   */
  private maybeMarkAsUnstaged(uri: vscode.Uri): void {
    const open = this.openDiffFile;
    if (uri.scheme !== "file" || !open || open.group === "unstaged") {
      return;
    }
    if (join(open.repoRoot, open.path) !== uri.fsPath) {
      return; // not the file shown in the tracked diff
    }
    // Only act when the edit is in OUR active higher-level diff (base = paireto-review, right = the file),
    // never a plain editor on the same path.
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const isOurDiff =
      input instanceof vscode.TabInputTextDiff &&
      input.original.scheme === Schemes.review &&
      input.modified.scheme === "file" &&
      input.modified.fsPath === uri.fsPath;
    if (!isOurDiff) {
      return;
    }
    const edited = markOpenDiffEdited(open);
    this.openDiffFile = edited; // flip synchronously: no re-entry
    this.openDiffs.set(input.original.toString(), edited);
    this.activeDiffEmitter.fire({ repoRoot: open.repoRoot, group: "unstaged", path: open.path });
    this.debug(
      `edit: ${open.path} ${open.group} -> unstaged; comparison remains ${open.baseLabel ?? open.baseRef}`,
    );
  }

  /** The active editor changed — if it's one of our diff tabs, re-select that file's tree row.
   *  Honours VS Code's `explorer.autoReveal`: when disabled, focusing a diff tab no longer pulls the
   *  Paireto sidebar forward or moves the tree selection. */
  private syncSelectionToActiveTab(): void {
    this.syncActiveDiffContext();
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const key = reviewTabKey(input);
    const target = key ? this.openDiffs.get(key) : undefined;
    if (target) {
      this.openDiffFile = target;
    }
    if (target && getAutoRevealSetting()) {
      this.activeDiffEmitter.fire(target);
    }
  }

  /** Drives the Compare To editor-title action, including editable diffs whose right side is file:. */
  private syncActiveDiffContext(): void {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const key = reviewTabKey(input);
    const active = key !== undefined && this.openDiffs.has(key);
    void vscode.commands.executeCommand("setContext", ContextKeys.reviewDiffActive, active);
  }

  /** Forget diffs whose tabs have closed (keeps the openDiffs map from growing unbounded). */
  private pruneClosedDiffs(): void {
    if (this.openDiffs.size === 0) {
      return;
    }
    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const key = reviewTabKey(tab.input);
        if (key) {
          open.add(key);
        }
      }
    }
    for (const key of this.openDiffs.keys()) {
      if (!open.has(key)) {
        this.openDiffs.delete(key);
      }
    }
  }

  private async openFile(file?: RepoChangedFile): Promise<void> {
    if (!file) {
      return;
    }
    const uri = vscode.Uri.file(join(file.repoRoot, file.path));
    // A diff tab showing this file as its modified side satisfies vscode.open's "already open"
    // check without ever showing the plain file — close any such tab first (in any group) so Open
    // File always does something. If the plain file is already open elsewhere, vscode.open switches
    // to it as normal.
    await closeTabsWhere(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.toString() === uri.toString(),
    );
    // `vscode.open` (not showTextDocument) lets VS Code pick the editor for the file type — image
    // preview, etc. — instead of forcing a text editor, matching the native git panel's "Open File".
    await vscode.commands.executeCommand("vscode.open", uri);
  }

  private async openDiff(
    requestedFile: RepoChangedFile,
    show?: {
      viewColumn?: vscode.ViewColumn;
      preserveFocus?: boolean;
      /** Explicit tab-local base. Omitted when opening from the tree, which uses the row's default. */
      baseComparison?: { ref: ContentRef; label: string };
      /** Preserve an edited tree location that is not on disk yet because the file is dirty. */
      trackedGroup?: FileGroup;
      /** Internal: a caller that has just refreshed can avoid repeating the git scan. */
      skipRefresh?: boolean;
      /** Tab preview state. Defaults to true (recycled, like explorer/native-git-panel opens); the
       *  re-point callers pass the prior tab's state so a kept tab never comes back as a preview —
       *  reopening two kept diffs as previews would collapse them into one recycled tab. */
      preview?: boolean;
      /** Set when silently re-pointing an already-open tab after a git write (stage/unstage/
       *  discard) — that's not a user-driven focus change, so don't reveal/select its tree row. */
      suppressActiveDiffEvent?: boolean;
    },
  ): Promise<OpenedReviewFile | undefined> {
    const repoRoot = requestedFile.repoRoot;
    // Opening is a synchronization boundary, but a SCOPED one: re-check just this file against git
    // (never the full multi-root getChanges scan or a refreshAllOpen() re-fire of every open review
    // URI — that made opening laggy in large projects), then, below, invalidate the exact URIs that
    // are about to open; the provider may still cache a URI from a previously closed tab.
    if (!show?.skipRefresh) {
      await syncFileForOpenDiff(this.openDiffSync, repoRoot, requestedFile);
    }
    const changes = this.changesFor(repoRoot);
    if (!changes) {
      return;
    }
    const refreshedFile =
      changes[requestedFile.group].find((f) => f.path === requestedFile.path) ??
      this.allFiles(repoRoot).find((f) => f.path === requestedFile.path);
    if (!refreshedFile) {
      this.debug(`openDiff: ${requestedFile.path} disappeared during refresh`);
      return;
    }
    const file = show?.trackedGroup
      ? { ...refreshedFile, group: show.trackedGroup }
      : refreshedFile;
    if (!show?.suppressActiveDiffEvent) {
      this.activeDiffEmitter.fire({ repoRoot, group: file.group, path: file.path });
    }

    const naturalSides = this.diff.fileSides(file, changes.compareRef);
    const sides = show?.baseComparison
      ? withBaseComparison(naturalSides, show.baseComparison.ref)
      : naturalSides;
    const baseRef = DiffService.encodeRef(sides.base);
    const baseLabel =
      show?.baseComparison?.label ??
      (file.group === "committed" && baseRef === changes.compareRef
        ? changes.compareLabel
        : comparisonLabel(sides.base));
    const open: OpenDiffState = {
      repoRoot,
      path: file.path,
      group: file.group,
      baseRef,
      baseLabel,
    };
    this.openDiffFile = open;
    const baseUri = ReviewPath.create({
      reviewId: this.reviewId,
      side: "base",
      relPath: file.path,
      ref: baseRef,
      repoRoot,
    }).toUri();
    // When editable, the modified side is the real working-tree file: it gets LSP + editing, and
    // edits land in the lowest (unstaged) level. Otherwise it's a read-only virtual document (the
    // paireto-review FileSystemProvider is registered read-only, so it genuinely can't be typed into).
    const editable = this.isEditable(file);
    this.debug(`openDiff: ${file.path} group=${file.group} editable=${editable}`);
    const modUri = editable
      ? vscode.Uri.file(join(repoRoot, file.path))
      : ReviewPath.create({
          reviewId: this.reviewId,
          side: "modified",
          relPath: file.path,
          ref: DiffService.encodeRef(sides.modified),
          repoRoot,
        }).toUri();

    // Invalidate the exact documents before VS Code asks for them. refreshAllOpen() cannot clear a
    // cached URI left behind by a closed tab, which was the source of stale content on first open.
    this.reviewContent.refresh(baseUri);
    if (modUri.scheme === Schemes.review) {
      this.reviewContent.refresh(modUri);
    }

    // State the pinned baseline in the title so comparison changes are explicit and predictable.
    // Use just the filename (not the whole relative path) so the tab label stays short.
    const name = basename(file.path);
    const modifiedLabel = editable ? "Working Tree" : GROUP_LABEL[file.group];
    const title = `${name} (${modifiedLabel} vs ${baseLabel})`;

    // An add (no base) or delete (no modified) has nothing to diff against — a two-pane diff would
    // show a broken/empty side (an image viewer can't render the 0-byte side at all). Open the one
    // real side in a single editor, like the native git panel. The doc is still commentable: the
    // working-tree file: side and the paireto-review virtual side both match the comment controller.
    const singleSide = singlePaneSide(sides);
    if (singleSide) {
      const paneUri = singleSide === "base" ? baseUri : modUri;
      if (paneUri.scheme === Schemes.review) {
        this.openDiffs.set(paneUri.toString(), open);
      }
      await vscode.commands.executeCommand("vscode.open", paneUri, {
        preview: show?.preview ?? true,
        viewColumn: show?.viewColumn,
        preserveFocus: show?.preserveFocus,
      });
      this.syncActiveDiffContext();
      void ensureCommentingVisible();
      return { baseUri, modifiedUri: modUri, visibleUris: [paneUri] };
    }

    // Remember which row this tab represents, so switching back to it re-selects the right row.
    this.openDiffs.set(baseUri.toString(), open);

    if (editable && (await isTextFile(join(repoRoot, file.path)))) {
      // Open the real working-tree file as a normal document first so the TypeScript server attaches
      // it to the workspace's configured project. Opening it only as a diff's modified side can leave
      // it in an inferred single-file project, so imported types resolve to `any`. Skipped for binary
      // files (images, etc.) — pre-opening them as text would force a text model and defeat VS Code's
      // image diff.
      await vscode.workspace.openTextDocument(modUri);
    }
    // Preview (recycled by the next open) like the explorer and the native git panel — safe for
    // editable diffs too, because VS Code pins a preview tab the moment its document goes dirty.
    await vscode.commands.executeCommand("vscode.diff", baseUri, modUri, title, {
      preview: show?.preview ?? true,
      viewColumn: show?.viewColumn,
      preserveFocus: show?.preserveFocus,
    });
    this.syncActiveDiffContext();
    void ensureCommentingVisible();
    return { baseUri, modifiedUri: modUri, visibleUris: [baseUri, modUri] };
  }

  /**
   * A file is editable iff it has no change at a lower level (committed > staged > unstaged) and isn't
   * deleted — so editing its working-tree copy is unambiguous and lands in the unstaged level. This is
   * purely structural: it does NOT depend on whether a review is active (commenting works in both the
   * editable and the locked case, so a review never forces a diff read-only).
   */
  private isEditable(file: RepoChangedFile): boolean {
    const changes = this.changesFor(file.repoRoot);
    return changes ? isFileEditable(file, changes) : false;
  }

  /** True if a `file:` doc is one of the repo's changed files (so its diff is commentable). */
  private isChangedFileDoc(uri: vscode.Uri): boolean {
    const root = this.roots.gitRootForPath(uri.fsPath);
    if (!root) {
      return false;
    }
    const rel = repoRelativePath(root.repoRoot, uri.fsPath);
    return this.allFiles(root.repoRoot).some((f) => f.path === rel);
  }

  private async addComment(reply: vscode.CommentReply, kind: CommentKind): Promise<void> {
    const uri = reply.thread.uri;
    const changesetId = changesetIdFromDocUri(uri);
    if (changesetId !== undefined) {
      await this.addChangesetComment(reply, kind, changesetId);
      return;
    }
    // Comments anchor on the review-scheme side of a locked diff OR the editable working-tree (file:)
    // side of an editable one (its modified side is the live file).
    const anchor = this.resolveCommentAnchor(uri);
    if (!anchor) {
      return;
    }
    const { repoRoot, side, relPath } = anchor;
    const line = reply.thread.range?.start.line ?? 0;
    const open = this.openStateForCommentUri(uri, repoRoot, relPath);

    const doc = await vscode.workspace.openTextDocument(uri);
    const quote = line < doc.lineCount ? doc.lineAt(line).text : "";
    const anchorLines = (start: number, end: number): string[] => {
      const out: string[] = [];
      for (let i = Math.max(0, start); i < Math.min(doc.lineCount, end); i++) {
        out.push(doc.lineAt(i).text);
      }
      return out;
    };

    const model: ReviewComment = {
      id: crypto.randomUUID(),
      repoRoot,
      filePath: relPath,
      side,
      line,
      kind,
      body: reply.text,
      quote,
      anchor: {
        lineText: quote,
        contextBefore: anchorLines(line - 2, line),
        contextAfter: anchorLines(line + 1, line + 3),
        lineHash: crypto.createHash("sha1").update(quote).digest("hex"),
      },
      attachment: open
        ? {
            group: open.group,
            baseRef: open.baseRef,
            baseLabel: open.baseLabel,
            sourceUri: uri.toString(),
          }
        : undefined,
    };
    let comment: GateComment;
    comment = this.commentSession.add(reply, kind, {
      id: model.id,
      onSaved: (newBody) => {
        model.body = newBody;
        this.changeEmitter.fire();
      },
      onDeleted: () => {
        this.comments.delete(model.id);
        const thread = comment.thread;
        if (thread?.comments.length === 0) {
          this.commentSession.forget(thread);
        }
        this.changeEmitter.fire();
      },
    });
    reply.thread.label = this.commentLocationLabel(repoRoot, relPath, line);
    this.comments.set(model.id, { comment, model });
    // Comments accumulate in this bucket whether or not a review is in progress; a review (started by
    // /paireto-review or the turn-end gate) consumes whatever is in it. The Feedback section reveals
    // itself once the bucket is non-empty. Editability is unaffected.
    this.changeEmitter.fire();
  }

  /**
   * A comment on a changeset's description: feedback about how the agent grouped the work, not about
   * a line of code. It joins the same bucket as file comments so one Send Feedback delivers both,
   * and carries the changeset instead of a file path — the feedback renderer keys off that.
   */
  private async addChangesetComment(
    reply: vscode.CommentReply,
    kind: CommentKind,
    changesetId: string,
  ): Promise<void> {
    const guided = this.getState().guided;
    const changeset = guided?.changesets.find((c) => c.id === changesetId);
    if (!guided || !changeset) {
      return;
    }
    const line = reply.thread.range?.start.line ?? 0;
    const doc = await vscode.workspace.openTextDocument(reply.thread.uri);
    const quote = line < doc.lineCount ? doc.lineAt(line).text : "";
    const model: ReviewComment = {
      id: crypto.randomUUID(),
      repoRoot: guided.repoRoot,
      filePath: "",
      changeset: { id: changeset.id, title: changeset.title },
      side: "modified",
      line,
      kind,
      body: reply.text,
      quote,
      anchor: {
        lineText: quote,
        contextBefore: [],
        contextAfter: [],
        lineHash: crypto.createHash("sha1").update(quote).digest("hex"),
      },
    };
    let comment: GateComment;
    comment = this.commentSession.add(reply, kind, {
      id: model.id,
      onSaved: (newBody) => {
        model.body = newBody;
        this.changeEmitter.fire();
      },
      onDeleted: () => {
        this.comments.delete(model.id);
        const thread = comment.thread;
        if (thread?.comments.length === 0) {
          this.commentSession.forget(thread);
        }
        this.changeEmitter.fire();
      },
    });
    reply.thread.label = `Changeset: ${changeset.title}`;
    this.comments.set(model.id, { comment, model });
    this.changeEmitter.fire();
  }

  /**
   * Map a comment thread's URI to (side, relPath). The thread sits on either a `paireto-review://`
   * diff side (side + path in the query) or the editable working-tree file (its modified side).
   */
  private resolveCommentAnchor(
    uri: vscode.Uri,
  ): { repoRoot: string; side: "base" | "modified"; relPath: string } | undefined {
    if (uri.scheme === Schemes.review) {
      const { repoRoot, side, relPath } = ReviewPath.fromUri(uri);
      if (!repoRoot) {
        return undefined;
      }
      return { repoRoot, side, relPath };
    }
    const root = uri.scheme === "file" ? this.roots.gitRootForPath(uri.fsPath) : undefined;
    if (root) {
      return {
        repoRoot: root.repoRoot,
        side: "modified",
        relPath: repoRelativePath(root.repoRoot, uri.fsPath),
      };
    }
    return undefined;
  }

  /** Resolve the exact open-tab state that produced a comment, especially for partially staged files. */
  private openStateForCommentUri(
    uri: vscode.Uri,
    repoRoot: string,
    relPath: string,
  ): OpenDiffState | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (
      input instanceof vscode.TabInputTextDiff &&
      (input.original.toString() === uri.toString() || input.modified.toString() === uri.toString())
    ) {
      return this.openDiffs.get(input.original.toString());
    }
    if (input instanceof vscode.TabInputText && input.uri.toString() === uri.toString()) {
      const tracked = this.openDiffs.get(input.uri.toString());
      if (tracked) {
        return tracked;
      }
    }
    // A plain changed-file editor is also commentable. Derive its natural Working Tree attachment
    // instead of borrowing whichever diff happened to be focused previously.
    const changes = this.changesFor(repoRoot);
    if (!changes) {
      return undefined;
    }
    const file = selectCommentFile(
      changes,
      relPath,
      uri.scheme === "file" ? "unstaged" : undefined,
    );
    if (!file) {
      return undefined;
    }
    const base = this.diff.fileSides(file, changes.compareRef).base;
    return {
      repoRoot,
      path: file.path,
      group: file.group,
      baseRef: DiffService.encodeRef(base),
      baseLabel: file.group === "committed" ? changes.compareLabel : comparisonLabel(base),
    };
  }

  /** Reveal a feedback row's line in its diff and expand the comment thread. */
  private async revealComment(id: string): Promise<void> {
    const entry = this.comments.get(id);
    if (!entry?.comment.thread) {
      return;
    }
    const c = entry.model;

    await this.refresh("reveal-comment");
    const changes = this.changesFor(c.repoRoot);
    const file = (
      changes ? selectCommentFile(changes, c.filePath, c.attachment?.group) : undefined
    ) as RepoChangedFile | undefined;
    let targetUri: vscode.Uri | undefined;
    let revealSurface: "review" | "fallback" = "fallback";
    let migratedAttachment:
      | { file: RepoChangedFile; baseRef: string; baseLabel?: string }
      | undefined;
    if (file) {
      const baseRef = c.attachment?.baseRef;
      const opened = await this.openDiff(file, {
        baseComparison: baseRef
          ? {
              ref: DiffService.decodeRef(baseRef),
              label: c.attachment?.baseLabel ?? comparisonLabel(DiffService.decodeRef(baseRef)),
            }
          : undefined,
        skipRefresh: true,
      });
      if (opened) {
        revealSurface = "review";
        const requested = c.side === "base" ? opened.baseUri : opened.modifiedUri;
        targetUri = opened.visibleUris.some((uri) => uri.toString() === requested.toString())
          ? requested
          : opened.visibleUris[0];
        const naturalBase = this.diff.fileSides(file, changes!.compareRef).base;
        migratedAttachment = {
          file,
          baseRef: baseRef ?? DiffService.encodeRef(naturalBase),
          baseLabel: c.attachment?.baseLabel ?? comparisonLabel(naturalBase),
        };
      }
    }
    targetUri ??= await this.fallbackCommentUri(c, entry.comment.thread.uri);
    if (!targetUri) {
      return; // original live thread remains untouched
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(targetUri);
    } catch {
      return; // never dispose/repoint the original thread unless its replacement can be opened
    }
    const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
    const line = relocateReviewAnchor(lines, c.line, c.anchor);
    const lineText = line < doc.lineCount ? doc.lineAt(line).text : "";
    const range = new vscode.Range(line, 0, line, lineText.length);
    const attachedPath = migratedAttachment?.file.path ?? c.filePath;
    const label = c.changeset
      ? `Changeset: ${c.changeset.title}`
      : this.commentLocationLabel(c.repoRoot, attachedPath, line);
    const thread = this.commentSession.reattach(entry.comment, targetUri, range, label);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    c.line = line;
    if (migratedAttachment) {
      // Only commit metadata after the replacement thread exists, so failed migrations are harmless.
      c.filePath = migratedAttachment.file.path;
      c.attachment = {
        group: migratedAttachment.file.group,
        baseRef: migratedAttachment.baseRef,
        baseLabel: migratedAttachment.baseLabel,
        sourceUri: targetUri.toString(),
      };
    } else if (c.attachment) {
      c.attachment.sourceUri = targetUri.toString();
    }

    // openDiff already opened the target inside its diff/single review surface. Opening that side URI
    // again would make VS Code materialize a duplicate plain-file tab.
    if (shouldOpenStandaloneCommentTarget(revealSurface)) {
      await vscode.commands.executeCommand("vscode.open", targetUri, { preview: false });
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.toString() === targetUri.toString()) {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    void ensureCommentingVisible();
  }

  /** Best-effort home when the file no longer appears in any Changes group. */
  private async fallbackCommentUri(
    c: ReviewComment,
    currentThreadUri: vscode.Uri,
  ): Promise<vscode.Uri | undefined> {
    const candidates: vscode.Uri[] = [];
    // A changeset comment has no file path, so the working-tree candidate would be the repository
    // root directory — its thread URI (the description document) is the only home it has.
    if (c.side === "modified" && c.filePath) {
      candidates.push(vscode.Uri.file(join(c.repoRoot, c.filePath)));
    }
    if (c.attachment?.sourceUri) {
      candidates.push(vscode.Uri.parse(c.attachment.sourceUri));
    }
    candidates.push(currentThreadUri);
    const historicalBase = ReviewPath.create({
      reviewId: this.reviewId,
      side: "base",
      relPath: c.filePath,
      ref:
        c.attachment?.baseRef && c.attachment.baseRef !== "EMPTY" ? c.attachment.baseRef : "HEAD",
      repoRoot: c.repoRoot,
    }).toUri();
    candidates.push(historicalBase);

    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = candidate.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      try {
        await vscode.workspace.openTextDocument(candidate);
        return candidate;
      } catch {
        // Try the next durable representation; the original thread has not been changed.
      }
    }
    return undefined;
  }

  /** Delete a comment from the Feedback tree row (its in-diff thread also drops it). */
  private deleteComment(id: string): void {
    const entry = this.comments.get(id);
    if (!entry) {
      return;
    }
    const thread = entry.comment.thread;
    if (thread) {
      thread.comments = thread.comments.filter((x) => x !== entry.comment);
      if (thread.comments.length === 0) {
        thread.dispose();
        this.commentSession.forget(thread);
      }
    }
    this.comments.delete(id);
    this.changeEmitter.fire();
  }

  // ── Guided review ───────────────────────────────────────────────────────────
  /** The live row a guided command names, looked up in the plan as it stands now. */
  private guidedRow(named: GuidedRowArg): GuidedFileRow | undefined {
    return this.getState()
      .guided?.changesets.find((c) => c.id === named.changesetId)
      ?.files.find((row) => row.path === named.path);
  }

  private openPlannedFile(named: GuidedRowArg): void {
    const file = this.guidedRow(named)?.file;
    if (!file) {
      return; // A path with no live change has nothing to open — the row already says so.
    }
    const changes = this.changesFor(file.repoRoot);
    void this.openDiff(file, {
      baseComparison: changes
        ? plannedBaseComparison(this.diff.fileSides(file, changes.compareRef), changes)
        : undefined,
    });
  }

  /** The changeset an id names, resolved against the live plan. */
  private guidedChangeset(id: string | undefined): GuidedChangesetState | undefined {
    return id === undefined
      ? undefined
      : this.getState().guided?.changesets.find((c) => c.id === id);
  }

  /** Open a changeset's description as a read-only markdown tab, so the reviewer can read what the
   *  group is for and comment on the grouping itself rather than on a line of code. */
  private async guidedReviewOpenChangeset(id: string): Promise<void> {
    const changeset = this.guidedChangeset(id);
    if (!changeset) {
      return;
    }
    await this.showGuidedDoc(changesetDocUri(changeset), renderChangesetDoc(changeset));
  }

  /** Open the plan's overview, so the agent's summary of the branch can be read in full rather than
   *  only as the section row's tooltip. */
  private async guidedReviewOpenPlan(): Promise<void> {
    const guided = this.getState().guided;
    if (!guided) {
      return;
    }
    await this.showGuidedDoc(
      changesetDocUri({ id: PLAN_DOC_ID, title: "Review plan" }),
      renderPlanDoc(guided),
    );
  }

  private async showGuidedDoc(uri: vscode.Uri, markdown: string): Promise<void> {
    this.changesetDocs.set(uri, markdown);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "markdown");
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Read-only guided snapshot for the env-gated E2E inspect seam. Nothing else reads it. */
  guidedSnapshot(): GuidedReviewState | undefined {
    return this.getState().guided;
  }

  getComments(): ReviewComment[] {
    return [...this.comments.values()].map((e) => e.model);
  }

  /** True when the user has left review comments (the bucket), whether or not a review is in progress. */
  hasComments(): boolean {
    return this.comments.size > 0;
  }

  // ── GateSession (shared Approve / Send-Feedback commands dispatch here while active) ──
  /** Approve: proceed with no changes (the agent continues, no feedback). */
  approve(): void {
    if (this.activeRequestId) {
      log.info(`review approved for agent ${this.activeSessionId?.slice(0, 8) ?? "unknown"}`);
      this.gate.fulfill(this.activeRequestId, { status: "cancelled", feedback: "" });
    }
  }

  sendFeedback(): void {
    if (!this.activeRequestId) {
      return;
    }
    const comments = this.getComments();
    const feedback = renderReviewFeedback(comments, this.isMultiRepository());
    if (!feedback) {
      void vscode.window.showWarningMessage(
        "No comments to send. Add a comment, or Approve to proceed with no changes.",
      );
      return;
    }
    log.info(
      `review feedback sent for agent ${this.activeSessionId?.slice(0, 8) ?? "unknown"}: ${comments.length} comment(s)`,
    );
    this.gate.fulfill(this.activeRequestId, { status: "submitted", feedback });
  }

  /** True when there's ≥1 comment to send (drives which gate button shows). */
  hasFeedback(): boolean {
    return renderReviewFeedback(this.getComments(), this.isMultiRepository()).length > 0;
  }

  /** True when comment file paths need their repo root prefixed to stay unambiguous. */
  isMultiRepository(): boolean {
    return this.roots.gitRoots.length > 1;
  }

  /** True if any comment is anchored on this file (so reconcile won't yank the diff out from it). */
  private hasCommentOnPath(repoRoot: string, relPath: string): boolean {
    return [...this.comments.values()].some(
      (e) => e.model.repoRoot === repoRoot && e.model.filePath === relPath,
    );
  }

  /** Empties the comment bucket once its comments are delivered, so they cannot be sent twice. */
  clearComments(): void {
    this.commentSession.reset();
    this.comments.clear();
    this.changeEmitter.fire();
  }

  private changesFor(repoRoot: string): RepositoryChangesModel | undefined {
    return this.repositoryStates.get(repoRoot)?.changes;
  }

  private allFiles(repoRoot: string): RepoChangedFile[] {
    const changes = this.changesFor(repoRoot);
    return changes ? [...changes.staged, ...changes.unstaged, ...changes.committed] : [];
  }

  private commentLocationLabel(repoRoot: string, relPath: string, zeroBasedLine: number): string {
    const repo = this.repositoryStates.get(repoRoot);
    const prefix = this.repositoryStates.size > 1 && repo ? `${repo.displayName}/` : "";
    return `${prefix}${relPath}:${zeroBasedLine + 1}`;
  }

  dispose(): void {
    this.drainGate();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** A changeset's live files sitting in one git layer — what its bulk Stage/Unstage acts on. */
function filesInGroup(changeset: GuidedChangesetState, group: FileGroup): RepoChangedFile[] {
  return changeset.files.flatMap((row) => (row.file?.group === group ? [row.file] : []));
}

function filesByRoot(files: RepoChangedFile[]): Map<string, RepoChangedFile[]> {
  const grouped = new Map<string, RepoChangedFile[]>();
  for (const file of files) {
    const list = grouped.get(file.repoRoot);
    if (list) {
      list.push(file);
    } else {
      grouped.set(file.repoRoot, [file]);
    }
  }
  return grouped;
}

function scopedChanges(repoRoot: string, changes: ChangesModel): RepositoryChangesModel {
  const scope = (files: ChangedFile[]): RepoChangedFile[] =>
    files.map((file) => ({ ...file, repoRoot }));
  return {
    staged: scope(changes.staged),
    unstaged: scope(changes.unstaged),
    committed: scope(changes.committed),
    compareLabel: changes.compareLabel,
    compareRef: changes.compareRef,
  };
}

function newReviewId(): string {
  return "review-" + crypto.randomBytes(4).toString("hex");
}

/** The scheme of a plain-text tab, so tabs belonging to one of our virtual schemes can be closed. */
function tabUriScheme(input: unknown): string | undefined {
  return input instanceof vscode.TabInputText ? input.uri.scheme : undefined;
}

/** Stable virtual URI used to identify either a two-pane review diff or a single virtual pane. */
function reviewTabKey(input: unknown): string | undefined {
  if (input instanceof vscode.TabInputTextDiff && input.original.scheme === Schemes.review) {
    return input.original.toString();
  }
  if (input instanceof vscode.TabInputText && input.uri.scheme === Schemes.review) {
    return input.uri.toString();
  }
  return undefined;
}

/** Short user-facing label for a content reference used as a diff baseline. */
function comparisonLabel(ref: ContentRef): string {
  switch (ref.kind) {
    case "empty":
      return "Empty";
    case "working":
      return "Working Tree";
    case "index":
      return "Index";
    case "ref":
      return ref.ref;
  }
}

/**
 * Find the current incarnation of a commented file. Its attachment group wins when the path appears
 * in multiple layers; otherwise prefer the newest available content and follow Git rename metadata.
 */
export function selectCommentFile(
  changes: ChangesModel,
  filePath: string,
  preferredGroup?: FileGroup,
): ChangedFile | undefined {
  const order: FileGroup[] = preferredGroup
    ? [
        preferredGroup,
        ...(["unstaged", "staged", "committed"] as FileGroup[]).filter(
          (group) => group !== preferredGroup,
        ),
      ]
    : ["unstaged", "staged", "committed"];
  for (const group of order) {
    const file = changes[group].find((candidate) =>
      [candidate.path, candidate.oldPath].includes(filePath),
    );
    if (file) {
      return file;
    }
  }
  return undefined;
}

/**
 * Whether the window's shared Compare To can hold this comparison point. A raw ref cannot be shared
 * once several Git roots are open — it need not name anything in the others — so the window falls
 * back to the default branch there.
 */
export function sharedCompareToHolds(rootCount: number, compareTo: CompareTo): boolean {
  return rootCount <= 1 || compareTo.kind !== "ref";
}

/**
 * The comparison point one repository is scanned against: the open plan's own comparison for the
 * repository it describes, otherwise the window's shared Compare To. The two only differ while a
 * guided review is open in a window holding more than one Git root, where the shared Compare To
 * cannot carry a raw ref.
 */
export function compareToForRepo(
  shared: CompareTo,
  guided: { repoRoot: string; compareTo: CompareTo } | undefined,
  repoRoot: string,
): CompareTo {
  return guided?.repoRoot === repoRoot ? guided.compareTo : shared;
}

/**
 * The base a planned row opens against: the plan's comparison point, so a file that is partly staged
 * — or committed and then edited — shows every layer of its change rather than only the topmost one
 * its natural sides would compare. An add or a delete has content on one side only, so it keeps its
 * natural single pane and returns nothing to pin.
 */
export function plannedBaseComparison(
  natural: FileSides,
  changes: { compareRef: string | null; compareLabel: string },
): { ref: ContentRef; label: string } | undefined {
  if (singlePaneSide(natural) !== null) {
    return undefined;
  }
  return {
    ref: { kind: "ref", ref: changes.compareRef ?? "HEAD" },
    label: changes.compareRef ? changes.compareLabel : "HEAD",
  };
}

/** Only historical/current-file fallbacks need an editor open; review targets are already visible. */
export function shouldOpenStandaloneCommentTarget(surface: "review" | "fallback"): boolean {
  return surface === "fallback";
}

/** What `syncFileForOpenDiff` needs from the controller — injectable so tests can prove openDiff
 *  never runs the full multi-root scan. */
export interface OpenDiffSync {
  changesForPath(
    repoRoot: string,
    relPaths: string[],
    compareRef: string | null,
  ): Promise<ChangedFile[]>;
  getRepository(repoRoot: string): RepositoryReviewState | undefined;
  setRepository(state: RepositoryReviewState): void;
  /** The repo's refresh() sequence (bumped synchronously at every refresh() start) — read around
   *  the scoped git call to detect a competing refresh starting mid-flight. */
  getRefreshSeq(repoRoot: string): number;
  fullRefresh(reason: "open-diff" | "open-diff-superseded"): Promise<void>;
  fireChange(): void;
}

/**
 * openDiff's scoped sync: re-check ONE file against git and merge the result into that repo's
 * in-memory model, so a file that moved layers or disappeared since the tree rendered is still
 * handled — without the full refresh (getChanges + currentBranch per root + refreshAllOpen), which
 * made opening a diff laggy in large projects. Falls back to the full refresh only when the repo has
 * no model yet, or when a competing refresh() started mid-sync (the rare race; a complete model is
 * the only safe answer then); a failed git check keeps the last-good model, like refresh().
 */
export async function syncFileForOpenDiff(
  deps: OpenDiffSync,
  repoRoot: string,
  file: { path: string; oldPath?: string },
): Promise<void> {
  const snapshot = deps.getRepository(repoRoot);
  if (!snapshot) {
    await deps.fullRefresh("open-diff");
    return;
  }
  const seq = deps.getRefreshSeq(repoRoot);
  const relPaths = file.oldPath ? [file.path, file.oldPath] : [file.path];
  let fresh: ChangedFile[];
  try {
    fresh = await deps.changesForPath(repoRoot, relPaths, snapshot.changes.compareRef);
  } catch {
    return;
  }
  if (deps.getRefreshSeq(repoRoot) !== seq) {
    // A refresh() STARTED while the scoped git call was in flight: its data is at least as fresh
    // and it may still be running, so a scoped write now could fight it — and openDiff still needs
    // this file present in the model, so bailing silently isn't an option either. Defer to one
    // complete refresh. (The sync never claims the seq itself: superseding a complete in-flight
    // refresh would discard its whole model with nothing re-delivering the other paths' updates.)
    await deps.fullRefresh("open-diff-superseded");
    return;
  }
  // Merge into the LIVE model, never the pre-await snapshot — a refresh() already in flight when
  // this sync began may have landed during the git call, and writing the snapshot back would
  // silently revert every other path it updated.
  const state = deps.getRepository(repoRoot);
  if (!state) {
    return;
  }
  if (state.changes.compareRef !== snapshot.changes.compareRef) {
    // A refresh() already in flight when this sync began (its seq bump predates the read above)
    // landed a model with a DIFFERENT compare ref: the scoped result was computed against the old
    // one, so merging it would inject a stale committed entry into (or drop a legitimate one from)
    // the new model. Defer to one complete refresh, like the superseded path.
    await deps.fullRefresh("open-diff-superseded");
    return;
  }
  const merged = mergeChangesForPath(state.changes, repoRoot, relPaths, fresh);
  if (merged.changed) {
    deps.setRepository({ ...state, changes: merged.changes });
    deps.fireChange();
  }
}

/** Replace one path's entries in a repo model with a scoped git result, leaving the rest alone. */
function mergeChangesForPath(
  changes: RepositoryChangesModel,
  repoRoot: string,
  relPaths: string[],
  fresh: ChangedFile[],
): { changes: RepositoryChangesModel; changed: boolean } {
  // Affected = the queried paths plus every path the scoped result touches, INCLUDING a rename's
  // old path — and stale entries match by their old path too, so a rename entry keyed by its new
  // path is still replaced when queried by the old one. The scoped scan widens its own path set
  // across rename pairs to a fixpoint, so it is always a superset of `affected` — anything dropped
  // here that still exists in git comes back via `fresh`.
  const affected = new Set(relPaths);
  for (const f of fresh) {
    affected.add(f.path);
    if (f.oldPath !== undefined) {
      affected.add(f.oldPath);
    }
  }
  const touches = (f: ChangedFile): boolean =>
    affected.has(f.path) || (f.oldPath !== undefined && affected.has(f.oldPath));
  const next = { ...changes };
  let changed = false;
  for (const group of ["staged", "unstaged", "committed"] as FileGroup[]) {
    const kept = changes[group].filter((f) => !touches(f));
    const replacement = fresh.filter((f) => f.group === group).map((f) => ({ ...f, repoRoot }));
    const merged = [...kept, ...replacement].sort((a, b) => a.path.localeCompare(b.path));
    if (!groupEqual(changes[group], merged)) {
      next[group] = merged;
      changed = true;
    }
  }
  return { changes: next, changed };
}

/**
 * Decide what to do with an open diff tab after a git write-op moved its file. `candidates` is the set
 * of groups that now contain the path (after refresh). Returns "keep" if it's still at the same level,
 * "close" if the change is gone entirely, otherwise the group to re-point the tab to (preferring the
 * write-op's destination group when the file landed in several).
 */
export function reconcileDiffTarget(
  oldGroup: FileGroup,
  candidates: FileGroup[],
  preferred?: FileGroup,
): "keep" | "close" | FileGroup {
  if (candidates.includes(oldGroup)) {
    return "keep";
  }
  if (candidates.length === 0) {
    return "close";
  }
  return preferred && candidates.includes(preferred) ? preferred : candidates[0];
}

/**
 * A file is editable iff it isn't deleted and has no change at a lower git layer (committed > staged >
 * unstaged) — editing its working-tree copy is then unambiguous and lands in the unstaged level.
 * Purely structural: independent of whether a review is active (a review never forces a diff
 * read-only; commenting works on both editable and locked diffs).
 */
export function isFileEditable(file: ChangedFile, changes: ChangesModel): boolean {
  if (file.status === "D") {
    return false;
  }
  return !LOWER_GROUPS[file.group].some((g) => changes[g].some((f) => f.path === file.path));
}

/**
 * Decide whether the turn-end gate should open a review. Pure/testable. Opens only when no review is
 * already in progress AND either this agent's turn edited files (the PostToolUse edit-tool hook sets
 * `changedThisTurn`) or the user has left review comments to deliver. A turn that changed nothing and
 * has no comments lets the agent stop immediately — we trust the per-turn hook signal, NOT the repo's
 * overall uncommitted state (which says nothing about whether *this* turn changed anything).
 */
export function shouldOpenTurnEndReview(opts: {
  reviewInProgress: boolean;
  changedThisTurn: boolean;
  hasComments: boolean;
  /** `paireto.review.mode === "automatic"`. When false, edits alone don't park — only comments do. */
  automatic: boolean;
}): boolean {
  return !opts.reviewInProgress && ((opts.automatic && opts.changedThisTurn) || opts.hasComments);
}

/**
 * Best-effort "is this a text file" check: a NUL byte in the first chunk means binary (the same
 * heuristic git uses). Used to decide whether to pre-open a file as a TextDocument. Fails open to
 * `true` if the file can't be read, so the text path (the common case) isn't skipped on a transient
 * error.
 */
async function isTextFile(absPath: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absPath, "r");
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return !buf.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    await handle?.close();
  }
}

/** Structural equality of the Changes model, so a no-op refresh doesn't re-render the tree. */
function changesEqual(a: ChangesModel, b: ChangesModel): boolean {
  return (
    a.compareRef === b.compareRef &&
    a.compareLabel === b.compareLabel &&
    groupEqual(a.staged, b.staged) &&
    groupEqual(a.unstaged, b.unstaged) &&
    groupEqual(a.committed, b.committed)
  );
}

function groupEqual(a: ChangedFile[], b: ChangedFile[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.path === y.path &&
      x.status === y.status &&
      x.additions === y.additions &&
      x.deletions === y.deletions
    );
  });
}
