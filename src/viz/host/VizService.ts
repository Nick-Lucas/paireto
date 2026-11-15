import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import type { FeedbackMutationResult } from "../../bridge/types.js";
import type { CommentKind } from "../../comments/kinds.js";
import { Schemes, StateKeys } from "../../config.js";
import type { InspectViz } from "../../e2e/inspectTypes.js";
import { log } from "../../log.js";
import type { CompareTo } from "../../protocol/guidedReview.js";
import { canonicalize } from "../../protocol/paths.js";
import type { VizGenerateRequest, VizPresentRequest } from "../../protocol/types.js";
import { VizGenerateArgs, VizPresentArgs } from "../../protocol/viz.js";
import { buildDelta, type DeltaFile } from "../../review/delta.js";
import { ReviewPath } from "../../review/ReviewPath.js";
import type { RepoChangedFile, ReviewState } from "../../review/ReviewController.js";
import type { DiagramAnchor, ReviewThread } from "../../review/reviewTypes.js";
import type { SeenFiles } from "../../review/SeenFiles.js";
import { compileViz, type VizChangedFile } from "../model/compile.js";
import { plural, renderAccepted, renderRejected } from "../model/render.js";
import { VIZ_DOC_FORMAT, type VizDoc, type VizIssue, type VizRepo } from "../model/types.js";
import {
  DEFAULT_VIZ_VIEW_STATE,
  type VizAlignment,
  type VizListEntry,
  type VizReviewFile,
  type VizReviewState,
  type VizViewState,
  type VizWindowState,
} from "../protocol.js";
import {
  compareToText,
  findUnits,
  manifestIn,
  renderChanges,
  type RepoChanges,
  uniqueRepoNames,
  vizStatus,
} from "./changes.js";
import { skeletonViz, type VizGenerator } from "./generator.js";
import { issueRange } from "./issueRange.js";
import { parseViewState } from "./messages.js";
import { vizNotes } from "./notes.js";
import { VIZ_VIEW_TYPE, VizEditor, type VizEditorHost } from "./VizEditor.js";
import {
  listEntries,
  listVizFiles,
  repoRootOfViz,
  vizNameOf,
  vizPathOf,
  writeVizFile,
} from "./vizFiles.js";

const REVIEW_DELAY_MS = 250;

export interface VizReview {
  getState(): ReviewState;
  readonly onDidChangeState: vscode.Event<void>;
  compareToFor(repoRoot: string): CompareTo;
  setCompareTo(compareTo: CompareTo, by: string): Promise<void>;
  isSessionActive(): boolean;
  getComments(): ReviewThread[];
  getPendingComments(): ReviewThread[];
  addDiagramComment(
    repoRoot: string,
    anchor: DiagramAnchor,
    kind: CommentKind,
    body: string,
  ): Promise<string | undefined>;
  diagramAnchorOf(id: string): DiagramAnchor | undefined;
  relinkDiagramComment(id: string, anchor: DiagramAnchor): boolean;
  editDiagramComment(id: string, kind: CommentKind, body: string, anchor: DiagramAnchor): boolean;
  editDiagramReply(id: string, body: string): boolean;
  deleteDiagramComment(id: string): boolean;
  replyDiagramComment(id: string, body: string): boolean;
  readDiagramComment(id: string): boolean;
  moveDiagramComment(id: string, place: NonNullable<DiagramAnchor["place"]>): boolean;
  resolveComment(id: string): void;
  openAgainstCompareToAt(
    file: RepoChangedFile,
    focus: { side: "base" | "modified"; start: number; end: number },
  ): Promise<vscode.TextEditor | undefined>;
}

export type VizSeen = Pick<SeenFiles, "isSeen" | "setSeen" | "onDidChange">;

export interface VizOpenOptions {
  viewColumn: vscode.ViewColumn;
  preserveFocus: boolean;
}

export interface VizServiceDeps {
  extensionUri: vscode.Uri;
  workspaceState: Pick<vscode.Memento, "get" | "update">;
  review: VizReview;
  seen: VizSeen;
  generate: VizGenerator;
  openEditor(uri: vscode.Uri, options: VizOpenOptions): Thenable<unknown>;
}

