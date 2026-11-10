import * as assert from "node:assert";

import { emphasisOf } from "../viz/model/emphasis.js";
import { initialUi, reduceUi, type UiAction, type UiState } from "../viz/model/ui.js";
import { multiServiceIndex } from "./vizFixtures.js";

const index = multiServiceIndex();
const FLOW = { kind: "flow", flow: "soft-decline" } as const;

function run(...actions: UiAction[]): UiState {
  return actions.reduce((ui, action) => reduceUi(index, ui, action), initialUi());
}

function only(map: ReadonlyMap<string | number, string>, level: string): (string | number)[] {
  return [...map].filter(([, value]) => value === level).map(([key]) => key);
}

suite("viz emphasis", () => {
  test("explore shows every overview element at normal and leaves the camera alone", () => {
    const emphasis = emphasisOf(index, initialUi());
    assert.strictEqual(emphasis.nodes.size, 9);
    assert.strictEqual(emphasis.nodes.has("shopper"), false);
    assert.deepStrictEqual(only(emphasis.nodes, "normal").length, 9);
    assert.deepStrictEqual(only(emphasis.edges, "normal").length, 10);
    assert.strictEqual(emphasis.camera, undefined);
    assert.strictEqual(emphasis.veil, false);
  });

  test("a legend filter dims nodes of that delta and the edges touching them, never hides", () => {
    const emphasis = emphasisOf(index, run({ type: "toggleDelta", delta: "unchanged" }));
    assert.deepStrictEqual(only(emphasis.nodes, "dim").sort(), ["events", "stripe"]);
    assert.strictEqual(emphasis.nodes.size, 9);
    assert.deepStrictEqual(only(emphasis.edges, "dim").sort(), [
      "billing-api>stripe",
      "events>notify",
      "legacy-dunning>stripe",
      "retry-worker>events",
      "retry-worker>stripe",
    ]);
  });

  test("a query brightens matches and dims the rest", () => {
    const emphasis = emphasisOf(index, run({ type: "query", query: "stripe" }));
    assert.deepStrictEqual(only(emphasis.nodes, "bright"), ["stripe"]);
    assert.deepStrictEqual(only(emphasis.edges, "bright").sort(), [
      "billing-api>stripe",
      "legacy-dunning>stripe",
      "retry-worker>stripe",
    ]);
    assert.strictEqual(only(emphasis.nodes, "dim").length, 8);
    const onFlow = emphasisOf(
      index,
      run({ type: "stage", stage: FLOW }, { type: "query", query: "poll" }),
    );
    assert.deepStrictEqual(only(onFlow.steps, "bright"), [7]);
  });

  test("focus mode brightens the node and its neighbours and frames them", () => {
    const emphasis = emphasisOf(
      index,
      run({ type: "select", ref: { kind: "node", id: "retry-worker" } }, { type: "focus" }),
    );
    assert.deepStrictEqual(only(emphasis.nodes, "bright").sort(), [
      "events",
      "payments-db",
      "retry-queue",
      "retry-worker",
      "stripe",
    ]);
    assert.deepStrictEqual(only(emphasis.edges, "bright").sort(), [
      "retry-queue>retry-worker",
      "retry-worker>events",
      "retry-worker>payments-db",
      "retry-worker>stripe",
    ]);
    assert.strictEqual(emphasis.camera?.length, 5);
  });

  test("a walkthrough step brightens its focus refs, veils the rest and frames the refs", () => {
    const emphasis = emphasisOf(index, run({ type: "walk" }));
    assert.deepStrictEqual(only(emphasis.nodes, "bright").sort(), ["billing-api", "retry-queue"]);
    assert.deepStrictEqual(only(emphasis.edges, "bright"), ["billing-api>retry-queue"]);
    assert.strictEqual(emphasis.veil, true);
    assert.deepStrictEqual(emphasis.camera, index.walkthrough[0].refs);
    const onFlow = emphasisOf(
      index,
      run({ type: "walk" }, { type: "next" }, { type: "next" }, { type: "next" }),
    );
    assert.deepStrictEqual(only(onFlow.steps, "bright"), [6, 7, 13]);
    assert.strictEqual(only(onFlow.steps, "dim").length, 11);
  });

  test("playback keeps earlier steps, brightens the current one and dims later ones", () => {
    const ui = run(
      { type: "stage", stage: FLOW },
      { type: "playToggle" },
      { type: "tick" },
      { type: "tick" },
    );
    const emphasis = emphasisOf(index, ui);
    assert.strictEqual(emphasis.cursor, 2);
    assert.deepStrictEqual(only(emphasis.steps, "normal"), [0, 1]);
    assert.deepStrictEqual(only(emphasis.steps, "bright"), [2]);
    assert.strictEqual(only(emphasis.steps, "dim").length, 11);
    assert.deepStrictEqual(only(emphasis.nodes, "bright").sort(), ["billing-api", "stripe"]);
    assert.deepStrictEqual(emphasis.camera, [{ kind: "step", flow: "soft-decline", index: 2 }]);
  });

  test("a walkthrough outranks a pending query", () => {
    const emphasis = emphasisOf(index, run({ type: "query", query: "notify" }, { type: "walk" }));
    assert.deepStrictEqual(only(emphasis.nodes, "bright").sort(), ["billing-api", "retry-queue"]);
  });
});
