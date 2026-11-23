import * as assert from "node:assert";

import type { NodeChange } from "@xyflow/react";

import { layoutOverview } from "../viz/layout/overview.js";
import { layoutSequence } from "../viz/layout/sequence.js";
import { emphasisOf } from "../viz/model/emphasis.js";
import { OVERVIEW, refInStage, type Stage } from "../viz/model/index.js";
import { formatVizRef, parseVizRef } from "../viz/model/refs.js";
import { estimateMeasure } from "../viz/layout/measure.js";
import {
  commentSpot,
  dragNotes,
  NO_EXTRAS,
  toOverviewRf,
  toSequenceRf,
  type CardData,
  type EdgeData,
  type MessageData,
  type RfNode,
  withNoteDrags,
} from "../viz/model/rf.js";
import { initialUi, reduceUi, type UiAction, type UiState } from "../viz/model/ui.js";
import { makeElk } from "./vizElk.js";
import { multiServiceIndex } from "./vizFixtures.js";

const index = multiServiceIndex();
const EXTRAS = { ...NO_EXTRAS, measure: estimateMeasure };
const FLOW = { kind: "flow", flow: "soft-decline" } as const;

function run(...actions: UiAction[]): UiState {
  return actions.reduce((ui, action) => reduceUi(index, ui, action), initialUi(index));
}

