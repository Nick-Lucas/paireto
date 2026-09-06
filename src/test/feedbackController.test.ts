// What the review controller asks a FeedbackSession for, and what it reports to the window around
// it. The session's own rules — buckets, rendering, thread groups — are proved in
// feedbackSession.test.ts.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";

import * as vscode from "vscode";

import type { CommentSession, GateComment } from "../comments/CommentSession.js";
import type { CommentKind } from "../comments/kinds.js";
import type { ChangesModel } from "../git/DiffService.js";
import type { FeedbackRef } from "../git/gitCli.js";
import { PlanReviewController } from "../plan/PlanReviewController.js";
import { INCLUDE_FILE_COMMENTS } from "../plan/planCodeFeedback.js";
import { ReviewController } from "../review/ReviewController.js";
import {
  FeedbackSession,
  type FeedbackContext,
  type FeedbackHost,
} from "../review/feedback/FeedbackSession.js";
import type { ReviewThread } from "../review/reviewTypes.js";
import gitCli = require("../git/gitCli.js");
import feedbackId = require("../review/feedbackId.js");

const REPO = "/repo";
/** The review id every URI this window builds carries. */
const WINDOW = "current-window";

const branch = (value: string): FeedbackRef => ({ kind: "branch", value });

const comment = (id: string, repoRoot = REPO): ReviewThread => ({
  id,
  repoRoot,
  filePath: "src/a.ts",
  side: "modified",
  line: 2,
  anchor: {
    lineText: "const answer = 42;",
    contextBefore: [],
    contextAfter: [],
    lineHash: "hash",
  },
  delivery: "pending",
  createdAt: "2026-08-12T20:00:00.000Z",
  updatedAt: "2026-08-12T20:00:00.000Z",
  activities: [
    {
      kind: "feedback",
      feedbackKind: "question",
      body: id,
      quote: "const answer = 42;",
      at: "2026-08-12T20:00:00.000Z",
    },
  ],
});

const NO_CHANGES: ChangesModel = {
  staged: [],
  unstaged: [],
  committed: [],
  compareLabel: "main",
  compareRef: null,
};

/** The part of the controller these tests drive. Object.create skips the constructor, so each test
 *  supplies the fields its own path reads. */
interface Controller {
  feedbackHost(): FeedbackHost;
  useFeedback(session: FeedbackSession): void;
  getComments(): ReviewThread[];
  addComment(reply: vscode.CommentReply, kind: CommentKind): Promise<boolean>;
  revealComment(id: string): Promise<void>;
  markCommentsSent(items: ReviewThread[]): Promise<ReviewThread[]>;
  sendFeedback(): Promise<void>;
  cleanupReview(requestId: string): Promise<void>;
  refresh(reason?: string): Promise<void>;
  feedbackUri(model: ReviewThread): vscode.Uri;
  activeRequestId?: string;
}

function build(overrides: Record<string, unknown> = {}): Controller {
  return Object.assign(
    Object.create(ReviewController.prototype),
    {
      reviewId: WINDOW,
      changeEmitter: { fire() {} },
      changesetDocs: { set() {}, clear() {} },
      commentSession: fakeComments(),
      repositoryStates: new Map(),
      lastFeedbackRef: new Map(),
      roots: { gitRoots: [] },
    },
    overrides,
  ) as Controller;
}

/** Enough of a CommentSession for a render to draw through. The real Comments API is proved in
 *  commenting.test.ts. */
function fakeComments(): CommentSession {
  return {
    place(args: {
      uri: vscode.Uri;
      range: vscode.Range;
      label: string;
      comments: GateComment[];
      previous?: vscode.CommentThread;
    }): vscode.CommentThread {
      const reuse =
        args.previous?.uri.toString() === args.uri.toString() ? args.previous : undefined;
      const thread = reuse ?? ({ uri: args.uri, dispose() {} } as unknown as vscode.CommentThread);
      Object.assign(thread, { range: args.range, label: args.label, comments: [...args.comments] });
      for (const item of args.comments) {
        item.thread = thread;
      }
      return thread;
    },
    remove(item: GateComment): GateComment[] {
      item.thread = undefined;
      return [item];
    },
    disposeThreads() {},
  } as unknown as CommentSession;
}

/** A session that answers only what the send path asks it for. */
function heldFeedback(threads: ReviewThread[]): FeedbackSession {
  return { allThreads: () => threads, hasBucketFor: () => true } as unknown as FeedbackSession;
}

