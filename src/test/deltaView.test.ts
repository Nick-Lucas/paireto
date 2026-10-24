import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { DiffService, type NetChange } from "../git/DiffService.js";
import { BulkTargetArg, DeltaArg, FileArg, FilesArg } from "../review/commandArgs.js";
import { buildDelta, type DeltaFile } from "../review/delta.js";
import type {
  RepoChangedFile,
  RepositoryReviewState,
  ReviewState,
} from "../review/ReviewController.js";
import { SeenFiles } from "../review/SeenFiles.js";
import type { ChangesMode, FileGroup } from "../types.js";
import { buildFileTree } from "../views/fileTree.js";
import { deltaFileItem, MainTreeProvider } from "../views/MainTreeProvider.js";

const REPO = "/repo";
const EXTENSION = vscode.Uri.file("/ext");

function layer(
  filePath: string,
  group: FileGroup,
  over: Partial<RepoChangedFile> = {},
): RepoChangedFile {
  return {
    repoRoot: REPO,
    path: filePath,
    group,
    status: "M",
    additions: 1,
    deletions: 0,
    ...over,
  };
}

function net(filePath: string, over: Partial<NetChange> = {}): NetChange {
  return {
    path: filePath,
    status: "M",
    additions: 5,
    deletions: 2,
    contentId: `blob-${filePath}`,
    ...over,
  };
}

