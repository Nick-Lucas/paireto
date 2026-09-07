import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { workingTreeFingerprint } from "../git/workingTreeFingerprint.js";
import type { AppEvent } from "../harness/appEvent.js";
import { TurnReviewState } from "../review/TurnReviewState.js";

const prompt: AppEvent = {
  kind: "userPromptSubmit",
  sessionId: "agent",
  harness: "codex",
  backgroundTaskCount: 0,
  sessionCronCount: 0,
};

suite("Central turn review state", () => {
  test("compares Git state against the turn-start snapshot", async () => {
    let fingerprint = "existing dirty files";
    const turns = new TurnReviewState(
      () => ["/repo"],
      async () => fingerprint,
    );
    turns.observe(prompt, "/repo");
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), false);
    fingerprint = "agent edited a dirty file";
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), true);
    turns.observe(prompt, "/repo");
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), false);
  });

  test("waits for a pending turn-start snapshot", async () => {
    let finish!: (value: string) => void;
    let calls = 0;
    const turns = new TurnReviewState(
      () => ["/repo"],
      () =>
        ++calls === 1
          ? new Promise<string>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve("after"),
    );
    turns.observe(prompt, "/repo");
    const changed = turns.changedSinceStart("agent", "/repo");
    assert.strictEqual(calls, 1);
    finish("before");
    assert.strictEqual(await changed, true);
  });

  test("after a review only further Git changes count, even without a new prompt", async () => {
    let fingerprint = "before";
    const turns = new TurnReviewState(
      () => ["/repo"],
      async () => fingerprint,
    );
    turns.observe(prompt, "/repo");
    fingerprint = "reviewed files";
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), true);
    await turns.resetBaseline("agent", "/repo");
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), false);
    fingerprint = "further edits";
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), true);
  });

  test("resetBaseline settles only once the new snapshot is in place", async () => {
    let finish!: (value: string) => void;
    let calls = 0;
    const turns = new TurnReviewState(
      () => ["/repo"],
      () =>
        ++calls === 1
          ? Promise.resolve("before")
          : new Promise<string>((resolve) => {
              finish = resolve;
            }),
    );
    await turns.resetBaseline("agent", "/repo");
    let settled = false;
    const reset = turns.resetBaseline("agent", "/repo").then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.strictEqual(settled, false, "the agent must not resume while the snapshot is pending");
    finish("after the review");
    await reset;
    assert.strictEqual(settled, true);
  });

  test("detects a change in any repository the review covers", async () => {
    const fingerprints = new Map([
      ["/a", "a1"],
      ["/b", "b1"],
    ]);
    const turns = new TurnReviewState(
      () => ["/a", "/b"],
      async (root) => fingerprints.get(root) ?? "",
    );
    turns.observe(prompt, "/a");
    assert.strictEqual(await turns.changedSinceStart("agent", "/a"), false);
    fingerprints.set("/b", "b2");
    assert.strictEqual(
      await turns.changedSinceStart("agent", "/a"),
      true,
      "an agent in one repository can edit another one the review shows",
    );
  });

  test("covers the agent's own repository even when the window lists none", async () => {
    let fingerprint = "before";
    const turns = new TurnReviewState(
      () => [],
      async () => fingerprint,
    );
    turns.observe(prompt, "/repo");
    fingerprint = "after";
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), true);
  });

  test("a repository whose snapshot fails does not hide the others", async () => {
    let fingerprint = "b1";
    const turns = new TurnReviewState(
      () => ["/a", "/b"],
      async (root) => {
        if (root === "/a") {
          throw new Error("git is gone");
        }
        return fingerprint;
      },
    );
    turns.observe(prompt, "/b");
    assert.strictEqual(await turns.changedSinceStart("agent", "/b"), false);
    fingerprint = "b2";
    assert.strictEqual(await turns.changedSinceStart("agent", "/b"), true);
  });

  test("a subagent prompt cannot reset the parent baseline", async () => {
    let fingerprint = "before";
    const turns = new TurnReviewState(
      () => ["/repo"],
      async () => fingerprint,
    );
    turns.observe(prompt, "/repo");
    fingerprint = "after";
    turns.observe({ ...prompt, agentId: "child" }, "/repo");
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), true);
  });

  test("forgets a session whose process is gone", async () => {
    let fingerprint = "before";
    const turns = new TurnReviewState(
      () => ["/repo"],
      async () => fingerprint,
    );
    turns.observe(prompt, "/repo");
    turns.forget("agent");
    fingerprint = "after";
    assert.strictEqual(await turns.changedSinceStart("agent", "/repo"), false);
  });
});

