// Pure-logic coverage for the provider-replay E2E layer (src/e2e/mockserver/). The record/check flow
// itself is validated end-to-end against the real MockServer container by the E2E suite; these tests
// pin the three pieces that must be correct BEFORE a run and can't be observed from a green E2E:
//   1. mode parsing (a typo must fail loud, not silently fall back to record),
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
  localBootstrapFor,
  nativeMockServerDockerArgs,
  normalizingProxyPlan,
  normalizeCapturedResponses,
  recordsRequest,
  stripVolatileRequestMatchers,
  unwrapExpectations,
} from "../e2e/mockserver/MockServerController.js";
import {
  E2E_DRIVERS,
  filterPairs,
  fixtureFileName,
  pairLabel,
  resolveMode,
} from "../e2e/mockserver/mode.js";
import { mockProxyEnv, resolveMockProxy } from "../e2e/mockserver/proxyEnv.js";
import {
  isPairetoTool,
  normalizeClaudeBody,
  normalizeCodexBody,
  normalizeKiroBody,
  normalizeOpenCodeBody,
} from "../e2e/proxy/normalize.js";
import { isEventStreamContentType } from "../e2e/proxy/normalizingProxy.js";

import { readPlanTurn as readPlanTurnFrom } from "../plugins/agent-plugin/com.openai.codex/planTurn.js";

interface NormalizedTool {
  description?: string;
  parameters?: unknown;
}

/** A normalized body's tools keyed by name — the inventory is sorted, so position means nothing. */
function toolsByName(normalizedBody: string): Map<string, NormalizedTool> {
  const { tools } = JSON.parse(normalizedBody) as {
    tools?: Array<NormalizedTool & { name: string }>;
  };
  return new Map((tools ?? []).map((tool) => [tool.name, tool]));
}

suite("provider-replay: mode parsing", () => {
  test("defaults to record when unset", () => {
    assert.strictEqual(resolveMode({}), "record");
  });

  test("parses record/check case-insensitively", () => {
    assert.strictEqual(resolveMode({ PAIRETO_E2E_MODE: "record" }), "record");
    assert.strictEqual(resolveMode({ PAIRETO_E2E_MODE: "CHECK" }), "check");
  });

  test("rejects the removed live mode and unknown modes", () => {
    assert.throws(() => resolveMode({ PAIRETO_E2E_MODE: "live" }), /invalid/);
    assert.throws(() => resolveMode({ PAIRETO_E2E_MODE: "replay" }), /invalid/);
  });

  test("the fixture is namespaced per (case, driver)", () => {
    assert.strictEqual(fixtureFileName("fullflow", "claudecode"), "fullflow.claudecode.json");
    assert.strictEqual(fixtureFileName("plan-only", "codex"), "plan-only.codex.json");
  });
});

suite("provider-replay: matrix selection", () => {
  const matrix = ["fullflow", "plan-only"].flatMap((testCase) =>
    E2E_DRIVERS.map((driver) => ({
      label: pairLabel(testCase, driver),
      testCase,
      driver,
    })),
  );
  const labels = (pairs: { label: string }[]): string[] => pairs.map((pair) => pair.label);

  test("includes every supported terminal harness", () => {
    assert.deepStrictEqual(E2E_DRIVERS, ["claudecode", "codex", "kiro", "opencode"]);
  });

  test("a pair is labelled with its case and a driver tag, which is its suite title", () => {
    assert.strictEqual(pairLabel("fullflow", "codex"), "fullflow @codex");
  });

  test("no filter selects the whole matrix", () => {
    assert.strictEqual(filterPairs(matrix, {}).length, 8);
  });

  test("a driver tag selects that driver across every case", () => {
    assert.deepStrictEqual(labels(filterPairs(matrix, { grep: "@codex" })), [
      "fullflow @codex",
      "plan-only @codex",
    ]);
  });

  test("a case name selects every driver of that case", () => {
    assert.deepStrictEqual(labels(filterPairs(matrix, { grep: "^fullflow " })), [
      "fullflow @claudecode",
      "fullflow @codex",
      "fullflow @kiro",
      "fullflow @opencode",
    ]);
  });

  test("the driver tag cannot match a driver whose name merely contains it", () => {
    assert.deepStrictEqual(labels(filterPairs(matrix, { fgrep: "@codex" })), [
      "fullflow @codex",
      "plan-only @codex",
    ]);
  });

  test("a pattern that matches no pair selects nothing, rather than everything", () => {
    assert.deepStrictEqual(filterPairs(matrix, { grep: "@nosuchdriver" }), []);
  });
});

