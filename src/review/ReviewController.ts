// Orchestrates the Changes view + code-review session: tracks the grouped changes (Staged /
// Unstaged / Committed) for the current Compare-To point, opens diffs, runs git write-ops
// (stage/unstage/discard), hosts inline comments, and ships feedback to the waiting agent.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, join, relative } from "node:path";

import * as vscode from "vscode";

import type { ReviewGateResult, StopGateResult } from "../bridge/types.js";
import { CommentSession, type GateComment } from "../comments/CommentSession.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
import { GateCoordinator, type GateEntry } from "../gate/GateCoordinator.js";
import { closeTabsWhere } from "../gate/tabs.js";
import {
  DiffService,
  singlePaneSide,
  type ChangedFile,
  type ChangesModel,
} from "../git/DiffService.js";
import type { RepoService } from "../git/RepoService.js";
import { log } from "../log.js";
import { isInside } from "../protocol/paths.js";
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
  /** The review slot: held while a review is in progress. A second agent review waits in
   *  `reviewWaiters` until the one ahead resolves (at most one review pending at a time). */
  private reviewBusy = false;
  private readonly reviewWaiters: Array<() => void> = [];
  /** The file currently shown in the diff editor, so an edit can re-target its compare base. */
  private openDiffFile?: { path: string; group: FileGroup };
  /** Each open diff's (group, path), keyed by its base URI (stable across demotion) — lets a tab
   *  switch re-select the matching tree row. */
  private readonly openDiffs = new Map<string, { group: FileGroup; path: string }>();
  /** Monotonic refresh id so a slow/stale `getChanges` can't overwrite a newer result. */
  private refreshSeq = 0;

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
      "paireto.review",
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

  /**
   * Begin a blocking review (invoked by the MCP paireto_review tool via the bridge). Waits for any
   * in-progress review to finish (at most one at a time), then opens a review — which automatically
   * consumes the bucket of unclaimed comments the user already left — and blocks until they resolve it.
   */
  async startSession(
    requestId: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<ReviewGateResult> {
    if (!(await this.acquireReviewSlot(signal))) {
      return { status: "cancelled", feedback: "" }; // connection dropped while queued
    }
    return this.runReview(requestId, sessionId, signal, (result) => result);
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
    signal: AbortSignal,
  ): Promise<StopGateResult> {
    // Only park if there's something to review: this agent's turn edited files (per the PostToolUse
    // hook) or the user has comments to deliver — and no review already owns the surface.
    const open = shouldOpenTurnEndReview({
      reviewInProgress: this.reviewBusy,
      changedThisTurn,
      hasComments: this.hasComments(),
      automatic:
        vscode.workspace.getConfiguration("paireto").get<string>("review.mode", "automatic") ===
        "automatic",
    });
    if (!open) {
      return { block: false };
    }
    this.reviewBusy = true;
    const requestId = newReviewId();
    this.notifyReviewOpened(requestId);
    return this.runReview(requestId, sessionId, signal, (r) =>
      r.status === "submitted" ? { block: true, reason: r.feedback } : { block: false },
    );
  }

  /**
   * Non-blocking toast announcing an auto-opened turn-end review (only — /paireto-review stays
   * silent), with one-click actions: review it or approve as-is.
   */
  private notifyReviewOpened(requestId: string): void {
    const REVIEW = "Start Reviewing";
    const APPROVE = "Approve Immediately";
    void vscode.window
      .showInformationMessage(
        "Claude finished its turn is waiting for your review.",
        REVIEW,
        APPROVE,
      )
      .then(async (choice) => {
        if (this.activeRequestId !== requestId) {
          return; // resolved/dropped while the toast was up
        }
        if (choice === REVIEW) {
          await this.coordinator.switchTo(requestId);
          try {
            await vscode.commands.executeCommand(`${Views.main}.focus`);
          } catch {
            /* view may not be registered yet — non-fatal */
          }
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
    signal: AbortSignal,
    map: (result: ReviewGateResult) => T,
  ): Promise<T> {
    await this.registerReviewGate(requestId, sessionId);
    // A dropped connection ends the review (resolve the gate so this unblocks, then reset).
    const onAbort = (): void => {
      this.gate.fulfill(requestId, { status: "cancelled", feedback: "" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const result = await this.gate.awaitDecision(requestId);
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
  ): Promise<void> {
    this.activeRequestId = requestId;
    this.activeSessionId = sessionId;
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
    await this.setReviewContext(false);
    this.resetComments();
    await this.coordinator.unregister(requestId);
    this.releaseReviewSlot();
    this.changeEmitter.fire();
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

  /** True while a review is in progress (drives the gate buttons), even if backgrounded. */
  isSessionActive(): boolean {
    return this.activeRequestId !== undefined;
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
    // undefined -> root is the legitimate late-discovery path (Git API populates after activation); a
    // change between two real roots is the blank-list bug — log loudly but don't refuse.
    if (prevRoot !== undefined && this.repoRoot !== prevRoot) {
      log.info(`refresh(${reason}) #${seq}: repo root CHANGED ${prevRoot} -> ${this.repoRoot}`);
    }
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
    log.info(msg);
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
    // `vscode.open` (not showTextDocument) lets VS Code pick the editor for the file type — image
    // preview, etc. — instead of forcing a text editor, matching the native git panel's "Open File".
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(join(this.repoRoot, file.path)),
    );
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
    // paireto-review FileSystemProvider is registered read-only, so it genuinely can't be typed into).
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

    // An add (no base) or delete (no modified) has nothing to diff against — a two-pane diff would
    // show a broken/empty side (an image viewer can't render the 0-byte side at all). Open the one
    // real side in a single editor, like the native git panel. The doc is still commentable: the
    // working-tree file: side and the paireto-review virtual side both match the comment controller.
    const singleSide = singlePaneSide(sides);
    if (singleSide) {
      const paneUri = singleSide === "base" ? baseUri : modUri;
      await vscode.commands.executeCommand("vscode.open", paneUri, {
        preview: !editable,
        viewColumn: show?.viewColumn,
        preserveFocus: show?.preserveFocus,
      });
      void ensureCommentingVisible();
      return;
    }

    if (editable && (await isTextFile(join(this.repoRoot, file.path)))) {
      // Open the real working-tree file as a normal document first so the TypeScript server attaches
      // it to the workspace's configured project. Opening it only as a diff's modified side can leave
      // it in an inferred single-file project, so imported types resolve to `any`. Non-preview so the
      // editable tab isn't recycled out from under an edit. Skipped for binary files (images, etc.) —
      // pre-opening them as text would force a text model and defeat VS Code's image diff.
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
    // Comments accumulate in this bucket whether or not a review is in progress; a review (started by
    // /paireto-review or the turn-end gate) consumes whatever is in it. The Feedback section reveals
    // itself once the bucket is non-empty. Editability is unaffected.
    this.changeEmitter.fire();
  }

  /**
   * Map a comment thread's URI to (side, relPath). The thread sits on either a `paireto-review://` diff
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

  /** True when the user has left review comments (the bucket), whether or not a review is in progress. */
  hasComments(): boolean {
    return this.comments.size > 0;
  }

  // ── GateSession (shared Approve / Send-Feedback commands dispatch here while active) ──
  /** Approve: proceed with no changes (the agent continues, no feedback). */
  approve(): void {
    if (this.activeRequestId) {
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
    this.gate.fulfill(this.activeRequestId, { status: "submitted", feedback });
  }

  /** True when there's ≥1 comment to send (drives which gate button shows). */
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
