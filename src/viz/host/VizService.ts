import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import type { FeedbackMutationResult } from "../../bridge/types.js";
import { Commands } from "../../config.js";
import type { InspectViz } from "../../e2e/inspectTypes.js";
import type { ChangesModel } from "../../git/DiffService.js";
import { log } from "../../log.js";
import type { CompareTo } from "../../protocol/guidedReview.js";
import { canonicalize } from "../../protocol/paths.js";
import type { ChangesDescribeRequest, VizShowRequest } from "../../protocol/types.js";
import type { VizFileRef } from "../../protocol/viz.js";
import { normalizePath } from "../../review/guidedPlan.js";
import type { RepoChangedFile, ReviewState } from "../../review/ReviewController.js";
import { compileViz } from "../model/compile.js";
import { renderAccepted, renderRejected } from "../model/render.js";
import { VIZ_DOC_FORMAT, type VizDoc, type VizRepo } from "../model/types.js";
import type { VizWindowState, WebviewToHost } from "../protocol.js";
import { findUnits, manifestIn, renderChanges, type RepoChanges, vizStatus } from "./changes.js";
import { VizPanel } from "./VizPanel.js";
import { VizStore } from "./VizStore.js";

export interface VizReview {
  getState(): ReviewState;
  readonly onDidChangeState: vscode.Event<void>;
  compareToFor(repoRoot: string): CompareTo;
  setCompareTo(compareTo: CompareTo, by: string): Promise<void>;
}

export interface VizServiceDeps {
  extensionUri: vscode.Uri;
  memento: Pick<vscode.Memento, "get" | "update">;
  review: VizReview;
  getChanges(repoRoot: string, compareTo: CompareTo): Promise<ChangesModel>;
}

interface WindowRepo extends RepoChanges {
  root: string;
}

export function vizIdFor(repoRoot: string, title: string): string {
  return crypto
    .createHash("sha256")
    .update(`${canonicalize(repoRoot)}\n${title}`)
    .digest("hex")
    .slice(0, 16);
}

