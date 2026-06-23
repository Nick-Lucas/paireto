// Owns the plan-review UX: opens the plan as a tui-plan:// markdown doc, attaches a shared
// CommentSession for line comments, and resolves the blocking plan gate via the shared
// Approve / Send-Feedback commands. One plan at a time (via the GateCoordinator). The plan auto-
// closes on any resolution, the bottom panel is hidden while reviewing, closing the tab early warns,
// and a dropped connection (abort signal) abandons the plan and resets state.

import * as vscode from "vscode";

import type { PlanGateResult } from "../bridge/types.js";
import { CommentSession, commentText, type GateComment } from "../comments/CommentSession.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { kindLabel, KIND_RANK, type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes } from "../config.js";
import { GateCoordinator, type GateSession } from "../gate/GateCoordinator.js";
import { closeTabsForUri, hideBottomPanel, showTerminalPanel, tabUri } from "../gate/tabs.js";
import type { PlanReviewRequest } from "../protocol/types.js";
import type { PlanContentProvider } from "./PlanContentProvider.js";
import { renderPlanFeedback, type PlanCommentData } from "./planFeedback.js";
import { PlanGateRegistry } from "./PlanGateRegistry.js";

interface PlanReview {
  key: string;
  uri: vscode.Uri;
  markdown: string;
  /** Frees the coordinator slot when this plan resolves. */
  release: () => void;
}

let planCounter = 0;

export class PlanReviewController implements vscode.Disposable, GateSession {
  readonly kind = "plan" as const;
  private readonly comments: CommentSession;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the gathered plan comments change (drives the Plan Review panel). */
  readonly onDidChange = this.changeEmitter.event;

  /** The single plan currently under review (one at a time via the coordinator). */
  private active?: PlanReview;
  private panelHidden = false;

  constructor(
    private readonly provider: PlanContentProvider,
    private readonly registry: PlanGateRegistry,
    private readonly coordinator: GateCoordinator,
  ) {
    this.comments = new CommentSession("tui.plan", "Plan Review", Schemes.plan, {
      prompt: "Add plan feedback",
      placeHolder: "Comment on this line of the plan",
    });
    this.disposables.push(
      this.comments,
      this.changeEmitter,
      vscode.commands.registerCommand(Commands.planAddQuestion, (r: vscode.CommentReply) =>
        this.addComment(r, "question"),
      ),
      vscode.commands.registerCommand(Commands.planAddComment, (r: vscode.CommentReply) =>
        this.addComment(r, "comment"),
      ),
      vscode.commands.registerCommand(Commands.planAddProblem, (r: vscode.CommentReply) =>
        this.addComment(r, "problem"),
      ),
      vscode.window.tabGroups.onDidChangeTabs((e) => void this.onTabsChanged(e)),
    );
  }

  /** Open the plan and return a promise that resolves with the user's decision. */
  async presentPlan(req: PlanReviewRequest, signal: AbortSignal): Promise<PlanGateResult> {
    let release: () => void;
    try {
      release = await this.coordinator.acquire(this, signal);
    } catch {
      // Connection dropped while queued behind another gate — nothing was opened.
      return { decision: "deny", reason: "Connection closed before plan review." };
    }

    const planId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${planCounter++}`;
    const uri = vscode.Uri.parse(`${Schemes.plan}://${req.sessionId}/${planId}.md`);
    const key = PlanGateRegistry.key(req.sessionId, planId);
    const review: PlanReview = { key, uri, markdown: req.plan, release };

    this.provider.set(uri, req.plan);
    this.active = review;
    this.updatePendingContext();

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "markdown");
    await vscode.window.showTextDocument(doc, { preview: false });
    void ensureCommentingVisible();
    await this.hidePanel();
    void vscode.window.showInformationMessage(
      "Claude is waiting on plan review. Add comments, then Approve or Send Feedback.",
    );

    // A dropped connection abandons the plan (resolve the gate so this promise unblocks, then reset).
    const onAbort = (): void => {
      this.registry.fulfill(key, { decision: "deny", reason: "Plan review connection closed." });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const result = await this.registry.awaitDecision(key);
    signal.removeEventListener("abort", onAbort);
    await this.finish(review);
    return result;
  }

