// Integration tests (run in the VS Code Extension Host via @vscode/test-electron). These exercise
// the real Comments API + TextDocumentContentProvider path that drives the gutter "+" affordance,
// guarding against regressions like accidentally returning the proposed CommentingRanges object.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { fullDocumentCommentingRanges } from "../comments/commentingRanges.js";
import {
  CommentSession,
  GateComment,
  editComment,
  saveComment,
  deleteComment,
} from "../comments/CommentSession.js";

const SCHEME = "paireto-test-doc";

suite("commenting integration", () => {
  const contents = new Map<string, string>();
  let providerReg: vscode.Disposable;

  suiteSetup(() => {
    providerReg = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? "",
    });
  });

  suiteTeardown(() => providerReg.dispose());

  async function openDoc(lines: number): Promise<vscode.TextDocument> {
    const uri = vscode.Uri.parse(`${SCHEME}://t/doc-${lines}.md`);
    contents.set(
      uri.toString(),
      Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc;
  }

  test("returns a plain Range[] (not the proposed object) covering the whole doc", async () => {
    const doc = await openDoc(5);
    const ranges = fullDocumentCommentingRanges(doc, SCHEME);
    assert.ok(Array.isArray(ranges), "must be a plain Range[] for the stable commenting API");
    assert.strictEqual(ranges!.length, 1);
    assert.strictEqual(ranges![0].start.line, 0);
    assert.strictEqual(ranges![0].end.line, 4);
  });

  test("returns undefined for a non-matching scheme", async () => {
    const doc = await openDoc(3);
    assert.strictEqual(fullDocumentCommentingRanges(doc, "some-other-scheme"), undefined);
  });

  test("a CommentController with this provider accepts a thread on the virtual doc", async () => {
    const controller = vscode.comments.createCommentController("paireto-test", "Test");
    controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => fullDocumentCommentingRanges(doc, SCHEME),
    };
    try {
      const doc = await openDoc(4);
      // Creating a thread on the virtual-doc URI must not throw — this is the path the gutter "+"
      // and our add-comment command both rely on.
      const thread = controller.createCommentThread(doc.uri, new vscode.Range(1, 0, 1, 0), []);
      assert.ok(thread);
      assert.strictEqual(thread.uri.toString(), doc.uri.toString());
      thread.dispose();
    } finally {
      controller.dispose();
    }
  });

  test("editComment/saveComment toggle mode + contextValue and sync the edited body", async () => {
    const controller = vscode.comments.createCommentController("paireto-test-edit", "Test");
    try {
      const doc = await openDoc(4);
      const thread = controller.createCommentThread(doc.uri, new vscode.Range(1, 0, 1, 0), []);
      const comment = new GateComment("original", "comment");
      comment.thread = thread;
      let saved: string | undefined;
      comment.onSaved = (b) => {
        saved = b;
      };
      thread.comments = [comment];

      editComment(comment);
      assert.strictEqual(comment.mode, vscode.CommentMode.Editing);
      assert.strictEqual(comment.contextValue, "editing");

      comment.body = "edited"; // VS Code mutates body in the editing widget
      saveComment(comment);
      assert.strictEqual(comment.mode, vscode.CommentMode.Preview);
      assert.strictEqual(comment.contextValue, "preview");
      assert.strictEqual(saved, "edited");

      thread.dispose();
    } finally {
      controller.dispose();
    }
  });

  /** The bodies on a thread. Deep-equalling the comment objects themselves makes mocha's failure
   *  reporter walk into the proposed comment API and hang the run, so assert on text. */
  function bodies(thread: vscode.CommentThread): string[] {
    return thread.comments.map((c) => String((c as GateComment).body));
  }

  /** A CommentReply as VS Code hands one over: the widget's own empty thread plus the typed text. */
  function replyOn(
    session: CommentSession,
    doc: vscode.TextDocument,
    line: number,
    text: string,
  ): vscode.CommentReply {
    const thread = session.controller.createCommentThread(
      doc.uri,
      new vscode.Range(line, 0, line, 0),
      [],
    );
    return { thread, text };
  }

  test("a reply joins the thread it was typed into", async () => {
    // VS Code routes a reply typed into an existing thread's box back to THAT thread. The reply
    // belongs to the comment it answers, so it joins that thread instead of starting another one.
    const session = new CommentSession("paireto-test-reply", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const first = session.add(replyOn(session, doc, 1, "first"), "comment");
      // The user types into the first comment's reply box rather than the gutter widget.
      const reply = session.add({ thread: first.thread!, text: "reply" }, "question");

      assert.strictEqual(reply.thread, first.thread, "the reply stays on the thread it answers");
      assert.deepStrictEqual(bodies(first.thread!), ["first", "reply"], "in the order made");
      assert.strictEqual(session.threads().length, 1);
    } finally {
      session.dispose();
    }
  });

  test("a second top-level comment on one line gets its own thread", async () => {
    // The gutter "+" opens an empty widget thread of its own, so two top-level comments can sit on
    // one line. VS Code stacks them.
    const session = new CommentSession("paireto-test-one-per", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const first = session.add(replyOn(session, doc, 1, "first"), "comment");
      const second = session.add(replyOn(session, doc, 1, "second"), "question");

      assert.notStrictEqual(second.thread, first.thread, "the second comment needs its own thread");
      assert.deepStrictEqual(bodies(first.thread!), ["first"]);
      assert.deepStrictEqual(bodies(second.thread!), ["second"]);
      assert.strictEqual(second.thread!.uri.toString(), first.thread!.uri.toString());
      assert.strictEqual(second.thread!.range?.start.line, 1);
      assert.strictEqual(session.threads().length, 2);
    } finally {
      session.dispose();
    }
  });

  test("a thread label is set by the comment that opens it, not by a reply", async () => {
    const session = new CommentSession("paireto-test-label", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const first = session.add(replyOn(session, doc, 1, "first"), "comment", { label: "Comment" });
      session.add({ thread: first.thread!, text: "reply" }, "question", { label: "Question" });

      assert.strictEqual(first.thread!.label, "Comment");
    } finally {
      session.dispose();
    }
  });

  test("deleteComment takes the thread with it and leaves a line-mate alone", async () => {
    const session = new CommentSession("paireto-test-del", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const keep = session.add(replyOn(session, doc, 1, "keep"), "comment");
      const drop = session.add(replyOn(session, doc, 1, "drop"), "question");
      let deleted = false;
      drop.onDeleted = () => {
        deleted = true;
      };

      deleteComment(drop);

      assert.strictEqual(deleted, true, "the owner is told so it can drop its model");
      assert.strictEqual(drop.thread, undefined, "the deleted comment keeps no thread");
      assert.strictEqual(session.threads().length, 1, "only the line-mate is still tracked");
      assert.strictEqual(session.threads()[0], keep.thread);
      assert.deepStrictEqual(bodies(keep.thread!), ["keep"]);
    } finally {
      session.dispose();
    }
  });

  test("deleting a reply leaves the thread and the comment it answers", async () => {
    const session = new CommentSession("paireto-test-del-reply", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const keep = session.add(replyOn(session, doc, 1, "keep"), "comment");
      const drop = session.add({ thread: keep.thread!, text: "drop" }, "question");

      deleteComment(drop);

      assert.strictEqual(drop.thread, undefined, "the deleted comment keeps no thread");
      assert.deepStrictEqual(bodies(keep.thread!), ["keep"], "its thread-mate is untouched");
      assert.strictEqual(session.threads().length, 1, "the thread is still tracked");
      assert.strictEqual(session.threads()[0], keep.thread);
    } finally {
      session.dispose();
    }
  });

  test("wouldRemove reports what a delete would take, so a confirmation can say so", async () => {
    const session = new CommentSession("paireto-test-would", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const opener = session.add(replyOn(session, doc, 1, "opener"), "comment");
      const reply = session.add({ thread: opener.thread!, text: "reply" }, "question");

      assert.deepStrictEqual(
        session.wouldRemove(opener).map((c) => String(c.body)),
        ["opener", "reply"],
        "the opener takes the thread",
      );
      assert.deepStrictEqual(
        session.wouldRemove(reply).map((c) => String(c.body)),
        ["reply"],
        "a reply takes only itself",
      );
    } finally {
      session.dispose();
    }
  });

  test("deleting the comment that opens a thread takes the replies with it", async () => {
    // The thread belongs to the comment that started it. Removing that comment alone would promote a
    // reply into a top-level comment answering nothing.
    const session = new CommentSession("paireto-test-del-opener", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const opener = session.add(replyOn(session, doc, 1, "opener"), "comment");
      const reply = session.add({ thread: opener.thread!, text: "reply" }, "question");
      const told: string[] = [];
      opener.onDeleted = () => told.push("opener");
      reply.onDeleted = () => told.push("reply");

      deleteComment(opener);

      assert.strictEqual(session.threads().length, 0, "the thread goes down with its opener");
      assert.strictEqual(opener.thread, undefined);
      assert.strictEqual(reply.thread, undefined, "the reply keeps no thread either");
      assert.deepStrictEqual(told, ["opener", "reply"], "each owner is told to drop its model");
    } finally {
      session.dispose();
    }
  });

  test("a deleted comment's thread stops being collected", async () => {
    // The plan gate gathers its feedback by walking session.threads(), so a thread left tracked
    // after its comment was deleted would put the deleted text back into what the agent receives.
    const session = new CommentSession("paireto-test-collect", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const only = session.add(replyOn(session, doc, 2, "only"), "comment");

      deleteComment(only);

      assert.strictEqual(session.threads().length, 0);
    } finally {
      session.dispose();
    }
  });

  test("disposeThreads takes down the selected threads and stops tracking them", async () => {
    const session = new CommentSession("paireto-test-dispose-many", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doomed = await openDoc(3);
      const kept = await openDoc(5);
      session.add(replyOn(session, doomed, 0, "a"), "comment");
      session.add(replyOn(session, doomed, 1, "b"), "comment");
      const survivor = session.add(replyOn(session, kept, 0, "c"), "comment");

      session.disposeThreads((thread) => thread.uri.toString() === doomed.uri.toString());

      assert.strictEqual(session.threads().length, 1);
      assert.strictEqual(session.threads()[0], survivor.thread);
    } finally {
      session.dispose();
    }
  });

  test("reattach moves the same live comment to a replacement document without losing it", async () => {
    const session = new CommentSession("paireto-test-reattach", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const oldDoc = await openDoc(3);
      const newDoc = await openDoc(6);
      const oldThread = session.controller.createCommentThread(
        oldDoc.uri,
        new vscode.Range(1, 0, 1, 0),
        [],
      );
      const comment = new GateComment("keep me", "comment");
      comment.thread = oldThread;
      oldThread.comments = [comment];

      const replacement = session.reattach(
        comment,
        newDoc.uri,
        new vscode.Range(4, 0, 4, 6),
        "file.ts:5",
      );

      assert.strictEqual(comment.thread, replacement);
      assert.strictEqual(replacement.uri.toString(), newDoc.uri.toString());
      assert.strictEqual(replacement.range?.start.line, 4);
      assert.deepStrictEqual(bodies(replacement), ["keep me"]);
      assert.strictEqual(replacement.label, "file.ts:5");
      assert.strictEqual(session.threads().length, 1, "the vacated thread is not kept");
      assert.strictEqual(session.threads()[0], replacement);
    } finally {
      session.dispose();
    }
  });

  test("reattach leaves a thread standing while it still carries other comments", async () => {
    const session = new CommentSession("paireto-test-reattach-reply", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const oldDoc = await openDoc(3);
      const newDoc = await openDoc(6);
      const stay = session.add(replyOn(session, oldDoc, 1, "stay"), "comment");
      const moved = session.add({ thread: stay.thread!, text: "moved" }, "question");
      const original = stay.thread!;

      const replacement = session.reattach(moved, newDoc.uri, new vscode.Range(4, 0, 4, 6), "f:5");

      assert.deepStrictEqual(bodies(original), ["stay"], "the thread keeps what did not move");
      assert.deepStrictEqual(bodies(replacement), ["moved"]);
      assert.strictEqual(session.threads().length, 2);
      assert.strictEqual(session.threads()[0], original);
      assert.strictEqual(session.threads()[1], replacement);
    } finally {
      session.dispose();
    }
  });
});
