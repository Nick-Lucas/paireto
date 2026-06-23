// Integration tests (run in the VS Code Extension Host via @vscode/test-electron). These exercise
// the real Comments API + TextDocumentContentProvider path that drives the gutter "+" affordance,
// guarding against regressions like accidentally returning the proposed CommentingRanges object.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { fullDocumentCommentingRanges } from "../comments/commentingRanges.js";
import {
  GateComment,
  editComment,
  saveComment,
  deleteComment,
} from "../comments/CommentSession.js";

const SCHEME = "tui-test-doc";

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
    const controller = vscode.comments.createCommentController("tui-test", "Test");
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
    const controller = vscode.comments.createCommentController("tui-test-edit", "Test");
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

  test("deleteComment removes the comment from its thread and fires onDeleted", async () => {
    const controller = vscode.comments.createCommentController("tui-test-del", "Test");
    try {
      const doc = await openDoc(4);
      const thread = controller.createCommentThread(doc.uri, new vscode.Range(1, 0, 1, 0), []);
      const keep = new GateComment("keep", "comment");
      const drop = new GateComment("drop", "problem");
      keep.thread = thread;
      drop.thread = thread;
      let deleted = false;
      drop.onDeleted = () => {
        deleted = true;
      };
      thread.comments = [keep, drop];

      deleteComment(drop);
      assert.strictEqual(deleted, true);
      assert.deepStrictEqual(thread.comments, [keep]);

      thread.dispose();
    } finally {
      controller.dispose();
    }
  });
});
