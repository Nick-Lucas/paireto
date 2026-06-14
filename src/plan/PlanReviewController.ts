// Owns the plan-review UX: opens the plan as a tui-plan:// markdown doc, attaches a
// CommentController for line comments with severity, and wires Approve / Send-Feedback to resolve
// the blocking plan gate (allow, or deny + serialized feedback).

import * as vscode from "vscode";

import type { PlanGateResult } from "../bridge/types.js";
import { fullDocumentCommentingRanges } from "../comments/commentingRanges.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { Commands, ContextKeys, Schemes } from "../config.js";
import type { PlanReviewRequest } from "../protocol/types.js";
import type { Severity } from "../types.js";
import type { PlanContentProvider } from "./PlanContentProvider.js";
import { renderPlanFeedback, type PlanCommentData } from "./planFeedback.js";
import { PlanGateRegistry } from "./PlanGateRegistry.js";

class PlanComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: "Reviewer" };
  contextValue: string;
  label: string;
  constructor(
    public body: string | vscode.MarkdownString,
    public severity: Severity,
  ) {
    this.contextValue = severity;
    this.label = severityLabel(severity);
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
      vscode.commands.registerCommand(Commands.planAddComment, (r: vscode.CommentReply) =>
        this.addComment(r),
      ),
      vscode.commands.registerCommand(Commands.planSetSeverityBlocking, (c: PlanComment) =>
        this.setSeverity(c, "blocking"),
      ),
      vscode.commands.registerCommand(Commands.planSetSeveritySuggestion, (c: PlanComment) =>
        this.setSeverity(c, "suggestion"),
      ),
      vscode.commands.registerCommand(Commands.planSetSeverityNote, (c: PlanComment) =>
        this.setSeverity(c, "note"),
      ),
      vscode.commands.registerCommand(Commands.planApprove, (uri?: vscode.Uri) =>
        this.approve(uri),
      ),
      vscode.commands.registerCommand(Commands.planSendFeedback, (uri?: vscode.Uri) =>
        this.sendFeedback(uri),
      ),
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

  private addComment(reply: vscode.CommentReply): void {
    const review = this.reviews.get(reply.thread.uri.toString());
    if (!review) {
      return;
    }
    const comment = new PlanComment(reply.text, "suggestion");
    reply.thread.comments = [...reply.thread.comments, comment];
    reply.thread.label = severityLabel(comment.severity);
    if (!review.threads.includes(reply.thread)) {
      review.threads.push(reply.thread);
    }
  }

  private setSeverity(comment: PlanComment, severity: Severity): void {
    comment.severity = severity;
    comment.contextValue = severity;
    comment.label = severityLabel(severity);
    // Re-assign comments arrays so VS Code re-renders the affected threads.
    for (const review of this.reviews.values()) {
      for (const thread of review.threads) {
        if (thread.comments.includes(comment)) {
          thread.comments = [...thread.comments];
          thread.label = severityLabel(severity);
        }
      }
    }
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
    const hasBlocking = this.collect(review).some((c) => c.severity === "blocking");
    if (hasBlocking) {
      const choice = await vscode.window.showWarningMessage(
        "This plan has unresolved blocking comments. Approve anyway?",
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

  /** Flatten this review's threads into serializable comment data. */
  private collect(review: PlanReview): PlanCommentData[] {
    const lines = review.markdown.split("\n");
    const result: PlanCommentData[] = [];
    for (const thread of review.threads) {
      const line = thread.range?.start.line ?? 0;
      const severity = highestSeverity(thread.comments as PlanComment[]);
      const body = (thread.comments as PlanComment[])
        .map((c) => commentText(c.body))
        .join(" ")
        .trim();
      if (body) {
        result.push({ line, quote: lines[line] ?? "", body, severity });
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
    this.reviews.clear();
  }
}

function severityLabel(severity: Severity): string {
  return severity === "blocking" ? "Blocking" : severity === "suggestion" ? "Suggestion" : "Note";
}

function highestSeverity(comments: PlanComment[]): Severity {
  if (comments.some((c) => c.severity === "blocking")) {
    return "blocking";
  }
  if (comments.some((c) => c.severity === "suggestion")) {
    return "suggestion";
  }
  return "note";
}

function commentText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
