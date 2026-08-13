// Discarding a file whose diff tab still holds unsaved edits. The change goes back to the committed
// content, so the file leaves every group and its tab has nothing left to show — but a tab with
// unsaved edits cannot be closed, because VS Code raises its own save dialog for it. The discard
// therefore throws those edits away with the rest of the change. Driven through the activated
// extension's real commands, like stageDirtyFile.test.ts.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";
import { revertDirtyDocs } from "./workbench.js";

interface SeenWarning {
  message: string;
  options?: vscode.MessageOptions;
}

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

/** The open review diff tabs for one file. Scoped by name: the suite shares its workbench with every
 *  other test file, so a global count would answer for their tabs too. */
function reviewDiffTabs(name: string): vscode.Tab[] {
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === Schemes.review &&
        tab.input.modified.path.endsWith(name)
      ) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

/** Record every warning raised, so a test can pin that the discard asks the user nothing. */
function stubWarnings(answer: string | undefined): { seen: SeenWarning[]; restore: () => void } {
  const seen: SeenWarning[] = [];
  const real = vscode.window.showWarningMessage;
  const stub = (message: string, options?: vscode.MessageOptions): Thenable<string | undefined> => {
    seen.push({ message, options });
    return Promise.resolve(answer);
  };
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = stub;
  return {
    seen,
    restore: () => {
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = real;
    },
  };
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

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), "three\n");
  assert.ok(
    await vscode.workspace.applyEdit(edit),
    "the working-tree document must accept an edit",
  );
  assert.strictEqual(
    doc.isDirty,
    true,
    "the working-tree document must be dirty before the discard",
  );
  return { file, doc };
}

async function activateForFixture(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test harness must open the fixture git workspace");
  await vscode.extensions.getExtension("Paireto.paireto")?.activate();
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  return folder.uri.fsPath;
}

suite("discarding a file with unsaved changes", () => {
  let warnings: { seen: SeenWarning[]; restore: () => void } | undefined;

  teardown(async () => {
    warnings?.restore();
    warnings = undefined;
    await revertDirtyDocs();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("the discard drops the unsaved edits, so no tab can hold them", async function () {
    this.timeout(60_000);
    const root = await activateForFixture();
    const name = "discard-dirty-modified.txt";
    const { file, doc } = await openDirtyDiff(root, name);
    warnings = stubWarnings(undefined);

    await vscode.commands.executeCommand("paireto.review.discard", file);

    const restored = await waitFor(
      () => (fs.readFileSync(path.join(root, name), "utf8") === "one\n" ? "yes" : undefined),
      20_000,
    );
    assert.strictEqual(restored, "yes", "the discard must take the file back to its commit");
    // The unsaved buffer is the whole point: while it lives, the tab cannot be closed or re-pointed,
    // because VS Code raises its own save dialog for it. Where the tab then goes is the reconcile's
    // business, and it reads the Compare To point, which every suite in this shared window can move.
    assert.strictEqual(doc.isDirty, false, "no unsaved buffer may survive the discard");
    assert.ok(
      reviewDiffTabs(name).every((tab) => !tab.isDirty),
      "no review diff tab may still hold unsaved edits",
    );
  });

  test("the discard asks nothing: running the command is the decision", async function () {
    this.timeout(60_000);
    const root = await activateForFixture();
    const name = "discard-no-prompt.txt";
    const { file } = await openDirtyDiff(root, name);
    warnings = stubWarnings(undefined);

    await vscode.commands.executeCommand("paireto.review.discard", file);

    const restored = await waitFor(
      () => (fs.readFileSync(path.join(root, name), "utf8") === "one\n" ? "yes" : undefined),
      20_000,
    );
    assert.strictEqual(restored, "yes", "the discard must run without a confirmation");
    assert.deepStrictEqual(warnings.seen, [], "the discard must raise no dialog");
  });
});
