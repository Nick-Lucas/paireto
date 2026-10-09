import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
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

const SAME = "alpha\nbravo\ncharlie\ndelta\necho\n";
const EDIT = "one\ntwo\nthree\nfour\nfive\n";

suite("openDiff for a staged rename", () => {
  let root: string;
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root }).toString().trim();

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    root = folder.uri.fsPath;
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    fs.writeFileSync(path.join(root, "ren-same-old.txt"), SAME);
    fs.writeFileSync(path.join(root, "ren-edit-old.txt"), EDIT);
    git("add", "ren-same-old.txt", "ren-edit-old.txt");
    git("commit", "-q", "-m", "rename fixtures");
  });

  teardown(() => {
    const paths = ["ren-same-old.txt", "ren-same-new.txt", "ren-edit-old.txt", "ren-edit-new.txt"];
    git("reset", "-q", "--", ...paths);
    fs.rmSync(path.join(root, "ren-same-new.txt"), { force: true });
    fs.rmSync(path.join(root, "ren-edit-new.txt"), { force: true });
    git("checkout", "--", "ren-same-old.txt", "ren-edit-old.txt");
  });

  async function openRenamed(oldPath: string, newPath: string): Promise<vscode.TabInputTextDiff> {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const file: RepoChangedFile = {
      path: newPath,
      oldPath,
      group: "staged",
      status: "R",
      additions: 0,
      deletions: 0,
      repoRoot: canonicalize(root),
    };
    await vscode.commands.executeCommand("paireto.review.openDiff", file);
    const input = await waitFor(() => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return active instanceof vscode.TabInputTextDiff && active.modified.path.endsWith(newPath)
        ? active
        : undefined;
    }, 20_000);
    assert.ok(input, "a staged rename must open as a two-pane diff");
    return input;
  }

  async function text(uri: vscode.Uri): Promise<string> {
    return (await vscode.workspace.openTextDocument(uri)).getText();
  }

  test("a pure rename shows the old content on the base side, so there is no diff", async function () {
    this.timeout(30_000);
    git("mv", "ren-same-old.txt", "ren-same-new.txt");

    const input = await openRenamed("ren-same-old.txt", "ren-same-new.txt");

    assert.strictEqual(await text(input.original), SAME);
    assert.strictEqual(await text(input.modified), SAME);
  });

  test("a rename with edits diffs the new content against the old content", async function () {
    this.timeout(30_000);
    git("mv", "ren-edit-old.txt", "ren-edit-new.txt");
    fs.writeFileSync(path.join(root, "ren-edit-new.txt"), `${EDIT}six\n`);
    git("add", "ren-edit-new.txt");
    assert.match(
      git("diff", "--cached", "--name-status"),
      /^R\d+\tren-edit-old\.txt\tren-edit-new\.txt$/m,
    );

    const input = await openRenamed("ren-edit-old.txt", "ren-edit-new.txt");

    assert.strictEqual(await text(input.original), EDIT);
    assert.strictEqual(await text(input.modified), `${EDIT}six\n`);
  });
});
