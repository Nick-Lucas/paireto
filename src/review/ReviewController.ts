// Orchestrates the code-review experience: tracks the current review spec + changed files, opens
// native diff editors, hosts inline comments (severity + anchoring), and ships feedback to Claude
// via the per-session queue (delivered on the agent's next prompt).

import * as crypto from "node:crypto";

import * as vscode from "vscode";

import type { AgentSessionService } from "../agents/AgentSessionService.js";
import { Commands, Schemes } from "../config.js";
import { DiffService, type ChangedFile } from "../git/DiffService.js";
import type { RepoService } from "../git/RepoService.js";
import type { ReviewFeedbackQueue } from "./ReviewFeedbackQueue.js";
import { ReviewContentProvider } from "./ReviewContentProvider.js";
import { renderReviewFeedback } from "./reviewFeedback.js";
import { pickBaseRef, pickMode } from "./reviewSelectors.js";
import type { ReviewComment } from "./reviewTypes.js";
import type { ReviewStore } from "../storage/ReviewStore.js";
import type { ReviewSpec, Severity } from "../types.js";

class RComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: "Reviewer" };
  contextValue: string;
  label: string;
  constructor(
    public body: string | vscode.MarkdownString,
    public severity: Severity,
    public readonly model: ReviewComment,
  ) {
    this.contextValue = severity;
    this.label = severity;
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

  constructor(
    private readonly repoService: RepoService,
    private readonly diff: DiffService,
    private readonly content: ReviewContentProvider,
    private readonly store: ReviewStore,
    private readonly agents: AgentSessionService,
    private readonly feedbackQueue: ReviewFeedbackQueue,
  ) {
    this.spec = store.getSpec();
    this.controller = vscode.comments.createCommentController("tui.review", "Code Review");
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        doc.uri.scheme === Schemes.review
          ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)]
          : [],
    };

    this.disposables.push(
      this.controller,
      this.changeEmitter,
      vscode.commands.registerCommand(Commands.reviewRefresh, () => this.refresh()),
      vscode.commands.registerCommand(Commands.reviewPickMode, () => this.changeMode()),
      vscode.commands.registerCommand(Commands.reviewPickBase, () => this.changeBase()),
      vscode.commands.registerCommand(Commands.reviewToggleUntracked, () => this.toggleUntracked()),
      vscode.commands.registerCommand(Commands.reviewOpenDiff, (f: ChangedFile) =>
        this.openDiff(f),
      ),
      vscode.commands.registerCommand(Commands.reviewAddComment, (r: vscode.CommentReply) =>
        this.addComment(r),
      ),
      vscode.commands.registerCommand(Commands.reviewSetSeverityBlocking, (c: RComment) =>
        this.setSeverity(c, "blocking"),
      ),
      vscode.commands.registerCommand(Commands.reviewSetSeveritySuggestion, (c: RComment) =>
        this.setSeverity(c, "suggestion"),
      ),
      vscode.commands.registerCommand(Commands.reviewSetSeverityNote, (c: RComment) =>
        this.setSeverity(c, "note"),
      ),
      vscode.commands.registerCommand(Commands.reviewSendFeedback, () => this.sendFeedback()),
      vscode.commands.registerCommand(Commands.reviewExport, () => this.exportReview()),
    );
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

  private async toggleUntracked(): Promise<void> {
    this.spec = { ...this.spec, includeUntracked: !this.spec.includeUntracked };
    await this.store.setSpec(this.spec);
    await this.refresh();
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
  }

  private async addComment(reply: vscode.CommentReply): Promise<void> {
    const uri = reply.thread.uri;
    if (uri.scheme !== Schemes.review) {
      return;
    }
    const side = uri.path.replace(/^\//, "").split("/")[0] as "base" | "modified";
    const params = new URLSearchParams(uri.query);
    const repoRoot = params.get("repo") ? decodeURIComponent(params.get("repo")!) : this.repoRoot;
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
      severity: "suggestion",
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
    const comment = new RComment(reply.text, "suggestion", model);
    reply.thread.comments = [...reply.thread.comments, comment];
    reply.thread.label = `${relPath}:${line + 1}`;
    this.comments.set(model.id, comment);
    this.threads.set(reply.thread, [...(this.threads.get(reply.thread) ?? []), comment]);
    void repoRoot;
  }

  private setSeverity(comment: RComment, severity: Severity): void {
    comment.severity = severity;
    comment.contextValue = severity;
    comment.label = severity;
    comment.model.severity = severity;
    for (const [thread, list] of this.threads) {
      if (list.includes(comment)) {
        thread.comments = [...thread.comments];
      }
    }
  }

  private allComments(): ReviewComment[] {
    return [...this.comments.values()].map((c) => c.model);
  }

  private async sendFeedback(): Promise<void> {
    const feedback = renderReviewFeedback(this.allComments());
    if (!feedback) {
      void vscode.window.showWarningMessage("No unresolved suggestion/blocking comments to send.");
      return;
    }
    if (!this.repoRoot) {
      return;
    }
    const sessions = this.agents
      .sessionsForRepo(this.repoRoot)
      .sort((a, b) => b.lastEventAt - a.lastEventAt);
    if (sessions.length === 0) {
      void vscode.window.showWarningMessage(
        "No active Claude session for this repo. Feedback was not queued.",
      );
      return;
    }
    let target = sessions[0];
    if (sessions.length > 1) {
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({ label: s.sessionId, description: s.state, session: s })),
        { title: "Send feedback to which Claude session?" },
      );
      if (!pick) {
        return;
      }
      target = pick.session;
    }
    this.feedbackQueue.enqueue(target.sessionId, feedback);
    void vscode.window.showInformationMessage(
      "Review feedback queued — it will be delivered to Claude on the next prompt.",
    );
  }

  private async exportReview(): Promise<void> {
    if (!this.repoRoot) {
      return;
    }
    const file = await this.store.export(
      this.repoRoot,
      this.reviewId,
      this.spec,
      this.allComments(),
    );
    void vscode.window.showInformationMessage(`Review exported to ${file}`);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function newReviewId(): string {
  return "review-" + crypto.randomBytes(4).toString("hex");
}
