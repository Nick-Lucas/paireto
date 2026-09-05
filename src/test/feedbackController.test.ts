import * as assert from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import * as vscode from "vscode";

import { CommentSession, GateComment, type CommentCallbacks } from "../comments/CommentSession.js";
import type { FeedbackRef } from "../git/gitCli.js";
import { ReviewController } from "../review/ReviewController.js";
import type { ReviewThread } from "../review/reviewTypes.js";
import feedbackStorage = require("../storage/FeedbackStore.js");
import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { FeedbackState, RepoFeedbackStore } from "../storage/FeedbackStore.js";

const realGetFeedbackStore = feedbackStorage.getFeedbackStore;
const realGetWorkspaceFeedbackStore = feedbackStorage.getWorkspaceFeedbackStore;
let storeForRepo: (root: string, ref: FeedbackRef) => Promise<TestStore>;
import { PlanReviewController } from "../plan/PlanReviewController.js";
import { INCLUDE_FILE_COMMENTS } from "../plan/planCodeFeedback.js";

const branch = (value: string): FeedbackRef => ({ kind: "branch", value });
const item = (id: string): ReviewThread => ({
  id,
  repoRoot: "/repo",
  filePath: "a.ts",
  side: "modified",
  line: 0,
  anchor: { lineText: "a", lineHash: "a", contextBefore: [], contextAfter: [] },
  delivery: "pending",
  createdAt: "now",
  updatedAt: "now",
  activities: [{ kind: "feedback", feedbackKind: "comment", body: id, quote: "a", at: "now" }],
});

type TestStore = RepoFeedbackStore;

function testStore(threads: ReviewThread[] = [], ref: FeedbackRef | null = branch("a")): TestStore {
  return createStore<FeedbackState>()(
    subscribeWithSelector(immer(() => ({ repoRoot: "/repo", ref: ref ?? undefined, threads }))),
  );
}

function activeStore(c: Harness, root: string): RepoFeedbackStore {
  return c.feedbackStores.get(root)?.store ?? c.workspaceFeedback!.store;
}

function seed(c: Harness, model: ReviewThread, ref?: FeedbackRef): void {
  if (ref && !c.feedbackStores.has(model.repoRoot)) {
    c.observeFeedbackStore(model.repoRoot, testStore([], ref));
  }
  activeStore(c, model.repoRoot).setState((draft) => {
    draft.threads.push(model);
  });
}

interface Harness {
  feedbackStores: Map<string, { store: RepoFeedbackStore; unsubscribe: () => void }>;
  workspaceFeedback?: { store: RepoFeedbackStore; unsubscribe: () => void };
  observeFeedbackStore(root: string, store: RepoFeedbackStore): void;
  observeWorkspaceFeedbackStore(store: RepoFeedbackStore): void;
  loadWorkspaceFeedback(root: string): Promise<RepoFeedbackStore>;
  getComments(): ReviewThread[];
  addFeedback(
    model: ReviewThread,
    reply: vscode.CommentReply,
    kind: "comment",
    label: string,
  ): Promise<void>;
  latestFeedbackSyncByRepo: Map<string, symbol>;
  comments: Map<string, { repoRoot: string; comment: GateComment }>;
  activeRequestId?: string;
  reviewId: string;
  syncFeedbackBucket(root: string, ref: FeedbackRef): Promise<void>;
  restoreFeedback(model: ReviewThread): void;
  restoreFeedbackUri(model: ReviewThread): vscode.Uri;
  restoreChangesetDocs(): void;
  clearAllFeedback(): Promise<void>;
  dispose(): void;
  markCommentsSent(items: ReviewThread[]): Promise<ReviewThread[]>;
  sendFeedback(): Promise<void>;
  refresh(): Promise<void>;
  cleanupReview(id: string): Promise<void>;
  revealComment(id: string): Promise<void>;
  changesetDocs: { set(uri: vscode.Uri, markdown: string): void; clear(): void };
}