suite("provider-replay: recorded endpoints", () => {
  test("only conversation endpoints are recorded", () => {
    for (const driver of ["claudecode", "codex", "opencode"] as const) {
      assert.strictEqual(
        recordsRequest(driver, { path: "/backend-api/wham/usage" }),
        false,
        driver,
      );
      assert.strictEqual(
        recordsRequest(driver, { path: "/backend-api/wham/rate-limit-reset-credits" }),
        false,
        driver,
      );
    }
    assert.strictEqual(recordsRequest("claudecode", { path: "/v1/messages" }), true);
    assert.strictEqual(recordsRequest("codex", { path: "/backend-api/codex/responses" }), true);
    assert.strictEqual(recordsRequest("opencode", { path: "/backend-api/codex/responses" }), true);
  });

  test("records only Kiro model inference on its shared AWS path", () => {
    const request = (target: string) => ({
      path: "/",
      headers: { "x-amz-target": [target] },
    });
    assert.strictEqual(
      recordsRequest("kiro", request("KiroRuntimeService.GenerateAssistantResponse")),
      true,
    );
    // Kiro proxies MCP JSON-RPC through this operation, and `tools/list` rides on it: a replay that
    // cannot answer it never learns Paireto's tools exist and diverges from the recorded run.
    assert.strictEqual(recordsRequest("kiro", request("KiroRuntimeService.InvokeMCP")), true);
    // Recorded because their answers end up inside the next request: the feature configuration
    // decides the advertised tool inventory, the model catalogue supplies the display name Kiro
    // writes into its own system prompt.
    assert.ok(recordsRequest("kiro", request("KiroRuntimeService.GetFeatureConfiguration")));
    assert.ok(recordsRequest("kiro", request("KiroControlPlaneBearerService.ListAvailableModels")));
    assert.strictEqual(
      recordsRequest("kiro", request("AmazonCodeWhispererService.GetProfile")),
      false,
    );
  });

  // Codex refuses to start a turn without them, so dropping them from the cassette only works if the
  // bootstrap answers them locally.
  test("Codex's account endpoints are answered from the local bootstrap", () => {
    const paths = localBootstrapFor("codex")
      .map((entry) => entry.httpRequest.path)
      .sort();
    assert.deepStrictEqual(paths, [
      "/backend-api/wham/rate-limit-reset-credits",
      "/backend-api/wham/usage",
    ]);

    const usage = localBootstrapFor("codex").find(
      (entry) => entry.httpRequest.path === "/backend-api/wham/usage",
    );
    const body = JSON.parse(String(usage?.httpResponse.body)) as {
      plan_type: string;
      rate_limit: { allowed: boolean };
    };
    assert.strictEqual(body.rate_limit.allowed, true, "the run must not be rate-limited");
    assert.ok(!/pro|plus|team|enterprise/i.test(body.plan_type), "states no real subscription");
  });
});

