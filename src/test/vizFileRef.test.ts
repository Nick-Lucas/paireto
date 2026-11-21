import * as assert from "node:assert";

import { BOX, measureClassBox } from "../viz/layout/classBox.js";
import { estimateMeasure } from "../viz/layout/measure.js";
import { fileRefLabel, fileRefTitle } from "../viz/model/refs.js";
import { classDiagramIndex } from "./vizFixtures.js";

suite("viz file refs", () => {
  test("label is the base name and the line", () => {
    assert.strictEqual(
      fileRefLabel({ path: "src/notify/notifier.ts", line: 12 }),
      "notifier.ts:12",
    );
  });

  test("label is the base name when the line is absent", () => {
    assert.strictEqual(fileRefLabel({ path: "src/notify/notifier.ts" }), "notifier.ts");
  });

  test("title is the full path and line", () => {
    assert.strictEqual(fileRefTitle({ path: "services/a.go", line: 4 }), "services/a.go:4");
  });

  test("title starts with the repo when set", () => {
    assert.strictEqual(
      fileRefTitle({ path: "services/a.go", line: 4, repo: "billing" }),
      "billing:services/a.go:4",
    );
  });

  test("a class box with a file ref has a taller header and the fitted ref", () => {
    const node = classDiagramIndex().nodes[1];
    const bare = { ...node, files: undefined };
    const withRef = { ...node, files: [{ path: "src/name.ts", line: 12 }] };
    const show = "all" as const;
    const plain = measureClassBox(bare, show, false, estimateMeasure);
    const boxed = measureClassBox(withRef, show, false, estimateMeasure);
    assert.strictEqual(plain.ref, undefined);
    assert.strictEqual(boxed.ref, "name.ts:12");
    assert.strictEqual(boxed.headerHeight, plain.headerHeight + BOX.refHeight);
  });
});
