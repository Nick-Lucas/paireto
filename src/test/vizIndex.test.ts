import * as assert from "node:assert";

import {
  buildVizIndex,
  refInStage,
  searchMatches,
  stageNumber,
  stepAt,
} from "../viz/model/index.js";
import { loadVizFixture, multiServiceIndex } from "./vizFixtures.js";

suite("viz index", () => {
  test("defaults step kind to sync and step delta to the flow delta", () => {
    const index = multiServiceIndex();
    const step = stepAt(index, { flow: "soft-decline", index: 4 });
    assert.strictEqual(step?.kind, "sync");
    assert.strictEqual(step?.delta, "added");
    assert.strictEqual(stepAt(index, { flow: "soft-decline", index: 3 })?.kind, "return");
  });

  test("carries the phase forward until the next phase starts", () => {
    const steps = multiServiceIndex().flowById.get("soft-decline")?.steps ?? [];
    assert.deepStrictEqual(
      steps.map((step) => step.phase),
      [
        "Checkout",
        "Checkout",
        "Checkout",
        "Checkout",
        "Checkout",
        "Checkout",
        "Checkout",
        "Retry",
        "Retry",
        "Retry",
        "Retry",
        "Retry",
        "Retry",
        "Settled",
      ],
    );
    assert.deepStrictEqual(
      steps.filter((step) => step.startsPhase).map((step) => step.index),
      [0, 7, 13],
    );
  });

  test("rides a step on the edge in either direction", () => {
    const index = multiServiceIndex();
    assert.strictEqual(
      stepAt(index, { flow: "soft-decline", index: 3 })?.edge,
      "billing-api>stripe",
    );
    assert.strictEqual(stepAt(index, { flow: "soft-decline", index: 0 })?.edge, undefined);
    assert.deepStrictEqual(index.stepsByEdge.get("billing-api>stripe"), [
      { flow: "soft-decline", index: 2 },
      { flow: "soft-decline", index: 3 },
    ]);
  });

  test("lists the flows each node appears in", () => {
    const index = multiServiceIndex();
    assert.deepStrictEqual(index.flowsByNode.get("retry-worker"), [
      "soft-decline",
      "final-failure",
    ]);
    assert.deepStrictEqual(index.flowsByNode.get("checkout"), ["soft-decline"]);
    assert.strictEqual(index.flowsByNode.get("legacy-dunning"), undefined);
  });

  test("derives the walkthrough stage from its refs", () => {
    const walk = multiServiceIndex().walkthrough;
    assert.deepStrictEqual(walk[0].stage, { kind: "overview" });
    assert.deepStrictEqual(walk[0].refs, [
      { kind: "node", id: "billing-api" },
      { kind: "edge", key: "billing-api>retry-queue" },
      { kind: "node", id: "retry-queue" },
    ]);
    assert.deepStrictEqual(walk[3].stage, { kind: "flow", flow: "soft-decline" });
    assert.deepStrictEqual(walk[3].refs[0], { kind: "step", flow: "soft-decline", index: 6 });
  });

  test("takes the walkthrough stage from a flow ref anywhere in the focus", () => {
    const viz = loadVizFixture("multiService");
    viz.walkthrough![3].focus = ["checkout", "soft-decline:7"];
    assert.deepStrictEqual(buildVizIndex(viz).walkthrough[3].stage, {
      kind: "flow",
      flow: "soft-decline",
    });
  });

  test("counts overview node deltas for the legend", () => {
    assert.deepStrictEqual(multiServiceIndex().deltaCounts, {
      added: 2,
      changed: 4,
      deleted: 1,
      unchanged: 2,
    });
  });

  test("points each step at the overview element it rides or touches", () => {
    const index = multiServiceIndex();
    assert.deepStrictEqual(stepAt(index, { flow: "soft-decline", index: 3 })?.overviewRef, {
      kind: "edge",
      key: "billing-api>stripe",
    });
    assert.deepStrictEqual(stepAt(index, { flow: "soft-decline", index: 0 })?.overviewRef, {
      kind: "node",
      id: "checkout",
    });
    assert.deepStrictEqual(stepAt(index, { flow: "soft-decline", index: 9 })?.overviewRef, {
      kind: "node",
      id: "retry-worker",
    });
  });

  test("numbers the overview 0 and each flow from 1", () => {
    const index = multiServiceIndex();
    assert.strictEqual(stageNumber(index, { kind: "overview" }), 0);
    assert.strictEqual(stageNumber(index, { kind: "flow", flow: "final-failure" }), 2);
  });

  test("search matches labels, roles, files and step text, case-insensitively", () => {
    const index = multiServiceIndex();
    assert.deepStrictEqual([...searchMatches(index, "Backoff")].sort(), [
      "retry-queue",
      "retry-queue>retry-worker",
      "retry-worker",
      "soft-decline",
      "soft-decline:10",
    ]);
    assert.deepStrictEqual([...searchMatches(index, "dunning.go")], ["legacy-dunning"]);
    assert.strictEqual(searchMatches(index, "   ").size, 0);
  });

  test("knows which refs belong to a stage", () => {
    const index = multiServiceIndex();
    const overview = { kind: "overview" } as const;
    const flow = { kind: "flow", flow: "soft-decline" } as const;
    assert.strictEqual(refInStage(index, { kind: "node", id: "shopper" }, overview), false);
    assert.strictEqual(refInStage(index, { kind: "node", id: "shopper" }, flow), true);
    assert.strictEqual(refInStage(index, { kind: "node", id: "notify" }, flow), false);
    assert.strictEqual(refInStage(index, { kind: "edge", key: "events>notify" }, overview), true);
    assert.strictEqual(refInStage(index, { kind: "edge", key: "events>notify" }, flow), false);
    assert.strictEqual(
      refInStage(index, { kind: "step", flow: "soft-decline", index: 1 }, flow),
      true,
    );
    assert.strictEqual(refInStage(index, { kind: "flow", id: "final-failure" }, flow), false);
  });
});
