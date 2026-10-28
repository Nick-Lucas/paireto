import * as assert from "node:assert";
import { mock } from "node:test";

import * as vscode from "vscode";

import type { ReviewGateResult } from "../bridge/types.js";
import * as gitCli from "../git/gitCli.js";
import type { FeedbackRef } from "../git/gitCli.js";
import {
  latestGuidedReview,
  toGuidedPlan,
  type CachedGuidedReview,
  type GuidedPlan,
} from "../review/guidedPlan.js";
import {
  ReviewController,
  type ReviewState,
  type ViewModeChoice,
} from "../review/ReviewController.js";
import { ReviewStore } from "../storage/ReviewStore.js";

const branch = (value: string): FeedbackRef => ({ kind: "branch", value });
const DETACHED: FeedbackRef = { kind: "detached", value: "HEAD" };

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
  get<T>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function planFor(repoRoot: string): GuidedPlan {
  return toGuidedPlan(
    repoRoot,
    [{ id: "c1", title: "Auth", description: "login", files: [{ path: "a.ts" }] }],
    {},
  );
}

function entry(repoRoot: string, ref: FeedbackRef, generatedAt: string): CachedGuidedReview {
  return { ref, generatedAt, plan: planFor(repoRoot) };
}

suite("guided review cache — latestGuidedReview", () => {
  test("returns the entry saved for each root's current branch", () => {
    const a = entry("/a", branch("main"), "2026-01-01T00:00:00.000Z");
    const b = entry("/b", branch("dev"), "2026-01-02T00:00:00.000Z");
    const refs = new Map([
      ["/a", branch("main")],
      ["/b", branch("dev")],
    ]);

    assert.strictEqual(latestGuidedReview([a, b], refs)?.plan.repoRoot, "/b");
    assert.strictEqual(latestGuidedReview([a], refs), a);
  });

  test("ignores an entry saved for another branch or another kind of ref", () => {
    const other = entry("/a", branch("feature"), "2026-01-01T00:00:00.000Z");
    const detached = entry("/a", DETACHED, "2026-01-02T00:00:00.000Z");

    assert.strictEqual(
      latestGuidedReview([other, detached], new Map([["/a", branch("main")]])),
      undefined,
    );
    assert.strictEqual(
      latestGuidedReview([other, detached], new Map([["/a", DETACHED]])),
      detached,
    );
  });

  test("ignores an entry for a root whose branch is not known", () => {
    const a = entry("/a", branch("main"), "2026-01-01T00:00:00.000Z");

    assert.strictEqual(latestGuidedReview([a], new Map()), undefined);
  });

  test("prefers the newest entry whatever the list order", () => {
    const older = entry("/a", branch("main"), "2026-01-01T00:00:00.000Z");
    const newer = entry("/b", branch("main"), "2026-03-01T00:00:00.000Z");
    const refs = new Map([
      ["/a", branch("main")],
      ["/b", branch("main")],
    ]);

    assert.strictEqual(latestGuidedReview([newer, older], refs), newer);
    assert.strictEqual(latestGuidedReview([older, newer], refs), newer);
  });
});

suite("guided review cache — ReviewStore", () => {
  test("a saved review is returned, and the guided view flag defaults to off", async () => {
    const store = new ReviewStore(new MemoryMemento());
    assert.deepStrictEqual(store.getGuidedReviews(), []);
    assert.strictEqual(store.getGuidedView(), false);

    const saved = entry("/a", branch("main"), "2026-01-01T00:00:00.000Z");
    await store.saveGuidedReview(saved);
    await store.setGuidedView(true);

    assert.deepStrictEqual(store.getGuidedReviews(), [saved]);
    assert.strictEqual(store.getGuidedView(), true);
  });

  test("saving again for the same root and branch replaces the old entry", async () => {
    const store = new ReviewStore(new MemoryMemento());
    const first = entry("/a", branch("main"), "2026-01-01T00:00:00.000Z");
    const otherBranch = entry("/a", branch("dev"), "2026-01-02T00:00:00.000Z");
    const otherRoot = entry("/b", branch("main"), "2026-01-03T00:00:00.000Z");
    const second = entry("/a", branch("main"), "2026-01-04T00:00:00.000Z");
    for (const saved of [first, otherBranch, otherRoot, second]) {
      await store.saveGuidedReview(saved);
    }

    assert.deepStrictEqual(store.getGuidedReviews(), [second, otherRoot, otherBranch]);
  });

  test("the list keeps only the newest entries", async () => {
    const store = new ReviewStore(new MemoryMemento());
    for (let index = 0; index < 25; index++) {
      await store.saveGuidedReview(entry("/a", branch(`b${index}`), "2026-01-01T00:00:00.000Z"));
    }

    const kept = store.getGuidedReviews();
    assert.strictEqual(kept.length, 20);
    assert.deepStrictEqual(kept[0].ref, branch("b24"));
    assert.deepStrictEqual(kept[19].ref, branch("b5"));
  });
});

