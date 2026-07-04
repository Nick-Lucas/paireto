// Activation entry point: constructs the services, wires the bridge handlers, registers commands
// and providers, and serves a socket per open repo. Kept thin — each subsystem lives in its module.

import * as path from "node:path";

import * as vscode from "vscode";

import { AgentSessionService } from "./agents/AgentSessionService.js";
import { ActivityPublisher } from "./bridge/ActivityPublisher.js";
import { BridgeManager } from "./bridge/BridgeManager.js";
import type { BridgeHandlers } from "./bridge/types.js";
import { registerCommentEditingCommands } from "./comments/CommentSession.js";
import { resolveCommentAuthor } from "./comments/author.js";
import { Commands, ContextKeys, Schemes } from "./config.js";
import { GateCoordinator } from "./gate/GateCoordinator.js";
import { DiffService } from "./git/DiffService.js";
import { RepoService } from "./git/RepoService.js";
import { WorktreeService } from "./git/WorktreeService.js";
import { log } from "./log.js";
import { NotificationController } from "./notify/NotificationController.js";
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
  const agents = new AgentSessionService();
  const repoService = new RepoService();
  const worktrees = new WorktreeService();
  const recents = new RecentRepoStore(context.globalState);
  // Shared gate manager: several plans/reviews can be pending, one foreground at a time (switchable).
  const coordinator = new GateCoordinator();
  const planProvider = new PlanContentProvider();
  const planGate = new PlanGateRegistry();
  const planReview = new PlanReviewController(planProvider, planGate, coordinator);
  const statusBar = new StatusBarController(repoService, agents);
  // Ping the user when one of this window's agents needs them; publish activity for other windows.
  const notifications = new NotificationController(agents);
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
    notifications,
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
      agents.ingest(msg);
    },
    onPlanReviewRequest: (msg, signal) => {
      // On disconnect (interrupt/crash) there's no Stop hook — return the agent to idle so its
      // activity indicator doesn't stay stuck on "awaiting plan review".
      signal.addEventListener("abort", () => agents.markIdleOnDisconnect(msg.sessionId), {
        once: true,
      });
      return planReview.presentPlan(msg, signal);
    },
    onReviewAwait: (msg, signal) => {
      warnForeignRepo(msg.repoRoot);
      // Reviews carry no sessionId reliably; attribute to the most-recently-active session in the
      // request's repo so the Agents panel can show "awaiting review" on the right row.
      const sessionId = msg.sessionId ?? agents.mostRecentSessionForRepo(msg.repoRoot);
      if (sessionId) {
        // Likewise reset the agent to idle if its review connection drops.
        signal.addEventListener("abort", () => agents.markIdleOnDisconnect(sessionId), {
          once: true,
        });
      }
      return reviewController.startSession(msg.id, sessionId, signal);
    },
    onStopGate: (msg, signal) => {
      warnForeignRepo(msg.repoRoot);
      // Fires on every turn-end. Resolves "allow" instantly unless a review is warranted for this
      // session (the turn touched files, a deferred review is open, or feedback is queued).
      const sessionId = msg.sessionId ?? agents.mostRecentSessionForRepo(msg.repoRoot);
      return reviewController.awaitStopOutcome(
        sessionId,
        agents.didChangeThisTurn(sessionId),
        signal,
      );
    },
    // The MCP server holds a liveness connection per session; when the last one drops, the agent
    // process has died (handles hard kills / terminal close, which fire no SessionEnd hook).
    onSessionAttached: (sessionId) => agents.attachSession(sessionId),
    onSessionDetached: (sessionId) => agents.detachSession(sessionId),
  };
  const bridge = new BridgeManager(handlers);
  context.subscriptions.push({ dispose: () => bridge.dispose() });
  context.subscriptions.push({ dispose: () => planGate.drain({ decision: "allow" }) });
  context.subscriptions.push({ dispose: () => reviewController.drainGate() });

  await repoService.init();
  void reviewController.refresh("init"); // after init so the first model has a real repo

  const serveOpenRepos = (): void => {
    for (const repo of repoService.repositories) {
      void bridge.ensureServerFor(repo.root.fsPath);
    }
  };
  serveOpenRepos();
  context.subscriptions.push(
    repoService.onDidChange(() => {
      serveOpenRepos();
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
