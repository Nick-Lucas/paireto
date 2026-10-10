import { runMcpServer } from "../core/mcp/runtime.js";
import { createAgentPluginMcpAdapter, detectAgentPluginHarness } from "./mcpAdapter.js";

const harness = detectAgentPluginHarness();
if (!harness) {
  process.stderr.write("Crafty could not identify the Agent Plugins client process.\n");
  process.exitCode = 1;
} else {
  void runMcpServer(createAgentPluginMcpAdapter(harness));
}
