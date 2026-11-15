import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import type { FileStatus } from "../git/DiffService.js";
import type { CompareTo } from "../protocol/guidedReview.js";
import type { VizGenerateRequest, VizPresentRequest } from "../protocol/types.js";
import type { VizFile } from "../protocol/viz.js";
import type { DeltaFile } from "../review/delta.js";
import { diagramThread } from "../review/diagramComments.js";
import type { RepositoryChangesModel, ReviewState } from "../review/ReviewController.js";
import type { DiagramAnchor, ReviewThread } from "../review/reviewTypes.js";
import { SUMMARY_PLACEHOLDER, type VizGeneratorRequest } from "../viz/host/generator.js";
import { parseWebviewMessage } from "../viz/host/messages.js";
import { VizService, type VizOpenOptions, type VizReview } from "../viz/host/VizService.js";
import { vizPathOf } from "../viz/host/vizFiles.js";
import {
  DEFAULT_VIZ_VIEW_STATE,
  type HostToWebview,
  type VizWindowState,
  type WebviewToHost,
} from "../viz/protocol.js";
import { changedFilesFor, loadVizFixture } from "./vizFixtures.js";

function memento(): Pick<vscode.Memento, "get" | "update"> {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  } as Pick<vscode.Memento, "get" | "update">;
}

interface FakePanel {
  posts: HostToWebview[];
  send(message: WebviewToHost): Promise<void>;
  dispose(): void;
}

interface OtherRepo {
  name: string;
  files: string[];
}

interface Harness {
  root: string;
  roots: string[];
  service: VizService;
  aligned: CompareTo[];
  opened: { file: string; options: VizOpenOptions }[];
  generated: VizGeneratorRequest[];
  threads: ReviewThread[];
  seenCalls: { paths: string[]; seen: boolean }[];
  setCompareTo(next: CompareTo): void;
  generate(args: unknown, cwd?: string): Promise<{ ok: boolean; message: string }>;
  present(name: string): Promise<{ ok: boolean; message: string }>;
  writeViz(name: string, viz: unknown, root?: string): string;
  openEditor(file: string): Promise<{ panel: FakePanel; document: vscode.TextDocument }>;
}

