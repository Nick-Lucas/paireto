import * as assert from "node:assert";

import { ClaudeDriver } from "../e2e/drivers/claude.js";

suite("Claude E2E startup readiness", () => {
  test("does not treat quiet startup frames as ready before a delayed trust dialog", async function () {
    this.timeout(5_000);
    const frames = ["", "", "Accessing workspace:\nIs this a project you trust?", "manual mode on"];
    const keys: string[] = [];
    let seen = 0;
    const driver = new ClaudeDriver({
      attachTarget: () => ({ label: "test", session: "test" }),
      capture: () => frames[Math.min(seen++, frames.length - 1)],
      captureHistory: () => "",
      exitStatus: () => undefined,
      kill: () => undefined,
      launch: () => undefined,
      sendKeys: (...sent: string[]) => keys.push(...sent),
      typeLine: () => Promise.resolve(),
    });
    const internals = driver as unknown as {
      ctx?: { planMode: boolean; log: string[] };
      waitForReady(): Promise<void>;
    };
    internals.ctx = { planMode: false, log: [] };

    await internals.waitForReady();

    assert.strictEqual(seen, 4, "returned before Claude drew its interactive mode footer");
    assert.deepStrictEqual(keys, ["Enter"], "the delayed trust dialog was not accepted");
  });
});
