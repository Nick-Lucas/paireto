import * as assert from "node:assert";

import {
  createAgentPluginMcpAdapter,
  detectAgentPluginHarness,
  type ParentProcess,
} from "../plugins/agent-plugin/mcpAdapter.js";

function processTree(records: Record<number, ParentProcess>) {
  return (pid: number): ParentProcess | undefined => records[pid];
}

suite("shared Agent Plugin MCP adapter", () => {
  test("detects Codex through wrapper processes", () => {
    assert.strictEqual(
      detectAgentPluginHarness(
        30,
        processTree({
          30: { parentPid: 20, command: "node" },
          20: { parentPid: 10, command: "/usr/local/bin/codex" },
        }),
      ),
      "codex",
    );
  });

  test("detects Kiro CLI through wrapper processes", () => {
    assert.strictEqual(
      detectAgentPluginHarness(
        30,
        processTree({
          30: { parentPid: 20, command: "node" },
          20: { parentPid: 10, command: "/opt/kiro/kiro-cli-chat" },
        }),
      ),
      "kiro",
    );
  });

  test("does not assign an unknown Agent Plugins client to a supported harness", () => {
    assert.strictEqual(
      detectAgentPluginHarness(30, processTree({ 30: { parentPid: 1, command: "another-agent" } })),
      undefined,
    );
  });

  test("uses one server identity with harness-specific session adapters", () => {
    const codex = createAgentPluginMcpAdapter("codex");
    const kiro = createAgentPluginMcpAdapter("kiro");
    assert.strictEqual(codex.serverName, "paireto-agent-plugin");
    assert.strictEqual(kiro.serverName, "paireto-agent-plugin");
    assert.strictEqual(codex.harness, "codex");
    assert.strictEqual(kiro.harness, "kiro");
  });
});
