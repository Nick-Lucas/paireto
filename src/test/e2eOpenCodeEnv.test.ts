import * as assert from "node:assert";

import { openCodeEnv } from "../e2e/drivers/opencode.js";

suite("E2E OpenCode env", () => {
  test("record and replay both skip the models.dev lookup, so both send the same title request", () => {
    assert.strictEqual(openCodeEnv().OPENCODE_DISABLE_MODELS_FETCH, "true");
  });
});
