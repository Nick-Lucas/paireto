// Guided review: the pure plan model. `parseChangesets` is the only boundary between agent output
// and the tree, so the sanitization rules are pinned here; `buildGuidedState` is pinned against a
// synthetic Changes model so layer moves, renames, missing paths and the unclaimed bucket are
// covered without a git repository.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { DiffService, type ChangesModel, type FileSides } from "../git/DiffService.js";

import { GateCoordinator, type GateEntry, type GateKind } from "../gate/GateCoordinator.js";
import {
  changesetDocUri,
  changesetIdFromDocUri,
  PLAN_DOC_ID,
  renderChangesetDoc,
  renderPlanDoc,
} from "../review/ChangesetDocProvider.js";
import {
  changesetFileItem,
  changesetFileNodes,
  changesetContextValue,
  changesetItem,
  guidedDescription,
  reviewCommentItem,
} from "../views/MainTreeProvider.js";
import {
  buildGuidedState,
  normalizePath,
  OTHER_CHANGESET_ID,
  parseCompareTo,
  parseChangesets,
  toGuidedPlan,
  verifyGuidedCompareTo,
  type GuidedChangesetState,
  type GuidedPlan,
  type GuidedReviewState,
  type ParsedChangeset,
} from "../review/guidedPlan.js";
import type { RepoChangedFile, RepositoryReviewState } from "../review/ReviewController.js";
import {
  compareToForRepo,
  plannedBaseComparison,
  selectCommentFile,
  sharedCompareToHolds,
} from "../review/ReviewController.js";
import type { ReviewComment } from "../review/reviewTypes.js";
import { ChangesetIdArg, FileArg, readArg, withArg } from "../review/commandArgs.js";
import type { CompareTo, FileGroup } from "../types.js";

const REPO = "/repo";

function changed(path: string, group: FileGroup, oldPath?: string): RepoChangedFile {
  return {
    path,
    oldPath,
    status: oldPath ? "R" : "M",
    group,
    additions: 1,
    deletions: 0,
    repoRoot: REPO,
  };
}

function repository(files: RepoChangedFile[]): RepositoryReviewState {
  return {
    repoRoot: REPO,
    displayName: "repo",
    changes: {
      staged: files.filter((f) => f.group === "staged"),
      unstaged: files.filter((f) => f.group === "unstaged"),
      committed: files.filter((f) => f.group === "committed"),
      compareLabel: "HEAD",
      compareRef: null,
    },
  };
}

/** What ReviewController stores per repository: the same model, with every file root-qualified. */
function scoped(repoRoot: string, changes: ChangesModel): RepositoryReviewState["changes"] {
  const qualify = (files: ChangesModel["staged"]): RepoChangedFile[] =>
    files.map((file) => ({ ...file, repoRoot }));
  return {
    ...changes,
    staged: qualify(changes.staged),
    unstaged: qualify(changes.unstaged),
    committed: qualify(changes.committed),
  };
}

/** The production resolver, so these tests exercise the same layer/rename preference the UI does. */
const resolve = (repo: RepositoryReviewState, path: string): RepoChangedFile | undefined =>
  selectCommentFile(repo.changes, path) as RepoChangedFile | undefined;

function plan(changesets: ParsedChangeset[]): GuidedPlan {
  return toGuidedPlan(REPO, changesets, {});
}

