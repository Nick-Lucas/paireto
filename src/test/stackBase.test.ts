// "Stack base" is the commit the branch itself was created from — the tip of the branch below it in
// a stack — as opposed to the merge base, which is the common ancestor with the default branch and
// therefore includes every stacked branch underneath. The resolution walks the decorated commits
// between the merge base and HEAD instead of reading the reflog: a stack is rebased often, and the
// "branch: Created from …" reflog entry goes stale the moment that happens (pinned by the rebase
// test below), while the walk keeps returning the branch that is really underneath.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiffService, pickStackBase } from "../git/DiffService.js";

interface TestRepo {
  root: string;
  git: (args: string[]) => string;
  commit: (name: string) => string;
}

function makeRepo(prefix: string): TestRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root }).toString().trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  const commit = (name: string): string => {
    fs.writeFileSync(path.join(root, name), `${name}\n`);
    git(["add", name]);
    git(["commit", "-q", "-m", name]);
    return git(["rev-parse", "HEAD"]);
  };
  return { root, git, commit };
}

suite("stack base — pickStackBase", () => {
  test("picks the nearest ancestor branch and skips the checked-out branch on the same commit", () => {
    const log = [
      "4c72661\tpaireto/stack-base-compare, paireto/changes-enter-rename",
      "a7c5145\tpaireto/stage-saves-unsaved-changes",
      "8dbd7d4\tpaireto/plan-review-file-feedback",
      "a27377b\tpaireto/sidebar-plugin-versions",
    ].join("\n");
    assert.deepStrictEqual(pickStackBase(log, "paireto/stack-base-compare"), {
      commit: "4c72661",
      branch: "paireto/changes-enter-rename",
    });
  });

  // The walk reads a first-parent log, so a branch merged into this layer is never in the output.
  // With nothing else below, the merge base is the comparison point.
  test("a layer's own line of commits with no branch on it has no stack parent", () => {
    const log = ["f7f9482\tfeat/b", "b567943\t", "0e91303\t"].join("\n");
    assert.strictEqual(pickStackBase(log, "feat/b"), undefined);
  });

  test("a branch made straight from the default branch has no stack parent", () => {
    assert.strictEqual(pickStackBase("702b78a\tfeat/solo", "feat/solo"), undefined);
  });

  test("an attached HEAD arrow is never mistaken for a stack parent", () => {
    assert.strictEqual(pickStackBase("2dcd9ea\tHEAD -> feat/b", "feat/b"), undefined);
  });

  test("empty output, which is what a failed git call yields, has no stack parent", () => {
    assert.strictEqual(pickStackBase("", "feat/b"), undefined);
  });

  // The first line is the HEAD commit. Without a branch name for the position we are on, a branch
  // there can be our own position under a different name, so only deeper commits can be trusted.
  test("with no branch name, a branch on the HEAD commit is not the branch below", () => {
    const log = ["4c72661\tfeat/b", "a7c5145\tfeat/a"].join("\n");
    assert.deepStrictEqual(pickStackBase(log, undefined), {
      commit: "a7c5145",
      branch: "feat/a",
    });
  });

  // A layer added to the stack has no commits of its own yet, so its parent is on the HEAD commit.
  test("a branch on the HEAD commit is the branch below when the checked-out branch is known", () => {
    const log = ["4c72661\tfeat/c, feat/b", "a7c5145\tfeat/a"].join("\n");
    assert.deepStrictEqual(pickStackBase(log, "feat/c"), {
      commit: "4c72661",
      branch: "feat/b",
    });
  });
});

suite("stack base — DiffService.resolveCompareTo", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let mainTip: string;
  let featATip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-");
    mainTip = repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/a"]);
    featATip = repo.commit("a.txt");
    repo.git(["checkout", "-q", "-b", "feat/b"]);
    repo.commit("b.txt");
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  test("the merge base is the default branch tip, below the whole stack", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "mergeBase" }), {
      ref: mainTip,
      label: "merge-base(main)",
    });
  });

  test("the stack base is the tip of the branch below this one", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: featATip,
      label: "stack-base(feat/a)",
    });
    assert.notStrictEqual(featATip, mainTip, "the two comparison points must really differ");
  });

  test("the committed group holds only this branch's own files", async () => {
    const stack = await diff.getChanges(repo.root, { kind: "stackBase" });
    assert.deepStrictEqual(
      stack.committed.map((f) => f.path),
      ["b.txt"],
    );
    const merge = await diff.getChanges(repo.root, { kind: "mergeBase" });
    assert.deepStrictEqual(
      merge.committed.map((f) => f.path),
      ["a.txt", "b.txt"],
    );
  });
});

// A layer can merge another branch into itself. That branch is not the branch below — it is work
// this layer took in — so it must not become the comparison point, or the layer below stays in the
// review under its name.
suite("stack base — a side branch merged into the layer", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let featATip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-merge-");
    repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/a"]);
    featATip = repo.commit("a.txt");
    repo.git(["checkout", "-q", "-b", "feat/b"]);
    repo.commit("b.txt");
    repo.git(["checkout", "-q", "-b", "side", "main"]);
    repo.commit("side.txt");
    repo.git(["checkout", "-q", "feat/b"]);
    repo.git(["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  test("the branch below is still the layer under this one", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: featATip,
      label: "stack-base(feat/a)",
    });
  });

  test("the committed group holds this layer's own work and what it merged in", async () => {
    const stack = await diff.getChanges(repo.root, { kind: "stackBase" });
    assert.deepStrictEqual(stack.committed.map((f) => f.path).sort(), ["b.txt", "side.txt"]);
  });
});

