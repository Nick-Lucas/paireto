import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { canonicalize } from "../protocol/paths.js";
import { deletedFromDisk, type DeltaFile } from "../review/delta.js";
import type { RepoChangedFile } from "../review/ReviewController.js";
import { changesetFileItem, deltaFileItem, fileItem } from "../views/MainTreeProvider.js";

interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
) as { contributes: { menus: Record<string, MenuItem[]> } };

const EXTENSION = vscode.Uri.file("/ext");

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test harness must open the fixture git workspace");
  return canonicalize(folder.uri.fsPath);
}

function changedFile(over: Partial<RepoChangedFile> = {}): RepoChangedFile {
  return {
    path: "notes.txt",
    group: "unstaged",
    status: "M",
    additions: 1,
    deletions: 0,
    repoRoot: workspaceRoot(),
    ...over,
  };
}

function deltaFile(file: RepoChangedFile): DeltaFile {
  return {
    repoRoot: file.repoRoot,
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    contentId: "id",
    stage: "unstaged",
    layers: [file],
  };
}

function folderNode(repoRoot: string, folderPath: string): unknown {
  return {
    kind: "folder",
    repoRoot,
    group: "unstaged",
    entry: { type: "folder", name: path.basename(folderPath), path: folderPath, children: [] },
  };
}

function menuShows(command: string, contextValue: string): boolean {
  return manifest.contributes.menus["view/item/context"]
    .filter((item) => item.command === command)
    .some((item) => {
      assert.ok(!item.group?.startsWith("inline"), `${command} must not be an inline button`);
      const match = /^view == paireto\.main && viewItem =~ \/(.+)\/$/.exec(item.when ?? "");
      assert.ok(match, `${command} must be keyed on a viewItem pattern, got ${item.when}`);
      return new RegExp(match[1]).test(contextValue);
    });
}

function stubInputBox(answer: string | undefined): {
  seen: vscode.InputBoxOptions[];
  restore: () => void;
} {
  const seen: vscode.InputBoxOptions[] = [];
  const real = vscode.window.showInputBox;
  (vscode.window as unknown as Record<string, unknown>).showInputBox = (
    options: vscode.InputBoxOptions,
  ) => {
    seen.push(options);
    return Promise.resolve(answer);
  };
  return {
    seen,
    restore: () => {
      (vscode.window as unknown as Record<string, unknown>).showInputBox = real;
    },
  };
}

function stubWarnings(answer: string | undefined): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  const real = vscode.window.showWarningMessage;
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = (message: string) => {
    seen.push(message);
    return Promise.resolve(answer);
  };
  return {
    seen,
    restore: () => {
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = real;
    },
  };
}

async function activate(): Promise<void> {
  await vscode.extensions.getExtension("Paireto.paireto")?.activate();
}

