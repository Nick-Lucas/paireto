// One plan comment and its replies are one conversation, and one piece of feedback. These run in the
// VS Code Extension Host, so the comment threads are real ones the reviewer could type into.

import * as assert from "node:assert";

import * as vscode from "vscode";

import {
  CommentSession,
  GateComment,
  deleteComment,
  saveComment,
} from "../comments/CommentSession.js";
import { PlanThreads } from "../plan/PlanThreads.js";

const SCHEME = "paireto-plan-threads-test";
const PLAN = ["# Plan", "", "Step one.", "Step two."].join("\n");

suite("plan comment threads", () => {
  let providerReg: vscode.Disposable;
  let session: CommentSession;
  let threads: PlanThreads;
  let changes: number;
  let uri: vscode.Uri;

  setup(async () => {
    uri = vscode.Uri.parse(`${SCHEME}://t/plan.md`);
    providerReg = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: () => PLAN,
    });
    await vscode.workspace.openTextDocument(uri);
    session = new CommentSession("paireto-plan-threads", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    changes = 0;
    threads = new PlanThreads(session, () => changes++);
  });

  teardown(() => {
    threads.dispose();
    session.dispose();
    providerReg.dispose();
  });

  /** The widget VS Code opens for a comment on a line, with the words typed into it. */
  function widget(line: number, text: string): vscode.CommentReply {
    const thread = session.controller.createCommentThread(
      uri,
      new vscode.Range(line, 0, line, 0),
      [],
    );
    return { thread, text };
  }

  const drawn = (thread: vscode.CommentThread): GateComment[] =>
    thread.comments.filter((item): item is GateComment => item instanceof GateComment);

  test("a comment and its replies reach the agent as one item, of the comment's kind", () => {
    const opening = widget(2, "Split step two.");
    threads.open(opening, "question", "Step one.");
    assert.strictEqual(threads.addReply({ thread: opening.thread, text: "Or drop it." }), true);

    assert.deepStrictEqual(threads.commentsFor(uri), [
      { line: 2, quote: "Step one.", body: "Split step two.\n\nOr drop it.", kind: "question" },
    ]);
    assert.deepStrictEqual(
      drawn(opening.thread).map((comment) => String(comment.body)),
      ["Split step two.", "Or drop it."],
      "both sit on the thread the reviewer typed into",
    );
  });

  test("a reply to a thread this holds nothing for is refused", () => {
    threads.open(widget(2, "Mine."), "comment", "Step one.");
    const other = session.controller.createCommentThread(uri, new vscode.Range(3, 0, 3, 0), []);

    assert.strictEqual(threads.addReply({ thread: other, text: "Nowhere to land." }), false);
    assert.strictEqual(threads.commentsFor(uri).length, 1);
  });

  test("an edit to a reply changes what is sent", () => {
    const opening = widget(2, "Split step two.");
    threads.open(opening, "comment", "Step one.");
    threads.addReply({ thread: opening.thread, text: "Or drop it." });

    const reply = drawn(opening.thread)[1];
    reply.body = "Or leave it.";
    saveComment(reply);

    assert.strictEqual(threads.commentsFor(uri)[0].body, "Split step two.\n\nOr leave it.");
  });

  test("deleting a reply leaves the comment it answers", () => {
    const opening = widget(2, "Split step two.");
    threads.open(opening, "comment", "Step one.");
    threads.addReply({ thread: opening.thread, text: "Or drop it." });

    deleteComment(drawn(opening.thread)[1]);

    assert.strictEqual(threads.commentsFor(uri)[0].body, "Split step two.");
    assert.deepStrictEqual(
      drawn(opening.thread).map((comment) => String(comment.body)),
      ["Split step two."],
    );
  });

  test("deleting the comment that opens a thread takes the whole conversation", () => {
    const opening = widget(2, "Split step two.");
    threads.open(opening, "comment", "Step one.");
    threads.addReply({ thread: opening.thread, text: "Or drop it." });

    deleteComment(drawn(opening.thread)[0]);

    assert.deepStrictEqual(threads.commentsFor(uri), []);
    assert.strictEqual(session.threads().length, 0, "its thread goes down with it");
  });

  test("every change tells the owner, so the panel keeps up", () => {
    const opening = widget(2, "Split step two.");
    threads.open(opening, "comment", "Step one.");
    threads.addReply({ thread: opening.thread, text: "Or drop it." });
    deleteComment(drawn(opening.thread)[1]);

    assert.strictEqual(changes, 3);
  });

  test("the conversation already sent is drawn beside the plan it revises", () => {
    const opening = widget(2, "Split step two.");
    threads.open(opening, "question", "Step one.");
    threads.addReply({ thread: opening.thread, text: "Or drop it." });

    const previous = uri.with({ fragment: "previous" });
    threads.showSent(previous, threads.threadsFor(uri));

    const shown = session.threads().filter((thread) => thread.uri.fragment === "previous");
    assert.strictEqual(shown.length, 1, "one thread for the one conversation");
    assert.strictEqual(shown[0].label, "Sent question");
    assert.strictEqual(shown[0].canReply, false, "what was said has been said");
    assert.strictEqual(
      shown[0].collapsibleState,
      vscode.CommentThreadCollapsibleState.Expanded,
      "the reader came to read it",
    );
    assert.deepStrictEqual(
      shown[0].comments.map((comment) => String(comment.body)),
      ["Split step two.", "Or drop it."],
    );
    assert.strictEqual(
      shown[0].comments.some((comment) => comment instanceof GateComment),
      false,
      "none of it is the reviewer's to edit or delete",
    );
  });

  test("dropping the plan it revises takes the sent conversation with it", () => {
    const opening = widget(2, "Split step two.");
    threads.open(opening, "comment", "Step one.");
    const previous = uri.with({ fragment: "previous" });
    threads.showSent(previous, threads.threadsFor(uri));

    threads.dropFor(previous);

    assert.strictEqual(
      session.threads().some((thread) => thread.uri.fragment === "previous"),
      false,
    );
    assert.strictEqual(threads.commentsFor(uri).length, 1, "the live plan is untouched");
  });

  test("dropping a plan takes its threads out of the editor", () => {
    threads.open(widget(2, "Split step two."), "comment", "Step one.");

    threads.dropFor(uri);

    assert.deepStrictEqual(threads.commentsFor(uri), []);
    assert.strictEqual(session.threads().length, 0);
  });
});