  // ── GateSession (shared Approve / Send-Feedback commands dispatch here while active) ──
  async approve(): Promise<void> {
    const review = this.active;
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
      if (choice !== "Approve Anyway" || this.active !== review) {
        return;
      }
    }
    this.registry.fulfill(review.key, { decision: "allow" });
  }

  sendFeedback(): void {
    const review = this.active;
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
    this.registry.fulfill(review.key, { decision: "deny", reason: renderPlanFeedback(comments) });
  }

  private addComment(reply: vscode.CommentReply, kind: CommentKind): void {
    const review = this.active;
    if (!review || reply.thread.uri.toString() !== review.uri.toString()) {
      return;
    }
    this.comments.add(reply, kind, {
      onSaved: () => this.changeEmitter.fire(),
      onDeleted: () => {
        if (reply.thread.comments.length === 0) {
          this.comments.forget(reply.thread);
        }
        this.changeEmitter.fire();
      },
    });
    reply.thread.label = kindLabel(kind);
    this.changeEmitter.fire();
  }

  /** All gathered plan comments for the active plan (drives the Plan Review panel). */
  getComments(): PlanCommentData[] {
    return this.active ? this.collect(this.active) : [];
  }

  /** True while a plan is awaiting review (drives the Plan Review section). */
  hasPendingPlan(): boolean {
    return this.active !== undefined;
  }

  /** Flatten the active review's threads into serializable comment data. */
  private collect(review: PlanReview): PlanCommentData[] {
    const lines = review.markdown.split("\n");
    const result: PlanCommentData[] = [];
    for (const thread of this.comments.threads()) {
      if (thread.uri.toString() !== review.uri.toString()) {
        continue;
      }
      const line = thread.range?.start.line ?? 0;
      const cs = thread.comments as GateComment[];
      const kind = highestKind(cs);
      const body = cs
        .map((c) => commentText(c.body))
        .join(" ")
        .trim();
      if (body) {
        result.push({ line, quote: lines[line] ?? "", body, kind });
      }
    }
    return result;
  }

  // ── Tab lifecycle ────────────────────────────────────────────────────────────────────────────
  /** A tab closed: if it's the pending plan and we didn't close it ourselves, ask what to do. */
  private async onTabsChanged(e: vscode.TabChangeEvent): Promise<void> {
    const review = this.active;
    if (!review) {
      return; // resolved plans clear `active` before we close their tab, so our own close is ignored
    }
    for (const tab of e.closed) {
      const uri = tabUri(tab);
      if (uri && uri.toString() === review.uri.toString()) {
        await this.promptOnEarlyClose(review);
        return;
      }
    }
  }

  private async promptOnEarlyClose(review: PlanReview): Promise<void> {
    if (this.active !== review) {
      return;
    }
    const APPROVE = "Approve";
    const FEEDBACK = "Send Feedback";
    const choice = await vscode.window.showWarningMessage(
      "Claude is still waiting on this plan.",
      {
        modal: true,
        detail: "Closing the tab doesn't answer Claude. Choose an outcome to continue.",
      },
      APPROVE,
      FEEDBACK,
    );
    if (this.active !== review) {
      return; // resolved while the dialog was open
    }
    if (choice === APPROVE) {
      await this.approve();
    } else if (choice === FEEDBACK) {
      if (this.collect(review).length === 0) {
        await this.reopen(review);
        void vscode.window.showWarningMessage(
          "Add at least one comment before sending feedback, or Approve.",
        );
        return;
      }
      this.sendFeedback();
    } else {
      await this.reopen(review); // dismissed — keep the gate alive
    }
  }

  private async reopen(review: PlanReview): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(review.uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Resolve cleanup: close the plan tab, reset comments, restore the panel, free the slot. */
  private async finish(review: PlanReview): Promise<void> {
    if (this.active !== review) {
      return;
    }
    this.active = undefined; // cleared first so closing the tab doesn't trip the early-close prompt
    this.comments.reset();
    await closeTabsForUri(review.uri);
    this.provider.clear(review.uri);
    this.updatePendingContext();
    this.changeEmitter.fire();
    await this.showPanel();
    review.release();
  }

  private async hidePanel(): Promise<void> {
    this.panelHidden = true;
    await hideBottomPanel();
  }

  private async showPanel(): Promise<void> {
    if (this.panelHidden) {
      this.panelHidden = false;
      await showTerminalPanel();
    }
  }

  private updatePendingContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      ContextKeys.planPending,
      this.active !== undefined,
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.active = undefined;
  }
}

/** The highest-priority kind among a thread's comments (problem > question > comment). */
function highestKind(comments: GateComment[]): CommentKind {
  return comments.map((c) => c.kind).sort((a, b) => KIND_RANK[a] - KIND_RANK[b])[0] ?? "comment";
}
