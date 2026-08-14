// Feedback outlives the window that took it. These drive the real add-comment command against the
// fixture repository, then read the bucket file the extension wrote and reload it through a second
// FeedbackStore — the same bytes a new window would hydrate from.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";

import * as vscode from "vscode";

import { currentFeedbackRef } from "../git/gitCli.js";
import { feedbackDir } from "../protocol/paths.js";
import { FeedbackStore } from "../storage/FeedbackStore.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  resetWorkbench,
  waitFor,
  type Wire,
} from "./planGateHarness.js";

suite("feedback durability", () => {
  let repoRoot: string;
  let wire: Wire;

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot }).toString().trim();

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    await resetWorkbench(wire);
  });

  /** What a freshly opened window would read for this repository's current ref. */
  async function storedFeedback(): Promise<string[]> {
    const ref = await currentFeedbackRef(repoRoot);
    assert.ok(ref, "the fixture repository has a ref");
    const stored = await new FeedbackStore(feedbackDir()).load(repoRoot, ref);
    return stored.map((item) => item.id);
  }

  test("a queued comment is on disk before the window is asked again", async function () {
    this.timeout(90_000);

    await queueFileComment("Rename this helper.", { feedbackId: "durable-1" });

    await waitFor("the comment to reach the bucket file", async () =>
      (await storedFeedback()).includes("durable-1") ? true : undefined,
    );
  });

  test("deleting a comment takes it off disk too", async function () {
    this.timeout(90_000);

    await queueFileComment("Temporary.", { feedbackId: "durable-gone" });
    await waitFor("the comment to reach the bucket file", async () =>
      (await storedFeedback()).includes("durable-gone") ? true : undefined,
    );

    const target = (await inspect()).feedback.find((item) => item.id === "durable-gone");
    assert.ok(target, "the comment is live in the window");
    await vscode.commands.executeCommand("paireto.review.deleteComment", { id: "durable-gone" });

    await waitFor("the comment to leave the bucket file", async () =>
      (await storedFeedback()).includes("durable-gone") ? undefined : true,
    );
  });

  test("feedback left on a branch survives a commit on that branch", async function () {
    this.timeout(90_000);
    const before = await currentFeedbackRef(repoRoot);

    await queueFileComment("Still relevant after the commit.", { feedbackId: "durable-commit" });
    await waitFor("the comment to reach the bucket file", async () =>
      (await storedFeedback()).includes("durable-commit") ? true : undefined,
    );

    git(["commit", "-q", "--allow-empty", "-m", "later work"]);

    const after = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(after, before, "a commit does not move the ref a bucket is keyed by");
    assert.ok((await storedFeedback()).includes("durable-commit"));
  });
});
