import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { currentFeedbackRef, type FeedbackRef } from "../git/gitCli.js";
import { canonicalize, repoKey } from "../protocol/paths.js";
import {
  getFeedbackStore,
  getWorkspaceFeedbackStore,
  workspaceFeedbackFilePath,
  feedbackFilePath,
  type RepoFeedbackStore,
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
  activities: [
    {
      kind: "feedback",
      feedbackKind: "question",
      body: "Why is this needed?",
      quote: "const answer = 42;",
      at: "2026-08-12T20:00:00.000Z",
    },
  ],
});

suite("workspace feedback storage", () => {
  test("workspace fallback has a stable persisted singleton", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-workspace-feedback-"));
    try {
      const store = await getWorkspaceFeedbackStore(["/workspace/b", "/workspace/a"], root);
      assert.strictEqual(
        await getWorkspaceFeedbackStore(["/workspace/a/../a", "/workspace/b"], root),
        store,
      );
      await store.setState((draft) => {
        draft.threads.push(comment("fallback"));
      });
      const files = fs.readdirSync(root);
      assert.strictEqual(files.length, 1);
      assert.match(files[0], /^workspace-.*\.json$/);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(root, files[0]), "utf8")).state.threads[0].id,
        "fallback",
      );
      assert.notStrictEqual(await getWorkspaceFeedbackStore(["/another-workspace"], root), store);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("restores workspace feedback on initial hydration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-workspace-restore-"));
    try {
      const paths = ["/project/review.code-workspace"];
      const file = workspaceFeedbackFilePath(paths, root);
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, state: { threads: [comment("restored")] } }),
      );
      const read = mock.method(fs.promises, "readFile");
      try {
        const store = await getWorkspaceFeedbackStore(paths, root);
        assert.strictEqual(store.getState().threads[0].id, "restored");
        assert.strictEqual(await getWorkspaceFeedbackStore(paths, root), store);
        assert.strictEqual(
          read.mock.calls.filter(({ arguments: args }) => args[0] === file).length,
          1,
        );
      } finally {
        read.mock.restore();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspace identities use canonical paths and do not collide with branch files", () => {
    assert.strictEqual(
      workspaceFeedbackFilePath(["/project/a", "/project/b"]),
      workspaceFeedbackFilePath(["/project/b", "/project/a/../a", "/project/a"]),
    );
    assert.notStrictEqual(
      workspaceFeedbackFilePath(["/project/a"]),
      workspaceFeedbackFilePath(["/project/b"]),
    );
    assert.notStrictEqual(
      workspaceFeedbackFilePath(["/project/a"]),
      feedbackFilePath("/project/a", branch("main")),
    );
  });
});

