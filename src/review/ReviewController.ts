// Orchestrates the code-review experience: tracks the current review spec + changed files, opens
// native diff editors, hosts inline comments (kinds + anchoring), and ships feedback to Claude
// via the per-session queue (delivered on the agent's next prompt).

import * as crypto from "node:crypto";

import * as vscode from "vscode";

import { fullDocumentCommentingRanges } from "../comments/commentingRanges.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { kindLabel, type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
import { DiffService, type ChangedFile } from "../git/DiffService.js";
import type { RepoService } from "../git/RepoService.js";
import type { ReviewGateResult } from "../bridge/types.js";
import { ReviewContentProvider } from "./ReviewContentProvider.js";
import { ReviewGateRegistry } from "./ReviewGateRegistry.js";
import { renderReviewFeedback } from "./reviewFeedback.js";
import { pickBaseRef, pickMode } from "./reviewSelectors.js";
import type { ReviewComment } from "./reviewTypes.js";
import type { ReviewStore } from "../storage/ReviewStore.js";
import type { ReviewSpec } from "../types.js";

class RComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: "Reviewer" };
  contextValue: string;
  label: string;
  /** The thread this comment lives on (for reveal/delete from the Feedback panel). */
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

export interface ReviewState {
  repoRoot?: string;
  spec: ReviewSpec;
  files: ChangedFile[];
}

