// Orchestrates the Changes view + code-review session: tracks the grouped changes (Staged /
// Unstaged / Committed) for the current Compare-To point, opens diffs, runs git write-ops
// (stage/unstage/discard), hosts inline comments, and ships feedback to the waiting agent.

import * as crypto from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

import * as vscode from "vscode";

import type { ReviewGateResult } from "../bridge/types.js";
import { CommentSession, type GateComment } from "../comments/CommentSession.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
import { GateCoordinator, type GateSession } from "../gate/GateCoordinator.js";
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

export class ReviewController implements vscode.Disposable, GateSession {
  readonly kind = "review" as const;
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
  /** Frees the coordinator slot when the active review session resolves. */
  private activeRelease?: () => void;
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
    // Commenting is only enabled during an active /tui-review session; outside one the diffs are
    // browse-only (the Changed Files section is always available).
    this.commentSession = new CommentSession(
      "tui.review",
      "Code Review",
      Schemes.review,
      { prompt: "Add a review comment", placeHolder: "Leave a comment for Claude" },
      () => this.isSessionActive(),
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

  /** Begin a blocking review session (invoked by the MCP tui_review tool via the bridge). */
  async startSession(requestId: string, signal: AbortSignal): Promise<ReviewGateResult> {
    let release: () => void;
    try {
      release = await this.coordinator.acquire(this, signal);
    } catch {
      // Connection dropped while queued behind another gate — nothing was opened.
      return { status: "cancelled", feedback: "" };
    }
    this.activeRequestId = requestId;
    this.activeRelease = release;
    await this.setSessionActive(true);
    await this.refresh();
    try {
      await vscode.commands.executeCommand(`${Views.main}.focus`);
    } catch {
      /* view may not be registered yet — non-fatal */
    }
    // A dropped connection ends the session (resolve the gate so this unblocks, then reset).
    const onAbort = (): void => {
      this.gate.fulfill(requestId, { status: "cancelled", feedback: "" });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const result = await this.gate.awaitDecision(requestId);
    signal.removeEventListener("abort", onAbort);
    if (this.activeRequestId === requestId) {
      this.activeRequestId = undefined;
      await this.setSessionActive(false);
      this.resetComments();
      this.changeEmitter.fire();
      this.activeRelease?.();
      this.activeRelease = undefined;
    }
    return result;
  }

  isSessionActive(): boolean {
    return this.activeRequestId !== undefined;
  }

  private async setSessionActive(active: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", ContextKeys.reviewSessionActive, active);
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
      await this.diff.stage(
        this.repoRoot,
        files.map((f) => f.path),
      );
      await this.refresh();
    }
  }

  private async unstageFiles(files: ChangedFile[]): Promise<void> {
    if (this.repoRoot && files.length) {
      await this.diff.unstage(
        this.repoRoot,
        files.map((f) => f.path),
      );
      await this.refresh();
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

  private async openDiff(file: ChangedFile): Promise<void> {
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
    // index mid-edit, so a fixed group label would lie — title them neutrally.
    const title = editable
      ? `${file.path} (Working Tree)`
      : `${file.path} (${GROUP_LABEL[file.group]})`;
    await vscode.commands.executeCommand("vscode.diff", baseUri, modUri, title, { preview: true });
    void ensureCommentingVisible();
  }

  /**
   * A file is editable iff it has no change at a lower level (committed > staged > unstaged) — so
   * editing its working-tree copy is unambiguous and lands in the unstaged level. During a review
   * session diffs stay virtual so inline comments (tui-review scheme only) keep working.
   */
  private isEditable(file: ChangedFile): boolean {
    if (this.isSessionActive() || file.status === "D") {
      return false;
    }
    return !LOWER_GROUPS[file.group].some((g) => this.changes[g].some((f) => f.path === file.path));
  }

  private async addComment(reply: vscode.CommentReply, kind: CommentKind): Promise<void> {
    const uri = reply.thread.uri;
    if (uri.scheme !== Schemes.review) {
      return;
    }
    const side = uri.path.replace(/^\//, "").split("/")[0] as "base" | "modified";
    const relPath = uri.path.replace(/^\/(base|modified)\//, "");
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
