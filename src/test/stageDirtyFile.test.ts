// Staging a file whose editor still holds unsaved edits used to put the ON-DISK content in the
// index and then close the diff tab, which made VS Code raise its own save dialog. The user's save
// landed AFTER the `git add`, so the very edits they thought they staged came back as a new
// unstaged change. Stage now means "stage the version I am looking at": the target documents are
// saved BEFORE the git write, without a question. Driven through the activated extension's real
// commands, like openDiffReconcile.test.ts.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Every open review diff tab (any tab group). */
function reviewDiffTabs(): vscode.Tab[] {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === Schemes.review
      ) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

function indexContent(root: string, name: string): string {
  return execFileSync("git", ["show", `:${name}`], { cwd: root, encoding: "utf8" });
}

/** The status letter git holds in the index for one file, or "" when the index has no change. */
function stagedStatus(root: string, name: string): string {
  const out = execFileSync("git", ["diff", "--cached", "--name-status", "--", name], {
    cwd: root,
    encoding: "utf8",
  });
  return out.trim().split(/\s+/)[0] ?? "";
}

/** A committed file with an unstaged change on disk, opened as a diff, with unsaved edits on top. */
async function openDirtyDiff(
  root: string,
  name: string,
): Promise<{ file: RepoChangedFile; doc: vscode.TextDocument }> {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, "one\n");
  execFileSync("git", ["add", name], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", `fixture ${name}`], { cwd: root });
  fs.writeFileSync(filePath, "one\ntwo\n");

  const file: RepoChangedFile = {
    path: name,
    group: "unstaged",
    status: "M",
    additions: 1,
    deletions: 0,
    repoRoot: canonicalize(root),
  };
  await vscode.commands.executeCommand("paireto.review.openDiff", file);
  const tab = await waitFor(() => {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = active?.input;
    return input instanceof vscode.TabInputTextDiff && input.modified.path.endsWith(name)
      ? active
      : undefined;
  }, 20_000);
  assert.ok(tab, `diff tab for ${name} must open`);

  // Type into the working-tree side without saving — the state that used to lose the edits.
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), "three\n");
  assert.ok(
    await vscode.workspace.applyEdit(edit),
    "the working-tree document must accept an edit",
  );
  assert.strictEqual(doc.isDirty, true, "the working-tree document must be dirty before staging");
  return { file, doc };
}

suite("staging a file with unsaved changes", () => {
  test("the stage saves the editor content first, so the index holds the unsaved line", async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const root = folder.uri.fsPath;
    const name = "stage-dirty-modified.txt";
    const { file, doc } = await openDirtyDiff(root, name);

    await vscode.commands.executeCommand("paireto.review.stage", file);

    const staged = await waitFor(
      () => (indexContent(root, name).includes("three") ? indexContent(root, name) : undefined),
      20_000,
    );
    assert.strictEqual(
      staged,
      "one\ntwo\nthree\n",
      `staging must put the editor content in the index, got: ${JSON.stringify(indexContent(root, name))}`,
    );
    assert.strictEqual(doc.isDirty, false, "the document must be saved by the stage");
    // A clean document lets the tab follow the file to the staged group without VS Code raising its
    // own save dialog.
    const tabs = reviewDiffTabs();
    assert.strictEqual(tabs.length, 1, "the review diff tab must still be open after the stage");
    assert.strictEqual(tabs[0].isDirty, false, "the review diff tab must hold no unsaved edits");
  });

  test("the stage does not save a deleted file, so the deletion stays", async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const root = folder.uri.fsPath;
    const name = "stage-dirty-deleted.txt";
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, "one\n");
    execFileSync("git", ["add", name], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", `fixture ${name}`], { cwd: root });

    // The user edits the file, then something else removes it: VS Code holds a dirty buffer for a
    // file that is no longer on disk, and writing that buffer back would undo the deletion.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), "two\n");
    assert.ok(await vscode.workspace.applyEdit(edit), "the document must accept an edit");
    assert.strictEqual(doc.isDirty, true, "the document must be dirty before the delete");
    fs.unlinkSync(filePath);

    const file: RepoChangedFile = {
      path: name,
      group: "unstaged",
      status: "D",
      additions: 0,
      deletions: 1,
      repoRoot: canonicalize(root),
    };
    await vscode.commands.executeCommand("paireto.review.stage", file);

    const staged = await waitFor(
      () => (stagedStatus(root, name) === "D" ? "yes" : undefined),
      20_000,
    );
    assert.strictEqual(
      staged,
      "yes",
      `the deletion must reach the index, got: ${JSON.stringify(stagedStatus(root, name))}`,
    );
    assert.strictEqual(fs.existsSync(filePath), false, "the stage must not re-create the file");
  });
});
