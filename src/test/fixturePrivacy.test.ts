// The guarantee that a committed cassette carries no personal identity: this scans the committed
// artifacts themselves and fails on anything email- or account-id-shaped, covering provider fields
// the scrubber's list does not yet know about.
//
// If it fails after a re-record, extend IDENTITY_PATTERNS/IDENTITY_KEYS in src/e2e/proxy/normalize.ts
// to cover the new field and re-record, so the scrubber keeps up with it.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeRequestBody, scrubIdentity } from "../e2e/proxy/normalize.js";

const FIXTURES_DIR = path.resolve(__dirname, "../../src/e2e/fixtures");

/** Placeholders the scrubber writes — these are the only "identity-shaped" strings allowed through. */
const PLACEHOLDERS = [
  "paireto-e2e@example.invalid",
  "user-PAIRETO_E2E_ACCOUNT",
  "org-PAIRETO_E2E_ORG",
  "acct_PAIRETO_E2E_ACCOUNT",
  "PAIRETO_E2E_ID",
];

/** Emails the agents themselves embed in their own instructions — not the recorder's identity. */
const VENDOR_EMAILS = [/^noreply@anthropic\.com$/i, /^[a-z0-9._%+-]+@example\.(com|invalid|org)$/i];

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ACCOUNT_ID = /\b(?:user|org)-[A-Za-z0-9]{16,}\b|\bacct[_-][A-Za-z0-9]{8,}\b/g;

function fixtureFiles(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(FIXTURES_DIR, name));
}

function offenders(text: string, pattern: RegExp, allow: RegExp[] = []): string[] {
  const hits = text.match(pattern) ?? [];
  return [
    ...new Set(
      hits.filter(
        (hit) => !PLACEHOLDERS.includes(hit) && !allow.some((exempt) => exempt.test(hit)),
      ),
    ),
  ];
}

suite("fixture privacy", () => {
  test("every committed cassette exists and is scanned", () => {
    const files = fixtureFiles();
    assert.ok(files.length >= 3, `expected the three per-driver cassettes, found ${files.length}`);
  });

  test("no cassette contains a personal email address", () => {
    for (const file of fixtureFiles()) {
      const found = offenders(fs.readFileSync(file, "utf8"), EMAIL, VENDOR_EMAILS);
      assert.deepStrictEqual(
        found,
        [],
        `${path.basename(file)} leaks email(s): ${found.join(", ")}`,
      );
    }
  });

  test("no cassette contains a provider account identifier", () => {
    for (const file of fixtureFiles()) {
      const found = offenders(fs.readFileSync(file, "utf8"), ACCOUNT_ID);
      assert.deepStrictEqual(
        found,
        [],
        `${path.basename(file)} leaks account id(s): ${found.join(", ")}`,
      );
    }
  });

  test("scrubIdentity replaces identity fields, emails, and opaque account ids", () => {
    const raw = JSON.stringify({
      email: "someone@real-domain.example.co.uk",
      user_id: "user-AbCdEfGhIjKlMnOpQrSt",
      chatgpt_account_id: "5b2f1a90-0000-4000-8000-000000000000",
      organization_uuid: "org-AbCdEfGhIjKlMnOpQrSt",
      nested: { accountId: "acct_1A2b3C4d5E" },
      keep: "this text is content, not identity",
    });
    const scrubbed = scrubIdentity(raw);

    assert.deepStrictEqual(offenders(scrubbed, EMAIL, VENDOR_EMAILS), []);
    assert.deepStrictEqual(offenders(scrubbed, ACCOUNT_ID), []);
    assert.ok(!scrubbed.includes("AbCdEfGhIjKlMnOpQrSt"));
    assert.ok(!scrubbed.includes("5b2f1a90-0000-4000-8000-000000000000"));
    assert.ok(scrubbed.includes("this text is content, not identity"));
  });

  test("scrubIdentity is idempotent, so re-normalizing a cassette on load cannot drift", () => {
    const once = scrubIdentity('{"user_id":"user-AbCdEfGhIjKlMnOpQrSt","e":"a@b.com"}');
    assert.strictEqual(scrubIdentity(once), once);
  });

  // Claude's /v1/messages `metadata.user_id` is a string containing escaped JSON; scrubbing has to
  // leave the document parseable, since the rest of normalization depends on it.
  test("scrubIdentity keeps JSON valid when an identity value is itself escaped JSON", () => {
    const raw = JSON.stringify({
      model: "claude-haiku-4-5",
      metadata: {
        user_id: JSON.stringify({
          device_id: "d06a6adb6dc6b906",
          account_uuid: "1bddd36c-c4f7-4e34-ad61-12ecc8b8d173",
          session_id: "00000000-0000-4000-8000-0000000000c1",
        }),
      },
      messages: [{ role: "user", content: "keep me" }],
    });
    const scrubbed = scrubIdentity(raw);

    const parsed = JSON.parse(scrubbed) as {
      model: string;
      metadata: { user_id: string };
      messages: unknown[];
    };
    assert.strictEqual(parsed.metadata.user_id, "PAIRETO_E2E_ID");
    assert.strictEqual(parsed.model, "claude-haiku-4-5");
    assert.deepStrictEqual(parsed.messages, [{ role: "user", content: "keep me" }]);
    assert.ok(!scrubbed.includes("1bddd36c-c4f7-4e34-ad61-12ecc8b8d173"));
    assert.ok(!scrubbed.includes("d06a6adb6dc6b906"));
  });

  test("a scrubbed JSON body stays parseable, so downstream normalization still runs", () => {
    const raw = JSON.stringify({
      metadata: { user_id: '{"nested":"quo\\"ted"}' },
      system: "env preamble",
      tools: [{ name: "Write", description: "prose" }],
    });
    const normalized = JSON.parse(normalizeRequestBody("claudecode", raw)) as {
      metadata: unknown;
      system: unknown;
      tools: unknown;
    };
    // These only normalize if the scrubbed body is still parseable.
    assert.strictEqual(normalized.metadata, null);
    assert.strictEqual(normalized.system, null);
    assert.deepStrictEqual(normalized.tools, [{ name: "Write" }]);
  });
});
