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
import {
  ReviewController,
  viewModeItems,
  type RepoChangedFile,
  type RepositoryReviewState,
  type ReviewState,
  type ViewModeItem,
} from "../review/ReviewController.js";
import { SeenFiles } from "../review/SeenFiles.js";
import type { ChangesMode, FileGroup, FileLayout } from "../types.js";
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

suite("Delta view — merge conflicts", () => {
  test("a conflicted file is one conflicted row and a cleanly merged file stays staged", async () => {
    const { root, git, write } = makeRepo();
    try {
      write("both.txt", "one\n");
      write("gone.txt", "one\n");
      write("clean.txt", "one\n");
      git(["add", "."]);
      git(["commit", "-q", "-m", "files"]);
      git(["checkout", "-q", "-b", "feature"]);
      write("both.txt", "feature\n");
      write("gone.txt", "feature\n");
      write("clean.txt", "feature\n");
      git(["commit", "-q", "-am", "feature"]);
      git(["checkout", "-q", "main"]);
      write("both.txt", "main\n");
      git(["rm", "-q", "gone.txt"]);
      git(["commit", "-q", "-am", "main"]);
      assert.throws(() => git(["merge", "feature"]));

      const changes = await new DiffService().getChanges(root, { kind: "head" });
      const withRoot = (files: typeof changes.staged): RepoChangedFile[] =>
        files.map((file) => ({ ...file, repoRoot: root }));
      const rows = buildDelta(root, {
        ...changes,
        staged: withRoot(changes.staged),
        unstaged: withRoot(changes.unstaged),
        committed: withRoot(changes.committed),
      });

      assert.deepStrictEqual(
        rows.map((row) => ({
          path: row.path,
          status: row.status,
          stage: row.stage,
          layers: row.layers.map((l) => `${l.group}:${l.status}`),
        })),
        [
          { path: "both.txt", status: "!", stage: "unstaged", layers: ["unstaged:!"] },
          { path: "clean.txt", status: "M", stage: "staged", layers: ["staged:M"] },
          { path: "gone.txt", status: "!", stage: "unstaged", layers: ["unstaged:!"] },
        ],
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

  test("in Review mode a seen row is greyed out like a staged row", () => {
    const row = deltaRow("committed");

    assert.strictEqual(
      iconFile(deltaFileItem(row, "review", true, EXTENSION)),
      "m-staged-dark.svg",
    );
    assert.strictEqual(iconFile(deltaFileItem(row, "review", false, EXTENSION)), "m-dark.svg");
  });

  test("a conflicted row shows the conflict icon in Delta and Review mode", () => {
    const [row] = buildDelta(
      REPO,
      repository([layer("src/a.ts", "unstaged", { status: "!" })], [net("src/a.ts")]).changes,
    );

    assert.deepStrictEqual(
      [
        deltaFileItem(row, "delta", false, EXTENSION),
        deltaFileItem(row, "review", false, EXTENSION),
        deltaFileItem(row, "review", true, EXTENSION),
      ].map(iconFile),
      ["conflict-dark.svg", "conflict-dark.svg", "conflict-dark.svg"],
    );
  });

  test("every icon a row can show is a file the extension ships", () => {
    const media = path.resolve(__dirname, "../../media/status");
    const statuses = ["A", "M", "D", "R", "C", "U", "!"] as const;
    const missing = statuses.flatMap((status) =>
      (["unstaged", "partial", "staged"] as const).flatMap((stage) => {
        const row = { ...deltaRow(stage), status };
        return [
          deltaFileItem(row, "delta", false, EXTENSION),
          deltaFileItem(row, "review", true, EXTENSION),
          deltaFileItem(row, "review", false, EXTENSION),
        ]
          .map(iconFile)
          .filter((file): file is string => file !== undefined)
          .filter((file) => !fs.existsSync(path.join(media, file)))
          .map((file) => `${status}/${stage}: ${file}`);
      }),
    );

    assert.deepStrictEqual(missing, []);
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

  test("the Changed Files checkbox is ticked only when every file is seen, and ticks them all", async () => {
    const seen = new SeenFiles(new MemoryMemento());
    const tree = treeIn("review", seen, repo);
    const sectionBox = (): vscode.TreeItemCheckboxState | undefined =>
      tree.getTreeItem(filesSection(tree)).checkboxState as vscode.TreeItemCheckboxState;
    const rows = buildDelta(REPO, repo.changes);

    assert.strictEqual(sectionBox(), vscode.TreeItemCheckboxState.Unchecked);
    await seen.setSeen(rows.slice(0, 1), true);
    assert.strictEqual(sectionBox(), vscode.TreeItemCheckboxState.Unchecked);

    await tree.onCheckboxes([[filesSection(tree), vscode.TreeItemCheckboxState.Checked]]);
    assert.strictEqual(sectionBox(), vscode.TreeItemCheckboxState.Checked);
    assert.ok(
      rows.every((row) => seen.isSeen(row)),
      "ticking the section marks every file seen",
    );

    await tree.onCheckboxes([[filesSection(tree), vscode.TreeItemCheckboxState.Unchecked]]);
    assert.ok(
      rows.every((row) => !seen.isSeen(row)),
      "unticking the section marks every file unseen",
    );
  });

  test("the Changed Files row has no checkbox outside Review mode", () => {
    const tree = treeIn("delta", new SeenFiles(new MemoryMemento()), repo);

    assert.strictEqual(tree.getTreeItem(filesSection(tree)).checkboxState, undefined);
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

interface ViewModePicker {
  pickViewMode(): void;
}

function controllerWith(
  mode: ChangesMode,
  layout: FileLayout,
): {
  controller: ViewModePicker;
  saved: { mode?: ChangesMode; layout?: FileLayout };
  fired: () => number;
} {
  const saved: { mode?: ChangesMode; layout?: FileLayout } = {};
  let fires = 0;
  const controller = Object.assign(Object.create(ReviewController.prototype), {
    mode,
    layout,
    store: {
      setMode: (value: ChangesMode) => {
        saved.mode = value;
        return Promise.resolve();
      },
      setLayout: (value: FileLayout) => {
        saved.layout = value;
        return Promise.resolve();
      },
    },
    changeEmitter: { fire: () => (fires += 1) },
  }) as ViewModePicker;
  return { controller, saved, fired: () => fires };
}

interface OpenedPicker {
  pick: vscode.QuickPick<ViewModeItem>;
  activeOnOpen: string[];
  hidden: () => boolean;
}

async function withPicker(
  controller: ViewModePicker,
  run: (opened: OpenedPicker) => Promise<void>,
): Promise<void> {
  const original = vscode.window.createQuickPick;
  let opened: OpenedPicker | undefined;
  vscode.window.createQuickPick = (<T extends vscode.QuickPickItem>() => {
    const pick = original<ViewModeItem>();
    let hidden = false;
    pick.onDidHide(() => (hidden = true));
    const show = pick.show.bind(pick);
    pick.show = () => {
      show();
      opened = {
        pick,
        activeOnOpen: pick.activeItems.map((item) => item.label),
        hidden: () => hidden,
      };
    };
    return pick as unknown as vscode.QuickPick<T>;
  }) as typeof vscode.window.createQuickPick;
  try {
    controller.pickViewMode();
    assert.ok(opened, "the View Modes picker must open");
    await run(opened);
  } finally {
    vscode.window.createQuickPick = original;
    opened?.pick.hide();
  }
}

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!probe()) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const labels = (items: readonly ViewModeItem[]): string[] => items.map((item) => item.label);

async function accept(pick: vscode.QuickPick<ViewModeItem>, name: string): Promise<void> {
  const reached = (): boolean => pick.activeItems[0]?.label.endsWith(` ${name}`) ?? false;
  for (let step = 0; step < pick.items.length && !reached(); step++) {
    const moved = new Promise((resolve) => {
      const sub = pick.onDidChangeActive(() => {
        sub.dispose();
        resolve(undefined);
      });
    });
    await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
    await moved;
  }
  assert.ok(reached(), `the picker must reach ${name}`);
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await until(
    () => labels(pick.items).includes(`$(check) ${name}`),
    `${name} must be ticked after it is picked`,
  );
}

suite("View Modes control", function () {
  this.timeout(30_000);

  test("one picker offers the view and the layout, with the current ones ticked", () => {
    assert.deepStrictEqual(labels(viewModeItems("delta", "flat")), [
      "View",
      "$(blank) Staging",
      "$(check) Delta",
      "$(blank) Review",
      "Layout",
      "$(blank) Tree",
      "$(check) Flat",
    ]);
  });

  test("the picker opens with the current view highlighted", async () => {
    await withPicker(controllerWith("review", "tree").controller, async ({ activeOnOpen }) => {
      assert.deepStrictEqual(activeOnOpen, ["$(check) Review"]);
    });
  });

  test("picking a view applies it and the picker stays open on that row", async () => {
    const { controller, saved, fired } = controllerWith("staging", "tree");

    await withPicker(controller, async ({ pick, hidden }) => {
      await accept(pick, "Review");

      assert.deepStrictEqual(saved, { mode: "review" });
      assert.strictEqual(fired(), 1);
      assert.strictEqual(hidden(), false, "the picker must stay open after a pick");
      assert.deepStrictEqual(labels(pick.activeItems), ["$(check) Review"]);
    });
  });

  test("a view and a layout can both be picked in one go", async () => {
    const { controller, saved } = controllerWith("staging", "tree");

    await withPicker(controller, async ({ pick }) => {
      await accept(pick, "Delta");
      await accept(pick, "Flat");

      assert.deepStrictEqual(saved, { mode: "delta", layout: "flat" });
      assert.deepStrictEqual(labels(pick.items), [
        "View",
        "$(blank) Staging",
        "$(check) Delta",
        "$(blank) Review",
        "Layout",
        "$(blank) Tree",
        "$(check) Flat",
      ]);
    });
  });

  test("dismissing the picker changes nothing", async () => {
    const { controller, saved, fired } = controllerWith("delta", "tree");

    await withPicker(controller, async ({ pick, hidden }) => {
      pick.hide();
      await until(hidden, "the picker must close");
    });

    assert.deepStrictEqual(saved, {});
    assert.strictEqual(fired(), 0);
  });
});
