// Integration tests (VS Code Extension Host) for answering a gate the moment it takes the
// foreground. A gate becomes clickable while its UI is still opening — the plan tab and the review
// panels come up inside the registration the controller is still awaiting. The answer must reach the
// agent from that first moment: a dropped one leaves the agent blocked with no sign anything failed.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  resetWorkbench,
  sendPlanRequest,
  sendReviewRequest,
  waitFor,
  waitForForegroundGate,
  type Wire,
} from "./planGateHarness.js";

suite("answering a gate as it opens", () => {
  let repoRoot: string;
  let wire: Wire;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    await resetWorkbench(wire);
  });

  test("a plan approved as it comes forward answers the agent", async function () {
    this.timeout(90_000);
    sendPlanRequest(wire, { repoRoot, id: "plan-race-1", sessionId: "answer-as-it-opens" });
    await waitForForegroundGate("plan");

    await vscode.commands.executeCommand(Commands.gateApprove);

    const response = await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response"),
    );
    assert.strictEqual(response.decision, "allow");
    await waitFor("the plan gate to clear", async () =>
      (await inspect()).gates.length === 0 ? true : undefined,
    );
  });

  test("a review approved as it comes forward answers the agent", async function () {
    this.timeout(90_000);
    sendReviewRequest(wire, { repoRoot, id: "review-race-1", sessionId: "answer-as-it-opens" });
    await waitForForegroundGate("review");

    await vscode.commands.executeCommand(Commands.gateApprove);

    const response = await waitFor("the review response", () =>
      wire.messages.find((m) => m.t === "review.await.response"),
    );
    assert.strictEqual(response.status, "cancelled"); // approve = proceed with no feedback
    await waitFor("the review gate to clear", async () =>
      (await inspect()).gates.length === 0 ? true : undefined,
    );
  });
});
