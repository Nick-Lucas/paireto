import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";

type Git = (args: string[]) => string;

function gitIn(cwd: string): Git {
  return (args) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
}

suite("openDiff on a conflicted file (activated extension)", () => {
  test("opens the merge editor", async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    const root = folder.uri.fsPath;
    const git = gitIn(root);
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const original = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const before = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "-b", "conflict-feature"]);
    fs.writeFileSync(path.join(root, "notes.txt"), "one\nfeature\n");
    git(["commit", "-q", "-am", "feature"]);
    git(["checkout", "-q", original]);
    fs.writeFileSync(path.join(root, "notes.txt"), "one\nmain\n");
    git(["commit", "-q", "-am", "main"]);
    try {
      assert.throws(() => git(["merge", "conflict-feature"]));
      const file: RepoChangedFile = {
        path: "notes.txt",
        group: "unstaged",
        status: "!",
        additions: 0,
        deletions: 0,
        repoRoot: canonicalize(root),
      };
      await vscode.commands.executeCommand("paireto.review.openDiff", file);
      const deadline = Date.now() + 30_000;
      let label = "";
      while (!label.startsWith("Merging") && Date.now() < deadline) {
        label = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? "";
        if (!label.startsWith("Merging")) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      assert.strictEqual(
        label,
        "Merging: notes.txt",
        "a conflicted file must open in the merge editor",
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      git(["merge", "--abort"]);
      git(["reset", "-q", "--hard", before]);
      git(["branch", "-q", "-D", "conflict-feature"]);
    }
  });
});
