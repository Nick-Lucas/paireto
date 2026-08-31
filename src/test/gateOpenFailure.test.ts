// Integration tests (VS Code Extension Host) for a gate whose UI fails to open. The pending answer
// is claimed before the UI goes up, so a failure on the way up has to give that slot back. Nothing
// else can: the agent waits on the socket until the controller answers it, and the review side also
// holds the single review slot, which every later review queues behind.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { ContextKeys, Schemes } from "../config.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  planTab,
  resetWorkbench,
  sendPlanRequest,
  sendReviewRequest,
  waitFor,
  waitForForegroundGate,
  type Wire,
} from "./planGateHarness.js";

/** Refuse to open the plan document, which fails the gate registration from inside foreground(). */
function refusePlanDocuments(): { restore: () => void } {
  const real = vscode.workspace.openTextDocument;
  const stub = (arg: unknown): Thenable<vscode.TextDocument> => {
    if (arg instanceof vscode.Uri && arg.scheme === Schemes.plan) {
      return Promise.reject(new Error("plan document refused"));
    }
    return (real as (a: unknown) => Thenable<vscode.TextDocument>).call(vscode.workspace, arg);
  };
  (vscode.workspace as unknown as Record<string, unknown>).openTextDocument = stub;
  return {
    restore: () => {
      (vscode.workspace as unknown as Record<string, unknown>).openTextDocument = real;
    },
  };
}

/** Fail the one setContext call the review gate makes as it comes forward. */
function refuseReviewContext(): { restore: () => void } {
  const real = vscode.commands.executeCommand;
  const stub = (command: string, ...rest: unknown[]): Thenable<unknown> => {
    if (command === "setContext" && rest[0] === ContextKeys.reviewSessionActive && rest[1]) {
      throw new Error("review context refused");
    }
    return (real as (c: string, ...r: unknown[]) => Thenable<unknown>).call(
      vscode.commands,
      command,
      ...rest,
    );
  };
  (vscode.commands as unknown as Record<string, unknown>).executeCommand = stub;
  return {
    restore: () => {
      (vscode.commands as unknown as Record<string, unknown>).executeCommand = real;
    },
  };
}

suite("a gate that cannot open", () => {
  let repoRoot: string;
  let wire: Wire;
  let stub: { restore: () => void } | undefined;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    stub?.restore();
    stub = undefined;
    await resetWorkbench(wire);
  });

  test("a plan whose tab cannot open still answers the agent", async function () {
    this.timeout(90_000);
    stub = refusePlanDocuments();

    sendPlanRequest(wire, { repoRoot, id: "plan-open-fail-1", sessionId: "open-failure" });

    const response = await waitFor("the plan gate response", () =>
      wire.messages.find((m) => m.t === "plan.review.hook.response"),
    );
    assert.strictEqual(response.decision, "deny");
    assert.ok(
      String(response.reason).includes("could not open the plan"),
      `the reason must name the failure: ${String(response.reason)}`,
    );
    await waitFor("the plan gate to clear", async () =>
      (await inspect()).gates.length === 0 ? true : undefined,
    );
    assert.strictEqual(planTab(), undefined, "no plan tab may be left behind");
  });

  test("a review whose gate cannot open releases the review slot", async function () {
    this.timeout(90_000);
    stub = refuseReviewContext();

    sendReviewRequest(wire, { repoRoot, id: "review-open-fail-1", sessionId: "open-failure" });

    const response = await waitFor("the review response", () =>
      wire.messages.find((m) => m.t === "review.await.response"),
    );
    assert.strictEqual(response.status, "cancelled");
    await waitFor("the review gate to clear", async () =>
      (await inspect()).gates.length === 0 ? true : undefined,
    );

    // The slot the failed review held is what every later review queues behind.
    stub.restore();
    stub = undefined;
    sendReviewRequest(wire, { repoRoot, id: "review-open-fail-2", sessionId: "open-failure" });
    await waitForForegroundGate("review");
  });
});
