// Orchestrates the Changes view + code-review session: tracks the grouped changes (Staged /
// Unstaged / Committed) for the current Compare-To point, opens diffs, runs git write-ops
// (stage/unstage/discard), hosts inline comments, and ships feedback to the waiting agent.

import * as crypto from "node:crypto";
import { join } from "node:path";

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
    public readonly model: ReviewComment
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

  constructor(
    private readonly repoService: RepoService,
    private readonly diff: DiffService,
    private readonly store: ReviewStore
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
      reg(Commands.reviewStage, (a: unknown) => this.stageFiles(asFiles(a))),
      reg(Commands.reviewUnstage, (a: unknown) => this.unstageFiles(asFiles(a))),
      reg(Commands.reviewDiscard, (a: unknown) => this.discardFiles(asFiles(a))),
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
      reg(Commands.reviewExport, () => this.exportReview())
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
    this.changeEmitter.fire();
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
      await this.diff.stage(this.repoRoot, files.map((f) => f.path));
      await this.refresh();
    }
  }

  private async unstageFiles(files: ChangedFile[]): Promise<void> {
    if (this.repoRoot && files.length) {
      await this.diff.unstage(this.repoRoot, files.map((f) => f.path));
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
      "Discard Changes"
    );
    if (choice !== "Discard Changes") {
      return;
    }
    await this.diff.discard(
      this.repoRoot,
      files.map((f) => ({ path: f.path, untracked: f.status === "U" }))
    );
    await this.refresh();
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
    const sides = this.diff.fileSides(file, this.changes.compareRef);
    const baseUri = ReviewContentProvider.buildUri(
      this.reviewId,
      "base",
      file.path,
      DiffService.encodeRef(sides.base),
      this.repoRoot
    );
    const modUri = ReviewContentProvider.buildUri(
      this.reviewId,
      "modified",
      file.path,
      DiffService.encodeRef(sides.modified),
      this.repoRoot
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      baseUri,
      modUri,
      `${file.path} (${GROUP_LABEL[file.group]})`,
      { preview: true }
    );
    void ensureCommentingVisible();
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
      "Clear"
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
      void vscode.window.showWarningMessage("No comments to send. Add a comment, or Cancel the review.");
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
      this.getComments()
    );
    void vscode.window.showInformationMessage(`Review exported to ${file}`);
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

function asFiles(arg: unknown): ChangedFile[] {
  const f = asFile(arg);
  return f ? [f] : [];
}

function newReviewId(): string {
  return "review-" + crypto.randomBytes(4).toString("hex");
}
