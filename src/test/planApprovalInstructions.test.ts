// Approving a plan has to carry the harness's own "what next" rules back to the agent.
//
// Kiro is the case that needs it: its agent server runs Stop hooks once per graph run, and raising
// the first plan gate spends that pass, so finishing the approved work emits no turn-end signal at
// all. The approval response is the last moment Paireto can tell the agent to open the review —
// which is why the rule has to be ON the allow, not only on a rejection.

import * as assert from "node:assert";

import { KiroStrategy } from "../harness/KiroStrategy.js";
import { instructionsFor } from "../harness/instructions.js";
import {
  activateForFixtureRepo,
  openWire,
  resetWorkbench,
  sendPlanRequest,
  waitFor,
  waitForForegroundGate,
  type Wire,
} from "./planGateHarness.js";
import * as vscode from "vscode";

suite("plan approval carries the harness's next-step rules", () => {
  let repoRoot: string;
  let wire: Wire;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    await resetWorkbench(wire);
  });

  function planResponse(): Promise<Record<string, unknown>> {
    return waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.response"),
    );
  }

  test("a Kiro approval returns the rule that reopens the loop", async function () {
    this.timeout(90_000);
    sendPlanRequest(wire, {
      repoRoot,
      id: "plan-approve-kiro",
      sessionId: "sess-kiro",
      harness: "kiro",
    });
    await waitForForegroundGate("plan");
    await vscode.commands.executeCommand("paireto.gate.approve");

    const response = await planResponse();
    assert.strictEqual(response.decision, "allow");
    const expected = instructionsFor(
      new KiroStrategy().extraPlanReviewResponseInstructions ?? [],
      "approved",
    );
    assert.ok(expected.length > 0, "Kiro declares an approval rule");
    for (const rule of expected) {
      assert.ok(
        String(response.reason ?? "").includes(rule),
        `the approval response carries "${rule}"`,
      );
    }
  });

  // Every other harness reports its own turn end, so an approval that grew a trailing rule would be
  // a change to text their cassettes already pin.
  test("a harness with no approval rule returns none", async function () {
    this.timeout(90_000);
    sendPlanRequest(wire, {
      repoRoot,
      id: "plan-approve-claude",
      sessionId: "sess-claude",
      harness: "claudecode",
    });
    await waitForForegroundGate("plan");
    await vscode.commands.executeCommand("paireto.gate.approve");

    const response = await planResponse();
    assert.strictEqual(response.decision, "allow");
    assert.strictEqual(response.reason, undefined);
  });
});