function changesOf(repoRoot: string, paths: { path: string; status: FileStatus }[]) {
  const files = paths.map((file) => ({
    ...file,
    additions: 1,
    deletions: file.status === "A" ? 0 : 1,
  }));
  return {
    staged: [],
    unstaged: files.map((file) => ({ ...file, group: "unstaged" as const, repoRoot })),
    committed: [],
    net: files.map((file) => ({ ...file, contentId: file.path })),
    compareLabel: "merge-base(main)",
    compareRef: "abc123",
  } as unknown as RepositoryChangesModel;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

function harness(viz: VizFile, others: OtherRepo[] = []): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paireto-viz-")));
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web", "package.json"), "{}");
  const otherRoots = others.map((other) => ({
    ...other,
    root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paireto-viz-other-"))),
  }));
  const repositories = [
    { repoRoot: root, displayName: "shop", changes: changesOf(root, changedFilesFor(viz)) },
    ...otherRoots.map((other) => ({
      repoRoot: other.root,
      displayName: other.name,
      changes: changesOf(
        other.root,
        other.files.map((file) => ({ path: file, status: "M" as const })),
      ),
    })),
  ];
  const emitter = new vscode.EventEmitter<void>();
  let compareTo: CompareTo = { kind: "mergeBase" };
  const aligned: CompareTo[] = [];
  const threads: ReviewThread[] = [];
  const amend = (id: string, change: (thread: ReviewThread) => ReviewThread) => {
    const at = threads.findIndex((thread) => thread.id === id);
    if (at < 0) {
      return false;
    }
    threads[at] = change(threads[at]);
    emitter.fire();
    return true;
  };
  const review: VizReview = {
    getState: () => ({ compareTo, repositories }) as unknown as ReviewState,
    onDidChangeState: emitter.event,
    compareToFor: () => compareTo,
    setCompareTo: async (next) => {
      compareTo = next;
      aligned.push(next);
      emitter.fire();
    },
    isSessionActive: () => false,
    getComments: () => threads,
    getPendingComments: () => threads.filter((thread) => thread.delivery === "pending"),
    addDiagramComment: async (repoRoot, anchor, kind, body) => {
      const id = `note-${threads.length + 1}`;
      const at = "2026-11-15T00:00:00.000Z";
      threads.push(diagramThread({ id, at, kind, body, uri: `x:${id}`, repoRoot, anchor }));
      emitter.fire();
      return id;
    },
    diagramAnchorOf: (id) => threads.find((thread) => thread.id === id)?.diagram,
    relinkDiagramComment: (id, anchor: DiagramAnchor) =>
      amend(id, (thread) => ({ ...thread, diagram: anchor })),
    editDiagramComment: () => true,
    editDiagramReply: () => true,
    deleteDiagramComment: () => true,
    replyDiagramComment: () => true,
    readDiagramComment: () => true,
    moveDiagramComment: () => true,
    resolveComment: () => undefined,
    openAgainstCompareToAt: async () => undefined,
  };
  const seenEmitter = new vscode.EventEmitter<void>();
  const seenCalls: { paths: string[]; seen: boolean }[] = [];
  const opened: { file: string; options: VizOpenOptions }[] = [];
  const generated: VizGeneratorRequest[] = [];
  const service = new VizService({
    extensionUri: vscode.Uri.file(root),
    workspaceState: memento(),
    review,
    seen: {
      isSeen: () => false,
      setSeen: async (files: DeltaFile[], seen: boolean) => {
        seenCalls.push({ paths: files.map((file) => file.path), seen });
        seenEmitter.fire();
      },
      onDidChange: seenEmitter.event,
    },
    generate: async (req) => {
      generated.push(req);
      return { ...loadVizFixture("classDiagram"), title: req.title ?? "Generated" };
    },
    openEditor: async (uri, options) => {
      opened.push({ file: uri.fsPath, options });
    },
  });
  const envelope = (cwd: string) => ({
    v: "test",
    ts: new Date().toISOString(),
    id: "request-1",
    cwd,
    repoRoot: root,
    harness: "claudecode" as const,
  });
  return {
    root,
    roots: [root, ...otherRoots.map((other) => other.root)],
    service,
    aligned,
    opened,
    generated,
    threads,
    seenCalls,
    setCompareTo: (next) => {
      compareTo = next;
      emitter.fire();
    },
    generate: (args, cwd = root) => {
      const msg: VizGenerateRequest = { ...envelope(cwd), t: "viz.generate.request", args };
      return service.generate(msg);
    },
    present: (name) => {
      const msg: VizPresentRequest = {
        ...envelope(root),
        t: "viz.present.request",
        args: { name },
      };
      return service.present(msg);
    },
    writeViz: (name, payload, at = root) => {
      const file = vizPathOf(at, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      return file;
    },
    openEditor: async (file) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const posts: HostToWebview[] = [];
      const received = new vscode.EventEmitter<unknown>();
      const disposed = new vscode.EventEmitter<void>();
      const webview = {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: async (message: HostToWebview) => {
          posts.push(message);
          return true;
        },
        onDidReceiveMessage: received.event,
      };
      const panel = {
        webview,
        title: "",
        iconPath: undefined,
        viewColumn: vscode.ViewColumn.Two,
        reveal: () => undefined,
        onDidDispose: disposed.event,
      };
      service.resolveCustomTextEditor(document, panel as unknown as vscode.WebviewPanel);
      return {
        document,
        panel: {
          posts,
          send: async (message) => {
            received.fire(message);
            await tick();
            await tick();
          },
          dispose: () => disposed.fire(),
        },
      };
    },
  };
}

function lastOf<T extends HostToWebview["type"]>(
  panel: FakePanel,
  type: T,
): Extract<HostToWebview, { type: T }> | undefined {
  return panel.posts
    .filter((post): post is Extract<HostToWebview, { type: T }> => post.type === type)
    .at(-1);
}

function lastWindow(panel: FakePanel): VizWindowState | undefined {
  return panel.posts
    .flatMap((message) =>
      message.type === "load" || message.type === "window" ? [message.window] : [],
    )
    .at(-1);
}

async function replaceText(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
  await tick();
}

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

