import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import type { ChangesModel } from "../git/DiffService.js";
import type { CompareTo } from "../protocol/guidedReview.js";
import type { VizShowRequest } from "../protocol/types.js";
import type { VizArgs } from "../protocol/viz.js";
import type { ReviewState } from "../review/ReviewController.js";
import { parseWebviewMessage } from "../viz/host/VizPanel.js";
import { vizIdFor, VizService, type VizReview } from "../viz/host/VizService.js";
import { VIZ_STORE_LIMIT, VizStore } from "../viz/host/VizStore.js";
import { VIZ_DOC_FORMAT, type VizDoc } from "../viz/model/types.js";
import { changedFilesFor, loadVizFixture } from "./vizFixtures.js";

function memento(): Pick<vscode.Memento, "get" | "update"> & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string, fallback?: T) => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  } as Pick<vscode.Memento, "get" | "update"> & { data: Map<string, unknown> };
}

interface Harness {
  root: string;
  service: VizService;
  aligned: CompareTo[];
  request(viz: unknown, repoRoot?: string): VizShowRequest;
}

function harness(viz: VizArgs): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-viz-"));
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web", "package.json"), "{}");
  const changes: ChangesModel = {
    staged: [],
    unstaged: [],
    committed: [],
    net: changedFilesFor(viz).map((file) => ({ ...file, contentId: file.path })),
    compareLabel: "merge-base(main)",
    compareRef: "abc123",
  };
  const emitter = new vscode.EventEmitter<void>();
  let compareTo: CompareTo = { kind: "mergeBase" };
  const aligned: CompareTo[] = [];
  const review: VizReview = {
    getState: () =>
      ({
        compareTo,
        repositories: [{ repoRoot: root, displayName: "shop", changes }],
      }) as unknown as ReviewState,
    onDidChangeState: emitter.event,
    compareToFor: () => compareTo,
    setCompareTo: async (next) => {
      compareTo = next;
      aligned.push(next);
      emitter.fire();
    },
  };
  const service = new VizService({
    extensionUri: vscode.Uri.file(root),
    memento: memento(),
    review,
    getChanges: async () => changes,
  });
  return {
    root,
    service,
    aligned,
    request: (payload, repoRoot = root) => ({
      t: "viz.show.request",
      v: "test",
      ts: new Date().toISOString(),
      id: "request-1",
      cwd: repoRoot,
      repoRoot,
      harness: "claudecode",
      viz: payload,
    }),
  };
}

