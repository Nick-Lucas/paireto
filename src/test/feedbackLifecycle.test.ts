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

    await queueFileComment("Rename this helper.", { feedbackId: "lifecycle-1" });

    // Each test reads back only the items it queued, so it does not depend on what else is held.
    const item = (await inspect()).feedback.find((entry) => entry.id === "lifecycle-1");
    assert.ok(item, "the queued comment is in the bucket");
    assert.strictEqual(item.delivery, "pending");
    assert.strictEqual(item.resolved, false);
    assert.deepStrictEqual(item.activityKinds, [], "the reviewer's words are not agent activity");
    assert.strictEqual(item.repoRoot, repoRoot);
  });

  test("two comments on one line are two items, each with its own id", async function () {
    this.timeout(90_000);

    await queueFileComment("First point.", { line: 0, feedbackId: "pair-a" });
    await queueFileComment("Second point.", { line: 0, feedbackId: "pair-b" });

    const ids = (await inspect()).feedback
      .map((entry) => entry.id)
      .filter((id) => id.startsWith("pair-"))
      .sort();
    assert.deepStrictEqual(ids, ["pair-a", "pair-b"]);
  });
});
