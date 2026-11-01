import * as crypto from "node:crypto";

import * as vscode from "vscode";

import { Commands, StateKeys } from "../config.js";
import { log } from "../log.js";
import type { ReviewController } from "../review/ReviewController.js";
import type { SeenFiles } from "../review/SeenFiles.js";
import type { SourceSpan } from "./core/model.js";
import {
  DEFAULT_VIEW_STATE,
  type HostMessage,
  type UmlViewState,
  type WebviewMessage,
} from "./core/protocol.js";
import { UmlModelBuilder, type BuiltModel } from "./modelBuilder.js";
import { resetReview } from "./resetReview.js";

const REBUILD_DELAY_MS = 250;

export class UmlDiffPanel {
  private static current: UmlDiffPanel | undefined;

  static show(context: vscode.ExtensionContext, review: ReviewController, seen: SeenFiles): void {
    if (UmlDiffPanel.current) {
      UmlDiffPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "paireto.umlDiff",
      "UML Diff",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "paireto.svg");
    UmlDiffPanel.current = new UmlDiffPanel(panel, context, review, seen);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly builder: UmlModelBuilder;
  private readonly memberLines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("focusBorder"),
    overviewRulerColor: new vscode.ThemeColor("focusBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private marked?: vscode.TextEditor;
  private built?: BuiltModel;
  private timer?: ReturnType<typeof setTimeout>;
  private building = false;
  private pending = false;
  private ready = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly review: ReviewController,
    private readonly seen: SeenFiles,
  ) {
    this.builder = new UmlModelBuilder(review, seen);
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.memberLines,
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
      this.review.onDidChangeState(() => this.schedule()),
      this.seen.onDidChange(() => this.schedule()),
    );
  }

  private dispose(): void {
    UmlDiffPanel.current = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private viewState(): UmlViewState {
    return {
      ...DEFAULT_VIEW_STATE,
      ...this.context.workspaceState.get<Partial<UmlViewState>>(StateKeys.umlView, {}),
    };
  }

  private schedule(): void {
    if (!this.ready) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.rebuild(), REBUILD_DELAY_MS);
  }

  private async rebuild(): Promise<void> {
    if (this.building) {
      this.pending = true;
      return;
    }
    this.building = true;
    try {
      this.built = await this.builder.build((message) => this.post({ type: "loading", message }));
      this.post({ type: "model", model: this.built.model });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[uml] model build failed: ${message}`);
      this.post({ type: "error", message });
    } finally {
      this.building = false;
      if (this.pending) {
        this.pending = false;
        void this.rebuild();
      }
    }
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.post({ type: "init", state: this.viewState() });
        this.post({ type: "loading", message: "Reading the changes…" });
        await this.rebuild();
        return;
      case "refresh":
        this.builder.clearCaches();
        await vscode.commands.executeCommand(Commands.reviewRefresh);
        await this.rebuild();
        return;
      case "pickCompareTo":
        await vscode.commands.executeCommand(Commands.reviewPickCompareTo);
        return;
      case "viewState":
        await this.context.workspaceState.update(StateKeys.umlView, msg.state);
        return;
      case "setRead": {
        const delta = this.built?.deltas.get(msg.fileKey);
        if (delta) {
          await this.seen.setSeen([delta], msg.read);
        }
        return;
      }
      case "resetReview":
        await resetReview(this.seen, [...(this.built?.deltas.values() ?? [])], (message, action) =>
          vscode.window.showWarningMessage(message, { modal: true }, action),
        );
        return;
      case "open":
        await this.open(msg.typeId, msg.memberId);
        return;
      case "openFile": {
        const delta = this.built?.deltas.get(msg.fileKey);
        const file = this.built?.model.files.find((f) => f.key === msg.fileKey);
        if (delta) {
          await this.review.openAgainstCompareToAt(
            delta.layers[0],
            file?.changes[msg.change ?? 0] ?? { side: "modified", start: 0, end: 0 },
          );
        }
        return;
      }
    }
  }

  private async open(typeId: string, memberId: string | undefined): Promise<void> {
    const built = this.built;
    const type = built?.model.types.find((t) => t.id === typeId);
    if (!built || !type) {
      return;
    }
    const context = built.contextLocations.get(typeId);
    if (context) {
      const position = new vscode.Position(context.line, 0);
      await vscode.window.showTextDocument(context.uri, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: true,
        selection: new vscode.Range(position, position),
      });
      return;
    }
    const delta = built.deltas.get(type.fileKey);
    if (!delta) {
      return;
    }
    const span = this.spanOf(typeId, memberId);
    if (!span) {
      return;
    }
    const editor = await this.review.openAgainstCompareToAt(delta.layers[0], span);
    this.markLines(editor, memberId ? span : undefined);
  }

  private spanOf(typeId: string, memberId: string | undefined): SourceSpan | undefined {
    const built = this.built;
    const type = built?.model.types.find((t) => t.id === typeId);
    if (!built || !type) {
      return undefined;
    }
    const member = type.members.find((m) => m.id === memberId);
    if (member) {
      return member.span;
    }
    if (type.kind === "module" || type.kind === "file" || !type.span) {
      const file = built.model.files.find((f) => f.key === type.fileKey);
      return file?.changes[0] ?? { side: "modified", start: 0, end: 0 };
    }
    return type.span;
  }

  private markLines(editor: vscode.TextEditor | undefined, span: SourceSpan | undefined): void {
    this.marked?.setDecorations(this.memberLines, []);
    this.marked = editor;
    if (!editor || !span) {
      return;
    }
    const last = editor.document.lineCount - 1;
    editor.setDecorations(this.memberLines, [
      new vscode.Range(Math.min(span.start, last), 0, Math.min(span.end, last), 0),
    ]);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString("base64");
    const dist = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", file));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${dist("uml.css")}" rel="stylesheet" />
  <title>UML Diff</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${dist("uml.js")}"></script>
</body>
</html>`;
  }
}