function harness(): Harness {
  const stores = new Map<string, TestStore>();
  storeForRepo = async (root, ref) => {
    const key = `${root}:${ref.kind}:${ref.value}`;
    if (!stores.has(key)) {
      stores.set(key, testStore([], ref));
    }
    return stores.get(key)!;
  };
  const c = Object.assign(Object.create(ReviewController.prototype), {
    feedbackStores: new Map(),
    latestFeedbackSyncByRepo: new Map(),
    comments: new Map(),
    reviewId: "current-window",
    changeEmitter: { fire() {} },
    disposables: [],
    drainGate() {},
    commentSession: {
      add(reply: vscode.CommentReply, kind: "comment", callbacks: CommentCallbacks) {
        const comment = new GateComment(reply.text, kind);
        Object.assign(comment, callbacks);
        comment.thread = reply.thread;
        reply.thread.comments = [...reply.thread.comments, comment];
        return comment;
      },
      remove(comment: GateComment) {
        comment.thread = undefined;
      },
      restore(uri: vscode.Uri, range: vscode.Range, comment: GateComment, label: string) {
        comment.thread = {
          uri,
          range,
          label,
          comments: [comment],
          dispose() {},
        } as unknown as vscode.CommentThread;
      },
      reattach(comment: GateComment, uri: vscode.Uri, range: vscode.Range, label: string) {
        Object.assign(comment.thread!, { uri, range, label });
        return comment.thread;
      },
    },
    roots: { gitRoots: [] },
    repositoryStates: new Map([["/repo", {}]]),
    refreshSeq: new Map(),
    refreshCounts: new Map(),
    openDiffs: new Map(),
    compareTo: { kind: "default" },
    reviewContent: { refreshAllOpen() {} },
    changesetDocs: { set() {}, clear() {} },
    setGuidedContext: async () => {},
    setReviewContext: async () => {},
    coordinator: { unregister: async () => {} },
    releaseReviewSlot() {},
  }) as Harness;
  c.observeWorkspaceFeedbackStore(testStore([], null));
  return c;
}

