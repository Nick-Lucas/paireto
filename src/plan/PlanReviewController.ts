// Owns the plan-review UX: opens the plan as a tui-plan:// markdown doc, attaches a
// CommentController for line comments with kinds, and wires Approve / Send-Feedback to resolve
// the blocking plan gate (allow, or deny + serialized feedback).

import * as vscode from "vscode";

import type { PlanGateResult } from "../bridge/types.js";
import { fullDocumentCommentingRanges } from "../comments/commentingRanges.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { kindLabel, KIND_RANK, type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes } from "../config.js";
import type { PlanReviewRequest } from "../protocol/types.js";
import type { PlanContentProvider } from "./PlanContentProvider.js";
import { renderPlanFeedback, renderPlanRejection, type PlanCommentData } from "./planFeedback.js";
import { PlanGateRegistry } from "./PlanGateRegistry.js";

class PlanComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: "Reviewer" };
  contextValue: string;
  label: string;
  constructor(
    public body: string | vscode.MarkdownString,
    public kind: CommentKind,
  ) {
    this.contextValue = kind;
    this.label = kindLabel(kind);
  }
}

interface PlanReview {
  key: string;
  sessionId: string;
  planId: string;
  uri: vscode.Uri;
  markdown: string;
  threads: vscode.CommentThread[];
}

let planCounter = 0;

export class PlanReviewController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly reviews = new Map<string, PlanReview>(); // uri.toString() -> review
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the gathered plan comments change (drives the Plan Review panel). */
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly provider: PlanContentProvider,
    private readonly registry: PlanGateRegistry,
  ) {
    this.controller = vscode.comments.createCommentController("tui.plan", "Plan Review");
    this.controller.options = {
      prompt: "Add plan feedback",
      placeHolder: "Comment on this line of the plan",
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => fullDocumentCommentingRanges(doc, Schemes.plan),
    };
    this.disposables.push(
      this.controller,
      vscode.commands.registerCommand(Commands.planAddQuestion, (r: vscode.CommentReply) =>
        this.addComment(r, "question"),
      ),
      vscode.commands.registerCommand(Commands.planAddComment, (r: vscode.CommentReply) =>
        this.addComment(r, "comment"),
      ),
      vscode.commands.registerCommand(Commands.planAddProblem, (r: vscode.CommentReply) =>
        this.addComment(r, "problem"),
      ),
      vscode.commands.registerCommand(Commands.planApprove, (uri?: vscode.Uri) =>
        this.approve(uri),
      ),
      vscode.commands.registerCommand(Commands.planSendFeedback, (uri?: vscode.Uri) =>
        this.sendFeedback(uri),
      ),
      vscode.commands.registerCommand(Commands.planReject, (uri?: vscode.Uri) => this.reject(uri)),
    );
  }

  /** Open the plan and return a promise that resolves with the user's decision. */
  async presentPlan(req: PlanReviewRequest): Promise<PlanGateResult> {
    const planId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${planCounter++}`;
    const uri = vscode.Uri.parse(`${Schemes.plan}://${req.sessionId}/${planId}.md`);
    const key = PlanGateRegistry.key(req.sessionId, planId);

    this.provider.set(uri, req.plan);
    this.reviews.set(uri.toString(), {
      key,
      sessionId: req.sessionId,
      planId,
      uri,
      markdown: req.plan,
      threads: [],
    });
    this.updatePendingContext();

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "markdown");
    await vscode.window.showTextDocument(doc, { preview: false });
    void ensureCommentingVisible();
    void vscode.window.showInformationMessage(
      "Claude is waiting on plan review. Add comments, then Approve or Send Feedback.",
    );

    const result = await this.registry.awaitDecision(key);
    this.cleanup(uri);
    return result;
  }

  private addComment(reply: vscode.CommentReply, kind: CommentKind): void {
    const review = this.reviews.get(reply.thread.uri.toString());
    if (!review) {
      return;
    }
    const comment = new PlanComment(reply.text, kind);
    reply.thread.comments = [...reply.thread.comments, comment];
    reply.thread.label = kindLabel(kind);
    if (!review.threads.includes(reply.thread)) {
      review.threads.push(reply.thread);
    }
    this.changeEmitter.fire();
  }

  /** All gathered plan comments across pending reviews (drives the Plan Review panel). */
  getComments(): PlanCommentData[] {
    return [...this.reviews.values()].flatMap((r) => this.collect(r));
  }

  /** True while a plan is awaiting review (drives the Plan Review section). */
  hasPendingPlan(): boolean {
    return this.reviews.size > 0;
  }

  private resolveReview(uri?: vscode.Uri): PlanReview | undefined {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (target && this.reviews.has(target.toString())) {
      return this.reviews.get(target.toString());
    }
    // Fall back to the only open review, if unambiguous.
    return this.reviews.size === 1 ? [...this.reviews.values()][0] : undefined;
  }

  private async approve(uri?: vscode.Uri): Promise<void> {
    const review = this.resolveReview(uri);
    if (!review) {
      return;
    }
    const hasProblem = this.collect(review).some((c) => c.kind === "problem");
    if (hasProblem) {
      const choice = await vscode.window.showWarningMessage(
        "This plan has unresolved problems. Approve anyway?",
        { modal: true },
        "Approve Anyway",
      );
      if (choice !== "Approve Anyway") {
        return;
      }
    }
    this.registry.fulfill(review.key, { decision: "allow" });
  }

  private sendFeedback(uri?: vscode.Uri): void {
    const review = this.resolveReview(uri);
    if (!review) {
      return;
    }
    const comments = this.collect(review);
    if (comments.length === 0) {
      void vscode.window.showWarningMessage(
        "No comments to send. Add at least one comment, or use Approve.",
      );
      return;
    }
    const reason = renderPlanFeedback(comments);
    this.registry.fulfill(review.key, { decision: "deny", reason });
  }

  /** Reject: deny the plan and tell the agent to discuss the problems with the user (not revise).
   *  Unlike Send Feedback, comments are optional — a rejection stands on its own. */
  private reject(uri?: vscode.Uri): void {
    const review = this.resolveReview(uri);
    if (!review) {
      return;
    }
    const reason = renderPlanRejection(this.collect(review));
    this.registry.fulfill(review.key, { decision: "deny", reason });
  }

  /** Flatten this review's threads into serializable comment data. */
  private collect(review: PlanReview): PlanCommentData[] {
    const lines = review.markdown.split("\n");
    const result: PlanCommentData[] = [];
    for (const thread of review.threads) {
      const line = thread.range?.start.line ?? 0;
      const kind = highestKind(thread.comments as PlanComment[]);
      const body = (thread.comments as PlanComment[])
        .map((c) => commentText(c.body))
        .join(" ")
        .trim();
      if (body) {
        result.push({ line, quote: lines[line] ?? "", body, kind });
      }
    }
    return result;
  }

  private cleanup(uri: vscode.Uri): void {
    const review = this.reviews.get(uri.toString());
    if (review) {
      for (const thread of review.threads) {
        thread.dispose();
      }
      this.reviews.delete(uri.toString());
    }
    this.provider.clear(uri);
    this.updatePendingContext();
    this.changeEmitter.fire();
  }

  private updatePendingContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      ContextKeys.planPending,
      this.reviews.size > 0
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changeEmitter.dispose();
    this.reviews.clear();
  }
}

/** The highest-priority kind among a thread's comments (problem > question > comment). */
function highestKind(comments: PlanComment[]): CommentKind {
  return comments
    .map((c) => c.kind)
    .sort((a, b) => KIND_RANK[a] - KIND_RANK[b])[0] ?? "comment";
}

function commentText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
