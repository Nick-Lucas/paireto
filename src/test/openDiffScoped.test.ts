// openDiff must never trigger the full multi-root scan (getChanges + currentBranch for EVERY git
// root, plus refreshAllOpen() re-firing every open review URI — each re-runs git show), which made
// opening a diff laggy in large projects. Instead it does a scoped per-file sync:
// DiffService.changesForPath re-checks just the one path against git, and syncFileForOpenDiff merges
// the result into the in-memory model so a file that moved layers or disappeared since the tree
// rendered is still handled correctly. The full ReviewController can't be constructed here (the
// activated extension already owns its command ids), so the sync's semantics are tested through its
// narrow seam — and the final suite drives the ACTIVATED extension's real openDiff command, pinning
// via the control plane's refresh counters that the call site really uses the scoped sync.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import type { InspectSnapshot } from "../e2e/inspectTypes.js";
import { DiffService, type ChangedFile } from "../git/DiffService.js";
import { canonicalize } from "../protocol/paths.js";
import {
  syncFileForOpenDiff,
  type OpenDiffSync,
  type RepoChangedFile,
  type RepositoryReviewState,
} from "../review/ReviewController.js";
import type { FileGroup } from "../types.js";

suite("DiffService.changesForPath (scoped per-file git check)", () => {
  const diff = new DiffService();
  let repo: string;
  let compareRef: string;
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo }).toString().trim();

  suiteSetup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-scoped-"));
    const write = (name: string, content: string): void =>
      fs.writeFileSync(path.join(repo, name), content);
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    const base = ["solo.txt", "other.txt", "moved.txt", "gone.txt", "hist.txt", "ren-old.txt"];
    for (const f of [...base, "crn-old.txt"]) {
      write(f, `${f} v1\n`);
    }
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    compareRef = git(["rev-parse", "HEAD"]);
    write("hist.txt", "hist v2\n");
    git(["add", "hist.txt"]);
    git(["mv", "crn-old.txt", "crn-new.txt"]);
    git(["commit", "-q", "-m", "second"]);
    // Working state: solo + other modified (unstaged), moved modified + staged, new untracked,
    // ren-old staged-renamed to ren-new with an untracked stub left at the old path, and the
    // committed crn rename with an unstaged edit at its new path + an untracked stub at its old one.
    write("solo.txt", "solo v2\n");
    write("other.txt", "other v2\n");
    write("moved.txt", "moved v2\n");
    git(["add", "moved.txt"]);
    write("new.txt", "one\ntwo\n");
    git(["mv", "ren-old.txt", "ren-new.txt"]);
    write("ren-old.txt", "stub\n");
    write("crn-new.txt", "crn v2\n");
    write("crn-old.txt", "stub\n");
  });

  suiteTeardown(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("reports only the requested path, at its current group", async () => {
    const fresh = await diff.changesForPath(repo, ["solo.txt"], null);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, group: f.group, status: f.status })),
      [{ path: "solo.txt", group: "unstaged", status: "M" }],
      "other.txt is also modified but must not be scanned/reported",
    );
  });

  test("sees a layer move that happened after the tree rendered", async () => {
    const fresh = await diff.changesForPath(repo, ["moved.txt"], null);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, group: f.group })),
      [{ path: "moved.txt", group: "staged" }],
    );
  });

  test("returns no entries for a change that no longer exists", async () => {
    assert.deepStrictEqual(await diff.changesForPath(repo, ["gone.txt"], null), []);
  });

  test("an untracked file reports as an unstaged add with line counts", async () => {
    const fresh = await diff.changesForPath(repo, ["new.txt"], null);
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].group, "unstaged");
    assert.strictEqual(fresh[0].status, "U");
    assert.strictEqual(fresh[0].additions, 2);
  });

  test("a staged rename queried by its old path reports the rename pair, never a phantom delete", async () => {
    // git pairs a rename only when BOTH sides are inside the pathspec — a scan scoped to just the
    // old path would degrade the R into a phantom `D ren-old.txt` the full scan never reports,
    // corrupting the merged model (Staged showing both a rename of the path and its deletion).
    const fresh = await diff.changesForPath(repo, ["ren-old.txt"], null);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, oldPath: f.oldPath, group: f.group, status: f.status })),
      [
        { path: "ren-new.txt", oldPath: "ren-old.txt", group: "staged", status: "R" },
        { path: "ren-old.txt", oldPath: undefined, group: "unstaged", status: "U" },
      ],
      "must match the full scan (rename + untracked stub), with no staged D",
    );
  });

  test("querying a rename's old path also reports other changes at its new path", async () => {
    // The merge treats the rename's other half as affected, so the scan must return EVERY entry
    // there — an unstaged edit at ren-new.txt missing from the scoped result would be dropped from
    // the merged model with no replacement.
    fs.writeFileSync(path.join(repo, "ren-new.txt"), "ren-new v2\n");
    const fresh = await diff.changesForPath(repo, ["ren-old.txt"], null);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, group: f.group, status: f.status })),
      [
        { path: "ren-new.txt", group: "staged", status: "R" },
        { path: "ren-new.txt", group: "unstaged", status: "M" },
        { path: "ren-old.txt", group: "unstaged", status: "U" },
      ],
    );
  });

  test("a committed rename remains when its new path has a Working Tree change", async () => {
    const fresh = await diff.changesForPath(repo, ["crn-old.txt"], compareRef);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, group: f.group, status: f.status })),
      [
        { path: "crn-new.txt", group: "unstaged", status: "M" },
        { path: "crn-old.txt", group: "unstaged", status: "U" },
        { path: "crn-new.txt", group: "committed", status: "R" },
      ],
    );
  });

  test("an untracked file whose name starts with ':' is still found by the scoped scan", async () => {
    // A raw leading-':' path is consumed as pathspec magic by ls-files (returns empty, exit 0), so
    // the scoped scan would miss the file the full scan reports and the merge would drop its row
    // with no replacement — the pathspec must use the `:(literal)` magic prefix.
    fs.writeFileSync(path.join(repo, ":colon.txt"), "one\n");
    const fresh = await diff.changesForPath(repo, [":colon.txt"], null);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, group: f.group, status: f.status })),
      [{ path: ":colon.txt", group: "unstaged", status: "U" }],
    );
  });

  test("committed entries remain against the compare ref with a lower-layer change", async () => {
    const committed = await diff.changesForPath(repo, ["hist.txt"], compareRef);
    assert.deepStrictEqual(
      committed.map((f) => ({ path: f.path, group: f.group })),
      [{ path: "hist.txt", group: "committed" }],
    );
    fs.writeFileSync(path.join(repo, "hist.txt"), "hist v3\n");
    const withWorkingChange = await diff.changesForPath(repo, ["hist.txt"], compareRef);
    assert.deepStrictEqual(
      withWorkingChange.map((f) => ({ path: f.path, group: f.group })),
      [
        { path: "hist.txt", group: "unstaged" },
        { path: "hist.txt", group: "committed" },
      ],
      "the committed and Working Tree comparisons must both remain available",
    );
    git(["add", "hist.txt"]);
    const withStagedChange = await diff.changesForPath(repo, ["hist.txt"], compareRef);
    assert.deepStrictEqual(
      withStagedChange.map((f) => ({ path: f.path, group: f.group })),
      [
        { path: "hist.txt", group: "staged" },
        { path: "hist.txt", group: "committed" },
      ],
      "the committed and Staged comparisons must both remain available",
    );
  });
});

