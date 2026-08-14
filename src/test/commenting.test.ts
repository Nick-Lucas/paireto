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
  feedbackActivityComment,
} from "../comments/CommentSession.js";

const SCHEME = "paireto-test-doc";

suite("commenting integration", () => {
  test("agent activity is read-only and names replies and resolutions", () => {
    const reply = feedbackActivityComment({
      kind: "reply",
      body: "I changed the implementation.",
      at: "2026-08-12T20:00:00.000Z",
      author: "Codex agent",
    });
    const resolved = feedbackActivityComment({
      kind: "resolved",
      at: "2026-08-12T20:01:00.000Z",
      author: "Codex agent",
    });
    assert.strictEqual(reply.contextValue, "activity");
    assert.strictEqual(reply.label, "Agent reply");
    assert.strictEqual(reply.author.name, "Codex agent");
    assert.strictEqual(resolved.label, "Resolved");
    assert.match(String(resolved.body), /resolved/i);
  });

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

  test("deleteComment keeps a thread that still holds another user comment", async () => {
    const controller = vscode.comments.createCommentController("paireto-test-del", "Test");
    try {
      const doc = await openDoc(4);
      const thread = controller.createCommentThread(doc.uri, new vscode.Range(1, 0, 1, 0), []);
      const keep = new GateComment("keep", "comment");
      const drop = new GateComment("drop", "question");
      keep.thread = thread;
      drop.thread = thread;
      let disposedWith: boolean | undefined;
      drop.onDeleted = (threadDisposed) => {
        disposedWith = threadDisposed;
      };
      thread.comments = [keep, drop];

      deleteComment(drop);
      assert.strictEqual(disposedWith, false, "the sibling must keep the thread alive");
      assert.deepStrictEqual(thread.comments, [keep]);

      thread.dispose();
    } finally {
      controller.dispose();
    }
  });

  test("deleteComment disposes a thread whose last user comment goes, activity included", async () => {
    // An agent reply and a resolution are read-only entries on the thread. They are not a reason to
    // keep it once the comment they belong to has been deleted.
    const controller = vscode.comments.createCommentController("paireto-test-del-last", "Test");
    try {
      const doc = await openDoc(4);
      const thread = controller.createCommentThread(doc.uri, new vscode.Range(1, 0, 1, 0), []);
      const only = new GateComment("only", "comment");
      only.thread = thread;
      let disposedWith: boolean | undefined;
      only.onDeleted = (threadDisposed) => {
        disposedWith = threadDisposed;
      };
      thread.comments = [
        only,
        feedbackActivityComment({
          kind: "reply",
          body: "done",
          at: "2026-08-12T20:00:00.000Z",
          author: "Codex agent",
        }),
      ];

      deleteComment(only);
      assert.strictEqual(disposedWith, true);
    } finally {
      controller.dispose();
    }
  });

  test("reattach moves the full resolved activity thread to the replacement document", async () => {
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
      const activity = feedbackActivityComment({
        kind: "reply",
        body: "done",
        at: "2026-08-12T20:00:00.000Z",
        author: "Codex agent",
      });
      comment.thread = oldThread;
      oldThread.comments = [comment, activity];
      oldThread.state = vscode.CommentThreadState.Resolved;

      const replacement = session.reattach(
        comment,
        newDoc.uri,
        new vscode.Range(4, 0, 4, 6),
        "file.ts:5",
      );

      assert.strictEqual(comment.thread, replacement);
      assert.strictEqual(replacement.uri.toString(), newDoc.uri.toString());
      assert.strictEqual(replacement.range?.start.line, 4);
      assert.deepStrictEqual(replacement.comments, [comment, activity]);
      assert.strictEqual(replacement.state, vscode.CommentThreadState.Resolved);
      assert.strictEqual(replacement.label, "file.ts:5");
    } finally {
      session.dispose();
    }
  });

  test("reattach repoints every user comment it moves, not only the one asked for", async () => {
    // A sibling left pointing at the disposed thread loses its edits silently, and its own reattach
    // would take the fast path and mutate a dead thread.
    const session = new CommentSession("paireto-test-reattach-siblings", "Test", SCHEME, {
      prompt: "Test",
      placeHolder: "Test",
    });
    try {
      const oldDoc = await openDoc(3);
      const newDoc = await openDoc(7);
      const oldThread = session.controller.createCommentThread(
        oldDoc.uri,
        new vscode.Range(1, 0, 1, 0),
        [],
      );
      const moved = new GateComment("moved", "comment");
      const sibling = new GateComment("sibling", "question");
      moved.thread = oldThread;
      sibling.thread = oldThread;
      oldThread.comments = [moved, sibling];

      const replacement = session.reattach(
        moved,
        newDoc.uri,
        new vscode.Range(4, 0, 4, 6),
        "file.ts:5",
      );

      assert.strictEqual(sibling.thread, replacement);
      assert.deepStrictEqual(session.threads(), [replacement]);
    } finally {
      session.dispose();
    }
  });
});
