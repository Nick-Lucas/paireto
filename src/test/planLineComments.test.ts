import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { PLAN_FEEDBACK_ONLY } from "../plan/planCodeFeedback.js";
import {
  activateForFixtureRepo,
  addPlanComment,
  openPlan,
  openWire,
  resetWorkbench,
  stubWarnings,
  waitFor,
  type WarningStub,
  type Wire,
} from "./planGateHarness.js";

suite("two comments on one plan line", () => {
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

  test("each comment reaches the agent as its own item, with its own kind", async function () {
    this.timeout(90_000);
    // Another suite may have left file comments in the bucket, which makes the gate ask about them.
    // This test is about plan comments, so answer that prompt rather than cancelling the send.
    warnings = stubWarnings((message) =>
      message.includes("file comment") ? PLAN_FEEDBACK_ONLY : undefined,
    );

    await openPlan(wire, { repoRoot, id: "plan-line-1", sessionId: "two-on-one-line" });
    await addPlanComment("Split step two.", { line: 2, kind: "comment" });
    await addPlanComment("Why two steps?", { line: 2, kind: "question" });

    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    const response = await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response"),
    );

    const reason = String(response.reason);
    assert.ok(reason.includes("Split step two."), "the first comment reaches the agent");
    assert.ok(reason.includes("Why two steps?"), "so does the second");
    assert.ok(
      reason.includes("[QUESTION]") && reason.includes("[COMMENT]"),
      `each keeps its own kind: ${reason}`,
    );
    assert.ok(
      !reason.includes("Split step two. Why two steps?"),
      "the two comments are not run together into one item",
    );
  });

  test("a reply joins the comment it answers, as one item of that comment's kind", async function () {
    this.timeout(90_000);
    warnings = stubWarnings((message) =>
      message.includes("file comment") ? PLAN_FEEDBACK_ONLY : undefined,
    );

    await openPlan(wire, { repoRoot, id: "plan-line-2", sessionId: "reply-on-one-thread" });
    await addPlanComment("Split step two.", { line: 2, kind: "comment" });
    // The user types into the first comment's reply box rather than opening a second widget.
    await addPlanComment("Why two steps?", { line: 2, kind: "question", reply: true });

    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    const response = await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response"),
    );

    const reason = String(response.reason);
    assert.ok(
      reason.includes("Split step two.\n\nWhy two steps?"),
      `the reply reads as more of the same comment: ${reason}`,
    );
    assert.ok(
      reason.includes("[COMMENT]") && !reason.includes("[QUESTION]"),
      `the comment that opens the thread says what kind it is: ${reason}`,
    );
    assert.ok(reason.includes("(0 question, 1 comment)"), `one item, not two: ${reason}`);
  });
});
