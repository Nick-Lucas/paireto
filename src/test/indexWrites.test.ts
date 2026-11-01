import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiffService } from "../git/DiffService.js";
import { predictIndexWrite, RepoWriteQueue, type IndexWrite } from "../review/indexWrites.js";
import type { RepositoryChangesModel } from "../review/ReviewController.js";

interface Repo {
  root: string;
  git: (args: string[]) => string;
  write: (name: string, text: string) => void;
  remove: (name: string) => void;
}

function makeRepo(): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-index-writes-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (name: string, text: string): void => fs.writeFileSync(path.join(root, name), text);
  const remove = (name: string): void => fs.rmSync(path.join(root, name));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  write("tracked.txt", "one\ntwo\n");
  write("other.txt", "other\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  return { root, git, write, remove };
}

async function model(root: string): Promise<RepositoryChangesModel> {
  const changes = await new DiffService().getChanges(root, { kind: "head" });
  const scope = (files: typeof changes.staged) =>
    files.map((file) => ({ ...file, repoRoot: root }));
  return {
    ...changes,
    staged: scope(changes.staged),
    unstaged: scope(changes.unstaged),
    committed: scope(changes.committed),
  };
}

function rows(changes: RepositoryChangesModel): string[] {
  return [
    ...changes.staged.map((f) => `staged ${f.status} ${f.path} +${f.additions} -${f.deletions}`),
    ...changes.unstaged.map(
      (f) => `unstaged ${f.status} ${f.path} +${f.additions} -${f.deletions}`,
    ),
    ...changes.net.map((f) => `net ${f.status} ${f.path}`),
  ];
}

function placement(changes: RepositoryChangesModel): string[] {
  return [
    ...changes.staged.map((f) => `staged ${f.status} ${f.path}`),
    ...changes.unstaged.map((f) => `unstaged ${f.status} ${f.path}`),
    ...changes.net.map((f) => `net ${f.status} ${f.path}`),
  ];
}

async function predictionAndTruth(
  setup: (repo: Repo) => void,
  write: IndexWrite,
  paths: string[],
): Promise<{ predicted: RepositoryChangesModel; actual: RepositoryChangesModel }> {
  const repo = makeRepo();
  try {
    setup(repo);
    const predicted = predictIndexWrite(await model(repo.root), paths, write);
    const diff = new DiffService();
    await (write === "stage" ? diff.stage(repo.root, paths) : diff.unstage(repo.root, paths));
    return { predicted, actual: await model(repo.root) };
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
}

suite("Optimistic index writes", () => {
  const exact: Array<[string, (repo: Repo) => void, IndexWrite, string]> = [
    [
      "stage a modified file",
      (r) => r.write("tracked.txt", "one\nTWO\nthree\n"),
      "stage",
      "tracked.txt",
    ],
    ["stage an untracked file", (r) => r.write("fresh.txt", "x\ny\n"), "stage", "fresh.txt"],
    ["stage a deleted file", (r) => r.remove("tracked.txt"), "stage", "tracked.txt"],
    [
      "unstage a modified file",
      (r) => {
        r.write("tracked.txt", "one\nTWO\nthree\n");
        r.git(["add", "tracked.txt"]);
      },
      "unstage",
      "tracked.txt",
    ],
    [
      "unstage a deleted file",
      (r) => {
        r.git(["rm", "-q", "tracked.txt"]);
      },
      "unstage",
      "tracked.txt",
    ],
    [
      "unstage a new file",
      (r) => {
        r.write("fresh.txt", "x\ny\n");
        r.git(["add", "fresh.txt"]);
      },
      "unstage",
      "fresh.txt",
    ],
  ];
  for (const [name, setup, write, file] of exact) {
    test(`${name}: the predicted model is the model git reports after the write`, async () => {
      const { predicted, actual } = await predictionAndTruth(setup, write, [file]);
      assert.deepStrictEqual(rows(predicted), rows(actual));
    });
  }

  const placed: Array<[string, (repo: Repo) => void, IndexWrite, string]> = [
    [
      "unstage a new file edited since",
      (r) => {
        r.write("fresh.txt", "x\ny\n");
        r.git(["add", "fresh.txt"]);
        r.write("fresh.txt", "x\ny\nz\n");
      },
      "unstage",
      "fresh.txt",
    ],
    [
      "stage a new file deleted since",
      (r) => {
        r.write("fresh.txt", "x\n");
        r.git(["add", "fresh.txt"]);
        r.remove("fresh.txt");
      },
      "stage",
      "fresh.txt",
    ],
    [
      "unstage a new file deleted since",
      (r) => {
        r.write("fresh.txt", "x\n");
        r.git(["add", "fresh.txt"]);
        r.remove("fresh.txt");
      },
      "unstage",
      "fresh.txt",
    ],
    [
      "stage a partly staged file",
      (r) => {
        r.write("tracked.txt", "one\nTWO\n");
        r.git(["add", "tracked.txt"]);
        r.write("tracked.txt", "one\nTWO\nthree\n");
      },
      "stage",
      "tracked.txt",
    ],
    [
      "unstage a partly staged file",
      (r) => {
        r.write("tracked.txt", "one\nTWO\n");
        r.git(["add", "tracked.txt"]);
        r.write("tracked.txt", "one\nTWO\nthree\n");
      },
      "unstage",
      "tracked.txt",
    ],
  ];
  for (const [name, setup, write, file] of placed) {
    test(`${name}: the predicted model puts every file where git puts it`, async () => {
      const { predicted, actual } = await predictionAndTruth(setup, write, [file]);
      assert.deepStrictEqual(placement(predicted), placement(actual));
    });
  }

  test("files the write does not name keep their rows", async () => {
    const { predicted, actual } = await predictionAndTruth(
      (r) => {
        r.write("tracked.txt", "changed\n");
        r.write("other.txt", "changed too\n");
      },
      "stage",
      ["tracked.txt"],
    );
    assert.deepStrictEqual(rows(predicted), rows(actual));
  });
});

suite("Repository write queue", () => {
  test("writes to one repository run one at a time, in the order they were asked for", async () => {
    const queue = new RepoWriteQueue();
    const log: string[] = [];
    let release!: () => void;
    const first = queue.run("/repo", async () => {
      log.push("first start");
      await new Promise<void>((resolve) => (release = resolve));
      log.push("first end");
    });
    const second = queue.run("/repo", async () => {
      log.push("second");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(log, ["first start"]);
    assert.strictEqual(queue.isBusy("/repo"), true);
    release();
    await Promise.all([first, second]);
    assert.deepStrictEqual(log, ["first start", "first end", "second"]);
    assert.strictEqual(queue.isBusy("/repo"), false);
  });

  test("a failed write rejects its own caller and does not stop the next write", async () => {
    const queue = new RepoWriteQueue();
    const failed = queue.run("/repo", () => Promise.reject(new Error("index.lock")));
    const next = queue.run("/repo", () => Promise.resolve());
    await assert.rejects(failed, /index\.lock/);
    await next;
    assert.strictEqual(queue.isBusy("/repo"), false);
  });
});
