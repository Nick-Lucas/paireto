import * as vscode from "vscode";

import type { PlanGateResult } from "../bridge/types.js";
import type { AppEvent } from "../harness/appEvent.js";
import type { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import { CommentSession } from "../comments/CommentSession.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
import { GateCoordinator, type GateEntry } from "../gate/GateCoordinator.js";
import { closeTabsForUri, tabUri } from "../gate/tabs.js";
import { log } from "../log.js";
import type { PlanContentProvider } from "./PlanContentProvider.js";
import { type PlanCommentData } from "./planFeedback.js";
import { PlanThreads, type PlanThread } from "./PlanThreads.js";
import {
  codeFeedbackPromptText,
  composeRejectedPlanFeedback,
  planSendDecision,
  INCLUDE_FILE_COMMENTS,
  PLAN_FEEDBACK_ONLY,
  type CodeFeedbackSource,
} from "./planCodeFeedback.js";
import { planDocLabel } from "./planTitle.js";
import { PlanGateRegistry } from "./PlanGateRegistry.js";
import type { Harness } from "../protocol/types.js";

interface PlanReview {
  id: string;
  key: string;
  sessionId: string;
  harness: Harness;
  uri: vscode.Uri;
  markdown: string;
  previousUri?: vscode.Uri;
}

interface AnsweredPlan {
  markdown: string;
  threads: PlanThread[];
}

function previousPlanUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ fragment: "previous" });
}

let planCounter = 0;

export class PlanReviewController implements vscode.Disposable {
  private readonly comments: CommentSession;
  private readonly threads: PlanThreads;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private readonly plans = new Map<string, PlanReview>();
  private foregroundReview?: PlanReview;
  private readonly closingTabs = new Set<string>();
  private readonly answeredPlans = new Map<string, AnsweredPlan>();

  constructor(
    private readonly provider: PlanContentProvider,
    private readonly registry: PlanGateRegistry,
    private readonly coordinator: GateCoordinator,
    private readonly locator: AgentServiceLocator,
    private readonly codeFeedback: CodeFeedbackSource,
  ) {
    this.comments = new CommentSession(
      "paireto.plan",
      "Paireto: Add Comment",
      Schemes.plan,
      {
        prompt: "Add plan feedback",
        placeHolder: "Comment on this line of the plan",
      },
      (doc) => doc.uri.scheme === Schemes.plan && doc.uri.fragment !== "previous",
    );
    this.threads = new PlanThreads(this.comments, () => this.changeEmitter.fire());
    this.disposables.push(
      this.comments,
      this.threads,
      this.changeEmitter,
      vscode.commands.registerCommand(Commands.planAddQuestion, (r: vscode.CommentReply) =>
        this.addComment(r, "question"),
      ),
      vscode.commands.registerCommand(Commands.planAddComment, (r: vscode.CommentReply) =>
        this.addComment(r, "comment"),
      ),
      vscode.commands.registerCommand(Commands.planAddReply, (r: vscode.CommentReply) =>
        this.threads.addReply(r),
      ),
      vscode.window.tabGroups.onDidChangeTabs((e) => void this.onTabsChanged(e)),
    );
  }