suite("viz rf adapters", () => {
  test("overview nodes carry lane bands, groups and cards with level and selection flags", async () => {
    const scene = await layoutOverview(index, makeElk());
    const ui = run(
      { type: "toggleDelta", delta: "unchanged" },
      { type: "select", ref: { kind: "node", id: "retry-worker" } },
    );
    const graph = toOverviewRf(scene, index, emphasisOf(index, ui), ui, EXTRAS);
    const byType = (type: string) => graph.nodes.filter((node) => node.type === type);
    assert.strictEqual(byType("lane").length, 5);
    assert.strictEqual(byType("frame").length, 2);
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
    const ui = run({ type: "select", ref: { kind: "edge", id: "billing-api>stripe:call" } });
    const graph = toOverviewRf(scene, index, emphasisOf(index, ui), ui, EXTRAS);
    assert.strictEqual(graph.edges.length, 10);
    const edge = graph.edges.find((candidate) => candidate.id === "billing-api>stripe:call");
    assert.ok(edge);
    assert.strictEqual(edge.source, "billing-api");
    assert.strictEqual(edge.target, "stripe");
    const data = edge.data as EdgeData;
    assert.strictEqual(data.selected, true);
    assert.strictEqual(data.steps, 2);
    assert.ok(data.points.length >= 2);
    assert.ok(data.label);
  });

  test("a walkthrough step marks its focus bright and the rest dim", async () => {
    const scene = await layoutOverview(index, makeElk());
    const ui = run({ type: "walk" });
    const graph = toOverviewRf(scene, index, emphasisOf(index, ui), ui, EXTRAS);
    const level = (id: string) =>
      (graph.nodes.find((node) => node.id === id)!.data as CardData).level;
    assert.strictEqual(level("billing-api"), "bright");
    assert.strictEqual(level("notify"), "dim");
    assert.strictEqual(
      (graph.edges.find((edge) => edge.id === "billing-api>retry-queue:event")!.data as EdgeData)
        .level,
      "bright",
    );
    const notifyGroup = graph.nodes.find(
      (node) =>
        node.type === "frame" && node.data.kind === "frame" && node.data.frame.label === "notify",
    );
    assert.strictEqual(notifyGroup?.data.kind === "frame" && notifyGroup.data.level, "dim");
  });

  test("sequence nodes cover participants, lifelines, activations, phases and messages", () => {
    const scene = layoutSequence(index, "soft-decline");
    const ui = run({ type: "stage", stage: FLOW }, { type: "playToggle" }, { type: "tick" });
    const graph = toSequenceRf(scene, index, emphasisOf(index, ui), ui, []);
    const count = (type: string) => graph.nodes.filter((node) => node.type === type).length;
    assert.strictEqual(count("participant"), 7);
    assert.strictEqual(count("lifeline"), 7);
    assert.strictEqual(count("phase"), 3);
    assert.strictEqual(count("message"), 14);
    assert.ok(count("activation") > 0);
    assert.strictEqual(graph.edges.length, 0);
    const current = graph.nodes.find((node) => node.id === "soft-decline 2")?.data as MessageData;
    assert.strictEqual(current.current, true);
    assert.strictEqual(current.selected, true);
    assert.strictEqual(current.level, "bright");
    assert.ok(current.toX > current.fromX);
    const later = graph.nodes.find((node) => node.id === "soft-decline 6")?.data as MessageData;
    assert.strictEqual(later.level, "dim");
    assert.strictEqual(later.current, false);
  });

  test("selectable ids are refs on the stage and other ids never parse as one", async () => {
    const scene = await layoutOverview(index, makeElk());
    const ui = initialUi(index);
    const overview = toOverviewRf(scene, index, emphasisOf(index, ui), ui, EXTRAS);
    const flowUi = run({ type: "stage", stage: FLOW });
    const sequence = toSequenceRf(
      layoutSequence(index, "soft-decline"),
      index,
      emphasisOf(index, flowUi),
      flowUi,
      [],
    );
    const check = (ids: { id: string; selectable: boolean }[], stage: Stage) => {
      for (const element of ids) {
        const ref = parseVizRef(element.id, index);
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
    assert.ok(sequence.nodes.some((node) => node.id === "soft-decline 2"));
  });
});

function band(id: string, x: number, y: number): RfNode {
  return {
    id,
    type: "lane",
    position: { x, y },
    width: 100,
    height: 40,
    data: { kind: "lane", label: id, even: false },
    selectable: false,
    draggable: true,
    zIndex: 0,
  };
}

function moved(id: string, x: number, y: number, dragging: boolean): NodeChange<RfNode> {
  return { type: "position", id, position: { x, y }, dragging };
}

suite("viz note drags", () => {
  const graph = [band("note:a", 10, 10), band("note:b", 200, 10)];

  test("a dragged note follows the pointer and keeps its drop place until the host moves it", () => {
    let drags = dragNotes(graph, new Map(), [moved("note:a", 30, 40, true)]);
    assert.deepStrictEqual(withNoteDrags(graph, drags)[0]?.position, { x: 30, y: 40 });
    assert.strictEqual(withNoteDrags(graph, drags)[1], graph[1]);
    drags = dragNotes(graph, drags, [moved("note:a", 60, 70, false)]);
    assert.deepStrictEqual(withNoteDrags(graph, drags)[0]?.position, { x: 60, y: 70 });
    const rebuilt = [band("note:a", 10, 10), band("note:b", 200, 10)];
    assert.deepStrictEqual(withNoteDrags(rebuilt, drags)[0]?.position, { x: 60, y: 70 });
    const saved = [band("note:a", 60, 70), band("note:b", 200, 10)];
    assert.strictEqual(withNoteDrags(saved, drags), saved);
    assert.strictEqual(dragNotes(saved, drags, []).size, 0);
  });

  test("changes that do not move a known node keep the drags", () => {
    const drags = dragNotes(graph, new Map(), [
      { type: "select", id: "note:a", selected: true },
      moved("missing", 1, 1, true),
    ]);
    assert.strictEqual(drags.size, 0);
    assert.strictEqual(withNoteDrags(graph, drags), graph);
    const held = dragNotes(graph, new Map(), [moved("note:a", 30, 40, true)]);
    assert.strictEqual(
      dragNotes(graph, held, [{ type: "select", id: "note:a", selected: true }]),
      held,
    );
  });
});

suite("viz comment spot", () => {
  const graph = [band("Notifier", 10, 20), band("deliver 2", 300, 80)];

  test("the comment icon sits at the top right of the selected part", () => {
    assert.deepStrictEqual(commentSpot(graph, { kind: "node", id: "Notifier" }), { x: 110, y: 20 });
    assert.deepStrictEqual(
      commentSpot(graph, { kind: "member", id: "Notifier.notify", node: "Notifier" }),
      { x: 110, y: 20 },
    );
    assert.deepStrictEqual(commentSpot(graph, { kind: "step", flow: "deliver", index: 1 }), {
      x: 400,
      y: 80,
    });
    assert.strictEqual(commentSpot(graph, { kind: "edge", id: "Notifier" }), undefined);
    assert.strictEqual(commentSpot(graph, { kind: "node", id: "missing" }), undefined);
  });
});
