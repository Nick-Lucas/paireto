import * as assert from "node:assert";

import type { VizFile } from "../protocol/viz.js";
import { autoGroups } from "../viz/layout/grouping.js";
import { buildVizIndex, type VizIndex } from "../viz/model/index.js";
import { changeSize } from "../viz/model/visible.js";
import { loadVizFixture, multiServiceIndex } from "./vizFixtures.js";

const MESSAGE = "src/notify/message.ts#Message";

function flatNotify(edit: (viz: VizFile) => void = () => {}): VizIndex {
  const viz = loadVizFixture("classDiagram");
  viz.nodes = viz.nodes
    .filter((node) => node.kind !== "package")
    .map(({ parent: _parent, ...node }) => node);
  edit(viz);
  return buildVizIndex(viz);
}

suite("viz auto grouping", () => {
  test("by links puts linked types in one frame named for the largest change", () => {
    const groups = autoGroups(flatNotify(), "links");
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].title, "EmailChannel and 5 linked types");
    assert.strictEqual(groups[0].members.length, 6);
    assert.ok(groups[0].members.includes(MESSAGE));
  });

  test("by links leaves a type with no links outside every frame", () => {
    const groups = autoGroups(
      flatNotify((viz) => {
        viz.edges = viz.edges?.filter((edge) => edge.to !== MESSAGE);
      }),
      "links",
    );
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].title, "EmailChannel and 4 linked types");
    assert.ok(!groups[0].members.includes(MESSAGE));
  });

  test("by folder frames the types by the folder of their first file", () => {
    const groups = autoGroups(
      flatNotify((viz) => {
        const message = viz.nodes.find((node) => node.id === MESSAGE);
        assert.ok(message);
        message.files = [{ path: "src/model/message.ts" }];
      }),
      "folders",
    );
    assert.deepStrictEqual(
      groups.map((group) => [group.id, group.title, group.members.length]),
      [
        ["folder/0", "src/model", 1],
        ["folder/1", "src/notify", 5],
      ],
    );
  });

  test("by links on mixed parts puts each part in at most one frame, largest frame first", () => {
    const index = multiServiceIndex();
    const groups = autoGroups(index, "links");
    const seen = new Set<string>();
    for (const group of groups) {
      assert.ok(group.members.length > 1, `${group.title} holds more than one part`);
      assert.ok(/ linked parts?$/.test(group.title), group.title);
      for (const id of group.members) {
        assert.ok(!seen.has(id), `${id} sits in one frame only`);
        seen.add(id);
      }
    }
    const sizes = groups.map((group) =>
      group.members.reduce((sum, id) => sum + changeSize(index.nodeById.get(id)!), 0),
    );
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i - 1] >= sizes[i], "frames come in size order");
    }
  });
});