/** Resolve a raw agent payload against a synthetic repository, the way the sidebar does. */
function guidedFor(files: RepoChangedFile[], raw: unknown): ReturnType<typeof buildGuidedState> {
  return buildGuidedState(plan(parseChangesets(raw)), [repository(files)], resolve);
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

suite("guided review — parseChangesets", () => {
  test("mints ids from submission order and keeps the agent's file order", () => {
    const parsed = parseChangesets([
      { title: "Auth", description: "login", files: [{ path: "z.ts" }, { path: "a.ts" }] },
      { title: "UI", description: "buttons", files: [{ path: "b.ts" }] },
    ]);
    assert.deepStrictEqual(
      parsed?.map((c) => c.id),
      ["cs0", "cs1"],
    );
    assert.deepStrictEqual(
      parsed?.[0].files.map((f) => f.path),
      ["z.ts", "a.ts"],
    );
  });

  test("accepts a bare string file entry alongside the object form", () => {
    const parsed = parseChangesets([
      { title: "T", description: "d", files: ["a.ts", { path: "b.ts" }] },
    ]);
    assert.deepStrictEqual(
      parsed?.[0].files.map((f) => f.path),
      ["a.ts", "b.ts"],
    );
  });

  // A plan that quietly lost a changeset would be reviewed as if it were complete, so every one of
  // these goes back to the agent naming the entry that was wrong.
  test("rejects a changeset with no title, no files, or a path outside the repository", () => {
    const rejected: Array<[unknown, string]> = [
      [[{ title: "   ", description: "d", files: [{ path: "a.ts" }] }], "changesets[0].title"],
      [[{ title: "Empty", description: "d", files: [] }], "changesets[0].files"],
      // The description IS the guided review — a changeset without one groups files and explains
      // nothing, so the reviewer is left to work out why they belong together. Only `description`
      // carries it: a model that puts the text under another name is told to move it.
      [
        [{ title: "Silent", description: "  ", files: [{ path: "a.ts" }] }],
        "changesets[0].description",
      ],
      [[{ title: "Silent", files: [{ path: "a.ts" }] }], "changesets[0].description"],
      [
        [{ title: "Silent", summary: "under the wrong name", files: [{ path: "a.ts" }] }],
        "changesets[0].description",
      ],
      [[{ title: "Abs", description: "d", files: [{ path: "/abs.ts" }] }], "changesets[0].files[0]"],
      [[{ title: "Up", description: "d", files: [{ path: "../up.ts" }] }], "changesets[0].files[0]"],
      [["not an object"], "changesets[0]"],
    ];
    for (const [payload, where] of rejected) {
      assert.throws(() => parseChangesets(payload), new RegExp(escapeRegExp(where)), where);
    }
  });

  test("dedupes paths within a changeset, keeping first-seen order", () => {
    const parsed = parseChangesets([
      {
        title: "T",
        description: "d",
        files: [{ path: "a.ts" }, { path: "./a.ts" }, { path: "b.ts" }],
      },
    ]);
    assert.deepStrictEqual(
      parsed?.[0].files.map((f) => f.path),
      ["a.ts", "b.ts"],
    );
  });

  test("caps counts and text lengths", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      title: `T${i}`,
      description: "d",
      files: [{ path: `f${i}.ts` }],
    }));
    assert.strictEqual(parseChangesets(many)?.length, 40);

    const wide = parseChangesets([
      {
        title: "x".repeat(500),
        description: "y".repeat(5000),
        files: Array.from({ length: 250 }, (_, i) => ({ path: `f${i}.ts` })),
      },
    ]);
    assert.strictEqual(wide?.[0].title.length, 200);
    assert.strictEqual(wide?.[0].description.length, 4000);
    assert.strictEqual(wide?.[0].files.length, 200);
  });

  test("rejects a payload that is not a non-empty list of changesets", () => {
    for (const bad of [undefined, "nope", []]) {
      assert.throws(() => parseChangesets(bad), /changesets/, JSON.stringify(bad) ?? "undefined");
    }
  });
});

