import * as assert from "node:assert";

import { planGateOutcome } from "../plugins/codex/planFlow.js";

suite("Codex Paireto plan continuation", () => {
  test("approval allows Stop so Codex can present its native mode-switch selector", () => {
    assert.deepStrictEqual(planGateOutcome({ decision: "allow" }), {
      decision: "allow",
    });
  });

  test("feedback blocks Stop with the review reason", () => {
    assert.deepStrictEqual(planGateOutcome({ decision: "deny", reason: "Add a rollback step." }), {
      decision: "block",
      reason: "Add a rollback step.",
    });
  });
});
