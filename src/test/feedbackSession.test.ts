// The feedback session drawn against a real CommentSession and real bucket files. XDG_STATE_HOME
// points at a fresh directory for each test, because FeedbackSession.open uses the default
// feedbackDir(). Two buckets must never share a file: they also share one temporary path.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";

import * as vscode from "vscode";

import { CommentSession, GateComment, saveComment } from "../comments/CommentSession.js";
import type { FeedbackRef } from "../git/gitCli.js";
import { log } from "../log.js";
import {
  FeedbackSession,
  contextKey,
  type FeedbackHost,
} from "../review/feedback/FeedbackSession.js";
import { appendFeedbackReply, resolveThread } from "../review/feedbackState.js";
import { getOpeningComment, type ReviewThread } from "../review/reviewTypes.js";
import { feedbackFilePath, type FeedbackState } from "../storage/FeedbackStore.js";

const SCHEME = "paireto-feedback-session-doc";
const REPO = "/paireto-session-repo";
const OTHER = "/paireto-session-other";
const MAIN: FeedbackRef = { kind: "branch", value: "main" };
const WHEN = "2026-08-12T20:00:00.000Z";

const branch = (value: string): FeedbackRef => ({ kind: "branch", value });

/** A thread with replies already on it, named the way the store names them. */
const withReplies = (
  model: ReviewThread,
  replies: Array<{ who: "reviewer" | "agent"; body: string; kind?: "reply" | "resolved" }>,
): ReviewThread =>
  replies.reduce((item, reply, index) => {
    const at = `2026-08-12T2${index}:00:00.000Z`;
    const author =
      reply.who === "reviewer"
        ? ({ kind: "reviewer" } as const)
        : ({ kind: "agent", harness: "claudecode" } as const);
    return reply.kind === "resolved"
      ? resolveThread(item, { at, author })
      : appendFeedbackReply(item, { body: reply.body, at, author });
  }, model);

const comment = (id: string, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  repoRoot: REPO,
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
  createdAt: WHEN,
  updatedAt: WHEN,
  items: [
    {
      kind: "comment",
      commentKind: "comment",
      body: id,
      quote: "const answer = 42;",
      at: WHEN,
    },
  ],
  ...over,
});

/** The bodies on a thread. Deep-equalling comment objects hangs mocha's reporter, so use text. */
const bodies = (thread: vscode.CommentThread): string[] =>
  thread.comments.map((item) => String((item as GateComment).body));

