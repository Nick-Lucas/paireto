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

function lines(prefix: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += `${prefix} line ${i} ${"x".repeat(40)}\n`;
  }
  return out;
}

function unstaged(folder: vscode.WorkspaceFolder, name: string): RepoChangedFile {
  return {
    path: name,
    group: "unstaged",
    status: "M",
    additions: 1,
    deletions: 1,
    repoRoot: canonicalize(folder.uri.fsPath),
  };
}

function diffTabsFor(name: string): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.label.startsWith(name));
}

function stubWarning(
  reply: (items: string[]) => string | undefined,
  messages: string[],
): () => void {
  const target = vscode.window as { showWarningMessage: unknown };
  const original = target.showWarningMessage;
  target.showWarningMessage = (
    message: string,
    ...items: string[]
  ): Thenable<string | undefined> => {
    messages.push(message);
    return Promise.resolve(reply(items));
  };
  return () => {
    target.showWarningMessage = original;
  };
}

suite("openDiff large files", () => {
  let folder: vscode.WorkspaceFolder;
  const created: string[] = [];

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: folder.uri.fsPath });
  }

  function write(name: string, content: string): void {
    fs.writeFileSync(path.join(folder.uri.fsPath, name), content);
  }

  function commitFile(name: string, content: string): void {
    write(name, content);
    git("add", name);
    git("commit", "-q", "-m", `add ${name}`);
    created.push(name);
  }

  setup(async () => {
    const first = vscode.workspace.workspaceFolders?.[0];
    assert.ok(first, "the test harness must open the fixture git workspace");
    folder = first;
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const name of created.splice(0)) {
      git("rm", "-q", "-f", name);
      git("commit", "-q", "-m", `remove ${name}`);
    }
  });

  test("a file above the size limit opens without a diff and warns", async function () {
    this.timeout(90_000);
    const name = "too-large.txt";
    const committed = lines("committed", 100_000);
    commitFile(name, committed);
    write(name, `${committed}changed\n`);

    const messages: string[] = [];
    const restore = stubWarning(() => undefined, messages);
    try {
      await vscode.commands.executeCommand("paireto.review.openDiff", unstaged(folder, name));

      const tab = await waitFor(() => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        return active?.input instanceof vscode.TabInputText && active.input.uri.path.endsWith(name)
          ? active
          : undefined;
      }, 30_000);
      assert.ok(tab, "a file above the limit must open as a plain editor");
      assert.strictEqual(diffTabsFor(name).length, 0, "no diff tab may exist for the large file");
      await waitFor(() => (messages.length > 0 ? true : undefined), 5_000);
    } finally {
      restore();
    }
    assert.strictEqual(messages.length, 1, "the user must see one warning");
    assert.ok(messages[0].includes("too large to diff"), messages[0]);
  });

  test("Open Diff Anyway opens the diff of a file above the size limit", async function () {
    this.timeout(90_000);
    const name = "too-large-anyway.txt";
    const committed = lines("committed", 100_000);
    commitFile(name, committed);
    write(name, `${committed}changed\n`);

    const messages: string[] = [];
    const restore = stubWarning((items) => items[0], messages);
    try {
      await vscode.commands.executeCommand("paireto.review.openDiff", unstaged(folder, name));

      const tab = await waitFor(() => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        return active?.input instanceof vscode.TabInputTextDiff &&
          active.input.modified.path.endsWith(name)
          ? active
          : undefined;
      }, 60_000);
      assert.ok(tab, "choosing Open Diff Anyway must open the diff");
    } finally {
      restore();
    }
    assert.strictEqual(messages.length, 1, "the user must see one warning before choosing");
    assert.ok(messages[0].includes("too large to diff"), messages[0]);
  });

  test("the last opened diff wins over a slower earlier open", async function () {
    this.timeout(90_000);
    const large = "slow-large.txt";
    const small = "quick-small.txt";
    commitFile(large, lines("committed", 65_000));
    commitFile(small, "one\ntwo\n");
    write(large, lines("modified", 65_000));
    write(small, "one\ntwo\nthree\n");

    const opens = [
      vscode.commands.executeCommand("paireto.review.openDiff", unstaged(folder, large)),
      vscode.commands.executeCommand("paireto.review.openDiff", unstaged(folder, small)),
    ];

    const tab = await waitFor(() => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      return active?.input instanceof vscode.TabInputTextDiff &&
        active.input.modified.path.endsWith(small)
        ? active
        : undefined;
    }, 30_000);
    assert.ok(tab, "the small file diff must open");

    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(
      active?.input instanceof vscode.TabInputTextDiff &&
        active.input.modified.path.endsWith(small),
      "the small file diff must stay active",
    );
    assert.strictEqual(diffTabsFor(large).length, 0, "the superseded open must not create a tab");
    await Promise.all(opens);
  });
});
