// What a strict-VCR miss prints. The realistic case is a small substitution inside a large body — a
// per-run id, a changed count — so the output has to land on the changed lines.

import * as assert from "node:assert";

import { describeBodyDiff, diffHunks, toDiffLines } from "../e2e/bodyDiff.js";

suite("replay miss diff", () => {
  test("pretty-prints JSON so the diff lands on semantic lines", () => {
    assert.deepStrictEqual(toDiffLines('{"a":1}'), ["{", '  "a": 1', "}"]);
  });

  test("falls back to raw lines for a non-JSON body", () => {
    assert.deepStrictEqual(toDiffLines("not json\nsecond"), ["not json", "second"]);
  });

  test("reports only the changed line of an otherwise identical body", () => {
    const cassette = JSON.stringify({ model: "m", id: "msg_019fdc62", tail: "same" });
    const live = JSON.stringify({ model: "m", id: "msg_019fdc69", tail: "same" });

    const diff = describeBodyDiff(cassette, live);

    assert.match(diff, /^--- cassette$/m);
    assert.match(diff, /^\+\+\+ replayed request$/m);
    assert.match(diff, /^-\s+"id": "msg_019fdc62",?$/m);
    assert.match(diff, /^\+\s+"id": "msg_019fdc69",?$/m);
    // The unchanged fields must not be reported as differences.
    assert.doesNotMatch(diff, /^[-+]\s+"model"/m);
    assert.doesNotMatch(diff, /^[-+]\s+"tail"/m);
  });

  test("resyncs after an inserted block instead of calling the rest changed", () => {
    const cassette = ["a", "b", "c", "d"];
    const live = ["a", "b", "INSERTED", "c", "d"];

    const hunks = diffHunks(cassette, live);

    assert.strictEqual(hunks.length, 1);
    assert.deepStrictEqual(hunks[0].expected, []);
    assert.deepStrictEqual(hunks[0].actual, ["INSERTED"]);
  });

  test("says so when the bodies match, since then the miss is the method or path", () => {
    assert.match(describeBodyDiff('{"a":1}', '{"a":1}'), /identical/);
  });

  test("caps the output so a structural change cannot bury the terminal", () => {
    const cassette = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => `old-${i}`) });
    const live = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => `new-${i}`) });

    const diff = describeBodyDiff(cassette, live);

    assert.ok(diff.split("\n").length < 80, "diff stays readable");
    assert.match(diff, /more changed lines|more differing hunks/);
  });

  test("truncates a single very long line rather than wrapping it off screen", () => {
    const cassette = JSON.stringify({ prompt: "x".repeat(4000) });
    const live = JSON.stringify({ prompt: "y".repeat(4000) });

    for (const line of describeBodyDiff(cassette, live).split("\n")) {
      assert.ok(line.length <= 280, `line too long: ${line.length}`);
    }
  });
});
