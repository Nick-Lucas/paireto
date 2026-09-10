// A plan sent back for revision is kept against the agent session, so the plan that answers it opens
// as a diff and the reviewer reads only what moved. An approval ends that chain.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { PLAN_FEEDBACK_ONLY } from "../plan/planCodeFeedback.js";
import {
  activateForFixtureRepo,
  addPlanComment,
  openPlan,
  openWire,
  planTab,
  resetWorkbench,
  stubWarnings,
  waitFor,
  waitForForegroundGate,
  type WarningStub,
  type Wire,
} from "./planGateHarness.js";

const FIRST = "# Plan\n\n- Step one\n- Step two\n";
const SECOND = "# Plan\n\n- Step one\n- Step two, in halves\n";
const THIRD = "# Plan\n\n- Something else entirely\n";

suite("a revised plan opens against the plan it revises", () => {
  let repoRoot: string;
  let wire: Wire;
  let warnings: WarningStub | undefined;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
    // Another suite may have left file comments in the bucket, which makes the gate ask about them.
    warnings = stubWarnings((message) =>
      message.includes("file comment") ? PLAN_FEEDBACK_ONLY : undefined,
    );
  });

  teardown(async () => {
    warnings?.restore();
    warnings = undefined;
    await resetWorkbench(wire);
  });

  /** Comment on the open plan, send it back, and wait for the agent to be answered. */
  async function sendFeedback(id: string): Promise<void> {
    await addPlanComment("Split step two.", { line: 3, kind: "comment" });
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response" && m.id === id),
    );
    await waitFor("the answered plan to close", () => (planTab() === undefined ? true : undefined));
  }

  test("the plan sent back is the left side of the next one from that session", async function () {
    this.timeout(90_000);

    await openPlan(wire, {
      repoRoot,
      id: "plan-diff-1",
      sessionId: "revising-agent",
      markdown: FIRST,
    });
    await sendFeedback("plan-diff-1");

    const tab = await openPlan(wire, {
      repoRoot,
      id: "plan-diff-2",
      sessionId: "revising-agent",
      markdown: SECOND,
    });

    const input = tab.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, "a revision opens as a diff");
    const previous = await vscode.workspace.openTextDocument(input.original);
    const revised = await vscode.workspace.openTextDocument(input.modified);
    assert.strictEqual(previous.getText(), FIRST, "the left side is the plan already answered");
    assert.strictEqual(
      revised.getText(),
      SECOND,
      "the right side is the plan waiting for feedback",
    );
  });

  test("a plan from another session opens on its own", async function () {
    this.timeout(90_000);

    await openPlan(wire, { repoRoot, id: "plan-diff-3", sessionId: "one-agent", markdown: FIRST });
    await sendFeedback("plan-diff-3");

    const tab = await openPlan(wire, {
      repoRoot,
      id: "plan-diff-4",
      sessionId: "another-agent",
      markdown: SECOND,
    });

    assert.ok(tab.input instanceof vscode.TabInputText, "another agent's plan revises nothing");
  });

  test("an approval ends the chain, so a later plan opens on its own", async function () {
    this.timeout(90_000);

    await openPlan(wire, {
      repoRoot,
      id: "plan-diff-5",
      sessionId: "approving-agent",
      markdown: FIRST,
    });
    await sendFeedback("plan-diff-5");

    await openPlan(wire, {
      repoRoot,
      id: "plan-diff-6",
      sessionId: "approving-agent",
      markdown: SECOND,
    });
    await waitForForegroundGate("plan");
    await vscode.commands.executeCommand(Commands.gateApprove);
    await waitFor("the approved plan to close", () => (planTab() === undefined ? true : undefined));

    const tab = await openPlan(wire, {
      repoRoot,
      id: "plan-diff-7",
      sessionId: "approving-agent",
      markdown: THIRD,
    });

    assert.ok(tab.input instanceof vscode.TabInputText, "new work is not a revision");
  });
});
