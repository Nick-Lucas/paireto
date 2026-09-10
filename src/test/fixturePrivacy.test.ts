// The guarantee that a committed cassette carries nothing private: this scans the committed artifacts
// themselves and fails on anything email-, account-id-, credential- or host-path-shaped, covering
// provider fields the scrubber's list does not yet know about.
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
const ACCOUNT_ID =
  /\b(?:user|org)-[A-Za-z0-9]{16,}\b|\bacct[_-][A-Za-z0-9]{8,}\b|\bRateLimitResetCredit_[A-Za-z0-9]{16,}\b/g;

/** Handles a provider mints per conversation and echoes back inside RESPONSE bodies, which the
 *  request-side normalizer never reaches. Their value must always be the placeholder. */
const SESSION_KEYS = ["prompt_cache_key", "turn_id"];
/** The keys above as written in a cassette: the response body is a JSON string inside JSON, so every
 *  quote may be escaped. */
const SESSION_HANDLE = new RegExp(
  `\\\\?"(?:${SESSION_KEYS.join("|")})\\\\?"\\s*:\\s*\\\\?"([^"\\\\]*)`,
  "g",
);

/** Credential shapes a cassette must never carry. None matches today only because auth travels in
 *  request headers, which are dropped — a provider that moved it into a body would be committed
 *  unnoticed without this scan. */
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ["bearer token", /Bearer[\s\\"]+[A-Za-z0-9._~+/-]{20,}/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["OpenAI key", /\bsk-(?:proj|svcacct|admin)?-?[A-Za-z0-9]{32,}/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["AWS key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Google key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["cookie header", /\bSet-Cookie\b/gi],
];

/** A home directory names the machine that recorded the cassette; the sandbox roots do not. */
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9_.-]+/g;
/** OpenCode's own bash tool description ships this literal example path. */
const VENDOR_HOME_PATHS = [/^\/Users\/name$/];

/** Endpoints that carry account state (plan, quota, credits) and never conversation. Recording one
 *  commits the recorder's subscription details, so they are answered from LOCAL_BOOTSTRAP instead. */
const ACCOUNT_ENDPOINT = /\/wham\/|usage|rate-limit|credits|billing/i;

interface CassetteExpectation {
  httpRequest?: Record<string, unknown>;
  httpResponse?: { headers?: Record<string, unknown> };
}

function fixtureFiles(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(FIXTURES_DIR, name));
}

/** Every cassette's bytes, read once. Each scan below walks all of them, and a re-record that grows
 *  the committed fixtures turns that repeated I/O into a timeout rather than a finding. */
const cassetteText = new Map<string, string>();

function fixtureText(file: string): string {
  const cached = cassetteText.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const text = fs.readFileSync(file, "utf8");
  cassetteText.set(file, text);
  return text;
}

