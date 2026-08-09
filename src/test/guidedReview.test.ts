// Guided review: the pure plan model. `parseChangesets` is the only boundary between agent output
// and the tree, so the sanitization rules are pinned here; `buildGuidedState` is pinned against a
// synthetic Changes model so layer moves, renames, missing paths and the unclaimed bucket are
// covered without a git repository.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { GateCoordinator, type GateEntry, type GateKind } from "../gate/GateCoordinator.js";
import {
  changesetDocUri,
  changesetIdFromDocUri,
  renderChangesetDoc,
} from "../review/ChangesetDocProvider.js";
import {
  changesetFileItem,
  changesetFileNodes,
  changesetContextValue,
  changesetItem,
  guidedDescription,
} from "../views/MainTreeProvider.js";
import {
  buildGuidedState,
  normalizePath,
  OTHER_CHANGESET_ID,
  parseCompareTo,
  parseChangesets,
  toGuidedPlan,
  type GuidedChangesetState,
  type GuidedPlan,
  type ParsedChangeset,
} from "../review/guidedPlan.js";
import type { RepoChangedFile, RepositoryReviewState } from "../review/ReviewController.js";
import { asFile, changesetIdFromArg, selectCommentFile } from "../review/ReviewController.js";
import type { FileGroup } from "../types.js";

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

/** The production resolver, so these tests exercise the same layer/rename preference the UI does. */
const resolve = (repo: RepositoryReviewState, path: string): RepoChangedFile | undefined =>
  selectCommentFile(repo.changes, path) as RepoChangedFile | undefined;

function plan(changesets: ParsedChangeset[]): GuidedPlan {
  return toGuidedPlan(REPO, changesets, {});
}

/** Resolve a raw agent payload against a synthetic repository, the way the sidebar does. */
function guidedFor(files: RepoChangedFile[], raw: unknown): ReturnType<typeof buildGuidedState> {
  return buildGuidedState(plan(parseChangesets(raw) ?? []), [repository(files)], resolve);
}

