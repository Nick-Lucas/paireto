import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { DiffService } from "../git/DiffService.js";
import {
  ReviewController,
  type RepoChangedFile,
  type RepositoryReviewState,
} from "../review/ReviewController.js";

const LINES = 300;
const MEMBER_LINE = 250;

interface Opener {
  openAgainstCompareToAt(
    file: RepoChangedFile,
    focus: { side: "base" | "modified"; start: number; end: number },
  ): Promise<vscode.TextEditor | undefined>;
}

async function changedRepository(): Promise<RepositoryReviewState> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paireto-open-at-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const lines = Array.from({ length: LINES }, (_, i) => `export const line${i} = ${i};`);
  fs.writeFileSync(path.join(root, "long.ts"), `${lines.join("\n")}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  lines[0] = "export const line0 = -1;";
  lines[MEMBER_LINE] = `export const line${MEMBER_LINE} = -1;`;
  fs.writeFileSync(path.join(root, "long.ts"), `${lines.join("\n")}\n`);
  const changes = await new DiffService().getChanges(root, { kind: "head" });
  const scope = <T>(files: T[]) => files.map((file) => ({ ...file, repoRoot: root }));
  return {
    repoRoot: root,
    displayName: "long",
    changes: {
      ...changes,
      staged: scope(changes.staged),
      unstaged: scope(changes.unstaged),
      committed: scope(changes.committed),
    },
  };
}

function opener(state: RepositoryReviewState): Opener {
  const diff = new DiffService();
  const repositoryStates = new Map([[state.repoRoot, state]]);
  return Object.assign(Object.create(ReviewController.prototype), {
    reviewId: "open-at",
    diff,
    repositoryStates,
    openDiffSeq: 0,
    openDiffs: new Map(),
    activeDiffEmitter: { fire() {} },
    reviewContent: { refresh() {} },
    openDiffSync: {
      changesForPath: (repoRoot: string, relPaths: string[], compareRef: string | null) =>
        diff.changesForPath(repoRoot, relPaths, compareRef),
      getRepository: (repoRoot: string) => repositoryStates.get(repoRoot),
      setRepository: (next: RepositoryReviewState) => repositoryStates.set(next.repoRoot, next),
      getRefreshSeq: () => 0,
      fullRefresh: async () => {},
      fireChange() {},
    },
  }) as Opener;
}

suite("opening a diff at a member", function () {
  this.timeout(30_000);

  test("the diff stays on the member's line after VS Code finishes the diff", async () => {
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const state = await changedRepository();
    const file = state.changes.unstaged.find((f) => f.path === "long.ts");
    assert.ok(file, "long.ts is changed");

    const editor = await opener(state).openAgainstCompareToAt(file, {
      side: "modified",
      start: MEMBER_LINE,
      end: MEMBER_LINE,
    });
    assert.ok(editor, "the diff opens");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const visible = editor.visibleRanges.map((r) => [r.start.line, r.end.line]);
    assert.ok(
      editor.visibleRanges.some((r) => r.start.line <= MEMBER_LINE && r.end.line >= MEMBER_LINE),
      `line ${MEMBER_LINE} is on screen, but the view shows ${JSON.stringify(visible)}`,
    );
    assert.strictEqual(editor.selection.active.line, MEMBER_LINE);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("the diff moves to the member when the same file is also open as a plain editor", async () => {
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const state = await changedRepository();
    const file = state.changes.unstaged.find((f) => f.path === "long.ts");
    assert.ok(file, "long.ts is changed");
    const plain = await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(state.repoRoot, "long.ts")),
      { viewColumn: vscode.ViewColumn.One },
    );

    const editor = await opener(state).openAgainstCompareToAt(file, {
      side: "modified",
      start: MEMBER_LINE,
      end: MEMBER_LINE,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert.ok(editor, "the diff opens");
    assert.notStrictEqual(editor, plain, "the jump goes to the diff, not the plain editor");
    assert.notStrictEqual(editor.viewColumn, plain.viewColumn);
    assert.ok(
      editor.visibleRanges.some((r) => r.start.line <= MEMBER_LINE && r.end.line >= MEMBER_LINE),
      `line ${MEMBER_LINE} is on screen in the diff`,
    );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
