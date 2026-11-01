import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import type { RepoChangedFile } from "../review/ReviewController.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  resetWorkbench,
  waitFor,
  type Wire,
} from "./planGateHarness.js";

const OPENED = "reveal-tree-opened.txt";
const COMMENTED = "reveal-tree-commented.txt";

suite("revealing a feedback comment", () => {
  let wire: Wire;
  let repoRoot: string;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot });
    await resetWorkbench(wire);
  });

  function modify(name: string): void {
    const file = path.join(repoRoot, name);
    fs.writeFileSync(file, "one\ntwo\n");
    execFileSync("git", ["add", name], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", `fixture ${name}`, "--", name], { cwd: repoRoot });
    fs.writeFileSync(file, "one\ntwo\nthree\n");
  }

  function activeDiffPath(): string | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff ? input.modified.path : undefined;
  }

  test("does not move the tree selection to the comment's file", async function () {
    this.timeout(60_000);
    modify(OPENED);
    modify(COMMENTED);
    await vscode.commands.executeCommand(Commands.reviewRefresh);
    await waitFor("both files to reach the Changes view", async () => {
      const paths = (await inspect()).repositories.flatMap((r) => r.unstagedPaths);
      return paths.includes(OPENED) && paths.includes(COMMENTED) ? true : undefined;
    });

    const opened: RepoChangedFile = {
      repoRoot,
      path: OPENED,
      group: "unstaged",
      status: "M",
      additions: 1,
      deletions: 0,
    };
    await vscode.commands.executeCommand(Commands.reviewOpenDiff, opened);
    await waitFor("the opened file's row to be selected", async () =>
      (await inspect()).treeSelection.includes(OPENED) ? true : undefined,
    );

    const id = await queueFileComment("why the third line?", { path: COMMENTED, line: 2 });
    await vscode.commands.executeCommand(Commands.reviewRevealComment, { id });
    await waitFor("the comment's diff to open", () =>
      activeDiffPath()?.endsWith(COMMENTED) ? true : undefined,
    );

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      assert.ok(
        !(await inspect()).treeSelection.includes(COMMENTED),
        "the tree does not select the comment's file",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepStrictEqual(
      (await inspect()).treeSelection,
      [OPENED],
      "the tree keeps the row the user had selected",
    );
  });
});
