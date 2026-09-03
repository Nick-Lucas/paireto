// Feedback carries a lifecycle, not just a body: an id the agent can quote back, a delivery state,
// and a list of activities whose first entry is always the reviewer's own words. Driven through the
// real add-comment command and read back off the inspect seam, which is how every later layer will
// assert on replies and resolutions.

import * as assert from "node:assert";

import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  resetWorkbench,
  type Wire,
} from "./planGateHarness.js";

suite("feedback lifecycle", () => {
  let repoRoot: string;
  let wire: Wire;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    await resetWorkbench(wire);
  });

  test("a queued comment is one pending, unresolved item with no agent activity", async function () {
    this.timeout(90_000);

    const id = await queueFileComment("Rename this helper.");

    // Each test reads back only the items it queued, so it does not depend on what else is held.
    const item = (await inspect()).feedback.find((entry) => entry.id === id);
    assert.ok(item, "the queued comment is in the bucket");
    assert.strictEqual(item.delivery, "pending");
    assert.strictEqual(item.resolved, false);
    assert.deepStrictEqual(item.activityKinds, [], "the reviewer's words are not agent activity");
    assert.strictEqual(item.repoRoot, repoRoot);
  });

  test("two comments on one line are two items, each with its own id", async function () {
    this.timeout(90_000);

    const first = await queueFileComment("First point.", { line: 0 });
    const second = await queueFileComment("Second point.", { line: 0 });

    assert.notStrictEqual(first, second, "each comment is keyed by an id of its own");
    const held = (await inspect()).feedback.map((entry) => entry.id);
    assert.ok(held.includes(first) && held.includes(second), "both are in the bucket");
  });
});
