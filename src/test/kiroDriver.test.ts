import * as assert from "node:assert";

import {
  acceptKiroTrustPrompt,
  KIRO_E2E_MODEL,
  kiroLaunchCommand,
  kiroStartupAction,
} from "../e2e/drivers/kiro.js";

suite("Kiro E2E launch contract", () => {
  test("uses CLI v3, the recording model, and the native planner", () => {
    assert.strictEqual(
      kiroLaunchCommand(true),
      `kiro-cli chat --v3 --agent kiro_planner --model ${KIRO_E2E_MODEL} --trust-all-tools --tui`,
    );
  });

  test("guided review uses the default agent but keeps the same model", () => {
    assert.strictEqual(
      kiroLaunchCommand(false),
      `kiro-cli chat --v3 --model ${KIRO_E2E_MODEL} --trust-all-tools --tui`,
    );
  });

  test("accepts Kiro's trust prompt instead of treating it as ready", () => {
    const screen = [
      "Kiro CLI can execute tools with --trust-all-tools.",
      "> No, exit",
      "  Yes, I accept",
      "  Yes, and don't ask again",
    ].join("\n");

    assert.strictEqual(kiroStartupAction(screen), "accept-trust");
    assert.strictEqual(kiroStartupAction("Ask me anything"), "wait");
  });

  test("moves the trust selector before it confirms the choice", async () => {
    const calls: string[][] = [];
    await acceptKiroTrustPrompt({ sendKeys: (...keys: string[]) => calls.push(keys) });

    assert.deepStrictEqual(calls, [["Down"], ["Enter"]]);
  });
});
