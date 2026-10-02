import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { canonicalize } from "../protocol/paths.js";
import type { RepoChangedFile } from "../review/ReviewController.js";

interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
) as { contributes: { menus: Record<string, MenuItem[]> } };

function changedFile(): RepoChangedFile {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test harness must open the fixture git workspace");
  return {
    path: "notes.txt",
    group: "unstaged",
    status: "M",
    additions: 1,
    deletions: 0,
    repoRoot: canonicalize(folder.uri.fsPath),
  };
}

suite("changed file context menu", () => {
  test("offers Copy Path and Focus in Explorer on every changed file row", () => {
    const context = manifest.contributes.menus["view/item/context"];
    for (const command of ["paireto.review.copyPath", "paireto.review.revealInExplorer"]) {
      const entry = context.find((item) => item.command === command);
      assert.ok(entry, `${command} must be in the tree item context menu`);
      assert.strictEqual(entry.when, "view == paireto.main && viewItem =~ /^changedFile:/");
      assert.ok(!entry.group?.startsWith("inline"), `${command} must not be an inline button`);
    }
  });

  test("Copy Path puts the repo relative file path on the clipboard", async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    const file = changedFile();
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand("paireto.review.copyPath", { kind: "file", file });
    assert.strictEqual(await vscode.env.clipboard.readText(), file.path);
  });

  test("Focus in Explorer reveals the file in the explorer", async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    const file = changedFile();
    const calls: unknown[][] = [];
    const original = vscode.commands.executeCommand;
    vscode.commands.executeCommand = (async (command: string, ...rest: unknown[]) => {
      if (command === "revealInExplorer") {
        calls.push(rest);
        return undefined;
      }
      return original(command, ...rest);
    }) as typeof vscode.commands.executeCommand;
    try {
      await original("paireto.review.revealInExplorer", { kind: "file", file });
    } finally {
      vscode.commands.executeCommand = original;
    }
    assert.strictEqual(calls.length, 1);
    const [uri] = calls[0] as [vscode.Uri];
    assert.strictEqual(uri.fsPath, path.join(file.repoRoot, file.path));
  });
});
