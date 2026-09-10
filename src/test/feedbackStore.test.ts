import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { currentFeedbackRef, type FeedbackRef } from "../git/gitCli.js";
import { repoKey } from "../protocol/paths.js";
import {
  feedbackFilePath,
  openFeedbackBucket,
  type FeedbackBucket,
  type FeedbackState,
} from "../storage/FeedbackStore.js";
import type { ReviewThread } from "../review/reviewTypes.js";

const branch = (value: string): FeedbackRef => ({ kind: "branch", value });
const comment = (id: string, repoRoot = "/repo"): ReviewThread => ({
  id,
  repoRoot,
  filePath: "src/a.ts",
  side: "modified",
  line: 2,
  anchor: {
    lineText: "const answer = 42;",
    contextBefore: [],
    contextAfter: [],
    lineHash: "hash",
  },
  delivery: "pending",
  createdAt: "2026-08-12T20:00:00.000Z",
  updatedAt: "2026-08-12T20:00:00.000Z",
  items: [
    {
      kind: "comment",
      commentKind: "question",
      body: "Why is this needed?",
      quote: "const answer = 42;",
      at: "2026-08-12T20:00:00.000Z",
    },
  ],
});

suite("repository feedback buckets", () => {
  let root: string;
  let bucket: FeedbackBucket;
  const main = branch("main");
  const other = branch("feature/other");

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-"));
    bucket = await openFeedbackBucket("/repo", main, root);
  });

  teardown(async () => {
    await bucket.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the same repository and ref name one file whatever the spelling", () => {
    assert.strictEqual(
      feedbackFilePath("/repo", main, root),
      feedbackFilePath("/repo/../repo", branch("main"), root),
    );
    assert.strictEqual(
      feedbackFilePath("/repo", main, root),
      feedbackFilePath("/repo", main, path.relative(process.cwd(), root)),
    );
    assert.notStrictEqual(
      feedbackFilePath("/repo", main, root),
      feedbackFilePath("/other", main, root),
    );
  });

  test("different ref buckets use separate files", async () => {
    const second = await openFeedbackBucket("/repo", other, root);
    try {
      bucket.update((draft) => {
        draft.threads = [comment("main")];
      });
      second.update((draft) => {
        draft.threads = [comment("other")];
      });
      await Promise.all([bucket.flush(), second.flush()]);
      const firstFile = feedbackFilePath("/repo", main, root);
      const secondFile = feedbackFilePath("/repo", other, root);
      assert.notStrictEqual(firstFile, secondFile);
      assert.strictEqual(path.dirname(firstFile), path.join(root, repoKey("/repo")));
      assert.strictEqual(path.dirname(secondFile), path.dirname(firstFile));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(firstFile, "utf8")), {
        version: 2,
        state: { threads: [comment("main")] },
      });
      const secondBytes = fs.readFileSync(secondFile, "utf8");
      bucket.update((draft) => {
        draft.threads = [];
      });
      await bucket.flush();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(firstFile, "utf8")).state.threads, []);
      assert.strictEqual(fs.readFileSync(secondFile, "utf8"), secondBytes);
      assert.strictEqual(second.threads()[0].id, "other");
    } finally {
      await second.close();
    }
  });

  test("branch and detached refs with the same value have separate paths", () => {
    assert.notStrictEqual(
      feedbackFilePath("/repo", branch("HEAD"), root),
      feedbackFilePath("/repo", { kind: "detached", value: "HEAD" }, root),
    );
  });

  test("a bucket reads its file exactly once when it opens", async () => {
    const repo = "/restored";
    const file = feedbackFilePath(repo, main, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, state: { threads: [comment("first", repo)] } }),
    );
    const read = mock.method(fs.promises, "readFile");
    try {
      const restored = await openFeedbackBucket(repo, main, root);
      assert.deepStrictEqual(restored.threads(), [comment("first", repo)]);
      assert.deepStrictEqual(restored.threads(), [comment("first", repo)]);
      assert.strictEqual(
        read.mock.calls.filter(({ arguments: args }) => args[0] === file).length,
        1,
      );
      await restored.close();
    } finally {
      read.mock.restore();
    }
  });

  test("an old file that carries repoRoot and ref keeps its threads and drops them on write", async () => {
    const repo = "/legacy";
    const file = feedbackFilePath(repo, main, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        state: { repoRoot: repo, ref: main, threads: [comment("kept", repo)] },
      }),
    );
    const legacy = await openFeedbackBucket(repo, main, root);
    try {
      assert.deepStrictEqual(
        legacy.threads().map((item) => item.id),
        ["kept"],
      );
      legacy.update((draft) => {
        draft.threads.push(comment("added", repo));
      });
      await legacy.flush();
      assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).state), [
        "threads",
      ]);
    } finally {
      await legacy.close();
    }
  });

  test("the bucket names the repository and ref it was opened for", () => {
    assert.strictEqual(bucket.repoRoot, path.resolve("/repo"));
    assert.deepStrictEqual(bucket.ref, main);
    assert.strictEqual(bucket.file, feedbackFilePath("/repo", main, root));
  });

  test("Immer updates preserve previous snapshots", async () => {
    bucket.update((draft) => {
      draft.threads = [comment("one")];
    });
    const before = bucket.threads();
    bucket.update((draft) => {
      draft.threads[0].line = 10;
    });
    assert.strictEqual(before[0].line, 2, "the earlier snapshot is untouched");
    assert.strictEqual(bucket.threads()[0].line, 10);
  });

  test("debounces draft updates into one disk write per bucket", async () => {
    const file = feedbackFilePath("/repo", main, root);
    const rename = mock.method(fs.promises, "rename");
    try {
      bucket.update((draft) => {
        draft.threads = [comment("one")];
      });
      bucket.update((draft) => {
        draft.threads.push(comment("two"));
      });
      bucket.update((draft) => {
        draft.threads[0].delivery = "sent";
      });
      await bucket.flush();
      assert.strictEqual(
        rename.mock.calls.filter(({ arguments: args }) => args[1] === file).length,
        1,
      );
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { state: FeedbackState };
      assert.strictEqual(saved.state.threads[0].delivery, "sent");
      assert.strictEqual(saved.state.threads[1].id, "two");
    } finally {
      rename.mock.restore();
    }
  });

  test("failed disk writes keep draft updates available and retry the bucket", async function () {
    this.timeout(5000);
    const file = feedbackFilePath("/repo", main, root);
    const original = fs.promises.rename;
    let attempts = 0;
    const rename = mock.method(
      fs.promises,
      "rename",
      async (from: fs.PathLike, to: fs.PathLike) => {
        if (to === file && ++attempts === 1) {
          throw new Error("disk full");
        }
        return original(from, to);
      },
    );
    try {
      bucket.update((draft) => {
        draft.threads = [comment("one")];
      });
      await bucket.flush();
      assert.strictEqual(bucket.threads()[0].id, "one");
      for (let i = 0; i < 150 && !fs.existsSync(file); i++) {
        await delay(20);
      }
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).state.threads[0].id, "one");
      assert.strictEqual(attempts, 2);
    } finally {
      rename.mock.restore();
    }
  });

  test("a bucket written by an older shape is discarded rather than half read", async () => {
    const repo = "/older";
    const file = feedbackFilePath(repo, main, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, state: { threads: [{ id: "old", items: [] }] } }),
    );

    const opened = await openFeedbackBucket(repo, main, root);

    assert.deepStrictEqual(opened.threads(), []);
    await opened.close();
  });

  test("a corrupt bucket file keeps the initial empty state", async () => {
    const file = feedbackFilePath("/corrupt", main, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ truncated");
    const recovered = await openFeedbackBucket("/corrupt", main, root);
    assert.deepStrictEqual(recovered.threads(), []);
    await recovered.close();
  });

  test("closing a bucket writes its pending change before it resolves", async () => {
    const closingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-close-"));
    try {
      const closing = await openFeedbackBucket("/closing", main, closingRoot);
      closing.update((draft) => {
        draft.threads = [comment("last", "/closing")];
      });
      await closing.close();
      const file = feedbackFilePath("/closing", main, closingRoot);
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).state.threads[0].id, "last");
    } finally {
      fs.rmSync(closingRoot, { recursive: true, force: true });
    }
  });

  test("closing a bucket with nothing pending writes nothing", async () => {
    const quietRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-quiet-"));
    const rename = mock.method(fs.promises, "rename");
    try {
      const quiet = await openFeedbackBucket("/quiet", main, quietRoot);
      await quiet.close();
      assert.strictEqual(rename.mock.calls.length, 0);
    } finally {
      rename.mock.restore();
      fs.rmSync(quietRoot, { recursive: true, force: true });
    }
  });

  test("a bucket opened after a close reads what the closed one wrote", async () => {
    const reopenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-reopen-"));
    try {
      const first = await openFeedbackBucket("/reopen", main, reopenRoot);
      first.update((draft) => {
        draft.threads = [comment("saved", "/reopen")];
      });
      await first.close();
      const second = await openFeedbackBucket("/reopen", main, reopenRoot);
      assert.deepStrictEqual(
        second.threads().map((item) => item.id),
        ["saved"],
      );
      await second.close();
    } finally {
      fs.rmSync(reopenRoot, { recursive: true, force: true });
    }
  });
});

