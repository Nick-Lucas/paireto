import * as assert from "node:assert";

import { layoutOverview } from "../viz/layout/overview.js";
import { layoutSequence } from "../viz/layout/sequence.js";
import { emphasisOf } from "../viz/model/emphasis.js";
import { OVERVIEW, refInStage, type Stage } from "../viz/model/index.js";
import { formatVizRef, parseVizRef } from "../viz/model/refs.js";
import { toOverviewRf, toSequenceRf, type CardData, type MessageData } from "../viz/model/rf.js";
import { initialUi, reduceUi, type UiAction, type UiState } from "../viz/model/ui.js";
import { makeElk } from "./vizElk.js";
import { multiServiceIndex } from "./vizFixtures.js";

const index = multiServiceIndex();
const FLOW = { kind: "flow", flow: "soft-decline" } as const;

function run(...actions: UiAction[]): UiState {
  return actions.reduce((ui, action) => reduceUi(index, ui, action), initialUi());
}

suite("viz rf adapters", () => {
  test("overview nodes carry lane bands, groups and cards with level and selection flags", async () => {
    const scene = await layoutOverview(index, makeElk());
    const ui = run(
      { type: "toggleDelta", delta: "unchanged" },
      { type: "select", ref: { kind: "node", id: "retry-worker" } },
    );
    const graph = toOverviewRf(scene, index, emphasisOf(index, ui), ui);
    const byType = (type: string) => graph.nodes.filter((node) => node.type === type);
    assert.strictEqual(byType("lane").length, 5);
    assert.strictEqual(byType("group").length, 2);
    assert.strictEqual(byType("card").length, 9);
    const worker = graph.nodes.find((node) => node.id === "retry-worker")?.data as CardData;
    assert.strictEqual(worker.selected, true);
    assert.strictEqual(worker.level, "normal");
    assert.strictEqual(worker.flows, 2);
    assert.strictEqual(worker.files, 2);
    const stripe = graph.nodes.find((node) => node.id === "stripe")?.data as CardData;
    assert.strictEqual(stripe.level, "dim");
    assert.strictEqual(stripe.selected, false);
    assert.ok(graph.nodes.every((node) => node.draggable === false));
  });

  test("overview edges keep their route, label, level and step count", async () => {
    const scene = await layoutOverview(index, makeElk());
    const ui = run({ type: "select", ref: { kind: "edge", key: "billing-api>stripe" } });
    const graph = toOverviewRf(scene, index, emphasisOf(index, ui), ui);
    assert.strictEqual(graph.edges.length, 10);
    const edge = graph.edges.find((candidate) => candidate.id === "billing-api>stripe");
    assert.ok(edge);
    assert.strictEqual(edge.source, "billing-api");
    assert.strictEqual(edge.target, "stripe");
    assert.strictEqual(edge.data.selected, true);
    assert.strictEqual(edge.data.steps, 2);
    assert.ok(edge.data.points.length >= 2);
    assert.ok(edge.data.label);
  });

  test("a walkthrough step marks its focus bright and the rest dim", async () => {
    const scene = await layoutOverview(index, makeElk());
    const ui = run({ type: "walk" });
    const graph = toOverviewRf(scene, index, emphasisOf(index, ui), ui);
    const level = (id: string) =>
      (graph.nodes.find((node) => node.id === id)!.data as CardData).level;
    assert.strictEqual(level("billing-api"), "bright");
    assert.strictEqual(level("notify"), "dim");
    assert.strictEqual(
      graph.edges.find((edge) => edge.id === "billing-api>retry-queue")?.data.level,
      "bright",
    );
    const notifyGroup = graph.nodes.find((node) => node.id === "group:services:notify");
    assert.strictEqual(notifyGroup?.data.kind === "group" && notifyGroup.data.level, "dim");
  });

  test("sequence nodes cover participants, lifelines, activations, phases and messages", () => {
    const scene = layoutSequence(index, "soft-decline");
    const ui = run({ type: "stage", stage: FLOW }, { type: "playToggle" }, { type: "tick" });
    const graph = toSequenceRf(scene, index, emphasisOf(index, ui), ui);
    const count = (type: string) => graph.nodes.filter((node) => node.type === type).length;
    assert.strictEqual(count("participant"), 7);
    assert.strictEqual(count("lifeline"), 7);
    assert.strictEqual(count("phase"), 3);
    assert.strictEqual(count("message"), 14);
    assert.ok(count("activation") > 0);
    assert.strictEqual(graph.edges.length, 0);
    const current = graph.nodes.find((node) => node.id === "soft-decline:2")?.data as MessageData;
    assert.strictEqual(current.current, true);
    assert.strictEqual(current.selected, true);
    assert.strictEqual(current.level, "bright");
    assert.ok(current.toX > current.fromX);
    const later = graph.nodes.find((node) => node.id === "soft-decline:6")?.data as MessageData;
    assert.strictEqual(later.level, "dim");
    assert.strictEqual(later.current, false);
  });

  test("selectable ids are refs on the stage and other ids never parse as one", async () => {
    const scene = await layoutOverview(index, makeElk());
    const ui = initialUi();
    const overview = toOverviewRf(scene, index, emphasisOf(index, ui), ui);
    const flowUi = run({ type: "stage", stage: FLOW });
    const sequence = toSequenceRf(
      layoutSequence(index, "soft-decline"),
      index,
      emphasisOf(index, flowUi),
      flowUi,
    );
    const check = (ids: { id: string; selectable: boolean }[], stage: Stage) => {
      for (const element of ids) {
        const ref = parseVizRef(element.id, index.flowById);
        if (element.selectable) {
          assert.ok(ref && refInStage(index, ref, stage), `${element.id} is a ref on the stage`);
          assert.strictEqual(formatVizRef(ref), element.id);
        } else {
          assert.strictEqual(ref, undefined, `${element.id} is not a ref`);
        }
      }
    };
    check([...overview.nodes, ...overview.edges], OVERVIEW);
    check([...sequence.nodes], FLOW);
    assert.ok(sequence.nodes.some((node) => node.id === "soft-decline:2"));
  });
});
