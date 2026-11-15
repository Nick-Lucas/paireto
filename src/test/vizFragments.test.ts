import * as assert from "node:assert";

import { layoutSequence, SEQ } from "../viz/layout/sequence.js";
import { buildVizIndex } from "../viz/model/index.js";
import { classDiagramIndex, loadVizFixture } from "./vizFixtures.js";

suite("viz sequence fragments", () => {
  test("a fragment box wraps the steps it covers and pushes the rows down", () => {
    const scene = layoutSequence(classDiagramIndex(), "deliver");
    assert.strictEqual(scene.fragments.length, 1);
    const [box] = scene.fragments;
    assert.deepStrictEqual(
      { kind: box.kind, label: box.label, from: box.from, to: box.to, depth: box.depth },
      { kind: "alt", label: "email send fails", from: 2, to: 4, depth: 0 },
    );
    const y = scene.messages.map((message) => message.lineY);
    assert.ok(y[0] < box.y, "the first step sits above the fragment");
    assert.ok(box.y < y[1], "the fragment opens before its first step");
    assert.ok(y[3] < box.y + box.height, "the fragment closes after its last step");
    assert.strictEqual(y[1] - y[0], SEQ.pitch + SEQ.fragmentHead);
    assert.ok(scene.bounds.height >= box.y + box.height);
  });

  test("a fragment inside another one sits one inset deeper", () => {
    const viz = loadVizFixture("classDiagram");
    const flow = viz.flows?.[0];
    assert.ok(flow);
    flow.fragments = [
      { kind: "loop", label: "until sent", from: 1, to: 4 },
      { kind: "alt", label: "email send fails", from: 2, to: 3 },
    ];
    const scene = layoutSequence(buildVizIndex(viz), "deliver");
    assert.deepStrictEqual(
      scene.fragments.map((box) => [box.kind, box.depth]),
      [
        ["loop", 0],
        ["alt", 1],
      ],
    );
    const [outer, inner] = scene.fragments;
    assert.strictEqual(inner.x - outer.x, SEQ.fragmentInset);
    assert.strictEqual(outer.x + outer.width - (inner.x + inner.width), SEQ.fragmentInset);
    assert.ok(inner.y > outer.y);
    assert.ok(inner.y + inner.height < outer.y + outer.height);
  });
});
