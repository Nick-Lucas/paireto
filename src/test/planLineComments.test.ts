// Two comments on ONE line of a plan. Each is its own thread and its own feedback item, so the agent
// receives both as written instead of one run-together sentence. Drives the real plan gate over the
// bridge socket and reads the reason the agent would actually get.

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
});