suite("Central Git turn comparison", () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-turn-"));
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await fs.writeFile(path.join(root, "tracked"), "original");
    git("add", "tracked");
    git("commit", "-m", "fixture");
  });
  teardown(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const change of ["edit", "create", "delete", "rename", "binary", "commit"]) {
    test(`detects ${change}`, async () => {
      const before = await workingTreeFingerprint(root);
      const tracked = path.join(root, "tracked");
      if (change === "delete") {
        await fs.unlink(tracked);
      } else if (change === "rename") {
        await fs.rename(tracked, path.join(root, "renamed"));
      } else if (change === "binary") {
        await fs.writeFile(tracked, Buffer.from([0, 255, 1]));
      } else {
        await fs.writeFile(path.join(root, change === "create" ? "new" : "tracked"), "changed");
      }
      if (change === "commit") {
        git("add", "tracked");
        git("commit", "-m", "agent edit");
      }
      assert.notStrictEqual(await workingTreeFingerprint(root), before);
    });
  }

  test("existing changes stay equal, including when an untracked file is staged", async () => {
    await fs.writeFile(path.join(root, "tracked"), "dirty");
    await fs.writeFile(path.join(root, "new"), "existing");
    const before = await workingTreeFingerprint(root);
    assert.strictEqual(await workingTreeFingerprint(root), before);
    git("add", "new");
    assert.strictEqual(await workingTreeFingerprint(root), before);
    await fs.writeFile(path.join(root, "new"), "edited");
    assert.notStrictEqual(await workingTreeFingerprint(root), before);
  });

  test("compares files before the first commit", async () => {
    await fs.rm(path.join(root, ".git"), { recursive: true });
    git("init");
    const before = await workingTreeFingerprint(root);
    await fs.writeFile(path.join(root, "new"), "new");
    assert.notStrictEqual(await workingTreeFingerprint(root), before);
  });

  test("a touched file is a change, even with the same content", async () => {
    const file = path.join(root, "tracked");
    const pinned = new Date(1_700_000_000_000);
    await fs.writeFile(file, "dirty");
    await fs.utimes(file, pinned, pinned);
    const before = await workingTreeFingerprint(root);
    await fs.utimes(file, pinned, new Date(pinned.getTime() + 1000));
    assert.notStrictEqual(await workingTreeFingerprint(root), before);
  });

  test("a same-timestamp edit of a different size is a change", async () => {
    const file = path.join(root, "tracked");
    const pinned = new Date(1_700_000_000_000);
    await fs.writeFile(file, "aaaa");
    await fs.utimes(file, pinned, pinned);
    const before = await workingTreeFingerprint(root);
    await fs.writeFile(file, "bbbbb");
    await fs.utimes(file, pinned, pinned);
    assert.notStrictEqual(await workingTreeFingerprint(root), before);
  });

  test("detects a change to the file a symlink points at", async () => {
    // The target must be one Git does not list by itself, or its own entry would carry the change.
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    git("add", ".gitignore");
    git("commit", "-m", "ignore");
    await fs.writeFile(path.join(root, "ignored.txt"), "one");
    await fs.symlink("ignored.txt", path.join(root, "link"));

    const before = await workingTreeFingerprint(root);
    await fs.writeFile(path.join(root, "ignored.txt"), "two!");
    assert.notStrictEqual(await workingTreeFingerprint(root), before);
  });

  test("a symlink out of the repository is compared by its path alone", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-outside-"));
    try {
      const target = path.join(outside, "file");
      await fs.writeFile(target, "one");
      await fs.symlink(target, path.join(root, "link"));

      const before = await workingTreeFingerprint(root);
      await fs.writeFile(target, "two!");
      assert.strictEqual(await workingTreeFingerprint(root), before);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("detects an edit inside an already dirty submodule", async () => {
    const sub = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-sub-"));
    const inSub = (...args: string[]) =>
      execFileSync("git", ["-C", sub, ...args], { stdio: "ignore" });
    try {
      inSub("init");
      inSub("config", "user.email", "test@example.com");
      inSub("config", "user.name", "Test");
      await fs.writeFile(path.join(sub, "file"), "original");
      inSub("add", "file");
      inSub("commit", "-m", "submodule fixture");
      git("-c", "protocol.file.allow=always", "submodule", "add", sub, "sub");
      git("commit", "-m", "add submodule");

      const nested = path.join(root, "sub", "file");
      await fs.writeFile(nested, "dirty before the turn");
      const before = await workingTreeFingerprint(root);
      await fs.writeFile(nested, "edited during the turn");
      assert.notStrictEqual(await workingTreeFingerprint(root), before);
    } finally {
      await fs.rm(sub, { recursive: true, force: true });
    }
  });

  test("an unreadable path does not abort the snapshot", async () => {
    await fs.mkdir(path.join(root, "d"));
    await fs.writeFile(path.join(root, "d", "f"), "nested");
    git("add", "d/f");
    git("commit", "-m", "nested");
    // The directory becomes a file, so Git still lists `d/f` but reading it fails with ENOTDIR.
    await fs.rm(path.join(root, "d"), { recursive: true });
    await fs.writeFile(path.join(root, "d"), "now a file");

    const before = await workingTreeFingerprint(root);
    await fs.writeFile(path.join(root, "tracked"), "changed");
    assert.notStrictEqual(
      await workingTreeFingerprint(root),
      before,
      "one unreadable path must not stop the rest of the tree being compared",
    );
  });
});