suite("feedback controller persistence", () => {
  setup(() => {
    mock.method(
      feedbackStorage,
      "getFeedbackStore",
      (root: string, ref: FeedbackRef) => storeForRepo(root, ref) as Promise<RepoFeedbackStore>,
    );
  });
  teardown(() => {
    mock.restoreAll();
  });
  test("adding feedback without a branch writes to the workspace file", async () => {
    const root = await mkdtemp(join(tmpdir(), "paireto-workspace-controller-"));
    const c = harness();
    c.workspaceFeedback!.unsubscribe();
    c.workspaceFeedback = undefined;
    let identity: string[] = [];
    const factory = mock.method(feedbackStorage, "getWorkspaceFeedbackStore", (paths: string[]) => {
      identity = paths;
      return realGetWorkspaceFeedbackStore(paths, root);
    });
    try {
      const thread = {
        uri: vscode.Uri.file("/repo/a.ts"),
        range: new vscode.Range(0, 0, 0, 1),
        comments: [],
      } as unknown as vscode.CommentThread;
      await c.addFeedback(item("fallback"), { thread, text: "fallback" }, "comment", "a.ts:1");
      const file = vscode.workspace.workspaceFile;
      assert.deepStrictEqual(
        identity,
        file && file.scheme !== "untitled"
          ? [file.fsPath]
          : vscode.workspace.workspaceFolders!.map((folder) => folder.uri.fsPath),
      );
      const saved = JSON.parse(
        await readFile(feedbackStorage.workspaceFeedbackFilePath(identity, root), "utf8"),
      );
      assert.strictEqual(saved.state.threads[0].id, "fallback");
      assert.strictEqual(c.getComments()[0], c.workspaceFeedback!.store.getState().threads[0]);
      assert.strictEqual(c.feedbackStores.size, 0);
    } finally {
      c.dispose();
      factory.mock.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("controller reads store edits and notifies the UI without a save call", async () => {
    const root = await mkdtemp(join(tmpdir(), "paireto-store-source-"));
    try {
      const c = harness();
      const store = await realGetFeedbackStore("/repo", branch("a"), root);
      await store.setState((draft) => {
        draft.threads.push(item("live"));
      });
      storeForRepo = async () => store;
      await c.syncFeedbackBucket("/repo", branch("a"));
      let changes = 0;
      Object.assign(c, {
        changeEmitter: {
          fire() {
            changes++;
          },
        },
      });
      await store.setState((draft) => {
        draft.threads[0].activities[0].body = "edited in store";
      });
      const reader = c as unknown as { getComments(): ReviewThread[] };
      assert.strictEqual(reader.getComments()[0].activities[0].body, "edited in store");
      assert.strictEqual(changes, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removing a workspace root detaches feedback without saving or deleting it", async () => {
    const c = harness();
    seed(c, item("kept"), branch("a"));
    let saves = 0;
    storeForRepo = async () => {
      saves++;
      return testStore();
    };
    await c.refresh();
    assert.strictEqual(c.comments.size, 0);
    assert.strictEqual(c.feedbackStores.size, 0);
    assert.strictEqual(saves, 0);
  });

  test("a later bucket load replaces an earlier pending load", async () => {
    const c = harness();
    const store = testStore([item("b")]);
    let finish!: (store: TestStore) => void;
    let firstCall = true;
    storeForRepo = async () => {
      if (firstCall) {
        firstCall = false;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return store;
    };
    const first = c.syncFeedbackBucket("/repo", branch("a"));
    await c.syncFeedbackBucket("/repo", branch("b"));
    finish(testStore([item("a")]));
    await first;
    assert.deepStrictEqual([...c.comments.keys()], ["b"]);
  });

  test("returning to the active branch cancels a pending switch", async () => {
    const c = harness();
    seed(c, item("a"), branch("a"));
    let finish!: (store: TestStore) => void;
    storeForRepo = async () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = c.syncFeedbackBucket("/repo", branch("b"));
    await c.syncFeedbackBucket("/repo", branch("a"));
    finish(testStore([item("b")]));
    await pending;
    assert.deepStrictEqual([...c.comments.keys()], ["a"]);
  });

  test("workspace feedback remains visible when a branch store opens", async () => {
    const c = harness();
    c.activeRequestId = "review";
    seed(c, item("live"));
    const store = testStore([item("stored")]);
    storeForRepo = async () => store;
    await c.syncFeedbackBucket("/repo", branch("a"));
    assert.deepStrictEqual([...c.comments.keys()].sort(), ["live", "stored"]);
    assert.deepStrictEqual(
      store
        .getState()
        .threads.map((item) => item.id)
        .sort(),
      ["stored"],
    );
    assert.deepStrictEqual(
      c.workspaceFeedback!.store.getState().threads.map((model) => model.id),
      ["live"],
    );
  });

  test("comment edits update the store and preserve previous snapshots", async () => {
    const c = harness();
    seed(c, item("saved"), branch("a"));
    const store = activeStore(c, "/repo");
    const before = store.getState();
    c.comments.get("saved")!.comment.onSaved!("edited");
    assert.strictEqual(store.getState().threads[0].activities[0].body, "edited");
    assert.strictEqual(before.threads[0].activities[0].body, "saved");
    assert.strictEqual(c.getComments()[0], store.getState().threads[0]);
  });

  test("store additions and deletions update inline comments", () => {
    const c = harness();
    const store = activeStore(c, "/repo");
    store.setState((draft) => {
      draft.threads.push(item("new"));
    });
    assert.strictEqual(c.comments.get("new")!.comment.body, "new");
    store.setState((draft) => {
      draft.threads = [];
    });
    assert.strictEqual(c.comments.size, 0);
    assert.deepStrictEqual(c.getComments(), []);
  });

  test("store edits preserve unsaved editor text", () => {
    const c = harness();
    seed(c, item("editing"), branch("a"));
    const comment = c.comments.get("editing")!.comment;
    comment.mode = vscode.CommentMode.Editing;
    comment.body = "unfinished edit";
    activeStore(c, "/repo").setState((draft) => {
      draft.threads[0].delivery = "sent";
    });
    assert.strictEqual(comment.body, "unfinished edit");
  });

  test("switching buckets removes the old UI subscription", async () => {
    const c = harness();
    seed(c, item("old"), branch("a"));
    const old = activeStore(c, "/repo");
    const next = testStore([item("new")], branch("b"));
    storeForRepo = async () => next;
    await c.syncFeedbackBucket("/repo", branch("b"));
    let changes = 0;
    Object.assign(c, {
      changeEmitter: {
        fire() {
          changes++;
        },
      },
    });
    old.setState((draft) => {
      draft.threads.push(item("hidden"));
    });
    assert.strictEqual(changes, 0);
    assert.deepStrictEqual(
      c.getComments().map((model) => model.id),
      ["new"],
    );
    next.setState((draft) => {
      draft.threads[0].activities[0].body = "visible edit";
    });
    assert.strictEqual(changes, 1);
    assert.strictEqual(c.comments.get("new")!.comment.body, "visible edit");
  });

  test("removing a workspace root and disposing stop store notifications", async () => {
    for (const remove of [true, false]) {
      const c = harness();
      seed(c, item("kept"), branch("a"));
      const store = activeStore(c, "/repo");
      if (remove) {
        await c.refresh();
      } else {
        c.dispose();
      }
      let changes = 0;
      Object.assign(c, {
        changeEmitter: {
          fire() {
            changes++;
          },
        },
      });
      store.setState((draft) => {
        draft.threads[0].activities[0].body = "after detach";
      });
      assert.strictEqual(changes, 0);
      assert.deepStrictEqual(c.getComments(), []);
    }
  });

  test("workspace feedback survives branch switches without being copied into branch files", async () => {
    const c = harness();
    seed(c, item("workspace"));
    seed(c, item("branch-a"), branch("a"));
    const next = testStore([item("branch-b")], branch("b"));
    storeForRepo = async () => next;
    await c.syncFeedbackBucket("/repo", branch("b"));
    assert.deepStrictEqual(
      c
        .getComments()
        .map((model) => model.id)
        .sort(),
      ["branch-b", "workspace"],
    );
    assert.deepStrictEqual([...c.comments.keys()].sort(), ["branch-b", "workspace"]);
    c.workspaceFeedback!.store.setState((draft) => {
      draft.threads[0].activities[0].body = "updated";
    });
    assert.strictEqual(c.comments.get("workspace")!.comment.body, "updated");
    assert.strictEqual(c.comments.get("branch-b")!.comment.body, "branch-b");
    c.workspaceFeedback!.store.setState((draft) => {
      draft.threads = [];
    });
    assert.deepStrictEqual([...c.comments.keys()], ["branch-b"]);
    assert.deepStrictEqual(
      next.getState().threads.map((model) => model.id),
      ["branch-b"],
    );
  });

  test("workspace comment edits still use the workspace store after a ref is known", async () => {
    const c = harness();
    seed(c, item("live"));
    const store = testStore([item("stored")]);
    storeForRepo = async () => store;
    await c.syncFeedbackBucket("/repo", branch("a"));
    c.comments.get("live")!.comment.onSaved!("assigned edit");
    assert.strictEqual(
      c.workspaceFeedback!.store.getState().threads.find((model) => model.id === "live")!
        .activities[0].body,
      "assigned edit",
    );
  });

  test("sending uses the current store value instead of an earlier snapshot", async () => {
    const c = harness();
    seed(c, item("send"), branch("a"));
    const before = c.getComments();
    c.comments.get("send")!.comment.onSaved!("latest text");
    const sent = await c.markCommentsSent(before);
    assert.strictEqual(sent[0].activities[0].body, "latest text");
    assert.strictEqual(sent[0].delivery, "sent");
    assert.strictEqual(before[0].activities[0].body, "send");
    assert.strictEqual(before[0].delivery, "pending");
  });

  test("clearing feedback updates the stores and removes inline comments", async () => {
    const c = harness();
    seed(c, item("clear"), branch("a"));
    const store = activeStore(c, "/repo");
    const warning = mock.method(vscode.window, "showWarningMessage", async () => "Clear All");
    try {
      await c.clearAllFeedback();
    } finally {
      warning.mock.restore();
    }
    assert.deepStrictEqual(store.getState().threads, []);
    assert.strictEqual(c.comments.size, 0);
  });

  test("workspace feedback can be sent without a Git ref", async () => {
    const c = harness();
    const model = item("retry");
    seed(c, model);
    const showError = mock.method(vscode.window, "showErrorMessage", async () => undefined);
    try {
      assert.strictEqual((await c.markCommentsSent([model]))[0].delivery, "sent");
      assert.strictEqual(model.delivery, "pending");
      assert.strictEqual(showError.mock.callCount(), 0);
    } finally {
      showError.mock.restore();
    }
  });

  test("a code review stays open if no feedback is eligible", async () => {
    const c = harness();
    c.activeRequestId = "review";
    seed(c, item("retry"));
    let fulfilled = false;
    c.markCommentsSent = async () => [];
    Object.assign(c, {
      gate: {
        fulfill: () => {
          fulfilled = true;
        },
      },
    });
    await c.sendFeedback();
    assert.strictEqual(fulfilled, false);
  });

  test("sending feedback skips items no longer in a store", async () => {
    const c = harness();
    const ready = item("ready-note");
    const waiting = { ...item("waiting-note"), repoRoot: "/unknown" };
    seed(c, ready, branch("main"));
    const sent = await c.markCommentsSent([ready, waiting]);
    assert.deepStrictEqual(
      sent.map((model) => model.id),
      [ready.id],
    );
    assert.strictEqual(c.getComments().find((model) => model.id === ready.id)!.delivery, "sent");
    assert.strictEqual(ready.delivery, "pending");
    assert.strictEqual(waiting.delivery, "pending");
  });

  test("code review sends only the feedback returned by markCommentsSent", async () => {
    const c = harness();
    c.activeRequestId = "review";
    const ready = item("ready-note");
    seed(c, ready);
    seed(c, item("waiting-note"));
    c.markCommentsSent = async () => [ready];
    let feedback = "";
    Object.assign(c, {
      gate: {
        fulfill: (_id: string, result: { feedback: string }) => {
          feedback = result.feedback;
        },
      },
    });
    await c.sendFeedback();
    assert.match(feedback, /ready-note/);
    assert.doesNotMatch(feedback, /waiting-note/);
  });

  test("plan review includes only file feedback returned by markCommentsSent", async () => {
    const ready = item("ready-note");
    const waiting = item("waiting-note");
    const review = { id: "plan", key: "plan-key", sessionId: "session", harness: "codex" };
    let reason = "";
    const c = Object.assign(Object.create(PlanReviewController.prototype), {
      plans: new Map([[review.id, review]]),
      collect: () => [{ line: 0, quote: "plan", body: "plan-note", kind: "comment" }],
      codeFeedback: {
        getPendingComments: () => [ready, waiting],
        isSessionActive: () => false,
        isMultiRepository: () => false,
        markCommentsSent: async () => [ready],
      },
      locator: { strategyFor: () => ({ planToolName: "submit_plan" }) },
      registry: {
        fulfill: (_key: string, result: { reason: string }) => {
          reason = result.reason;
        },
      },
    }) as { sendFeedback(review: unknown): Promise<void> };
    const warning = mock.method(
      vscode.window,
      "showWarningMessage",
      async () => INCLUDE_FILE_COMMENTS,
    );
    try {
      await c.sendFeedback(review);
      assert.match(reason, /plan-note/);
      assert.match(reason, /ready-note/);
      assert.doesNotMatch(reason, /waiting-note/);
    } finally {
      warning.mock.restore();
    }
  });

  test("review cleanup refreshes the branch before releasing the review slot", async () => {
    const c = harness();
    c.activeRequestId = "review";
    let refreshed = false;
    c.refresh = async () => {
      assert.strictEqual(c.activeRequestId, undefined);
      refreshed = true;
    };
    await c.cleanupReview("review");
    assert.ok(refreshed);
  });

  test("restored diff addresses use this window", () => {
    const c = harness();
    const model = item("diff");
    model.attachment = {
      group: "staged",
      baseRef: "INDEX",
      sourceUri: "paireto-review://old/a.ts?side=base",
    };
    assert.strictEqual(c.restoreFeedbackUri(model).authority, "current-window");
  });

  test("saved changeset descriptions with the same title have separate addresses", () => {
    const c = harness();
    const first = item("first");
    const second = item("second");
    for (const model of [first, second]) {
      model.sourceDocument = { uri: "paireto-changeset:/Same.md?id=cs1", markdown: model.id };
      seed(c, model);
    }
    const docs = new Map<string, string>();
    c.changesetDocs.set = (uri, markdown) => {
      docs.set(uri.toString(), markdown);
    };
    c.restoreChangesetDocs();
    assert.strictEqual(docs.size, 2);
    assert.strictEqual(docs.get(c.restoreFeedbackUri(first).toString()), "first");
    assert.strictEqual(docs.get(c.restoreFeedbackUri(second).toString()), "second");
  });

  test("review cleanup moves live changeset threads to their saved descriptions", () => {
    const c = harness();
    const model = item("snapshot");
    model.sourceDocument = { uri: "paireto-changeset:/Same.md?id=cs1", markdown: "original" };
    seed(c, model);
    c.comments.get(model.id)!.comment.thread = {
      uri: vscode.Uri.parse(model.sourceDocument.uri),
      range: new vscode.Range(0, 0, 0, 1),
      label: "Same",
    } as vscode.CommentThread;
    let attached: string | undefined;
    Object.assign(c, {
      commentSession: {
        reattach: (_comment: GateComment, uri: vscode.Uri) => {
          attached = uri.toString();
        },
      },
    });
    c.restoreChangesetDocs();
    assert.strictEqual(attached, c.restoreFeedbackUri(model).toString());
  });

  test("revealing a relocated comment saves its new line", async () => {
    const c = harness();
    const doc = await vscode.workspace.openTextDocument({ content: "inserted\na\n" });
    const model = item("moved");
    seed(c, model);
    const thread = {
      uri: doc.uri,
      range: new vscode.Range(0, 0, 0, 1),
      comments: [c.comments.get(model.id)!.comment],
    } as unknown as vscode.CommentThread;
    c.comments.get(model.id)!.comment.thread = thread;
    Object.assign(c, {
      refresh: async () => {},
      changesFor: () => undefined,
      fallbackCommentUri: async () => doc.uri,
      commentSession: { reattach: () => thread },
    });
    await c.revealComment(model.id);
    assert.strictEqual(c.getComments()[0].line, 1);
    assert.strictEqual(model.line, 0);
  });

  test("restored comment threads are expanded", () => {
    const session = new CommentSession("feedback-restore-test", "Test", "file", {});
    try {
      const thread = session.restore(
        vscode.Uri.file("/repo/a.ts"),
        new vscode.Range(0, 0, 0, 1),
        new GateComment("a", "comment"),
        "Test",
      );
      assert.strictEqual(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    } finally {
      session.dispose();
    }
  });
});
