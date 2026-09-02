import * as assert from "node:assert";

import { waitForStablePane } from "../e2e/drivers/kiro.js";

/** A pane that plays the given frames, one per capture, then repeats the last one forever. */
function pane(frames: string[]) {
  let index = 0;
  return {
    capture: (): string => frames[Math.min(index++, frames.length - 1)],
    exitStatus: (): number | undefined => undefined,
    sendKeys: (): void => undefined,
  };
}

const SPINNERS = ["⠹ Launching...", "⠸ Launching...", "⠼ Launching...", "⠴ Launching..."];
const READY = "› ask a question or describe a task";

suite("kiro readiness", () => {
  test("waits through a launch spinner rather than calling it ready", async () => {
    const tmux = pane([...SPINNERS, READY, READY, READY, READY]);
    let slept = 0;

    await waitForStablePane(tmux as never, 150_000, () => {
      slept += 1;
      return Promise.resolve();
    });

    assert.ok(slept >= SPINNERS.length, "every animated frame is waited through");
  });

  test("gives up once the budget is spent, saying how long it waited", async () => {
    // A pane that never settles: each capture differs, so no frame ever matches its predecessor.
    let frame = 0;
    const forever = {
      capture: (): string => `⠹ Launching... ${frame++}`,
      exitStatus: (): number | undefined => undefined,
      sendKeys: (): void => undefined,
    };

    await assert.rejects(
      waitForStablePane(forever as never, 5, () => Promise.resolve()),
      /Kiro did not become ready after \d+s/,
    );
  });

  test("reports an exit during startup instead of waiting out the budget", async () => {
    const exited = {
      capture: (): string => "boom",
      exitStatus: (): number | undefined => 1,
      sendKeys: (): void => undefined,
    };

    await assert.rejects(
      waitForStablePane(exited as never, 150_000, () => Promise.resolve()),
      /Kiro exited during startup \(status 1\)/,
    );
  });
});