interface GuidedController {
  startGuidedSession(
    requestId: string,
    sessionId: string | undefined,
    repoRoot: string,
    submitted: { changesets: unknown },
    displayName: string,
    signal: AbortSignal,
  ): Promise<ReviewGateResult>;
  cleanupReview(requestId: string): Promise<void>;
  applyViewMode(choice: ViewModeChoice): Promise<void>;
  getState(): ReviewState;
  lastFeedbackRef: Map<string, FeedbackRef>;
  activeRequestId?: string;
}

const REPO = "/repo";
const SUBMITTED = {
  changesets: [{ title: "Auth", description: "login", files: [{ path: "a.ts" }] }],
};

interface Harness {
  controller: GuidedController;
  store: ReviewStore;
  calls: string[];
}

function harness(): Harness {
  const store = new ReviewStore(new MemoryMemento());
  const calls: string[] = [];
  const controller = Object.assign(Object.create(ReviewController.prototype), {
    store,
    showGuided: false,
    mode: "staging",
    layout: "tree",
    compareTo: { kind: "head" },
    roots: { gitRoots: [{ repoRoot: REPO, displayName: "repo", workspaceIndex: 0 }] },
    repositoryStates: new Map(),
    lastFeedbackRef: new Map([[REPO, branch("main")]]),
    changeEmitter: { fire: () => calls.push("fire") },
    changesetDocs: { set() {}, clear: () => calls.push("clear-docs") },
    diff: { refExists: async () => true },
    coordinator: { unregister: async () => {} },
    acquireReviewSlot: async () => true,
    releaseReviewSlot: () => calls.push("release"),
    notifyReviewOpened: () => {},
    setReviewContext: async () => {},
    refresh: async (reason: string) => {
      calls.push(`refresh:${reason}`);
    },
    runReview: async (requestId: string): Promise<ReviewGateResult> => {
      (controller as unknown as GuidedController).activeRequestId = requestId;
      return { status: "submitted", feedback: "" };
    },
  }) as GuidedController;
  return { controller, store, calls };
}

suite("guided review cache — ReviewController", function () {
  this.timeout(30_000);

  teardown(() => mock.restoreAll());

  async function startSession(
    controller: GuidedController,
    ref: FeedbackRef | null = branch("main"),
  ): Promise<ReviewGateResult> {
    mock.method(gitCli, "currentFeedbackRef", async () => ref ?? undefined);
    return controller.startGuidedSession(
      "req",
      "session",
      REPO,
      SUBMITTED,
      "Agent",
      new AbortController().signal,
    );
  }

  test("the plan stays after the review is cleaned up", async () => {
    const { controller, store, calls } = harness();
    await startSession(controller);

    assert.strictEqual(controller.getState().guided?.changesets[0].title, "Auth");
    assert.strictEqual(store.getGuidedReviews().length, 1);
    assert.strictEqual(store.getGuidedView(), true);

    calls.length = 0;
    await controller.cleanupReview("req");

    assert.strictEqual(controller.getState().guided?.changesets[0].title, "Auth");
    assert.ok(!calls.includes("clear-docs"), "cleanup must keep the changeset documents");
    assert.ok(calls.includes("release"));
  });

  test("a new session replaces the changeset documents of the old plan", async () => {
    const { controller, calls } = harness();

    await startSession(controller);

    assert.deepStrictEqual(
      calls.filter((call) => call === "clear-docs"),
      ["clear-docs"],
    );
  });

  test("a session with no branch to key the plan on is cancelled and gives up the slot", async () => {
    const { controller, store, calls } = harness();

    const result = await startSession(controller, null);

    assert.deepStrictEqual(result, { status: "cancelled", feedback: "" });
    assert.deepStrictEqual(store.getGuidedReviews(), []);
    assert.ok(calls.includes("release"));
  });

  test("picking a file mode hides the plan and picking guided shows it again", async () => {
    const { controller, store } = harness();
    await startSession(controller);
    await controller.cleanupReview("req");

    await controller.applyViewMode({ kind: "mode", mode: "delta" });
    assert.strictEqual(controller.getState().guided, undefined);
    assert.strictEqual(controller.getState().mode, "delta");
    assert.strictEqual(store.getGuidedView(), false);

    await controller.applyViewMode({ kind: "guided" });
    assert.strictEqual(controller.getState().guided?.changesets[0].title, "Auth");
    assert.strictEqual(controller.getState().mode, "delta");
    assert.strictEqual(store.getGuidedView(), true);
  });

  test("the plan only shows on the branch it was made for", async () => {
    const { controller } = harness();
    await startSession(controller);
    await controller.cleanupReview("req");

    controller.lastFeedbackRef.set(REPO, branch("other"));
    assert.strictEqual(controller.getState().guided, undefined);

    controller.lastFeedbackRef.set(REPO, branch("main"));
    assert.strictEqual(controller.getState().guided?.changesets[0].title, "Auth");
  });
});
