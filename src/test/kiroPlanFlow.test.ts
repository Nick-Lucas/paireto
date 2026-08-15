import * as assert from "node:assert";

import { kiroPlanGateOutcome } from "../plugins/agent-plugin/dev.kiro/planFlow.js";

suite("Kiro native Plan continuation", () => {
  test("approval allows switch_to_execution", () => {
    assert.deepStrictEqual(kiroPlanGateOutcome({ decision: "allow" }), {
      decision: "allow",
    });
  });

  test("feedback blocks the tool with the review reason", () => {
    assert.deepStrictEqual(
      kiroPlanGateOutcome({ decision: "deny", reason: "Add a rollback step." }),
      {
        decision: "block",
        reason: "Add a rollback step.",
      },
    );
  });

  test("missing feedback gets a useful default", () => {
    assert.deepStrictEqual(kiroPlanGateOutcome({ decision: "deny" }), {
      decision: "block",
      reason: "Plan changes requested.",
    });
  });
});
