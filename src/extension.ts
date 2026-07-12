// Activation entry point: constructs the services, wires the bridge handlers, registers commands
// and providers, and serves a socket per open repo. Kept thin — each subsystem lives in its module.

import * as path from "node:path";

import * as vscode from "vscode";

import { AgentSessionService } from "./agents/AgentSessionService.js";
import { ActivityPublisher } from "./bridge/ActivityPublisher.js";
import { BridgeManager } from "./bridge/BridgeManager.js";
import type { BridgeHandlers } from "./bridge/types.js";
import { AgentServiceLocator } from "./harness/AgentServiceLocator.js";
import { registerCommentEditingCommands } from "./comments/CommentSession.js";
import { resolveCommentAuthor } from "./comments/author.js";
import { Commands, ContextKeys, Schemes } from "./config.js";
import { GateCoordinator } from "./gate/GateCoordinator.js";
import { DiffService } from "./git/DiffService.js";
import { gitToplevel } from "./git/gitCli.js";
import { RepoService } from "./git/RepoService.js";
import { WorktreeService } from "./git/WorktreeService.js";
import { log } from "./log.js";
import { PlanContentProvider } from "./plan/PlanContentProvider.js";
import { PlanGateRegistry } from "./plan/PlanGateRegistry.js";
import { PlanReviewController } from "./plan/PlanReviewController.js";
import { canonicalize } from "./protocol/paths.js";
import { ReviewContentProvider } from "./review/ReviewContentProvider.js";
import { ReviewController } from "./review/ReviewController.js";
import { RecentRepoStore } from "./storage/RecentRepoStore.js";
import { ReviewStore } from "./storage/ReviewStore.js";
import { RepoSwitcher } from "./status/repoSwitcher.js";
import { StatusBarController } from "./status/StatusBarController.js";
import { MainTreeProvider } from "./views/MainTreeProvider.js";
import { WelcomePanel } from "./welcome/WelcomePanel.js";
import { exposeTestControlPlane } from "./testControlPlane.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Warm the comment-author cache (signed-in account → OS user → "Developer"); fire-and-forget.
  void resolveCommentAuthor();

  // Show the Welcome / onboarding webview once, on first install — the user sets up their agent
  // (installs the bundled plugin) from there. A version string lets a future bump re-show it as a
  // "what's new". Reopenable any time via paireto.openWelcome.
  const WELCOME_VERSION = "1";
  const welcomeMarker = "paireto.welcomeShownVersion";
  if (context.globalState.get<string>(welcomeMarker) !== WELCOME_VERSION) {
    void context.globalState.update(welcomeMarker, WELCOME_VERSION);
    WelcomePanel.show(context);
  }

  // Session-scoped panels start hidden; their context keys gate visibility (see package.json `when`).
  void vscode.commands.executeCommand("setContext", ContextKeys.reviewSessionActive, false);
  void vscode.commands.executeCommand("setContext", ContextKeys.planPending, false);

  // Core services.
  const locator = new AgentServiceLocator();
  const agents = new AgentSessionService(locator);
  const repoService = new RepoService();
  const worktrees = new WorktreeService();
  const recents = new RecentRepoStore(context.globalState);
  // Shared gate manager: several plans/reviews can be pending, one foreground at a time (switchable).
  const coordinator = new GateCoordinator();
  const planProvider = new PlanContentProvider();
  const planGate = new PlanGateRegistry();
  const planReview = new PlanReviewController(planProvider, planGate, coordinator, locator);
  const statusBar = new StatusBarController(repoService, agents);
  const activityPublisher = new ActivityPublisher(agents);

  // Code review (Phase 3).
  const diffService = new DiffService();
  const reviewContent = new ReviewContentProvider();
  const reviewStore = new ReviewStore(context.workspaceState);
  const reviewController = new ReviewController(
    repoService,
    diffService,
    reviewStore,
    reviewContent,
    coordinator,
  );

  const mainTree = new MainTreeProvider(
    agents,
    reviewController,
    planReview,
    repoService,
    coordinator,
    locator,
    context.extensionUri,
  );
  const switcher = new RepoSwitcher(repoService, worktrees, recents, context.extensionUri);

  // Drive which gate button shows: only Send Feedback once feedback is queued, only Approve before.
  // Recompute whenever the foreground gate switches or its comments change.
  const refreshGateFeedback = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      ContextKeys.gateHasFeedback,
      coordinator.current?.hasFeedback() ?? false,
    );
  };
  refreshGateFeedback();
  context.subscriptions.push(
    coordinator.onDidChange(refreshGateFeedback),
    planReview.onDidChange(refreshGateFeedback),
    reviewController.onDidChangeState(refreshGateFeedback),
  );

  context.subscriptions.push(
    { dispose: () => log.dispose() },
    agents,
    repoService,
    coordinator,
    planProvider,
    planReview,
    statusBar,
    activityPublisher,
    reviewContent,
    reviewController,
    mainTree,
    switcher,
    vscode.commands.registerCommand(Commands.focusAgent, () =>
      vscode.commands.executeCommand("workbench.action.terminal.focus"),
    ),
    vscode.commands.registerCommand(Commands.openWelcome, () => WelcomePanel.show(context)),
    // Shared gate outcomes dispatch to whichever flow (plan or review) is currently active.
    vscode.commands.registerCommand(Commands.gateApprove, () => coordinator.current?.approve()),
    vscode.commands.registerCommand(Commands.gateSendFeedback, () =>
      coordinator.current?.sendFeedback(),
    ),
    // Palette entry point: one action that submits queued feedback, or approves when there is none.
    vscode.commands.registerCommand(Commands.gateSubmit, () => {
      const gate = coordinator.current;
      if (!gate) {
        void vscode.window.showWarningMessage(
          "Paireto: nothing to submit — this command only works while an agent is awaiting your feedback on a Plan or Code Review.",
        );
        return;
      }
      if (gate.hasFeedback()) {
        gate.sendFeedback();
      } else {
        gate.approve();
      }
    }),
    registerCommentEditingCommands(),
    vscode.workspace.registerTextDocumentContentProvider(Schemes.plan, planProvider),
    vscode.workspace.registerFileSystemProvider(Schemes.review, reviewContent, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    mainTree.register(),
  );

  // Env-gated E2E test control plane (inert unless PAIRETO_TEST === "1"): read-only inspect + a
  // comment injector that re-dispatches through the real add-comment commands. Never in production.
  if (process.env.PAIRETO_TEST === "1") {
    context.subscriptions.push(
      exposeTestControlPlane({
        agents,
        coordinator,
        planReview,
        reviewController,
        repoService,
      }),
    );
  }

  // Tripwire: a review/stop request should only ever arrive for the repo this window serves. A
  // foreign repoRoot means the bridge targeted the wrong socket — log it (behavior unchanged).
  const warnForeignRepo = (repoRoot: string): void => {
    const mine = repoService.current()?.root.fsPath;
    if (mine && canonicalize(mine) !== canonicalize(repoRoot)) {
      log.info(
        `review request from foreign repoRoot ${canonicalize(repoRoot)}, this window serves ${canonicalize(mine)}`,
      );
    }
  };

  // Bridge: one socket per open repo, dispatching inbound messages to the services.
  const handlers: BridgeHandlers = {
    onHookEvent: (msg) => {
      // Map the raw harness event to the common representation at the boundary; an event the
      // strategy doesn't recognise (undefined) is simply dropped — nothing downstream sees it.
      // Render the unmappable event via the strategy (msg.event is the harness-dialect union, so its
      // fields aren't uniformly accessible here — the strategy knows its own dialect).
      const strategy = locator.strategyFor(msg.harness);
      const event = strategy.toAppEvent(msg.event, msg.meta);
      if (!event) {
        log.info(`hook event dropped (unmappable ${strategy.describeEvent(msg.event)})`);
        return;
      }
      agents.ingest(event, msg.repoRoot);
    },
    onPlanReviewRequest: (msg, signal) => {
      const strategy = locator.strategyFor(msg.harness);
      const event = strategy.toAppEvent(msg.event, msg.meta);
      if (!event) {
        // Unmappable plan-gate request — fail open (allow) so the agent isn't left blocked.
        log.info(`plan review allowed (unmappable ${strategy.describeEvent(msg.event)})`);
        return Promise.resolve({ decision: "allow" });
      }
      if (agents.isMuted(event.sessionId)) {
        log.info(`plan review skipped for muted session ${event.sessionId.slice(0, 8)}`);
        return Promise.resolve({ decision: "allow" });
      }

      // On disconnect (interrupt/crash) there's no Stop hook — return the agent to idle so its
      // activity indicator doesn't stay stuck on "awaiting plan review".
      signal.addEventListener("abort", () => agents.markIdleOnDisconnect(event.sessionId), {
        once: true,
      });
      return planReview.presentPlan(event, msg.repoRoot, signal);
    },
    onReviewAwait: (msg, signal) => {
      warnForeignRepo(msg.repoRoot);
      // Reviews carry no sessionId reliably; attribute to the most-recently-active session in the
      // request's repo so the Agents panel can show "awaiting review" on the right row.
      const sessionId = msg.sessionId ?? agents.mostRecentSessionForRepo(msg.repoRoot);
      if (sessionId) {
        // We do not honour muted here because this event is a manual user action (Skill → Review)

        // Likewise reset the agent to idle if its review connection drops.
        signal.addEventListener("abort", () => agents.markIdleOnDisconnect(sessionId), {
          once: true,
        });
      }
      return reviewController.startSession(msg.id, sessionId, signal);
    },
    onStopGate: (msg, signal) => {
      warnForeignRepo(msg.repoRoot);
      const strategy = locator.strategyFor(msg.harness);
      const event = strategy.toAppEvent(msg.event, msg.meta);
      if (!event) {
        // Unmappable stop-gate request — fail open (allow the stop) so the agent isn't left blocked.
        log.info(`stop gate allowed (unmappable ${strategy.describeEvent(msg.event)})`);
        return Promise.resolve({ block: false });
      }
      // Fires on every turn-end. Resolves "allow" instantly unless a review is warranted for this
      // session (the turn touched files, a deferred review is open, or feedback is queued).
      const sessionId = event.sessionId ?? agents.mostRecentSessionForRepo(msg.repoRoot);
      if (agents.isMuted(sessionId)) {
        log.info(`stop gate skipped for muted session ${sessionId?.slice(0, 8) ?? "unknown"}`);
        return Promise.resolve({ block: false });
      }

      // This Stop event's own background-task/session-cron counts (this request arrives on a
      // separate connection from the passive hook.event Stop — feed AgentSession before querying it
      // so both paths agree on one piece of state, per AgentSessionService.noteBackgroundWork).
      agents.noteBackgroundWork(sessionId, event);
      const turn = agents.turnState(sessionId);

      // A subagent/background task is believed still pending — the agent isn't really done, it'll
      // emit a real final Stop later. Decide this HERE, using AgentSession's own owned state, before
      // ever calling into the review flow — ReviewController.awaitStopOutcome only ever needs to
      // reason about whether THIS turn's edits/comments warrant a review, nothing about subagents.
      if (turn.hasPendingWork) {
        log.info(
          `review gate skipped for agent ${sessionId?.slice(0, 8) ?? "unknown"}: subagent/background work still pending`,
        );
        return Promise.resolve({ block: false });
      }
      return reviewController.awaitStopOutcome(
        sessionId,
        turn.changedThisTurn,
        strategy.displayName,
        signal,
      );
    },

    // The MCP server holds a liveness connection per session; when the last one drops, the agent
    // process has died (handles hard kills / terminal close, which fire no SessionEnd hook).
    onSessionAttached: (sessionId) => agents.attachSession(sessionId),
    onSessionDetached: (sessionId) => agents.detachSession(sessionId),
  };

  const bridge = new BridgeManager(handlers, locator);
  context.subscriptions.push({ dispose: () => bridge.dispose() });
  context.subscriptions.push({ dispose: () => planGate.drain({ decision: "allow" }) });
  context.subscriptions.push({ dispose: () => reviewController.drainGate() });

  await repoService.init();
  void reviewController.refresh("init"); // after init so the first model has a real repo

  // One socket per open workspace folder, keyed by that folder's REAL git toplevel — resolved
  // independently via the git CLI (mirroring exactly what the hook scripts compute in
  // bridge.js's gitToplevel), never trusted from vscode.git's own repository auto-detection. A
  // mismatch between the two (e.g. a worktree window whose vscode.git reports its main repo's
  // root) previously bound the wrong socket identity with no diagnostic trail. Toplevel doesn't
  // change when a repo's working tree does, so this only re-runs on folder add/remove, not on
  // every repoService change.
  const servedToplevels = new Map<string, string>(); // workspace folder fsPath -> resolved toplevel

  const serveFolder = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    const toplevel = await gitToplevel(folder.uri.fsPath);
    if (!toplevel) {
      return;
    }
    servedToplevels.set(folder.uri.fsPath, toplevel);
    await bridge.ensureServerFor(toplevel);
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void serveFolder(folder);
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        void serveFolder(folder);
      }
      for (const folder of e.removed) {
        const toplevel = servedToplevels.get(folder.uri.fsPath);
        servedToplevels.delete(folder.uri.fsPath);
        if (toplevel && ![...servedToplevels.values()].includes(toplevel)) {
          bridge.removeServerFor(toplevel);
        }
      }
    }),
  );

  context.subscriptions.push(
    repoService.onDidChange(() => {
      void reviewController.refresh("git"); // the git extension is our sole working-tree/index signal
    }),
  );

  const current = repoService.current();
  if (current) {
    void recents.touch(current.root.fsPath);
  }

  // (The repo switcher registers its own commands; see RepoSwitcher.)

  console.log("paireto active:", path.basename(context.extensionUri.fsPath));
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions handle teardown (sockets, index entries).
}