suite("guided review — parseCompareTo", () => {
  test("accepts every Compare To kind the window understands", () => {
    assert.deepStrictEqual(parseCompareTo({ kind: "head" }), { kind: "head" });
    assert.deepStrictEqual(parseCompareTo({ kind: "mergeBase" }), { kind: "mergeBase" });
    assert.deepStrictEqual(parseCompareTo({ kind: "default" }), { kind: "default" });
    assert.deepStrictEqual(parseCompareTo({ kind: "ref", ref: "v1.2" }), {
      kind: "ref",
      ref: "v1.2",
    });
  });

  test("an omitted comparison means HEAD; a bad one is the agent's to fix", () => {
    assert.deepStrictEqual(parseCompareTo(undefined), { kind: "head" });
    for (const bad of ["head", { kind: "branch" }, { kind: "ref" }, { kind: "ref", ref: "  " }]) {
      assert.throws(() => parseCompareTo(bad), /compareTo/, JSON.stringify(bad));
    }
  });

  test("a plan carries the comparison it was built against", () => {
    const built = toGuidedPlan(REPO, [], { compareTo: { kind: "mergeBase" } });
    assert.deepStrictEqual(built.compareTo, { kind: "mergeBase" });
  });

  // A ref only the agent believes in makes the committed group degrade to empty, so the review would
  // open without the very changes the plan grouped — and they cannot even surface as "Other changes".
  test("a ref the repository cannot resolve is the agent's to fix", async () => {
    const built = toGuidedPlan(REPO, [], { compareTo: { kind: "ref", ref: "no-such-branch" } });
    const rejection = await verifyGuidedCompareTo(built, async () => false);
    assert.match(rejection ?? "", /no-such-branch/);
  });

  test("a resolvable ref, and every computed kind, is accepted", async () => {
    const resolvable = toGuidedPlan(REPO, [], { compareTo: { kind: "ref", ref: "v1.2" } });
    assert.strictEqual(await verifyGuidedCompareTo(resolvable, async () => true), undefined);
    for (const kind of ["head", "default", "mergeBase"] as const) {
      const built = toGuidedPlan(REPO, [], { compareTo: { kind } });
      const rejection = await verifyGuidedCompareTo(built, async () => {
        throw new Error("a computed comparison point is never checked as a ref");
      });
      assert.strictEqual(rejection, undefined, kind);
    }
  });
});

// The window's Compare To is shared by every Git root, and a multi-root window cannot hold a raw ref
// at all. The plan's own comparison therefore stays scoped to the repository it describes, so the
// files it named resolve against what the agent actually diffed.
suite("guided review — comparison point per repository", () => {
  const shared: CompareTo = { kind: "default" };
  const guided = { repoRoot: REPO, compareTo: { kind: "ref", ref: "v1.2" } as CompareTo };

  test("the plan's repository uses the plan's comparison", () => {
    assert.deepStrictEqual(compareToForRepo(shared, guided, REPO), guided.compareTo);
  });

  test("every other repository keeps the window's shared comparison", () => {
    assert.deepStrictEqual(compareToForRepo(shared, guided, "/other"), shared);
  });

  test("with no plan open every repository uses the shared comparison", () => {
    assert.deepStrictEqual(compareToForRepo(shared, undefined, REPO), shared);
  });

  test("a lone root shares every comparison point; several roots cannot share a ref", () => {
    for (const kind of ["head", "default", "mergeBase"] as const) {
      assert.strictEqual(sharedCompareToHolds(3, { kind }), true, kind);
    }
    assert.strictEqual(sharedCompareToHolds(1, guided.compareTo), true);
    assert.strictEqual(sharedCompareToHolds(2, guided.compareTo), false);
  });
});

// A planned row is a reading instruction, so it has to show everything that changed in that file
// since the plan's comparison point — not only the topmost git layer the file happens to sit in.
suite("guided review — a planned row opens against the plan's comparison point", () => {
  const diff = new DiffService();
  const changes = { compareRef: "abc123", compareLabel: "main" };
  const sidesFor = (file: Partial<RepoChangedFile>): FileSides =>
    diff.fileSides({ ...changed("a.ts", "unstaged"), ...file }, changes.compareRef);

  test("a partly staged file is pinned to the comparison point, not to the index", () => {
    const natural = sidesFor({ group: "unstaged" });
    assert.deepStrictEqual(natural.base, { kind: "index" }, "the staged hunks are below this base");
    assert.deepStrictEqual(plannedBaseComparison(natural, changes), {
      ref: { kind: "ref", ref: "abc123" },
      label: "main",
    });
  });

  test("comparing against HEAD pins the row to HEAD", () => {
    const head = { compareRef: null, compareLabel: "HEAD" };
    assert.deepStrictEqual(
      plannedBaseComparison(diff.fileSides(changed("a.ts", "unstaged"), null), head),
      {
        ref: { kind: "ref", ref: "HEAD" },
        label: "HEAD",
      },
    );
  });

  test("an add or a delete keeps its natural single pane", () => {
    // Neither has content on both sides, so there is nothing to pin a comparison point to.
    assert.strictEqual(plannedBaseComparison(sidesFor({ status: "U" }), changes), undefined);
    assert.strictEqual(plannedBaseComparison(sidesFor({ status: "A" }), changes), undefined);
    assert.strictEqual(plannedBaseComparison(sidesFor({ status: "D" }), changes), undefined);
  });
});

