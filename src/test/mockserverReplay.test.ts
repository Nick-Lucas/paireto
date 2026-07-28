// Pure-logic coverage for the provider-replay E2E layer (src/e2e/mockserver/). The record/check flow
// itself is validated end-to-end against the real MockServer container by the E2E suite; these tests
// pin the three pieces that must be correct BEFORE a run and can't be observed from a green E2E:
//   1. mode parsing (a typo must fail loud, not silently fall back to live),
//   2. the fixture-normalization transform (strip volatile request matchers — the difference between
//      every strict replay 599-ing and a clean offline match),
//   3. MCP response parsing (MockServer answers as raw JSON or a single SSE frame).

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { extractJsonRpc } from "../e2e/mockserver/mcpClient.js";
import {
  isSuccessfulRecording,
  normalizeCapturedResponses,
  stripVolatileRequestMatchers,
  unwrapExpectations,
} from "../e2e/mockserver/MockServerController.js";
import { fixtureFileName, isMockMode, resolveCase, resolveMode } from "../e2e/mockserver/mode.js";
import { mockProxyEnv } from "../e2e/mockserver/proxyEnv.js";
import {
  isPairetoTool,
  normalizeClaudeBody,
  normalizeCodexBody,
  normalizeOpenCodeBody,
} from "../e2e/proxy/normalize.js";

const codexBridge = require("../../plugins/codex/scripts/bridge.js") as {
  readPlanTurn: (
    transcriptPath: string,
    turnId: string,
  ) => { isPlanTurn: boolean; planMarkdown?: string };
};

suite("provider-replay: mode parsing", () => {
  test("defaults to live when unset", () => {
    assert.strictEqual(resolveMode({}), "live");
    assert.strictEqual(isMockMode("live"), false);
  });

  test("parses record/check case-insensitively and marks them mock modes", () => {
    assert.strictEqual(resolveMode({ PAIRETO_E2E_MODE: "record" }), "record");
    assert.strictEqual(resolveMode({ PAIRETO_E2E_MODE: "CHECK" }), "check");
    assert.strictEqual(isMockMode("record"), true);
    assert.strictEqual(isMockMode("check"), true);
  });

  test("throws on an unknown mode rather than silently falling back", () => {
    assert.throws(() => resolveMode({ PAIRETO_E2E_MODE: "replay" }), /invalid/);
  });

  test("test case defaults to fullflow, overridable, and namespaces the fixture per (case, driver)", () => {
    assert.strictEqual(resolveCase({}), "fullflow");
    assert.strictEqual(resolveCase({ PAIRETO_E2E_CASE: "plan-only" }), "plan-only");
    assert.strictEqual(resolveCase({ PAIRETO_E2E_CASE: "  " }), "fullflow");
    assert.strictEqual(fixtureFileName("fullflow", "claudecode"), "fullflow.claudecode.json");
    assert.strictEqual(fixtureFileName("plan-only", "codex"), "plan-only.codex.json");
  });
});

