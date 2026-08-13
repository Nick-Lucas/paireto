// Root-cause hunt for "openDiff: <path> disappeared during refresh" on untracked rows.
//
// Shape of the report: clicking an untracked row deletes it from the tree and opens nothing. Only
// mergeChangesForPath removes a single path from the model, and it does so when the scoped scan
// returns no entry for that path. Tracked files reach the scoped scan through the FULL `git diff`
// output filtered in JS, so they cannot be lost this way; untracked files reach it through a git
// PATHSPEC on a SECOND, separate `ls-files` call. Everything below asks one question: what makes
// that call disagree with the unscoped walk the tree was built from?
//
// Theories that were measured and RULED OUT (same fixture, Linux, git 2.34 / 2.39 / 2.43 / 2.49 —
// full-vs-scoped parity held for every one, so they are not reproduced here):
//   plain report-shaped repo; GIT_LITERAL_PATHSPECS; GIT_NOGLOB_PATHSPECS; GIT_DIR + GIT_WORK_TREE;
//   glob characters, option-shaped names and newlines in the file name; an embedded git repo
//   reported as a directory entry; a .gitignore directory exclude with a re-admitting negation; a
//   repo root reached through a symlink; huge-repo tuning (feature.manyFiles, core.untrackedCache,
//   core.fsmonitor, index.version=4); a submodule as a sibling of the plan docs; a deinitialised
//   submodule; a transient spawn failure of the untracked walk; two clicks in flight together.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiffService, type ChangedFile } from "../git/DiffService.js";
import {
  syncFileForOpenDiff,
  type OpenDiffSync,
  type RepoChangedFile,
  type RepositoryReviewState,
} from "../review/ReviewController.js";

const PLAN_A = "docs/implementation-plans/2026-06-11-acd-audio-routing-refactor.md";
const PLAN_B = "docs/implementation-plans/2026-07-20-acd-58-dtmf-inter-digit-timeout.md";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "root\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
}

function write(root: string, relPath: string): void {
  const file = path.join(root, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "plan\n");
}

/** Run `body` with the given environment variables set, then restore the previous values. */
async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * The invariant every theory is measured against: for each untracked entry the FULL scan reports,
 * the SCOPED scan for that same path must report it too. Anything else deletes the row on click.
 */
async function assertScopedParity(diff: DiffService, repo: string, note: string): Promise<void> {
  const full = await diff.getChanges(repo, { kind: "head" });
  const untracked = full.unstaged.filter((f) => f.status === "U");
  assert.ok(untracked.length > 0, `${note}: the fixture must have untracked files to check`);
  const missing: string[] = [];
  for (const file of untracked) {
    let fresh: ChangedFile[];
    try {
      fresh = await diff.changesForPath(repo, [file.path], null);
    } catch (error) {
      missing.push(`${file.path} (scan threw: ${String(error).split("\n")[0]})`);
      continue;
    }
    if (!fresh.some((f) => f.path === file.path)) {
      missing.push(file.path);
    }
  }
  assert.deepStrictEqual(missing, [], `${note}: scoped scan lost untracked rows`);
}

suite("untracked rows lost by the scoped scan", () => {
  const diff = new DiffService();
  let fixture: string;

  setup(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-untracked-"));
  });

  teardown(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  /** A repo shaped like the report: a submodule, and untracked plan docs in a directory that holds
   *  no tracked files at all. */
  function reportShapedRepo(): string {
    const root = path.join(fixture, "root");
    const submoduleSource = path.join(fixture, "sub-src");
    makeRepo(root);
    makeRepo(submoduleSource);
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submoduleSource,
      "vendor/sub",
    ]);
    git(root, ["commit", "-q", "-m", "add submodule"]);
    write(root, PLAN_A);
    write(root, PLAN_B);
    return root;
  }

  test("THEORY: GIT_GLOB_PATHSPECS in the editor's environment", async () => {
    // `--literal-pathspecs` is mutually exclusive with the other global pathspec settings: git
    // refuses the whole command with "global 'literal' pathspec setting is incompatible with all
    // other global pathspec settings". The untracked walk then never runs, for every path, forever.
    const root = reportShapedRepo();
    await withEnv({ GIT_GLOB_PATHSPECS: "1" }, () =>
      assertScopedParity(diff, root, "GIT_GLOB_PATHSPECS=1"),
    );
  });

  test("THEORY: GIT_ICASE_PATHSPECS in the editor's environment", async () => {
    const root = reportShapedRepo();
    await withEnv({ GIT_ICASE_PATHSPECS: "1" }, () =>
      assertScopedParity(diff, root, "GIT_ICASE_PATHSPECS=1"),
    );
  });

  test("THEORY: the untracked walk reports nothing while the file is still on disk", async () => {
    // The root fragility, independent of WHICH cause empties the call: an untracked walk that exits
    // 0 with no output is indistinguishable from "there is no untracked file at this path", and the
    // merge deletes the row for both. The scan should confirm the file is really gone — the file
    // exists here, is not ignored, and the full scan lists it — before reporting it as no change.
    const root = reportShapedRepo();
    const binDir = path.join(fixture, "shim-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(binDir, "git"),
      `#!/bin/sh\ncase " $* " in *" ls-files "*) exit 0;; esac\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    await withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }, async () => {
      const fresh = await diff.changesForPath(root, [PLAN_A], null);
      assert.deepStrictEqual(
        fresh.map((f) => f.path),
        [PLAN_A],
        "the file is present and not ignored — the row must survive an empty untracked walk",
      );
    });
  });
});

suite("openDiff's scoped sync and a competing refresh", () => {
  const ROOT = "/repo";

  function file(p: string): RepoChangedFile {
    return { path: p, group: "unstaged", status: "U", additions: 1, deletions: 0, repoRoot: ROOT };
  }

  function stateWith(files: RepoChangedFile[]): RepositoryReviewState {
    return {
      repoRoot: ROOT,
      displayName: "repo",
      branch: "main",
      changes: {
        staged: [],
        unstaged: files,
        committed: [],
        compareLabel: "HEAD",
        compareRef: null,
      },
    };
  }

  test("THEORY: a refresh that began BEFORE the sync lands after it and reverts the merge", async () => {
    // refresh() bumps the repo's sequence when it STARTS, and re-reads it before installing its
    // model so a NEWER refresh wins. A scoped sync claims no sequence at all, so it is invisible to
    // that guard: a refresh already running when the click arrived installs its own snapshot on top
    // of the merge. In a repo this size a full refresh takes seconds, so it routinely lands after
    // the click it overlapped — with a model snapshotted before the plan doc was written.
    let seq = 1;
    let current = stateWith([]);
    const olderRefreshSeq = seq; // refresh() started before the click, holding an empty snapshot
    const deps: OpenDiffSync = {
      changesForPath: () => Promise.resolve([file(PLAN_A)]),
      getRepository: () => current,
      setRepository: (next) => {
        current = next;
      },
      getRefreshSeq: () => seq,
      fullRefresh: () => Promise.resolve(),
      fireChange: () => {},
    };
    await syncFileForOpenDiff(deps, ROOT, { path: PLAN_A });
    // The older refresh finishes and applies refresh()'s own supersede guard before writing.
    if (seq === olderRefreshSeq) {
      current = stateWith([]);
    }
    assert.deepStrictEqual(
      current.changes.unstaged.map((f) => f.path),
      [PLAN_A],
      "a refresh older than the sync must not overwrite the sync's merge",
    );
  });
});
