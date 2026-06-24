// Orchestrates the Changes view + code-review session: tracks the grouped changes (Staged /
// Unstaged / Committed) for the current Compare-To point, opens diffs, runs git write-ops
// (stage/unstage/discard), hosts inline comments, and ships feedback to the waiting agent.

import * as crypto from "node:crypto";
import { basename, isAbsolute, join, relative } from "node:path";

import * as vscode from "vscode";

import type { ReviewGateResult, StopGateResult } from "../bridge/types.js";
import { CommentSession, type GateComment } from "../comments/CommentSession.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
import { GateCoordinator, type GateEntry } from "../gate/GateCoordinator.js";
import { closeTabsWhere } from "../gate/tabs.js";
import { DiffService, type ChangedFile, type ChangesModel } from "../git/DiffService.js";
import type { RepoService } from "../git/RepoService.js";
import type { ReviewStore } from "../storage/ReviewStore.js";
import type { CompareTo, FileGroup, FileLayout } from "../types.js";
import { filesInEntry, type TreeEntry } from "../views/fileTree.js";
import { ReviewContentProvider } from "./ReviewContentProvider.js";
import { ReviewGateRegistry } from "./ReviewGateRegistry.js";
import { renderReviewFeedback } from "./reviewFeedback.js";
import { pickCompareTo } from "./reviewSelectors.js";
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
  repoRoot?: string;
  compareTo: CompareTo;
  layout: FileLayout;
  changes: ChangesModel;
}

export class ReviewController implements vscode.Disposable {
  private readonly commentSession: CommentSession;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.changeEmitter.event;
  /** Fires the (group, path) of the diff the editor is now showing, so the tree can select its row. */
  private readonly activeDiffEmitter = new vscode.EventEmitter<{
    group: FileGroup;
    path: string;
  }>();
  readonly onDidChangeActiveDiff = this.activeDiffEmitter.event;

  private reviewId = newReviewId();
  private compareTo: CompareTo;
  private layout: FileLayout;
  private changes: ChangesModel = EMPTY_CHANGES;
  private repoRoot?: string;
  private readonly comments = new Map<string, ReviewEntry>();
  private readonly gate = new ReviewGateRegistry();
  private activeRequestId?: string;
  /** Owning agent session of the active review (best-effort; drives the Agents panel). */
  private activeSessionId?: string;
  /** Only one review may be pending at a time; a second startSession waits here. */
  private reviewBusy = false;
  private readonly reviewWaiters: Array<() => void> = [];
  /** True when the active review is "deferred" (user/Stop-gate driven) rather than a blocking
   *  /tui-review tool call — its outcome is delivered to the Stop gate / queue, not a socket reply. */
  private activeIsDeferred = false;
  /** A turn-end Stop gate currently waiting for the user to resolve the deferred review. */
  private stopWaiter?: { resolve: (outcome: StopGateResult) => void };
  /** Feedback the user submitted on a deferred review while no Stop gate was waiting — delivered at
   *  the next turn-end. Keyed by repoRoot (the Stop gate and the comment that started the review both
   *  know the repo, whereas sessionId attribution is best-effort). */
  private readonly pendingFeedback = new Map<string, string>();
  /** Best-effort owning-session resolver for a comment-started deferred review (set by extension.ts
   *  so the Agents panel can show "awaiting code review" on the right row). */
  resolveActiveSession?: () => string | undefined;
  /** The file currently shown in the diff editor, so an edit can re-target its compare base. */
  private openDiffFile?: { path: string; group: FileGroup };
  /** Each open diff's (group, path), keyed by its base URI (stable across demotion) — lets a tab
   *  switch re-select the matching tree row. */
  private readonly openDiffs = new Map<string, { group: FileGroup; path: string }>();
  /** Monotonic refresh id so a slow/stale `getChanges` can't overwrite a newer result. */
  private refreshSeq = 0;
  private readonly log = vscode.window.createOutputChannel("TUI Companion");
  private debugEnabled = vscode.workspace
    .getConfiguration("tui-companion")
    .get<boolean>("debug", false);