suite("provider-replay: fixture normalization", () => {
  test("keeps successful captures and drops transient provider failures", () => {
    assert.strictEqual(isSuccessfulRecording({ httpResponse: { statusCode: 200 } }), true);
    assert.strictEqual(isSuccessfulRecording({ httpResponse: { statusCode: 302 } }), true);
    assert.strictEqual(isSuccessfulRecording({ httpResponse: { statusCode: 405 } }), false);
    assert.strictEqual(isSuccessfulRecording({ httpResponse: { statusCode: 503 } }), false);
    assert.strictEqual(isSuccessfulRecording({}), false);
  });

  test("reduces each request matcher to method/path/body, dropping volatile headers", () => {
    const list = [
      {
        httpRequest: {
          method: "POST",
          path: "/v1/messages",
          headers: {
            Host: ["host.docker.internal:55038"],
            accept: ["*/*"],
            Cookie: ["session=must-never-be-stored"],
          },
          keepAlive: true,
          secure: false,
          protocol: "HTTP_1_1",
          localAddress: "172.17.0.2:1080",
          remoteAddress: "192.168.65.1:17747",
          body: '{"model":"m","messages":[]}',
        },
        httpResponse: { statusCode: 200 },
      },
    ];
    const [exp] = stripVolatileRequestMatchers(list);
    assert.deepStrictEqual(exp.httpRequest, {
      method: "POST",
      path: "/v1/messages",
      body: '{"model":"m","messages":[]}',
    });
    // the response side is untouched
    assert.deepStrictEqual((list[0] as { httpResponse?: unknown }).httpResponse, {
      statusCode: 200,
    });
  });

  test("omits body when the recorded request had none, and tolerates a missing matcher", () => {
    const [withNoBody, noMatcher] = stripVolatileRequestMatchers([
      { httpRequest: { method: "GET", path: "/v1/models" } },
      {},
    ]);
    assert.deepStrictEqual(withNoBody.httpRequest, { method: "GET", path: "/v1/models" });
    assert.deepStrictEqual(noMatcher, {});
  });

  test("unwraps the shapes raw_retrieve can return", () => {
    const one = { httpRequest: { method: "POST", path: "/x" } };
    assert.deepStrictEqual(unwrapExpectations([one]), [one]);
    assert.deepStrictEqual(unwrapExpectations({ data: [one] }), [one]);
    assert.deepStrictEqual(unwrapExpectations({ expectations: [one] }), [one]);
  });

  test("whitelists only Content-Type in stored responses and drops every cookie value", () => {
    const [codex] = normalizeCapturedResponses(
      [
        {
          httpRequest: { method: "POST", path: "/backend-api/codex/responses" },
          httpResponse: {
            statusCode: 200,
            cookies: { session: "must-never-be-stored" },
            headers: {
              "content-type": ["application/json"],
              "Set-Cookie": ["session=must-never-be-stored; HttpOnly"],
              "x-future-provider-secret": ["also-must-never-be-stored"],
            },
          },
        },
      ],
      "codex",
    );
    assert.deepStrictEqual(codex.httpResponse?.headers, {
      "Content-Type": ["text/event-stream; charset=utf-8"],
    });
    assert.strictEqual(codex.httpResponse?.cookies, undefined);

    const [claude] = normalizeCapturedResponses(
      [
        {
          httpRequest: { method: "POST", path: "/v1/messages" },
          httpResponse: {
            statusCode: 200,
            cookies: { account: "must-never-be-stored" },
            headers: {
              "Content-Type": ["text/event-stream; charset=utf-8"],
              "set-cookie": ["account=must-never-be-stored"],
              "request-id": ["not-needed-for-replay"],
            },
          },
        },
      ],
      "claudecode",
    );
    assert.deepStrictEqual(claude.httpResponse?.headers, {
      "Content-Type": ["text/event-stream; charset=utf-8"],
    });
    assert.strictEqual(claude.httpResponse?.cookies, undefined);
  });

  test("normalizes Claude runtime policy, tool inventory, cache metadata, and workflow results", () => {
    const normalized = JSON.parse(
      normalizeClaudeBody(
        JSON.stringify({
          model: "claude-haiku-4-5",
          metadata: { session_id: "volatile" },
          system: "volatile environment",
          tools: [
            { name: "new-cli-tool", description: "prose that churns every CLI release" },
            {
              name: "mcp__paireto__paireto_review",
              description: "prose",
              input_schema: { type: "object", properties: { reviewId: { type: "string" } } },
            },
          ],
          mcp_servers: [{ name: "account-server", url: "https://volatile" }],
          thinking: { type: "enabled", budget_tokens: 1234 },
          context_management: { edits: [] },
          temperature: 1,
          output_config: { effort: "high" },
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "write-1",
                  name: "Write",
                  input: { file_path: "/tmp/home/plans/plan-random-slug.md" },
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "write-1",
                  content: "File written to /tmp/home/plans/plan-random-slug.md (151 bytes)",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "exit-1",
                  name: "ExitPlanMode",
                  input: {
                    plan: "volatile repeated plan",
                    planFilePath: "/tmp/home/plans/plan-random-slug.md",
                  },
                },
              ],
            },
          ],
        }),
      ),
    );
    assert.strictEqual(normalized.model, "claude-haiku-4-5");
    assert.strictEqual(normalized.metadata, null);
    assert.strictEqual(normalized.system, null);
    // The inventory is REDUCED, not erased: every tool keeps its name (sorted, since order varies),
    // and Paireto's own tool keeps its schema so a broken definition still fails replay.
    assert.deepStrictEqual(normalized.tools, [
      {
        name: "mcp__paireto__paireto_review",
        input_schema: { type: "object", properties: { reviewId: { type: "string" } } },
      },
      { name: "new-cli-tool" },
    ]);
    assert.deepStrictEqual(normalized.mcp_servers, [{ name: "account-server" }]);
    assert.strictEqual(normalized.thinking, undefined);
    assert.strictEqual(normalized.context_management, undefined);
    assert.strictEqual(normalized.temperature, undefined);
    assert.strictEqual(normalized.output_config, undefined);
    assert.strictEqual(normalized.messages[0].content[0].cache_control, undefined);
    assert.strictEqual(normalized.messages[1].content[0].cache_control, undefined);
    assert.strictEqual(normalized.messages[1].content[0].content, "WRITE_RESULT_NORMALIZED");
    assert.strictEqual(
      normalized.messages[0].content[0].input.file_path,
      "/tmp/home/plans/plan-NORMALIZED.md",
    );
    assert.deepStrictEqual(normalized.messages[2].content[0].input, {});
  });

  // A credential-free check run gets one fewer <system-reminder> than a subscription record run, so
  // the match key has to survive the difference in block count.
  test("a differing number of system-reminders produces the same match key", () => {
    const withReminders = (count: number): string =>
      JSON.stringify({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              ...Array.from({ length: count }, () => ({
                type: "text",
                text: "<system-reminder>account-specific noise</system-reminder>",
              })),
              { type: "text", text: "\n" },
              { type: "text", text: "Plan how to add hello.txt" },
            ],
          },
        ],
      });

    assert.strictEqual(
      normalizeClaudeBody(withReminders(3)),
      normalizeClaudeBody(withReminders(4)),
    );
    // …while every block with real content survives.
    const kept = JSON.parse(normalizeClaudeBody(withReminders(3))) as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    assert.deepStrictEqual(
      kept.messages[0].content.map((b) => b.text),
      ["Plan how to add hello.txt"],
    );
  });

  test("normalizes Codex account context and custom-tool envelopes without erasing output", () => {
    const raw = JSON.stringify({
      client_metadata: { volatile: true },
      instructions: "volatile",
      prompt_cache_key: "volatile",
      reasoning: { effort: "high" },
      user: "account-id",
      input: [
        {
          role: "developer",
          content: [
            { type: "input_text", text: "stable" },
            { type: "input_text", text: "<environment_context>machine</environment_context>" },
          ],
        },
        {
          role: "developer",
          content: [
            { type: "input_text", text: "<collaboration_mode>transition</collaboration_mode>" },
          ],
        },
        {
          type: "custom_tool_call_output",
          output: [{ type: "input_text", text: "generated envelope" }, { text: "stable output" }],
          internal_chat_message_metadata_passthrough: { volatile: true },
        },
      ],
    });
    const normalized = JSON.parse(normalizeCodexBody(raw));
    assert.strictEqual(normalized.client_metadata, undefined);
    assert.strictEqual(normalized.instructions, undefined);
    assert.strictEqual(normalized.prompt_cache_key, undefined);
    assert.strictEqual(normalized.reasoning, undefined);
    assert.strictEqual(normalized.user, undefined);
    assert.strictEqual(normalized.input.length, 2);
    assert.strictEqual(
      normalized.input[0].content[1].text,
      "<environment_context>NORMALIZED</environment_context>",
    );
    assert.strictEqual(normalized.input[1].internal_chat_message_metadata_passthrough, undefined);
    assert.strictEqual(normalized.input[1].output[0].text, "NORMALIZED");
    assert.strictEqual(normalized.input[1].output[1].text, "stable output");
  });

  // Codex stamps a fresh `msg_<uuidv7>` on every conversation item, so a replayed body could never
  // match verbatim; renumbering keeps distinct ids distinct and their call/output pairing intact.
  test("renumbers Codex per-run item ids, preserving their pairing", () => {
    const body = (runId: string): string =>
      JSON.stringify({
        input: [
          { type: "message", id: `msg_${runId}-a`, role: "developer", content: [] },
          { type: "function_call", id: `fc_${runId}-b`, call_id: `call_${runId}-c` },
          { type: "function_call_output", call_id: `call_${runId}-c`, output: "stable" },
        ],
      });

    const first = normalizeCodexBody(body("019fdc69"));
    assert.strictEqual(first, normalizeCodexBody(body("019fdc62")));

    const parsed = JSON.parse(first) as {
      input: Array<{ id?: string; call_id?: string; output?: string }>;
    };
    assert.notStrictEqual(parsed.input[0].id, parsed.input[1].id, "distinct ids stay distinct");
    assert.strictEqual(
      parsed.input[1].call_id,
      parsed.input[2].call_id,
      "a call still pairs with its output",
    );
    assert.strictEqual(parsed.input[2].output, "stable", "content is untouched");
  });

  test("keeps Paireto's OpenCode tool schema but drops built-in tool schema churn", () => {
    const pairetoSchema = { type: "object", properties: { plan: { type: "string" } } };
    const raw = JSON.stringify({
      tools: [
        {
          type: "function",
          name: "paireto_submit_plan",
          description: "Open plan review",
          parameters: pairetoSchema,
        },
        {
          type: "function",
          name: "bash",
          description: "Run a command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      input: [{ role: "user", content: [{ type: "input_text", text: "plan" }] }],
    });
    const normalized = JSON.parse(normalizeOpenCodeBody(raw));
    // A broken paireto_submit_plan schema must still fail replay.
    assert.strictEqual(normalized.tools[0].name, "paireto_submit_plan");
    assert.deepStrictEqual(normalized.tools[0].parameters, pairetoSchema);
    assert.strictEqual(normalized.tools[1].name, "bash");
    assert.strictEqual(normalized.tools[1].parameters, undefined);
    assert.deepStrictEqual(JSON.parse(normalizeCodexBody(raw)).tools[0].parameters, pairetoSchema);
  });

  // A cassette recorded on one machine has to replay on another: built-in descriptions state the
  // host OS and shell, and Codex's skills block enumerates whatever SKILL.md files that host can see.
  test("drops host-dependent built-in tool descriptions but keeps Paireto's", () => {
    const body = (os: string): string =>
      JSON.stringify({
        tools: [
          { type: "function", name: "bash", description: `Be aware: OS: ${os}`, parameters: {} },
          { type: "function", name: "paireto_submit_plan", description: "Open plan review" },
        ],
      });

    assert.strictEqual(normalizeOpenCodeBody(body("linux")), normalizeOpenCodeBody(body("darwin")));

    const tools = (
      JSON.parse(normalizeOpenCodeBody(body("linux"))) as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools;
    assert.strictEqual(tools[0].description, undefined, "built-in description dropped");
    assert.strictEqual(tools[1].description, "Open plan review", "Paireto's is kept");
  });

  test("normalizes Codex's host-dependent skills block", () => {
    const body = (skills: string): string =>
      JSON.stringify({
        input: [
          {
            role: "developer",
            content: [
              { type: "input_text", text: `<skills_instructions>${skills}</skills_instructions>` },
            ],
          },
        ],
      });

    assert.strictEqual(
      normalizeCodexBody(body("one skill at /workspace")),
      normalizeCodexBody(body("many skills at /Users/dev")),
    );
  });

  test("recognises Paireto's own tools across each harness's naming", () => {
    for (const name of [
      "paireto_submit_plan",
      "paireto_review",
      "mcp__paireto__paireto_review",
      "mcp__plugin_paireto_bridge__paireto_review",
    ]) {
      assert.strictEqual(isPairetoTool(name), true, name);
    }
    for (const name of ["bash", "Write", "ExitPlanMode", "update_plan"]) {
      assert.strictEqual(isPairetoTool(name), false, name);
    }
  });
});

suite("provider-replay: Codex replay turn correlation", () => {
  test("does not reuse a stale Plan item for a later implementation Stop", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-codex-transcript-"));
    const transcript = path.join(dir, "rollout.jsonl");
    const previousMode = process.env.PAIRETO_E2E_MODE;
    try {
      fs.writeFileSync(
        transcript,
        [
          JSON.stringify({
            type: "event_msg",
            payload: { type: "item_completed", item: { type: "Plan", text: "stale plan" } },
          }),
          JSON.stringify({
            type: "turn_context",
            payload: {
              turn_id: "implementation-turn",
              collaboration_mode: { mode: "default" },
            },
          }),
          JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "assistant", content: "implementation complete" },
          }),
        ].join("\n"),
      );
      process.env.PAIRETO_E2E_MODE = "check";
      assert.deepStrictEqual(codexBridge.readPlanTurn(transcript, "implementation-turn"), {
        isPlanTurn: false,
      });
    } finally {
      if (previousMode === undefined) {
        delete process.env.PAIRETO_E2E_MODE;
      } else {
        process.env.PAIRETO_E2E_MODE = previousMode;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts an explicit proposed-plan wrapper inside the target replay turn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-codex-transcript-"));
    const transcript = path.join(dir, "rollout.jsonl");
    const previousMode = process.env.PAIRETO_E2E_MODE;
    try {
      fs.writeFileSync(
        transcript,
        [
          JSON.stringify({
            type: "turn_context",
            payload: { turn_id: "plan-turn", collaboration_mode: { mode: "default" } },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: "<proposed_plan>one safe step</proposed_plan>",
            },
          }),
        ].join("\n"),
      );
      process.env.PAIRETO_E2E_MODE = "check";
      assert.deepStrictEqual(codexBridge.readPlanTurn(transcript, "plan-turn"), {
        isPlanTurn: true,
        planMarkdown: "one safe step",
      });
    } finally {
      if (previousMode === undefined) {
        delete process.env.PAIRETO_E2E_MODE;
      } else {
        process.env.PAIRETO_E2E_MODE = previousMode;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not treat a message that merely QUOTES a plan as a new plan proposal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-codex-transcript-"));
    const transcript = path.join(dir, "rollout.jsonl");
    try {
      fs.writeFileSync(
        transcript,
        [
          JSON.stringify({
            type: "turn_context",
            payload: { turn_id: "implementation-turn", collaboration_mode: { mode: "default" } },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              // An implementation turn recapping the agreed plan, which belongs at a review gate.
              content:
                "As agreed: <proposed_plan>one safe step</proposed_plan> — implementation done.",
            },
          }),
        ].join("\n"),
      );
      assert.deepStrictEqual(codexBridge.readPlanTurn(transcript, "implementation-turn"), {
        isPlanTurn: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite("provider-replay: transparent proxy env", () => {
  test("points the standard proxy vars at MockServer and trusts its CA, sparing loopback", () => {
    const env = mockProxyEnv("http://127.0.0.1:9999", "/tmp/ca.pem");
    assert.strictEqual(env.HTTPS_PROXY, "http://127.0.0.1:9999");
    assert.strictEqual(env.https_proxy, "http://127.0.0.1:9999");
    assert.strictEqual(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
    assert.strictEqual(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.match(env.NO_PROXY ?? "", /127\.0\.0\.1/);
    // deliberately does NOT set a provider base URL — the harness keeps its real host + credentials
    assert.strictEqual(env.ANTHROPIC_BASE_URL, undefined);
  });
});

suite("provider-replay: MCP response parsing", () => {
  test("parses a raw JSON body", () => {
    const rpc = extractJsonRpc('{"result":{"content":[{"type":"text","text":"ok"}]}}');
    assert.strictEqual(rpc.result?.content?.[0]?.text, "ok");
  });

  test("parses the last data: frame of an SSE body", () => {
    const sse =
      'event: message\ndata: {"result":{"content":[{"type":"text","text":"from-sse"}]}}\n\n';
    const rpc = extractJsonRpc(sse);
    assert.strictEqual(rpc.result?.content?.[0]?.text, "from-sse");
  });

  test("surfaces a JSON-RPC error object", () => {
    const rpc = extractJsonRpc('{"error":{"code":-32601,"message":"nope"}}');
    assert.strictEqual(rpc.error?.message, "nope");
  });

  test("throws on an unparseable body", () => {
    assert.throws(() => extractJsonRpc("not json and no data lines"), /no parseable body/);
  });
});
