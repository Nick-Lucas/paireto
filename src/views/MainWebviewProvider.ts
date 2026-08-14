import * as vscode from "vscode";

import type { AgentSession } from "../agents/AgentSession.js";
import type { AgentSessionService } from "../agents/AgentSessionService.js";
import { Commands, Views } from "../config.js";
import type { GateCoordinator } from "../gate/GateCoordinator.js";
import type { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import type { PlanReviewController } from "../plan/PlanReviewController.js";
import type { ReviewController } from "../review/ReviewController.js";
import type { AgentInstallStatus } from "../welcome/AgentInstallStatus.js";
import { buildSidebarState, computeViewBadge, type SidebarSnapshot } from "./sidebarModel.js";
import type {
  SidebarAction,
  SidebarActionTarget,
  SidebarNode,
  SidebarOperation,
  SidebarState,
  SidebarWebviewMessage,
} from "./sidebarProtocol.js";

type AgentCommandArg = AgentSession | { session: AgentSession };

function commandSession(argument: AgentCommandArg): AgentSession {
  return "session" in argument ? argument.session : argument;
}

export class MainWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private viewSubscriptions: vscode.Disposable[] = [];
  private activeDiff?: SidebarSnapshot["activeDiff"];
  private currentState?: SidebarState;

  constructor(
    private readonly agents: AgentSessionService,
    private readonly review: ReviewController,
    private readonly plan: PlanReviewController,
    private readonly coordinator: GateCoordinator,
    private readonly locator: AgentServiceLocator,
    private readonly installStatus: AgentInstallStatus,
    private readonly extensionUri: vscode.Uri,
  ) {
    const refresh = (): void => this.postState();
    const contextCommand = (command: string, operation: SidebarOperation): vscode.Disposable =>
      vscode.commands.registerCommand(command, (context: unknown) =>
        this.runContextAction(operation, context),
      );
    this.subscriptions.push(
      this.agents.onDidChange(refresh),
      this.review.onDidChangeState(refresh),
      this.plan.onDidChange(refresh),
      this.installStatus.onDidChange(refresh),
      this.coordinator.onDidChange(refresh),
      this.review.onDidChangeActiveDiff((target) => {
        this.activeDiff = this.review.getState().guided ? undefined : target;
        this.postState();
      }),
      vscode.commands.registerCommand(Commands.agentSwitch, (argument: AgentCommandArg) =>
        this.switchToAgent(commandSession(argument)),
      ),
      vscode.commands.registerCommand(Commands.agentHide, (argument: AgentCommandArg) =>
        this.agents.setMuted(commandSession(argument).sessionId, true),
      ),
      vscode.commands.registerCommand(Commands.agentShow, (argument: AgentCommandArg) =>
        this.agents.setMuted(commandSession(argument).sessionId, false),
      ),
      contextCommand(Commands.sidebarOpenFile, "openFile"),
      contextCommand(Commands.sidebarOpenDiff, "openDiff"),
      contextCommand(Commands.sidebarStage, "stageFiles"),
      contextCommand(Commands.sidebarUnstage, "unstageFiles"),
      contextCommand(Commands.sidebarDiscard, "discardFiles"),
      contextCommand(Commands.sidebarStageChangeset, "stageChangeset"),
      contextCommand(Commands.sidebarUnstageChangeset, "unstageChangeset"),
      contextCommand(Commands.sidebarDeleteComment, "deleteComment"),
    );
  }

  register(): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider(Views.main, this);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeViewSubscriptions();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.file(vscode.env.appRoot),
      ],
    };
    view.webview.html = this.html(view.webview);
    this.viewSubscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => void this.onMessage(message)),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined;
          this.disposeViewSubscriptions();
        }
      }),
    );
    this.postState();
  }

  private switchToAgent(session: AgentSession): void {
    this.agents.clearAttention(session.sessionId);
    const entry = this.coordinator.entryForSession(session.sessionId);
    if (entry) {
      void this.coordinator.switchTo(entry.id);
      return;
    }
    void vscode.commands.executeCommand("workbench.action.terminal.focus");
  }

  private snapshot(): SidebarSnapshot {
    const agents = this.agents
      .allSessions()
      .filter((session) => session.state !== "ended")
      .map((session) => {
        const entry = this.coordinator.entryForSession(session.sessionId);
        return {
          sessionId: session.sessionId,
          displayName: this.locator.strategyFor(session.harness).displayName,
          repoRoot: session.repoRoot,
          state: session.state,
          startedAt: session.startedAt,
          lastEventAt: session.lastEventAt,
          lastTool: session.lastTool,
          needsAttention: session.needsAttention,
          muted: session.muted,
          gate: entry
            ? { kind: entry.kind, foreground: this.coordinator.isForeground(entry.id) }
            : undefined,
        };
      });
    return {
      setupPrompt: this.installStatus.prompt(),
      agents,
      review: this.review.getState(),
      planPending: this.plan.hasPendingPlan(),
      planComments: this.plan.getComments(),
      reviewSessionActive: this.review.isSessionActive(),
      reviewComments: this.review.getComments(),
      activeDiff: this.activeDiff,
    };
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const state = buildSidebarState(this.snapshot());
    this.currentState = state;
    this.updateBadge(state);
    void this.view.webview.postMessage({ type: "state", state });
  }

  private updateBadge(state: SidebarState): void {
    if (this.view) {
      this.view.badge = computeViewBadge(state.badge);
    }
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isWebviewMessage(message)) {
      return;
    }
    if (message.type === "requestState") {
      this.postState();
      return;
    }
    await this.runAction(message.action);
  }

  private async runContextAction(operation: SidebarOperation, context: unknown): Promise<void> {
    const nodeId = sidebarNodeId(context);
    if (!nodeId || !this.currentState) {
      return;
    }
    const node = findNode(this.currentState.nodes, nodeId);
    const action = node?.menuActions?.find((candidate) => candidate.operation === operation);
    if (action) {
      await this.runAction(action);
    }
  }

  private async runAction(action: SidebarAction): Promise<void> {
    switch (action.operation) {
      case "openWelcome":
        await vscode.commands.executeCommand(Commands.openWelcome);
        return;
      case "pickCompareTo":
        await vscode.commands.executeCommand(Commands.reviewPickCompareTo);
        return;
      case "toggleLayout":
        await vscode.commands.executeCommand(Commands.reviewToggleLayout);
        return;
      case "focusAgent":
        await vscode.commands.executeCommand(Commands.focusAgent);
        return;
      case "switchAgent":
      case "hideAgent":
      case "showAgent": {
        const session = this.sessionFrom(action.target);
        if (!session) {
          return;
        }
        const command =
          action.operation === "switchAgent"
            ? Commands.agentSwitch
            : action.operation === "hideAgent"
              ? Commands.agentHide
              : Commands.agentShow;
        await vscode.commands.executeCommand(command, session);
        return;
      }
      case "openDiff":
      case "openFile": {
        const file = fileFrom(action.target);
        if (!file) {
          return;
        }
        await vscode.commands.executeCommand(
          action.operation === "openDiff" ? Commands.reviewOpenDiff : Commands.reviewOpenFile,
          file,
        );
        return;
      }
      case "stageFiles":
      case "unstageFiles":
      case "discardFiles": {
        const files = this.filesFrom(action.target);
        if (!files) {
          return;
        }
        const command =
          action.operation === "stageFiles"
            ? Commands.reviewStage
            : action.operation === "unstageFiles"
              ? Commands.reviewUnstage
              : Commands.reviewDiscard;
        await vscode.commands.executeCommand(command, files);
        return;
      }
      case "openReviewPlan":
        await vscode.commands.executeCommand(Commands.guidedReviewOpenPlan);
        return;
      case "openChangeset":
      case "stageChangeset":
      case "unstageChangeset": {
        const changesetId = changesetFrom(action.target);
        if (!changesetId) {
          return;
        }
        const command =
          action.operation === "openChangeset"
            ? Commands.guidedReviewOpenChangeset
            : action.operation === "stageChangeset"
              ? Commands.reviewStageAll
              : Commands.reviewUnstageAll;
        await vscode.commands.executeCommand(command, { changesetId });
        return;
      }
      case "openPlannedFile": {
        if (action.target?.kind !== "plannedFile") {
          return;
        }
        await vscode.commands.executeCommand(Commands.guidedReviewOpenFile, {
          changesetId: action.target.changesetId,
          path: action.target.path,
        });
        return;
      }
      case "revealComment":
      case "deleteComment": {
        const id = commentFrom(action.target);
        if (!id) {
          return;
        }
        await vscode.commands.executeCommand(
          action.operation === "revealComment"
            ? Commands.reviewRevealComment
            : Commands.reviewDeleteComment,
          { id },
        );
      }
    }
  }

  private sessionFrom(target: SidebarActionTarget | undefined): AgentSession | undefined {
    if (target?.kind !== "agent") {
      return undefined;
    }
    return this.agents.allSessions().find((session) => session.sessionId === target.sessionId);
  }

  private filesFrom(target: SidebarActionTarget | undefined) {
    if (target?.kind === "file") {
      return [target.file];
    }
    if (target?.kind !== "files") {
      return undefined;
    }
    const files = this.review
      .getState()
      .repositories.find((repository) => repository.repoRoot === target.repoRoot)?.changes[
      target.group
    ];
    if (!target.pathPrefix) {
      return files;
    }
    const prefix = `${target.pathPrefix}/`;
    return files?.filter((file) => file.path.startsWith(prefix));
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar.css"),
    );
    const codiconFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), "out", "media", "codicon.ttf"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">@font-face { font-family: codicon; font-display: block; src: url("${codiconFontUri}") format("truetype"); }</style>
  <link href="${styleUri}" rel="stylesheet" />
  <title>Paireto</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private disposeViewSubscriptions(): void {
    for (const subscription of this.viewSubscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  dispose(): void {
    this.disposeViewSubscriptions();
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.view = undefined;
  }
}

function fileFrom(target: SidebarActionTarget | undefined) {
  return target?.kind === "file" ? target.file : undefined;
}

function sidebarNodeId(context: unknown): string | undefined {
  if (!context || typeof context !== "object" || !("pairetoSidebarNodeId" in context)) {
    return undefined;
  }
  return typeof context.pairetoSidebarNodeId === "string"
    ? context.pairetoSidebarNodeId
    : undefined;
}

function findNode(nodes: SidebarNode[], id: string): SidebarNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const child = node.children && findNode(node.children, id);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function changesetFrom(target: SidebarActionTarget | undefined): string | undefined {
  return target?.kind === "changeset" ? target.changesetId : undefined;
}

function commentFrom(target: SidebarActionTarget | undefined): string | undefined {
  return target?.kind === "comment" ? target.id : undefined;
}

function isWebviewMessage(value: unknown): value is SidebarWebviewMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  if (value.type === "requestState") {
    return true;
  }
  return value.type === "runAction" && "action" in value && isAction(value.action);
}

function isAction(value: unknown): value is SidebarAction {
  return (
    !!value &&
    typeof value === "object" &&
    "operation" in value &&
    typeof value.operation === "string" &&
    "label" in value &&
    typeof value.label === "string" &&
    "icon" in value &&
    typeof value.icon === "string"
  );
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index++) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return nonce;
}
