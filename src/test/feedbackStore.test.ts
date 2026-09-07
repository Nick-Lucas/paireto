import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";

import { currentFeedbackRef, type FeedbackRef } from "../git/gitCli.js";
import { repoKey } from "../protocol/paths.js";
import { FeedbackStore } from "../storage/FeedbackStore.js";
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

suite("persistent feedback store", () => {
  let stateRoot: string;
  let feedbackRoot: string;
  let store: FeedbackStore;

  setup(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-"));
    feedbackRoot = path.join(stateRoot, "feedback");
    store = new FeedbackStore(feedbackRoot);
  });

  teardown(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  test("debounces writes from multiple consumers into one disk write", async () => {
    const ref = branch("main");
    const other = new FeedbackStore(feedbackRoot);
    const rename = mock.method(fs.promises, "rename");
    try {
      await Promise.all([
        store.save("/repo", ref, [comment("one")]),
        other.save("/repo", ref, [comment("two")]),
        store.save("/repo", ref, [comment("three")]),
      ]);

      const file = store.bucketPath("/repo", ref);
      assert.strictEqual(
        rename.mock.calls.filter(({ arguments: args }) => args[1] === file).length,
        1,
      );
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(file, "utf8")).state.threads.map(
          (item: ReviewThread) => item.id,
        ),
        ["three"],
      );
    } finally {
      rename.mock.restore();
    }
  });

  test("updates feedback before its first debounced write reaches disk", async () => {
    const ref = branch("main");
    const save = store.save("/repo", ref, [comment("one")]);
    const update = store.updateById("/repo", "one", (item) => ({ ...item, delivery: "sent" }));
    const [, updated] = await Promise.all([save, update]);

    assert.strictEqual(updated?.item.delivery, "sent");
    const persisted = JSON.parse(fs.readFileSync(store.bucketPath("/repo", ref), "utf8"));
    assert.strictEqual(persisted.state.threads[0].delivery, "sent");
  });

  test("clearing pending feedback does not leave a delayed write behind", async () => {
    const ref = branch("main");
    const other = new FeedbackStore(feedbackRoot);
    await Promise.all([store.save("/repo", ref, [comment("one")]), other.clear("/repo", ref)]);

    assert.deepStrictEqual(await store.load("/repo", ref), []);
    assert.strictEqual(fs.existsSync(store.bucketPath("/repo", ref)), false);
  });

  test("a failed batch rejects every save and permits a later write", async () => {
    const ref = branch("main");
    const file = store.bucketPath("/repo", ref);
    const failure = new Error("disk write failed");
    const original = fs.promises.rename;
    const rename = mock.method(
      fs.promises,
      "rename",
      async (from: fs.PathLike, to: fs.PathLike) => {
        if (to === file) {
          throw failure;
        }
        return original(from, to);
      },
    );
    try {
      const results = await Promise.allSettled([
        store.save("/repo", ref, [comment("one")]),
        store.save("/repo", ref, [comment("two")]),
      ]);
      assert.deepStrictEqual(results, [
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
    } finally {
      rename.mock.restore();
    }

    await store.save("/repo", ref, [comment("three")]);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).state.threads[0].id, "three");
  });

  test("consumers share one hydrated bucket in memory", async () => {
    const ref = branch("main");
    const file = store.bucketPath("/repo", ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        state: { repoRoot: "/repo", ref, threads: [comment("one")] },
      }),
    );
    const other = new FeedbackStore(path.relative(process.cwd(), feedbackRoot));

    const [first, second] = await Promise.all([store.load("/repo", ref), other.load("/repo", ref)]);

    assert.strictEqual(first, second);
    fs.writeFileSync(file, "{ truncated");
    assert.strictEqual(await other.load("/repo", ref), first);

    await Promise.all([
      store.updateById("/repo", "one", (item) => ({ ...item, delivery: "sent" })),
      other.updateById("/repo", "one", (item) => ({ ...item, line: 10 })),
    ]);
    const [updated] = await store.load("/repo", ref);
    assert.strictEqual(updated.delivery, "sent");
    assert.strictEqual(updated.line, 10);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).state.threads, [updated]);

    await other.clear("/repo", ref);
    assert.deepStrictEqual(await store.load("/repo", ref), []);
    assert.strictEqual(fs.existsSync(file), false);
    await store.save("/repo", ref, [comment("two")]);
    assert.deepStrictEqual(
      (await other.load("/repo", ref)).map((item) => item.id),
      ["two"],
    );
  });

  test("restores a bucket and isolates repository, branch, and detached commit", async () => {
    await store.save("/repo", branch("feature/a"), [comment("one")]);
    await store.save("/repo", branch("feature/b"), [comment("two")]);
    await store.save("/other", branch("feature/a"), [comment("three", "/other")]);
    await store.save("/repo", { kind: "commit", value: "abc123" }, [comment("four")]);

    assert.deepStrictEqual(
      (await store.load("/repo", branch("feature/a"))).map((item) => item.id),
      ["one"],
    );
    assert.deepStrictEqual(
      (await store.load("/repo", branch("feature/b"))).map((item) => item.id),
      ["two"],
    );
    assert.deepStrictEqual(
      (await store.load("/other", branch("feature/a"))).map((item) => item.id),
      ["three"],
    );
    assert.deepStrictEqual(
      (await store.load("/repo", { kind: "commit", value: "abc123" })).map((item) => item.id),
      ["four"],
    );
  });

  test("finds and updates an item in its original branch after checkout changes", async () => {
    await store.save("/repo", branch("old-branch"), [comment("target")]);
    await store.save("/repo", branch("new-branch"), []);

    const updated = await store.updateById("/repo", "target", (item) => ({
      ...item,
      activities: [
        ...item.activities,
        {
          kind: "reply",
          body: "It prevents the race.",
          at: "2026-08-12T20:01:00.000Z",
          harness: "codex",
          sessionId: "session-1",
        },
      ],
    }));

    assert.strictEqual(updated?.ref.kind, "branch");
    assert.strictEqual(updated?.ref.value, "old-branch");
    const restored = await store.load("/repo", branch("old-branch"));
    assert.strictEqual(restored[0].activities[1]?.kind, "reply");
  });

  test("does not update a matching ID in another repository", async () => {
    await store.save("/other", branch("main"), [comment("target", "/other")]);

    const updated = await store.updateById("/repo", "target", (item) => ({
      ...item,
      delivery: "sent",
    }));

    assert.strictEqual(updated, undefined);
    assert.strictEqual((await store.load("/other", branch("main")))[0].delivery, "pending");
  });

  test("clears only the selected bucket", async () => {
    await store.save("/repo", branch("feature/a"), [comment("one")]);
    await store.save("/repo", branch("feature/b"), [comment("two")]);

    await store.clear("/repo", branch("feature/a"));

    assert.deepStrictEqual(await store.load("/repo", branch("feature/a")), []);
    assert.deepStrictEqual(
      (await store.load("/repo", branch("feature/b"))).map((item) => item.id),
      ["two"],
    );
  });

  test("gives every repository and ref its own file below its repository key", async () => {
    await store.save("/repo", branch("feature/a"), [comment("one")]);
    await store.save("/repo", branch("feature/b"), [comment("two")]);
    await store.save("/other", branch("feature/a"), [comment("three", "/other")]);

    const repoFiles = fs.readdirSync(path.join(feedbackRoot, repoKey("/repo")));
    const otherFiles = fs.readdirSync(path.join(feedbackRoot, repoKey("/other")));
    assert.strictEqual(repoFiles.length, 2, "one file per ref");
    assert.strictEqual(otherFiles.length, 1);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(feedbackRoot, repoKey("/other"), otherFiles[0]), "utf8"),
    );
    assert.strictEqual(persisted.version, 1, "the Zustand store stamps its schema version");
    assert.deepStrictEqual(persisted.state.ref, { kind: "branch", value: "feature/a" });
    assert.strictEqual(persisted.state.repoRoot, "/other");
    assert.deepStrictEqual(
      persisted.state.threads.map((item: ReviewThread) => item.id),
      ["three"],
    );
  });

  test("a second window's save keeps the buckets the first window wrote", async () => {
    // Two windows are two FeedbackStore instances over the same state directory. A window that
    // rewrote the whole file from its own view of the world would drop the other window's feedback.
    const windowA = new FeedbackStore(feedbackRoot);
    const windowB = new FeedbackStore(feedbackRoot);

    await windowA.save("/repo-a", branch("feature/a"), [comment("from-a", "/repo-a")]);
    await windowB.save("/repo-b", branch("feature/b"), [comment("from-b", "/repo-b")]);
    await windowA.save("/repo-a", branch("feature/a"), [
      comment("from-a", "/repo-a"),
      comment("from-a-again", "/repo-a"),
    ]);

    assert.deepStrictEqual(
      (await windowB.load("/repo-a", branch("feature/a"))).map((item) => item.id),
      ["from-a", "from-a-again"],
    );
    assert.deepStrictEqual(
      (await windowA.load("/repo-b", branch("feature/b"))).map((item) => item.id),
      ["from-b"],
    );
  });

  test("deleting the last item of a bucket leaves no file behind", async () => {
    await store.save("/repo", branch("feature/a"), [comment("one")]);
    await store.save("/repo", branch("feature/a"), []);

    assert.deepStrictEqual(fs.readdirSync(path.join(feedbackRoot, repoKey("/repo"))), []);
    assert.deepStrictEqual(await store.load("/repo", branch("feature/a")), []);
  });

  // save() awaits Zustand's persist middleware, which returns its storage write from setState. That
  // is not a documented guarantee, so it is pinned here: no polling, no second await — if the bytes
  // are not there the moment save() resolves, every durability test above becomes a race.
  test("save resolves only once the bytes are on disk", async () => {
    const ref = branch("feature/a");
    await store.save("/repo", ref, [comment("one")]);

    const persisted = JSON.parse(fs.readFileSync(store.bucketPath("/repo", ref), "utf8"));
    assert.strictEqual(persisted.version, 1);
    assert.deepStrictEqual(
      persisted.state.threads.map((item: ReviewThread) => item.id),
      ["one"],
    );
  });

  test("an empty save resolves only once the file is gone", async () => {
    const ref = branch("feature/a");
    await store.save("/repo", ref, [comment("one")]);

    await store.save("/repo", ref, []);

    assert.strictEqual(fs.existsSync(store.bucketPath("/repo", ref)), false);
  });

  // An agent answers and resolves one item in a single turn, so two writes to one bucket are in
  // flight together. Both have to land: a rejected save is reported to the agent as lost feedback.
  test("two writes to one bucket in flight together both land", async () => {
    const ref = branch("feature/a");

    await Promise.all([
      store.save("/repo", ref, [comment("one")]),
      store.save("/repo", ref, [comment("one"), comment("two")]),
    ]);

    const ids = (await store.load("/repo", ref)).map((item) => item.id);
    assert.ok(ids.length > 0, "the bucket must not be left empty");
  });

  // Read-modify-write: without one lock over both halves the second update overwrites the first
  // with a copy it read before that change existed.
  test("concurrent updates to one bucket keep both changes", async () => {
    const ref = branch("feature/a");
    await store.save("/repo", ref, [comment("one"), comment("two")]);

    await Promise.all([
      store.updateById("/repo", "one", (item) => ({ ...item, delivery: "sent" })),
      store.updateById("/repo", "two", (item) => ({ ...item, delivery: "sent" })),
    ]);

    assert.deepStrictEqual(
      (await store.load("/repo", ref)).map((item) => item.delivery),
      ["sent", "sent"],
    );
  });

  test("a corrupt bucket file reads as empty instead of throwing", async () => {
    const file = store.bucketPath("/repo", branch("feature/a"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ truncated");

    assert.deepStrictEqual(await store.load("/repo", branch("feature/a")), []);
    assert.strictEqual(await store.updateById("/repo", "one", (item) => item), undefined);
  });
});

suite("feedback identity over a real repository", () => {
  let stateRoot: string;
  let store: FeedbackStore;
  let repoRoot: string;

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot }).toString().trim();

  const commit = (name: string): void => {
    fs.writeFileSync(path.join(repoRoot, name), `${name}\n`);
    git(["add", name]);
    git(["commit", "-q", "-m", name]);
  };

  setup(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-repo-"));
    store = new FeedbackStore(path.join(stateRoot, "feedback"));
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-feedback-git-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    commit("one.txt");
  });

  teardown(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test("feedback left on a branch survives a commit on that branch", async () => {
    const before = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(before, { kind: "branch", value: "main" });
    await store.save(repoRoot, before!, [comment("one", repoRoot)]);

    commit("two.txt");

    const after = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(after, before, "a commit does not move the branch a bucket is keyed by");
    assert.deepStrictEqual(
      (await store.load(repoRoot, after!)).map((item) => item.id),
      ["one"],
    );
  });

  test("a detached HEAD falls back to the commit it sits on", async () => {
    git(["checkout", "-q", "--detach"]);

    assert.deepStrictEqual(await currentFeedbackRef(repoRoot), {
      kind: "commit",
      value: git(["rev-parse", "HEAD"]),
    });
  });
});
