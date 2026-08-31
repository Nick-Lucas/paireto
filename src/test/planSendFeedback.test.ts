// Integration tests (VS Code Extension Host) for "Send Feedback" on a plan while file comments sit
// in the bucket. The gate asks about them only when both kinds exist, and each answer leads
// somewhere different: send both, send the plan only, or answer nothing at all. Each test drives the
// real command and reads the response the agent would receive off the bridge.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { INCLUDE_FILE_COMMENTS, PLAN_FEEDBACK_ONLY } from "../plan/planCodeFeedback.js";
import {
  activateForFixtureRepo,
  addPlanComment,
  FIXTURE_FILE,
  inspect,
  openPlan,
  openWire,
  planTab,
  queueFileComment,
  resetWorkbench,
  startReview,
  stubWarnings,
  waitFor,
  type WarningStub,
  type Wire,
} from "./planGateHarness.js";

const PLAN_COMMENT = "Split step two.";
const FILE_COMMENT = "Rename this file.";

suite("plan send feedback with queued file comments", () => {
  let repoRoot: string;
  let wire: Wire;
  let warnings: WarningStub | undefined;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    warnings?.restore();
    warnings = undefined;
    await resetWorkbench(wire);
  });

  function planResponse(): Promise<Record<string, unknown>> {
    return waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response"),
    );
  }

  test("with nothing queued the plan feedback goes out without a prompt", async function () {
    this.timeout(90_000);
    warnings = stubWarnings(() => undefined);
    const prompts = warnings.seen;
    assert.strictEqual(
      (await inspect()).commentBucketCount,
      0,
      "this scenario needs an empty comment bucket",
    );

    await openPlan(wire, { repoRoot, id: "plan-send-1", sessionId: "send-plan-only" });
    await addPlanComment(PLAN_COMMENT);
    await vscode.commands.executeCommand(Commands.gateSendFeedback);

    const response = await planResponse();
    assert.strictEqual(response.decision, "deny");
    assert.ok(
      String(response.reason).includes(PLAN_COMMENT),
      "the plan feedback reaches the agent",
    );
    assert.ok(
      !prompts.some((m) => m.includes("file comment")),
      "with no file comments there is nothing to ask about",
    );
  });

  test("including the file comments sends both and empties the queue", async function () {
    this.timeout(90_000);
    warnings = stubWarnings((message) =>
      message.includes("file comment") ? INCLUDE_FILE_COMMENTS : undefined,
    );
    await queueFileComment(FILE_COMMENT);

    await openPlan(wire, { repoRoot, id: "plan-send-2", sessionId: "send-both" });
    await addPlanComment(PLAN_COMMENT);
    await vscode.commands.executeCommand(Commands.gateSendFeedback);

    const response = await planResponse();
    assert.strictEqual(response.decision, "deny");
    const reason = String(response.reason);
    assert.ok(reason.includes(PLAN_COMMENT), "the plan feedback rides in the response");
    assert.ok(reason.includes(`${FIXTURE_FILE}:1`), "the file comment rides in the response");
    assert.ok(
      reason.indexOf("The user also left comments on files.") > reason.indexOf(PLAN_COMMENT),
      "the plan block comes first, then the bridge into the file comments",
    );
    await waitFor("the file comments to clear", async () =>
      (await inspect()).commentBucketCount === 0 ? true : undefined,
    );
  });

  test("plan comments only keeps the file comments for the next code review", async function () {
    this.timeout(90_000);
    warnings = stubWarnings((message) =>
      message.includes("file comment") ? PLAN_FEEDBACK_ONLY : undefined,
    );
    await queueFileComment(FILE_COMMENT);

    await openPlan(wire, { repoRoot, id: "plan-send-3", sessionId: "send-plan-part" });
    await addPlanComment(PLAN_COMMENT);
    await vscode.commands.executeCommand(Commands.gateSendFeedback);

    const response = await planResponse();
    assert.strictEqual(response.decision, "deny");
    const reason = String(response.reason);
    assert.ok(reason.includes(PLAN_COMMENT), "the plan feedback rides in the response");
    assert.ok(!reason.includes(FIXTURE_FILE), "the file comment is held back");
    assert.strictEqual((await inspect()).commentBucketCount, 1, "the file comment stays queued");

    // What the prompt promises: the next code review still carries the comment.
    await startReview(wire, { repoRoot, id: "review-after-plan-only" });
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    const review = await waitFor("the review response", () =>
      wire.messages.find((m) => m.t === "review.await.response"),
    );
    assert.strictEqual(review.status, "submitted");
    assert.ok(
      String(review.feedback).includes(`${FIXTURE_FILE}:1`),
      "the held-back comment reaches the code review",
    );
    await waitFor("the file comments to clear", async () =>
      (await inspect()).commentBucketCount === 0 ? true : undefined,
    );
  });

  test("cancelling the prompt sends nothing and keeps the plan open", async function () {
    this.timeout(90_000);
    let answer: string | undefined; // cancelled until the drain below
    warnings = stubWarnings((message) => (message.includes("file comment") ? answer : undefined));
    const prompts = warnings.seen;
    await queueFileComment(FILE_COMMENT);

    await openPlan(wire, { repoRoot, id: "plan-send-4", sessionId: "send-cancelled" });
    await addPlanComment(PLAN_COMMENT);
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    await waitFor("the file-comment prompt", () =>
      prompts.some((m) => m.includes("file comment")) ? true : undefined,
    );

    assert.strictEqual(
      wire.messages.some((m) => m.t === "plan.review.hook.response"),
      false,
      "a cancelled prompt must leave the plan gate pending",
    );
    assert.strictEqual((await inspect()).commentBucketCount, 1, "the file comment stays queued");
    assert.ok(planTab(), "the plan stays open for another attempt");

    // Nothing was lost: the same command with an answer sends both sets.
    answer = INCLUDE_FILE_COMMENTS;
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    const response = await planResponse();
    const reason = String(response.reason);
    assert.ok(reason.includes(PLAN_COMMENT), "the plan comment survived the cancel");
    assert.ok(reason.includes(`${FIXTURE_FILE}:1`), "the file comment survived the cancel");
    await waitFor("the file comments to clear", async () =>
      (await inspect()).commentBucketCount === 0 ? true : undefined,
    );
  });
});
