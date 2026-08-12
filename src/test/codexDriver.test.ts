import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  codexLaunchCommand,
  completeNativePlanApproval,
  interruptedMcpReason,
  renderCodexRuntimeConfig,
  typeCodexPrompt,
  waitForCodexReady,
} from "../e2e/drivers/codex.js";
import { readFixture } from "../e2e/mockserver/MockServerController.js";

/** The composer footer Codex only draws once its TUI is interactive. */
const READY_FRAME = "  gpt-5.6-luna low · /private/tmp/paireto-e2e-codex";
const FAST = { readyPollMs: 0, acceptPollMs: 0, submitGapMs: 0, readyTimeoutMs: 50 };

suite("Codex E2E launch permissions", () => {
  test("bypasses approvals and the inner sandbox only inside Docker", () => {
    const command = codexLaunchCommand("/tmp/repo", true);

    assert.match(command, /--dangerously-bypass-hook-trust/);
    assert.match(command, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(command, /--cd "\/tmp\/repo"/);
  });

  test("keeps the Docker-only CLI bypass out of native host runs", () => {
    const command = codexLaunchCommand("/tmp/repo", false);

    assert.match(command, /--dangerously-bypass-hook-trust/);
    assert.doesNotMatch(command, /--dangerously-bypass-approvals-and-sandbox/);
  });
});

suite("Codex E2E runtime config", () => {
  test("pins Luna and disables WebSockets before installer-owned TOML tables", () => {
    const existing = `[plugins]\nenabled = true\n`;
    const config = renderCodexRuntimeConfig(existing, "/tmp/repo");

    assert.ok(config.indexOf('model = "gpt-5.6-luna"') < config.indexOf("[plugins]"));
    assert.ok(config.indexOf('model_provider = "paireto_openai"') < config.indexOf("[plugins]"));
    assert.match(config, /supports_websockets = false/);
    assert.match(config, /\[projects\."\/tmp\/repo"\]\ntrust_level = "trusted"/);
  });

  test("record and check use the replayable provider and bypass the inner permission boundary", () => {
    const config = renderCodexRuntimeConfig("", "/tmp/repo");
    assert.match(config, /approval_policy = "never"/);
    assert.match(config, /sandbox_mode = "danger-full-access"/);
    assert.match(config, /model_provider = "paireto_openai"/);
    assert.match(config, /supports_websockets = false/);
    assert.match(config, /enable_request_compression = false/);
  });

  test("every root setting precedes the first TOML table", () => {
    const config = renderCodexRuntimeConfig("", "/tmp/repo");
    const firstTable = config.indexOf("[");
    const rootLines = config
      .slice(0, firstTable)
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.ok(rootLines.length > 0);
    assert.ok(rootLines.every((line) => line.includes(" = ")));
  });

  test("committed recording contains only successful Luna inference traffic", () => {
    const fixture = readFixture(
      JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, "../../src/e2e/fixtures/fullflow.codex.json"),
          "utf8",
        ),
      ),
      "codex",
    ).expectations as Array<{
      httpRequest?: { method?: string; path?: string; body?: string };
      httpResponse?: { statusCode?: number };
    }>;
    const inference = fixture.filter(
      ({ httpRequest }) =>
        httpRequest?.method === "POST" && httpRequest.path === "/backend-api/codex/responses",
    );
    const models = new Set(
      inference
        .map(({ httpRequest }) => JSON.parse(httpRequest?.body ?? "{}") as { model?: string })
        .map(({ model }) => model),
    );

    assert.ok(inference.length > 0);
    assert.deepStrictEqual([...models], ["gpt-5.6-luna"]);
    assert.ok(fixture.every(({ httpResponse }) => (httpResponse?.statusCode ?? 500) < 400));
  });
});