  constructor(
    private readonly repoService: RepoService,
    private readonly diff: DiffService,
    private readonly store: ReviewStore,
    private readonly reviewContent: ReviewContentProvider,
    private readonly coordinator: GateCoordinator,
  ) {
    this.compareTo = store.getCompareTo();
    this.layout = store.getLayout();
    // Commenting is always available on the Changes diffs — on the review-scheme side of a locked
    // diff AND on the editable working-tree (file:) side of an editable one, so it works regardless
    // of whether the file can be edited. The first comment auto-starts a "deferred" review.
    this.commentSession = new CommentSession(
      "tui.review",
      "Code Review",
      Schemes.review,
      { prompt: "Add a review comment", placeHolder: "Leave a comment for Claude" },
      (doc) =>
        doc.uri.scheme === Schemes.review ||
        (doc.uri.scheme === "file" && this.isChangedFileDoc(doc.uri)),
    );

    const reg = vscode.commands.registerCommand;
    this.disposables.push(
      this.commentSession,
      this.changeEmitter,
      this.activeDiffEmitter,
      reg(Commands.reviewRefresh, () => this.refresh()),
      reg(Commands.reviewPickCompareTo, () => this.changeCompareTo()),
      reg(Commands.reviewToggleLayout, () => this.toggleLayout()),
      reg(Commands.reviewOpenDiff, (a: unknown) => {
        const f = asFile(a);
        if (f) {
          void this.openDiff(f);
        }
      }),
      reg(Commands.reviewOpenFile, (a: unknown) => this.openFile(asFile(a))),
      reg(Commands.reviewStage, (a: unknown) => this.stageFiles(filesFromArg(a))),
      reg(Commands.reviewUnstage, (a: unknown) => this.unstageFiles(filesFromArg(a))),
      reg(Commands.reviewDiscard, (a: unknown) => this.discardFiles(filesFromArg(a))),
      reg(Commands.reviewStageAll, () => this.stageFiles(this.changes.unstaged)),
      reg(Commands.reviewUnstageAll, () => this.unstageFiles(this.changes.staged)),
      reg(Commands.reviewDiscardAll, () => this.discardFiles(this.changes.unstaged)),
      reg(Commands.reviewAddQuestion, (r: vscode.CommentReply) => this.addComment(r, "question")),
      reg(Commands.reviewAddComment, (r: vscode.CommentReply) => this.addComment(r, "comment")),
      reg(Commands.reviewAddProblem, (r: vscode.CommentReply) => this.addComment(r, "problem")),
      reg(Commands.reviewRevealComment, (c: ReviewComment) => this.revealComment(c)),
      reg(Commands.reviewDeleteComment, (c: ReviewComment) => this.deleteComment(c)),
      this.log,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("tui-companion.debug")) {
          this.debugEnabled = vscode.workspace
            .getConfiguration("tui-companion")
            .get<boolean>("debug", false);
        }
      }),
      // Editing an editable staged/committed diff routes the change to the working tree — flip the
      // diff to the unstaged base immediately, on the first keystroke (before any save).
      vscode.workspace.onDidChangeTextDocument((e) => this.maybeSwitchToUnstaged(e.document.uri)),
      // Saving writes to the working tree — keep the Changes view in sync.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === "file" && this.repoRoot && isInside(this.repoRoot, doc.uri.fsPath)) {
          void this.refresh("save");
        }
      }),
      // When a demoted diff's tab closes, drop its index-demotion so a later reopen starts clean.
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.reviewContent.pruneClosedDemotions();
        this.pruneClosedDiffs();
      }),
      // Switching between already-open diff tabs re-selects that file's row in the tree.
      vscode.window.onDidChangeActiveTextEditor(() => this.syncSelectionToActiveTab()),
    );
  }

  /** Begin a blocking review session (invoked by the MCP tui_review tool via the bridge). At most
   *  one review is pending at a time; a second waits until the first resolves. */
  async startSession(
    requestId: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<ReviewGateResult> {
    if (!(await this.acquireReviewSlot(signal))) {
      return { status: "cancelled", feedback: "" }; // connection dropped while queued
    }
    await this.registerReviewGate(requestId, sessionId, false);

    // A dropped connection ends the session (resolve the gate so this unblocks, then reset).
    const onAbort = (): void => {
      this.gate.fulfill(requestId, { status: "cancelled", feedback: "" });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const result = await this.gate.awaitDecision(requestId);
    signal.removeEventListener("abort", onAbort);
    if (this.activeRequestId === requestId) {
      await this.cleanupReview(requestId);
    }
    return result;
  }

  /** Register a review gate (foregrounded if nothing else is) and mark it active. Shared by the
   *  blocking /tui-review path and the deferred (user/Stop-gate) path. Caller owns the review slot. */
  private async registerReviewGate(
    requestId: string,
    sessionId: string | undefined,
    deferred: boolean,
  ): Promise<void> {
    this.activeRequestId = requestId;
    this.activeSessionId = sessionId;
    this.activeIsDeferred = deferred;
    await this.refresh();
    const entry: GateEntry = {
      id: requestId,
      sessionId,
      kind: "review",
      repoRoot: this.repoRoot ?? "",
      session: {
        kind: "review",
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
    this.activeIsDeferred = false;
    await this.setReviewContext(false);
    this.resetComments();
    await this.coordinator.unregister(requestId);
    this.releaseReviewSlot();
    this.changeEmitter.fire();
  }

  /**
   * Open a non-blocking "deferred" review (the user started commenting, or the Stop gate is opening
   * review mode at turn-end). No-op if a review is already active. Returns the new request id.
   */
  async requestDeferredReview(sessionId: string | undefined): Promise<string | undefined> {
    if (this.reviewBusy || this.isSessionActive()) {
      return this.activeRequestId; // a review is already in progress
    }
    this.reviewBusy = true;
    const requestId = newReviewId();
    await this.registerReviewGate(requestId, sessionId, true);
    return requestId;
  }

  /**
   * The blocking turn-end gate. Resolves "allow" immediately unless a review is warranted for this
   * session, in which case it surfaces review mode and waits for the user to Approve / Send Feedback.
   * `changedThisTurn` is the agent's "touched files this turn" signal (uncommitted changes back it up).
   */
  async awaitStopOutcome(
    sessionId: string | undefined,
    changedThisTurn: boolean,
    signal: AbortSignal,
  ): Promise<StopGateResult> {
    const key = this.repoRoot ?? "";
    const action = stopGateAction({
      hasPendingFeedback: this.pendingFeedback.has(key),
      reviewActive: this.isSessionActive(),
      reviewIsDeferred: this.activeIsDeferred,
      changedThisTurn,
      hasUncommittedChanges: this.hasUncommittedChanges(),
      reviewBusy: this.reviewBusy,
    });
    // 1. Feedback the user already submitted this turn — deliver it (user-initiated, time-shifted).
    if (action === "deliver-pending") {
      const queued = this.pendingFeedback.get(key) ?? "";
      this.pendingFeedback.delete(key);
      return { block: true, reason: queued };
    }
    // Allow immediately: nothing changed, busy, or a blocking /tui-review collects its own result.
    if (action === "allow") {
      return { block: false };
    }
    // 2/3. Open a deferred review if the turn touched files, else wait on the in-progress one.
    if (!this.isSessionActive()) {
      const id = await this.requestDeferredReview(sessionId);
      if (!id) {
        return { block: false };
      }
    }
    if (this.activeRequestId) {
      await this.coordinator.switchTo(this.activeRequestId); // bring review mode to the foreground
    }
    return await new Promise<StopGateResult>((resolve) => {
      this.stopWaiter = { resolve };
      signal.addEventListener(
        "abort",
        () => {
          if (this.stopWaiter) {
            this.stopWaiter = undefined;
            resolve({ block: false }); // connection dropped — let the agent stop
          }
        },
        { once: true },
      );
    });
  }

  /** True when there are staged/unstaged changes (the Stop-gate fallback for "the turn touched files"). */
  private hasUncommittedChanges(): boolean {
    return this.changes.staged.length > 0 || this.changes.unstaged.length > 0;
  }

  /**
   * Resolve a deferred review's outcome: hand it to a waiting Stop gate if one is parked, otherwise
   * queue submitted feedback for the session's next turn-end. Always tears the review down.
   */
  private resolveDeferred(outcome: StopGateResult): void {
    const key = this.repoRoot ?? "";
    const requestId = this.activeRequestId;
    if (this.stopWaiter) {
      const waiter = this.stopWaiter;
      this.stopWaiter = undefined;
      waiter.resolve(outcome);
    } else if (outcome.block && outcome.reason) {
      this.pendingFeedback.set(key, outcome.reason);
    }
    if (requestId) {
      void this.cleanupReview(requestId);
    }
  }

  /** Foreground: commenting on, Feedback section shown, view focused. */
  private async foreground(): Promise<void> {
    await this.setReviewContext(true);
    await this.refresh();
    try {
      await vscode.commands.executeCommand(`${Views.main}.focus`);
    } catch {
      /* view may not be registered yet — non-fatal */
    }
    this.changeEmitter.fire();
  }

  /** Background: hide the Feedback section without resolving; comments are preserved. */
  private async background(): Promise<void> {
    await this.setReviewContext(false);
    this.changeEmitter.fire();
  }

  /** True while a review is pending (drives commenting + diff read-only mode), even if backgrounded. */
  isSessionActive(): boolean {
    return this.activeRequestId !== undefined;
  }

  /** The owning agent session of the pending review, if known (drives the Agents panel). */
  activeReviewSessionId(): string | undefined {
    return this.activeSessionId;
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
    return {
      repoRoot: this.repoRoot,
      compareTo: this.compareTo,
      layout: this.layout,
      changes: this.changes,
    };
  }

  async refresh(reason = "manual"): Promise<void> {
    const seq = ++this.refreshSeq;
    const current = this.repoService.current();
    const prevRoot = this.repoRoot;
    this.repoRoot = current?.root.fsPath;
    let next: ChangesModel;
    try {
      next = this.repoRoot
        ? await this.diff.getChanges(this.repoRoot, this.compareTo)
        : EMPTY_CHANGES;
    } catch {
      // git failed transiently (e.g. a concurrent index write) — keep the last good model rather
      // than blanking it, which would wrongly make staged files look editable.
      this.debug(`refresh(${reason}) #${seq}: getChanges failed — keeping last model`);
      return;
    }

    // A newer refresh started while we awaited git — discard this (possibly stale) result so it
    // can't clobber the newer one. This is what kept editable/unstaged state out of sync.
    if (seq !== this.refreshSeq) {
      this.debug(`refresh(${reason}) #${seq}: superseded`);
      return;
    }

    const rootChanged = this.repoRoot !== prevRoot;
    if (rootChanged) {
      this.reviewContent.clearAllDemotions(); // demotions belonged to the old repo
    }
    const changed = rootChanged || !changesEqual(this.changes, next);
    this.changes = next; // adopt the new model (identical on a no-change refresh)

    // Re-fetch every open diff's virtual sides on ANY refresh — a git mutation (stage/unstage/
    // discard, or an external git op) can change index/HEAD content without changing the file list,
    // and VS Code would otherwise keep serving the cached blob.
    this.reviewContent.refreshAllOpen();

    if (changed) {
      this.debug(
        `refresh(${reason}) #${seq}: staged=${next.staged.length} unstaged=${next.unstaged.length} committed=${next.committed.length}`,
      );
      this.changeEmitter.fire(); // re-render the tree
    } else {
      this.debug(`refresh(${reason}) #${seq}: no change`);
    }
  }

  private debug(msg: string): void {
    if (this.debugEnabled) {
      this.log.appendLine(msg);
    }
  }

  private async changeCompareTo(): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const choice = await pickCompareTo(this.repoRoot, this.diff, this.store.getRecentRefs());
    if (!choice) {
      return;
    }
    this.compareTo = choice;
    await this.store.setCompareTo(choice);
    if (choice.kind === "ref" && choice.ref) {
      await this.store.addRecentRef(choice.ref);
    }
    this.reviewContent.clearAllDemotions(); // committed bases must recompute against the new ref
    await this.refresh();
  }

  private async toggleLayout(): Promise<void> {
    this.layout = this.layout === "tree" ? "flat" : "tree";
    await this.store.setLayout(this.layout);
    this.changeEmitter.fire();
  }

  // ── Git write-ops ──────────────────────────────────────────────────────────
  private async stageFiles(files: ChangedFile[]): Promise<void> {
    if (this.repoRoot && files.length) {
      const paths = files.map((f) => f.path);
      await this.diff.stage(this.repoRoot, paths);
      await this.refresh();
      await this.reconcileOpenDiffsAfterWrite(paths, "staged");
    }
  }

  private async unstageFiles(files: ChangedFile[]): Promise<void> {
    if (this.repoRoot && files.length) {
      const paths = files.map((f) => f.path);
      await this.diff.unstage(this.repoRoot, paths);
      await this.refresh();
      await this.reconcileOpenDiffsAfterWrite(paths, "unstaged");
    }
  }

  private async discardFiles(files: ChangedFile[]): Promise<void> {
    if (!this.repoRoot || !files.length) {
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
    await this.diff.discard(
      this.repoRoot,
      files.map((f) => ({ path: f.path, untracked: f.status === "U" })),
    );
    await this.refresh();
    await this.reconcileOpenDiffsAfterWrite(files.map((f) => f.path));
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
    for (const [baseKey, { group: oldGroup, path: relPath }] of snapshot) {
      if (!affected.has(relPath) || this.hasCommentOnPath(relPath)) {
        continue;
      }
      const candidates = order.filter((g) => this.changes[g].some((f) => f.path === relPath));
      const target = reconcileDiffTarget(oldGroup, candidates, preferredGroup);
      if (target === "keep") {
        continue; // still present at the same level — content refresh handles it
      }
      const located = this.locateDiffTab(baseKey);
      this.openDiffs.delete(baseKey);
      if (this.openDiffFile?.path === relPath && this.openDiffFile.group === oldGroup) {
        this.openDiffFile = undefined;
      }
      await closeTabsWhere(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === baseKey,
      );
      if (target === "close") {
        this.debug(`reconcile: ${relPath} gone — closed diff tab`);
        continue;
      }
      const file = this.changes[target].find((f) => f.path === relPath);
      if (file) {
        await this.openDiff(file, {
          viewColumn: located?.viewColumn,
          preserveFocus: !located?.active,
        });
        this.debug(`reconcile: ${relPath} ${oldGroup} -> ${target}`);
      }
    }
  }

  /** The open review diff tab whose base URI matches `baseKey`: its column and whether it's active. */
  private locateDiffTab(
    baseKey: string,
  ): { viewColumn: vscode.ViewColumn; active: boolean } | undefined {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.original.toString() === baseKey
        ) {
          return { viewColumn: group.viewColumn, active: tab.isActive };
        }
      }
    }
    return undefined;
  }

  /**
   * Editing the working-tree side of an editable staged/committed diff puts the change at the
   * unstaged level. Re-render the open diff's base against the index *in place* (the content provider
   * swaps the left side) — no reopen, so the tab, dirty buffer, caret, and focus are all untouched.
   */
  private maybeSwitchToUnstaged(uri: vscode.Uri): void {
    const open = this.openDiffFile;
    if (uri.scheme !== "file" || !this.repoRoot || !open || open.group === "unstaged") {
      return;
    }
    if (join(this.repoRoot, open.path) !== uri.fsPath) {
      return; // not the file shown in the tracked diff
    }
    // Only act when the edit is in OUR active higher-level diff (base = tui-review, right = the file),
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
    this.openDiffFile = { path: open.path, group: "unstaged" }; // flip synchronously: no re-entry
    this.openDiffs.set(input.original.toString(), { group: "unstaged", path: open.path });
    this.activeDiffEmitter.fire({ group: "unstaged", path: open.path });
    this.debug(`demote: ${open.path} (was ${open.group}) -> index base`);
    this.reviewContent.demoteToIndex(open.path);
  }

  /** The active editor changed — if it's one of our diff tabs, re-select that file's tree row. */
  private syncSelectionToActiveTab(): void {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== Schemes.review) {
      return;
    }
    const target = this.openDiffs.get(input.original.toString());
    if (target) {
      this.openDiffFile = target;
      this.activeDiffEmitter.fire(target);
    }
  }

  /** Forget diffs whose tabs have closed (keeps the openDiffs map from growing unbounded). */
  private pruneClosedDiffs(): void {
    if (this.openDiffs.size === 0) {
      return;
    }
    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          open.add(tab.input.original.toString());
        }
      }
    }
    for (const key of this.openDiffs.keys()) {
      if (!open.has(key)) {
        this.openDiffs.delete(key);
      }
    }
  }

  private async openFile(file?: ChangedFile): Promise<void> {
    if (!this.repoRoot || !file) {
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(join(this.repoRoot, file.path)));
  }

  private async openDiff(
    file: ChangedFile,
    show?: { viewColumn?: vscode.ViewColumn; preserveFocus?: boolean },
  ): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    this.openDiffFile = { path: file.path, group: file.group };
    this.activeDiffEmitter.fire({ group: file.group, path: file.path });
    // Reopening from a row shows that level's comparison again, so drop any prior index demotion.
    this.reviewContent.clearDemotion(file.path);

    const sides = this.diff.fileSides(file, this.changes.compareRef);
    const baseUri = ReviewContentProvider.buildUri(
      this.reviewId,
      "base",
      file.path,
      DiffService.encodeRef(sides.base),
      this.repoRoot,
    );
    // Remember which row this tab represents, so switching back to it re-selects the right row.
    this.openDiffs.set(baseUri.toString(), { group: file.group, path: file.path });

    // When editable, the modified side is the real working-tree file: it gets LSP + editing, and
    // edits land in the lowest (unstaged) level. Otherwise it's a read-only virtual document (the
    // tui-review FileSystemProvider is registered read-only, so it genuinely can't be typed into).
    const editable = this.isEditable(file);
    this.debug(`openDiff: ${file.path} group=${file.group} editable=${editable}`);
    const modUri = editable
      ? vscode.Uri.file(join(this.repoRoot, file.path))
      : ReviewContentProvider.buildUri(
          this.reviewId,
          "modified",
          file.path,
          DiffService.encodeRef(sides.modified),
          this.repoRoot,
        );

    // Editable diffs always compare against the live working tree and the base may demote to the
    // index mid-edit, so a fixed group label would lie — title them neutrally. Use just the filename
    // (not the whole relative path) so the tab label stays short.
    const name = basename(file.path);
    const title = editable ? `${name} (Working Tree)` : `${name} (${GROUP_LABEL[file.group]})`;
    if (editable) {
      // Open the real working-tree file as a normal document first so the TypeScript server attaches
      // it to the workspace's configured project. Opening it only as a diff's modified side can leave
      // it in an inferred single-file project, so imported types resolve to `any`. Non-preview so the
      // editable tab isn't recycled out from under an edit.
      await vscode.workspace.openTextDocument(modUri);
    }
    await vscode.commands.executeCommand("vscode.diff", baseUri, modUri, title, {
      preview: !editable,
      viewColumn: show?.viewColumn,
      preserveFocus: show?.preserveFocus,
    });
    void ensureCommentingVisible();
  }

  /**
   * A file is editable iff it has no change at a lower level (committed > staged > unstaged) and isn't
   * deleted — so editing its working-tree copy is unambiguous and lands in the unstaged level. This is
   * purely structural: it does NOT depend on whether a review is active (commenting works in both the
   * editable and the locked case, so a review never forces a diff read-only).
   */
  private isEditable(file: ChangedFile): boolean {
    return isFileEditable(file, this.changes);
  }

  /** True if a `file:` doc is one of the repo's changed files (so its diff is commentable). */
  private isChangedFileDoc(uri: vscode.Uri): boolean {
    if (!this.repoRoot || !isInside(this.repoRoot, uri.fsPath)) {
      return false;
    }
    const rel = relative(this.repoRoot, uri.fsPath);
    return this.allFiles().some((f) => f.path === rel);
  }

  private async addComment(reply: vscode.CommentReply, kind: CommentKind): Promise<void> {
    const uri = reply.thread.uri;
    // Comments anchor on the review-scheme side of a locked diff OR the editable working-tree (file:)
    // side of an editable one (its modified side is the live file).
    const anchor = this.resolveCommentAnchor(uri);
    if (!anchor) {
      return;
    }
    const { side, relPath } = anchor;
    const line = reply.thread.range?.start.line ?? 0;

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
      filePath: relPath,
      side,
      line,
      kind,
      body: reply.text,
      resolved: false,
      quote,
      anchor: {
        lineText: quote,
        contextBefore: anchorLines(line - 2, line),
        contextAfter: anchorLines(line + 1, line + 3),
        lineHash: crypto.createHash("sha1").update(quote).digest("hex"),
      },
    };
    const comment = this.commentSession.add(reply, kind, {
      id: model.id,
      onSaved: (newBody) => {
        model.body = newBody;
        this.changeEmitter.fire();
      },
      onDeleted: () => {
        this.comments.delete(model.id);
        if (reply.thread.comments.length === 0) {
          this.commentSession.forget(reply.thread);
        }
        this.changeEmitter.fire();
      },
    });
    reply.thread.label = `${relPath}:${line + 1}`;
    this.comments.set(model.id, { comment, model });
    this.changeEmitter.fire();

    // The first comment auto-starts a "deferred" review (reveals the Feedback section + registers the
    // gate); the blocking review gate then surfaces it at turn-end. Editability is unaffected.
    if (!this.isSessionActive() && this.repoRoot) {
      await this.requestDeferredReview(this.resolveActiveSession?.());
    }
  }

  /**
   * Map a comment thread's URI to (side, relPath). The thread sits on either a `tui-review://` diff
   * side (`/base/<path>` or `/modified/<path>`) or the editable working-tree file (its modified side).
   */
  private resolveCommentAnchor(
    uri: vscode.Uri,
  ): { side: "base" | "modified"; relPath: string } | undefined {
    if (uri.scheme === Schemes.review) {
      const side = uri.path.replace(/^\//, "").split("/")[0] as "base" | "modified";
      return { side, relPath: uri.path.replace(/^\/(base|modified)\//, "") };
    }
    if (uri.scheme === "file" && this.repoRoot && isInside(this.repoRoot, uri.fsPath)) {
      return { side: "modified", relPath: relative(this.repoRoot, uri.fsPath) };
    }
    return undefined;
  }

  /** Reveal a feedback row's line in its diff and expand the comment thread. */
  private async revealComment(c: ReviewComment): Promise<void> {
    const file = this.allFiles().find((f) => f.path === c.filePath);
    if (file) {
      await this.openDiff(file);
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const pos = new vscode.Position(c.line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    const entry = this.comments.get(c.id);
    if (entry?.comment.thread) {
      entry.comment.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  /** Delete a comment from the Feedback tree row (its in-diff thread also drops it). */
  private deleteComment(c: ReviewComment): void {
    const entry = this.comments.get(c.id);
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
    this.comments.delete(c.id);
    this.changeEmitter.fire();
  }

  getComments(): ReviewComment[] {
    return [...this.comments.values()].map((e) => e.model);
  }

  // ── GateSession (shared Approve / Send-Feedback commands dispatch here while active) ──
  /** Approve: proceed with no changes (the agent continues, no feedback). */
  approve(): void {
    if (!this.activeRequestId) {
      return;
    }
    if (this.activeIsDeferred) {
      this.resolveDeferred({ block: false }); // let the turn-end through with nothing to address
    } else {
      this.gate.fulfill(this.activeRequestId, { status: "cancelled", feedback: "" });
    }
  }

  sendFeedback(): void {
    if (!this.activeRequestId) {
      return;
    }
    const feedback = renderReviewFeedback(this.getComments());
    if (!feedback) {
      void vscode.window.showWarningMessage(
        "No comments to send. Add a comment, or Approve to proceed with no changes.",
      );
      return;
    }
    if (this.activeIsDeferred) {
      this.resolveDeferred({ block: true, reason: feedback });
    } else {
      this.gate.fulfill(this.activeRequestId, { status: "submitted", feedback });
    }
  }

  /** True when there's ≥1 actionable (unresolved) comment to send (drives which gate button shows). */
  hasFeedback(): boolean {
    return renderReviewFeedback(this.getComments()).length > 0;
  }

  /** True if any comment is anchored on this file (so reconcile won't yank the diff out from it). */
  private hasCommentOnPath(relPath: string): boolean {
    return [...this.comments.values()].some((e) => e.model.filePath === relPath);
  }

  private resetComments(): void {
    this.commentSession.reset();
    this.comments.clear();
    this.changeEmitter.fire();
  }

  private allFiles(): ChangedFile[] {
    return [...this.changes.staged, ...this.changes.unstaged, ...this.changes.committed];
  }

  dispose(): void {
    this.drainGate();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** Unwrap a command argument (a MainTree file node, or a ChangedFile) to a ChangedFile. */
function asFile(arg: unknown): ChangedFile | undefined {
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  if ("path" in arg && "group" in arg) {
    return arg as ChangedFile;
  }
  if ("file" in arg) {
    return (arg as { file: ChangedFile }).file;
  }
  return undefined;
}

/**
 * Collect every ChangedFile a git action should apply to. Handles a single file row, a folder row
 * (all descendant files, matching the native git panel), and a raw ChangedFile from a caller.
 */
function filesFromArg(arg: unknown): ChangedFile[] {
  if (!arg || typeof arg !== "object") {
    return [];
  }
  const o = arg as { kind?: string; entry?: TreeEntry };
  if (o.kind === "folder" && o.entry) {
    return filesInEntry(o.entry);
  }
  const f = asFile(arg);
  return f ? [f] : [];
}

function newReviewId(): string {
  return "review-" + crypto.randomBytes(4).toString("hex");
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

export type StopGateAction = "deliver-pending" | "allow" | "review";

/**
 * Decide what the blocking Stop gate does at a turn-end. Pure so it's unit-testable apart from the
 * VS Code surfaces. "deliver-pending" = the user already submitted feedback (hand it over);
 * "review" = enter/continue review mode and wait for the user; "allow" = let the agent stop now.
 */
export function stopGateAction(opts: {
  hasPendingFeedback: boolean;
  reviewActive: boolean;
  reviewIsDeferred: boolean;
  changedThisTurn: boolean;
  hasUncommittedChanges: boolean;
  reviewBusy: boolean;
}): StopGateAction {
  if (opts.hasPendingFeedback) {
    return "deliver-pending";
  }
  // A blocking /tui-review owns its own delivery; the agent can't reach Stop while parked in it.
  if (opts.reviewActive && !opts.reviewIsDeferred) {
    return "allow";
  }
  if (opts.reviewActive) {
    return "review"; // an in-progress deferred review — wait for the user to resolve it
  }
  // No review active: only open one if the turn touched files (uncommitted changes back it up).
  if (opts.reviewBusy || !(opts.changedThisTurn || opts.hasUncommittedChanges)) {
    return "allow";
  }
  return "review";
}

/** True when `child` is the same as or nested under `root` (both absolute fs paths). */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