suite("guided review — parseChangesets", () => {
  test("mints ids from submission order and keeps the agent's file order", () => {
    const parsed = parseChangesets([
      { title: "Auth", description: "login", files: [{ path: "z.ts" }, { path: "a.ts" }] },
      { title: "UI", description: "", files: [{ path: "b.ts", note: "why" }] },
    ]);
    assert.deepStrictEqual(
      parsed?.map((c) => c.id),
      ["cs0", "cs1"],
    );
    assert.deepStrictEqual(
      parsed?.[0].files.map((f) => f.path),
      ["z.ts", "a.ts"],
    );
    assert.strictEqual(parsed?.[1].files[0].note, "why");
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

  test("drops changesets with no title or no usable files", () => {
    const parsed = parseChangesets([
      { title: "   ", description: "d", files: [{ path: "a.ts" }] },
      { title: "Kept", description: "d", files: [{ path: "a.ts" }] },
      { title: "Empty", description: "d", files: [] },
      { title: "AllBad", description: "d", files: [{ path: "/abs.ts" }, { path: "../up.ts" }] },
      "not an object",
    ]);
    assert.deepStrictEqual(
      parsed?.map((c) => c.title),
      ["Kept"],
    );
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
        files: Array.from({ length: 250 }, (_, i) => ({ path: `f${i}.ts`, note: "n".repeat(400) })),
      },
    ]);
    assert.strictEqual(wide?.[0].title.length, 200);
    assert.strictEqual(wide?.[0].description.length, 4000);
    assert.strictEqual(wide?.[0].files.length, 200);
    assert.strictEqual(wide?.[0].files[0].note?.length, 300);
  });

  test("returns undefined for a payload with nothing usable", () => {
    assert.strictEqual(parseChangesets(undefined), undefined);
    assert.strictEqual(parseChangesets("nope"), undefined);
    assert.strictEqual(parseChangesets([]), undefined);
    assert.strictEqual(parseChangesets([{ title: "T", description: "d", files: [] }]), undefined);
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

  test("falls back to HEAD for anything it cannot trust", () => {
    // HEAD shows the working state, which is never wrong — only narrower than the agent may have meant.
    for (const bad of [
      undefined,
      "head",
      { kind: "branch" },
      { kind: "ref" },
      { kind: "ref", ref: "  " },
    ]) {
      assert.deepStrictEqual(parseCompareTo(bad), { kind: "head" }, JSON.stringify(bad));
    }
  });

  test("a plan carries the comparison it was built against", () => {
    const built = toGuidedPlan(REPO, [], { compareTo: { kind: "mergeBase" } });
    assert.deepStrictEqual(built.compareTo, { kind: "mergeBase" });
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
    const state = buildGuidedState(plan(parsed ?? []), [repository(files)], resolve);
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
      plan(parsed ?? []),
      [repository([changed("new.ts", "unstaged", "old.ts")])],
      resolve,
    );
    assert.strictEqual(state.changesets[0].files[0].file?.path, "new.ts");
  });

  test("keeps a path with no live change as an explicit missing row", () => {
    const parsed = parseChangesets([
      { title: "T", description: "d", files: [{ path: "gone.ts" }] },
    ]);
    const state = buildGuidedState(plan(parsed ?? []), [repository([])], resolve);
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
      plan(parsed ?? []),
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
    const state = buildGuidedState(plan(parsed ?? []), [repository(files)], resolve);
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
    const state = buildGuidedState(plan(parsed ?? []), [], resolve);
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
    assert.strictEqual(item.command?.command, "paireto.guided.openChangeset");
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

suite("guided review — command arguments", () => {
  // VS Code hands an inline view/item/context button the tree NODE. A node shape the unwrapper does
  // not understand makes the button silently do nothing, so pin the exact nodes the tree produces.
  const rowNode = (raw: unknown, files: RepoChangedFile[]): unknown => {
    const state = buildGuidedState(plan(parseChangesets(raw) ?? []), [repository(files)], resolve);
    return changesetFileNodes(REPO, state.changesets[0])[0];
  };

  test("a planned file row resolves to its changed file, so the git actions act on it", () => {
    const node = rowNode(
      [{ title: "T", description: "d", files: [{ path: "a.ts" }] }],
      [changed("a.ts", "unstaged")],
    );
    const file = asFile(node);
    assert.strictEqual(file?.path, "a.ts");
    assert.strictEqual(file?.group, "unstaged");
    assert.strictEqual(file?.repoRoot, REPO);
  });

  test("a planned row with no live change resolves to nothing — there is nothing to stage", () => {
    const node = rowNode([{ title: "T", description: "d", files: [{ path: "gone.ts" }] }], []);
    assert.strictEqual(asFile(node), undefined);
  });

  test("a file row never resolves to its whole changeset", () => {
    const node = rowNode(
      [{ title: "T", description: "d", files: [{ path: "a.ts" }, { path: "b.ts" }] }],
      [changed("a.ts", "unstaged"), changed("b.ts", "unstaged")],
    );
    assert.strictEqual(changesetIdFromArg(node), undefined);
  });

  test("a changeset row resolves to its id, from the node or a plain payload", () => {
    assert.strictEqual(
      changesetIdFromArg({ kind: "changeset", repoRoot: REPO, changeset: { id: "cs0" } }),
      "cs0",
    );
    assert.strictEqual(changesetIdFromArg({ changesetId: "cs1" }), "cs1");
    assert.strictEqual(changesetIdFromArg({ kind: "file" }), undefined);
  });
});

suite("guided review — changeset description document", () => {
  const changeset = (title: string): GuidedChangesetState =>
    guidedFor(
      [changed("a.ts", "unstaged")],
      [{ title, description: "why it exists", files: [{ path: "a.ts", note: "the entry point" }] }],
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
    assert.ok(doc.includes("the entry point"));
  });

  test("a changeset with no description still renders", () => {
    const bare = guidedFor(
      [changed("a.ts", "unstaged")],
      [{ title: "Bare", description: "", files: [{ path: "a.ts" }] }],
    ).changesets[0];
    assert.ok(renderChangesetDoc(bare).includes("no description"));
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