suite("guided review — feedback rows", () => {
  const comment = (over: Partial<ReviewComment>): ReviewComment => ({
    id: "c1",
    repoRoot: REPO,
    filePath: "src/a.ts",
    side: "modified",
    line: 3,
    kind: "comment",
    body: "split this up",
    quote: "> why",
    anchor: { lineText: "", contextBefore: [], contextAfter: [], lineHash: "" },
    ...over,
  });

  test("a changeset comment is named by its changeset, not by an empty file path", () => {
    const item = reviewCommentItem(
      comment({ filePath: "", changeset: { id: "cs0", title: "Auth" } }),
    );
    assert.strictEqual(item.label, "Auth");
    assert.ok(String(item.description).includes("split this up"));
    assert.ok(
      String((item.tooltip as vscode.MarkdownString).value).includes("Auth"),
      "the tooltip names the changeset rather than the repository root",
    );
  });

  test("a file comment still shows its path and line", () => {
    const item = reviewCommentItem(comment({}));
    assert.strictEqual(item.label, "a.ts:4");
    assert.ok(String(item.description).includes("src"));
  });
});

suite("guided review — normalizePath", () => {
  test("normalizes separators and strips redundant segments", () => {
    assert.strictEqual(normalizePath("./src\\a.ts"), "src/a.ts");
    assert.strictEqual(normalizePath("src//./a.ts"), "src/a.ts");
    assert.strictEqual(normalizePath("  src/a.ts  "), "src/a.ts");
  });

  test("rejects absolute paths and anything climbing out of the repository", () => {
    for (const bad of ["/etc/passwd", "C:/win.ts", "../up.ts", "src/../../up.ts", "", "   ", "."]) {
      assert.strictEqual(normalizePath(bad), undefined, bad);
    }
  });
});

suite("guided review — buildGuidedState", () => {
  test("resolves each named path against the live model and counts progress", () => {
    const files = [changed("a.ts", "unstaged"), changed("b.ts", "staged")];
    const parsed = parseChangesets([
      { title: "One", description: "d", files: [{ path: "a.ts" }, { path: "b.ts" }] },
    ]);
    const state = buildGuidedState(plan(parsed), [repository(files)], resolve);
    assert.strictEqual(state.fileTotal, 2);
    assert.strictEqual(state.missingTotal, 0);
    assert.deepStrictEqual(
      state.changesets[0].files.map((r) => r.file?.group),
      ["unstaged", "staged"],
    );
    // One file in each layer, so the row can offer both bulk actions.
    assert.strictEqual(state.changesets[0].stageableCount, 1);
    assert.strictEqual(state.changesets[0].unstageableCount, 1);
  });

  test("follows a rename through the old path", () => {
    const parsed = parseChangesets([{ title: "T", description: "d", files: [{ path: "old.ts" }] }]);
    const state = buildGuidedState(
      plan(parsed),
      [repository([changed("new.ts", "unstaged", "old.ts")])],
      resolve,
    );
    assert.strictEqual(state.changesets[0].files[0].file?.path, "new.ts");
  });

  test("keeps a path with no live change as an explicit missing row", () => {
    const parsed = parseChangesets([
      { title: "T", description: "d", files: [{ path: "gone.ts" }] },
    ]);
    const state = buildGuidedState(plan(parsed), [repository([])], resolve);
    assert.strictEqual(state.changesets[0].files.length, 1);
    assert.strictEqual(state.changesets[0].files[0].file, undefined);
    assert.strictEqual(state.missingTotal, 1);
  });

  test("a file named by two changesets appears under both", () => {
    const parsed = parseChangesets([
      { title: "One", description: "d", files: [{ path: "shared.ts" }] },
      { title: "Two", description: "d", files: [{ path: "shared.ts" }] },
    ]);
    const state = buildGuidedState(
      plan(parsed),
      [repository([changed("shared.ts", "unstaged")])],
      resolve,
    );
    assert.strictEqual(state.changesets[0].files[0].file?.path, "shared.ts");
    assert.strictEqual(state.changesets[1].files[0].file?.path, "shared.ts");
    assert.strictEqual(state.changesets.length, 2, "nothing is left unclaimed");
  });

  test("collects live files no changeset named, deduped across layers", () => {
    const files = [
      changed("claimed.ts", "unstaged"),
      changed("other.ts", "unstaged"),
      changed("other.ts", "staged"),
      changed("more.ts", "committed"),
    ];
    const parsed = parseChangesets([
      { title: "T", description: "d", files: [{ path: "claimed.ts" }] },
    ]);
    const state = buildGuidedState(plan(parsed), [repository(files)], resolve);
    const other = state.changesets.at(-1);
    assert.strictEqual(other?.id, OTHER_CHANGESET_ID);
    assert.deepStrictEqual(
      other.files.map((f) => f.path),
      ["more.ts", "other.ts"],
    );
    // The bucket counts towards the section total like any other changeset.
    assert.strictEqual(state.fileTotal, 3);
  });

  test("a plan for a repository no longer in the window resolves to all-missing", () => {
    const parsed = parseChangesets([{ title: "T", description: "d", files: [{ path: "a.ts" }] }]);
    const state = buildGuidedState(plan(parsed), [], resolve);
    assert.strictEqual(state.missingTotal, 1);
    assert.strictEqual(state.changesets.length, 1, "no repository means nothing to collect");
  });
});