suite("provider-replay: fixture normalization", () => {
  test("normalizes Kiro request identities without using the Codex schema", () => {
    const first = normalizeKiroBody(
      JSON.stringify({
        conversationId: "conversation-a",
        agentContinuationId: "continuation-a",
        messages: [{ toolUseId: "tool-a", text: "Keep this prompt" }],
      }),
    );
    const second = normalizeKiroBody(
      JSON.stringify({
        conversationId: "conversation-b",
        agentContinuationId: "continuation-b",
        messages: [{ toolUseId: "tool-b", text: "Keep this prompt" }],
      }),
    );
    assert.strictEqual(first, second);
    assert.ok(first.includes("Keep this prompt"));
  });

  // normalizeKiroBody walks every object, so an array named `tools` that is NOT an inventory (a tool
  // result quoting one, say) must be left exactly as it is — sorting it would reorder content.
  test("leaves an array named tools alone when it is not an inventory", () => {
    const body = JSON.stringify({
      conversationState: {
        history: [{ userInputMessage: { content: "x", tools: ["zebra", "apple"] } }],
      },
    });

    const parsed = JSON.parse(normalizeKiroBody(body)) as {
      conversationState: { history: Array<{ userInputMessage: { tools: string[] } }> };
    };
    assert.deepStrictEqual(parsed.conversationState.history[0].userInputMessage.tools, [
      "zebra",
      "apple",
    ]);
  });

  // The recorder signs in with OAuth and sends a profile ARN; replay uses an API key and sends none.
  // The ARN also spells out an AWS account id, so it must not reach a committed cassette.
  test("drops the Kiro profile ARN, which differs by auth method and names an account", () => {
    const withArn = normalizeKiroBody(
      JSON.stringify({
        origin: "KIRO_CLI",
        version: "2.18.0",
        profileArn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
      }),
    );
    const withoutArn = normalizeKiroBody(JSON.stringify({ origin: "KIRO_CLI", version: "2.18.0" }));

    assert.strictEqual(withArn, withoutArn);
    assert.ok(!withArn.includes("699475941385"));
  });

  // Kiro advertises its built-in tools with full JSON Schemas, and which ones it offers depends on
  // what its account/governance lookup answered — a check run reaches none of that, so the schemas
  // it sends differ from the recording. Reduce them the way the other harnesses are reduced.
  test("reduces Kiro's built-in tool inventory but keeps Paireto's own tools whole", () => {
    const inventory = (tools: unknown[]): string =>
      JSON.stringify({
        conversationState: {
          currentMessage: {
            userInputMessage: { userInputMessageContext: { tools } },
          },
        },
      });
    const builtin = (name: string, property: string): unknown => ({
      toolSpecification: {
        name,
        description: `does ${property} things on ${name}`,
        inputSchema: { json: { type: "object", properties: { [property]: { type: "string" } } } },
      },
    });
    const paireto = {
      toolSpecification: {
        name: "paireto_start_guided_review",
        description: "Hand a review plan to the human reviewer and wait for feedback.",
        inputSchema: { json: { type: "object", properties: { changesets: { type: "array" } } } },
      },
    };

    // The recorder is signed in and is offered remote_web_search; the credential-free replay is not,
    // so an entitled tool must not reach the match key.
    const recorded = normalizeKiroBody(
      inventory([builtin("web_search", "query"), builtin("remote_web_search", "query"), paireto]),
    );
    const replayed = normalizeKiroBody(inventory([paireto, builtin("web_search", "command")]));

    assert.strictEqual(recorded, replayed, "a churning built-in schema must not break replay");
    assert.ok(recorded.includes("web_search"), "a tool that stops being offered must break replay");
    assert.ok(
      recorded.includes("Hand a review plan to the human reviewer"),
      "Paireto's own tool keeps its description, so a regression in it breaks replay",
    );
    assert.ok(
      recorded.includes("changesets"),
      "Paireto's own tool keeps its schema, so a lost parameter breaks replay",
    );
  });

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

  test("keeps only Kiro's operation header so POST root requests remain distinct", () => {
    const [exp] = stripVolatileRequestMatchers(
      [
        {
          httpRequest: {
            method: "POST",
            path: "/",
            headers: {
              authorization: ["Bearer must-never-be-stored"],
              "x-amz-target": ["KiroRuntimeService.GenerateAssistantResponse"],
            },
            body: "{}",
          },
        },
      ],
      "kiro",
    );
    assert.deepStrictEqual(exp.httpRequest, {
      method: "POST",
      path: "/",
      headers: {
        "x-amz-target": ["KiroRuntimeService.GenerateAssistantResponse"],
      },
      body: "{}",
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
    // and Paireto's own tool is kept whole so a broken definition still fails replay.
    assert.deepStrictEqual(normalized.tools, [
      {
        name: "mcp__paireto__paireto_review",
        description: "prose",
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

  test("normalizes timestamps in Codex directory listings", () => {
    const body = (time: string, name = "src"): string =>
      JSON.stringify({
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "bash",
            arguments: JSON.stringify({ command: "ls -la && ls -la src" }),
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: `total 4\ndrwxr-xr-x 2 root root 4096 Aug 14 ${time} ${name}`,
          },
        ],
      });

    assert.strictEqual(normalizeOpenCodeBody(body("09:38")), normalizeOpenCodeBody(body("10:19")));
    assert.notStrictEqual(
      normalizeOpenCodeBody(body("09:38")),
      normalizeOpenCodeBody(body("09:38", "docs")),
    );
  });

  test("orders parallel tool results by id, so a race between two commands cannot change the key", () => {
    const body = (first: string, second: string): string =>
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "keep me first" },
              { type: "tool_result", tool_use_id: first, content: `out-${first}` },
              { type: "tool_result", tool_use_id: second, content: `out-${second}` },
            ],
          },
        ],
      });

    const normalized = normalizeClaudeBody(body("toolu_a", "toolu_b"));
    assert.strictEqual(normalized, normalizeClaudeBody(body("toolu_b", "toolu_a")));
    const parsed = JSON.parse(normalized) as {
      messages: Array<{ content: Array<{ type: string; tool_use_id?: string; content?: string }> }>;
    };
    const blocks = parsed.messages[0].content;
    assert.strictEqual(blocks[0].type, "text", "ordinary content must not be reordered");
    assert.deepStrictEqual(
      blocks.slice(1).map((b) => b.tool_use_id),
      ["toolu_a", "toolu_b"],
    );
    // Each result must still carry ITS OWN output — sorting moves whole blocks, never their contents.
    assert.strictEqual(blocks[1].content, "out-toolu_a");
    assert.strictEqual(blocks[2].content, "out-toolu_b");
  });

  test("trims only trailing whitespace from a tool result, so a stray blank line cannot miss", () => {
    const body = (suffix: string): string =>
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t", content: `1\tline\n2\t}${suffix}` }],
          },
        ],
      });

    assert.strictEqual(normalizeClaudeBody(body("")), normalizeClaudeBody(body("\n\n")));
    const parsed = JSON.parse(normalizeClaudeBody(body("\n\n"))) as {
      messages: Array<{ content: Array<{ content: string }> }>;
    };
    // Interior newlines and indentation are the model's actual input — only the tail goes.
    assert.strictEqual(parsed.messages[0].content[0].content, "1\tline\n2\t}");
  });

  test("collapses the Codex plugin-cache version, so a plugin bump alone cannot invalidate a cassette", () => {
    const body = (version: string): string =>
      JSON.stringify({
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `<hook_prompt hook_run_id="stop:8:/tmp/home/plugins/cache/paireto/paireto/${version}/hooks/hooks.json">go</hook_prompt>`,
              },
            ],
          },
        ],
      });

    assert.strictEqual(normalizeCodexBody(body("0.5.7")), normalizeCodexBody(body("0.9.12")));
    assert.ok(normalizeCodexBody(body("0.5.7")).includes("paireto/paireto/VERSION/hooks"));
    // The path still has to be there — only its version segment is noise.
    assert.ok(normalizeCodexBody(body("0.5.7")).includes("plugins/cache/paireto"));
  });

  // Codex stamps a fresh `msg_<uuidv7>` on every conversation item, so a replayed body could never
  // match verbatim; renumbering keeps distinct ids distinct and their call/output pairing intact.
  test("scrubs the plugin version out of a Codex hook_run_id", () => {
    // Codex names the staged plugin's hooks.json in every hook_run_id, and that path carries the
    // plugin version — so without this a routine version bump invalidates every recorded body that
    // carries a hook prompt.
    const body = (version: string): string =>
      JSON.stringify({
        input: [
          {
            type: "message",
            content: [
              {
                type: "input_text",
                text: `<hook_prompt hook_run_id="stop:8:/home/plugins/cache/paireto/paireto/${version}/hooks/hooks.json">go</hook_prompt>`,
              },
            ],
          },
        ],
      });

    const normalized = normalizeCodexBody(body("0.5.7"));
    assert.strictEqual(normalized, normalizeCodexBody(body("9.9.9")));
    assert.ok(normalized.includes("cache/paireto/paireto/VERSION/hooks/hooks.json"));
    assert.ok(!normalized.includes("0.5.7"));
  });

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
    const tools = toolsByName(normalizeOpenCodeBody(raw));
    // A broken paireto_submit_plan schema must still fail replay.
    assert.deepStrictEqual(tools.get("paireto_submit_plan")?.parameters, pairetoSchema);
    assert.ok(tools.has("bash"));
    assert.strictEqual(tools.get("bash")?.parameters, undefined);
    assert.deepStrictEqual(
      toolsByName(normalizeCodexBody(raw)).get("paireto_submit_plan")?.parameters,
      pairetoSchema,
    );
  });

  // The advertised order varies between runs, so a match key that preserved it would 599
  // intermittently. The Claude path has always sorted; OpenCode must too.
  test("sorts the OpenCode tool inventory, so a reordered advertisement still matches", () => {
    const tool = (name: string): unknown => ({
      type: "function",
      name,
      description: "prose",
      parameters: { type: "object" },
    });
    const body = (names: string[]): string => JSON.stringify({ tools: names.map(tool) });

    assert.strictEqual(
      normalizeOpenCodeBody(body(["bash", "paireto_submit_plan", "write"])),
      normalizeOpenCodeBody(body(["write", "bash", "paireto_submit_plan"])),
    );
    // A tool that stops being offered must still break replay.
    assert.notStrictEqual(
      normalizeOpenCodeBody(body(["bash", "write"])),
      normalizeOpenCodeBody(body(["bash", "paireto_submit_plan", "write"])),
    );
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

    const tools = toolsByName(normalizeOpenCodeBody(body("linux")));
    assert.strictEqual(tools.get("bash")?.description, undefined, "built-in description dropped");
    assert.strictEqual(
      tools.get("paireto_submit_plan")?.description,
      "Open plan review",
      "Paireto's is kept",
    );
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

// `find` and `ls` report a directory in the order the filesystem walks it, which differs between
// machines holding an identical tree — so a cassette recorded on one host missed on another, and the
// diff named only the shuffled listing. Order is the one dimension that cannot reproduce; every path
// in the listing still has to.
suite("provider-replay: directory listing order", () => {
  const turn = (command: string, listing: string): string =>
    JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }],
        },
        {
          role: "user",
          content: [{ tool_use_id: "toolu_1", type: "tool_result", content: listing }],
        },
      ],
    });
  const FIND = "find docs src -type f 2>/dev/null | head -20";

  test("the same listing keys the same however the filesystem walked it", () => {
    assert.strictEqual(
      normalizeClaudeBody(turn(FIND, "docs/changelog.md\nsrc/ui/button.ts\nsrc/auth/login.ts")),
      normalizeClaudeBody(turn(FIND, "docs/changelog.md\nsrc/auth/login.ts\nsrc/ui/button.ts")),
    );
  });

  test("a listing that gained or lost a path still differs", () => {
    const three = normalizeClaudeBody(turn(FIND, "a.ts\nb.ts\nc.ts"));
    assert.notStrictEqual(three, normalizeClaudeBody(turn(FIND, "a.ts\nb.ts")));
    assert.notStrictEqual(three, normalizeClaudeBody(turn(FIND, "a.ts\nb.ts\nd.ts")));
  });

  test("output of any other command keeps the order it was produced in", () => {
    // Ordering carries meaning nearly everywhere else — a git log is the obvious case.
    const log = "git log --oneline -10";
    assert.notStrictEqual(
      normalizeClaudeBody(turn(log, "ed76240 second\n802f70f initial")),
      normalizeClaudeBody(turn(log, "802f70f initial\ned76240 second")),
    );
  });
});