export class VizService implements vscode.Disposable {
  private readonly store: VizStore;
  private panel: VizPanel | undefined;
  private current: VizDoc | undefined;
  private postedWindow: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: VizServiceDeps) {
    this.store = new VizStore(deps.memento);
    this.disposables.push(deps.review.onDidChangeState(() => this.postWindow()));
  }

  async describeChanges(msg: ChangesDescribeRequest): Promise<FeedbackMutationResult> {
    try {
      const repos = await this.windowRepos(msg.repoRoot);
      if (!repos.some((repo) => repo.isCaller)) {
        return { ok: false, message: notInWindow(msg.repoRoot) };
      }
      const units = repos.flatMap((repo) => {
        const seen = new Map<string, string | undefined>();
        return findUnits(repo.name, repo.files, (dir) => {
          if (!seen.has(dir)) {
            seen.set(dir, manifestIn(listDir(path.join(repo.root, dir))));
          }
          return seen.get(dir);
        });
      });
      return { ok: true, message: renderChanges(repos, units) };
    } catch (error) {
      log.error(`viz: describing changes failed: ${String(error)}`);
      return { ok: false, message: `Paireto could not read the changes: ${String(error)}` };
    }
  }

  async show(msg: VizShowRequest): Promise<FeedbackMutationResult> {
    try {
      const repos = await this.windowRepos(msg.repoRoot);
      const caller = repos.find((repo) => repo.isCaller);
      if (!caller) {
        return { ok: false, message: notInWindow(msg.repoRoot) };
      }
      const roots = new Map(repos.map((repo) => [repo.name, repo.root]));
      const changed = repos.flatMap((repo) => repo.files);
      const result = compileViz(msg.viz, {
        repoName: caller.name,
        repos: repos.map((repo): VizRepo => ({ name: repo.name, root: repo.root })),
        changed,
        fileExists: (repo, file) => {
          const root = roots.get(repo);
          return root !== undefined && fs.existsSync(path.join(root, file));
        },
      });
      if (!result.ok) {
        return { ok: false, message: renderRejected(result.errors, result.warnings) };
      }
      const doc: VizDoc = {
        format: VIZ_DOC_FORMAT,
        meta: {
          id: vizIdFor(caller.root, result.viz.title),
          repoRoot: caller.root,
          repoName: caller.name,
          repos: repos.map((repo) => ({ name: repo.name, root: repo.root })),
          harness: msg.harness,
          compareTo: caller.compareTo,
          compareLabel: caller.compareLabel,
          createdAt: new Date().toISOString(),
          changed,
        },
        viz: result.viz,
      };
      await this.store.put(doc);
      this.open(doc);
      return { ok: true, message: renderAccepted(result.viz, result.warnings) };
    } catch (error) {
      log.error(`viz: show failed: ${String(error)}`);
      return { ok: false, message: `Paireto could not show the viz: ${String(error)}` };
    }
  }

  async pick(): Promise<void> {
    const docs = this.store.all();
    if (docs.length === 0) {
      void vscode.window.showInformationMessage(
        "Paireto: no change visualizations yet. Ask your agent to run the Paireto viz skill.",
      );
      return;
    }
    if (docs.length === 1) {
      this.reopen(docs[0].meta.id);
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      docs.map((doc) => ({
        label: doc.viz.title,
        description: `${doc.meta.repoName} · ${doc.meta.compareLabel}`,
        detail: new Date(doc.meta.createdAt).toLocaleString(),
        id: doc.meta.id,
      })),
      { placeHolder: "Open a change visualization" },
    );
    if (chosen) {
      this.reopen(chosen.id);
    }
  }

  reopen(id?: string): boolean {
    const doc = id ? this.store.get(id) : this.store.all()[0];
    if (!doc) {
      return false;
    }
    this.open(doc);
    return true;
  }

  revive(webviewPanel: vscode.WebviewPanel, state: unknown): void {
    const vizId = (state as { vizId?: unknown } | undefined)?.vizId;
    const doc =
      (typeof vizId === "string" ? this.store.get(vizId) : undefined) ?? this.store.all()[0];
    if (!doc || this.panel) {
      webviewPanel.dispose();
      return;
    }
    this.panel = new VizPanel(webviewPanel, this.deps.extensionUri, this.panelEvents());
    this.load(doc);
  }

  inspect(): InspectViz {
    const stored = this.store.all().length;
    const doc = this.panel ? this.current : undefined;
    return doc
      ? { open: true, vizId: doc.meta.id, title: doc.viz.title, stored }
      : { open: this.panel !== undefined, stored };
  }

  dispose(): void {
    this.panel?.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private open(doc: VizDoc): void {
    if (!this.panel) {
      this.panel = VizPanel.create(this.deps.extensionUri, doc.viz.title, this.panelEvents());
    }
    this.panel.show(doc.viz.title);
    this.load(doc);
  }

  private load(doc: VizDoc): void {
    this.current = doc;
    const window = this.windowState(doc);
    this.postedWindow = JSON.stringify(window);
    this.panel?.post({ type: "load", doc, history: this.store.history(), window });
  }

  private panelEvents() {
    return {
      onMessage: (message: WebviewToHost) => void this.onMessage(message),
      onDispose: () => {
        this.panel = undefined;
        this.postedWindow = undefined;
      },
    };
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    const doc = this.current;
    switch (message.type) {
      case "ready":
        if (doc) {
          this.load(doc);
        }
        return;
      case "open":
        if (doc) {
          await this.openFile(doc, message.file, message.mode);
        }
        return;
      case "align":
        if (doc) {
          await this.deps.review.setCompareTo(doc.meta.compareTo, "viz");
        }
        return;
      case "showHistory":
        this.reopen(message.id);
        return;
      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.showInformationMessage(`Paireto: copied ${message.what}.`);
        return;
    }
  }

  private postWindow(): void {
    if (!this.panel || !this.current) {
      return;
    }
    const window = this.windowState(this.current);
    const serialized = JSON.stringify(window);
    if (serialized !== this.postedWindow) {
      this.postedWindow = serialized;
      this.panel.post({ type: "window", window });
    }
  }

  private windowState(doc: VizDoc): VizWindowState {
    const repository = this.deps.review
      .getState()
      .repositories.find((repo) => sameRoot(repo.repoRoot, doc.meta.repoRoot));
    const compareTo = this.deps.review.compareToFor(repository?.repoRoot ?? doc.meta.repoRoot);
    return {
      compareTo,
      compareLabel: repository?.changes.compareLabel ?? doc.meta.compareLabel,
      aligned: sameCompareTo(compareTo, doc.meta.compareTo),
    };
  }

  private async windowRepos(callerRoot: string): Promise<WindowRepo[]> {
    const repositories = this.deps.review.getState().repositories;
    const repos = await Promise.all(
      repositories.map(async (repository): Promise<WindowRepo> => {
        const compareTo = this.deps.review.compareToFor(repository.repoRoot);
        const changes = await this.deps.getChanges(repository.repoRoot, compareTo);
        return {
          name: repository.displayName,
          root: repository.repoRoot,
          isCaller: sameRoot(repository.repoRoot, callerRoot),
          compareTo,
          compareLabel: changes.compareLabel,
          files: changes.net.map((file) => ({
            repo: repository.displayName,
            path: file.path,
            status: vizStatus(file.status),
            additions: file.additions,
            deletions: file.deletions,
          })),
        };
      }),
    );
    return repos.sort((a, b) => Number(b.isCaller) - Number(a.isCaller));
  }

  private async openFile(doc: VizDoc, ref: VizFileRef, mode: "file" | "diff"): Promise<void> {
    const repo = doc.meta.repos.find(
      (candidate) => candidate.name === (ref.repo ?? doc.meta.repoName),
    );
    const relPath = normalizePath(ref.path);
    if (!repo || !relPath) {
      return;
    }
    const otherColumn =
      this.panel?.viewColumn === vscode.ViewColumn.One
        ? vscode.ViewColumn.Two
        : vscode.ViewColumn.One;
    const changed = mode === "diff" ? this.changedFile(repo.root, relPath) : undefined;
    if (changed) {
      await vscode.commands.executeCommand(
        otherColumn === vscode.ViewColumn.One
          ? "workbench.action.focusFirstEditorGroup"
          : "workbench.action.focusSecondEditorGroup",
      );
      await vscode.commands.executeCommand(Commands.reviewOpenDelta, { layers: [changed] });
      revealLines(vscode.window.activeTextEditor, relPath, ref);
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
      viewColumn: otherColumn,
      preview: true,
    });
    revealLines(editor, relPath, ref);
  }

  private changedFile(repoRoot: string, relPath: string): RepoChangedFile | undefined {
    const repository = this.deps.review
      .getState()
      .repositories.find((repo) => sameRoot(repo.repoRoot, repoRoot));
    if (!repository) {
      return undefined;
    }
    const { committed, staged, unstaged } = repository.changes;
    return [...committed, ...staged, ...unstaged].find((file) => file.path === relPath);
  }
}

function revealLines(
  editor: vscode.TextEditor | undefined,
  relPath: string,
  ref: VizFileRef,
): void {
  if (!editor || ref.line === undefined || !editor.document.uri.path.endsWith(`/${relPath}`)) {
    return;
  }
  const last = editor.document.lineCount - 1;
  const start = Math.min(ref.line - 1, last);
  const end = Math.min((ref.endLine ?? ref.line) - 1, last);
  const range = new vscode.Range(start, 0, end, 0);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function sameRoot(a: string, b: string): boolean {
  return canonicalize(a) === canonicalize(b);
}

function sameCompareTo(a: CompareTo, b: CompareTo): boolean {
  return a.kind === b.kind && (a.kind !== "ref" || a.ref === b.ref);
}

function notInWindow(repoRoot: string): string {
  return `This VS Code window does not have ${repoRoot} open as a Git root. Open it in the window, then try again.`;
}
