import * as assert from "node:assert";

import { initialUi, reduceUi, type UiAction, type UiState } from "../viz/model/ui.js";
import type { VizIndex } from "../viz/model/index.js";
import { multiServiceIndex } from "./vizFixtures.js";

const index: VizIndex = multiServiceIndex();
const FLOW = { kind: "flow", flow: "soft-decline" } as const;

function run(...actions: UiAction[]): UiState {
  return actions.reduce((ui, action) => reduceUi(index, ui, action), initialUi());
}

suite("viz ui reducer", () => {
  test("starts in explore on the overview with every delta shown", () => {
    const ui = initialUi();
    assert.deepStrictEqual(ui.stage, { kind: "overview" });
    assert.deepStrictEqual(ui.mode, { kind: "explore" });
    assert.deepStrictEqual([...ui.deltaFilter].sort(), [
      "added",
      "changed",
      "deleted",
      "unchanged",
    ]);
  });

  test("digits pick the stage and an out-of-range digit is ignored", () => {
    assert.deepStrictEqual(run({ type: "stageAt", n: 2 }).stage, {
      kind: "flow",
      flow: "final-failure",
    });
    assert.deepStrictEqual(run({ type: "stageAt", n: 2 }, { type: "stageAt", n: 0 }).stage, {
      kind: "overview",
    });
    assert.deepStrictEqual(run({ type: "stageAt", n: 7 }).stage, { kind: "overview" });
  });

  test("a stage change keeps a node selection that exists there and drops the rest", () => {
    const kept = run(
      { type: "select", ref: { kind: "node", id: "checkout" } },
      { type: "stage", stage: FLOW },
    );
    assert.deepStrictEqual(kept.selection, { kind: "node", id: "checkout" });
    const dropped = run(
      { type: "select", ref: { kind: "edge", key: "events>notify" } },
      { type: "stage", stage: FLOW },
    );
    assert.strictEqual(dropped.selection, undefined);
  });

  test("selecting a ref that is not on the current stage is ignored", () => {
    const ui = run({ type: "select", ref: { kind: "step", flow: "soft-decline", index: 1 } });
    assert.strictEqual(ui.selection, undefined);
  });

  test("goto moves to the ref's stage and selects it", () => {
    const ui = run({ type: "goto", ref: { kind: "step", flow: "final-failure", index: 3 } });
    assert.deepStrictEqual(ui.stage, { kind: "flow", flow: "final-failure" });
    assert.deepStrictEqual(ui.selection, { kind: "step", flow: "final-failure", index: 3 });
    const node = run(
      { type: "stage", stage: FLOW },
      { type: "goto", ref: { kind: "node", id: "notify" } },
    );
    assert.deepStrictEqual(node.stage, { kind: "overview" });
    assert.deepStrictEqual(node.selection, { kind: "node", id: "notify" });
  });

  test("goto with a stage selects the node on that flow", () => {
    const ui = run({
      type: "goto",
      ref: { kind: "node", id: "retry-worker" },
      stage: { kind: "flow", flow: "final-failure" },
    });
    assert.deepStrictEqual(ui.stage, { kind: "flow", flow: "final-failure" });
    assert.deepStrictEqual(ui.selection, { kind: "node", id: "retry-worker" });
  });

  test("focus needs a selected node on the overview and toggles off", () => {
    assert.deepStrictEqual(run({ type: "focus" }).mode, { kind: "explore" });
    const focused = run(
      { type: "select", ref: { kind: "node", id: "billing-api" } },
      { type: "focus" },
    );
    assert.deepStrictEqual(focused.mode, { kind: "focus", node: "billing-api" });
    assert.deepStrictEqual(reduceUi(index, focused, { type: "focus" }).mode, { kind: "explore" });
    const onFlow = run(
      { type: "stage", stage: FLOW },
      { type: "select", ref: { kind: "node", id: "checkout" } },
      { type: "focus" },
    );
    assert.deepStrictEqual(onFlow.mode, { kind: "explore" });
  });

  test("walkthrough follows its steps' stages and exits past the end", () => {
    const start = run({ type: "walk" });
    assert.deepStrictEqual(start.mode, { kind: "walk", step: 0 });
    assert.deepStrictEqual(start.stage, { kind: "overview" });
    const fourth = run({ type: "walk" }, { type: "next" }, { type: "next" }, { type: "next" });
    assert.deepStrictEqual(fourth.mode, { kind: "walk", step: 3 });
    assert.deepStrictEqual(fourth.stage, FLOW);
    const back = reduceUi(index, fourth, { type: "prev" });
    assert.deepStrictEqual(back.mode, { kind: "walk", step: 2 });
    assert.deepStrictEqual(back.stage, { kind: "overview" });
    assert.deepStrictEqual(reduceUi(index, start, { type: "prev" }).mode, {
      kind: "walk",
      step: 0,
    });
    const done = run({ type: "walk" }, ...Array<UiAction>(5).fill({ type: "next" }));
    assert.deepStrictEqual(done.mode, { kind: "explore" });
  });

  test("selecting during a walkthrough ends it", () => {
    const ui = run({ type: "walk" }, { type: "select", ref: { kind: "node", id: "notify" } });
    assert.deepStrictEqual(ui.mode, { kind: "explore" });
    assert.deepStrictEqual(ui.selection, { kind: "node", id: "notify" });
  });

  test("space starts playback on a flow, pauses it, and does nothing on the overview", () => {
    assert.deepStrictEqual(run({ type: "playToggle" }).mode, { kind: "explore" });
    const playing = run({ type: "stage", stage: FLOW }, { type: "playToggle" });
    assert.deepStrictEqual(playing.mode, {
      kind: "play",
      flow: "soft-decline",
      step: 0,
      running: true,
    });
    assert.deepStrictEqual(playing.selection, { kind: "step", flow: "soft-decline", index: 0 });
    assert.deepStrictEqual(reduceUi(index, playing, { type: "playToggle" }).mode, {
      kind: "play",
      flow: "soft-decline",
      step: 0,
      running: false,
    });
  });

  test("tick advances a running playback and stops at the last step", () => {
    let ui = run({ type: "stage", stage: FLOW }, { type: "playToggle" });
    for (let i = 0; i < 20; i++) {
      ui = reduceUi(index, ui, { type: "tick" });
    }
    assert.deepStrictEqual(ui.mode, {
      kind: "play",
      flow: "soft-decline",
      step: 13,
      running: false,
    });
    assert.deepStrictEqual(reduceUi(index, ui, { type: "tick" }), ui);
  });

  test("arrows step a paused playback and clicking a step moves the cursor", () => {
    const ui = run({ type: "stage", stage: FLOW }, { type: "next" }, { type: "next" });
    assert.deepStrictEqual(ui.mode, {
      kind: "play",
      flow: "soft-decline",
      step: 1,
      running: false,
    });
    const clicked = reduceUi(index, ui, {
      type: "select",
      ref: { kind: "step", flow: "soft-decline", index: 9 },
    });
    assert.deepStrictEqual(clicked.mode, {
      kind: "play",
      flow: "soft-decline",
      step: 9,
      running: false,
    });
    assert.deepStrictEqual(reduceUi(index, clicked, { type: "prev" }).mode.kind, "play");
    assert.deepStrictEqual(run({ type: "prev" }).mode, { kind: "explore" });
  });

  test("leaving the flow stage ends playback", () => {
    const ui = run(
      { type: "stage", stage: FLOW },
      { type: "playToggle" },
      { type: "stageAt", n: 0 },
    );
    assert.deepStrictEqual(ui.mode, { kind: "explore" });
  });

  test("legend toggles remove and restore a delta", () => {
    const off = run({ type: "toggleDelta", delta: "unchanged" });
    assert.strictEqual(off.deltaFilter.has("unchanged"), false);
    assert.strictEqual(
      reduceUi(index, off, { type: "toggleDelta", delta: "unchanged" }).deltaFilter.has(
        "unchanged",
      ),
      true,
    );
  });

  test("escape backs out one layer at a time", () => {
    let ui = run(
      { type: "select", ref: { kind: "node", id: "billing-api" } },
      { type: "focus" },
      { type: "query", query: "retry" },
      { type: "toggleHelp" },
    );
    ui = reduceUi(index, ui, { type: "escape" });
    assert.strictEqual(ui.help, false);
    ui = reduceUi(index, ui, { type: "escape" });
    assert.strictEqual(ui.query, "");
    ui = reduceUi(index, ui, { type: "escape" });
    assert.deepStrictEqual(ui.mode, { kind: "explore" });
    ui = reduceUi(index, ui, { type: "escape" });
    assert.strictEqual(ui.selection, undefined);
    assert.strictEqual(reduceUi(index, ui, { type: "escape" }), ui);
  });
});