suite("provider-replay: Codex replay turn correlation", () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-codex-transcript-"));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a rollout transcript and read the plan turn out of it. */
  function readPlanTurn(records: unknown[], turnId: string): unknown {
    const transcript = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n"));
    return readPlanTurnFrom(transcript, turnId);
  }

  const turnContext = (turnId: string, mode = "default"): unknown => ({
    type: "turn_context",
    payload: { turn_id: turnId, collaboration_mode: { mode } },
  });
  const assistantMessage = (content: string): unknown => ({
    type: "response_item",
    payload: { type: "message", role: "assistant", content },
  });

  test("does not reuse a stale Plan item for a later implementation Stop", () => {
    const stalePlan = {
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "Plan", text: "stale plan" } },
    };

    assert.deepStrictEqual(
      readPlanTurn(
        [
          stalePlan,
          turnContext("implementation-turn"),
          assistantMessage("implementation complete"),
        ],
        "implementation-turn",
      ),
      { isPlanTurn: false },
    );
  });

  test("accepts an explicit proposed-plan wrapper inside the target replay turn", () => {
    assert.deepStrictEqual(
      readPlanTurn(
        [
          turnContext("plan-turn"),
          assistantMessage("<proposed_plan>one safe step</proposed_plan>"),
        ],
        "plan-turn",
      ),
      { isPlanTurn: true, planMarkdown: "one safe step" },
    );
  });

  test("does not treat a message that merely QUOTES a plan as a new plan proposal", () => {
    assert.deepStrictEqual(
      readPlanTurn(
        [
          turnContext("implementation-turn"),
          // An implementation turn recapping the agreed plan, which belongs at a review gate.
          assistantMessage(
            "As agreed: <proposed_plan>one safe step</proposed_plan> — implementation done.",
          ),
        ],
        "implementation-turn",
      ),
      { isPlanTurn: false },
    );
  });

  // turn_context is written at turn START, so a long transcript's tail read can miss it. The
  // task_complete path is keyed on turn_id directly and must still recover the plan.
  test("recovers a proposed plan from task_complete without a preceding turn_context", () => {
    assert.deepStrictEqual(
      readPlanTurn(
        [
          {
            type: "event_msg",
            payload: {
              turn_id: "plan-turn",
              type: "task_complete",
              last_agent_message: "<proposed_plan>one safe step</proposed_plan>",
            },
          },
        ],
        "plan-turn",
      ),
      { isPlanTurn: true, planMarkdown: "one safe step" },
    );
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

  test("resolves the proxy URL and CA for every E2E run", () => {
    const proxy = resolveMockProxy({
      PAIRETO_MOCK_URL: "http://127.0.0.1:9999",
      PAIRETO_MOCK_CA: "/tmp/ca.pem",
    });
    assert.strictEqual(proxy.url, "http://127.0.0.1:9999");
    assert.strictEqual(proxy.caPath, "/tmp/ca.pem");
  });

  test("requires the proxy URL and CA together", () => {
    assert.throws(
      () => resolveMockProxy({ PAIRETO_MOCK_URL: "http://127.0.0.1:9999" }),
      /PAIRETO_MOCK_CA/,
    );
    assert.throws(() => resolveMockProxy({ PAIRETO_MOCK_CA: "/tmp/ca.pem" }), /PAIRETO_MOCK_URL/);
  });
});