// A layer can merge the branch below it in instead of rebasing onto it. That parent is then off this
// layer's own line of commits, so the merge base is the comparison point.
suite("stack base — a layer that merges its parent in", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let mainTip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-parentmerge-");
    mainTip = repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/a"]);
    repo.commit("a1.txt");
    repo.git(["checkout", "-q", "-b", "feat/b"]);
    repo.commit("b1.txt");
    // feat/a moves on, and feat/b takes that work in with a merge instead of a rebase.
    repo.git(["checkout", "-q", "feat/a"]);
    repo.commit("a2.txt");
    repo.git(["checkout", "-q", "feat/b"]);
    repo.git(["merge", "-q", "--no-ff", "-m", "merge feat/a", "feat/a"]);
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  test("the merge base is the comparison point, under the default branch's name", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: mainTip,
      label: "stack-base(main)",
    });
  });
});

// `%D` prints the decorations in the shape the log.decorate config asks for, and a full ref name
// ("refs/heads/feat/b") matches no short branch name, so every name — the checked-out one included —
// would look like the branch below.
suite("stack base — with log.decorate set to full", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let featATip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-decorate-");
    repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/a"]);
    featATip = repo.commit("a.txt");
    repo.git(["checkout", "-q", "-b", "feat/b"]);
    repo.commit("b.txt");
    repo.git(["config", "log.decorate", "full"]);
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  test("the stack base is still the tip of the branch below", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: featATip,
      label: "stack-base(feat/a)",
    });
  });
});

// A detached HEAD is normal during a rebase, which is exactly when a stack is being worked on.
// Git cannot name the position we are on, so the branch left on the HEAD commit is our own branch.
suite("stack base — a detached HEAD", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let featATip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-detached-");
    repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/a"]);
    featATip = repo.commit("a.txt");
    repo.git(["checkout", "-q", "-b", "feat/b"]);
    repo.commit("b.txt");
    repo.git(["checkout", "-q", "--detach"]);
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  test("the stack base is the branch below, not the branch we sit on", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: featATip,
      label: "stack-base(feat/a)",
    });
  });

  test("the committed group still holds this branch's own files", async () => {
    const stack = await diff.getChanges(repo.root, { kind: "stackBase" });
    assert.deepStrictEqual(
      stack.committed.map((f) => f.path),
      ["b.txt"],
    );
  });
});

// A branch added on top of a stack has no commits of its own, so it shares the tip of the branch
// below and an empty committed group is the true answer.
suite("stack base — a layer with no commits of its own", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let featBTip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-newlayer-");
    repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/a"]);
    repo.commit("a.txt");
    repo.git(["checkout", "-q", "-b", "feat/b"]);
    featBTip = repo.commit("b.txt");
    repo.git(["checkout", "-q", "-b", "feat/c"]);
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  test("the stack base is the branch below, on the same commit", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: featBTip,
      label: "stack-base(feat/b)",
    });
    const stack = await diff.getChanges(repo.root, { kind: "stackBase" });
    assert.deepStrictEqual(stack.committed, []);
  });
});

// A stack is rebased whenever the branch below it moves. The branch's own reflog still names the
// commit it was first created from, which is no longer an ancestor of HEAD, so a reflog-based or
// `merge-base --fork-point` resolution returns a commit outside the branch's history.
suite("stack base — after the stack is rebased", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let createdFrom: string;
  let rebasedATip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-rebase-");
    repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/a"]);
    createdFrom = repo.commit("a.txt");
    repo.git(["checkout", "-q", "-b", "feat/b"]);
    repo.commit("b.txt");
    repo.git(["checkout", "-q", "main"]);
    repo.commit("main2.txt");
    repo.git(["checkout", "-q", "feat/a"]);
    repo.git(["rebase", "-q", "main"]);
    rebasedATip = repo.git(["rev-parse", "HEAD"]);
    repo.git(["checkout", "-q", "feat/b"]);
    repo.git(["rebase", "-q", "--onto", "feat/a", createdFrom, "feat/b"]);
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  test("the commit the branch was created from is no longer in its history", () => {
    assert.throws(
      () => repo.git(["merge-base", "--is-ancestor", createdFrom, "HEAD"]),
      "the rebase must have made the original fork point unreachable",
    );
  });

  test("the stack base follows the branch below to its new tip", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: rebasedATip,
      label: "stack-base(feat/a)",
    });
  });
});

suite("stack base — a branch with nothing under it", () => {
  const diff = new DiffService();
  let repo: TestRepo;
  let mainTip: string;

  suiteSetup(() => {
    repo = makeRepo("paireto-stackbase-solo-");
    mainTip = repo.commit("base.txt");
    repo.git(["checkout", "-q", "-b", "feat/solo"]);
    repo.commit("solo.txt");
  });

  suiteTeardown(() => {
    fs.rmSync(repo.root, { recursive: true, force: true });
  });

  // The refs match here, so the label is the only thing telling the reviewer which row is active.
  test("degrades to the merge base but keeps its own label", async () => {
    assert.deepStrictEqual(await diff.resolveCompareTo(repo.root, { kind: "stackBase" }), {
      ref: mainTip,
      label: "stack-base(main)",
    });
  });
});