suite("changed file context menu", () => {
  const folderRows = [
    "folder:unstaged",
    "folder:staged",
    "deltaFolder:delta:stage",
    "deltaFolder:review",
  ];
  const fileRows = [
    "changedFile:unstaged",
    "changedFile:staged:planned",
    "deltaFile:delta:stage",
    "deltaFile:review",
  ];
  const deletedFileRows = [
    "changedFile:unstaged:deleted",
    "changedFile:staged:planned:deleted",
    "deltaFile:delta:unstage:deleted",
  ];

  test("offers Copy Path and Focus in Explorer on every changed file row", () => {
    for (const command of ["paireto.review.copyPath", "paireto.review.revealInExplorer"]) {
      for (const row of [...fileRows, ...deletedFileRows]) {
        assert.ok(menuShows(command, row), `${command} must show on ${row}`);
      }
    }
  });

  test("offers New File, Copy Path and Rename on folder rows", () => {
    for (const command of [
      "paireto.review.newFile",
      "paireto.review.copyPath",
      "paireto.review.rename",
    ]) {
      for (const row of folderRows) {
        assert.ok(menuShows(command, row), `${command} must show on ${row}`);
      }
    }
    assert.ok(!menuShows("paireto.review.delete", "folder:unstaged"));
    assert.ok(!menuShows("paireto.review.newFile", "changedFile:unstaged"));
  });

  test("offers Rename and Delete on file rows whose file is still on disk", () => {
    for (const command of ["paireto.review.rename", "paireto.review.delete"]) {
      for (const row of fileRows) {
        assert.ok(menuShows(command, row), `${command} must show on ${row}`);
      }
      for (const row of deletedFileRows) {
        assert.ok(!menuShows(command, row), `${command} must not show on ${row}`);
      }
    }
  });

  test("a file is gone from disk only when its newest layer deletes it", () => {
    const at = (
      filePath: string,
      group: RepoChangedFile["group"],
      status: RepoChangedFile["status"],
    ) => changedFile({ path: filePath, group, status });
    const gone = deletedFromDisk({
      unstaged: [
        at("staged-then-deleted.txt", "unstaged", "D"),
        at("recreated.txt", "unstaged", "A"),
      ],
      staged: [at("staged-then-deleted.txt", "staged", "M"), at("recreated.txt", "staged", "D")],
      committed: [
        at("deleted-in-commit.txt", "committed", "D"),
        at("edited.txt", "committed", "M"),
      ],
    });
    assert.deepStrictEqual([...gone].sort(), ["deleted-in-commit.txt", "staged-then-deleted.txt"]);
  });

  test("marks the row of a file gone from disk so Rename and Delete stay hidden", () => {
    const staged = changedFile({ group: "staged" });
    assert.strictEqual(
      fileItem(staged, EXTENSION, true).contextValue,
      "changedFile:staged:deleted",
    );
    assert.strictEqual(fileItem(staged, EXTENSION, false).contextValue, "changedFile:staged");
    assert.strictEqual(
      changesetFileItem(
        staged.repoRoot,
        { changesetId: "c", path: staged.path, file: staged },
        EXTENSION,
        true,
      ).contextValue,
      "changedFile:staged:planned:deleted",
    );
    assert.strictEqual(
      deltaFileItem(deltaFile(changedFile({ status: "D" })), "delta", false, EXTENSION)
        .contextValue,
      "deltaFile:delta:stage:deleted",
    );
  });

  test("Copy Path puts the repo relative file path on the clipboard", async function () {
    this.timeout(30_000);
    await activate();
    const file = changedFile();
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand("paireto.review.copyPath", { kind: "file", file });
    assert.strictEqual(await vscode.env.clipboard.readText(), file.path);
  });

  test("Copy Path on a folder puts the repo relative folder path on the clipboard", async function () {
    this.timeout(30_000);
    await activate();
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand(
      "paireto.review.copyPath",
      folderNode(workspaceRoot(), "src/review"),
    );
    assert.strictEqual(await vscode.env.clipboard.readText(), "src/review");
  });

  test("Focus in Explorer reveals the file in the explorer", async function () {
    this.timeout(30_000);
    await activate();
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

suite("changed file operations", () => {
  let root: string;
  let dir: string;

  setup(async function () {
    this.timeout(30_000);
    await activate();
    root = workspaceRoot();
    dir = `ops-${Date.now()}`;
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, "a.txt"), "a\n");
    fs.writeFileSync(path.join(root, dir, "taken.txt"), "taken\n");
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    fs.rmSync(path.join(root, `${dir}-renamed`), { recursive: true, force: true });
  });

  function fileIn(name: string): RepoChangedFile {
    return changedFile({ path: `${dir}/${name}`, status: "A" });
  }

  test("New File creates the named file in the folder and opens it", async function () {
    this.timeout(30_000);
    const input = stubInputBox("nested/new.txt");
    try {
      await vscode.commands.executeCommand("paireto.review.newFile", folderNode(root, dir));
    } finally {
      input.restore();
    }
    const created = path.join(root, dir, "nested", "new.txt");
    assert.ok(fs.existsSync(created), "the new file must exist on disk");
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, created);
  });

  test("New File refuses a name that is already taken", async function () {
    this.timeout(30_000);
    const input = stubInputBox(undefined);
    try {
      await vscode.commands.executeCommand("paireto.review.newFile", folderNode(root, dir));
    } finally {
      input.restore();
    }
    const validate = input.seen[0]?.validateInput;
    assert.ok(validate, "the name prompt must validate its input");
    assert.ok(await validate("taken.txt"), "an existing name must be refused");
    assert.ok(await validate("  "), "an empty name must be refused");
    assert.ok(!(await validate("fresh.txt")), "a free name must be accepted");
  });

  test("Rename on a file moves it to the new name", async function () {
    this.timeout(30_000);
    const input = stubInputBox("b.txt");
    try {
      await vscode.commands.executeCommand("paireto.review.rename", {
        kind: "file",
        file: fileIn("a.txt"),
      });
    } finally {
      input.restore();
    }
    assert.strictEqual(input.seen[0]?.value, "a.txt");
    assert.deepStrictEqual(input.seen[0]?.valueSelection, [0, 1]);
    assert.ok(!fs.existsSync(path.join(root, dir, "a.txt")), "the old name must be gone");
    assert.strictEqual(fs.readFileSync(path.join(root, dir, "b.txt"), "utf8"), "a\n");
  });

  test("Rename accepts a change to the letter case of the name", async function () {
    this.timeout(30_000);
    const input = stubInputBox(undefined);
    try {
      await vscode.commands.executeCommand("paireto.review.rename", {
        kind: "file",
        file: fileIn("a.txt"),
      });
    } finally {
      input.restore();
    }
    const validate = input.seen[0]?.validateInput;
    assert.ok(validate, "the name prompt must validate its input");
    assert.ok(!(await validate("A.txt")), "a case only rename must be accepted");
  });

  test("Rename on a delta file row refuses a name that is already taken", async function () {
    this.timeout(30_000);
    const input = stubInputBox(undefined);
    try {
      await vscode.commands.executeCommand("paireto.review.rename", {
        kind: "deltaFile",
        delta: deltaFile(fileIn("a.txt")),
      });
    } finally {
      input.restore();
    }
    const validate = input.seen[0]?.validateInput;
    assert.ok(validate, "the name prompt must validate its input");
    assert.ok(await validate("taken.txt"), "an existing name must be refused");
    assert.ok(!(await validate("a.txt")), "keeping the same name must be accepted");
    assert.ok(
      fs.existsSync(path.join(root, dir, "a.txt")),
      "a dismissed prompt must change nothing",
    );
  });

  test("Rename on a folder moves the whole folder", async function () {
    this.timeout(30_000);
    const input = stubInputBox(`${dir}-renamed`);
    try {
      await vscode.commands.executeCommand("paireto.review.rename", folderNode(root, dir));
    } finally {
      input.restore();
    }
    assert.ok(!fs.existsSync(path.join(root, dir)), "the old folder must be gone");
    assert.ok(fs.existsSync(path.join(root, `${dir}-renamed`, "a.txt")));
  });

  test("Delete removes the file once the user confirms", async function () {
    this.timeout(30_000);
    const warnings = stubWarnings("Delete");
    try {
      await vscode.commands.executeCommand("paireto.review.delete", {
        kind: "file",
        file: fileIn("a.txt"),
      });
    } finally {
      warnings.restore();
    }
    assert.strictEqual(warnings.seen.length, 1);
    assert.ok(warnings.seen[0].includes("a.txt"), "the confirmation must name the file");
    assert.ok(!fs.existsSync(path.join(root, dir, "a.txt")), "the file must be deleted");
  });

  test("Delete keeps the file when the user cancels", async function () {
    this.timeout(30_000);
    const warnings = stubWarnings(undefined);
    try {
      await vscode.commands.executeCommand("paireto.review.delete", {
        kind: "file",
        file: fileIn("a.txt"),
      });
    } finally {
      warnings.restore();
    }
    assert.ok(fs.existsSync(path.join(root, dir, "a.txt")), "the file must stay");
  });
});