suite("guided review — sidebar rows", () => {
  test("a changeset renders its files in the agent's submitted order", () => {
    const state = guidedFor(
      [changed("zebra.ts", "unstaged"), changed("apple.ts", "unstaged")],
      [{ title: "T", description: "d", files: [{ path: "zebra.ts" }, { path: "apple.ts" }] }],
    );
    const nodes = changesetFileNodes(REPO, state.changesets[0]);
    assert.deepStrictEqual(
      nodes.map((n) => (n as { row: { path: string } }).row.path),
      ["zebra.ts", "apple.ts"],
      "submitted order must survive — any alphabetical sort silently destroys the reading order",
    );
  });

  test("a changeset row is titled, counted, repo-scoped, and opens its description", () => {
    const state = guidedFor(
      [changed("a.ts", "unstaged")],
      [{ title: "Auth", description: "why", files: [{ path: "a.ts" }] }],
    );
    const item = changesetItem(REPO, state.changesets[0]);
    assert.strictEqual(item.label, "Auth");
    assert.strictEqual(item.description, "1 file");
    assert.strictEqual(item.command?.command, "paireto.guidedReview.openChangeset");
    assert.ok(item.id?.startsWith("changeset:"));
    assert.ok(item.id?.endsWith(":cs0"));
  });

  test("a changeset offers only the bulk action that would do work", () => {
    const of = (files: RepoChangedFile[], paths: string[]): string =>
      changesetContextValue(
        guidedFor(files, [{ title: "T", description: "d", files: paths.map((path) => ({ path })) }])
          .changesets[0],
      );
    assert.strictEqual(of([changed("a.ts", "unstaged")], ["a.ts"]), "changeset:stage");
    assert.strictEqual(of([changed("a.ts", "staged")], ["a.ts"]), "changeset:unstage");
    assert.strictEqual(
      of([changed("a.ts", "unstaged"), changed("b.ts", "staged")], ["a.ts", "b.ts"]),
      "changeset:both",
    );
    // Committed changes cannot be staged or unstaged, so neither action is offered.
    assert.strictEqual(of([changed("a.ts", "committed")], ["a.ts"]), "changeset");
  });

  test("a file in two changesets gets distinct row ids, so VS Code accepts both rows", () => {
    const state = guidedFor(
      [changed("shared.ts", "unstaged")],
      [
        { title: "One", description: "d", files: [{ path: "shared.ts" }] },
        { title: "Two", description: "d", files: [{ path: "shared.ts" }] },
      ],
    );
    const uri = vscode.Uri.file("/ext");
    const first = changesetFileItem(REPO, state.changesets[0].files[0], uri);
    const second = changesetFileItem(REPO, state.changesets[1].files[0], uri);
    assert.notStrictEqual(first.id, second.id);
    assert.strictEqual(first.contextValue, "changedFile:unstaged:planned");
  });

  test("a planned file row shows which git layer it sits in", () => {
    const uri = vscode.Uri.file("/ext");
    const iconOf = (group: FileGroup): vscode.TreeItem["iconPath"] => {
      const state = guidedFor(
        [changed("a.ts", group)],
        [{ title: "T", description: "d", files: [{ path: "a.ts" }] }],
      );
      return changesetFileItem(REPO, state.changesets[0].files[0], uri).iconPath;
    };
    // Committed gets the commit glyph; the other two keep the status letter, muted once staged.
    assert.ok(iconOf("committed") instanceof vscode.ThemeIcon);
    const unstaged = iconOf("unstaged") as { light: vscode.Uri };
    const staged = iconOf("staged") as { light: vscode.Uri };
    assert.ok(unstaged.light.path.endsWith("/m-light.svg"), unstaged.light.path);
    assert.ok(staged.light.path.endsWith("/m-staged-light.svg"), staged.light.path);
  });

  test("a planned file with no live change renders as an explicit missing row", () => {
    const state = guidedFor([], [{ title: "T", description: "d", files: [{ path: "gone.ts" }] }]);
    const item = changesetFileItem(REPO, state.changesets[0].files[0], vscode.Uri.file("/ext"));
    assert.strictEqual(item.description, "no longer in the changes");
    assert.strictEqual(item.contextValue, "changesetFile:missing");
    assert.strictEqual(item.command, undefined, "a missing row has nothing to open");
  });

  test("the section description sizes the plan and flags unresolved paths", () => {
    const resolved = guidedFor(
      [changed("a.ts", "unstaged")],
      [{ title: "T", description: "d", files: [{ path: "a.ts" }] }],
    );
    assert.strictEqual(guidedDescription(resolved), "1 changeset · 1 file");

    const partly = guidedFor(
      [changed("a.ts", "unstaged")],
      [{ title: "T", description: "d", files: [{ path: "a.ts" }, { path: "gone.ts" }] }],
    );
    assert.strictEqual(
      guidedDescription(partly),
      "1 changeset · 2 files · 1 not in the current comparison",
    );
  });

  test("unclaimed changes render as a trailing Other changes row", () => {
    const state = guidedFor(
      [changed("named.ts", "unstaged"), changed("stray.ts", "unstaged")],
      [{ title: "T", description: "d", files: [{ path: "named.ts" }] }],
    );
    const other = state.changesets.at(-1);
    assert.strictEqual(other?.title, "Other changes");
    assert.deepStrictEqual(
      other.files.map((f) => f.path),
      ["stray.ts"],
    );
    // The bucket behaves like any other changeset, bulk actions included.
    assert.strictEqual(changesetItem(REPO, other).contextValue, "changeset:stage");
  });
});

