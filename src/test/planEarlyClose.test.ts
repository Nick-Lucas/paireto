// Integration test (VS Code Extension Host) for the plan gate's early-close path when file comments
// are queued. Closing the plan tab asks for an outcome; choosing Send Feedback then asks whether to
// carry the file comments. Cancelling that second modal answers nothing, so the plan document must
// come back — the tab is already gone and there is no other way to reach a foreground plan.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { INCLUDE_FILE_COMMENTS } from "../plan/planCodeFeedback.js";
import {
  activateForFixtureRepo,
  addPlanComment,
  inspect,
  openPlan,
  openWire,
  planTab,
  queueFileComment,
  resetWorkbench,
  stubWarnings,
  waitFor,
  type WarningStub,
  type Wire,
} from "./planGateHarness.js";

const PLAN_REQUEST_ID = "plan-early-close-1";

suite("plan early close with queued file comments", () => {
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

  test("cancelling the file-comment prompt brings the plan document back", async function () {
    this.timeout(90_000);
    // The first answer cancels the file-comment prompt; the second sends everything.
    const codeAnswers: (string | undefined)[] = [undefined, INCLUDE_FILE_COMMENTS];
    warnings = stubWarnings((message) => {
      if (message.includes("still waiting on this plan")) {
        return "Send Feedback";
      }
      if (message.includes("file comment")) {
        return codeAnswers.shift();
      }
      return undefined;
    });

    // A file comment queued outside any review session: this is what makes the gate ask.
    await queueFileComment("Rename this file.");

    const tab = await openPlan(wire, {
      repoRoot,
      id: PLAN_REQUEST_ID,
      sessionId: "early-close-session",
    });
    await addPlanComment("Split step two.");

    await vscode.window.tabGroups.close(tab);
    await waitFor("the file-comment prompt", () =>
      warnings!.seen.some((m) => m.includes("file comment")) ? true : undefined,
    );

    const reopened = await waitFor("the plan document to come back", () => planTab());
    assert.ok(reopened, "cancelling the prompt must reopen the plan");
    assert.strictEqual(
      wire.messages.some((m) => m.t === "plan.review.response"),
      false,
      "a cancelled prompt must leave the plan gate pending",
    );

    // The gate is still usable: sending again, this time including the file comments, resolves it.
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    const response = await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.response"),
    );
    assert.strictEqual(response.decision, "deny");
    const reason = String(response.reason);
    assert.ok(reason.includes("Split step two."), "the plan feedback rides in the response");
    assert.ok(reason.includes("notes.txt"), "the file comment rides in the response");
    await waitFor("the file comments to clear", async () =>
      (await inspect()).commentBucketCount === 0 ? true : undefined,
    );
  });

  test("send feedback with no plan comments means the file comments stay queued", async function () {
    this.timeout(90_000);
    warnings = stubWarnings((message) =>
      message.includes("still waiting on this plan") ? "Send Feedback" : undefined,
    );

    await queueFileComment("Rename this file.");
    const tab = await openPlan(wire, {
      repoRoot,
      id: `${PLAN_REQUEST_ID}-refusal`,
      sessionId: "early-close-session",
    });

    await vscode.window.tabGroups.close(tab);

    const refusal = await waitFor("the refusal message", () =>
      warnings!.seen.find((m) => m.includes("No plan comments to send")),
    );
    assert.ok(
      refusal.includes("stay queued"),
      `the refusal must say the file comments survive: ${refusal}`,
    );
    const reopened = await waitFor("the plan document to come back", () => planTab());
    assert.ok(reopened, "a refusal answers nothing, so the plan must come back");
    assert.strictEqual(
      wire.messages.some((m) => m.t === "plan.review.response"),
      false,
      "a refusal must leave the plan gate pending",
    );
  });
});
