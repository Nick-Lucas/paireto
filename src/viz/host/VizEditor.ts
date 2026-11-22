import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { Commands } from "../../config.js";
import type { VizFileRef } from "../../protocol/viz.js";
import type { DeltaFile } from "../../review/delta.js";
import { normalizePath } from "../../review/guidedPlan.js";
import type { RepoChangedFile } from "../../review/ReviewController.js";
import type { DiagramAnchor } from "../../review/reviewTypes.js";
import type { VizDoc, VizIssue } from "../model/types.js";
import type {
  HostToWebview,
  VizListEntry,
  VizNoteTarget,
  VizReviewState,
  VizViewState,
  VizWindowState,
  WebviewToHost,
} from "../protocol.js";
import { parseWebviewMessage } from "./messages.js";
import { diagramTargets, noteTarget, notesTitle, sameTarget } from "./notes.js";
import type { VizCheck, VizReview, VizSeen } from "./VizService.js";
import { vizNameOf } from "./vizFiles.js";

export const VIZ_VIEW_TYPE = "paireto.viz";

export const RESET_SEEN = "Reset review";

export interface VizEditorHost {
  review: VizReview;
  seen: VizSeen;
  check(file: string, text: string): VizCheck;
  setIssues(document: vscode.TextDocument, issues: VizIssue[]): void;
  windowState(doc: VizDoc): VizWindowState;
  vizzes(): VizListEntry[];
  reviewState(repoRoot: string, name: string): VizReviewState;
  viewState(file: string): VizViewState;
  saveViewState(file: string, state: VizViewState): Promise<void>;
  takePendingNote(file: string): string | undefined;
  switchTo(name: string, from: string, viewColumn: vscode.ViewColumn | undefined): Promise<boolean>;
  deltaFiles(): { repo: string; delta: DeltaFile }[];
  changedFile(repoRoot: string, relPath: string): RepoChangedFile | undefined;
}