function expectationsOf(file: string): CassetteExpectation[] {
  const parsed = JSON.parse(fixtureText(file)) as {
    expectations?: CassetteExpectation[];
  };
  return parsed.expectations ?? [];
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

suite("fixture privacy", function () {
  // Reading and scanning every committed cassette is real work — 11MB today and growing with each
  // re-record — so this suite states its own budget rather than inheriting the default for a unit test.
  this.timeout(30_000);

  test("every committed cassette exists and is scanned", () => {
    const files = fixtureFiles();
    assert.ok(files.length >= 3, `expected the three per-driver cassettes, found ${files.length}`);
  });

  test("no cassette contains a personal email address", () => {
    for (const file of fixtureFiles()) {
      const found = offenders(fixtureText(file), EMAIL, VENDOR_EMAILS);
      assert.deepStrictEqual(
        found,
        [],
        `${path.basename(file)} leaks email(s): ${found.join(", ")}`,
      );
    }
  });

  test("no cassette contains a provider account identifier", () => {
    for (const file of fixtureFiles()) {
      const found = offenders(fixtureText(file), ACCOUNT_ID);
      assert.deepStrictEqual(
        found,
        [],
        `${path.basename(file)} leaks account id(s): ${found.join(", ")}`,
      );
    }
  });

  test("no cassette contains a provider conversation handle", () => {
    for (const file of fixtureFiles()) {
      const text = fixtureText(file);
      const found = [
        ...new Set(
          [...text.matchAll(SESSION_HANDLE)]
            .map((match) => match[1])
            .filter((value) => !PLACEHOLDERS.includes(value)),
        ),
      ];
      assert.deepStrictEqual(
        found,
        [],
        `${path.basename(file)} leaks conversation handle(s): ${found.join(", ")}`,
      );
    }
  });

  test("no cassette contains a credential", () => {
    for (const file of fixtureFiles()) {
      const text = fixtureText(file);
      for (const [name, pattern] of SECRET_SHAPES) {
        const found = offenders(text, pattern);
        assert.deepStrictEqual(
          found,
          [],
          `${path.basename(file)} leaks a ${name}: ${found.join(", ")}`,
        );
      }
    }
  });

  test("no cassette contains the recorder's home directory", () => {
    for (const file of fixtureFiles()) {
      const found = offenders(fixtureText(file), HOME_PATH, VENDOR_HOME_PATHS);
      assert.deepStrictEqual(
        found,
        [],
        `${path.basename(file)} leaks home path(s): ${found.join(", ")}`,
      );
    }
  });

  // The account endpoints answer with the recorder's plan, quota and credit balance, and drive no
  // inference — LOCAL_BOOTSTRAP serves them so they never reach a cassette.
  test("no cassette records an account or billing endpoint", () => {
    for (const file of fixtureFiles()) {
      const found = expectationsOf(file)
        .map((expectation) => String(expectation.httpRequest?.path ?? ""))
        .filter((requestPath) => ACCOUNT_ENDPOINT.test(requestPath));
      assert.deepStrictEqual(
        found,
        [],
        `${path.basename(file)} records account endpoint(s): ${found.join(", ")}`,
      );
    }
  });

  // The deny-by-default header policy is what stops a future provider header — a Set-Cookie above all
  // — becoming committable, so the committed shape is asserted, not just the transform that makes it.
  test("a cassette stores only the Kiro operation request header and response Content-Type", () => {
    for (const file of fixtureFiles()) {
      expectationsOf(file).forEach((expectation, index) => {
        const where = `${path.basename(file)}#${index}`;
        const isKiro = path.basename(file).endsWith(".kiro.json");
        assert.deepStrictEqual(
          Object.keys(expectation.httpRequest ?? {}).filter(
            (key) => !["method", "path", "body", ...(isKiro ? ["headers"] : [])].includes(key),
          ),
          [],
          `${where} stores request matcher fields beyond the whitelist`,
        );
        assert.deepStrictEqual(
          Object.keys((expectation.httpRequest?.headers as Record<string, unknown>) ?? {}),
          isKiro ? ["x-amz-target"] : [],
          `${where} stores a request header outside the whitelist`,
        );
        assert.deepStrictEqual(
          Object.keys(expectation.httpResponse?.headers ?? {}).filter(
            (key) => key !== "Content-Type",
          ),
          [],
          `${where} stores a response header outside the whitelist`,
        );
      });
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

  // The request normalizer deletes these outright, but the provider echoes them back inside the SSE
  // response, where only scrubIdentity runs.
  test("scrubIdentity replaces the conversation handles a response echoes back", () => {
    const scrubbed = scrubIdentity(
      JSON.stringify({
        response: { prompt_cache_key: "ses_0232f763effeQbE1qXCwIy4XCj" },
        internal_chat_message_metadata_passthrough: {
          turn_id: "019fdccf-6990-78f2-972e-59db23528aa8",
        },
      }),
    );

    assert.ok(!scrubbed.includes("ses_0232f763effeQbE1qXCwIy4XCj"));
    assert.ok(!scrubbed.includes("019fdccf-6990-78f2-972e-59db23528aa8"));
    assert.deepStrictEqual(
      [...scrubbed.matchAll(SESSION_HANDLE)].map((match) => match[1]),
      ["PAIRETO_E2E_ID", "PAIRETO_E2E_ID"],
    );
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