  async presentPlan(
    event: AppEvent,
    repoRoot: string,
    signal: AbortSignal,
  ): Promise<PlanGateResult> {
    const sessionId = event.sessionId;
    const plan = event.planText ?? "";
    const planId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${planCounter++}`;

    const uri = vscode.Uri.from({
      scheme: Schemes.plan,
      authority: sessionId,
      path: `/${planDocLabel(plan, new Date())}`,
      query: planId,
    });
    const key = PlanGateRegistry.key(sessionId, planId);
    const answered = this.answeredPlans.get(sessionId);
    const previousUri = answered === undefined ? undefined : previousPlanUri(uri);
    const review: PlanReview = {
      id: key,
      key,
      sessionId,
      harness: event.harness,
      uri,
      markdown: plan,
      previousUri,
    };

    this.provider.set(uri, plan);
    if (previousUri !== undefined && answered !== undefined) {
      this.provider.set(previousUri, answered.markdown);
      this.threads.showSent(previousUri, answered.threads);
    }
    this.plans.set(review.id, review);

    const entry: GateEntry = {
      id: review.id,
      sessionId,
      kind: "plan",
      repoRoot,
      session: {
        kind: "plan",
        approve: () => this.approve(review),
        sendFeedback: () => this.sendFeedback(review),
        hasFeedback: () => this.collect(review).length > 0,
      },
      foreground: () => this.foreground(review),
      background: () => this.background(review),
    };

    const decision = this.registry.awaitDecision(key);

    const onAbort = (): void => {
      this.registry.fulfill(key, { decision: "deny", reason: "Plan review connection closed." });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await this.coordinator.register(entry);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error(`plan review failed to open for agent ${sessionId.slice(0, 8)}: ${detail}`);
      this.registry.fulfill(key, {
        decision: "deny",
        reason: `Paireto could not open the plan for review (${detail}). Ask the user how to continue.`,
      });
      signal.removeEventListener("abort", onAbort);
      await this.finish(review);

      return decision;
    }
    this.updatePendingContext();
    this.changeEmitter.fire();
    const planTool = this.locator.strategyFor(review.harness).planToolName;
    log.info(
      `plan review opened for agent ${sessionId.slice(0, 8)} (${planTool}, repo ${repoRoot})`,
    );
    this.notifyPlanOpened(review);

    const result = await decision;
    signal.removeEventListener("abort", onAbort);
    await this.finish(review);
    return result;
  }

  private notifyPlanOpened(review: PlanReview): void {
    const VIEW = "View Plan";
    const APPROVE = "Approve Immediately";
    const name = this.locator.strategyFor(review.harness).displayName;
    void vscode.window
      .showInformationMessage(
        `${name} finished a plan and is waiting for your review.`,
        VIEW,
        APPROVE,
      )
      .then(async (choice) => {
        if (!this.plans.has(review.id)) {
          return; // resolved/dropped while the toast was up
        }
        if (choice === VIEW) {
          await this.coordinator.switchTo(review.id);
        } else if (choice === APPROVE) {
          await this.approve(review);
        }
      });
  }

  private async foreground(review: PlanReview): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${Views.main}.focus`);
    } catch {
      /* view may not be registered yet — non-fatal */
    }
    await this.show(review);
    this.foregroundReview = review;
    void ensureCommentingVisible();
    this.changeEmitter.fire();
  }

  private async background(review: PlanReview): Promise<void> {
    if (this.foregroundReview === review) {
      this.foregroundReview = undefined;
    }
    this.closingTabs.add(review.uri.toString());
    await closeTabsForUri(review.uri);
    this.changeEmitter.fire();
  }

  private async approve(review: PlanReview): Promise<void> {
    if (!this.plans.has(review.id)) {
      return;
    }

    const configured = vscode.workspace
      .getConfiguration("paireto")
      .get<string>(`planApprove.mode.${review.harness}`);
    const nextMode = resolvePlanApproveMode(
      configured,
      this.locator.strategyFor(review.harness).defaultPlanApproveMode,
    );
    log.info(
      `plan review approved for agent ${review.sessionId.slice(0, 8)}` +
        (nextMode ? ` (mode -> ${nextMode})` : ""),
    );
    this.answeredPlans.delete(review.sessionId);
    this.registry.fulfill(review.key, { decision: "allow", nextMode });
  }

  private async sendFeedback(review: PlanReview): Promise<void> {
    if (!this.plans.has(review.id)) {
      return;
    }
    const comments = this.collect(review);
    const codeComments = this.codeFeedback.getPendingComments();
    const decision = planSendDecision({
      planComments: comments.length,
      codeComments: codeComments.length,
      reviewInProgress: this.codeFeedback.isSessionActive(),
    });

    if (decision.action === "refuse") {
      const queued =
        codeComments.length > 0 ? " Your file comments stay queued for the next code review." : "";
      void vscode.window.showWarningMessage(
        `No plan comments to send. Add a comment on the plan, or use Approve.${queued}`,
      );
      return;
    }

    let include = false;
    if (decision.action === "ask") {
      const { message, detail } = codeFeedbackPromptText(decision.codeCount);
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        INCLUDE_FILE_COMMENTS,
        PLAN_FEEDBACK_ONLY,
      );
      if (!this.plans.has(review.id)) {
        return; // resolved while the dialog was open
      }
      if (choice !== INCLUDE_FILE_COMMENTS && choice !== PLAN_FEEDBACK_ONLY) {
        log.info("plan review feedback cancelled at the file-comment prompt");
        return;
      }
      include = choice === INCLUDE_FILE_COMMENTS;
    }

    const sentCode = include ? await this.codeFeedback.markCommentsSent(codeComments) : [];
    log.info(
      `plan review feedback sent for agent ${review.sessionId.slice(0, 8)}: ${comments.length} comment(s), ${sentCode.length} file comment(s)`,
    );
    const strategy = this.locator.strategyFor(review.harness);
    const reason = composeRejectedPlanFeedback({
      planComments: comments,
      codeComments: sentCode,
      toolName: strategy.planToolName,
      rejectedPlanReviewInstructions: strategy.rejectedPlanReviewInstructions,
      multiRepository: this.codeFeedback.isMultiRepository(),
    });

    this.answeredPlans.set(review.sessionId, {
      markdown: review.markdown,
      threads: this.threads.threadsFor(review.uri),
    });
    this.registry.fulfill(review.key, { decision: "deny", reason });
  }

  /** Answers whether the comment attached, so a caller is never left waiting for a silent drop. */
  private addComment(reply: vscode.CommentReply, kind: CommentKind): boolean {
    const review = this.planForUri(reply.thread.uri);
    if (!review) {
      return false;
    }
    if (this.threads.addReply(reply)) {
      return true;
    }
    const line = reply.thread.range?.start.line ?? 0;
    this.threads.open(reply, kind, review.markdown.split("\n")[line] ?? "");
    return true;
  }

  /** Gathered comments for the foreground plan (drives the Plan Review panel). */
  getComments(): PlanCommentData[] {
    const review = this.foregroundReview ?? [...this.plans.values()].at(-1);
    return review ? this.collect(review) : [];
  }

  /** True while any plan is awaiting review (drives the Plan Review section). */
  hasPendingPlan(): boolean {
    return this.plans.size > 0;
  }

  planTextForGate(gateId: string): string | undefined {
    return this.plans.get(gateId)?.markdown;
  }

  private planForUri(uri: vscode.Uri): PlanReview | undefined {
    const target = uri.toString();
    return [...this.plans.values()].find((p) => p.uri.toString() === target);
  }

  private collect(review: PlanReview): PlanCommentData[] {
    return this.threads.commentsFor(review.uri);
  }

  // ── Tab lifecycle ────────────────────────────────────────────────────────────────────────────
  /** A tab closed: if it's a still-pending plan we didn't close ourselves, ask what to do. */
  private async onTabsChanged(e: vscode.TabChangeEvent): Promise<void> {
    for (const tab of e.closed) {
      const uri = tabUri(tab);
      if (!uri) {
        continue;
      }
      const key = uri.toString();
      if (this.closingTabs.has(key)) {
        this.closingTabs.delete(key);
        continue; // our own programmatic close
      }
      const review = this.planForUri(uri);
      if (review) {
        await this.promptOnEarlyClose(review);
        return;
      }
    }
  }

  private async promptOnEarlyClose(review: PlanReview): Promise<void> {
    if (!this.plans.has(review.id)) {
      return;
    }
    const APPROVE = "Approve";
    const FEEDBACK = "Send Feedback";
    const name = this.locator.strategyFor(review.harness).displayName;
    const choice = await vscode.window.showWarningMessage(
      `${name} is still waiting on this plan.`,
      {
        modal: true,
        detail: `Closing the tab doesn't answer ${name}. Choose an outcome to continue.`,
      },
      APPROVE,
      FEEDBACK,
    );
    if (!this.plans.has(review.id)) {
      return; // resolved while the dialog was open
    }
    if (choice === APPROVE) {
      await this.approve(review);
    } else if (choice === FEEDBACK) {
      await this.sendFeedback(review);
      // Send Feedback answers nothing when there are no plan comments to send, and the file-comment
      // prompt can be cancelled. The tab is already closed, so bring the plan back in both cases or
      // the user can no longer read it or comment on it.
      if (this.registry.has(review.key)) {
        await this.reopen(review);
      }
    } else {
      await this.reopen(review); // dismissed — keep the gate alive
    }
  }

  private async reopen(review: PlanReview): Promise<void> {
    await this.show(review);
  }

  private async show(review: PlanReview): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(review.uri);
    await vscode.languages.setTextDocumentLanguage(doc, "markdown");
    if (!review.previousUri) {
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }
    const previous = await vscode.workspace.openTextDocument(review.previousUri);
    await vscode.languages.setTextDocumentLanguage(previous, "markdown");
    await vscode.commands.executeCommand(
      "vscode.diff",
      review.previousUri,
      review.uri,
      `${review.uri.path.replace(/^\//, "")} (revised)`,
      { preview: false },
    );
  }

  private async finish(review: PlanReview): Promise<void> {
    if (!this.plans.has(review.id)) {
      return;
    }
    this.plans.delete(review.id);
    if (this.foregroundReview === review) {
      this.foregroundReview = undefined;
    }
    this.threads.dropFor(review.uri);
    if (review.previousUri) {
      this.threads.dropFor(review.previousUri);
    }
    this.closingTabs.add(review.uri.toString());
    await closeTabsForUri(review.uri);
    this.provider.clear(review.uri);
    if (review.previousUri) {
      this.provider.clear(review.previousUri);
    }
    await this.coordinator.unregister(review.id);
    this.updatePendingContext();
    this.changeEmitter.fire();
  }

  private updatePendingContext(): void {
    void vscode.commands.executeCommand("setContext", ContextKeys.planPending, this.plans.size > 0);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.plans.clear();
    this.answeredPlans.clear();
    this.foregroundReview = undefined;
  }
}

export function resolvePlanApproveMode(
  configuredMode: string | undefined,
  defaultMode: string | undefined,
): string | undefined {
  const mode = configuredMode ?? defaultMode;
  return mode && mode !== "off" ? mode : undefined;
}