// A plan row must track the file's CURRENT git layer, not the one it had when the plan arrived:
// editing a committed file has to give that row the working-tree actions, and undoing the edit has
// to give it back its committed state. Driven against a real repository through the real
// DiffService, because the layer transitions are git's, not ours.
suite("guided review — a planned row follows the file through the layers", () => {
  const diff = new DiffService();
  let repo: string;
  let baseRef: string;
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo }).toString().trim();
  const write = (content: string): void =>
    fs.writeFileSync(path.join(repo, "a.ts"), content);

  suiteSetup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-guided-"));
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    write("v1\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    baseRef = git(["rev-parse", "HEAD"]);
    write("v2\n");
    git(["commit", "-q", "-am", "change a"]);
  });

  suiteTeardown(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  /** The plan row for a.ts as the sidebar would render it right now. */
  const rowNow = async (): Promise<vscode.TreeItem> => {
    const changes = await diff.getChanges(repo, { kind: "ref", ref: baseRef });
    const state = buildGuidedState(
      toGuidedPlan(repo, parseChangesets([{ title: "T", description: "d", files: ["a.ts"] }]), {
        compareTo: { kind: "ref", ref: baseRef },
      }),
      [{ repoRoot: repo, displayName: "repo", changes: scoped(repo, changes) }],
      resolve,
    );
    return changesetFileItem(repo, state.changesets[0].files[0], vscode.Uri.file("/ext"));
  };

  test("committed, then edited, then staged, then restored", async () => {
    assert.strictEqual(
      (await rowNow()).contextValue,
      "changedFile:committed:planned",
      "starts as a committed change against the compare point",
    );

    write("v3\n");
    assert.strictEqual(
      (await rowNow()).contextValue,
      "changedFile:unstaged:planned",
      "an edit gives the row the working-tree actions",
    );

    git(["add", "a.ts"]);
    assert.strictEqual(
      (await rowNow()).contextValue,
      "changedFile:staged:planned",
      "staging moves the row to the index",
    );

    git(["restore", "--staged", "a.ts"]);
    write("v2\n");
    assert.strictEqual(
      (await rowNow()).contextValue,
      "changedFile:committed:planned",
      "undoing the edit returns the row to the committed comparison",
    );
  });
});

