import * as assert from "node:assert";

import { nodeContextChips } from "../viz/model/inspector.js";
import { classDiagramIndex, multiServiceIndex } from "./vizFixtures.js";

suite("viz inspector", () => {
  test("a node with no lane shows only its frame as context", () => {
    const index = classDiagramIndex();
    const node = index.nodeById.get("src/notify/channel.ts#Channel")!;
    assert.deepStrictEqual(nodeContextChips(node, index), ["notify"]);
  });

  test("a node in a lane shows the lane label", () => {
    const index = multiServiceIndex();
    const node = index.viz.nodes.find((candidate) => candidate.lane)!;
    const lane = index.lanes.find((candidate) => candidate.id === node.lane)!;
    assert.ok(nodeContextChips(node, index).includes(lane.label));
  });
});
