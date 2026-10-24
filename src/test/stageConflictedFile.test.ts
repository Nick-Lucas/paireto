import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";

type Git = (args: string[]) => string;

interface SeenWarning {
  message: string;
  options?: vscode.MessageOptions;
  items: string[];
}

function gitIn(cwd: string): Git {
  return (args) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
}

function stubWarnings(answer: string | undefined): { seen: SeenWarning[]; restore: () => void } {
  const seen: SeenWarning[] = [];
  const real = vscode.window.showWarningMessage;
  const stub = (
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ): Thenable<string | undefined> => {
    seen.push({ message, options, items });
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

suite("staging a conflicted file (activated extension)", () => {
  let root: string;
  let git: Git;
  let original: string;
  let before: string;
  let warnings: { seen: SeenWarning[]; restore: () => void } | undefined;

  setup(async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    root = folder.uri.fsPath;
    git = gitIn(root);
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    original = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    before = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "-b", "stage-conflict-feature"]);
    fs.writeFileSync(path.join(root, "notes.txt"), "Notes\n=======\none\nfeature\n");
    git(["commit", "-q", "-am", "feature"]);
    git(["checkout", "-q", original]);
    fs.writeFileSync(path.join(root, "notes.txt"), "Notes\n=======\none\nmain\n");
    git(["commit", "-q", "-am", "main"]);
    assert.throws(() => git(["merge", "stage-conflict-feature"]));
  });

  teardown(async () => {
    warnings?.restore();
    warnings = undefined;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    git(["merge", "--abort"]);
    git(["reset", "-q", "--hard", before]);
    git(["branch", "-q", "-D", "stage-conflict-feature"]);
  });

  function conflictedFile(): RepoChangedFile {
    return {
      path: "notes.txt",
      group: "unstaged",
      status: "!",
      additions: 0,
      deletions: 0,
      repoRoot: canonicalize(root),
    };
  }

  test("a file that still has markers stays conflicted when the warning is dismissed", async function () {
    this.timeout(60_000);
    warnings = stubWarnings(undefined);

    await vscode.commands.executeCommand("paireto.review.stage", conflictedFile());

    assert.deepStrictEqual(
      warnings.seen.map((w) => w.message),
      ["Are you sure you want to stage notes.txt with merge conflicts?"],
    );
    assert.strictEqual(warnings.seen[0].options?.modal, true);
    assert.deepStrictEqual(warnings.seen[0].items, ["Yes"]);
    assert.notStrictEqual(git(["ls-files", "-u"]), "", "the file must stay conflicted");
  });

  test("a file that still has markers is staged when the warning is answered Yes", async function () {
    this.timeout(60_000);
    warnings = stubWarnings("Yes");

    await vscode.commands.executeCommand("paireto.review.stage", conflictedFile());

    assert.strictEqual(warnings.seen.length, 1);
    assert.strictEqual(git(["ls-files", "-u"]), "", "the file must leave the conflicted state");
  });

  test("a file whose markers were removed is staged with no warning", async function () {
    this.timeout(60_000);
    fs.writeFileSync(path.join(root, "notes.txt"), "one\nresolved\n");
    warnings = stubWarnings(undefined);

    await vscode.commands.executeCommand("paireto.review.stage", conflictedFile());

    assert.deepStrictEqual(warnings.seen, []);
    assert.strictEqual(git(["ls-files", "-u"]), "", "the file must leave the conflicted state");
  });

  test("a resolved file that keeps a heading underline from both sides is staged with no warning", async function () {
    this.timeout(60_000);
    fs.writeFileSync(path.join(root, "notes.txt"), "Notes\n=======\none\nresolved\n");
    warnings = stubWarnings(undefined);

    await vscode.commands.executeCommand("paireto.review.stage", conflictedFile());

    assert.deepStrictEqual(warnings.seen, []);
    assert.strictEqual(git(["ls-files", "-u"]), "", "the file must leave the conflicted state");
  });

  test("a resolved file with only whitespace errors is staged with no warning", async function () {
    this.timeout(60_000);
    fs.writeFileSync(path.join(root, "notes.txt"), "Notes\n=======\none\nresolved \n");
    warnings = stubWarnings(undefined);

    await vscode.commands.executeCommand("paireto.review.stage", conflictedFile());

    assert.deepStrictEqual(warnings.seen, []);
    assert.strictEqual(git(["ls-files", "-u"]), "", "the file must leave the conflicted state");
  });
});
