import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { currentFeedbackRef } from "../git/gitCli.js";
import { repoKey } from "../protocol/paths.js";
import { FeedbackStore, type FeedbackRef } from "../storage/FeedbackStore.js";
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

  test("a corrupt bucket file reads as empty instead of throwing", async () => {
    await store.save("/repo", branch("feature/a"), [comment("one")]);
    const [name] = fs.readdirSync(path.join(feedbackRoot, repoKey("/repo")));
    fs.writeFileSync(path.join(feedbackRoot, repoKey("/repo"), name), "{ truncated");

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