suite("viz service", () => {
  let current: Harness | undefined;

  teardown(async () => {
    current?.service.dispose();
    for (const root of current?.roots ?? []) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    current = undefined;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("generate with base none writes a skeleton and returns the change summary", async () => {
    current = harness(loadVizFixture("singleFrontend"));
    const result = await current.generate({ name: "checkout", base: "none", title: "Checkout" });
    assert.strictEqual(result.ok, true, result.message);
    const file = vizPathOf(current.root, "checkout");
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as VizFile;
    assert.strictEqual(written.base, "none");
    assert.strictEqual(written.title, "Checkout");
    assert.strictEqual(written.summary, SUMMARY_PLACEHOLDER);
    assert.deepStrictEqual(written.compareTo, { kind: "mergeBase" });
    assert.deepStrictEqual(written.nodes, []);
    assert.ok(written.generatedAt);
    const lines = result.message.split("\n");
    assert.strictEqual(lines[0], `Wrote ${file} (base none): 0 nodes, 0 edges.`);
    assert.strictEqual(
      lines[1],
      "Repo shop (this repo, omit repo on file refs). Compare To: merge-base(main) [mergeBase]. 7 changed files, +7 -5.",
    );
    assert.ok(lines.includes("Units: web [package.json] 7"));
    assert.ok(lines.includes("Level hint: component (1 unit changed)."));
    assert.strictEqual(
      lines.at(-1),
      `Read the diffs, then read and edit ${file}, then call paireto_viz_present with name "checkout".`,
    );
    assert.deepStrictEqual(current.generated, []);
  });

  test("generate with base changes asks the generator and says when it replaced a file", async () => {
    current = harness(loadVizFixture("singleFrontend"));
    current.setCompareTo({ kind: "ref", ref: "release" });
    await current.generate({ name: "types", base: "none" });
    const result = await current.generate({ name: "types", base: "changes" });
    assert.strictEqual(result.ok, true, result.message);
    assert.deepStrictEqual(current.generated, [
      { repoRoot: current.root, compareTo: { kind: "ref", ref: "release" }, title: undefined },
    ]);
    const file = vizPathOf(current.root, "types");
    const classes = loadVizFixture("classDiagram");
    assert.match(
      result.message,
      new RegExp(
        `^Replaced ${escaped(file)} \\(base changes\\): ${classes.nodes.length} nodes, ${classes.edges?.length ?? 0} edges\\.\nThe old file of this name is gone\\.\n`,
      ),
    );
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as VizFile;
    assert.strictEqual(written.base, "changes");
    assert.deepStrictEqual(written.compareTo, { kind: "ref", ref: "release" });
  });

  test("generate writes into the repo that holds the agent's cwd", async () => {
    current = harness(loadVizFixture("singleFrontend"), [{ name: "infra", files: ["main.tf"] }]);
    const infra = current.roots[1];
    fs.mkdirSync(path.join(infra, "modules"));
    const result = await current.generate(
      { name: "infra", base: "none" },
      path.join(infra, "modules"),
    );
    assert.strictEqual(result.ok, true, result.message);
    assert.ok(fs.existsSync(vizPathOf(infra, "infra")));
    assert.ok(!fs.existsSync(vizPathOf(current.root, "infra")));
    assert.match(result.message, /\nRepo infra \(this repo, omit repo on file refs\)/);
  });

  test("generate refuses bad arguments and a repo the window does not hold", async () => {
    current = harness(loadVizFixture("singleFrontend"));
    const bad = await current.generate({ name: "Bad Name", base: "none" });
    assert.strictEqual(bad.ok, false);
    const elsewhere = await current.service.generate({
      t: "viz.generate.request",
      v: "test",
      ts: "",
      id: "x",
      cwd: "/elsewhere",
      repoRoot: "/elsewhere",
      harness: "claudecode",
      args: { name: "x", base: "none" },
    });
    assert.strictEqual(elsewhere.ok, false);
    assert.match(elsewhere.message, /does not have \/elsewhere open/);
  });

  test("present returns errors with JSON paths and opens nothing", async () => {
    const viz = loadVizFixture("multiService");
    current = harness(viz);
    viz.nodes[2].lane = "sevrices";
    current.writeViz("pay", viz);
    const result = await current.present("pay");
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /^Viz rejected\. Fix all 1 in the file /);
    assert.match(result.message, /\n- nodes\[2\]\.lane: /);
    assert.deepStrictEqual(current.opened, []);
  });

  test("present opens a valid viz without focus and names a missing one", async () => {
    const viz = loadVizFixture("multiService");
    current = harness(viz);
    const file = current.writeViz("pay", viz);
    const result = await current.present("pay");
    assert.strictEqual(result.ok, true, result.message);
    assert.match(result.message, /^Viz "Retry soft-declined card charges" is open in VS Code/);
    assert.deepStrictEqual(current.opened, [
      { file, options: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true } },
    ]);
    const missing = await current.present("nope");
    assert.strictEqual(missing.ok, false);
    assert.match(missing.message, /no viz named "nope".*paireto_viz_generate/);
  });

  test("the editor loads on ready, keeps the last good doc and shows issues as diagnostics", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz);
    const file = current.writeViz("comments", viz);
    const { panel, document } = await current.openEditor(file);
    assert.strictEqual(panel.posts.length, 0);
    await panel.send({ type: "ready" });
    const load = lastOf(panel, "load");
    assert.strictEqual(load?.doc.viz.title, viz.title);
    assert.strictEqual(load?.doc.meta.name, "comments");
    assert.deepStrictEqual(load?.view, DEFAULT_VIZ_VIEW_STATE);
    assert.deepStrictEqual(
      load?.vizzes.map((entry) => entry.name),
      ["comments"],
    );

    const broken = structuredClone(viz);
    broken.nodes[1].parent = "nowhere";
    await replaceText(document, JSON.stringify(broken, null, 2));
    const invalid = lastOf(panel, "invalid");
    assert.strictEqual(invalid?.name, "comments");
    assert.deepStrictEqual(
      invalid?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.path),
      ["nodes[1].parent"],
    );
    const errors = vscode.languages
      .getDiagnostics(document.uri)
      .filter(
        (diagnostic) =>
          diagnostic.source === "Paireto viz" &&
          diagnostic.severity === vscode.DiagnosticSeverity.Error,
      );
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, "unknown-parent");
    assert.strictEqual(document.getText(errors[0].range), '"parent"');
    assert.strictEqual(panel.posts.filter((post) => post.type === "load").length, 1);

    await replaceText(document, JSON.stringify({ ...viz, title: "Fixed" }, null, 2));
    assert.strictEqual(lastOf(panel, "load")?.doc.viz.title, "Fixed");
    assert.strictEqual(fs.readFileSync(file, "utf8"), JSON.stringify(viz, null, 2));
  });

  test("the view state is kept per viz and sent back in the next load", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz);
    const file = current.writeViz("comments", viz);
    const first = await current.openEditor(file);
    await first.panel.send({ type: "ready" });
    const state = { ...DEFAULT_VIZ_VIEW_STATE, stage: "flow:edit", sidebar: false };
    await first.panel.send({ type: "viewState", state });
    first.panel.dispose();
    const second = await current.openEditor(file);
    await second.panel.send({ type: "ready" });
    assert.deepStrictEqual(lastOf(second.panel, "load")?.view, state);
  });

  test("a note on a node becomes a diagram thread with the node's code location", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz);
    const file = current.writeViz("comments", viz);
    const { panel } = await current.openEditor(file);
    await panel.send({ type: "ready" });
    await panel.send({
      type: "note.add",
      kind: "question",
      title: "",
      body: "Why a component?",
      targets: [{ kind: "node", id: "comment-thread", label: "CommentThread" }],
    });
    assert.deepStrictEqual(current.threads[0].diagram, {
      viz: "comments",
      title: "CommentThread",
      targets: [
        {
          kind: "node",
          id: "comment-thread",
          label: "CommentThread",
          code: {
            repoRoot: current.root,
            path: "web/src/comments/CommentThread.tsx",
            line: 30,
            side: "modified",
          },
        },
      ],
    });
    await settle();
    const notes = lastOf(panel, "review")?.review.notes;
    assert.deepStrictEqual(
      notes?.map((note) => ({ id: note.id, targets: note.targets, sent: note.sent })),
      [
        {
          id: "note-1",
          targets: [{ kind: "node", id: "comment-thread", label: "CommentThread" }],
          sent: false,
        },
      ],
    );
    await panel.send({
      type: "note.link",
      id: "note-1",
      target: { kind: "node", id: "comment-editor", label: "CommentEditor" },
    });
    assert.strictEqual(current.threads[0].diagram?.title, "CommentThread and 1 more");
    assert.strictEqual(current.threads[0].diagram?.targets[1].code?.line, 1);
  });

  test("regenerate leaves a question note that asks the agent to generate this viz again", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz);
    const file = current.writeViz("comments", viz);
    const { panel } = await current.openEditor(file);
    await panel.send({ type: "ready" });
    await panel.send({ type: "regenerate" });
    const thread = current.threads[0];
    assert.strictEqual(thread.items[0].commentKind, "question");
    assert.strictEqual(thread.delivery, "pending");
    assert.match(thread.items[0].body, /merge-base\(main\)/);
    assert.match(thread.items[0].body, /paireto_viz_generate with name "comments" and base "none"/);
    assert.deepStrictEqual(lastOf(panel, "showNote"), { type: "showNote", id: thread.id });
  });

  test("seen marks the changed file through the seen store", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz);
    const file = current.writeViz("comments", viz);
    const { panel } = await current.openEditor(file);
    await panel.send({ type: "ready" });
    const files = lastOf(panel, "load")?.review.files ?? [];
    assert.ok(files.some((entry) => entry.path === "web/src/comments/CommentThread.tsx"));
    await panel.send({
      type: "seen",
      repo: "shop",
      path: "web/src/comments/CommentThread.tsx",
      seen: true,
    });
    assert.deepStrictEqual(current.seenCalls, [
      { paths: ["web/src/comments/CommentThread.tsx"], seen: true },
    ]);
  });

  test("open newest picks the newest viz in the row's repo, and switch opens in the same group", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz, [{ name: "infra", files: [] }]);
    const old = current.writeViz("old", viz);
    const newer = current.writeViz("newer", viz);
    const other = current.writeViz("other", viz, current.roots[1]);
    fs.utimesSync(old, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(2000), new Date(2000));
    fs.utimesSync(other, new Date(3000), new Date(3000));
    await current.service.openNewest({
      kind: "repository",
      repository: { repoRoot: current.root },
    });
    await current.service.openNewest();
    assert.deepStrictEqual(
      current.opened.map((entry) => entry.file),
      [newer, other],
    );
    const { panel } = await current.openEditor(newer);
    await panel.send({ type: "ready" });
    await panel.send({ type: "switch", name: "old" });
    assert.deepStrictEqual(current.opened.at(-1), {
      file: old,
      options: { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
    });
  });

  test("align sets the window Compare To back to the viz's Compare To", async () => {
    const viz: VizFile = {
      ...loadVizFixture("singleFrontend"),
      compareTo: { kind: "ref", ref: "release" },
    };
    current = harness(viz);
    const file = current.writeViz("comments", viz);
    const { panel } = await current.openEditor(file);
    await panel.send({ type: "ready" });
    current.setCompareTo({ kind: "head" });
    await settle();
    assert.deepStrictEqual(lastWindow(panel)?.alignment, { kind: "available" });
    await panel.send({ type: "align" });
    assert.deepStrictEqual(current.aligned, [{ kind: "ref", ref: "release" }]);
  });

  test("align is refused when a ref snapshot would reach every repo", async () => {
    const viz: VizFile = {
      ...loadVizFixture("singleFrontend"),
      compareTo: { kind: "ref", ref: "release" },
    };
    current = harness(viz, [{ name: "infra", files: [] }]);
    const file = current.writeViz("comments", viz);
    const { panel } = await current.openEditor(file);
    await panel.send({ type: "ready" });
    const window = lastWindow(panel);
    assert.strictEqual(window?.alignment.kind, "blocked");
    assert.match(window.alignment.kind === "blocked" ? window.alignment.reason : "", /2 repos/);
    await panel.send({ type: "align" });
    assert.deepStrictEqual(current.aligned, []);
  });
});

