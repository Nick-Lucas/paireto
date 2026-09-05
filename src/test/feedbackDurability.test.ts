// Read the bucket bytes directly because the extension and test have separate store caches.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import * as vscode from "vscode";

import { currentFeedbackRef } from "../git/gitCli.js";
import { feedbackFilePath, type FeedbackState } from "../storage/FeedbackStore.js";
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
    const file = feedbackFilePath(repoRoot, ref);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const saved = JSON.parse(raw) as { state: FeedbackState };
    return saved.state.threads.map((item) => item.id);
  }

  test("a queued comment is on disk before the window is asked again", async function () {
    this.timeout(90_000);

    const id = await queueFileComment("Rename this helper.");

    await waitFor("the comment to reach the bucket file", async () =>
      (await storedFeedback()).includes(id) ? true : undefined,
    );
  });

  test("opening an editor rehydrates feedback from disk", async function () {
    this.timeout(90_000);
    const id = await queueFileComment("Reload this feedback.");
    const ref = await currentFeedbackRef(repoRoot);
    assert.ok(ref);
    const file = feedbackFilePath(repoRoot, ref);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      state: FeedbackState;
    };
    saved.state.threads.find((model) => model.id === id)!.delivery = "sent";
    await writeFile(file, JSON.stringify(saved));
    const doc = await vscode.workspace.openTextDocument({ content: "Feedback hydration test" });
    await vscode.window.showTextDocument(doc);
    await waitFor("the editor event to reload feedback", async () =>
      (await inspect()).feedback.find((model) => model.id === id)?.delivery === "sent"
        ? true
        : undefined,
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
