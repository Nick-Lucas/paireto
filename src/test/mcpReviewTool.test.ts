// The `paireto_review` tool is agent-facing contract: the model decides whether to call it from the
// name and description alone, and the e2e replay fixtures match on that text. Pin both so a reword
// is a deliberate change with a fixture re-record, not an accident.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  REVIEW_TOOL_DESCRIPTION,
  REVIEW_TOOL_NAME,
  runReview,
  textResult,
} from "../plugins/core/mcp/reviewTool.js";
import { createMcpServer } from "../plugins/core/mcp/runtime.js";
import {
  FEEDBACK_REPLY_TOOL_NAME,
  FEEDBACK_RESOLVE_TOOL_NAME,
  runFeedbackReply,
} from "../plugins/core/mcp/feedbackTools.js";
import { ackWith, startServer } from "./fakeBridgeServer.js";

suite("MCP paireto_review tool", () => {
  test("registers independent reply and resolve tools with strict schemas", async () => {
    const server = createMcpServer({
      serverName: "paireto-test",
      harness: "codex" as const,
      resolveReviewTarget: () => undefined,
      startLiveness: () => () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
      assert.deepStrictEqual(tools.get(FEEDBACK_REPLY_TOOL_NAME)?.inputSchema.required, [
        "feedbackId",
        "message",
      ]);
      assert.deepStrictEqual(tools.get(FEEDBACK_RESOLVE_TOOL_NAME)?.inputSchema.required, [
        "feedbackId",
      ]);
    } finally {
      await client.close();
    }
  });

  test("the tool name is the one the skills and commands invoke", () => {
    assert.strictEqual(REVIEW_TOOL_NAME, "paireto_review");
  });

  test("the description says feedback includes stable IDs", () => {
    assert.strictEqual(
      REVIEW_TOOL_DESCRIPTION,
      "Open an interactive code review in the connected VS Code window and wait for the user to " +
        "submit feedback. Blocks until the user clicks Send Feedback or Approve, then returns " +
        "review comments with stable feedback IDs. Call this when the user asks for a review.",
    );
  });

  // A zero-argument tool may be called with no `arguments` field at all. Declaring an input schema
  // for it makes the SDK validate that missing field and reject the call before the tool ever runs.
  test("a call that omits arguments reaches the tool", async () => {
    const server = createMcpServer({
      serverName: "paireto-test",
      harness: "claudecode" as const,
      resolveReviewTarget: () => undefined,
      startLiveness: () => () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      assert.deepStrictEqual(tools.tools[0].inputSchema, { type: "object", properties: {} });

      const result = await client.request(
        { method: "tools/call", params: { name: REVIEW_TOOL_NAME } },
        CallToolResultSchema,
      );
      assert.match((result.content[0] as { text: string }).text, /No VS Code Paireto is listening/);
    } finally {
      await client.close();
    }
  });

  test("textResult marks errors and leaves successes unmarked", () => {
    assert.deepStrictEqual(textResult("hello"), {
      content: [{ type: "text", text: "hello" }],
    });
    assert.deepStrictEqual(textResult("nope", true), {
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
  });

  test("with no window listening the tool reports an error rather than hanging", async () => {
    const result = await runReview(undefined);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No VS Code Paireto is listening/);
  });

  test("a socket that is not there reports no window rather than a connection failure", async () => {
    const result = await runReview({
      target: { socketPath: "/nonexistent/nope.sock", repoRoot: "/tmp" },
      cwd: "/tmp",
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No VS Code Paireto is listening/);
  });

  test("a feedback mutation the extension never answers reports an error rather than hanging", async () => {
    // The extension logs and sends nothing when a handler throws, so only a deadline on the request
    // settles the tool call. Without one the agent waits until the socket drops.
    const server = await startServer(ackWith(true));
    try {
      const result = await runFeedbackReply(
        { target: server.target, cwd: server.target.repoRoot },
        "codex",
        { feedbackId: "feedback-1", message: "I changed it." },
        undefined,
        150,
      );
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /did not complete/);
    } finally {
      await server.dispose();
    }
  });

  test("a path that exists but is not a listening socket reports a connection failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-review-"));
    const notASocket = path.join(dir, "not.sock");
    fs.writeFileSync(notASocket, "");
    try {
      const result = await runReview({
        target: { socketPath: notASocket, repoRoot: dir },
        cwd: dir,
      });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /Could not connect/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
