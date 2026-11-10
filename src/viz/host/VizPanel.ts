import * as crypto from "node:crypto";

import * as vscode from "vscode";
import { z } from "zod";

import { VizFileRef } from "../../protocol/viz.js";
import type { HostToWebview, WebviewToHost } from "../protocol.js";

export const VIZ_VIEW_TYPE = "paireto.viz";

const WebviewMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("open"), file: VizFileRef, mode: z.enum(["file", "diff"]) }),
  z.object({ type: z.literal("align") }),
  z.object({ type: z.literal("showHistory"), id: z.string().min(1).max(200) }),
  z.object({ type: z.literal("copy"), text: z.string().max(1_000_000), what: z.string().max(80) }),
]);

export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  const parsed = WebviewMessage.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export interface VizPanelEvents {
  onMessage(message: WebviewToHost): void;
  onDispose(): void;
}

export class VizPanel implements vscode.Disposable {
  static create(extensionUri: vscode.Uri, title: string, events: VizPanelEvents): VizPanel {
    const panel = vscode.window.createWebviewPanel(
      VIZ_VIEW_TYPE,
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { retainContextWhenHidden: true },
    );
    return new VizPanel(panel, extensionUri, events);
  }

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    events: VizPanelEvents,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
    };
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "paireto.svg");
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (message) {
          events.onMessage(message);
        }
      }),
      panel.onDidDispose(() => {
        this.disposeListeners();
        events.onDispose();
      }),
    );
  }

  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  show(title: string): void {
    this.panel.title = title;
    this.panel.reveal(undefined, true);
  }

  post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private disposeListeners(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString("base64");
    const dist = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", file));
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
  <link href="${dist("viz.css")}" rel="stylesheet" />
  <title>Paireto Viz</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${dist("viz.js")}"></script>
</body>
</html>`;
  }
}
