// Unit tests for the per-session notification gate. Every fire is asynchronous (undebounced reasons
// go through setTimeout(0)), so assertions always wait a tick; staleness is the onFire callback's
// job, not the gate's.

import * as assert from "node:assert";

import { createDebouncedStop } from "../agents/debouncedStop.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite("createDebouncedStop", () => {
  test("an undebounced reason fires on the next macrotask", async () => {
    const fired: string[] = [];
    const gate = createDebouncedStop((reason) => fired.push(reason), 30);
    gate.consider("awaiting your permission", false);
    assert.deepStrictEqual(fired, [], "asynchronous — nothing fires inside the same tick");
    await wait(0);
    assert.deepStrictEqual(fired, ["awaiting your permission"]);
    gate.dispose();
  });

  test("a debounced reason fires only after the settle window", async () => {
    const fired: string[] = [];
    const gate = createDebouncedStop((reason) => fired.push(reason), 20);
    gate.consider("finished its turn (Stop)", true);
    await wait(0);
    assert.deepStrictEqual(fired, [], "the settle window is still open");
    await wait(50);
    assert.deepStrictEqual(fired, ["finished its turn (Stop)"]);
    gate.dispose();
  });

  test("a reasonless event does nothing (no fire, and a pending fire keeps ticking)", async () => {
    const fired: string[] = [];
    const gate = createDebouncedStop((reason) => fired.push(reason), 20);
    gate.consider(undefined, false);
    gate.consider(undefined, true);
    await wait(50);
    assert.deepStrictEqual(fired, [], "no reason, no fire");
    gate.consider("finished its turn (Stop)", true);
    gate.consider(undefined, true); // e.g. a FileChanged while still stopped
    await wait(50);
    assert.deepStrictEqual(fired, ["finished its turn (Stop)"], "pending fire kept ticking");
    gate.dispose();
  });

  test("a new reason replaces a pending one (single fire, latest reason)", async () => {
    const fired: string[] = [];
    const gate = createDebouncedStop((reason) => fired.push(reason), 20);
    gate.consider("first", true);
    await wait(10);
    gate.consider("second", true); // a fresh stopped edge before the first window closed
    await wait(60);
    assert.deepStrictEqual(fired, ["second"]);
    gate.dispose();
  });

  test("an undebounced reason replaces a pending debounced one (no double fire)", async () => {
    const fired: string[] = [];
    const gate = createDebouncedStop((reason) => fired.push(reason), 20);
    gate.consider("finished its turn (Stop)", true);
    gate.consider("awaiting your permission", false);
    await wait(60);
    assert.deepStrictEqual(fired, ["awaiting your permission"]);
    gate.dispose();
  });

  test("dispose cancels a pending fire", async () => {
    const fired: string[] = [];
    const gate = createDebouncedStop((reason) => fired.push(reason), 0);
    gate.consider("finished its turn (Stop)", true);
    gate.dispose();
    await wait(20);
    assert.deepStrictEqual(fired, []);
  });
});