suite("viz webview messages", () => {
  test("well-formed messages parse", () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
    const open = { type: "open", file: { path: "a.ts", line: 3, side: "base" }, mode: "diff" };
    assert.deepStrictEqual(parseWebviewMessage(open), open);
    const add = {
      type: "note.add",
      kind: "comment",
      title: "Cart",
      body: "Split this.",
      targets: [{ kind: "member", id: "cart.add", node: "cart", label: "add()" }],
      place: { node: "cart", x: 4, y: 8 },
    };
    assert.deepStrictEqual(parseWebviewMessage(add), add);
    assert.deepStrictEqual(parseWebviewMessage({ type: "gate", action: "approve" }), {
      type: "gate",
      action: "approve",
    });
  });

  test("malformed messages are dropped", () => {
    assert.strictEqual(
      parseWebviewMessage({ type: "open", file: { path: "" }, mode: "diff" }),
      undefined,
    );
    assert.strictEqual(
      parseWebviewMessage({ type: "open", file: { path: "a", x: 1 }, mode: "file" }),
      undefined,
    );
    assert.strictEqual(
      parseWebviewMessage({ type: "note.add", kind: "problem", title: "", body: "", targets: [] }),
      undefined,
    );
    assert.strictEqual(parseWebviewMessage({ type: "gate", action: "merge" }), undefined);
    assert.strictEqual(parseWebviewMessage({ type: "run", command: "rm" }), undefined);
    assert.strictEqual(parseWebviewMessage("ready"), undefined);
  });
});

suite("viz custom editor", () => {
  test("a .viz.json file opens in the Paireto viz editor by default", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paireto-viz-open-")));
    const file = vizPathOf(root, "opened");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(loadVizFixture("singleFrontend")));
    try {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputCustom, "the tab is a custom editor");
      assert.strictEqual(input.viewType, "paireto.viz");
      assert.strictEqual(input.uri.fsPath, file);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
