import * as assert from "node:assert";

import type { Rect } from "../viz/layout/geometry.js";
import { layoutOverview, type OverviewScene } from "../viz/layout/overview.js";
import type { VizIndex } from "../viz/model/index.js";
import { makeElk } from "./vizElk.js";
import { multiServiceIndex, singleFrontendIndex } from "./vizFixtures.js";

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function nodeRect(scene: OverviewScene, id: string) {
  const node = scene.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `node ${id} is placed`);
  return node;
}

function checkInvariants(index: VizIndex, scene: OverviewScene): void {
  for (let i = 1; i < scene.lanes.length; i++) {
    const prev = scene.lanes[i - 1];
    const lane = scene.lanes[i];
    assert.ok(prev.index < lane.index, "lane bands keep the lane order");
    assert.ok(lane.x >= prev.x + prev.width - 0.01, `lane ${lane.id} does not overlap ${prev.id}`);
  }
  for (const node of scene.nodes) {
    const lane = index.nodeById.get(node.id)?.lane;
    const band = scene.lanes.find((candidate) => candidate.id === lane);
    assert.ok(band, `lane band ${lane} exists for ${node.id}`);
    assert.ok(contains(band, node), `${node.id} sits inside lane ${lane}`);
    assert.ok(contains(scene.bounds, node), `${node.id} sits inside the bounds`);
  }
  for (const group of scene.groups) {
    for (const member of group.members) {
      assert.ok(
        contains(group, nodeRect(scene, member)),
        `${member} sits inside group ${group.label}`,
      );
    }
  }
  for (const a of scene.nodes) {
    for (const b of scene.nodes) {
      if (a.id < b.id) {
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        assert.ok(apart, `${a.id} and ${b.id} do not overlap`);
      }
    }
  }
  for (const edge of scene.edges) {
    assert.ok(edge.points.length >= 2, `${edge.key} has a route`);
  }
}

suite("viz overview layout", () => {
  test("lays out the multi-service fixture with ordered lane bands and boxed groups", async () => {
    const index = multiServiceIndex();
    const scene = await layoutOverview(index, makeElk());
    checkInvariants(index, scene);
    assert.deepStrictEqual(
      scene.lanes.map((lane) => lane.id),
      ["web", "services", "messaging", "data", "third-party"],
    );
    assert.deepStrictEqual(
      scene.groups.map((group) => [group.label, [...group.members].sort()]),
      [
        ["billing", ["billing-api", "legacy-dunning", "retry-worker"]],
        ["notify", ["notify"]],
      ],
    );
    assert.strictEqual(scene.edges.length, 10);
  });

  test("lays out the single-frontend fixture", async () => {
    const index = singleFrontendIndex();
    const scene = await layoutOverview(index, makeElk());
    checkInvariants(index, scene);
    assert.deepStrictEqual(
      scene.lanes.map((lane) => lane.id),
      ["view", "state", "data"],
    );
    assert.strictEqual(scene.groups.length, 0);
  });

  test("leaves flow-only nodes out", async () => {
    const scene = await layoutOverview(multiServiceIndex(), makeElk());
    assert.strictEqual(
      scene.nodes.some((node) => node.id === "shopper"),
      false,
    );
    assert.strictEqual(
      scene.lanes.some((lane) => lane.id === "client"),
      false,
    );
  });

  test("lane bands tile the whole scene width and height", async () => {
    const scene = await layoutOverview(multiServiceIndex(), makeElk());
    assert.strictEqual(scene.lanes[0].x, scene.bounds.x);
    const last = scene.lanes[scene.lanes.length - 1];
    assert.strictEqual(last.x + last.width, scene.bounds.x + scene.bounds.width);
    for (const lane of scene.lanes) {
      assert.strictEqual(lane.height, scene.bounds.height);
    }
  });

  test("gives labelled edges a label box and starts edges on the source card side", async () => {
    const index = multiServiceIndex();
    const scene = await layoutOverview(index, makeElk());
    const hero = scene.edges.find((edge) => edge.key === "billing-api>retry-queue");
    assert.ok(hero?.label, "the hero edge carries its label box");
    const source = nodeRect(scene, "billing-api");
    const start = hero.points[0];
    assert.ok(
      Math.abs(start.x - (source.x + source.width)) < 1,
      "edge leaves from the right side of its source",
    );
    const unlabelled = scene.edges.find((edge) => edge.key === "events>notify");
    assert.strictEqual(unlabelled?.label, undefined);
  });

  test("is deterministic across runs", async () => {
    const index = multiServiceIndex();
    const first = await layoutOverview(index, makeElk());
    const second = await layoutOverview(index, makeElk());
    assert.deepStrictEqual(second, first);
  });
});
