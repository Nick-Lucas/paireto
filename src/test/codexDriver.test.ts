import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  codexLaunchCommand,
  completeNativePlanApproval,
  renderCodexRuntimeConfig,
} from "../e2e/drivers/codex.js";
import { readFixture } from "../e2e/mockserver/MockServerController.js";

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
