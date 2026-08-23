// Approving a plan sends the agent no trailing rules.
//
// Kiro is the harness that would want them: it runs Stop hooks once per graph run, and the plan gate
// spends that pass, so finishing the approved work emits no turn-end signal. The approval still
// cannot carry the rule that would open the review, because Kiro reads an allowed hook's stdout as a
// JSON decision and discards anything else. Rules the agent must hear therefore ride a rejection,
// which is a channel it does read.

import * as assert from "node:assert";

import { KiroStrategy } from "../harness/KiroStrategy.js";
import type { Harness } from "../protocol/types.js";
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

suite("plan approval carries no next-step rules", () => {
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

  async function approve(id: string, sessionId: string, harness: Harness): Promise<void> {
    sendPlanRequest(wire, { repoRoot, id, sessionId, harness });
    await waitForForegroundGate("plan");
    await vscode.commands.executeCommand("paireto.gate.approve");
  }

  test("Kiro declares its rules on the rejection, not the approval", async function () {
    this.timeout(90_000);
    const strategy = new KiroStrategy();
    const rules = strategy.extraPlanReviewResponseInstructions ?? [];
    assert.strictEqual(
      instructionsFor(rules, "approved").length,
      0,
      "Kiro declares no approval rule",
    );
    assert.ok(instructionsFor(rules, "rejected").length > 0, "Kiro declares a rejection rule");

    await approve("plan-approve-kiro", "sess-kiro", "kiro");
    const response = await planResponse();
    assert.strictEqual(response.decision, "allow");
    assert.strictEqual(response.reason, undefined);
  });

  test("a harness that reports its own turn end also returns none", async function () {
    this.timeout(90_000);
    await approve("plan-approve-claude", "sess-claude", "claudecode");

    const response = await planResponse();
    assert.strictEqual(response.decision, "allow");
    assert.strictEqual(response.reason, undefined);
  });
});