suite("review controller feedback", () => {
  let stateHome: string;
  const opened: FeedbackSession[] = [];

  setup(() => {
    stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-controller-"));
  });

  teardown(async () => {
    for (const session of opened.splice(0)) {
      // Close, not flush: the temporary directory goes away next.
      await session.close();
      session.dispose();
    }
    mock.restoreAll();
    fs.rmSync(stateHome, { recursive: true, force: true });
  });

  /** FeedbackSession.open reads the default feedback directory, so the state home points at a fresh
   *  one while the buckets open. A bucket resolves its file once, so the swap ends there. */
  async function openFeedback(
    host: FeedbackHost,
    roots: FeedbackContext["roots"],
  ): Promise<FeedbackSession> {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const session = await FeedbackSession.open({ roots }, host);
      opened.push(session);
      return session;
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previous;
      }
    }
  }

  /** A controller holding one open bucket for REPO. */
  async function withFeedback(
    overrides: Record<string, unknown> = {},
  ): Promise<{ c: Controller; session: FeedbackSession }> {
    const c = build(overrides);
    const session = await openFeedback(c.feedbackHost(), [{ repoRoot: REPO, ref: branch("main") }]);
    c.useFeedback(session);
    return { c, session };
  }

  test("sending uses the current store value instead of an earlier snapshot", async () => {
    const { c, session } = await withFeedback();
    await session.add(comment("send"));
    const before = c.getComments();

    await session.edit("send", "latest text");
    const sent = await c.markCommentsSent(before);

    assert.strictEqual(sent[0].activities[0].body, "latest text");
    assert.strictEqual(sent[0].delivery, "sent");
    assert.strictEqual(before[0].activities[0].body, "send", "the earlier snapshot is untouched");
    assert.strictEqual(before[0].delivery, "pending");
  });

  test("a code review stays open if no feedback is eligible", async () => {
    let fulfilled = false;
    const c = build({
      activeRequestId: "review",
      gate: {
        fulfill: () => {
          fulfilled = true;
        },
      },
    });
    c.useFeedback(heldFeedback([comment("retry")]));
    c.markCommentsSent = async () => [];

    await c.sendFeedback();

    assert.strictEqual(fulfilled, false);
  });

  test("sending feedback skips items no longer in a store", async () => {
    const { c, session } = await withFeedback();
    const ready = comment("ready-note");
    const waiting = comment("waiting-note", "/unknown");
    await session.add(ready);

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
    const ready = comment("ready-note");
    let feedback = "";
    const c = build({
      activeRequestId: "review",
      gate: {
        fulfill: (_id: string, result: { feedback: string }) => {
          feedback = result.feedback;
        },
      },
    });
    c.useFeedback(heldFeedback([ready, comment("waiting-note")]));
    c.markCommentsSent = async () => [ready];

    await c.sendFeedback();

    assert.match(feedback, /ready-note/);
    assert.doesNotMatch(feedback, /waiting-note/);
  });

  test("plan review includes only file feedback returned by markCommentsSent", async () => {
    const ready = comment("ready-note");
    const waiting = comment("waiting-note");
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
    mock.method(vscode.window, "showWarningMessage", async () => INCLUDE_FILE_COMMENTS);

    await c.sendFeedback(review);

    assert.match(reason, /plan-note/);
    assert.match(reason, /ready-note/);
    assert.doesNotMatch(reason, /waiting-note/);
  });

  test("review cleanup refreshes the branch before releasing the review slot", async () => {
    const order: string[] = [];
    const c = build({
      activeRequestId: "review",
      changesetDocs: {
        set() {},
        clear: () => order.push("clear-docs"),
      },
      setGuidedContext: async () => {},
      setReviewContext: async () => {},
      coordinator: { unregister: async () => {} },
      releaseReviewSlot: () => order.push("release"),
    });
    c.useFeedback({ render: () => order.push("render") } as unknown as FeedbackSession);
    c.refresh = async (reason) => {
      assert.strictEqual(reason, "review-ended");
      assert.strictEqual(c.activeRequestId, undefined, "the slot is already given up");
      order.push("refresh");
    };

    await c.cleanupReview("review");

    assert.deepStrictEqual(order, ["clear-docs", "render", "refresh", "release"]);
  });

  test("revealing a relocated comment saves its new line", async () => {
    const doc = await vscode.workspace.openTextDocument({ content: "inserted\na\n" });
    const { c, session } = await withFeedback({
      refresh: async () => {},
      changesFor: () => undefined,
      fallbackCommentUri: async () => doc.uri,
    });
    const model: ReviewThread = {
      ...comment("moved"),
      line: 0,
      anchor: { lineText: "a", contextBefore: [], contextAfter: [], lineHash: "hash" },
    };
    await session.add(model);

    await c.revealComment(model.id);

    assert.strictEqual(c.getComments()[0].line, 1, "the anchor found its new line");
    assert.strictEqual(model.line, 0, "the earlier snapshot is untouched");
  });

  test("restored diff addresses use this window", () => {
    const c = build();
    const model: ReviewThread = {
      ...comment("diff"),
      attachment: {
        group: "staged",
        baseRef: "INDEX",
        sourceUri: "paireto-review://old/a.ts?side=base",
      },
    };

    assert.strictEqual(c.feedbackUri(model).authority, WINDOW);
  });

  test("saved changeset descriptions with the same title have separate addresses", async () => {
    const docs = new Map<string, string>();
    const { c, session } = await withFeedback({
      changesetDocs: {
        set: (uri: vscode.Uri, markdown: string) => docs.set(uri.toString(), markdown),
        clear() {},
      },
    });
    const first = comment("first");
    const second = comment("second");
    for (const model of [first, second]) {
      model.sourceDocument = { uri: "paireto-changeset:/Same.md?id=cs1", markdown: model.id };
      await session.add(model);
    }

    assert.strictEqual(docs.size, 2);
    assert.strictEqual(docs.get(c.feedbackUri(first).toString()), "first");
    assert.strictEqual(docs.get(c.feedbackUri(second).toString()), "second");
  });

  test("a comment for a repository with no open bucket is refused and reported", async () => {
    const c = build({
      refresh: async () => {},
      roots: {
        gitRoots: [],
        gitRootForPath: () => ({ repoRoot: REPO, displayName: "repo", workspaceIndex: 0 }),
      },
    });
    const warning = mock.method(vscode.window, "showWarningMessage", async () => undefined);
    const mintId = mock.method(feedbackId, "newFeedbackId");
    const reply = {
      thread: {
        uri: vscode.Uri.file(path.join(REPO, "src/a.ts")),
        range: new vscode.Range(0, 0, 0, 0),
        comments: [],
      },
      text: "Rename this helper.",
    } as unknown as vscode.CommentReply;

    assert.strictEqual(await c.addComment(reply, "comment"), false);

    assert.strictEqual(warning.mock.callCount(), 1, "the refusal is said out loud");
    assert.strictEqual(mintId.mock.callCount(), 0, "a refused comment burns no id");
  });

  test("a context change is reported once, and not while a review is active", async () => {
    const emitter = new vscode.EventEmitter<FeedbackContext>();
    const seen: FeedbackContext[] = [];
    const listener = emitter.event((context) => seen.push(context));
    let ref = branch("main");
    mock.method(gitCli, "currentFeedbackRef", async () => ref);
    const c = build({
      feedbackContextEmitter: emitter,
      roots: { gitRoots: [{ repoRoot: REPO, displayName: "repo", workspaceIndex: 0 }] },
      refreshSeq: new Map(),
      refreshCounts: new Map(),
      openDiffs: new Map(),
      compareTo: { kind: "default" },
      diff: { getChanges: async () => NO_CHANGES },
      reviewContent: { refreshAllOpen() {} },
    });

    try {
      await c.refresh();
      assert.strictEqual(seen.length, 1);
      assert.deepStrictEqual(seen[0].roots, [{ repoRoot: REPO, ref: branch("main") }]);

      await c.refresh();
      assert.strictEqual(seen.length, 1, "an unchanged context is not reported again");

      ref = branch("other");
      c.activeRequestId = "review";
      await c.refresh();
      assert.strictEqual(seen.length, 1, "a live review keeps the feedback it opened with");

      c.activeRequestId = undefined;
      await c.refresh();
      assert.strictEqual(seen.length, 2);
      assert.deepStrictEqual(seen[1].roots, [{ repoRoot: REPO, ref: branch("other") }]);
    } finally {
      listener.dispose();
      emitter.dispose();
    }
  });
});
