import * as assert from "node:assert";

import { ClaudeDriver, showsPlanFilePermission, trustAnswerKeys } from "../e2e/drivers/claude.js";

/** The folder-trust safety check as Claude Code 2.1.251 draws it: "No, exit" first and highlighted. */
const TRUST_SCREEN = [
  " Accessing workspace:",
  "",
  " /private/tmp/paireto-e2e-claudecode",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a" +
    " well-known open source project, or work from your team). If not, take a moment to review" +
    " what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");

/** The same check with the options the other way round, as 2.1.233 drew it. */
const TRUST_SCREEN_YES_FIRST = TRUST_SCREEN.replace(
  " ❯ No, exit\n   Yes, I trust this folder",
  " ❯ Yes, I trust this folder\n   No, exit",
);

suite("Claude E2E trust dialog", () => {
  test("steps onto the trust option instead of confirming whatever is highlighted", () => {
    assert.deepStrictEqual(trustAnswerKeys(TRUST_SCREEN), ["Down", "Enter"]);
  });

  test("confirms in place when the trust option is already highlighted", () => {
    assert.deepStrictEqual(trustAnswerKeys(TRUST_SCREEN_YES_FIRST), ["Enter"]);
  });

  test("keys nothing while the options are not drawn yet", () => {
    assert.deepStrictEqual(
      trustAnswerKeys(" Quick safety check: Is this a project you trust?"),
      [],
    );
  });
});

suite("Claude E2E startup readiness", () => {
  test("does not treat quiet startup frames as ready before a delayed trust dialog", async function () {
    this.timeout(5_000);
    const frames = ["", "", TRUST_SCREEN, "manual mode on"];
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
    assert.deepStrictEqual(keys, ["Down", "Enter"], "the delayed trust dialog was not accepted");
  });
});

suite("Claude E2E plan-file permission", () => {
  // Claude words the prompt by what it is about to do, and 2.1.251 says "create" for a plan file
  // that does not exist yet. Unanswered, the agent sits on the prompt for the whole step.
  test("recognises the prompt for a plan file that does not exist yet", () => {
    assert.ok(
      showsPlanFilePermission(
        " Do you want to create plan-how-to-add-generic-kazoo.md?\n ❯ 1. Yes\n   3. No",
      ),
    );
  });

  test("recognises the prompt for a plan file that does exist", () => {
    assert.ok(
      showsPlanFilePermission(
        " Do you want to make this edit to plan-add-hello-txt.md?\n ❯ 1. Yes",
      ),
    );
  });

  test("ignores a permission prompt about anything else", () => {
    assert.ok(!showsPlanFilePermission(" Do you want to create hello.txt?\n ❯ 1. Yes"));
  });
});