suite("repository feedback stores", () => {
  let root: string;
  let store: RepoFeedbackStore;
  const main = branch("main");
  const other = branch("feature/other");

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-"));
    store = await getFeedbackStore("/repo", main, root);
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("returns the same store for the same canonical repository and ref", async () => {
    const [first, second] = await Promise.all([
      getFeedbackStore("/repo/../repo", branch("main"), root),
      getFeedbackStore("/repo", main, path.relative(process.cwd(), root)),
    ]);
    assert.strictEqual(first, store);
    assert.strictEqual(second, store);
    assert.notStrictEqual(await getFeedbackStore("/other", main, root), store);
  });

  test("different ref buckets use separate stores and files", async () => {
    const second = await getFeedbackStore("/repo", other, root);
    assert.notStrictEqual(store, second);
    await Promise.all([
      store.setState((draft) => {
        draft.threads = [comment("main")];
      }),
      second.setState((draft) => {
        draft.threads = [comment("other")];
      }),
    ]);
    const firstFile = feedbackFilePath("/repo", main, root);
    const secondFile = feedbackFilePath("/repo", other, root);
    assert.notStrictEqual(firstFile, secondFile);
    assert.strictEqual(path.dirname(firstFile), path.join(root, repoKey("/repo")));
    assert.strictEqual(path.dirname(secondFile), path.dirname(firstFile));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(firstFile, "utf8")), {
      version: 1,
      state: { repoRoot: canonicalize("/repo"), ref: main, threads: [comment("main")] },
    });
    const secondBytes = fs.readFileSync(secondFile, "utf8");
    await store.setState((draft) => {
      draft.threads = [];
    });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(firstFile, "utf8")).state.threads, []);
    assert.strictEqual(fs.readFileSync(secondFile, "utf8"), secondBytes);
    assert.strictEqual(second.getState().threads[0].id, "other");
  });

  test("branch and detached refs with the same value have separate paths", () => {
    assert.notStrictEqual(
      feedbackFilePath("/repo", branch("HEAD"), root),
      feedbackFilePath("/repo", { kind: "detached", value: "HEAD" }, root),
    );
    assert.notStrictEqual(
      feedbackFilePath("/repo", main, root),
      feedbackFilePath("/other", main, root),
    );
  });

  test("hydrates a saved bucket once and serves subsequent reads from memory", async () => {
    const repo = "/restored";
    const file = feedbackFilePath(repo, main, root);
    const state: FeedbackState = { repoRoot: repo, ref: main, threads: [comment("first", repo)] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, state }));
    const read = mock.method(fs.promises, "readFile");
    try {
      const restored = await getFeedbackStore(repo, main, root);
      assert.deepStrictEqual(restored.getState(), state);
      assert.strictEqual(await getFeedbackStore(repo, main, root), restored);
      assert.strictEqual(
        read.mock.calls.filter(({ arguments: args }) => args[0] === file).length,
        1,
      );
    } finally {
      read.mock.restore();
    }
  });

  test("Immer updates preserve previous snapshots and notify only the selected value", async () => {
    await store.setState((draft) => {
      draft.threads = [comment("one")];
    });
    const before = store.getState();
    const seen: number[] = [];
    const unsubscribe = store.subscribe(
      (state) => state.threads[0].line,
      (line) => {
        seen.push(line);
      },
    );
    try {
      await store.setState((draft) => {
        draft.threads[0].activities[0].body = "edited";
      });
      assert.deepStrictEqual(seen, []);
      await store.setState((draft) => {
        draft.threads[0].line = 10;
      });
      assert.strictEqual(before.threads[0].line, 2);
      assert.strictEqual(before.threads[0].activities[0].body, "Why is this needed?");
      assert.deepStrictEqual(seen, [10]);
    } finally {
      unsubscribe();
    }
    await store.setState((draft) => {
      draft.threads[0].line = 11;
    });
    assert.deepStrictEqual(seen, [10]);
  });

  test("debounces draft updates into one disk write per bucket", async () => {
    const file = feedbackFilePath("/repo", main, root);
    const rename = mock.method(fs.promises, "rename");
    try {
      await Promise.all([
        store.setState((draft) => {
          draft.threads = [comment("one")];
        }),
        store.setState((draft) => {
          draft.threads.push(comment("two"));
        }),
        store.setState((draft) => {
          draft.threads[0].delivery = "sent";
        }),
      ]);
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
      await store.setState((draft) => {
        draft.threads = [comment("one")];
      });
      assert.strictEqual(store.getState().threads[0].id, "one");
      for (let i = 0; i < 150 && !fs.existsSync(file); i++) {
        await delay(20);
      }
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).state.threads[0].id, "one");
      assert.strictEqual(attempts, 2);
    } finally {
      rename.mock.restore();
    }
  });

  test("a corrupt bucket file keeps the initial empty state", async () => {
    const file = feedbackFilePath("/corrupt", main, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ truncated");
    const recovered = await getFeedbackStore("/corrupt", main, root);
    assert.deepStrictEqual(recovered.getState().threads, []);
  });
});

suite("feedback identity over a real repository", () => {
  let stateRoot: string;
  let store: RepoFeedbackStore;
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
    store = await getFeedbackStore(repoRoot, branch("main"), path.join(stateRoot, "feedback"));
  });

  teardown(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test("feedback left on a branch survives a commit on that branch", async () => {
    const before = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(before, { kind: "branch", value: "main" });
    await store.setState((draft) => {
      draft.threads = [comment("one", repoRoot)];
    });

    commit("two.txt");

    const after = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(after, before, "a commit does not move the branch a bucket is keyed by");
    assert.deepStrictEqual(
      (await getFeedbackStore(repoRoot, after!, path.join(stateRoot, "feedback")))
        .getState()
        .threads.map((item) => item.id),
      ["one"],
    );
  });

  test("detached feedback keeps its bucket after a commit", async () => {
    git(["checkout", "-q", "--detach"]);

    const before = await currentFeedbackRef(repoRoot);
    commit("detached.txt");
    assert.deepStrictEqual(await currentFeedbackRef(repoRoot), before);
  });
});
