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

import { GUIDED_REVIEW_TOOL_NAME } from "../plugins/core/mcp/guidedReviewTool.js";
import { PLAN_REVIEW_TOOL_NAME } from "../plugins/core/mcp/planReviewTool.js";
import {
  REVIEW_TOOL_DESCRIPTION,
  REVIEW_TOOL_NAME,
  runReview,
  textResult,
} from "../plugins/core/mcp/reviewTool.js";
import { createMcpServer } from "../plugins/core/mcp/runtime.js";
import { type Harness, PLUGIN_VERSION } from "../protocol/types.js";
import {
  FEEDBACK_REPLY_TOOL_NAME,
  FEEDBACK_RESOLVE_TOOL_NAME,
  runFeedbackReply,
} from "../plugins/core/mcp/feedbackTools.js";
import { ackWith, startServer } from "./fakeBridgeServer.js";

suite("MCP paireto_review tool", () => {
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
    const result = await runReview(undefined, "kiro");
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No VS Code Paireto is listening/);
  });

  test("a socket that is not there reports no window rather than a connection failure", async () => {
    const result = await runReview(
      {
        target: { socketPath: "/nonexistent/nope.sock", repoRoot: "/tmp" },
        cwd: "/tmp",
      },
      "kiro",
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No VS Code Paireto is listening/);
  });

  // The window is right there and answering — it just refuses this build. Reporting that as a
  // connection failure sends the reader looking at sockets instead of at the plugin version.
  test("a refused handshake names both versions and how to recover", async () => {
    const server = await startServer(ackWith(false, "9.9.9"));
    try {
      const result = await runReview(
        { target: server.target, cwd: server.target.repoRoot },
        "kiro",
      );

      assert.strictEqual(result.isError, true);
      const text = result.content[0].text;
      assert.match(text, /9\.9\.9/, `expected the window's version in: ${text}`);
      assert.ok(text.includes(PLUGIN_VERSION), `expected the plugin's version in: ${text}`);
      assert.match(text, /Update the Paireto plugin/, `expected the way out in: ${text}`);
      assert.doesNotMatch(text, /Could not connect/, "a refusal is not a transport failure");
    } finally {
      await server.dispose();
    }
  });

  test("a path that exists but is not a listening socket reports a connection failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-review-"));
    const notASocket = path.join(dir, "not.sock");
    fs.writeFileSync(notASocket, "");
    try {
      const result = await runReview(
        {
          target: { socketPath: notASocket, repoRoot: dir },
          cwd: dir,
        },
        "kiro",
      );
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /Could not connect/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `paireto_plan_review` exists for the one harness that cannot raise a second plan gate from a hook.
// Advertising it anywhere else gives the model a way to "approve" a plan without the harness-native
// mode transition an approval has to carry, so the inventory is checked per harness.
suite("MCP paireto_plan_review tool exposure", () => {
  const toolNames = async (harness: Harness): Promise<string[]> => {
    const server = createMcpServer({
      serverName: "paireto-test",
      harness,
      resolveReviewTarget: () => undefined,
      startLiveness: () => () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      return tools.tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
    }
  };

  /** Every harness can answer feedback, so these ride alongside whatever else it is given. */
  const FEEDBACK_TOOLS = [FEEDBACK_REPLY_TOOL_NAME, FEEDBACK_RESOLVE_TOOL_NAME];

  test("Kiro gets the plan-review tool", async () => {
    assert.deepStrictEqual(
      await toolNames("kiro"),
      [PLAN_REVIEW_TOOL_NAME, REVIEW_TOOL_NAME, GUIDED_REVIEW_TOOL_NAME, ...FEEDBACK_TOOLS].sort(),
    );
  });

  for (const harness of ["claudecode", "codex", "opencode"] as const) {
    test(`${harness} does not get the plan-review tool`, async () => {
      assert.deepStrictEqual(
        await toolNames(harness),
        [REVIEW_TOOL_NAME, GUIDED_REVIEW_TOOL_NAME, ...FEEDBACK_TOOLS].sort(),
      );
    });
  }
});
