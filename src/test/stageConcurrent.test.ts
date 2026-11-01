import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import type { InspectSnapshot } from "../e2e/inspectTypes.js";
import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";

const NAMES = ["quick-1.txt", "quick-2.txt", "quick-3.txt", "quick-4.txt", "quick-5.txt"];

suite("staging files in quick succession (activated extension)", () => {
  let root: string;
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  setup(async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    root = folder.uri.fsPath;
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    for (const name of NAMES) {
      fs.writeFileSync(path.join(root, name), `${name}\n`);
    }
    await vscode.commands.executeCommand("paireto.review.refresh");
  });

  teardown(() => {
    git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...NAMES]);
    for (const name of NAMES) {
      fs.rmSync(path.join(root, name), { force: true });
    }
  });

  test("every stage reaches the index and the tree, even when the next click comes before git finishes", async function () {
    this.timeout(60_000);
    const files: RepoChangedFile[] = NAMES.map((name) => ({
      path: name,
      group: "unstaged",
      status: "U",
      additions: 1,
      deletions: 0,
      repoRoot: canonicalize(root),
    }));

    const results = await Promise.allSettled(
      files.map((file) => vscode.commands.executeCommand("paireto.review.stage", file)),
    );

    assert.deepStrictEqual(
      results.filter((result) => result.status === "rejected"),
      [],
      "no stage may fail",
    );
    assert.deepStrictEqual(
      git(["diff", "--cached", "--name-only", "--", ...NAMES]).split("\n").sort(),
      NAMES,
      "every file must be in the index",
    );
    const snapshot = await vscode.commands.executeCommand<InspectSnapshot>("paireto.test.inspect");
    const repository = snapshot.repositories.find((repo) => repo.repoRoot === canonicalize(root));
    assert.deepStrictEqual(
      NAMES.filter((name) => !repository?.stagedPaths.includes(name)),
      [],
      "every file must show as staged",
    );
    assert.deepStrictEqual(
      NAMES.filter((name) => repository?.unstagedPaths.includes(name)),
      [],
      "no file may still show in the working tree",
    );
  });
});
