import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const bundle = path.resolve(__dirname, "../../dist/plugins/agent-plugin");

suite("built Agent Plugin MCP stdio server", () => {
  test("initializes, lists tools, calls a tool, and shuts down with a sanitized environment", async () => {
    const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-plugin-data-"));
    const server = path.join(bundle, "runtime", "mcp.js");
    const wrapper = [
      'const { spawn } = require("node:child_process");',
      'process.title = "kiro-cli";',
      'const child = spawn("node", [process.argv[1]], { env: process.env, stdio: "inherit" });',
      'child.once("exit", code => process.exit(code ?? 1));',
    ].join("");
    const transport = new StdioClientTransport({
      command: "node",
      args: ["-e", wrapper, server],
      env: {
        PATH: process.env.PATH ?? "",
        PLUGIN_ROOT: bundle,
        PLUGIN_DATA: pluginData,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "agent-plugin-conformance-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      assert.deepStrictEqual(tools.tools.map((tool) => tool.name).sort(), [
        "paireto_review",
        "paireto_start_guided_review",
      ]);
      const result = await client.request(
        { method: "tools/call", params: { name: "paireto_review" } },
        CallToolResultSchema,
      );
      assert.strictEqual(result.isError, true);
      assert.match(
        (result.content[0] as { text: string }).text,
        /could not find a VS Code window/i,
      );
    } finally {
      await client.close();
      fs.rmSync(pluginData, { recursive: true, force: true });
    }
  });
});