suite("provider-replay: normalizing proxy plan", () => {
  test("routes every driver through the shim and normalizes only replay requests", () => {
    for (const driver of ["claudecode", "codex", "opencode"] as const) {
      assert.deepStrictEqual(normalizingProxyPlan("record", driver), {
        normalizeDriver: undefined,
        fatalMissPaths: undefined,
        fatalMissTargets: undefined,
      });
      const check = normalizingProxyPlan("check", driver);
      assert.strictEqual(check.normalizeDriver, driver);
      assert.ok(check.fatalMissPaths?.length);
    }
    const kiro = normalizingProxyPlan("check", "kiro");
    assert.ok(
      kiro.fatalMissTargets?.some((target) =>
        target.test("KiroRuntimeService.GenerateAssistantResponse"),
      ),
    );
  });
});

suite("provider-replay: SSE response detection", () => {
  test("accepts parameters, case differences, and array header values", () => {
    assert.strictEqual(isEventStreamContentType("text/event-stream; charset=utf-8"), true);
    assert.strictEqual(isEventStreamContentType("Text/Event-Stream"), true);
    assert.strictEqual(
      isEventStreamContentType(["application/json", "text/event-stream; charset=utf-8"]),
      true,
    );
    assert.strictEqual(isEventStreamContentType("application/json"), false);
  });
});

