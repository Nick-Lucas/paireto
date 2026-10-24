import * as assert from "node:assert";

import { openCodeCredentialFromCodex, piCredentialFromCodex } from "../e2e/sandbox.js";

const jwt = (payload: Record<string, unknown>): string =>
  [{ alg: "none", typ: "JWT" }, payload]
    .map((part) => Buffer.from(JSON.stringify(part), "utf8").toString("base64url"))
    .concat("sig")
    .join(".");

const access = jwt({
  exp: 1_900_000_000,
  "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
});

const codexAuth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: access, refresh_token: "refresh-1", account_id: "account-1" },
});

const oauth = {
  type: "oauth",
  access,
  refresh: "refresh-1",
  expires: 1_900_000_000_000,
  accountId: "account-1",
};

suite("E2E credentials from the Codex login", () => {
  test("OpenCode signs in to its OpenAI provider with the Codex ChatGPT login", () => {
    assert.deepStrictEqual(openCodeCredentialFromCodex(codexAuth), { openai: oauth });
  });

  test("Pi signs in to its Codex provider with the Codex ChatGPT login", () => {
    assert.deepStrictEqual(piCredentialFromCodex(codexAuth), { "openai-codex": oauth });
  });

  test("no Codex login gives no credential", () => {
    assert.strictEqual(openCodeCredentialFromCodex(""), undefined);
    assert.strictEqual(piCredentialFromCodex(""), undefined);
  });
});
