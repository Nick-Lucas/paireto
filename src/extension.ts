// Activation entry point: constructs the services, wires the bridge handlers, registers commands
// and providers, and serves a socket per open repo. Kept thin — each subsystem lives in its module.

import * as path from "node:path";

import * as vscode from "vscode";

import { AgentSessionService } from "./agents/AgentSessionService.js";
import { BridgeManager } from "./bridge/BridgeManager.js";
import { DEFAULT_CONFIG, writeConfigMirror } from "./bridge/ConfigMirror.js";
import { installPlugin, PLUGIN_VERSION } from "./bridge/PluginInstaller.js";
import type { BridgeConfig, BridgeHandlers } from "./bridge/types.js";
import { registerCommentEditingCommands } from "./comments/CommentSession.js";
import { Commands, ContextKeys, Schemes } from "./config.js";
import { GateCoordinator } from "./gate/GateCoordinator.js";
import { DiffService } from "./git/DiffService.js";
import { RepoService } from "./git/RepoService.js";
import { WorktreeService } from "./git/WorktreeService.js";
import { PlanContentProvider } from "./plan/PlanContentProvider.js";
import { PlanGateRegistry } from "./plan/PlanGateRegistry.js";
import { PlanReviewController } from "./plan/PlanReviewController.js";
import { ReviewContentProvider } from "./review/ReviewContentProvider.js";
import { ReviewController } from "./review/ReviewController.js";
import { RecentRepoStore } from "./storage/RecentRepoStore.js";
import { ReviewStore } from "./storage/ReviewStore.js";
import { RepoSwitcher } from "./status/repoSwitcher.js";
import { StatusBarController } from "./status/StatusBarController.js";
import { MainTreeProvider } from "./views/MainTreeProvider.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 1. Mirror fail-mode config for the (settings-blind) hook scripts.
  const config = readConfig();
  try {
    writeConfigMirror(config);
  } catch (err) {
    console.error("tui-companion: failed to write config mirror", err);
  }

  // 2. Best-effort plugin install/registration via the claude CLI (once per version, non-blocking).
  if (vscode.workspace.getConfiguration("tui-companion").get<boolean>("plugin.autoInstall", true)) {
    const marker = "tui.pluginInstalledVersion";
    if (context.globalState.get<string>(marker) !== PLUGIN_VERSION) {
      const pluginsRoot = vscode.Uri.joinPath(context.extensionUri, "plugins").fsPath;
      void installPlugin(pluginsRoot).then(async (result) => {
        console.log(`tui-companion: plugin install — ${result.detail}`);
        if (result.ok) {
          await context.globalState.update(marker, PLUGIN_VERSION);
        } else if (result.manualCommand) {
          const choice = await vscode.window.showWarningMessage(
            "TUI Companion couldn't auto-install its Claude Code plugin. Register it manually?",
            "Copy Command",
          );
          if (choice === "Copy Command") {
            await vscode.env.clipboard.writeText(result.manualCommand);
            void vscode.window.showInformationMessage(
              "Command copied. Run it in a terminal, then restart Claude Code.",
            );
          }
        }
      });
    }
  }

  // Session-scoped panels start hidden; their context keys gate visibility (see package.json `when`).
  void vscode.commands.executeCommand("setContext", ContextKeys.reviewSessionActive, false);
  void vscode.commands.executeCommand("setContext", ContextKeys.planPending, false);

  // 3. Core services.
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
  const switcher = new RepoSwitcher(repoService, worktrees, recents);

  context.subscriptions.push(
    agents,
    repoService,
    coordinator,
    planProvider,
    planReview,
    statusBar,
    reviewContent,
    reviewController,
    mainTree,
    switcher,
    vscode.commands.registerCommand(Commands.focusAgent, () =>
      vscode.commands.executeCommand("workbench.action.terminal.focus"),
    ),
    // Shared gate outcomes dispatch to whichever flow (plan or review) is currently active.
    vscode.commands.registerCommand(Commands.gateApprove, () => coordinator.current?.approve()),
    vscode.commands.registerCommand(Commands.gateSendFeedback, () =>
      coordinator.current?.sendFeedback(),
    ),
    registerCommentEditingCommands(),
    vscode.workspace.registerTextDocumentContentProvider(Schemes.plan, planProvider),
    vscode.workspace.registerFileSystemProvider(Schemes.review, reviewContent, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    mainTree.register(),
  );

  // 4. Bridge: one socket per open repo, dispatching inbound messages to the services.
  const handlers: BridgeHandlers = {
    onHookEvent: (msg) => {
      agents.ingest(msg);
      if (msg.event === "WorktreeCreate" || msg.event === "WorktreeRemove") {
        worktrees.invalidate(msg.repoRoot);
      }
    },
    onPlanReviewRequest: (msg, signal) => planReview.presentPlan(msg, signal),
    onReviewAwait: (msg, signal) => {
      // Reviews carry no sessionId reliably; attribute to the most-recently-active session in the
      // request's repo so the Agents panel can show "awaiting review" on the right row.
      const sessionId = msg.sessionId ?? agents.mostRecentSessionForRepo(msg.repoRoot);
      return reviewController.startSession(msg.id, sessionId, signal);
    },
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

  console.log("tui-companion active:", path.basename(context.extensionUri.fsPath));
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions handle teardown (sockets, index entries).
}

function readConfig(): BridgeConfig {
  const cfg = vscode.workspace.getConfiguration("tui-companion");
  const gate = DEFAULT_CONFIG.planGate;
  return {
    planGate: {
      onUnavailable: cfg.get("planGate.onUnavailable", gate.onUnavailable),
      onTimeout: cfg.get("planGate.onTimeout", gate.onTimeout),
      onMalformed: cfg.get("planGate.onMalformed", gate.onMalformed),
      timeoutSeconds: cfg.get("planGate.timeoutSeconds", gate.timeoutSeconds),
    },
  };
}
