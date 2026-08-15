import * as assert from "node:assert";

import { KIRO_MODEL } from "../bridge/KiroInstaller.js";
import { kiroLaunchCommand } from "../e2e/drivers/kiro.js";

suite("Kiro E2E launch contract", () => {
  test("uses CLI v3, the cheapest model, and the native planner", () => {
    assert.strictEqual(
      kiroLaunchCommand(true),
      `kiro-cli chat --v3 --agent kiro_planner --model ${KIRO_MODEL} --trust-all-tools --tui`,
    );
  });

  test("guided review uses the default agent but keeps the same model", () => {
    assert.strictEqual(
      kiroLaunchCommand(false),
      `kiro-cli chat --v3 --model ${KIRO_MODEL} --trust-all-tools --tui`,
    );
  });
});
