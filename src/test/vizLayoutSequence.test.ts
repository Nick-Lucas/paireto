import * as assert from "node:assert";

import { layoutSequence, SEQ } from "../viz/layout/sequence.js";
import { multiServiceIndex, singleFrontendIndex } from "./vizFixtures.js";

suite("viz sequence layout", () => {
  test("places participants as equal columns in flow order", () => {
    const scene = layoutSequence(multiServiceIndex(), "soft-decline");
    assert.deepStrictEqual(
      scene.participants.map((p) => p.id),
      [
        "shopper",
        "checkout",
        "billing-api",
        "stripe",
        "retry-queue",
        "retry-worker",
        "payments-db",
      ],
    );
    const pitch = scene.participants[1].x - scene.participants[0].x;
    for (let i = 1; i < scene.participants.length; i++) {
      assert.strictEqual(scene.participants[i].x - scene.participants[i - 1].x, pitch);
      assert.strictEqual(scene.participants[i].width, SEQ.columnWidth);
    }
    assert.ok(pitch >= SEQ.columnWidth + SEQ.minGap);
    assert.strictEqual(scene.bounds.width, scene.participants[6].x + SEQ.columnWidth + SEQ.pad);
  });

  test("rows advance by a fixed pitch, with a taller row for a self step and room for a phase band", () => {
    const scene = layoutSequence(multiServiceIndex(), "soft-decline");
    const y = scene.messages.map((m) => m.lineY);
    assert.strictEqual(y[1] - y[0], SEQ.pitch);
    assert.strictEqual(y[10] - y[9], SEQ.selfPitch);
    assert.strictEqual(y[8] - y[7], SEQ.pitch);
    assert.strictEqual(y[7] - y[6], SEQ.pitch + SEQ.phaseHeight + SEQ.phaseGap);
    assert.deepStrictEqual(
      scene.phases.map((phase) => [phase.label, phase.firstStep]),
      [
        ["Checkout", 0],
        ["Retry", 7],
        ["Settled", 13],
      ],
    );
    for (const phase of scene.phases) {
      assert.strictEqual(phase.width, scene.bounds.width);
      assert.ok(
        phase.y + phase.height < scene.messages[phase.firstStep].lineY - SEQ.messageHeight / 2,
      );
    }
  });

  test("draws a self step as a loop box to the right of the lifeline", () => {
    const scene = layoutSequence(multiServiceIndex(), "soft-decline");
    const self = scene.messages[9];
    assert.strictEqual(self.direction, "self");
    assert.strictEqual(self.step.label, "backoff check");
    const worker = scene.participants.find((p) => p.id === "retry-worker")!;
    assert.ok(self.x >= worker.lifelineX, "loop starts at or right of the lifeline");
    assert.ok(self.width > SEQ.selfWidth);
  });

  test("messages run between lifelines with a direction", () => {
    const scene = layoutSequence(singleFrontendIndex(), "edit-rollback");
    const first = scene.messages[0];
    assert.strictEqual(first.direction, "right");
    assert.ok(first.toX > first.fromX);
    const back = scene.messages[6];
    assert.strictEqual(back.direction, "left");
    assert.strictEqual(back.step.kind, "return");
    assert.ok(back.toX < back.fromX);
    assert.strictEqual(back.x, Math.min(back.fromX, back.toX));
    assert.strictEqual(back.width, Math.abs(back.fromX - back.toX));
  });

  test("a sync call opens an activation that its return closes", () => {
    const scene = layoutSequence(multiServiceIndex(), "soft-decline");
    const y = scene.messages.map((m) => m.lineY);
    const stripe = scene.activations.find(
      (bar) => bar.participant === "stripe" && bar.opener === 2,
    );
    assert.ok(stripe, "charge opens stripe");
    assert.strictEqual(stripe.y, y[2]);
    assert.strictEqual(stripe.y + stripe.height, y[3]);
    const billing = scene.activations.find(
      (bar) => bar.participant === "billing-api" && bar.opener === 1,
    );
    assert.ok(billing, "POST /charges opens billing-api");
    assert.strictEqual(billing.y + billing.height, y[6]);
    assert.strictEqual(billing.depth, 0);
  });

  test("the next step from the caller closes a call that never returns, and async opens nothing", () => {
    const scene = layoutSequence(multiServiceIndex(), "soft-decline");
    const y = scene.messages.map((m) => m.lineY);
    const insert = scene.activations.find(
      (bar) => bar.participant === "payments-db" && bar.opener === 4,
    );
    assert.ok(insert, "insert attempt opens payments-db");
    assert.strictEqual(insert.y + insert.height, y[5]);
    assert.strictEqual(
      scene.activations.some((bar) => bar.opener === 5),
      false,
    );
    assert.strictEqual(
      scene.activations.some((bar) => bar.opener === 8),
      false,
    );
  });

  test("a call still open at the end closes at the bottom of the lifelines", () => {
    const scene = layoutSequence(multiServiceIndex(), "soft-decline");
    const markPaid = scene.activations.find(
      (bar) => bar.participant === "payments-db" && bar.opener === 12,
    );
    assert.ok(markPaid);
    assert.strictEqual(markPaid.y + markPaid.height, scene.lifelineBottom - SEQ.pad);
  });

  test("nested calls stack with a depth offset", () => {
    const scene = layoutSequence(singleFrontendIndex(), "edit-rollback");
    const editor = scene.activations.find(
      (bar) => bar.participant === "comment-editor" && bar.opener === 0,
    )!;
    const hook = scene.activations.find(
      (bar) => bar.participant === "use-edit-comment" && bar.opener === 1,
    )!;
    assert.ok(editor && hook);
    assert.strictEqual(hook.depth, 0);
    assert.ok(hook.y > editor.y);
    assert.ok(hook.y + hook.height <= editor.y + editor.height);
  });

  test("an unknown flow gives an empty scene", () => {
    const scene = layoutSequence(multiServiceIndex(), "missing");
    assert.strictEqual(scene.participants.length, 0);
    assert.strictEqual(scene.messages.length, 0);
  });
});
