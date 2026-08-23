import * as assert from "node:assert";

import { kiroPlanGateOutcome } from "../plugins/agent-plugin/dev.kiro/planFlow.js";

suite("Kiro native Plan continuation", () => {
  test("approval allows switch_to_execution", () => {
    assert.deepStrictEqual(kiroPlanGateOutcome({ decision: "allow" }), { decision: "allow" });
  });

  // Kiro reads an allowed hook's stdout as a JSON decision, so text on an approval never reaches the
  // agent. The outcome drops it rather than writing bytes the agent cannot read.
  test("approval carries no text, even when the response offers some", () => {
    assert.deepStrictEqual(
      kiroPlanGateOutcome({ decision: "allow", reason: "call switch_to_execution" }),
      { decision: "allow" },
    );
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