export type VizCheck =
  | { ok: true; doc: VizDoc; issues: VizIssue[] }
  | { ok: false; issues: VizIssue[] };

interface WindowRepo extends RepoChanges {
  root: string;
}

export class VizService implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly editors = new Set<VizEditor>();
  private readonly pendingNotes = new Map<string, string>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("paireto-viz");
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: VizServiceDeps) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/.paireto/viz/*.viz.json");
    this.disposables.push(
      this.diagnostics,
      watcher,
      watcher.onDidCreate(() => this.postVizzes()),
      watcher.onDidDelete(() => this.postVizzes()),
      deps.review.onDidChangeState(() => this.scheduleReview()),
      deps.seen.onDidChange(() => this.scheduleReview()),
    );
  }

  async generate(msg: VizGenerateRequest): Promise<FeedbackMutationResult> {
    const args = VizGenerateArgs.safeParse(msg.args);
    if (!args.success) {
      return { ok: false, message: `Paireto could not read the arguments: ${args.error.message}` };
    }
    try {
      const repos = this.windowRepos(this.targetRoot(msg.cwd, msg.repoRoot) ?? msg.repoRoot);
      const target = repos.find((repo) => repo.isCaller);
      if (!target) {
        return { ok: false, message: notInWindow(msg.repoRoot) };
      }
      const { name, base, title } = args.data;
      const generated =
        base === "changes"
          ? await this.deps.generate({ repoRoot: target.root, compareTo: target.compareTo, title })
          : skeletonViz("none", target.compareTo, title);
      const viz = {
        ...generated,
        base,
        compareTo: target.compareTo,
        generatedAt: new Date().toISOString(),
      };
      const file = vizPathOf(target.root, name);
      const { replaced } = writeVizFile(file, viz);
      return {
        ok: true,
        message: [
          `${replaced ? "Replaced" : "Wrote"} ${file} (base ${base}): ${plural(viz.nodes.length, "node")}, ${plural(viz.edges?.length ?? 0, "edge")}.`,
          ...(replaced ? ["The old file of this name is gone."] : []),
          renderChanges(repos, this.units(repos)),
          `Read the diffs, then read and edit ${file}, then call paireto_viz_present with name "${name}".`,
        ].join("\n"),
      };
    } catch (error) {
      log.error(`viz: generate failed: ${String(error)}`);
      return { ok: false, message: `Paireto could not write the viz: ${String(error)}` };
    }
  }

  async present(msg: VizPresentRequest): Promise<FeedbackMutationResult> {
    const args = VizPresentArgs.safeParse(msg.args);
    if (!args.success) {
      return { ok: false, message: `Paireto could not read the arguments: ${args.error.message}` };
    }
    try {
      const { name } = args.data;
      const file = this.findViz(name, this.targetRoot(msg.cwd, msg.repoRoot) ?? msg.repoRoot);
      if (!file) {
        return {
          ok: false,
          message: `There is no viz named "${name}" in this window. Call paireto_viz_generate first.`,
        };
      }
      const checked = this.check(file, fs.readFileSync(file, "utf8"));
      if (!checked.ok) {
        return { ok: false, message: renderRejected(checked.issues) };
      }
      await this.open(file, { preserveFocus: true });
      return { ok: true, message: renderAccepted(checked.doc.viz, checked.issues) };
    } catch (error) {
      log.error(`viz: present failed: ${String(error)}`);
      return { ok: false, message: `Paireto could not open the viz: ${String(error)}` };
    }
  }

  async pick(): Promise<void> {
    const repos = this.repos();
    const files = listVizFiles(repos);
    if (files.length === 0) {
      showNoViz();
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      files.map((file) => ({
        label: file.title,
        description: repos.length > 1 ? `${file.repoName} · ${file.name}` : file.name,
        detail: new Date(file.modifiedAt).toLocaleString(),
        file: file.path,
      })),
      { placeHolder: "Open a Paireto viz" },
    );
    if (chosen) {
      await this.open(chosen.file, { preserveFocus: false });
    }
  }

  async openNewest(arg?: unknown): Promise<void> {
    const at = rootOfArg(arg);
    const repoRoot = at === undefined ? undefined : this.containingRoot(at);
    const repos = this.repos();
    const scope = repoRoot ? repos.filter((repo) => sameRoot(repo.root, repoRoot)) : repos;
    const newest = listVizFiles(scope)[0];
    if (!newest) {
      showNoViz();
      return;
    }
    await this.open(newest.path, { preserveFocus: false });
  }

  async showNote(id: string): Promise<void> {
    const thread = this.deps.review.getComments().find((candidate) => candidate.id === id);
    if (!thread?.diagram) {
      return;
    }
    const file = vizPathOf(thread.repoRoot, thread.diagram.viz);
    const editor = this.editorFor(file);
    if (editor) {
      editor.reveal(false);
      editor.showNote(id);
      return;
    }
    if (!fs.existsSync(file)) {
      void vscode.window.showInformationMessage(
        `Paireto: the viz file ${thread.diagram.viz}.viz.json is gone, so its note cannot show.`,
      );
      return;
    }
    this.pendingNotes.set(canonicalize(file), id);
    await this.open(file, { preserveFocus: false });
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const editor = new VizEditor(document, panel, this.deps.extensionUri, this.editorHost());
    this.editors.add(editor);
    panel.onDidDispose(() => {
      this.editors.delete(editor);
      if (![...this.editors].some((other) => other.document === document)) {
        this.diagnostics.delete(document.uri);
      }
    });
  }

  inspect(): InspectViz {
    return {
      open: [...this.editors].map((editor) => ({
        name: editor.name,
        path: editor.document.uri.fsPath,
        title: editor.doc?.viz.title,
      })),
    };
  }

  check(file: string, text: string): VizCheck {
    const repoRoot = repoRootOfViz(file);
    const window = this.repos();
    const repos = window.some((repo) => sameRoot(repo.root, repoRoot))
      ? window
      : [...window, { name: path.basename(repoRoot), root: repoRoot }];
    const repo = repos.find((candidate) => sameRoot(candidate.root, repoRoot)) ?? repos[0];
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            severity: "error",
            rule: "json",
            path: "",
            message: `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    const result = compileViz(raw, {
      repoName: repo.name,
      repos,
      changed: this.changedFiles(),
      fileExists: (repoName, relPath) => {
        const root = repos.find((candidate) => candidate.name === repoName)?.root;
        return root !== undefined && fs.existsSync(path.join(root, relPath));
      },
    });
    if (!result.ok) {
      return result;
    }
    const doc: VizDoc = {
      format: VIZ_DOC_FORMAT,
      meta: {
        name: vizNameOf(file),
        path: file,
        repoRoot: repo.root,
        repoName: repo.name,
        repos,
        compareTo: result.viz.compareTo,
        compareLabel: result.viz.compareTo && this.compareLabel(repo.root, result.viz.compareTo),
        checkedAt: new Date().toISOString(),
      },
      viz: result.viz,
    };
    return { ok: true, doc, issues: result.issues };
  }

  dispose(): void {
    clearTimeout(this.timer);
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private editorHost(): VizEditorHost {
    return {
      review: this.deps.review,
      seen: this.deps.seen,
      check: (file, text) => this.check(file, text),
      setIssues: (document, issues) => this.setIssues(document, issues),
      windowState: (doc) => this.windowState(doc),
      vizzes: () => this.vizzes(),
      reviewState: (repoRoot, name) => this.reviewState(repoRoot, name),
      viewState: (file) => this.viewState(file),
      saveViewState: (file, state) => this.saveViewState(file, state),
      takePendingNote: (file) => {
        const key = canonicalize(file);
        const id = this.pendingNotes.get(key);
        this.pendingNotes.delete(key);
        return id;
      },
      switchTo: (name, from, viewColumn) => this.switchTo(name, from, viewColumn),
      deltaFiles: () => this.deltaFiles(),
      changedFile: (repoRoot, relPath) => this.changedFile(repoRoot, relPath),
    };
  }

  private async open(
    file: string,
    options: { preserveFocus: boolean; viewColumn?: vscode.ViewColumn },
  ): Promise<void> {
    const editor = this.editorFor(file);
    if (editor && options.viewColumn === undefined) {
      editor.reveal(options.preserveFocus);
      return;
    }
    await this.deps.openEditor(vscode.Uri.file(file), {
      viewColumn: options.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: options.preserveFocus,
    });
  }

  private async switchTo(
    name: string,
    from: string,
    viewColumn: vscode.ViewColumn | undefined,
  ): Promise<void> {
    const file = this.findViz(name, repoRootOfViz(from));
    if (file) {
      await this.open(file, {
        preserveFocus: false,
        viewColumn: viewColumn ?? vscode.ViewColumn.Active,
      });
    }
  }

  private editorFor(file: string): VizEditor | undefined {
    const key = canonicalize(file);
    return [...this.editors].find((editor) => canonicalize(editor.document.uri.fsPath) === key);
  }

  private findViz(name: string, preferredRoot: string): string | undefined {
    const preferred = vizPathOf(preferredRoot, name);
    if (fs.existsSync(preferred)) {
      return preferred;
    }
    return listVizFiles(this.repos()).find((file) => file.name === name)?.path;
  }

  private vizzes(): VizListEntry[] {
    return listEntries(listVizFiles(this.repos()));
  }

  private setIssues(document: vscode.TextDocument, issues: VizIssue[]): void {
    const text = document.getText();
    this.diagnostics.set(
      document.uri,
      issues.map((issue) => {
        const [start, end] = issueRange(text, issue.path);
        const hint = issue.suggestion === undefined ? "" : ` Did you mean "${issue.suggestion}"?`;
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(document.positionAt(start), document.positionAt(end)),
          `${issue.message}${hint}`,
          issue.severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = "Paireto viz";
        diagnostic.code = issue.rule;
        return diagnostic;
      }),
    );
  }

  private scheduleReview(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const editor of this.editors) {
        editor.postWindow();
        editor.postReview();
      }
    }, REVIEW_DELAY_MS);
  }

  private postVizzes(): void {
    const vizzes = this.vizzes();
    for (const editor of this.editors) {
      editor.postVizzes(vizzes);
    }
  }

  private reviewState(repoRoot: string, name: string): VizReviewState {
    const review = this.deps.review;
    return {
      files: this.deltaFiles().map(({ repo, delta }): VizReviewFile => ({
        repo,
        path: delta.path,
        status: vizStatus(delta.status),
        additions: delta.additions,
        deletions: delta.deletions,
        seen: this.deps.seen.isSeen(delta),
      })),
      notes: vizNotes(review.getComments(), repoRoot, name),
      feedback: { waiting: review.isSessionActive(), pending: review.getPendingComments().length },
    };
  }

  private deltaFiles(): { repo: string; delta: DeltaFile }[] {
    const repositories = this.deps.review.getState().repositories;
    const names = uniqueRepoNames(repositories.map((repository) => repository.displayName));
    return repositories.flatMap((repository, at) =>
      buildDelta(repository.repoRoot, repository.changes).map((delta) => ({
        repo: names[at],
        delta,
      })),
    );
  }

  private viewState(file: string): VizViewState {
    const stored = this.deps.workspaceState.get<Record<string, unknown>>(StateKeys.vizView, {});
    return parseViewState(stored[canonicalize(file)]) ?? DEFAULT_VIZ_VIEW_STATE;
  }

  private async saveViewState(file: string, state: VizViewState): Promise<void> {
    const stored = this.deps.workspaceState.get<Record<string, unknown>>(StateKeys.vizView, {});
    await this.deps.workspaceState.update(StateKeys.vizView, {
      ...stored,
      [canonicalize(file)]: state,
    });
  }

  private windowState(doc: VizDoc): VizWindowState {
    const repositories = this.deps.review.getState().repositories;
    const repository = repositories.find((repo) => sameRoot(repo.repoRoot, doc.meta.repoRoot));
    const compareTo = this.deps.review.compareToFor(repository?.repoRoot ?? doc.meta.repoRoot);
    return {
      compareTo,
      compareLabel: repository?.changes.compareLabel ?? compareToText(compareTo),
      alignment: alignmentOf(doc.meta.compareTo, compareTo, repositories.length),
    };
  }

  private compareLabel(repoRoot: string, compareTo: CompareTo): string {
    const repository = this.deps.review
      .getState()
      .repositories.find((repo) => sameRoot(repo.repoRoot, repoRoot));
    return repository && sameCompareTo(compareTo, this.deps.review.compareToFor(repoRoot))
      ? repository.changes.compareLabel
      : compareToText(compareTo);
  }

  private repos(): VizRepo[] {
    const repositories = this.deps.review.getState().repositories;
    const names = uniqueRepoNames(repositories.map((repository) => repository.displayName));
    return repositories.map((repository, at) => ({ name: names[at], root: repository.repoRoot }));
  }

  private targetRoot(cwd: string, repoRoot: string): string | undefined {
    return (
      this.containingRoot(cwd) ?? this.repos().find((repo) => sameRoot(repo.root, repoRoot))?.root
    );
  }

  private containingRoot(at: string): string | undefined {
    const wanted = canonicalize(at);
    return this.repos()
      .filter((repo) => {
        const root = canonicalize(repo.root);
        return wanted === root || wanted.startsWith(`${root}${path.sep}`);
      })
      .sort((a, b) => b.root.length - a.root.length)[0]?.root;
  }

  private windowRepos(callerRoot: string): WindowRepo[] {
    const repositories = this.deps.review.getState().repositories;
    const names = uniqueRepoNames(repositories.map((repository) => repository.displayName));
    const repos = repositories.map((repository, at): WindowRepo => {
      const name = names[at];
      return {
        name,
        root: repository.repoRoot,
        isCaller: sameRoot(repository.repoRoot, callerRoot),
        compareTo: this.deps.review.compareToFor(repository.repoRoot),
        compareLabel: repository.changes.compareLabel,
        files: changedOf(name, repository.changes.net),
      };
    });
    return repos.sort((a, b) => Number(b.isCaller) - Number(a.isCaller));
  }

  private units(repos: WindowRepo[]) {
    return repos.flatMap((repo) => {
      const seen = new Map<string, string | undefined>();
      return findUnits(repo.name, repo.files, (dir) => {
        if (!seen.has(dir)) {
          seen.set(dir, manifestIn(listDir(path.join(repo.root, dir))));
        }
        return seen.get(dir);
      });
    });
  }

  private changedFiles(): VizChangedFile[] {
    const repositories = this.deps.review.getState().repositories;
    const names = uniqueRepoNames(repositories.map((repository) => repository.displayName));
    return repositories.flatMap((repository, at) => changedOf(names[at], repository.changes.net));
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

export function registerVizEditor(service: VizService): vscode.Disposable {
  return vscode.window.registerCustomEditorProvider(VIZ_VIEW_TYPE, service, {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: false,
  });
}

export function openVizEditor(uri: vscode.Uri, options: VizOpenOptions): Thenable<unknown> {
  return vscode.commands.executeCommand("vscode.openWith", uri, VIZ_VIEW_TYPE, {
    ...options,
    preview: false,
  });
}

function changedOf(
  repo: string,
  files: ReviewState["repositories"][number]["changes"]["net"],
): VizChangedFile[] {
  return files.map((file) => ({
    repo,
    path: file.path,
    status: vizStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
  }));
}

function rootOfArg(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri) {
    return arg.scheme === Schemes.review ? ReviewPath.fromUri(arg).repoRoot : arg.fsPath;
  }
  if (typeof arg === "object" && arg !== null && "repository" in arg) {
    const repository = arg.repository;
    if (typeof repository === "object" && repository !== null && "repoRoot" in repository) {
      return typeof repository.repoRoot === "string" ? repository.repoRoot : undefined;
    }
  }
  return undefined;
}

function showNoViz(): void {
  void vscode.window.showInformationMessage(
    "Paireto: this repo has no viz yet. Ask your agent for one with /paireto:viz.",
  );
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

function alignmentOf(
  snapshot: CompareTo | undefined,
  window: CompareTo,
  repoCount: number,
): VizAlignment {
  if (!snapshot || sameCompareTo(snapshot, window)) {
    return { kind: "aligned" };
  }
  if (snapshot.kind === "ref" && repoCount > 1) {
    return {
      kind: "blocked",
      reason: `This window holds ${repoCount} repos, and Align would set the ref ${snapshot.ref} as the Compare To of every one of them.`,
    };
  }
  return { kind: "available" };
}

function notInWindow(repoRoot: string): string {
  return `This VS Code window does not have ${repoRoot} open as a Git root. Open it in the window, then try again.`;
}
