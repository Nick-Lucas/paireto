// After a stage/unstage/discard moves an open diff's file to another git layer,
// reconcileOpenDiffsAfterWrite re-points the tab by closing it and reopening the diff at the new
// layer. The reopen must carry the tab's PRIOR preview/kept state forward: if every reopen were a
// preview, a kept tab would silently come back transient, and — since VS Code keeps at most one
// preview tab per group — staging two open diffs would collapse both into ONE recycled tab. Driven
// through the activated extension's real commands, like openDiffPreview.test.ts.

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

suite("reconcile after a git write preserves re-pointed diff tabs", () => {
  test("staging two KEPT diff tabs re-points both, neither recycled into a preview", async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const root = folder.uri.fsPath;
    const names = ["reconcile-a.txt", "reconcile-b.txt"];
    for (const name of names) {
      fs.writeFileSync(path.join(root, name), "one\n");
    }
    execFileSync("git", ["add", ...names], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "reconcile fixture"], { cwd: root });
    for (const name of names) {
      fs.writeFileSync(path.join(root, name), "one\ntwo\n");
    }

    const repoRoot = canonicalize(root);
    const fileFor = (name: string): RepoChangedFile => ({
      path: name,
      group: "unstaged",
      status: "M",
      additions: 1,
      deletions: 0,
      repoRoot,
    });

    // Open both diffs and KEEP them (a user's pinned/kept tabs — e.g. VS Code auto-keeps on edit).
    for (const name of names) {
      await vscode.commands.executeCommand("paireto.review.openDiff", fileFor(name));
      const tab = await waitFor(() => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        const input = active?.input;
        return input instanceof vscode.TabInputTextDiff && input.modified.path.endsWith(name)
          ? active
          : undefined;
      }, 20_000);
      assert.ok(tab, `diff tab for ${name} must open`);
      await vscode.commands.executeCommand("workbench.action.keepEditor");
    }
    assert.strictEqual(reviewDiffTabs().length, 2, "both kept diff tabs open before staging");

    for (const name of names) {
      await vscode.commands.executeCommand("paireto.review.stage", fileFor(name));
    }

    const survived = await waitFor(() => {
      const tabs = reviewDiffTabs();
      return tabs.length === 2 && tabs.every((tab) => !tab.isPreview) ? tabs : undefined;
    }, 20_000);
    const got = reviewDiffTabs()
      .map((tab) => `${tab.label} preview=${tab.isPreview}`)
      .join(", ");
    assert.ok(
      survived,
      `both diffs must be re-pointed as KEPT tabs (a preview reopen recycles the other), got: ${got}`,
    );
  });
});
