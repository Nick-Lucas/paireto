// Orchestrates the Changes view + code-review session: tracks the grouped changes (Staged /
// Unstaged / Committed) for the current Compare-To point, opens diffs, runs git write-ops
// (stage/unstage/discard), hosts inline comments, and ships feedback to the waiting agent.

import * as crypto from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";

import * as vscode from "vscode";

import type { ReviewGateResult } from "../bridge/types.js";
import { fullDocumentCommentingRanges } from "../comments/commentingRanges.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { kindLabel, type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
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

class RComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: "Reviewer" };
  contextValue: string;
  label: string;
  thread?: vscode.CommentThread;
  constructor(
    public body: string | vscode.MarkdownString,
    public kind: CommentKind,
    public readonly model: ReviewComment,
  ) {
    this.contextValue = kind;
    this.label = kindLabel(kind);
  }
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
  unstaged: "Unstaged",
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
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.changeEmitter.event;

  private reviewId = newReviewId();
  private compareTo: CompareTo;
  private layout: FileLayout;
  private changes: ChangesModel = EMPTY_CHANGES;
  private repoRoot?: string;
  private readonly comments = new Map<string, RComment>();
  private readonly threads = new Map<vscode.CommentThread, RComment[]>();
  private readonly gate = new ReviewGateRegistry();
  private activeRequestId?: string;
  /** The file currently shown in the diff editor, so an edit can re-target its compare base. */
  private openDiffFile?: { path: string; group: FileGroup };
  /** Debounced refresh of diffs when their underlying files change on disk. */
  private fsWatcher?: vscode.FileSystemWatcher;
  private watchedRoot?: string;
  private readonly dirtyPaths = new Set<string>();
  private fsDebounce?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly repoService: RepoService,
    private readonly diff: DiffService,
    private readonly store: ReviewStore,
    private readonly reviewContent: ReviewContentProvider,
  ) {
    this.compareTo = store.getCompareTo();
    this.layout = store.getLayout();
    this.controller = vscode.comments.createCommentController("tui.review", "Code Review");
    this.controller.options = {
      prompt: "Add a review comment",
      placeHolder: "Leave a comment for Claude",
    };
    this.controller.commentingRangeProvider = {
      // Commenting is only enabled during an active /tui-review session; outside one the diffs are
      // browse-only (the Changed Files section is always available).
      provideCommentingRanges: (doc) =>
        this.isSessionActive() ? fullDocumentCommentingRanges(doc, Schemes.review) : undefined,
    };

    const reg = vscode.commands.registerCommand;
    this.disposables.push(
      this.controller,
      this.changeEmitter,
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
      reg(Commands.reviewClearFeedback, () => this.clearFeedback()),
      reg(Commands.reviewRevealComment, (c: ReviewComment) => this.revealComment(c)),
      reg(Commands.reviewDeleteComment, (c: ReviewComment) => this.deleteComment(c)),
      reg(Commands.reviewSendFeedback, () => this.sendFeedback()),
      reg(Commands.reviewCancel, () => this.cancelReview()),
      reg(Commands.reviewExport, () => this.exportReview()),
      // Editing an editable staged/committed diff routes the change to the working tree — flip the
      // diff to the unstaged base immediately, on the first keystroke (before any save).
      vscode.workspace.onDidChangeTextDocument((e) => this.maybeSwitchToUnstaged(e.document.uri)),
      // Saving writes to the working tree — keep the Changes view in sync.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === "file" && this.repoRoot && isInside(this.repoRoot, doc.uri.fsPath)) {
          void this.refresh();
        }
      }),
    );
  }

  /** Begin a blocking review session (invoked by the MCP tui_review tool via the bridge). */
  async startSession(requestId: string): Promise<ReviewGateResult> {
    this.activeRequestId = requestId;
    await this.setSessionActive(true);
    await this.refresh();
    try {
      await vscode.commands.executeCommand(`${Views.main}.focus`);
    } catch {
      /* view may not be registered yet — non-fatal */
    }
    const result = await this.gate.awaitDecision(requestId);
    if (this.activeRequestId === requestId) {
      this.activeRequestId = undefined;
      await this.setSessionActive(false);
      this.changeEmitter.fire();
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

  async refresh(): Promise<void> {
    const current = this.repoService.current();
    this.repoRoot = current?.root.fsPath;
    if (!this.repoRoot) {
      this.changes = EMPTY_CHANGES;
    } else {
      this.changes = await this.diff.getChanges(this.repoRoot, this.compareTo);
    }
    this.ensureFsWatcher();
    this.changeEmitter.fire();
  }

  // ── Underlying-file watch: refresh open diffs + the Changes view when files change on disk ──
  private ensureFsWatcher(): void {
    if (this.repoRoot === this.watchedRoot) {
      return;
    }
    this.fsWatcher?.dispose();
    this.watchedRoot = this.repoRoot;
    if (!this.repoRoot) {
      this.fsWatcher = undefined;
      return;
    }
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repoRoot, "**/*")
    );
    const onChange = (uri: vscode.Uri): void => this.onFsChange(uri);
    w.onDidChange(onChange);
    w.onDidCreate(onChange);
    w.onDidDelete(onChange);
    this.fsWatcher = w;
  }

  private onFsChange(uri: vscode.Uri): void {
    if (uri.scheme !== "file" || !this.repoRoot) {
      return;
    }
    const rel = relative(this.repoRoot, uri.fsPath);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.includes(`.git${sep}`) || rel.includes(`node_modules${sep}`)) {
      return;
    }
    this.dirtyPaths.add(rel.split(sep).join("/"));
    if (this.fsDebounce) {
      clearTimeout(this.fsDebounce);
    }
    this.fsDebounce = setTimeout(() => void this.flushFsChanges(), 200);
  }

  private async flushFsChanges(): Promise<void> {
    this.fsDebounce = undefined;
    const paths = [...this.dirtyPaths];
    this.dirtyPaths.clear();
    for (const p of paths) {
      this.reviewContent.refreshOpenForPath(p);
    }
    await this.refresh();
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
   * unstaged level, so re-target the open diff's base to the index — keeping the same (live, dirty)
   * working file on the right, and restoring the caret + focus the user was typing at.
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
    const oldTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = oldTab?.input;
    const isOurDiff =
      input instanceof vscode.TabInputTextDiff &&
      input.original.scheme === Schemes.review &&
      input.modified.scheme === "file" &&
      input.modified.fsPath === uri.fsPath;
    if (!isOurDiff) {
      return;
    }
    this.openDiffFile = { path: open.path, group: "unstaged" }; // flip synchronously: no re-entry
    // Defer so the editor's selection reflects the just-typed character (it updates after the
    // onDidChangeTextDocument event), then re-target the diff base and restore the caret.
    setTimeout(() => {
      const active = vscode.window.activeTextEditor;
      const selection =
        active && active.document.uri.fsPath === uri.fsPath ? active.selection : undefined;
      void this.showUnstagedDiff(open.path, selection, oldTab);
    }, 0);
  }

  private async showUnstagedDiff(
    relPath: string,
    selection?: vscode.Selection,
    replaceTab?: vscode.Tab
  ): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const baseUri = ReviewContentProvider.buildUri(
      this.reviewId,
      "base",
      relPath,
      DiffService.encodeRef({ kind: "index" }),
      this.repoRoot
    );
    const modUri = vscode.Uri.file(join(this.repoRoot, relPath));
    await vscode.commands.executeCommand(
      "vscode.diff",
      baseUri,
      modUri,
      `${relPath} (${GROUP_LABEL.unstaged})`,
      { preview: true }
    );

    // The edited (dirty) higher-level diff opens as a separate tab — close it so this replaces it
    // rather than stacking. The document stays open here, so no save prompt.
    const newTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (replaceTab && replaceTab !== newTab) {
      void vscode.window.tabGroups.close(replaceTab);
    }

    // Restore the caret + keep focus on the modified side.
    const editor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.toString() === modUri.toString()
    );
    if (editor && selection) {
      editor.selection = selection;
      editor.revealRange(
        new vscode.Range(selection.active, selection.active),
        vscode.TextEditorRevealType.Default
      );
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
    const sides = this.diff.fileSides(file, this.changes.compareRef);
    const baseUri = ReviewContentProvider.buildUri(
      this.reviewId,
      "base",
      file.path,
      DiffService.encodeRef(sides.base),
      this.repoRoot,
    );

    // When editable, the modified side is the real working-tree file: it gets LSP + editing, and
    // edits land in the lowest (unstaged) level. Otherwise it's a read-only virtual document.
    const editable = this.isEditable(file);
    const modUri = editable
      ? vscode.Uri.file(join(this.repoRoot, file.path))
      : ReviewContentProvider.buildUri(
          this.reviewId,
          "modified",
          file.path,
          DiffService.encodeRef(sides.modified),
          this.repoRoot,
        );

    await vscode.commands.executeCommand(
      "vscode.diff",
      baseUri,
      modUri,
      `${file.path} (${GROUP_LABEL[file.group]})`,
      { preview: true },
    );
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
    const comment = new RComment(reply.text, kind, model);
    comment.thread = reply.thread;
    reply.thread.comments = [...reply.thread.comments, comment];
    reply.thread.label = `${relPath}:${line + 1}`;
    this.comments.set(model.id, comment);
    this.threads.set(reply.thread, [...(this.threads.get(reply.thread) ?? []), comment]);
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
    const rc = this.comments.get(c.id);
    if (rc?.thread) {
      rc.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  private deleteComment(c: ReviewComment): void {
    const rc = this.comments.get(c.id);
    if (!rc) {
      return;
    }
    const thread = rc.thread;
    if (thread) {
      const remaining = (this.threads.get(thread) ?? []).filter((x) => x !== rc);
      if (remaining.length === 0) {
        thread.dispose();
        this.threads.delete(thread);
      } else {
        thread.comments = thread.comments.filter((x) => x !== rc);
        this.threads.set(thread, remaining);
      }
    }
    this.comments.delete(c.id);
    this.changeEmitter.fire();
  }

  private async clearFeedback(): Promise<void> {
    if (this.comments.size === 0) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Clear all ${this.comments.size} review comment(s)? This cannot be undone.`,
      { modal: true },
      "Clear",
    );
    if (choice === "Clear") {
      this.resetComments();
    }
  }

  getComments(): ReviewComment[] {
    return [...this.comments.values()].map((c) => c.model);
  }

  private sendFeedback(): void {
    if (!this.activeRequestId) {
      return;
    }
    const feedback = renderReviewFeedback(this.getComments());
    if (!feedback) {
      void vscode.window.showWarningMessage(
        "No comments to send. Add a comment, or Cancel the review.",
      );
      return;
    }
    this.gate.fulfill(this.activeRequestId, { status: "submitted", feedback });
    this.resetComments();
  }

  private cancelReview(): void {
    if (this.activeRequestId) {
      this.gate.fulfill(this.activeRequestId, { status: "cancelled", feedback: "" });
      this.resetComments();
    }
  }

  private resetComments(): void {
    for (const thread of this.threads.keys()) {
      thread.dispose();
    }
    this.threads.clear();
    this.comments.clear();
    this.changeEmitter.fire();
  }

  private async exportReview(): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const file = await this.store.export(
      this.repoRoot,
      this.reviewId,
      this.changes.compareLabel,
      this.getComments(),
    );
    void vscode.window.showInformationMessage(`Review exported to ${file}`);
  }

  private allFiles(): ChangedFile[] {
    return [...this.changes.staged, ...this.changes.unstaged, ...this.changes.committed];
  }

  dispose(): void {
    this.drainGate();
    if (this.fsDebounce) {
      clearTimeout(this.fsDebounce);
    }
    this.fsWatcher?.dispose();
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