suite("guided review — command arguments", () => {
  // VS Code hands an inline view/item/context button the tree NODE. A node shape the unwrapper does
  // not understand makes the button silently do nothing, so pin the exact nodes the tree produces.
  const rowNode = (raw: unknown, files: RepoChangedFile[]): unknown => {
    const state = buildGuidedState(plan(parseChangesets(raw)), [repository(files)], resolve);
    return changesetFileNodes(REPO, state.changesets[0])[0];
  };

  test("a planned file row resolves to its changed file, so the git actions act on it", () => {
    const node = rowNode(
      [{ title: "T", description: "d", files: [{ path: "a.ts" }] }],
      [changed("a.ts", "unstaged")],
    );
    const file = readArg(FileArg, node);
    assert.strictEqual(file?.path, "a.ts");
    assert.strictEqual(file?.group, "unstaged");
    assert.strictEqual(file?.repoRoot, REPO);
  });

  test("a planned row with no live change resolves to nothing — there is nothing to stage", () => {
    const node = rowNode([{ title: "T", description: "d", files: [{ path: "gone.ts" }] }], []);
    assert.strictEqual(readArg(FileArg, node), undefined);
  });

  test("a file row never resolves to its whole changeset", () => {
    const node = rowNode(
      [{ title: "T", description: "d", files: [{ path: "a.ts" }, { path: "b.ts" }] }],
      [changed("a.ts", "unstaged"), changed("b.ts", "unstaged")],
    );
    assert.strictEqual(readArg(ChangesetIdArg, node), undefined);
  });

  test("a changeset row resolves to its id, from the node or a plain payload", () => {
    assert.strictEqual(
      readArg(ChangesetIdArg, { kind: "changeset", repoRoot: REPO, changeset: { id: "cs0" } }),
      "cs0",
    );
    assert.strictEqual(readArg(ChangesetIdArg, { changesetId: "cs1" }), "cs1");
    assert.strictEqual(readArg(ChangesetIdArg, { kind: "file" }), undefined);
  });

  test("withArg hands the handler a parsed value, and refuses an argument it cannot read", () => {
    const seen: string[] = [];
    const run = withArg(ChangesetIdArg, (id) => seen.push(id));

    run({ kind: "changeset", changeset: { id: "cs0" } });
    assert.deepStrictEqual(seen, ["cs0"]);

    // A wired-up-wrong menu must be loud: silently doing nothing is the hardest version to find.
    assert.throws(() => run({ kind: "file" }), /command argument rejected/);
    assert.deepStrictEqual(seen, ["cs0"], "the handler never ran on a rejected argument");
  });

  // The schemas name only the fields a command reads, so a node that grows one keeps working — while
  // anything that isn't one of the known shapes resolves to nothing rather than a half-built file.
  test("extra fields are tolerated; an unknown shape resolves to nothing", () => {
    const file = { ...changed("a.ts", "unstaged"), decoration: { badge: "M" } };
    assert.strictEqual(readArg(FileArg, file)?.path, "a.ts");
    assert.strictEqual(readArg(FileArg, { file, kind: "file", label: "a.ts" })?.group, "unstaged");

    for (const bad of [undefined, null, "a.ts", 7, {}, { file: { path: "a.ts" } }]) {
      assert.strictEqual(readArg(FileArg, bad), undefined, JSON.stringify(bad) ?? "undefined");
    }
  });
});

