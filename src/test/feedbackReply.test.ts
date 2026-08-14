// An agent answering feedback, over the real socket. The test sends the same protocol messages a
// plugin would, then reads the item back off the inspect seam and out of the bucket file, because a
// reply the reviewer cannot see after a reload is not a reply.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { currentFeedbackRef } from "../git/gitCli.js";
import { feedbackDir } from "../protocol/paths.js";
import { PLUGIN_VERSION } from "../protocol/types.js";
import { FeedbackStore } from "../storage/FeedbackStore.js";
import { Commands } from "../config.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  startReview,
  stubWarnings,
  resetWorkbench,
  waitFor,
  type Wire,
} from "./planGateHarness.js";

suite("agent replies to feedback", () => {
  let repoRoot: string;
  let wire: Wire;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    await resetWorkbench(wire);
  });

  function send(t: string, id: string, extra: Record<string, unknown>): void {
    wire.send({
      t,
      v: PLUGIN_VERSION,
      id,
      ts: new Date().toISOString(),
      harness: "claudecode",
      repoRoot,
      ...extra,
    });
  }

  async function storedActivity(feedbackId: string): Promise<string[]> {
    const ref = await currentFeedbackRef(repoRoot);
    assert.ok(ref);
    const stored = await new FeedbackStore(feedbackDir()).load(repoRoot, ref);
    const item = stored.find((entry) => entry.id === feedbackId);
    return (item?.activities ?? []).map((activity) => activity.kind);
  }

  test("a reply lands on the item, in the window and on disk", async function () {
    this.timeout(90_000);
    await queueFileComment("Rename this helper.", { feedbackId: "reply-1" });

    send("feedback.reply.request", "req-reply-1", {
      feedbackId: "reply-1",
      message: "Renamed it to loadSession.",
    });

    const response = await waitFor("the reply response", () =>
      wire.messages.find((m) => m.t === "feedback.reply.response" && m.id === "req-reply-1"),
    );
    assert.strictEqual(response.ok, true, String(response.message));

    const item = (await inspect()).feedback.find((entry) => entry.id === "reply-1");
    assert.deepStrictEqual(item?.activityKinds, ["reply"]);
    assert.strictEqual(item?.resolved, false, "a reply is not a resolution");
    assert.deepStrictEqual(await storedActivity("reply-1"), ["feedback", "reply"]);
  });

  test("resolving marks the item resolved and is idempotent", async function () {
    this.timeout(90_000);
    await queueFileComment("Please simplify.", { feedbackId: "resolve-1" });

    send("feedback.resolve.request", "req-resolve-1", { feedbackId: "resolve-1" });
    await waitFor("the resolve response", () =>
      wire.messages.find((m) => m.t === "feedback.resolve.response" && m.id === "req-resolve-1"),
    );
    send("feedback.resolve.request", "req-resolve-2", { feedbackId: "resolve-1" });
    const second = await waitFor("the second resolve response", () =>
      wire.messages.find((m) => m.t === "feedback.resolve.response" && m.id === "req-resolve-2"),
    );

    assert.strictEqual(second.ok, true, "resolving twice is not an error");
    const item = (await inspect()).feedback.find((entry) => entry.id === "resolve-1");
    assert.strictEqual(item?.resolved, true);
    assert.deepStrictEqual(item?.activityKinds, ["resolved"], "the second resolve adds nothing");
  });

  // A guided review E2E left a sent-and-resolved item in the bucket after approve, so pin the rule
  // here where resolution exists: approving a review takes ALL of its feedback, history included.
  test("approve clears feedback the agent has already resolved", async function () {
    this.timeout(90_000);
    const warnings = stubWarnings(() => undefined);
    try {
      await queueFileComment("Simplify this.", { feedbackId: "approve-resolved" });

      await startReview(wire, { repoRoot, id: "gate-resolve-send" });
      await vscode.commands.executeCommand(Commands.gateSendFeedback);
      await waitFor("the review to resolve on send", () =>
        wire.messages.find((m) => m.t === "review.await.response"),
      );

      send("feedback.resolve.request", "req-approve-resolved", { feedbackId: "approve-resolved" });
      await waitFor("the resolve response", () =>
        wire.messages.find(
          (m) => m.t === "feedback.resolve.response" && m.id === "req-approve-resolved",
        ),
      );
      const resolved = (await inspect()).feedback.find((f) => f.id === "approve-resolved");
      assert.strictEqual(resolved?.resolved, true, "the item is resolved before the approve");

      await startReview(wire, { repoRoot, id: "gate-resolve-approve" });
      await vscode.commands.executeCommand(Commands.gateApprove);

      await waitFor("the resolved item to leave the bucket", async () =>
        (await inspect()).feedback.some((f) => f.id === "approve-resolved") ? undefined : true,
      );
    } finally {
      warnings.restore();
    }
  });

  test("an unknown feedback id is reported, not silently accepted", async function () {
    this.timeout(90_000);

    send("feedback.reply.request", "req-missing", {
      feedbackId: "no-such-feedback",
      message: "Done.",
    });

    const response = await waitFor("the reply response", () =>
      wire.messages.find((m) => m.t === "feedback.reply.response" && m.id === "req-missing"),
    );
    assert.strictEqual(response.ok, false);
    assert.match(String(response.message), /not found/i);
  });
});
