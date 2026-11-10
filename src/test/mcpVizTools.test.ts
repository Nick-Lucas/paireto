import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as assert from "node:assert";
import type * as net from "node:net";

import { NO_WINDOW_MESSAGE } from "../plugins/core/mcp/reviewTool.js";
import { createMcpServer } from "../plugins/core/mcp/runtime.js";
import {
  GET_CHANGES_TOOL_DESCRIPTION,
  GET_CHANGES_TOOL_NAME,
  runGetChanges,
  runShowViz,
  SHOW_VIZ_TOOL_DESCRIPTION,
  SHOW_VIZ_TOOL_NAME,
} from "../plugins/core/mcp/vizTools.js";
import { PLUGIN_VERSION } from "../protocol/types.js";
import { ackWith, type FakeServer, startServer } from "./fakeBridgeServer.js";

function answering(ok: boolean, message: string) {
  const ack = ackWith(true);
  return (line: string, sock: net.Socket) => {
    ack(line, sock);
    const msg = JSON.parse(line) as { t: string; id?: string };
    const responseTag = {
      "viz.show.request": "viz.show.response",
      "changes.describe.request": "changes.describe.response",
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
  test("the tool names and descriptions are fixed text", () => {
    assert.strictEqual(GET_CHANGES_TOOL_NAME, "paireto_get_changes");
    assert.strictEqual(SHOW_VIZ_TOOL_NAME, "paireto_show_viz");
    assert.strictEqual(
      GET_CHANGES_TOOL_DESCRIPTION,
      "List what the connected VS Code window compares: its Compare To, each repo, the changed " +
        "files grouped by unit, and a level hint. Call this before paireto_show_viz.",
    );
    assert.strictEqual(
      SHOW_VIZ_TOOL_DESCRIPTION,
      "Show how the changes fit together in the connected VS Code window: an overview graph, flows " +
        "as sequence diagrams, and a walkthrough. Returns at once: accepted with warnings, or every " +
        "error to fix before you call it again.",
    );
  });

  test("every harness server lists both tools, and get_changes takes no arguments", async () => {
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
      assert.deepStrictEqual(tools.get(GET_CHANGES_TOOL_NAME)?.inputSchema, {
        type: "object",
        properties: {},
      });
      assert.deepStrictEqual(tools.get(SHOW_VIZ_TOOL_NAME)?.inputSchema.required, [
        "title",
        "summary",
        "level",
        "lanes",
        "nodes",
      ]);
      const result = await client.request(
        { method: "tools/call", params: { name: GET_CHANGES_TOOL_NAME } },
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
      const viz = { title: "X", anything: [1, 2] };
      const result = await runShowViz(
        { target: server.target, cwd: "/work/shop/web", sessionId: "s1" },
        "codex",
        viz,
      );
      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: 'Viz "X" is open in VS Code: 1 node.' }],
      });
      const request = sent(server, "viz.show.request");
      assert.deepStrictEqual(
        [request?.repoRoot, request?.cwd, request?.harness, request?.sessionId, request?.viz],
        [server.target.repoRoot, "/work/shop/web", "codex", "s1", viz],
      );
    } finally {
      await server.dispose();
    }
  });

  test("a rejected viz passes the window's text through as an error", async () => {
    const server = await startServer(answering(false, "Viz rejected. Fix all 1."));
    try {
      const result = await runShowViz({ target: server.target, cwd: "/w" }, "kiro", {});
      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: "Viz rejected. Fix all 1." }],
        isError: true,
      });
    } finally {
      await server.dispose();
    }
  });

  test("the changes description passes through", async () => {
    const server = await startServer(answering(true, "Repo shop (this repo)."));
    try {
      const result = await runGetChanges({ target: server.target, cwd: "/w" }, "claudecode");
      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: "Repo shop (this repo)." }],
      });
      assert.strictEqual(sent(server, "changes.describe.request")?.harness, "claudecode");
    } finally {
      await server.dispose();
    }
  });

  test("a window that never answers reports an error rather than hanging", async () => {
    const server = await startServer(ackWith(true));
    try {
      const result = await runShowViz(
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
    const result = await runGetChanges(undefined, "pi", "No Paireto window for this session.");
    assert.deepStrictEqual(result, {
      content: [{ type: "text", text: "No Paireto window for this session." }],
      isError: true,
    });
  });
});
