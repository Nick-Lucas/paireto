import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as assert from "node:assert";
import type * as net from "node:net";

import { NO_WINDOW_MESSAGE } from "../plugins/core/mcp/reviewTool.js";
import { createMcpServer } from "../plugins/core/mcp/runtime.js";
import {
  runMutationTool,
  VIZ_GENERATE_TOOL,
  VIZ_PRESENT_TOOL,
} from "../plugins/core/mcp/mutationTools.js";
import { PLUGIN_VERSION } from "../protocol/types.js";
import { ackWith, type FakeServer, startServer } from "./fakeBridgeServer.js";

function answering(ok: boolean, message: string) {
  const ack = ackWith(true);
  return (line: string, sock: net.Socket) => {
    ack(line, sock);
    const msg = JSON.parse(line) as { t: string; id?: string };
    const responseTag = {
      "viz.generate.request": "viz.generate.response",
      "viz.present.request": "viz.present.response",
    }[msg.t];
    if (responseTag) {
      sock.write(
        JSON.stringify({
          t: responseTag,
          v: PLUGIN_VERSION,
          ts: new Date().toISOString(),
          id: msg.id,
          ok,
          message,
        }) + "\n",
      );
    }
  };
}

function sent(server: FakeServer, tag: string): Record<string, unknown> | undefined {
  return server.received
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((msg) => msg.t === tag);
}

suite("MCP viz tools", () => {
  test("the tool names are fixed and each names the next step", () => {
    assert.strictEqual(VIZ_GENERATE_TOOL.name, "paireto_viz_generate");
    assert.strictEqual(VIZ_PRESENT_TOOL.name, "paireto_viz_present");
    assert.match(VIZ_GENERATE_TOOL.description, /call paireto_viz_present\.$/);
    assert.match(VIZ_PRESENT_TOOL.description, /JSON path/);
  });

  test("every harness server lists both tools with their argument schemas", async () => {
    const server = createMcpServer({
      serverName: "paireto-test",
      harness: "claudecode",
      resolveReviewTarget: () => undefined,
      startLiveness: () => () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
      assert.deepStrictEqual(tools.get(VIZ_GENERATE_TOOL.name)?.inputSchema.required, [
        "name",
        "base",
      ]);
      assert.deepStrictEqual(tools.get(VIZ_PRESENT_TOOL.name)?.inputSchema.required, ["name"]);
      const result = await client.request(
        {
          method: "tools/call",
          params: { name: VIZ_PRESENT_TOOL.name, arguments: { name: "checkout" } },
        },
        CallToolResultSchema,
      );
      assert.strictEqual(result.isError, true);
      assert.strictEqual((result.content[0] as { text: string }).text, NO_WINDOW_MESSAGE);
    } finally {
      await client.close();
    }
  });

  test("an accepted viz passes the window's text through as a success", async () => {
    const server = await startServer(answering(true, 'Viz "X" is open in VS Code: 1 node.'));
    try {
      const result = await runMutationTool(
        VIZ_PRESENT_TOOL,
        { target: server.target, cwd: "/work/shop/web", sessionId: "s1" },
        "codex",
        { name: "checkout" },
      );
      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: 'Viz "X" is open in VS Code: 1 node.' }],
      });
      const request = sent(server, "viz.present.request");
      assert.deepStrictEqual(
        [request?.repoRoot, request?.cwd, request?.harness, request?.sessionId, request?.args],
        [server.target.repoRoot, "/work/shop/web", "codex", "s1", { name: "checkout" }],
      );
    } finally {
      await server.dispose();
    }
  });

  test("a rejected viz passes the window's text through as an error", async () => {
    const server = await startServer(answering(false, "Viz rejected. Fix all 1."));
    try {
      const result = await runMutationTool(
        VIZ_PRESENT_TOOL,
        { target: server.target, cwd: "/w" },
        "kiro",
        {},
      );
      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: "Viz rejected. Fix all 1." }],
        isError: true,
      });
    } finally {
      await server.dispose();
    }
  });

  test("the generate result passes through with the agent's cwd", async () => {
    const server = await startServer(answering(true, "Wrote /w/.paireto/viz/x.viz.json"));
    try {
      const args = { name: "x", base: "changes" };
      const result = await runMutationTool(
        VIZ_GENERATE_TOOL,
        { target: server.target, cwd: "/w/api" },
        "claudecode",
        args,
      );
      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: "Wrote /w/.paireto/viz/x.viz.json" }],
      });
      const request = sent(server, "viz.generate.request");
      assert.deepStrictEqual(
        [request?.harness, request?.cwd, request?.args],
        ["claudecode", "/w/api", args],
      );
    } finally {
      await server.dispose();
    }
  });

  test("a window that never answers reports an error rather than hanging", async () => {
    const server = await startServer(ackWith(true));
    try {
      const result = await runMutationTool(
        VIZ_PRESENT_TOOL,
        { target: server.target, cwd: "/w" },
        "codex",
        {},
        undefined,
        150,
      );
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /did not complete/);
    } finally {
      await server.dispose();
    }
  });

  test("with no window the tools report it", async () => {
    const result = await runMutationTool(
      VIZ_GENERATE_TOOL,
      undefined,
      "pi",
      {},
      "No Paireto window for this session.",
    );
    assert.deepStrictEqual(result, {
      content: [{ type: "text", text: "No Paireto window for this session." }],
      isError: true,
    });
  });
});