suite("syncFileForOpenDiff (openDiff's scoped sync, never a full refresh)", () => {
  const ROOT = "/repo";

  function file(p: string, group: FileGroup): RepoChangedFile {
    return { path: p, group, status: "M", additions: 1, deletions: 0, repoRoot: ROOT };
  }

  function stateWith(files: RepoChangedFile[]): RepositoryReviewState {
    return {
      repoRoot: ROOT,
      displayName: "repo",
      branch: "main",
      changes: {
        staged: files.filter((f) => f.group === "staged"),
        unstaged: files.filter((f) => f.group === "unstaged"),
        committed: files.filter((f) => f.group === "committed"),
        compareLabel: "HEAD",
        compareRef: null,
      },
    };
  }

  function makeDeps(
    state: RepositoryReviewState | undefined,
    fresh: ChangedFile[] | Error,
    duringGitCall?: (competing: {
      start: () => void;
      land: (files: RepoChangedFile[]) => void;
    }) => void,
  ): {
    deps: OpenDiffSync;
    calls: { changesForPath: string[][]; fullRefresh: number; fireChange: number };
    current: () => RepositoryReviewState | undefined;
  } {
    let current = state;
    let seq = 0;
    const calls = { changesForPath: [] as string[][], fullRefresh: 0, fireChange: 0 };
    // A competing refresh(), from the sync's point of view: `start` bumps the repo's refresh seq
    // (refresh() does that synchronously on entry), `land` installs its complete fresh model.
    const competing = {
      start: (): void => {
        seq += 1;
      },
      land: (files: RepoChangedFile[]): void => {
        current = stateWith(files);
      },
    };
    const deps: OpenDiffSync = {
      changesForPath: (_root, relPaths) => {
        calls.changesForPath.push(relPaths);
        duringGitCall?.(competing);
        return fresh instanceof Error ? Promise.reject(fresh) : Promise.resolve(fresh);
      },
      getRepository: () => current,
      setRepository: (s) => {
        current = s;
      },
      getRefreshSeq: () => seq,
      fullRefresh: () => {
        calls.fullRefresh += 1;
        return Promise.resolve();
      },
      fireChange: () => {
        calls.fireChange += 1;
      },
    };
    return { deps, calls, current: () => current };
  }

  test("with a model present it makes ONE scoped call and never the full refresh", async () => {
    const { deps, calls, current } = makeDeps(stateWith([file("a.ts", "unstaged")]), [
      file("a.ts", "unstaged"),
    ]);
    await syncFileForOpenDiff(deps, ROOT, { path: "a.ts" });
    assert.strictEqual(calls.fullRefresh, 0, "openDiff must not run the full multi-root scan");
    assert.deepStrictEqual(calls.changesForPath, [["a.ts"]]);
    assert.strictEqual(calls.fireChange, 0, "an unchanged model must not re-render the tree");
    assert.deepStrictEqual(current()?.changes.unstaged, [file("a.ts", "unstaged")]);
  });

  test("a file that moved layers is re-homed in the model and the change fires", async () => {
    const { deps, calls, current } = makeDeps(
      stateWith([file("a.ts", "unstaged"), file("b.ts", "unstaged")]),
      [file("a.ts", "staged")],
    );
    await syncFileForOpenDiff(deps, ROOT, { path: "a.ts" });
    assert.deepStrictEqual(current()?.changes.staged, [file("a.ts", "staged")]);
    assert.deepStrictEqual(
      current()?.changes.unstaged,
      [file("b.ts", "unstaged")],
      "unrelated entries must be untouched",
    );
    assert.strictEqual(calls.fireChange, 1);
    assert.strictEqual(calls.fullRefresh, 0);
  });

  test("a file whose change disappeared is dropped, so openDiff's bail still works", async () => {
    const { deps, calls, current } = makeDeps(stateWith([file("a.ts", "unstaged")]), []);
    await syncFileForOpenDiff(deps, ROOT, { path: "a.ts" });
    assert.deepStrictEqual(current()?.changes.unstaged, []);
    assert.strictEqual(calls.fireChange, 1);
  });

  test("a rename's old path rides in the scoped path set", async () => {
    const { deps, calls } = makeDeps(stateWith([file("new.ts", "unstaged")]), [
      file("new.ts", "unstaged"),
    ]);
    await syncFileForOpenDiff(deps, ROOT, { path: "new.ts", oldPath: "old.ts" });
    assert.deepStrictEqual(calls.changesForPath, [["new.ts", "old.ts"]]);
  });

  test("a stale rename entry matched only via its old path is replaced, not left as a phantom", async () => {
    // The scoped scan matches entries by path OR oldPath, so querying old.ts re-reports a still-live
    // rename keyed by new.ts — the merge must therefore also treat the stale rename entry as
    // affected, or a rename that git no longer has survives next to old.ts's fresh state.
    const staleRename: RepoChangedFile = {
      path: "new.ts",
      oldPath: "old.ts",
      status: "R",
      group: "staged",
      additions: 0,
      deletions: 0,
      repoRoot: ROOT,
    };
    const { deps, current } = makeDeps(stateWith([staleRename]), [file("old.ts", "unstaged")]);
    await syncFileForOpenDiff(deps, ROOT, { path: "old.ts" });
    assert.deepStrictEqual(
      current()?.changes.staged,
      [],
      "the rename no longer exists in git — its stale entry must be dropped",
    );
    assert.deepStrictEqual(current()?.changes.unstaged, [file("old.ts", "unstaged")]);
  });

  test("falls back to the full refresh ONLY when the repo has no model yet", async () => {
    const { deps, calls } = makeDeps(undefined, []);
    await syncFileForOpenDiff(deps, ROOT, { path: "a.ts" });
    assert.strictEqual(calls.fullRefresh, 1);
    assert.deepStrictEqual(calls.changesForPath, []);
  });

  test("keeps the last-good model when the scoped git call fails", async () => {
    const state = stateWith([file("a.ts", "unstaged")]);
    const { deps, calls, current } = makeDeps(state, new Error("git broke"));
    await syncFileForOpenDiff(deps, ROOT, { path: "a.ts" });
    assert.strictEqual(current(), state);
    assert.strictEqual(calls.fireChange, 0);
    assert.strictEqual(calls.fullRefresh, 0);
  });

  test("a refresh() already in flight that lands during the git call is not reverted", async () => {
    // The unguarded-write scenario: `git add .` staged x AND y, and the refresh() that began before
    // the sync installs that model while the sync awaits its scoped git call. Writing the sync's
    // pre-await snapshot back (y still unstaged, x merged only) would silently revert y — the merge
    // must be into the LIVE model.
    const { deps, calls, current } = makeDeps(
      stateWith([file("x.ts", "unstaged"), file("y.ts", "unstaged")]),
      [file("x.ts", "staged")],
      ({ land }) => land([file("x.ts", "staged"), file("y.ts", "staged")]),
    );
    await syncFileForOpenDiff(deps, ROOT, { path: "x.ts" });
    assert.deepStrictEqual(current()?.changes.staged, [
      file("x.ts", "staged"),
      file("y.ts", "staged"),
    ]);
    assert.deepStrictEqual(
      current()?.changes.unstaged,
      [],
      "y.ts must not be reverted to unstaged by the sync's pre-await snapshot",
    );
    assert.strictEqual(calls.fullRefresh, 0);
  });

  test("a landed refresh() that CHANGED the compare ref supersedes the sync: defer to a full refresh", async () => {
    // Compare-To switched (main → HEAD) before the sync began: the refresh() bumped the seq before
    // the sync read it, so the seq check passes — but the scoped result was computed against the
    // OLD compareRef. Merging it would inject a phantom committed row into the new model (or drop a
    // legitimate one), persisting until some later refresh. A compareRef mismatch between snapshot
    // and live model must defer to a full refresh instead.
    const snapshot = stateWith([file("x.ts", "committed"), file("y.ts", "unstaged")]);
    snapshot.changes.compareRef = "main";
    snapshot.changes.compareLabel = "main";
    const { deps, calls, current } = makeDeps(
      snapshot,
      [file("x.ts", "committed")],
      ({ land }) => land([file("y.ts", "unstaged")]), // new model: Compare To HEAD, committed empty
    );
    await syncFileForOpenDiff(deps, ROOT, { path: "x.ts" });
    assert.strictEqual(calls.fullRefresh, 1, "compareRef changed under the sync → full refresh");
    assert.strictEqual(calls.fireChange, 0, "no scoped write against a different compareRef");
    assert.deepStrictEqual(
      current()?.changes.committed,
      [],
      "the stale committed@main entry must not be injected into the HEAD model",
    );
  });

  test("a refresh() that STARTS during the git call supersedes the sync: defer to a full refresh", async () => {
    // The competing refresh owns data at least as fresh and may still be running, so a scoped write
    // could fight it — and openDiff still needs this file present in the model, so bailing silently
    // would make the open fall through ("disappeared during refresh"). One complete refresh is the
    // only safe answer.
    const { deps, calls, current } = makeDeps(
      stateWith([file("x.ts", "unstaged"), file("y.ts", "unstaged")]),
      [file("x.ts", "staged")],
      ({ start }) => start(),
    );
    await syncFileForOpenDiff(deps, ROOT, { path: "x.ts" });
    assert.strictEqual(calls.fullRefresh, 1, "superseded → wait out one full refresh");
    assert.strictEqual(calls.fireChange, 0, "no scoped write once superseded");
    assert.deepStrictEqual(
      current()?.changes.unstaged,
      [file("x.ts", "unstaged"), file("y.ts", "unstaged")],
      "the model is left for the full refresh to install",
    );
  });

  test("opening one half of a rename never drops the other half's own change (real git)", async () => {
    // Regression: the scoped scan matched entries against the queried paths only, while the merge
    // dropped everything touching the rename-WIDENED affected set — clicking the untracked old-path
    // row deleted the unstaged edit at the rename's new path from the model with no replacement.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-merge-"));
    try {
      const git = (args: string[]): void => {
        execFileSync("git", args, { cwd: repo });
      };
      fs.writeFileSync(path.join(repo, "old.txt"), "one\ntwo\n");
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      git(["add", "."]);
      git(["commit", "-q", "-m", "base"]);
      git(["mv", "old.txt", "new.txt"]);
      fs.appendFileSync(path.join(repo, "new.txt"), "three\n");
      fs.writeFileSync(path.join(repo, "old.txt"), "stub\n");

      const diff = new DiffService();
      const withRoot = (f: ChangedFile): RepoChangedFile => ({ ...f, repoRoot: repo });
      const full = await diff.getChanges(repo, { kind: "head" });
      let state: RepositoryReviewState = {
        repoRoot: repo,
        displayName: "repo",
        branch: "main",
        changes: {
          ...full,
          staged: full.staged.map(withRoot),
          unstaged: full.unstaged.map(withRoot),
          committed: full.committed.map(withRoot),
        },
      };
      const deps: OpenDiffSync = {
        changesForPath: (root, relPaths, ref) => diff.changesForPath(root, relPaths, ref),
        getRepository: () => state,
        setRepository: (s) => {
          state = s;
        },
        getRefreshSeq: () => 0,
        fullRefresh: () => {
          assert.fail("must sync via the scoped path");
        },
        fireChange: () => {},
      };
      await syncFileForOpenDiff(deps, repo, { path: "old.txt" });
      assert.deepStrictEqual(
        state.changes.unstaged.map((f) => ({ path: f.path, status: f.status })),
        [
          { path: "new.txt", status: "M" },
          { path: "old.txt", status: "U" },
        ],
        "the unstaged edit at the rename's new path must survive the merge",
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── The integration seam: the ACTIVATED extension's openDiff must call the scoped sync ────────────

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

suite("openDiff integration (activated extension)", () => {
  test("opening a diff never runs the full refresh once the repo has a model", async function () {
    this.timeout(30_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    // Leftover/session-restored diff tabs would satisfy the active-tab polls below.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    fs.writeFileSync(path.join(folder.uri.fsPath, "notes.txt"), "one\ntwo\nscoped\n");
    const file: RepoChangedFile = {
      path: "notes.txt",
      group: "unstaged",
      status: "M",
      additions: 1,
      deletions: 0,
      repoRoot: canonicalize(folder.uri.fsPath),
    };
    const waitForDiffTab = (): Promise<vscode.Tab | undefined> =>
      waitFor(() => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        return active?.input instanceof vscode.TabInputTextDiff ? active : undefined;
      }, 20_000);
    const openDiffRefreshes = async (): Promise<number> => {
      const snapshot = (await vscode.commands.executeCommand(
        "paireto.test.inspect",
      )) as InspectSnapshot;
      return snapshot.refreshCounts["open-diff"] ?? 0;
    };

    // The first open may legitimately fall back to the full refresh (the repo may have no model
    // yet) — it seeds the model; only the count from here on is the assertion.
    await vscode.commands.executeCommand("paireto.review.openDiff", file);
    assert.ok(await waitForDiffTab(), "openDiff must open a diff tab");
    const before = await openDiffRefreshes();

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("paireto.review.openDiff", file);
    assert.ok(await waitForDiffTab(), "openDiff must reopen a diff tab");
    assert.strictEqual(
      await openDiffRefreshes(),
      before,
      "openDiff must sync via the scoped per-file path, never refresh('open-diff'), once a model exists",
    );
  });
});