suite("feedback session", () => {
  let docA: vscode.TextDocument;
  let docB: vscode.TextDocument;
  let docC: vscode.TextDocument;
  let provider: vscode.Disposable;

  let previousXdg: string | undefined;
  let stateHome: string;
  let comments: CommentSession;
  let host: TestHost;
  let sessions: FeedbackSession[] = [];
  let seq = 0;

  /** What the session asks of its owner, with every answer under the test's control. */
  class TestHost implements FeedbackHost {
    readonly registered: { uri: string; markdown: string }[] = [];
    changes = 0;
    uriFor: (model: ReviewThread) => vscode.Uri = (model) =>
      vscode.Uri.parse(model.sourceDocument?.uri ?? model.sourceUri ?? docA.uri.toString());
    labelFor: (model: ReviewThread) => string = (model) => `${model.filePath}:${model.line + 1}`;

    private readonly waiters: (() => void)[] = [];

    constructor(readonly comments: CommentSession) {}

    registerDoc(uri: vscode.Uri, markdown: string): void {
      this.registered.push({ uri: uri.toString(), markdown });
    }

    changed(): void {
      this.changes++;
      this.waiters.splice(0).forEach((resolve) => resolve());
    }

    /** Answers on the next write, so a fire-and-forget editor action can be waited on. */
    nextChange(): Promise<void> {
      return new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  suiteSetup(async () => {
    const contents = new Map<string, string>();
    provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? "",
    });
    const openDoc = async (name: string): Promise<vscode.TextDocument> => {
      const uri = vscode.Uri.parse(`${SCHEME}://t/${name}.ts`);
      contents.set(
        uri.toString(),
        Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
      );
      return vscode.workspace.openTextDocument(uri);
    };
    docA = await openDoc("a");
    docB = await openDoc("b");
    docC = await openDoc("c");
  });

  suiteTeardown(() => provider.dispose());

  setup(() => {
    previousXdg = process.env.XDG_STATE_HOME;
    // A short root keeps the socket path the state dir also holds inside the sun_path limit.
    const root = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
    stateHome = fs.mkdtempSync(path.join(root, "pai-fbs-"));
    process.env.XDG_STATE_HOME = stateHome;
    comments = new CommentSession(`paireto-feedback-session-${++seq}`, "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    host = new TestHost(comments);
  });

  teardown(async () => {
    mock.restoreAll();
    for (const session of sessions) {
      // Close, not flush: the temporary directory goes away next.
      await session.close();
      session.dispose();
    }
    sessions = [];
    comments.dispose();
    if (previousXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdg;
    }
    fs.rmSync(stateHome, { recursive: true, force: true });
  });

  /** Put threads in a bucket file before any session opens it. */
  function seed(models: ReviewThread[], repoRoot = REPO, ref = MAIN): void {
    const file = feedbackFilePath(repoRoot, ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, state: { threads: models } }));
  }

  /** What a freshly opened window would read for this bucket. */
  function stored(repoRoot = REPO, ref = MAIN): ReviewThread[] {
    const file = feedbackFilePath(repoRoot, ref);
    if (!fs.existsSync(file)) {
      return [];
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { state: FeedbackState };
    return saved.state.threads;
  }

  const ids = (models: ReviewThread[]): string[] => models.map((model) => model.id);

  async function openSession(
    roots: { repoRoot: string; ref: FeedbackRef }[] = [{ repoRoot: REPO, ref: MAIN }],
  ): Promise<FeedbackSession> {
    const session = await FeedbackSession.open({ roots }, host);
    sessions.push(session);
    return session;
  }

  test("opening a session puts every stored comment back on its document", async () => {
    seed([
      comment("on-a", { sourceUri: docA.uri.toString(), line: 1 }),
      comment("on-b", { sourceUri: docB.uri.toString(), line: 3 }),
    ]);

    const session = await openSession();

    assert.deepStrictEqual(ids(session.allThreads()).sort(), ["on-a", "on-b"]);
    const first = session.commentFor("on-a")!;
    const second = session.commentFor("on-b")!;
    assert.strictEqual(first.thread!.uri.toString(), docA.uri.toString());
    assert.strictEqual(second.thread!.uri.toString(), docB.uri.toString());
    assert.strictEqual(first.thread!.range?.start.line, 1);
    assert.deepStrictEqual(bodies(first.thread!), ["on-a"]);
    assert.deepStrictEqual(bodies(second.thread!), ["on-b"]);
    assert.strictEqual(comments.threads().length, 2);
  });

  test("a thread restores with its whole conversation, in the order it was said", async () => {
    seed([
      withReplies(comment("opener"), [
        { who: "reviewer", body: "and another thing" },
        { who: "agent", body: "fixed both" },
      ]),
      comment("alone", { line: 5 }),
    ]);

    const session = await openSession();

    const opener = session.commentFor("opener")!;
    assert.deepStrictEqual(bodies(opener.thread!), ["opener", "and another thing", "fixed both"]);
    assert.strictEqual(comments.threads().length, 2, "one thread per piece of feedback");
    assert.notStrictEqual(session.commentFor("alone")!.thread, opener.thread);
  });

  test("the reviewer's own replies stay theirs to edit, an agent's do not", async () => {
    seed([
      withReplies(comment("opener"), [
        { who: "reviewer", body: "mine" },
        { who: "agent", body: "theirs" },
      ]),
    ]);
    const session = await openSession();

    const mine = session.commentFor("opener#1");
    assert.ok(mine, "the reviewer's reply is a comment of its own");
    assert.strictEqual(String(mine.body), "mine");
    assert.strictEqual(session.commentFor("opener#2"), undefined, "an agent answer is read-only");
  });

  test("a restored comment carries its model id, so a reply can join its thread", async () => {
    seed([comment("opener")]);
    const session = await openSession();
    const thread = session.commentFor("opener")!.thread!;

    // A reply is routed by the id of the comment that opens the thread it was typed into.
    assert.strictEqual((thread.comments[0] as GateComment).id, "opener");
    session.addReply("opener", "a follow-up");

    assert.deepStrictEqual(bodies(thread), ["opener", "a follow-up"]);
    assert.strictEqual(comments.threads().length, 1, "a reply opens no second thread");
    assert.deepStrictEqual(ids(session.allThreads()), ["opener"], "and no second feedback item");
  });

  test("a resolution is carried by the thread, not drawn as another comment", async () => {
    seed([
      withReplies(comment("opener"), [
        { who: "agent", body: "fixed it" },
        { who: "agent", body: "", kind: "resolved" },
      ]),
    ]);
    const session = await openSession();

    const thread = session.commentFor("opener")!.thread!;
    assert.deepStrictEqual(bodies(thread), ["opener", "fixed it"], "no Resolved pseudo-comment");
    assert.strictEqual(thread.state, vscode.CommentThreadState.Resolved);
    assert.strictEqual(thread.label, "Marked as resolved");
  });

  test("the reviewer's reply makes a delivered thread sendable again", async () => {
    seed([comment("sent-already", { delivery: "sent" })]);
    const session = await openSession();

    session.addReply("sent-already", "one more thing");

    assert.strictEqual(session.allThreads()[0].delivery, "pending");
  });

  test("adding feedback creates its comment from store state", async () => {
    const session = await openSession();
    const add = mock.method(comments, "add", (): GateComment => {
      throw new Error("direct UI creation");
    });

    await session.add(comment("added"));

    assert.strictEqual(add.mock.callCount(), 0, "the comment comes from the render, not from add");
    const drawn = session.commentFor("added")!;
    assert.strictEqual(String(drawn.body), "added");
    assert.strictEqual(drawn.thread!.uri.toString(), docA.uri.toString());
    await session.flush();
    assert.deepStrictEqual(ids(stored()), ["added"]);
  });

  test("a delete reaches the store before the comment leaves the editor", async () => {
    seed([comment("gone")]);
    const session = await openSession();
    let heldAtRemoval: string[] | undefined;
    const original = comments.remove.bind(comments);
    const remove = mock.method(comments, "remove", (target: GateComment): GateComment[] => {
      heldAtRemoval = ids(session.allThreads());
      return original(target);
    });

    await session.removeCommentOrThread("gone");

    assert.strictEqual(remove.mock.callCount(), 1);
    assert.deepStrictEqual(heldAtRemoval, [], "the store is already clear when the editor is told");
    assert.strictEqual(session.commentFor("gone"), undefined);
    await session.flush();
    assert.deepStrictEqual(stored(), []);
    assert.strictEqual(comments.threads().length, 0);
  });

  test("deleting the comment that opens a thread takes its whole conversation", async () => {
    seed([
      withReplies(comment("opener"), [
        { who: "reviewer", body: "mine" },
        { who: "agent", body: "theirs" },
      ]),
      comment("alone", { line: 5 }),
    ]);
    const session = await openSession();

    await session.removeCommentOrThread("opener");

    assert.deepStrictEqual(ids(session.allThreads()), ["alone"]);
    await session.flush();
    assert.deepStrictEqual(ids(stored()), ["alone"]);
    assert.strictEqual(session.commentFor("opener"), undefined);
    assert.strictEqual(session.commentFor("opener#1"), undefined);
    assert.strictEqual(comments.threads().length, 1);
  });

  test("deleting one reply leaves the thread and everything else on it", async () => {
    seed([
      withReplies(comment("opener"), [
        { who: "reviewer", body: "first" },
        { who: "reviewer", body: "second" },
      ]),
    ]);
    const session = await openSession();

    await session.removeCommentOrThread("opener#1");

    assert.deepStrictEqual(ids(session.allThreads()), ["opener"], "the thread stays");
    assert.deepStrictEqual(bodies(session.commentFor("opener")!.thread!), ["opener", "second"]);
    assert.strictEqual(session.commentFor("opener#1"), undefined);
  });

  test("the reply count for a delete counts only the reviewer's own words", async () => {
    seed([
      withReplies(comment("opener"), [
        { who: "reviewer", body: "mine" },
        { who: "agent", body: "theirs" },
      ]),
      comment("alone", { line: 5 }),
    ]);
    const session = await openSession();

    assert.strictEqual(
      session.repliesFor("opener").length,
      1,
      "the agent answer is not the user's",
    );
    assert.strictEqual(session.repliesFor("alone").length, 0);
  });

  test("a rendering failure does not prevent the store write", async () => {
    const session = await openSession();
    host.uriFor = () => {
      throw new Error("editor unavailable");
    };

    await session.add(comment("kept"));

    assert.deepStrictEqual(ids(session.allThreads()), ["kept"]);
    await session.flush();
    assert.deepStrictEqual(ids(stored()), ["kept"]);
  });

  test("one change notification per write", async () => {
    const session = await openSession();
    host.changes = 0;

    await session.add(comment("counted"));
    assert.strictEqual(host.changes, 1);

    await session.edit("counted", "edited");
    assert.strictEqual(host.changes, 2);

    session.render();
    assert.strictEqual(host.changes, 2, "a render on its own is not a change");

    await session.removeCommentOrThread("counted");
    assert.strictEqual(host.changes, 3);
  });

  test("an edit in the editor reaches the store and keeps the previous snapshot", async () => {
    seed([comment("saved")]);
    const session = await openSession();
    const before = session.allThreads();
    const drawn = session.commentFor("saved")!;

    drawn.body = "edited in the editor";
    const written = host.nextChange();
    saveComment(drawn);
    await written;

    assert.strictEqual(getOpeningComment(session.allThreads()[0]).body, "edited in the editor");
    assert.strictEqual(
      getOpeningComment(before[0]).body,
      "saved",
      "the earlier snapshot is untouched",
    );
  });

  test("a store change does not overwrite text the user is still typing", async () => {
    seed([comment("typing")]);
    const session = await openSession();
    const drawn = session.commentFor("typing")!;
    drawn.mode = vscode.CommentMode.Editing;
    drawn.body = "half typed";

    await session.edit("typing", "from the store");

    assert.strictEqual(String(drawn.body), "half typed");
    assert.strictEqual(getOpeningComment(session.allThreads()[0]).body, "from the store");
  });

  test("a comment that moves document gets a new thread and the old one is disposed", async () => {
    seed([comment("moved", { sourceUri: docA.uri.toString() })]);
    const session = await openSession();
    const before = session.commentFor("moved")!.thread!;

    await session.relocate("moved", { line: 4, sourceUri: docB.uri.toString() });

    const after = session.commentFor("moved")!.thread!;
    assert.notStrictEqual(after, before, "a new document needs a new thread");
    assert.strictEqual(after.uri.toString(), docB.uri.toString());
    assert.strictEqual(after.range?.start.line, 4);
    assert.strictEqual(comments.threads().length, 1, "the vacated thread is not kept");
    assert.strictEqual(comments.threads()[0], after);
    await session.flush();
    assert.strictEqual(stored()[0].sourceUri, docB.uri.toString());
    assert.strictEqual(stored()[0].line, 4);
  });

  test("a comment that stays on its document keeps its thread and its collapsed state", async () => {
    seed([comment("stays", { sourceUri: docA.uri.toString() })]);
    const session = await openSession();
    const before = session.commentFor("stays")!.thread!;
    before.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

    await session.relocate("stays", { line: 5, sourceUri: docA.uri.toString() });

    const after = session.commentFor("stays")!.thread!;
    assert.strictEqual(after, before, "the same document keeps the same thread");
    assert.strictEqual(after.range?.start.line, 5);
    assert.strictEqual(after.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
  });

  test("relocating a thread moves its whole conversation", async () => {
    seed([
      withReplies(comment("opener", { sourceUri: docA.uri.toString() }), [
        { who: "reviewer", body: "and this" },
      ]),
    ]);
    const session = await openSession();

    await session.relocate("opener", { line: 6, sourceUri: docB.uri.toString() });

    const model = session.allThreads()[0];
    assert.strictEqual(model.sourceUri, docB.uri.toString());
    assert.strictEqual(model.line, 6);
    const thread = session.commentFor("opener")!.thread!;
    assert.strictEqual(session.commentFor("opener#1")!.thread, thread, "the reply travels with it");
    assert.strictEqual(thread.uri.toString(), docB.uri.toString());
    assert.deepStrictEqual(bodies(thread), ["opener", "and this"]);
    assert.strictEqual(comments.threads().length, 1);
  });

  test("restored threads are expanded", async () => {
    seed([comment("open-me")]);

    const session = await openSession();

    assert.strictEqual(
      session.commentFor("open-me")!.thread!.collapsibleState,
      vscode.CommentThreadCollapsibleState.Expanded,
    );
  });

  test("a two-root context labels a restored thread with its repository name", async () => {
    seed([comment("here", { line: 1 })], REPO);
    seed([comment("there", { repoRoot: OTHER, line: 3 })], OTHER);
    host.labelFor = (model) => `${path.basename(model.repoRoot)}: ${model.filePath}`;

    const session = await openSession([
      { repoRoot: REPO, ref: MAIN },
      { repoRoot: OTHER, ref: MAIN },
    ]);

    assert.strictEqual(
      session.commentFor("here")!.thread!.label,
      `${path.basename(REPO)}: src/a.ts`,
    );
    assert.strictEqual(
      session.commentFor("there")!.thread!.label,
      `${path.basename(OTHER)}: src/a.ts`,
    );
  });

  test("marking sent answers the current stored values, not the caller's snapshot", async () => {
    seed([comment("send")]);
    const session = await openSession();
    const snapshot = session.allThreads();

    await session.edit("send", "latest text");
    const sent = await session.markSent(new Set(["send"]), "2026-09-01T00:00:00.000Z");

    assert.strictEqual(getOpeningComment(sent[0]).body, "latest text");
    assert.strictEqual(sent[0].delivery, "sent");
    assert.strictEqual(getOpeningComment(snapshot[0]).body, "send");
    assert.strictEqual(snapshot[0].delivery, "pending");
  });

  test("marking sent skips ids no longer held", async () => {
    seed([comment("here")]);
    const session = await openSession();

    const sent = await session.markSent(new Set(["here", "gone"]), "2026-09-01T00:00:00.000Z");

    assert.deepStrictEqual(ids(sent), ["here"]);
    assert.strictEqual(session.allThreads()[0].delivery, "sent");
  });

  test("marking sent does not re-stamp a comment already delivered", async () => {
    seed([comment("once")]);
    const session = await openSession();

    await session.markSent(new Set(["once"]), "2026-09-01T00:00:00.000Z");
    await session.markSent(new Set(["once"]), "2026-09-02T00:00:00.000Z");

    assert.strictEqual(session.allThreads()[0].delivery, "sent");
    assert.strictEqual(session.allThreads()[0].updatedAt, "2026-09-01T00:00:00.000Z");
  });

  test("clearing empties every bucket and takes every thread down", async () => {
    seed([comment("here", { line: 1 })], REPO);
    seed([comment("there", { repoRoot: OTHER, line: 3 })], OTHER);
    const session = await openSession([
      { repoRoot: REPO, ref: MAIN },
      { repoRoot: OTHER, ref: MAIN },
    ]);
    assert.strictEqual(comments.threads().length, 2);

    await session.clear();

    assert.deepStrictEqual(session.allThreads(), []);
    await session.flush();
    assert.deepStrictEqual(stored(REPO), []);
    assert.deepStrictEqual(stored(OTHER), []);
    assert.strictEqual(comments.threads().length, 0);
    assert.strictEqual(session.commentFor("here"), undefined);
  });

  test("a write for a repository with no open bucket is refused and logged", async () => {
    seed([comment("held")]);
    const session = await openSession();
    const errors = mock.method(log, "error");

    await session.add(comment("stray", { repoRoot: OTHER }));

    assert.deepStrictEqual(ids(session.allThreads()), ["held"]);
    await session.flush();
    assert.deepStrictEqual(ids(stored()), ["held"]);
    assert.strictEqual(session.commentFor("stray"), undefined);
    assert.ok(
      errors.mock.calls.some((call) =>
        /no feedback bucket is open/.test(String(call.arguments[0])),
      ),
      "the refusal is written to the log",
    );
  });

  test("a repository root is found whatever the spelling of its path", async () => {
    seed([comment("held")]);
    const session = await openSession([
      { repoRoot: `${REPO}/../${path.basename(REPO)}`, ref: MAIN },
    ]);

    assert.deepStrictEqual(
      ids(session.allThreads()),
      ["held"],
      "the same file backs both spellings",
    );
    assert.strictEqual(session.hasBucketFor(REPO), true);
    assert.strictEqual(session.hasBucketFor(`${REPO}/`), true);
    assert.strictEqual(session.hasBucketFor(OTHER), false);

    await session.add(comment("added", { repoRoot: `${REPO}/.` }));

    await session.flush();
    assert.deepStrictEqual(ids(stored()).sort(), ["added", "held"]);
  });

  test("a changeset description is registered on every render, not only when its thread is created", async () => {
    const description = { uri: docC.uri.toString(), markdown: "# What changed" };
    seed([comment("about-the-plan", { sourceDocument: description })]);
    const session = await openSession();
    assert.deepStrictEqual(host.registered, [description]);

    await session.edit("about-the-plan", "second thoughts");

    assert.deepStrictEqual(host.registered, [description, description]);
    assert.strictEqual(
      session.commentFor("about-the-plan")!.thread!.uri.toString(),
      docC.uri.toString(),
    );
  });

  test("flushing a session with no pending change writes nothing", async () => {
    seed([comment("read-only")]);
    const session = await openSession();
    const rename = mock.method(fs.promises, "rename");

    await session.flush();

    assert.strictEqual(rename.mock.callCount(), 0);
  });

  test("flushing a session writes its pending change, and dispose takes its threads down", async () => {
    const session = await openSession();
    session.add(comment("last"));

    await session.flush();

    assert.deepStrictEqual(ids(stored()), ["last"]);
    session.dispose();
    assert.strictEqual(comments.threads().length, 0);
    assert.strictEqual(session.commentFor("last"), undefined);
  });

  test("dispose takes down only this session's threads", async () => {
    seed([comment("mine")]);
    const session = await openSession();
    const widget = comments.controller.createCommentThread(
      docB.uri,
      new vscode.Range(0, 0, 0, 0),
      [],
    );
    const foreign = comments.add({ thread: widget, text: "foreign" }, "comment");
    assert.strictEqual(comments.threads().length, 2);

    session.dispose();

    assert.strictEqual(comments.threads().length, 1);
    assert.strictEqual(comments.threads()[0], foreign.thread);
    assert.deepStrictEqual(bodies(foreign.thread!), ["foreign"]);
  });
});

suite("feedback context identity", () => {
  test("one context whatever the spelling of its roots, another when a ref moves", () => {
    const key = contextKey({
      roots: [
        { repoRoot: REPO, ref: MAIN },
        { repoRoot: OTHER, ref: branch("work") },
      ],
    });

    assert.strictEqual(
      contextKey({
        roots: [
          { repoRoot: `${REPO}/../${path.basename(REPO)}`, ref: branch("main") },
          { repoRoot: `${OTHER}/`, ref: branch("work") },
        ],
      }),
      key,
    );
    assert.notStrictEqual(
      contextKey({
        roots: [
          { repoRoot: REPO, ref: MAIN },
          { repoRoot: OTHER, ref: branch("other") },
        ],
      }),
      key,
    );
    assert.notStrictEqual(
      contextKey({
        roots: [
          { repoRoot: REPO, ref: { kind: "detached", value: "HEAD" } },
          { repoRoot: OTHER, ref: branch("work") },
        ],
      }),
      key,
    );
  });
});
