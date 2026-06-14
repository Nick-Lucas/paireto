// Activation entry point: constructs the services, wires the bridge handlers, registers commands
// and providers, and serves a socket per open repo. Kept thin — each subsystem lives in its module.

import * as path from "node:path";

import * as vscode from "vscode";

import { AgentSessionService } from "./agents/AgentSessionService.js";
import { BridgeManager } from "./bridge/BridgeManager.js";
import { DEFAULT_CONFIG, writeConfigMirror } from "./bridge/ConfigMirror.js";
import { installPlugin, PLUGIN_VERSION } from "./bridge/PluginInstaller.js";
import type { BridgeConfig, BridgeHandlers } from "./bridge/types.js";
import { Schemes, Views } from "./config.js";
import { DiffService } from "./git/DiffService.js";
import { RepoService } from "./git/RepoService.js";
import { WorktreeService } from "./git/WorktreeService.js";
import { PlanContentProvider } from "./plan/PlanContentProvider.js";
import { PlanGateRegistry } from "./plan/PlanGateRegistry.js";
import { PlanReviewController } from "./plan/PlanReviewController.js";
import { ReviewContentProvider } from "./review/ReviewContentProvider.js";
import { ReviewController } from "./review/ReviewController.js";
import { ReviewFeedbackQueue } from "./review/ReviewFeedbackQueue.js";
import { ReviewFileDecorationProvider } from "./review/ReviewFileDecorationProvider.js";
import {
  ReviewFeedbackProvider,
  ReviewFilesProvider,
  reviewSummary,
} from "./review/reviewViews.js";
import { RecentRepoStore } from "./storage/RecentRepoStore.js";
import { ReviewStore } from "./storage/ReviewStore.js";
import { RepoSwitcher } from "./status/repoSwitcher.js";
import { StatusBarController } from "./status/StatusBarController.js";

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
            "Copy Command"
          );
          if (choice === "Copy Command") {
            await vscode.env.clipboard.writeText(result.manualCommand);
            void vscode.window.showInformationMessage(
              "Command copied. Run it in a terminal, then restart Claude Code."
            );
          }
        }
      });
    }
  }

  // 3. Core services.
  const agents = new AgentSessionService();
  const repoService = new RepoService();
  const worktrees = new WorktreeService();
  const recents = new RecentRepoStore(context.globalState);
  const planProvider = new PlanContentProvider();
  const planGate = new PlanGateRegistry();
  const planReview = new PlanReviewController(planProvider, planGate);
  const reviewFeedback = new ReviewFeedbackQueue();
  const statusBar = new StatusBarController(repoService, agents);

  // Code review (Phase 3).
  const diffService = new DiffService();
  const reviewContent = new ReviewContentProvider();
  const reviewStore = new ReviewStore(context.workspaceState);
  const reviewController = new ReviewController(
    repoService,
    diffService,
    reviewContent,
    reviewStore,
    agents,
    reviewFeedback,
  );
  const filesTree = new ReviewFilesProvider(reviewController);
  const feedbackTree = new ReviewFeedbackProvider(reviewController);
  const fileDecorations = new ReviewFileDecorationProvider();
  const switcher = new RepoSwitcher(repoService, worktrees, recents);

  const reviewView = vscode.window.createTreeView(Views.review, { treeDataProvider: filesTree });
  const syncReviewSummary = (): void => {
    reviewView.description = reviewSummary(reviewController.getState().spec);
  };
  syncReviewSummary();

  // Re-apply file decorations and the title summary whenever review state updates.
  context.subscriptions.push(
    reviewController.onDidChangeState(() => {
      fileDecorations.refresh();
      syncReviewSummary();
    })
  );

  context.subscriptions.push(
    agents,
    repoService,
    planProvider,
    planReview,
    statusBar,
    reviewContent,
    reviewController,
    filesTree,
    feedbackTree,
    fileDecorations,
    switcher,
    reviewView,
    vscode.workspace.registerTextDocumentContentProvider(Schemes.plan, planProvider),
    vscode.workspace.registerTextDocumentContentProvider(Schemes.review, reviewContent),
    vscode.window.registerFileDecorationProvider(fileDecorations),
    vscode.window.createTreeView(Views.reviewFeedback, { treeDataProvider: feedbackTree }),
  );
  void reviewController.refresh();

  // 4. Bridge: one socket per open repo, dispatching inbound messages to the services.
  const handlers: BridgeHandlers = {
    onHookEvent: (msg) => {
      agents.ingest(msg);
      if (msg.event === "WorktreeCreate" || msg.event === "WorktreeRemove") {
        worktrees.invalidate(msg.repoRoot);
      }
    },
    onPlanReviewRequest: (msg) => planReview.presentPlan(msg),
    onFeedbackPull: (msg) => reviewFeedback.pull(msg.sessionId),
  };
  const bridge = new BridgeManager(handlers);
  context.subscriptions.push({ dispose: () => bridge.dispose() });
  context.subscriptions.push({ dispose: () => planGate.drain({ decision: "allow" }) });

  await repoService.init();

  const serveOpenRepos = (): void => {
    for (const repo of repoService.repositories) {
      void bridge.ensureServerFor(repo.root.fsPath);
    }
  };
  serveOpenRepos();
  context.subscriptions.push(
    repoService.onDidChange(() => {
      serveOpenRepos();
      void reviewController.refresh();
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
