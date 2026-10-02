import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import { canonicalize } from "../protocol/paths.js";
import {
  ReviewController,
  type OpenDiffState,
  type RepoChangedFile,
  type ReviewState,
} from "../review/ReviewController.js";
import type { FileGroup } from "../types.js";
import { MainTreeProvider } from "../views/MainTreeProvider.js";

const REPO = "/repo";
const NAME = "notes.txt";

interface EditTracker {
  maybeMarkAsUnstaged(uri: vscode.Uri): void;
  openDiffFile?: OpenDiffState;
}

interface Tree {
  syncSelection(target: { repoRoot: string; group: FileGroup; path: string }): void;
  onStateChanged(): void;
}

function row(group: FileGroup): RepoChangedFile {
  return { repoRoot: REPO, path: NAME, group, status: "M", additions: 1, deletions: 0 };
}

function state(groups: Partial<Record<FileGroup, RepoChangedFile[]>>): ReviewState {
  return {
    compareTo: { kind: "head" },
    layout: "flat",
    repositories: [
      {
        repoRoot: REPO,
        displayName: "repo",
        changes: {
          staged: [],
          unstaged: [],
          committed: [],
          compareLabel: "HEAD",
          compareRef: null,
          ...groups,
        },
      },
    ],
  };
}

function buildTree(getState: () => ReviewState, revealed: FileGroup[]): Tree {
  return Object.assign(Object.create(MainTreeProvider.prototype), {
    emitter: { fire() {} },
    review: { getState },
    view: {
      reveal(node: { file: RepoChangedFile }): Promise<void> {
        revealed.push(node.file.group);
        return Promise.resolve();
      },
    },
  }) as Tree;
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

suite("editing a staged diff (tree selection)", () => {
  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("the edit moves the tab's row to the Working Tree without selecting that row", async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const root = folder.uri.fsPath;
    const name = "changes-list-reveal.txt";
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, "one\n");
    execFileSync("git", ["add", name], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", `fixture ${name}`, "--", name], { cwd: root });
    fs.writeFileSync(filePath, "one\ntwo\n");
    execFileSync("git", ["add", name], { cwd: root });

    const file: RepoChangedFile = {
      repoRoot: canonicalize(root),
      path: name,
      group: "staged",
      status: "M",
      additions: 1,
      deletions: 0,
    };
    await vscode.commands.executeCommand("paireto.review.openDiff", file);
    const input = await waitFor(() => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return active instanceof vscode.TabInputTextDiff && active.modified.path.endsWith(name)
        ? active
        : undefined;
    }, 20_000);
    assert.ok(input, `the staged row for ${name} must open a diff`);
    assert.strictEqual(input.original.scheme, Schemes.review);
    assert.strictEqual(input.modified.scheme, "file", "the staged diff must be editable");

    const fired: Array<{ group: FileGroup; path: string }> = [];
    const emitter = new vscode.EventEmitter<{ repoRoot: string; group: FileGroup; path: string }>();
    const sub = emitter.event((target) => fired.push(target));
    const open: OpenDiffState = {
      repoRoot: path.dirname(input.modified.fsPath),
      path: name,
      group: "staged",
      baseRef: "HEAD",
    };
    const controller = Object.assign(Object.create(ReviewController.prototype), {
      openDiffFile: open,
      openDiffs: new Map([[input.original.toString(), open]]),
      activeDiffEmitter: emitter,
    }) as EditTracker;

    try {
      controller.maybeMarkAsUnstaged(input.modified);
      assert.strictEqual(
        controller.openDiffFile?.group,
        "unstaged",
        "the edit must move the tab's row to the Working Tree",
      );
      assert.deepStrictEqual(
        fired,
        [],
        "the edit must not ask the tree to select the Working Tree row",
      );
    } finally {
      sub.dispose();
      emitter.dispose();
    }
  });
});

suite("changes list reveal", () => {
  test("a row that arrives after the save is not revealed", () => {
    const revealed: FileGroup[] = [];
    let current = state({ committed: [row("committed")] });
    const tree = buildTree(() => current, revealed);

    tree.syncSelection({ repoRoot: REPO, group: "unstaged", path: NAME });
    assert.deepStrictEqual(revealed, [], "there is no Working Tree row to select yet");

    current = state({ committed: [row("committed")], unstaged: [row("unstaged")] });
    tree.onStateChanged();
    assert.deepStrictEqual(
      revealed,
      [],
      "the saved file's new Working Tree row must not pull the list to it",
    );
  });

  test("the row of the diff the user opens is still selected", () => {
    const revealed: FileGroup[] = [];
    const current = state({ committed: [row("committed")] });
    const tree = buildTree(() => current, revealed);

    tree.syncSelection({ repoRoot: REPO, group: "committed", path: NAME });
    assert.deepStrictEqual(revealed, ["committed"], "an existing row must still be selected");
  });
});
