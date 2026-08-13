import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import type { InspectSnapshot } from "../e2e/inspectTypes.js";
import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function selectCompareRef(ref: string): Promise<void> {
  const pickers: Array<{
    picker: vscode.QuickPick<vscode.QuickPickItem>;
    accept?: () => unknown;
  }> = [];
  const createQuickPick = vscode.window.createQuickPick;
  const replaced = Reflect.set(vscode.window, "createQuickPick", () => {
    const picker = createQuickPick<vscode.QuickPickItem>();
    const driver: (typeof pickers)[number] = { picker };
    const onDidAccept = picker.onDidAccept.bind(picker);
    Reflect.set(picker, "onDidAccept", (listener: () => unknown) => {
      driver.accept = listener;
      return onDidAccept(listener);
    });
    pickers.push(driver);
    return picker;
  });
  assert.ok(replaced, "the test must be able to drive the Compare To picker");

  const waitForPicker = async (index: number): Promise<(typeof pickers)[number]> => {
    const deadline = Date.now() + 5_000;
    while (!pickers[index]) {
      assert.ok(Date.now() <= deadline, `Compare To picker ${index + 1} did not open`);
      await wait(25);
    }
    return pickers[index];
  };

  try {
    const command = vscode.commands.executeCommand("paireto.review.pickCompareTo");
    const compareDriver = await waitForPicker(0);
    const branchRefItem = compareDriver.picker.items.find((item) =>
      item.label.includes("Branch/Ref"),
    );
    assert.ok(branchRefItem, "the Compare To picker must contain the Branch/Ref item");
    compareDriver.picker.activeItems = [branchRefItem];
    assert.ok(compareDriver.accept, "the Compare To picker must register an accept listener");
    compareDriver.accept();

    const refDriver = await waitForPicker(1);
    refDriver.picker.value = ref;
    const deadline = Date.now() + 5_000;
    while (
      (refDriver.picker.busy ||
        !refDriver.picker.items.some(
          (item) => (item as vscode.QuickPickItem & { ref?: string }).ref === ref,
        )) &&
      Date.now() <= deadline
    ) {
      await wait(25);
    }
    assert.ok(
      refDriver.picker.items.some(
        (item) => (item as vscode.QuickPickItem & { ref?: string }).ref === ref,
      ),
      `${ref} must be selectable`,
    );
    assert.ok(refDriver.accept, "the ref picker must register an accept listener");
    refDriver.accept();
    await command;
  } finally {
    Reflect.set(vscode.window, "createQuickPick", createQuickPick);
  }
}

async function inspectRepository(
  repoRoot: string,
): Promise<InspectSnapshot["repositories"][number]> {
  const snapshot = (await vscode.commands.executeCommand(
    "paireto.test.inspect",
  )) as InspectSnapshot;
  const repository = snapshot.repositories.find((candidate) => candidate.repoRoot === repoRoot);
  assert.ok(repository, "the Changes model must include the fixture repository");
  return repository;
}

async function activeDiff(): Promise<vscode.TabInputTextDiff | undefined> {
  const deadline = Date.now() + 5_000;
  do {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
      return input;
    }
    await wait(25);
  } while (Date.now() <= deadline);
  return undefined;
}

suite("committed diff retention", () => {
  test("keeps the committed comparison when the same file gets a Working Tree change", async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const root = folder.uri.fsPath;
    const repoRoot = canonicalize(root);
    const fileName = "committed-diff-retention.txt";
    const filePath = path.join(root, fileName);
    fs.writeFileSync(filePath, "base\n");
    execFileSync("git", ["add", fileName], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "committed diff retention base", "--", fileName], {
      cwd: root,
    });
    const compareRef = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(filePath, "committed\n");
    execFileSync("git", ["add", fileName], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "committed diff retention change", "--", fileName], {
      cwd: root,
    });

    await selectCompareRef(compareRef);
    let repository = await inspectRepository(repoRoot);
    assert.ok(repository.committedPaths.includes(fileName), "the committed row must be visible");

    fs.writeFileSync(filePath, "committed\nworking tree\n");
    await vscode.commands.executeCommand("paireto.review.refresh");
    repository = await inspectRepository(repoRoot);
    assert.ok(repository.unstagedPaths.includes(fileName), "the Working Tree row must be visible");
    assert.ok(
      repository.committedPaths.includes(fileName),
      "the committed row must remain visible beside the Working Tree row",
    );

    const committedFile: RepoChangedFile = {
      repoRoot,
      path: fileName,
      group: "committed",
      status: "M",
      additions: 1,
      deletions: 1,
    };
    await vscode.commands.executeCommand("paireto.review.openDiff", committedFile);
    const input = await activeDiff();
    assert.ok(input, "the committed row must open a diff");
    assert.strictEqual(input.original.scheme, Schemes.review);
    assert.strictEqual(input.modified.scheme, Schemes.review);
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(input.original)).getText(),
      "base\n",
    );
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(input.modified)).getText(),
      "committed\n",
      "the committed diff must end at HEAD and exclude the local edit",
    );
  });
});
