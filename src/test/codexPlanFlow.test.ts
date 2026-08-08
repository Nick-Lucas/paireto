import * as assert from "node:assert";

const planFlow = require("../../plugins/codex/scripts/plan-flow.js") as {
  planGateOutcome: (message: {
    decision?: string;
    reason?: string;
  }) => { decision: "allow" } | { decision: "block"; reason: string };
};

suite("Codex Paireto plan continuation", () => {
  test("approval allows Stop so Codex can present its native mode-switch selector", () => {
    assert.deepStrictEqual(planFlow.planGateOutcome({ decision: "allow" }), {
      decision: "allow",
    });
  });

  test("feedback blocks Stop with the review reason", () => {
    assert.deepStrictEqual(
      planFlow.planGateOutcome({ decision: "deny", reason: "Add a rollback step." }),
      { decision: "block", reason: "Add a rollback step." },
    );
  });
});
