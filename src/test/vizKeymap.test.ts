import * as assert from "node:assert";

import { KEY_BINDINGS, resolveKey } from "../viz/model/keymap.js";

suite("viz keymap", () => {
  test("no key is bound twice", () => {
    const keys = KEY_BINDINGS.flatMap((binding) => binding.keys);
    assert.deepStrictEqual([...new Set(keys)], keys);
  });

  test("every binding has help text and a display key", () => {
    for (const binding of KEY_BINDINGS) {
      assert.ok(binding.label.length > 0, binding.display);
      assert.ok(binding.display.length > 0, binding.label);
    }
  });

  test("digits pick stages and letters map to their actions", () => {
    assert.deepStrictEqual(resolveKey({ key: "0", modifier: false, inTextField: false }), {
      kind: "ui",
      action: { type: "stageAt", n: 0 },
    });
    assert.deepStrictEqual(resolveKey({ key: "3", modifier: false, inTextField: false }), {
      kind: "ui",
      action: { type: "stageAt", n: 3 },
    });
    assert.deepStrictEqual(resolveKey({ key: "/", modifier: false, inTextField: false }), {
      kind: "effect",
      effect: "search",
    });
    assert.deepStrictEqual(resolveKey({ key: " ", modifier: false, inTextField: false }), {
      kind: "ui",
      action: { type: "playToggle" },
    });
  });

  test("keys with a modifier or typed into a text field are left to the host, except escape", () => {
    assert.strictEqual(resolveKey({ key: "f", modifier: true, inTextField: false }), undefined);
    assert.strictEqual(resolveKey({ key: "f", modifier: false, inTextField: true }), undefined);
    assert.deepStrictEqual(resolveKey({ key: "Escape", modifier: false, inTextField: true }), {
      kind: "ui",
      action: { type: "escape" },
    });
    assert.strictEqual(resolveKey({ key: "x", modifier: false, inTextField: false }), undefined);
  });
});
