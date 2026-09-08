// An agent answering feedback, over the real socket. The test sends the same protocol messages a
// plugin would, then reads the item back off the inspect seam and out of the bucket file, because a
// reply the reviewer cannot see after a reload is not a reply.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { readFile } from "node:fs/promises";

import { currentFeedbackRef } from "../git/gitCli.js";
import { PLUGIN_VERSION } from "../protocol/types.js";
import { feedbackFilePath, type FeedbackState } from "../storage/FeedbackStore.js";
import { Commands } from "../config.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  sendStopGate,
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

  /** Read the bucket bytes: the extension owns the only writer for that file. */
  async function storedItemKinds(feedbackId: string): Promise<string[]> {
    const ref = await currentFeedbackRef(repoRoot);
    assert.ok(ref);
    const saved = JSON.parse(await readFile(feedbackFilePath(repoRoot, ref), "utf8")) as {
      state: FeedbackState;
    };
    const item = saved.state.threads.find((entry) => entry.id === feedbackId);
    return (item?.items ?? []).map((activity) => activity.kind);
  }

  test("a reply lands on the item, in the window and on disk", async function () {
    this.timeout(90_000);
    const id = await queueFileComment("Rename this helper.");

    send("feedback.reply.request", "req-reply-1", {
      feedbackId: id,
      message: "Renamed it to loadSession.",
    });

    const response = await waitFor("the reply response", () =>
      wire.messages.find((m) => m.t === "feedback.reply.response" && m.id === "req-reply-1"),
    );
    assert.strictEqual(response.ok, true, String(response.message));

    const item = (await inspect()).feedback.find((entry) => entry.id === id);
    assert.deepStrictEqual(item?.itemKinds, ["reply"]);
    assert.strictEqual(item?.resolved, false, "a reply is not a resolution");
    assert.deepStrictEqual(await storedItemKinds(id), ["comment", "reply"]);
  });

  test("sending a comment settles it, and a question stays open for the reviewer", async function () {
    this.timeout(90_000);
    const comment = await queueFileComment("Please simplify.");
    const question = await queueFileComment("Why the cast here?", { kind: "question", line: 1 });

    await startReview(wire, { repoRoot, id: "send-settles" });
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    await waitFor("the review to resolve on send", () =>
      wire.messages.find((m) => m.t === "review.await.response"),
    );

    const held = (await inspect()).feedback;
    assert.strictEqual(
      held.find((entry) => entry.id === comment)?.resolved,
      true,
      "handing a comment over settles it",
    );
    assert.strictEqual(
      held.find((entry) => entry.id === question)?.resolved,
      false,
      "a question is settled by an answer the reviewer has read, not by sending it",
    );
  });

  test("a question takes a reply and stays open", async function () {
    this.timeout(90_000);
    const id = await queueFileComment("Why the cast here?", { kind: "question" });

    send("feedback.reply.request", "req-reply-question", {
      feedbackId: id,
      message: "Because the union is wider than it looks.",
    });
    const replied = await waitFor("the reply response", () =>
      wire.messages.find((m) => m.t === "feedback.reply.response" && m.id === "req-reply-question"),
    );

    assert.strictEqual(replied.ok, true, String(replied.message));
    const item = (await inspect()).feedback.find((entry) => entry.id === id);
    assert.deepStrictEqual(item?.itemKinds, ["reply"]);
    assert.strictEqual(item?.resolved, false, "only the reviewer closes a question");
  });

  // A guided review E2E left a sent-and-resolved item in the bucket after approve, so pin the rule
  // here where resolution exists: approving a review takes ALL of its feedback, history included.
  test("approve clears feedback that sending already settled", async function () {
    this.timeout(90_000);
    const warnings = stubWarnings(() => undefined);
    try {
      const id = await queueFileComment("Simplify this.");

      await startReview(wire, { repoRoot, id: "gate-resolve-send" });
      await vscode.commands.executeCommand(Commands.gateSendFeedback);
      await waitFor("the review to resolve on send", () =>
        wire.messages.find((m) => m.t === "review.await.response"),
      );

      const resolved = (await inspect()).feedback.find((f) => f.id === id);
      assert.strictEqual(resolved?.resolved, true, "the item is resolved before the approve");

      await startReview(wire, { repoRoot, id: "gate-resolve-approve" });
      await vscode.commands.executeCommand(Commands.gateApprove);

      await waitFor("the resolved item to leave the bucket", async () =>
        (await inspect()).feedback.some((f) => f.id === id) ? undefined : true,
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

  test("an agent reply parks the next stop, with no files changed", async function () {
    this.timeout(90_000);
    const id = await queueFileComment("Rename this helper.");
    await startReview(wire, { repoRoot, id: "gate-answer-1" });
    await vscode.commands.executeCommand(Commands.gateSendFeedback);
    await waitFor("the review to resolve on send", () =>
      wire.messages.find((m) => m.t === "review.await.response"),
    );

    send("feedback.reply.request", "req-answer-1", {
      feedbackId: id,
      message: "Renamed it to loadSession.",
    });
    await waitFor("the reply response", () =>
      wire.messages.find((m) => m.t === "feedback.reply.response" && m.id === "req-answer-1"),
    );

    sendStopGate(wire, { repoRoot, id: "stop-answer-1", sessionId: "answer-session" });
    await waitFor("the review to open for the answer", async () =>
      (await inspect()).reviewActive ? true : undefined,
    );

    await vscode.commands.executeCommand(Commands.gateApprove);
    await waitFor("the stop gate to answer", () =>
      wire.messages.find((m) => m.t === "stop.gate.response" && m.id === "stop-answer-1"),
    );
  });
});
