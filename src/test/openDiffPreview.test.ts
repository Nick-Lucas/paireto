// Opening a diff from the changes list must create a PREVIEW tab (italic title, recycled by the
// next preview open), exactly like the file explorer and the native git diff panel. Editable diffs
// lose nothing by opening as preview: VS Code pins a preview tab the moment its document goes dirty.
// Driven through the ACTIVATED extension's real openDiff command — the test harness opens a fixture
// git workspace (.vscode-test.mjs) so the catalog resolves a git root at activation.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

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

suite("openDiff preview behaviour", () => {
  test("an editable changed file opens as a preview diff tab", async function () {
    this.timeout(30_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    // Leftover/session-restored diff tabs (which VS Code restores as KEPT tabs) would satisfy the
    // active-tab poll below before our own open lands.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // isPreview is trivially false everywhere when previews are off — guard the precondition.
    assert.strictEqual(
      vscode.workspace.getConfiguration("workbench.editor").get<boolean>("enablePreview"),
      true,
      "the test instance must keep workbench.editor.enablePreview at its default (enabled)",
    );

    // An unstaged-only modification of a committed file: editable, two-pane diff.
    fs.writeFileSync(path.join(folder.uri.fsPath, "notes.txt"), "one\ntwo\nthree\n");
    const file: RepoChangedFile = {
      path: "notes.txt",
      group: "unstaged",
      status: "M",
      additions: 1,
      deletions: 0,
      repoRoot: canonicalize(folder.uri.fsPath),
    };
    await vscode.commands.executeCommand("paireto.review.openDiff", file);

    // The command handler fires openDiff without awaiting it — poll for the diff tab.
    const tab = await waitFor(() => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      return active?.input instanceof vscode.TabInputTextDiff ? active : undefined;
    }, 20_000);
    assert.ok(tab, "openDiff must open a diff tab for the changed file");
    assert.strictEqual(
      tab.isPreview,
      true,
      "changes-list diffs must open as preview tabs, like the native git panel",
    );
  });

  test("an untracked (added) file opens its single pane as a preview tab too", async function () {
    this.timeout(30_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // An add has no base side, so openDiff takes the single-pane vscode.open path instead of
    // vscode.diff — its preview behaviour must match, or successive clicks on new files pile up
    // pinned tabs.
    const name = "untracked-preview.txt";
    fs.writeFileSync(path.join(folder.uri.fsPath, name), "hello\n");
    const file: RepoChangedFile = {
      path: name,
      group: "unstaged",
      status: "U",
      additions: 1,
      deletions: 0,
      repoRoot: canonicalize(folder.uri.fsPath),
    };
    await vscode.commands.executeCommand("paireto.review.openDiff", file);

    const tab = await waitFor(() => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = active?.input;
      return input instanceof vscode.TabInputText && input.uri.path.endsWith(name)
        ? active
        : undefined;
    }, 20_000);
    assert.ok(tab, "openDiff must open the add's one real side in a single editor");
    assert.strictEqual(
      tab.isPreview,
      true,
      "single-pane adds/deletes must open as preview tabs, like two-pane diffs",
    );
  });
});
