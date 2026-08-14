// What a review gate is responsible for. Approving means "nothing to change here", so it refuses
// while feedback is waiting to be sent, and takes the buckets it opened with away when it succeeds.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  resetWorkbench,
  startReview,
  stubWarnings,
  waitFor,
  type WarningStub,
  type Wire,
} from "./planGateHarness.js";

suite("review gate feedback rules", () => {
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

  test("approve refuses while feedback is still waiting to be sent", async function () {
    this.timeout(90_000);
    warnings = stubWarnings(() => undefined);
    await queueFileComment("Please rename this.", { feedbackId: "gate-pending" });

    await startReview(wire, { repoRoot, id: "gate-approve-refused" });
    await vscode.commands.executeCommand(Commands.gateApprove);

    assert.ok(
      warnings.seen.some((m) => m.includes("has not been sent")),
      `the reviewer is told why: ${warnings.seen.join(" | ")}`,
    );
    assert.strictEqual(
      wire.messages.some((m) => m.t === "review.await.response"),
      false,
      "a refused approve leaves the gate open",
    );
    const item = (await inspect()).feedback.find((f) => f.id === "gate-pending");
    assert.strictEqual(item?.delivery, "pending", "the feedback is untouched");
  });

  test("approve clears the buckets the review opened with once nothing is pending", async function () {
    this.timeout(90_000);
    warnings = stubWarnings(() => undefined);
    await queueFileComment("Deliver me.", { feedbackId: "gate-delivered" });

    await startReview(wire, { repoRoot, id: "gate-send" });
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    await waitFor("the review to resolve on send", () =>
      wire.messages.find((m) => m.t === "review.await.response"),
    );

    // The delivered item is still held, so a second review can approve it away.
    await startReview(wire, { repoRoot, id: "gate-approve" });
    await vscode.commands.executeCommand(Commands.gateApprove);

    await waitFor("the bucket to empty on approve", async () =>
      (await inspect()).feedback.some((f) => f.id === "gate-delivered") ? undefined : true,
    );
  });
});