// Codex draws its TUI before its MCP servers have finished starting, and a keystroke in that window
// both abandons the startup and is swallowed: the session then has none of Paireto's tools and an
// empty composer, which used to surface only as a 5-minute wait for a gate that could never open.
suite("Codex E2E startup readiness", () => {
  test("holds keystrokes until the composer has settled", async () => {
    const frames = ["", "booting", READY_FRAME, READY_FRAME, READY_FRAME, READY_FRAME];
    let seen = 0;
    await waitForCodexReady(
      {
        capture: () => frames[Math.min(seen++, frames.length - 1)],
        exitStatus: () => undefined,
      },
      () => undefined,
      { ...FAST, readyStableFrames: 2, readyTimeoutMs: 5_000 },
    );
    // Ready only once the composer frame has repeated: 3 boot frames + the run of identical ones.
    assert.strictEqual(seen, 5, "returned before the boot redraws stopped");
  });

  test("a TUI that died during startup fails at the cause", async () => {
    await assert.rejects(
      waitForCodexReady({ capture: () => "boom", exitStatus: () => 1 }, () => undefined, FAST),
      /exited during startup \(status 1\)/,
    );
  });

  test("an abandoned MCP startup is a failure reason, naming the server", () => {
    const reason = interruptedMcpReason(
      "⚠ MCP startup interrupted. The following servers were not initialized: paireto",
    );
    assert.match(reason ?? "", /paireto/);
    assert.match(reason ?? "", /no gate can open/);
    assert.strictEqual(interruptedMcpReason(READY_FRAME), undefined);
  });
});

suite("Codex E2E prompt submission", () => {
  const PROMPT = "$paireto-guided-review Group the uncommitted changes for review.";

  test("submits only once the composer is holding the text", async () => {
    const typed: string[] = [];
    const keys: string[] = [];
    let composer = "";
    await typeCodexPrompt(
      {
        capture: () => composer,
        sendKeys: (...sent: string[]) => keys.push(...sent),
        typeLine: (text: string) => {
          typed.push(text);
          composer = text;
          return Promise.resolve();
        },
      },
      PROMPT,
      () => undefined,
      FAST,
    );
    assert.deepStrictEqual(typed, [PROMPT]);
    assert.deepStrictEqual(keys, ["Enter"], "Enter is a separate, later event");
  });

  test("retypes a prompt the composer swallowed", async () => {
    const typed: string[] = [];
    let composer = "";
    await typeCodexPrompt(
      {
        capture: () => composer,
        sendKeys: () => undefined,
        // The first attempt is swallowed, as it is when it lands during MCP startup.
        typeLine: (text: string) => {
          if (typed.push(text) === 2) {
            composer = text;
          }
          return Promise.resolve();
        },
      },
      PROMPT,
      () => undefined,
      { ...FAST, acceptTimeoutMs: 0 },
    );
    assert.deepStrictEqual(typed, [PROMPT, PROMPT]);
  });

  test("a composer that never accepts the prompt fails rather than pressing Enter", async () => {
    const keys: string[] = [];
    await assert.rejects(
      typeCodexPrompt(
        {
          capture: () => "",
          sendKeys: (...sent: string[]) => keys.push(...sent),
          typeLine: () => Promise.resolve(),
        },
        PROMPT,
        () => undefined,
        { ...FAST, acceptTimeoutMs: 0 },
      ),
      /never accepted the prompt/,
    );
    assert.deepStrictEqual(keys, [], "a swallowed prompt must not be submitted blind");
  });
});

suite("Codex native plan transition", () => {
  test("selects the native approve-and-switch option after Paireto approval", async () => {
    const keys: string[] = [];

    await completeNativePlanApproval(
      {
        capture: () => "Implement this plan?",
        sendKeys: (...sent: string[]) => keys.push(...sent),
      },
      10,
      0,
    );

    assert.deepStrictEqual(keys, ["Enter"]);
  });

  test("fails if Codex never presents the native selector", async () => {
    await assert.rejects(
      completeNativePlanApproval(
        { capture: () => "still in plan mode", sendKeys: () => undefined },
        0,
        0,
      ),
      /Implement this plan/i,
    );
  });
});