function repository(layers: RepoChangedFile[], netChanges: NetChange[]): RepositoryReviewState {
  return {
    repoRoot: REPO,
    displayName: "repo",
    changes: {
      staged: layers.filter((f) => f.group === "staged"),
      unstaged: layers.filter((f) => f.group === "unstaged"),
      committed: layers.filter((f) => f.group === "committed"),
      net: netChanges,
      compareLabel: "HEAD",
      compareRef: null,
    },
  };
}

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
  get<T>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function makeRepo(): {
  root: string;
  git: (args: string[]) => string;
  write: (name: string, text: string) => void;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paireto-delta-")));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root }).toString().trim();
  const write = (name: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  write("base.txt", "one\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  return { root, git, write };
}

suite("Delta view — net changes against Compare To", () => {
  test("a file added on the branch and edited since reports one net add with combined counts", async () => {
    const { root, git, write } = makeRepo();
    try {
      const base = git(["rev-parse", "HEAD"]);
      write("feature.txt", "a\nb\n");
      git(["add", "feature.txt"]);
      git(["commit", "-q", "-m", "feature"]);
      write("feature.txt", "a\nb\nc\n");

      const changes = await new DiffService().getChanges(root, { kind: "ref", ref: base });

      const feature = changes.net.find((f) => f.path === "feature.txt");
      assert.deepStrictEqual(
        feature && {
          status: feature.status,
          additions: feature.additions,
          deletions: feature.deletions,
        },
        { status: "A", additions: 3, deletions: 0 },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an untracked file is part of the net changes", async () => {
    const { root, write } = makeRepo();
    try {
      write("fresh.txt", "x\ny\n");

      const changes = await new DiffService().getChanges(root, { kind: "head" });

      assert.deepStrictEqual(
        changes.net.map((f) => ({ path: f.path, status: f.status, additions: f.additions })),
        [{ path: "fresh.txt", status: "U", additions: 2 }],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a file's content id changes when its working tree content changes", async () => {
    const { root, write } = makeRepo();
    try {
      const diff = new DiffService();
      write("base.txt", "two\n");
      const before = (await diff.getChanges(root, { kind: "head" })).net[0].contentId;
      write("base.txt", "three\n");
      const after = (await diff.getChanges(root, { kind: "head" })).net[0].contentId;

      assert.ok(before, "a modified file must carry a content id");
      assert.notStrictEqual(before, after);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the scoped scan for one path reports that path's net change", async () => {
    const { root, write } = makeRepo();
    try {
      write("base.txt", "two\n");
      write("other.txt", "other\n");

      const scoped = await new DiffService().changesForPath(root, ["base.txt"], null);

      assert.deepStrictEqual(
        scoped.net.map((f) => f.path),
        ["base.txt"],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite("Delta view — one row per file", () => {
  test("each row says how much of the change is staged", () => {
    const rows = buildDelta(
      REPO,
      repository(
        [
          layer("work.ts", "unstaged"),
          layer("both.ts", "staged"),
          layer("both.ts", "unstaged"),
          layer("ready.ts", "staged"),
          layer("done.ts", "committed"),
          layer("ready.ts", "committed"),
        ],
        [net("work.ts"), net("both.ts"), net("ready.ts"), net("done.ts")],
      ).changes,
    );

    assert.deepStrictEqual(
      rows.map((row) => [row.path, row.stage]),
      [
        ["both.ts", "partial"],
        ["done.ts", "committed"],
        ["ready.ts", "staged"],
        ["work.ts", "unstaged"],
      ],
    );
  });

  test("a row reports the net counts and lists its topmost layer first", () => {
    const [row] = buildDelta(
      REPO,
      repository(
        [layer("a.ts", "committed"), layer("a.ts", "unstaged")],
        [net("a.ts", { status: "A", additions: 9, deletions: 0 })],
      ).changes,
    );

    assert.deepStrictEqual(
      { status: row.status, additions: row.additions, layers: row.layers.map((l) => l.group) },
      { status: "A", additions: 9, layers: ["unstaged", "committed"] },
    );
  });

  test("a layer change that cancels out against Compare To still gets a row", () => {
    const rows = buildDelta(REPO, repository([layer("undo.ts", "unstaged")], []).changes);

    assert.deepStrictEqual(
      rows.map((row) => ({ path: row.path, additions: row.additions, deletions: row.deletions })),
      [{ path: "undo.ts", additions: 0, deletions: 0 }],
    );
  });
});

function deltaRow(stage: "unstaged" | "partial" | "staged" | "committed"): DeltaFile {
  const groups: Record<typeof stage, FileGroup[]> = {
    unstaged: ["unstaged"],
    partial: ["unstaged", "staged"],
    staged: ["staged"],
    committed: ["committed"],
  };
  const [row] = buildDelta(
    REPO,
    repository(
      groups[stage].map((group) => layer("src/a.ts", group)),
      [net("src/a.ts")],
    ).changes,
  );
  return row;
}

function iconFile(item: vscode.TreeItem): string | undefined {
  const icon = item.iconPath as { dark?: vscode.Uri } | undefined;
  return icon?.dark ? path.basename(icon.dark.path) : undefined;
}

suite("Delta view — rows", () => {
  test("the status letter shows whether the change is staged", () => {
    assert.deepStrictEqual(
      (["unstaged", "partial", "staged"] as const).map((stage) =>
        iconFile(deltaFileItem(deltaRow(stage), "delta", false, EXTENSION)),
      ),
      ["m-dark.svg", "m-partial-dark.svg", "m-staged-dark.svg"],
    );
    const committed = deltaFileItem(deltaRow("committed"), "delta", false, EXTENSION);
    assert.strictEqual((committed.iconPath as vscode.ThemeIcon).id, "git-commit");
  });

  test("a row offers stage and unstage only where that would do work", () => {
    assert.deepStrictEqual(
      (["unstaged", "partial", "staged", "committed"] as const).map(
        (stage) => deltaFileItem(deltaRow(stage), "delta", false, EXTENSION).contextValue,
      ),
      [
        "deltaFile:delta:stage",
        "deltaFile:delta:stage:unstage",
        "deltaFile:delta:unstage",
        "deltaFile:delta",
      ],
    );
  });

  test("a row opens its change against Compare To and shows the net counts", () => {
    const row = deltaRow("partial");
    const item = deltaFileItem(row, "delta", false, EXTENSION);

    assert.strictEqual(item.command?.command, Commands.reviewOpenDelta);
    assert.strictEqual(item.description, "src  +5 -2");
    assert.strictEqual(item.checkboxState, undefined, "Delta mode has no seen checkbox");
  });

  test("in Review mode a row has a seen checkbox and no stage actions", () => {
    const row = deltaRow("unstaged");
    const seen = deltaFileItem(row, "review", true, EXTENSION);
    const unseen = deltaFileItem(row, "review", false, EXTENSION);

    assert.strictEqual(seen.contextValue, "deltaFile:review");
    assert.strictEqual(seen.checkboxState, vscode.TreeItemCheckboxState.Checked);
    assert.strictEqual(unseen.checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  });
});

suite("Delta view — command arguments", () => {
  test("a Delta row opens its topmost layer", () => {
    const row = deltaRow("partial");

    assert.strictEqual(DeltaArg.parse(row).group, "unstaged");
    assert.strictEqual(DeltaArg.parse({ kind: "deltaFile", delta: row }).group, "unstaged");
    assert.strictEqual(FileArg.parse({ kind: "deltaFile", delta: row }).path, "src/a.ts");
  });

  test("stage and unstage on a Delta row or folder act on every layer below it", () => {
    const row = deltaRow("partial");
    const [folder] = buildFileTree([row]);

    assert.deepStrictEqual(
      FilesArg.parse({ kind: "deltaFile", delta: row }).map((f) => f.group),
      ["unstaged", "staged"],
    );
    assert.deepStrictEqual(
      FilesArg.parse({ kind: "deltaFolder", repoRoot: REPO, entry: folder }).map((f) => f.group),
      ["unstaged", "staged"],
    );
  });

  test("Stage All on the section or a repository row names its target", () => {
    assert.deepStrictEqual(BulkTargetArg.parse({ kind: "section", id: "files" }), {
      changesetId: undefined,
      repoRoot: undefined,
    });
    assert.deepStrictEqual(
      BulkTargetArg.parse({ kind: "repository", repository: { repoRoot: REPO } }),
      { changesetId: undefined, repoRoot: REPO },
    );
  });
});

suite("Review mode — seen files", () => {
  test("a file marked seen goes back to unseen when its content changes", async () => {
    const seen = new SeenFiles(new MemoryMemento());
    const row = deltaRow("unstaged");

    await seen.setSeen([row], true);

    assert.strictEqual(seen.isSeen(row), true);
    assert.strictEqual(seen.isSeen({ ...row, contentId: "HEAD:other-blob" }), false);
    await seen.setSeen([row], false);
    assert.strictEqual(seen.isSeen(row), false);
  });
});

interface TreeUnderTest {
  getChildren(node?: unknown): Array<{ kind: string }>;
  getTreeItem(node: unknown): vscode.TreeItem;
  onCheckboxes(items: ReadonlyArray<[unknown, vscode.TreeItemCheckboxState]>): Promise<void>;
}

function treeIn(mode: ChangesMode, seen: SeenFiles, repo: RepositoryReviewState): TreeUnderTest {
  const state: ReviewState = {
    compareTo: { kind: "head" },
    layout: "tree",
    mode,
    repositories: [repo],
  };
  return Object.assign(Object.create(MainTreeProvider.prototype), {
    review: { getState: () => state, isSessionActive: () => false, hasComments: () => false },
    seen,
    extensionUri: EXTENSION,
    agents: { allSessions: () => [] },
    plan: { hasPendingPlan: () => false },
    installStatus: { prompt: () => undefined },
  }) as TreeUnderTest;
}

function filesSection(tree: TreeUnderTest): { kind: string; description?: string } {
  const section = tree
    .getChildren()
    .find((node) => node.kind === "section" && (node as { id?: string }).id === "files");
  assert.ok(section, "the Changed Files section must be listed");
  return section;
}

suite("Review mode — tree", () => {
  const repo = repository(
    [layer("src/a.ts", "unstaged"), layer("src/b.ts", "staged"), layer("top.ts", "unstaged")],
    [net("src/a.ts"), net("src/b.ts"), net("top.ts")],
  );

  test("ticking a folder marks every file below it as seen", async () => {
    const seen = new SeenFiles(new MemoryMemento());
    const tree = treeIn("review", seen, repo);
    const section = filesSection(tree);
    const [folder] = tree.getChildren(section);

    await tree.onCheckboxes([[folder, vscode.TreeItemCheckboxState.Checked]]);

    assert.strictEqual(folder.kind, "deltaFolder");
    assert.strictEqual(
      tree.getTreeItem(folder).checkboxState,
      vscode.TreeItemCheckboxState.Checked,
    );
    assert.deepStrictEqual(
      buildDelta(REPO, repo.changes).map((row) => [row.path, seen.isSeen(row)]),
      [
        ["src/a.ts", true],
        ["src/b.ts", true],
        ["top.ts", false],
      ],
    );
    assert.strictEqual(filesSection(tree).description, "HEAD · 2/3 seen");
  });

  test("Delta mode lists one row per file and offers bulk stage and unstage on the section", () => {
    const tree = treeIn("delta", new SeenFiles(new MemoryMemento()), repo);
    const section = filesSection(tree);

    assert.deepStrictEqual(
      tree.getChildren(section).map((node) => node.kind),
      ["deltaFolder", "deltaFile"],
    );
    assert.strictEqual(tree.getTreeItem(section).contextValue, "section:files:delta:stage:unstage");
  });
});
