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
  stubWarnings,
  waitFor,
  type WarningStub,
  type Wire,
} from "./planGateHarness.js";

suite("feedback durability", () => {
  let repoRoot: string;
  let wire: Wire;
  let warnings: WarningStub | undefined;

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot }).toString().trim();

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    warnings?.restore();
    warnings = undefined;
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

    const id = await queueFileComment("Rename this helper.");

    await waitFor("the comment to reach the bucket file", async () =>
      (await storedFeedback()).includes(id) ? true : undefined,
    );
  });

  test("deleting a comment takes it off disk too", async function () {
    this.timeout(90_000);
    // Deleting from the sidebar asks first, so answer the dialog the command raises.
    warnings = stubWarnings(() => "Delete");

    const id = await queueFileComment("Temporary.");
    await waitFor("the comment to reach the bucket file", async () =>
      (await storedFeedback()).includes(id) ? true : undefined,
    );

    const target = (await inspect()).feedback.find((item) => item.id === id);
    assert.ok(target, "the comment is live in the window");
    await vscode.commands.executeCommand("paireto.review.deleteComment", { id });

    await waitFor("the comment to leave the bucket file", async () =>
      (await storedFeedback()).includes(id) ? undefined : true,
    );
  });

  test("feedback left on a branch survives a commit on that branch", async function () {
    this.timeout(90_000);
    const before = await currentFeedbackRef(repoRoot);

    const id = await queueFileComment("Still relevant after the commit.");
    await waitFor("the comment to reach the bucket file", async () =>
      (await storedFeedback()).includes(id) ? true : undefined,
    );

    git(["commit", "-q", "--allow-empty", "-m", "later work"]);

    const after = await currentFeedbackRef(repoRoot);
    assert.deepStrictEqual(after, before, "a commit does not move the ref a bucket is keyed by");
    assert.ok((await storedFeedback()).includes(id));
  });
});
