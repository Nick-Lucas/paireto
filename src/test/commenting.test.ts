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

  test("remove takes the thread with it and leaves a line-mate alone", async () => {
    const session = new CommentSession("paireto-test-del", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const keep = session.add(replyOn(session, doc, 1, "keep"), "comment");
      const drop = session.add(replyOn(session, doc, 1, "drop"), "question");

      session.remove(drop);

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

      session.remove(drop);

      assert.strictEqual(drop.thread, undefined, "the deleted comment keeps no thread");
      assert.deepStrictEqual(bodies(keep.thread!), ["keep"], "its thread-mate is untouched");
      assert.strictEqual(session.threads().length, 1, "the thread is still tracked");
      assert.strictEqual(session.threads()[0], keep.thread);
    } finally {
      session.dispose();
    }
  });

  test("removing the opener takes its replies, a reply takes only itself", async () => {
    const session = new CommentSession("paireto-test-would", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const opener = session.add(replyOn(session, doc, 1, "opener"), "comment");
      const reply = session.add({ thread: opener.thread!, text: "reply" }, "question");

      assert.deepStrictEqual(
        session.remove(reply).map((c) => String(c.body)),
        ["reply"],
        "a reply takes only itself",
      );
      assert.deepStrictEqual(
        session.remove(opener).map((c) => String(c.body)),
        ["opener"],
        "the opener takes what is left on its thread",
      );
    } finally {
      session.dispose();
    }
  });

  test("deleteComment asks the owner to delete", async () => {
    const session = new CommentSession("paireto-test-owner-delete", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const comment = session.add(replyOn(session, doc, 1, "mine"), "comment");
      let asked = 0;
      comment.onDelete = () => asked++;

      deleteComment(comment);

      assert.strictEqual(asked, 1, "the owner decides what goes down with it");
      assert.notStrictEqual(comment.thread, undefined, "the session is not touched");
      assert.strictEqual(session.threads().length, 1);
    } finally {
      session.dispose();
    }
  });

  test("removing the comment that opens a thread takes the replies with it", async () => {
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

      const removed = session.remove(opener);

      assert.strictEqual(session.threads().length, 0, "the thread goes down with its opener");
      assert.strictEqual(opener.thread, undefined);
      assert.strictEqual(reply.thread, undefined, "the reply keeps no thread either");
      assert.deepStrictEqual(
        removed.map((c) => String(c.body)),
        ["opener", "reply"],
        "the caller is told what went down with it",
      );
    } finally {
      session.dispose();
    }
  });

  test("a removed comment's thread stops being collected", async () => {
    // The plan gate gathers its feedback by walking session.threads(), so a thread left tracked
    // after its comment was deleted would put the deleted text back into what the agent receives.
    const session = new CommentSession("paireto-test-collect", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(4);
      const only = session.add(replyOn(session, doc, 2, "only"), "comment");

      session.remove(only);

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

  test("place moves a whole thread to a replacement document and disposes the old one", async () => {
    const session = new CommentSession("paireto-test-place-move", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const oldDoc = await openDoc(3);
      const newDoc = await openDoc(6);
      const opener = session.add(replyOn(session, oldDoc, 1, "opener"), "comment");
      const reply = session.add({ thread: opener.thread!, text: "reply" }, "question");
      const original = opener.thread!;

      const replacement = session.place({
        uri: newDoc.uri,
        range: new vscode.Range(4, 0, 4, 6),
        label: "file.ts:5",
        comments: [{ comment: opener }, { comment: reply }],
        previous: original,
      });

      assert.notStrictEqual(replacement, original, "a new document needs a new thread");
      assert.strictEqual(opener.thread, replacement);
      assert.strictEqual(reply.thread, replacement, "the whole group moves together");
      assert.strictEqual(replacement.uri.toString(), newDoc.uri.toString());
      assert.strictEqual(replacement.range?.start.line, 4);
      assert.strictEqual(replacement.label, "file.ts:5");
      assert.deepStrictEqual(bodies(replacement), ["opener", "reply"]);
      assert.strictEqual(session.threads().length, 1, "the vacated thread is not kept");
      assert.strictEqual(session.threads()[0], replacement);
    } finally {
      session.dispose();
    }
  });

  test("place keeps the thread and its collapsed state while the document is unchanged", async () => {
    const session = new CommentSession("paireto-test-place-keep", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(6);
      const comment = session.add(replyOn(session, doc, 1, "stay"), "comment");
      const original = comment.thread!;
      original.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

      const same = session.place({
        uri: doc.uri,
        range: new vscode.Range(4, 0, 4, 4),
        label: "f:5",
        comments: [{ comment }],
        previous: original,
      });

      assert.strictEqual(same, original, "the same document keeps the same thread");
      assert.strictEqual(same.range?.start.line, 4);
      assert.strictEqual(same.label, "f:5");
      assert.strictEqual(same.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
      assert.strictEqual(session.threads().length, 1);
    } finally {
      session.dispose();
    }
  });

  test("place labels a thread from its opening comment, not from a reply", async () => {
    const session = new CommentSession("paireto-test-place-label", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const doc = await openDoc(6);
      const opener = new GateComment("opener", "comment");
      const reply = new GateComment("reply", "question");

      const thread = session.place({
        uri: doc.uri,
        range: new vscode.Range(2, 0, 2, 3),
        label: "opener label",
        comments: [{ comment: opener }, { comment: reply }],
      });

      assert.strictEqual(thread.label, "opener label");
      assert.deepStrictEqual(bodies(thread), ["opener", "reply"]);
      assert.strictEqual(
        thread.collapsibleState,
        vscode.CommentThreadCollapsibleState.Expanded,
        "a restored thread is open",
      );
    } finally {
      session.dispose();
    }
  });
});
