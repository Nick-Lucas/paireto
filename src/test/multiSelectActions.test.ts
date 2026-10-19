import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mock } from "node:test";

import * as vscode from "vscode";

import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test harness must open the fixture git workspace");
  return folder.uri.fsPath;
}

function commitThenModify(root: string, name: string): void {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, "one\n");
  execFileSync("git", ["add", name], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", `fixture ${name}`], { cwd: root });
  fs.writeFileSync(filePath, "one\ntwo\n");
}

function changedFile(root: string, name: string, group: RepoChangedFile["group"]): RepoChangedFile {
  return {
    path: name,
    group,
    status: "M",
    additions: 1,
    deletions: 0,
    repoRoot: canonicalize(root),
  };
}

function node(file: RepoChangedFile): { kind: "file"; file: RepoChangedFile } {
  return { kind: "file", file };
}

function stagedNames(root: string): string[] {
  return execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function unstagedNames(root: string): string[] {
  return execFileSync("git", ["diff", "--name-only"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

suite("changes list multi-select", () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
  });

  test("Stage Changes stages every unstaged file in the selection", async function () {
    this.timeout(30_000);
    const root = workspaceRoot();
    commitThenModify(root, "multi-stage-a.txt");
    commitThenModify(root, "multi-stage-b.txt");
    const a = node(changedFile(root, "multi-stage-a.txt", "unstaged"));
    const b = node(changedFile(root, "multi-stage-b.txt", "unstaged"));

    await vscode.commands.executeCommand("paireto.review.stage", a, [a, b]);

    const staged = stagedNames(root);
    assert.ok(staged.includes("multi-stage-a.txt"), `a must be staged, got ${staged.join(",")}`);
    assert.ok(staged.includes("multi-stage-b.txt"), `b must be staged, got ${staged.join(",")}`);
    execFileSync("git", ["reset", "-q", "--", "multi-stage-a.txt", "multi-stage-b.txt"], {
      cwd: root,
    });
  });

  test("Stage Changes leaves a staged file in the selection alone", async function () {
    this.timeout(30_000);
    const root = workspaceRoot();
    commitThenModify(root, "multi-mixed-unstaged.txt");
    commitThenModify(root, "multi-mixed-staged.txt");
    execFileSync("git", ["add", "multi-mixed-staged.txt"], { cwd: root });
    fs.writeFileSync(path.join(root, "multi-mixed-staged.txt"), "one\ntwo\nthree\n");
    const unstaged = node(changedFile(root, "multi-mixed-unstaged.txt", "unstaged"));
    const staged = node(changedFile(root, "multi-mixed-staged.txt", "staged"));

    await vscode.commands.executeCommand("paireto.review.stage", unstaged, [unstaged, staged]);

    assert.ok(stagedNames(root).includes("multi-mixed-unstaged.txt"));
    assert.ok(
      unstagedNames(root).includes("multi-mixed-staged.txt"),
      "the working tree change of the staged row must stay unstaged",
    );
    execFileSync(
      "git",
      ["reset", "-q", "--", "multi-mixed-unstaged.txt", "multi-mixed-staged.txt"],
      { cwd: root },
    );
  });

  test("Unstage Changes unstages every staged file in the selection", async function () {
    this.timeout(30_000);
    const root = workspaceRoot();
    commitThenModify(root, "multi-unstage-a.txt");
    commitThenModify(root, "multi-unstage-b.txt");
    execFileSync("git", ["add", "multi-unstage-a.txt", "multi-unstage-b.txt"], { cwd: root });
    const a = node(changedFile(root, "multi-unstage-a.txt", "staged"));
    const b = node(changedFile(root, "multi-unstage-b.txt", "staged"));

    await vscode.commands.executeCommand("paireto.review.unstage", b, [a, b]);

    const staged = stagedNames(root);
    assert.ok(
      !staged.includes("multi-unstage-a.txt"),
      `a must be unstaged, got ${staged.join(",")}`,
    );
    assert.ok(
      !staged.includes("multi-unstage-b.txt"),
      `b must be unstaged, got ${staged.join(",")}`,
    );
  });

  test("Discard Changes discards every unstaged file in the selection", async function () {
    this.timeout(30_000);
    const root = workspaceRoot();
    commitThenModify(root, "multi-discard-a.txt");
    commitThenModify(root, "multi-discard-b.txt");
    const a = node(changedFile(root, "multi-discard-a.txt", "unstaged"));
    const b = node(changedFile(root, "multi-discard-b.txt", "unstaged"));

    const warning = mock.method(vscode.window, "showWarningMessage", async () => "Discard");
    try {
      await vscode.commands.executeCommand("paireto.review.discard", a, [a, b]);
    } finally {
      warning.mock.restore();
    }

    assert.strictEqual(warning.mock.callCount(), 1);
    assert.strictEqual(fs.readFileSync(path.join(root, "multi-discard-a.txt"), "utf8"), "one\n");
    assert.strictEqual(fs.readFileSync(path.join(root, "multi-discard-b.txt"), "utf8"), "one\n");
  });

  test("Copy Path puts every selected path on the clipboard", async function () {
    this.timeout(30_000);
    const root = workspaceRoot();
    const a = node(changedFile(root, "copy-a.txt", "unstaged"));
    const b = node(changedFile(root, "copy-b.txt", "staged"));
    await vscode.env.clipboard.writeText("");

    await vscode.commands.executeCommand("paireto.review.copyPath", a, [a, b]);

    assert.strictEqual(await vscode.env.clipboard.readText(), "copy-a.txt\ncopy-b.txt");
  });

  test("Open File opens every selected file", async function () {
    this.timeout(30_000);
    const root = workspaceRoot();
    commitThenModify(root, "multi-open-a.txt");
    commitThenModify(root, "multi-open-b.txt");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const a = node(changedFile(root, "multi-open-a.txt", "unstaged"));
    const b = node(changedFile(root, "multi-open-b.txt", "unstaged"));

    await vscode.commands.executeCommand("paireto.review.openFile", a, [a, b]);

    const open = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri.fsPath] : []));
    for (const name of ["multi-open-a.txt", "multi-open-b.txt"]) {
      assert.ok(
        open.some((p) => p.endsWith(name)),
        `${name} must be open, got ${open.join(",")}`,
      );
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