export class VizEditor {
  doc: VizDoc | undefined;
  private ready = false;
  private posted = { window: "", review: "" };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly host: VizEditorHost,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
    };
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "paireto.svg");
    panel.webview.html = vizHtml(panel.webview, extensionUri);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (message) {
          void this.onMessage(message);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === document && event.contentChanges.length > 0) {
          this.refresh();
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    this.check();
  }

  get name(): string {
    return vizNameOf(this.document.uri.fsPath);
  }

  private get file(): string {
    return this.document.uri.fsPath;
  }

  reveal(preserveFocus: boolean): void {
    this.panel.reveal(undefined, preserveFocus);
  }

  showNote(id: string): void {
    if (this.ready) {
      this.post({ type: "showNote", id });
    }
  }

  postWindow(): void {
    if (!this.ready || !this.doc) {
      return;
    }
    const window = this.host.windowState(this.doc);
    const serialized = JSON.stringify(window);
    if (serialized !== this.posted.window) {
      this.posted.window = serialized;
      this.post({ type: "window", window });
    }
  }

  postReview(): void {
    if (!this.ready || !this.doc) {
      return;
    }
    const review = this.host.reviewState(this.doc.meta.repoRoot, this.name);
    const serialized = JSON.stringify(review);
    if (serialized !== this.posted.review) {
      this.posted.review = serialized;
      this.post({ type: "review", review });
    }
  }

  postVizzes(vizzes: VizListEntry[]): void {
    if (this.ready) {
      this.post(this.doc ? { type: "vizzes", vizzes } : { type: "empty", vizzes });
    }
  }

  private check(): VizIssue[] {
    const checked = this.host.check(this.file, this.document.getText());
    this.host.setIssues(this.document, checked.issues);
    if (checked.ok) {
      this.doc = checked.doc;
      this.panel.title = checked.doc.viz.title;
    }
    return checked.ok ? [] : checked.issues;
  }

  private refresh(): void {
    const errors = this.check();
    if (!this.ready) {
      return;
    }
    if (errors.length > 0) {
      this.post({ type: "invalid", name: this.name, issues: errors });
      return;
    }
    this.load();
  }

  private load(): void {
    const doc = this.doc;
    if (!doc) {
      this.post({ type: "empty", vizzes: this.host.vizzes() });
      return;
    }
    const window = this.host.windowState(doc);
    const review = this.host.reviewState(doc.meta.repoRoot, this.name);
    this.posted = { window: JSON.stringify(window), review: JSON.stringify(review) };
    this.post({
      type: "load",
      doc,
      window,
      vizzes: this.host.vizzes(),
      review,
      view: this.host.viewState(this.file),
    });
  }

  private post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    const review = this.host.review;
    switch (message.type) {
      case "ready": {
        this.ready = true;
        const errors = this.check();
        this.load();
        if (errors.length > 0) {
          this.post({ type: "invalid", name: this.name, issues: errors });
        }
        const note = this.host.takePendingNote(this.file);
        if (note) {
          this.showNote(note);
        }
        return;
      }
      case "open":
        await this.openFile(message.file, message.mode);
        return;
      case "align":
        if (
          this.doc?.meta.compareTo &&
          this.host.windowState(this.doc).alignment.kind === "available"
        ) {
          await review.setCompareTo(this.doc.meta.compareTo, "viz");
        }
        return;
      case "regenerate":
        await this.askToRegenerate();
        return;
      case "switch":
        if (await this.host.switchTo(message.name, this.file, this.panel.viewColumn)) {
          this.panel.dispose();
        }
        return;
      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.showInformationMessage(`Paireto: copied ${message.what}.`);
        return;
      case "seen": {
        const found = this.host
          .deltaFiles()
          .find((entry) => entry.repo === message.repo && entry.delta.path === message.path);
        if (found) {
          await this.host.seen.setSeen([found.delta], message.seen);
        }
        return;
      }
      case "resetSeen":
        await resetSeen(
          this.host.seen,
          this.host.deltaFiles().map((entry) => entry.delta),
          (text, action) => vscode.window.showWarningMessage(text, { modal: true }, action),
        );
        return;
      case "viewState":
        await this.host.saveViewState(this.file, message.state);
        return;
      case "note.add": {
        if (!this.doc) {
          return;
        }
        const targets = diagramTargets(this.doc, message.targets);
        const anchor: DiagramAnchor = {
          viz: this.name,
          title: message.title.trim() || notesTitle(targets),
          targets,
          ...(message.place ? { place: message.place } : {}),
        };
        await review.addDiagramComment(this.doc.meta.repoRoot, anchor, message.kind, message.body);
        return;
      }
      case "note.edit": {
        const anchor = review.diagramAnchorOf(message.id);
        if (anchor) {
          review.editDiagramComment(
            message.id,
            message.kind,
            message.body,
            this.relinked(anchor, message.targets),
          );
        }
        return;
      }
      case "note.link": {
        const anchor = review.diagramAnchorOf(message.id);
        const held = anchor?.targets.map(noteTarget) ?? [];
        if (anchor && !held.some((target) => sameTarget(target, message.target))) {
          review.relinkDiagramComment(message.id, this.relinked(anchor, [...held, message.target]));
        }
        return;
      }
      case "note.unlink": {
        const anchor = review.diagramAnchorOf(message.id);
        if (anchor) {
          const kept = anchor.targets.map(noteTarget).filter((_, at) => at !== message.index);
          review.relinkDiagramComment(message.id, this.relinked(anchor, kept));
        }
        return;
      }
      case "note.reply":
        review.replyDiagramComment(message.id, message.body);
        return;
      case "note.editReply":
        review.editDiagramReply(message.id, message.body);
        return;
      case "note.move":
        review.moveDiagramComment(message.id, message.place);
        return;
      case "note.read":
        review.readDiagramComment(message.id);
        return;
      case "note.resolve":
        review.resolveComment(message.id);
        return;
      case "note.delete":
        review.deleteDiagramComment(message.id);
        return;
      case "gate":
        await vscode.commands.executeCommand(
          message.action === "approve" ? Commands.gateApprove : Commands.gateSendFeedback,
        );
        return;
    }
  }

  private relinked(anchor: DiagramAnchor, targets: VizNoteTarget[]): DiagramAnchor {
    const resolved = this.doc
      ? diagramTargets(this.doc, targets)
      : targets.map((target) => anchor.targets.find((held) => sameTarget(held, target)) ?? target);
    const autoTitle = anchor.title === notesTitle(anchor.targets);
    return {
      viz: anchor.viz,
      title: autoTitle ? notesTitle(resolved) : anchor.title,
      targets: resolved,
    };
  }

  private async askToRegenerate(): Promise<void> {
    const doc = this.doc;
    if (!doc) {
      return;
    }
    const window = this.host.windowState(doc);
    const body = [
      `Regenerate the viz "${doc.viz.title}" for the Compare To ${window.compareLabel}.`,
      `Call paireto_viz_generate with name "${this.name}" and base "${doc.viz.base}", then edit the file again and call paireto_viz_present.`,
    ].join(" ");
    const id = await this.host.review.addDiagramComment(
      doc.meta.repoRoot,
      { viz: this.name, title: doc.viz.title, targets: [] },
      "question",
      body,
    );
    if (id) {
      this.showNote(id);
    }
  }

  private async openFile(ref: VizFileRef, mode: "file" | "diff"): Promise<void> {
    const doc = this.doc;
    const repo = doc?.meta.repos.find(
      (candidate) => candidate.name === (ref.repo ?? doc.meta.repoName),
    );
    const relPath = normalizePath(ref.path);
    if (!repo || !relPath) {
      return;
    }
    const side = ref.side ?? "modified";
    const changed = this.host.changedFile(repo.root, relPath);
    if (changed && (mode === "diff" || side === "base")) {
      const start = (ref.line ?? 1) - 1;
      await this.host.review.openAgainstCompareToAt(changed, {
        side,
        start,
        end: (ref.endLine ?? ref.line ?? 1) - 1,
      });
      return;
    }
    const uri = vscode.Uri.file(path.join(repo.root, relPath));
    if (!fs.existsSync(uri.fsPath)) {
      void vscode.window.showInformationMessage(
        `Paireto: ${relPath} is not on disk. It is not in the current changes either.`,
      );
      return;
    }
    const editor = await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false,
    });
    revealLines(editor, ref);
  }

  private dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

export async function resetSeen(
  seen: Pick<VizSeen, "isSeen" | "setSeen">,
  files: readonly DeltaFile[],
  confirm: (message: string, action: string) => Thenable<string | undefined>,
): Promise<boolean> {
  const seenCount = files.filter((file) => seen.isSeen(file)).length;
  if (seenCount === 0) {
    return false;
  }
  const answer = await confirm(
    `Reset the review? ${seenCount} of ${files.length} files are marked seen. They will all be marked not seen.`,
    RESET_SEEN,
  );
  if (answer !== RESET_SEEN) {
    return false;
  }
  await seen.setSeen([...files], false);
  return true;
}

function revealLines(editor: vscode.TextEditor, ref: VizFileRef): void {
  if (ref.line === undefined) {
    return;
  }
  const last = editor.document.lineCount - 1;
  const start = Math.min(ref.line - 1, last);
  const end = Math.min((ref.endLine ?? ref.line) - 1, last);
  const range = new vscode.Range(start, 0, end, 0);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function vizHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const dist = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", file));
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