suite("feedback identity over a real repository", () => {
  let stateRoot: string;
  let bucket: FeedbackBucket;
  let repoRoot: string;

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot }).toString().trim();

  const commit = (name: string): void => {
    fs.writeFileSync(path.join(repoRoot, name), `${name}\n`);
    git(["add", name]);
    git(["commit", "-q", "-m", name]);
  };

  setup(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-repo-"));
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-git-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    commit("one.txt");
    bucket = await openFeedbackBucket(repoRoot, branch("main"), path.join(stateRoot, "feedback"));
  });

  teardown(async () => {
    await bucket.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test("feedback left on a branch survives a commit on that branch", async () => {
    const before = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(before, { kind: "branch", value: "main" });
    bucket.update((draft) => {
      draft.threads = [comment("one", repoRoot)];
    });
    await bucket.close();

    commit("two.txt");

    const after = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(after, before, "a commit does not move the branch a bucket is keyed by");
    const reopened = await openFeedbackBucket(repoRoot, after!, path.join(stateRoot, "feedback"));
    assert.deepStrictEqual(
      reopened.threads().map((item) => item.id),
      ["one"],
    );
    await reopened.close();
  });

  test("detached feedback keeps its bucket after a commit", async () => {
    git(["checkout", "-q", "--detach"]);

    const before = await currentFeedbackRef(repoRoot);
    commit("detached.txt");
    assert.deepStrictEqual(await currentFeedbackRef(repoRoot), before);
  });
});