export class ReviewController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.changeEmitter.event;

  private reviewId = newReviewId();
  private spec: ReviewSpec;
  private files: ChangedFile[] = [];
  private repoRoot?: string;
  private readonly comments = new Map<string, RComment>(); // comment id -> comment
  private readonly threads = new Map<vscode.CommentThread, RComment[]>();
  private readonly gate = new ReviewGateRegistry();
  private activeRequestId?: string;

  constructor(
    private readonly repoService: RepoService,
    private readonly diff: DiffService,
    private readonly store: ReviewStore,
  ) {
    this.spec = store.getSpec();
    this.controller = vscode.comments.createCommentController("tui.review", "Code Review");
    this.controller.options = {
      prompt: "Add a review comment",
      placeHolder: "Leave a comment for Claude",
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => fullDocumentCommentingRanges(doc, Schemes.review),
    };

    this.disposables.push(
      this.controller,
      this.changeEmitter,
      vscode.commands.registerCommand(Commands.reviewRefresh, () => this.refresh()),
      vscode.commands.registerCommand(Commands.reviewPickMode, () => this.changeMode()),
      vscode.commands.registerCommand(Commands.reviewPickBase, () => this.changeBase()),
      vscode.commands.registerCommand(Commands.reviewOpenDiff, (f: ChangedFile) =>
        this.openDiff(f),
      ),
      vscode.commands.registerCommand(Commands.reviewAddQuestion, (r: vscode.CommentReply) =>
        this.addComment(r, "question"),
      ),
      vscode.commands.registerCommand(Commands.reviewAddComment, (r: vscode.CommentReply) =>
        this.addComment(r, "comment"),
      ),
      vscode.commands.registerCommand(Commands.reviewAddProblem, (r: vscode.CommentReply) =>
        this.addComment(r, "problem"),
      ),
      vscode.commands.registerCommand(Commands.reviewClearFeedback, () => this.clearFeedback()),
      vscode.commands.registerCommand(Commands.reviewRevealComment, (c: ReviewComment) =>
        this.revealComment(c),
      ),
      vscode.commands.registerCommand(Commands.reviewDeleteComment, (c: ReviewComment) =>
        this.deleteComment(c),
      ),
      vscode.commands.registerCommand(Commands.reviewSendFeedback, () => this.sendFeedback()),
      vscode.commands.registerCommand(Commands.reviewCancel, () => this.cancelReview()),
      vscode.commands.registerCommand(Commands.reviewExport, () => this.exportReview()),
    );
  }

  /**
   * Begin a blocking review session (invoked by the MCP tui_review tool via the bridge). Reveals
   * the review panels and resolves when the user clicks Send Feedback or Cancel.
   */
  async startSession(requestId: string): Promise<ReviewGateResult> {
    this.activeRequestId = requestId;
    await this.setSessionActive(true);
    await this.refresh();
    try {
      await vscode.commands.executeCommand(`${Views.review}.focus`);
    } catch {
      /* view may not be registered yet — non-fatal */
    }
    const result = await this.gate.awaitDecision(requestId);
    if (this.activeRequestId === requestId) {
      this.activeRequestId = undefined;
      await this.setSessionActive(false);
    }
    return result;
  }

  private async setSessionActive(active: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", ContextKeys.reviewSessionActive, active);
  }

  /** Resolve any outstanding review gate (on dispose) so the MCP tool doesn't hang. */
  drainGate(): void {
    this.gate.drain({ status: "cancelled", feedback: "" });
  }

  getState(): ReviewState {
    return { repoRoot: this.repoRoot, spec: this.spec, files: this.files };
  }

  async refresh(): Promise<void> {
    const current = this.repoService.current();
    this.repoRoot = current?.root.fsPath;
    if (!this.repoRoot) {
      this.files = [];
      this.changeEmitter.fire();
      return;
    }
    this.files = await this.diff.listChanges(this.repoRoot, this.spec);
    this.changeEmitter.fire();
  }

  private async changeMode(): Promise<void> {
    const mode = await pickMode(this.spec.mode);
    if (mode) {
      this.spec = { ...this.spec, mode };
      await this.store.setSpec(this.spec);
      await this.refresh();
    }
  }

  private async changeBase(): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const base = await pickBaseRef(this.repoRoot, this.spec.baseRef);
    if (base) {
      this.spec = { ...this.spec, baseRef: base };
      await this.store.setSpec(this.spec);
      await this.refresh();
    }
  }

  private async openDiff(file: ChangedFile): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const sides = await this.diff.fileSides(this.repoRoot, this.spec, file);
    const baseUri = ReviewContentProvider.buildUri(
      this.reviewId,
      "base",
      file.path,
      DiffService.encodeRef(sides.base),
      this.repoRoot,
    );
    const modUri = ReviewContentProvider.buildUri(
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
      `${file.path} (${this.spec.mode})`,
      { preview: true },
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
    const file = this.files.find((f) => f.path === c.filePath);
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

  /** Delete a single feedback comment (and its thread if now empty). */
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

  /** Clear all gathered review comments (after confirmation). */
  private async clearFeedback(): Promise<void> {
    if (this.comments.size === 0) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Clear all ${this.comments.size} review comment(s)? This cannot be undone.`,
      { modal: true },
      "Clear"
    );
    if (choice !== "Clear") {
      return;
    }
    for (const thread of this.threads.keys()) {
      thread.dispose();
    }
    this.threads.clear();
    this.comments.clear();
    this.changeEmitter.fire();
  }

  /** All review comments (for the Feedback panel). */
  getComments(): ReviewComment[] {
    return [...this.comments.values()].map((c) => c.model);
  }

  /** Resolve the active review session with the gathered feedback, then reset. */
  private sendFeedback(): void {
    if (!this.activeRequestId) {
      return;
    }
    const feedback = renderReviewFeedback(this.getComments());
    if (!feedback) {
      void vscode.window.showWarningMessage(
        "No comments to send. Add a comment, or Cancel the review."
      );
      return;
    }
    this.gate.fulfill(this.activeRequestId, { status: "submitted", feedback });
    this.resetComments();
  }

  /** Resolve the active review session as cancelled (agent proceeds with no changes). */
  private cancelReview(): void {
    if (!this.activeRequestId) {
      return;
    }
    this.gate.fulfill(this.activeRequestId, { status: "cancelled", feedback: "" });
    this.resetComments();
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
    const file = await this.store.export(this.repoRoot, this.reviewId, this.spec, this.getComments());
    void vscode.window.showInformationMessage(`Review exported to ${file}`);
  }

  dispose(): void {
    this.drainGate();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function newReviewId(): string {
  return "review-" + crypto.randomBytes(4).toString("hex");
}
