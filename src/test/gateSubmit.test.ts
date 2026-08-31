// Integration tests (VS Code Extension Host) for the palette's one-key gate action. Submit either
// sends the queued feedback or approves, and the plan's Send Feedback can raise a modal on the way.
// The command must not report done while that modal is still in front of the user: whatever the user
// does next would act on a gate they have not answered yet.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { INCLUDE_FILE_COMMENTS } from "../plan/planCodeFeedback.js";
import {
  activateForFixtureRepo,
  addPlanComment,
  openPlan,
  openWire,
  queueFileComment,
  resetWorkbench,
  waitFor,
  waitForForegroundGate,
  type Wire,
} from "./planGateHarness.js";

/** How long the file-comment modal stays up. Long enough that a command which does not wait for it
 *  returns first by a clear margin. */
const MODAL_MS = 600;

/** A modal that takes its time, so "did the command wait?" is a question the clock can answer. */
function stubSlowWarnings(reply: (message: string) => string | undefined): { restore: () => void } {
  const real = vscode.window.showWarningMessage;
  const stub = async (message: string): Promise<string | undefined> => {
    await new Promise((resolve) => setTimeout(resolve, MODAL_MS));
    return reply(message);
  };
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = stub;
  return {
    restore: () => {
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = real;
    },
  };
}

suite("submitting a gate from the palette", () => {
  let repoRoot: string;
  let wire: Wire;
  let warnings: { restore: () => void } | undefined;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    warnings?.restore();
    warnings = undefined;
    await resetWorkbench(wire);
  });

  test("submit waits for the file-comment prompt before it reports done", async function () {
    this.timeout(90_000);
    warnings = stubSlowWarnings((message) =>
      message.includes("file comment") ? INCLUDE_FILE_COMMENTS : undefined,
    );

    // A queued file comment is what makes Send Feedback ask before it answers the gate.
    await queueFileComment("Rename this file.");
    await openPlan(wire, { repoRoot, id: "plan-submit-1", sessionId: "submit-session" });
    await addPlanComment("Split step two.");

    const started = Date.now();
    await vscode.commands.executeCommand(Commands.gateSubmit);
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed >= MODAL_MS - 100,
      `submit must not report done while the modal is up (returned after ${elapsed}ms)`,
    );

    const response = await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response"),
    );
    assert.strictEqual(response.decision, "deny");
    assert.ok(
      String(response.reason).includes("Split step two."),
      `the plan comment must reach the agent: ${String(response.reason)}`,
    );
  });

  test("submit approves a plan that has no feedback", async function () {
    this.timeout(90_000);
    await openPlan(wire, { repoRoot, id: "plan-submit-2", sessionId: "submit-session" });
    await waitForForegroundGate("plan");

    await vscode.commands.executeCommand(Commands.gateSubmit);

    const response = await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response"),
    );
    assert.strictEqual(response.decision, "allow");
  });
});
