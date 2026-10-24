import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiffService } from "../git/DiffService.js";

type Git = (args: string[]) => string;

function gitIn(cwd: string): Git {
  return (args) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
}

suite("merge conflicts in the change list", () => {
  const diff = new DiffService();
  let repo: string;
  let git: Git;

  suiteSetup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-conflict-"));
    git = gitIn(repo);
    const write = (name: string, content: string): void =>
      fs.writeFileSync(path.join(repo, name), content);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    write("f.txt", "one\ntwo\nthree\n");
    write("clean.txt", "clean v1\n");
    write("gone.txt", "gone v1\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    git(["checkout", "-q", "-b", "feature"]);
    write("f.txt", "one\ntwo feature\nthree\n");
    write("clean.txt", "clean v2\n");
    write("gone.txt", "gone feature\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "feature"]);
    git(["checkout", "-q", "main"]);
    write("f.txt", "one\ntwo main\nthree\n");
    git(["rm", "-q", "gone.txt"]);
    git(["add", "."]);
    git(["commit", "-q", "-m", "main"]);
    assert.throws(() => git(["merge", "feature"]), "the merge must stop on a conflict");
  });

  suiteTeardown(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("getChanges lists a conflicted file once, as unmerged in the Working Tree group", async () => {
    const changes = await diff.getChanges(repo, { kind: "head" });
    assert.deepStrictEqual(
      changes.unstaged.map((f) => ({ path: f.path, status: f.status })),
      [
        { path: "f.txt", status: "!" },
        { path: "gone.txt", status: "!" },
      ],
    );
    assert.deepStrictEqual(
      changes.staged.map((f) => ({ path: f.path, status: f.status })),
      [{ path: "clean.txt", status: "M" }],
      "conflicted paths must not appear in Staged; the cleanly merged file stays",
    );
  });

  test("changesForPath agrees with getChanges for a conflicted file", async () => {
    const fresh = await diff.changesForPath(repo, ["f.txt"], null);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, group: f.group, status: f.status })),
      [{ path: "f.txt", group: "unstaged", status: "!" }],
    );
  });

  test("changesForPath keeps a cleanly merged file staged", async () => {
    const fresh = await diff.changesForPath(repo, ["clean.txt"], null);
    assert.deepStrictEqual(
      fresh.map((f) => ({ path: f.path, group: f.group, status: f.status })),
      [{ path: "clean.txt", group: "staged", status: "M" }],
    );
  });

  test("hasBothConflictSides is true for a both-modified conflict", async () => {
    assert.strictEqual(await diff.hasBothConflictSides(repo, "f.txt"), true);
  });

  test("hasBothConflictSides is false for a modify/delete conflict", async () => {
    assert.strictEqual(await diff.hasBothConflictSides(repo, "gone.txt"), false);
  });

  test("hasBothConflictSides is false for a path with no conflict", async () => {
    assert.strictEqual(await diff.hasBothConflictSides(repo, "clean.txt"), false);
  });
});