async function closePanels(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

suite("viz service", () => {
  let current: Harness | undefined;

  teardown(async () => {
    current?.service.dispose();
    if (current) {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
    current = undefined;
    await closePanels();
  });

  test("an accepted viz is stored and opens in the panel", async () => {
    const viz = loadVizFixture("multiService");
    current = harness(viz);
    const result = await current.service.show(current.request(viz));
    assert.strictEqual(result.ok, true, result.message);
    assert.match(result.message, /^Viz "Retry soft-declined card charges" is open in VS Code/);
    assert.deepStrictEqual(current.service.inspect(), {
      open: true,
      vizId: vizIdFor(current.root, viz.title),
      title: viz.title,
      stored: 1,
    });
  });

  test("a rejected viz opens nothing and stores nothing", async () => {
    const viz = loadVizFixture("multiService");
    current = harness(viz);
    viz.nodes[2].lane = "sevrices";
    const result = await current.service.show(current.request(viz));
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /^Viz rejected\. Fix all 1 /);
    assert.deepStrictEqual(current.service.inspect(), { open: false, stored: 0 });
  });

  test("the same title replaces the stored viz, a new title adds one", async () => {
    const viz = loadVizFixture("multiService");
    current = harness(viz);
    await current.service.show(current.request(viz));
    await current.service.show(current.request({ ...viz, summary: "Second take." }));
    assert.strictEqual(current.service.inspect().stored, 1);
    const result = await current.service.show(current.request({ ...viz, title: "Another view" }));
    assert.strictEqual(result.ok, true, result.message);
    assert.deepStrictEqual(current.service.inspect(), {
      open: true,
      vizId: vizIdFor(current.root, "Another view"),
      title: "Another view",
      stored: 2,
    });
  });

  test("a closed panel reopens on the newest viz", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz);
    await current.service.show(current.request(viz));
    await closePanels();
    assert.strictEqual(current.service.inspect().open, false);
    assert.strictEqual(current.service.reopen(), true);
    assert.deepStrictEqual(current.service.inspect(), {
      open: true,
      vizId: vizIdFor(current.root, viz.title),
      title: viz.title,
      stored: 1,
    });
  });

  test("a repo the window does not hold is refused", async () => {
    const viz = loadVizFixture("multiService");
    current = harness(viz);
    const result = await current.service.show(current.request(viz, "/elsewhere"));
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /does not have \/elsewhere open/);
    const described = await current.service.describeChanges({
      ...current.request(undefined, "/elsewhere"),
      t: "changes.describe.request",
    });
    assert.strictEqual(described.ok, false);
  });

  test("the changes description names the repo, its Compare To and its units", async () => {
    const viz = loadVizFixture("singleFrontend");
    current = harness(viz);
    const result = await current.service.describeChanges({
      ...current.request(undefined),
      t: "changes.describe.request",
    });
    assert.strictEqual(result.ok, true, result.message);
    const lines = result.message.split("\n");
    assert.strictEqual(
      lines[0],
      "Repo shop (this repo, omit repo on file refs). Compare To: merge-base(main) [mergeBase]. 7 changed files, +7 -5.",
    );
    assert.strictEqual(lines[1], "Units: web [package.json] 7");
    assert.ok(lines.includes("Level hint: component (1 unit changed)."));
  });
});

suite("viz store", () => {
  function doc(id: string): VizDoc {
    return {
      format: VIZ_DOC_FORMAT,
      meta: {
        id,
        repoRoot: "/work/shop",
        repoName: "shop",
        repos: [{ name: "shop", root: "/work/shop" }],
        harness: "claudecode",
        compareTo: { kind: "head" },
        compareLabel: "HEAD",
        createdAt: "2026-11-10T00:00:00.000Z",
        changed: [],
      },
      viz: { ...loadVizFixture("singleFrontend"), title: `Viz ${id}` },
    };
  }

  test("stored entries with another format or a bad payload are dropped", () => {
    const state = memento();
    state.data.set("paireto.vizDocs", [
      doc("good"),
      { ...doc("old"), format: 0 },
      { ...doc("broken"), viz: { title: "no lanes" } },
      "junk",
    ]);
    assert.deepStrictEqual(
      new VizStore(state).all().map((stored) => stored.meta.id),
      ["good"],
    );
  });

  test("put keeps the newest first, replaces by id and keeps at most the limit", async () => {
    const store = new VizStore(memento());
    for (let i = 0; i < VIZ_STORE_LIMIT + 2; i++) {
      await store.put(doc(`v${i}`));
    }
    await store.put(doc("v5"));
    const ids = store.all().map((stored) => stored.meta.id);
    assert.strictEqual(ids.length, VIZ_STORE_LIMIT);
    assert.deepStrictEqual(ids.slice(0, 3), ["v5", "v11", "v10"]);
    assert.strictEqual(ids.filter((id) => id === "v5").length, 1);
  });
});

suite("viz webview messages", () => {
  test("well-formed messages parse", () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
    assert.deepStrictEqual(
      parseWebviewMessage({ type: "open", file: { path: "a.ts", line: 3 }, mode: "diff" }),
      { type: "open", file: { path: "a.ts", line: 3 }, mode: "diff" },
    );
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
    assert.strictEqual(parseWebviewMessage({ type: "run", command: "rm" }), undefined);
    assert.strictEqual(parseWebviewMessage("ready"), undefined);
  });
});