suite("provider-replay: native MockServer launch", () => {
  test("redacts secrets from native container logs and recorded expectations", () => {
    const args = nativeMockServerDockerArgs(1080, "paireto-test");
    assert.ok(args.includes("MOCKSERVER_REDACT_SECRETS_IN_LOG=true"));
    assert.ok(args.includes("MOCKSERVER_REDACT_SECRETS_IN_RECORDED_EXPECTATIONS=true"));
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

// Kiro states the wall-clock date in its own system prompt, so a cassette recorded on one day would
// otherwise stop matching the next.
suite("provider-replay: Kiro wall-clock date", () => {
  const prompt = (date: string, day: string): string =>
    JSON.stringify({
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: `<current_date_and_time>\nDate: ${date}\nDay of Week: ${day}\n\nUse this carefully.`,
          },
        },
      },
    });

  test("a cassette still matches on a later day", () => {
    assert.strictEqual(
      normalizeKiroBody(prompt("August 15, 2026", "Saturday")),
      normalizeKiroBody(prompt("August 16, 2026", "Sunday")),
    );
  });

  test("the surrounding prompt is left intact", () => {
    assert.ok(
      normalizeKiroBody(prompt("August 15, 2026", "Saturday")).includes("Use this carefully"),
    );
  });
});

// Kiro stamps its own build into every request, so pinning it would expire each cassette on the
// harness's next release — and the Dockerfile installs the CLI unpinned.
suite("provider-replay: Kiro CLI version", () => {
  const body = (version: string): string =>
    JSON.stringify({
      origin: "KIRO_CLI",
      version,
      conversationState: { currentMessage: { userInputMessage: { content: "hello" } } },
    });

  test("a cassette survives a CLI upgrade", () => {
    assert.strictEqual(normalizeKiroBody(body("2.18.0")), normalizeKiroBody(body("2.18.1")));
  });

  test("a version that is not Kiro's own is left alone", () => {
    const other = JSON.stringify({ origin: "SOMETHING_ELSE", version: "2.18.0" });
    assert.ok(normalizeKiroBody(other).includes("2.18.0"));
  });
});
