// Serves plan markdown as a read-only virtual document under the tui-plan:// scheme. A stable URI
// (keyed by planId) is what lets the Comments API anchor threads reliably; there's no write path,
// so VS Code treats it as read-only — no disk, no save prompts.

import * as vscode from "vscode";

export class PlanContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, markdown: string): void {
    this.docs.set(uri.toString(), markdown);
    this.emitter.fire(uri);
  }

  get(uri: vscode.Uri): string | undefined {
    return this.docs.get(uri.toString());
  }

  clear(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