suite("guided review — changeset description document", () => {
  const changeset = (title: string): GuidedChangesetState =>
    guidedFor(
      [changed("a.ts", "unstaged")],
      [{ title, description: "why it exists", files: [{ path: "a.ts" }] }],
    ).changesets[0];

  test("the URI is titled for the tab and keyed by changeset id", () => {
    const uri = changesetDocUri({ id: "cs0", title: "Auth" });
    assert.strictEqual(uri.scheme, "paireto-changeset");
    assert.strictEqual(uri.path, "/Auth.md");
    assert.strictEqual(changesetIdFromDocUri(uri), "cs0");
  });

  test("a title with a slash cannot invent a path segment", () => {
    const uri = changesetDocUri({ id: "cs1", title: "auth/login" });
    assert.strictEqual(uri.path, "/auth-login.md");
    assert.strictEqual(changesetIdFromDocUri(uri), "cs1");
  });

  test("a non-changeset URI resolves to no changeset", () => {
    assert.strictEqual(changesetIdFromDocUri(vscode.Uri.file("/repo/a.ts")), undefined);
  });

  test("the markdown carries the title, description, and files in reading order", () => {
    const doc = renderChangesetDoc(changeset("Auth"));
    assert.ok(doc.startsWith("# Auth"));
    assert.ok(doc.includes("why it exists"));
    assert.ok(doc.includes("1. `a.ts`"));
  });

  // The boundary rejects a description-less plan, so this is the renderer's own last line of defence
  // — built directly, because no payload can reach it through `parseChangesets`.
  test("a changeset with no description still renders", () => {
    const bare: GuidedChangesetState = {
      ...changeset("Bare"),
      description: "",
    };
    assert.ok(renderChangesetDoc(bare).includes("no description"));
  });
});

suite("guided review — plan overview document", () => {
  const guided = (summary?: string): GuidedReviewState =>
    buildGuidedState(
      toGuidedPlan(
        REPO,
        parseChangesets([
          { title: "Auth", description: "d", files: ["a.ts"] },
          { title: "UI", description: "d", files: ["b.ts"] },
        ]),
        { summary, compareTo: { kind: "mergeBase" } },
      ),
      [repository([changed("a.ts", "unstaged"), changed("b.ts", "unstaged")])],
      resolve,
    );

  test("the plan document is keyed apart from every changeset", () => {
    const uri = changesetDocUri({ id: PLAN_DOC_ID, title: "Review plan" });
    assert.strictEqual(changesetIdFromDocUri(uri), PLAN_DOC_ID);
    assert.ok(
      !guided("s").changesets.some((c) => c.id === PLAN_DOC_ID),
      "no changeset can claim the plan's own id",
    );
  });

  test("it carries the summary, the comparison point, and every changeset", () => {
    const doc = renderPlanDoc(guided("This branch adds guided review."));
    assert.ok(doc.startsWith("# Review plan"));
    assert.ok(doc.includes("This branch adds guided review."));
    assert.ok(doc.includes("merge base"));
    assert.ok(doc.includes("**Auth**"));
    assert.ok(doc.includes("**UI**"));
  });

  test("a plan with no summary still renders", () => {
    assert.ok(renderPlanDoc(guided()).includes("no summary"));
  });
});

suite("guided review — gate panel policy", () => {
  const makeEntry = (id: string, kind: GateKind): GateEntry => ({
    id,
    sessionId: id,
    kind,
    repoRoot: REPO,
    session: { kind, approve() {}, sendFeedback() {}, hasFeedback: () => false },
    foreground: () => {},
    background: () => {},
  });

  test("a guided review hides the terminal like every other gate", async () => {
    const panel: string[] = [];
    const coordinator = new GateCoordinator(
      async () => {
        panel.push("hide");
      },
      async () => {
        panel.push("show");
      },
    );
    await coordinator.register(makeEntry("g", "guided"));
    assert.deepStrictEqual(panel, ["hide"]);
    await coordinator.unregister("g");
    assert.deepStrictEqual(panel, ["hide", "show"]);
  });
});
