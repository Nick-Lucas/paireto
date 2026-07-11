// Owns the plan-review UX. Several plans can be PENDING at once (one paireto-plan:// doc each); the
// GateCoordinator decides which is foreground (its tab open). Backgrounding a plan closes its tab
// without resolving it, so it can be returned to. Resolution goes through the shared Approve /
// Send-Feedback commands (dispatched to the foreground plan's GateSession). A dropped connection
// (abort signal) abandons that plan and resets it.

import * as vscode from "vscode";

import type { PlanGateResult } from "../bridge/types.js";
import type { AppEvent } from "../harness/appEvent.js";
import type { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import { CommentSession, commentText, type GateComment } from "../comments/CommentSession.js";
import { ensureCommentingVisible } from "../comments/commentingVisibility.js";
import { kindLabel, KIND_RANK, type CommentKind } from "../comments/kinds.js";
import { Commands, ContextKeys, Schemes, Views } from "../config.js";
import { GateCoordinator, type GateEntry } from "../gate/GateCoordinator.js";
import { closeTabsForUri, tabUri } from "../gate/tabs.js";
import { log } from "../log.js";
import type { PlanContentProvider } from "./PlanContentProvider.js";
import { renderPlanFeedback, type PlanCommentData } from "./planFeedback.js";
import { planDocLabel } from "./planTitle.js";
import { PlanGateRegistry } from "./PlanGateRegistry.js";
import type { Harness } from "../protocol/types.js";

interface PlanReview {
  id: string;
  key: string;
  sessionId: string;
  /** The harness that proposed this plan — selects the per-harness approve mode + tool wording. */
  harness: Harness;
  uri: vscode.Uri;
  markdown: string;
}

let planCounter = 0;

export class PlanReviewController implements vscode.Disposable {
  private readonly comments: CommentSession;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the gathered plan comments change (drives the Plan Review panel). */
  readonly onDidChange = this.changeEmitter.event;

  /** All pending plans, keyed by their gate-entry id. */
  private readonly plans = new Map<string, PlanReview>();
  /** The plan whose tab is currently shown (drives the Plan Review section). */
  private foregroundReview?: PlanReview;
  /** URIs we're closing programmatically, so the early-close prompt ignores our own closes. */
  private readonly closingTabs = new Set<string>();

  constructor(
    private readonly provider: PlanContentProvider,
    private readonly registry: PlanGateRegistry,
    private readonly coordinator: GateCoordinator,
    private readonly locator: AgentServiceLocator,
  ) {
    this.comments = new CommentSession("paireto.plan", "Paireto: Add Comment", Schemes.plan, {
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

  /** Open the plan (foregrounded only if no other gate is) and resolve with the user's decision. */
  async presentPlan(
    event: AppEvent,
    repoRoot: string,
    signal: AbortSignal,
  ): Promise<PlanGateResult> {
    const sessionId = event.sessionId;
    const plan = event.planText ?? "";
    const planId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${planCounter++}`;
    // The tab basename is the human label; planId rides in the query so the URI (and the content
    // provider's map keyed by uri.toString()) stays unique without polluting the visible tab name.
    const uri = vscode.Uri.from({
      scheme: Schemes.plan,
      authority: sessionId,
      path: `/${planDocLabel(plan, new Date())}`,
      query: planId,
    });
    const key = PlanGateRegistry.key(sessionId, planId);
    const review: PlanReview = { id: key, key, sessionId, harness: event.harness, uri, markdown: plan };

    this.provider.set(uri, plan);
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
    await this.coordinator.register(entry);
    this.updatePendingContext();
    this.changeEmitter.fire();
    const planTool = this.locator.strategyFor(review.harness).planToolName;
    log.info(`plan review opened for agent ${sessionId.slice(0, 8)} (${planTool}, repo ${repoRoot})`);
    this.notifyPlanOpened(review);

    // A dropped connection abandons the plan (resolve the gate so this unblocks, then reset).
    const onAbort = (): void => {
      this.registry.fulfill(key, { decision: "deny", reason: "Plan review connection closed." });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const result = await this.registry.awaitDecision(key);
    signal.removeEventListener("abort", onAbort);
    await this.finish(review);
    return result;
  }

  /** Non-blocking toast announcing an auto-opened plan, with one-click View / Approve actions. */
  private notifyPlanOpened(review: PlanReview): void {
    const VIEW = "View Plan";
    const APPROVE = "Approve Immediately";
    const name = this.locator.strategyFor(review.harness).displayName;
    void vscode.window
      .showInformationMessage(`${name} finished a plan and is waiting for your review.`, VIEW, APPROVE)
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

  // ── GateEntry foreground/background ──────────────────────────────────────────────────────────
  private async foreground(review: PlanReview): Promise<void> {
    // Reveal the Paireto sidebar first, then open the plan tab so the editor ends up focused.
    try {
      await vscode.commands.executeCommand(`${Views.main}.focus`);
    } catch {
      /* view may not be registered yet — non-fatal */
    }
    const doc = await vscode.workspace.openTextDocument(review.uri);
    await vscode.languages.setTextDocumentLanguage(doc, "markdown");
    await vscode.window.showTextDocument(doc, { preview: false });
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

  // ── GateSession outcomes (bound per-plan; invoked via the shared commands on the foreground) ──
  private async approve(review: PlanReview): Promise<void> {
    if (!this.plans.has(review.id)) {
      return;
    }
    const hasProblem = this.collect(review).some((c) => c.kind === "problem");
    if (hasProblem) {
      const choice = await vscode.window.showWarningMessage(
        "This plan has unresolved problems. Approve anyway?",
        { modal: true },
        "Approve Anyway",
      );
      if (choice !== "Approve Anyway" || !this.plans.has(review.id)) {
        return;
      }
    }
    // Approving a plan otherwise restores the pre-plan permission mode; default to the harness's own
    // plan-approve mode (Claude: auto) so the agent proceeds without re-prompting. The setting is a
    // per-harness key `planApprove.mode.<harness>` (an explicit value wins over the strategy default);
    // "off" — or a harness with no key/settable mode (Codex) — leaves the mode unchanged.
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
    this.registry.fulfill(review.key, { decision: "allow", nextMode });
  }

  private sendFeedback(review: PlanReview): void {
    if (!this.plans.has(review.id)) {
      return;
    }
    const comments = this.collect(review);
    if (comments.length === 0) {
      void vscode.window.showWarningMessage(
        "No comments to send. Add at least one comment, or use Approve.",
      );
      return;
    }
    log.info(
      `plan review feedback sent for agent ${review.sessionId.slice(0, 8)}: ${comments.length} comment(s)`,
    );
    const planTool = this.locator.strategyFor(review.harness).planToolName;
    this.registry.fulfill(review.key, {
      decision: "deny",
      reason: renderPlanFeedback(comments, planTool),
    });
  }

  private addComment(reply: vscode.CommentReply, kind: CommentKind): void {
    const review = this.planForUri(reply.thread.uri);
    if (!review) {
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

  /** Gathered comments for the foreground plan (drives the Plan Review panel). */
  getComments(): PlanCommentData[] {
    const review = this.foregroundReview ?? [...this.plans.values()].at(-1);
    return review ? this.collect(review) : [];
  }

  /** True while any plan is awaiting review (drives the Plan Review section). */
  hasPendingPlan(): boolean {
    return this.plans.size > 0;
  }

  private planForUri(uri: vscode.Uri): PlanReview | undefined {
    const target = uri.toString();
    return [...this.plans.values()].find((p) => p.uri.toString() === target);
  }

  /** Flatten one plan's threads into serializable comment data. */
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
      if (this.collect(review).length === 0) {
        await this.reopen(review);
        void vscode.window.showWarningMessage(
          "Add at least one comment before sending feedback, or Approve.",
        );
        return;
      }
      this.sendFeedback(review);
    } else {
      await this.reopen(review); // dismissed — keep the gate alive
    }
  }

  private async reopen(review: PlanReview): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(review.uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Resolve cleanup: dispose this plan's comments + tab, then unregister (promotes the next gate). */
  private async finish(review: PlanReview): Promise<void> {
    if (!this.plans.has(review.id)) {
      return;
    }
    this.plans.delete(review.id);
    if (this.foregroundReview === review) {
      this.foregroundReview = undefined;
    }
    this.disposeThreadsFor(review.uri);
    this.closingTabs.add(review.uri.toString());
    await closeTabsForUri(review.uri);
    this.provider.clear(review.uri);
    await this.coordinator.unregister(review.id);
    this.updatePendingContext();
    this.changeEmitter.fire();
  }

  private disposeThreadsFor(uri: vscode.Uri): void {
    const target = uri.toString();
    for (const thread of this.comments.threads()) {
      if (thread.uri.toString() === target) {
        thread.dispose();
        this.comments.forget(thread);
      }
    }
  }

  private updatePendingContext(): void {
    void vscode.commands.executeCommand("setContext", ContextKeys.planPending, this.plans.size > 0);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.plans.clear();
    this.foregroundReview = undefined;
  }
}

/** The permission mode to enter on plan approval: an explicit per-harness config value wins over the
 *  harness strategy's default; "off" — or a harness with no settable mode (undefined default) —
 *  leaves the mode unchanged (undefined). */
export function resolvePlanApproveMode(
  configuredMode: string | undefined,
  defaultMode: string | undefined,
): string | undefined {
  const mode = configuredMode ?? defaultMode;
  return mode && mode !== "off" ? mode : undefined;
}

/** The highest-priority kind among a thread's comments (problem > question > comment). */
function highestKind(comments: GateComment[]): CommentKind {
  return comments.map((c) => c.kind).sort((a, b) => KIND_RANK[a] - KIND_RANK[b])[0] ?? "comment";
}
