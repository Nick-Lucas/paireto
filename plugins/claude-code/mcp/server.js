#!/usr/bin/env node
"use strict";

// Minimal zero-dependency MCP stdio server bundled with the tui-companion plugin.
//
// Exposes one tool, `tui_review`: it opens a blocking code-review session in the connected VS Code
// window (over the same per-repo Unix socket the hooks use) and BLOCKS until the user clicks Send
// Feedback or Cancel, then returns the gathered review comments as the tool result. This is what
// lets `/tui-review` hand control to VS Code and resume the agent with real feedback.
//
// MCP stdio transport = newline-delimited JSON-RPC 2.0 (no embedded newlines in a message).

const crypto = require("node:crypto");
const bridge = require("../scripts/bridge.js");

const SERVER_INFO = { name: "tui-companion", version: "0.2.0" };
const CONNECT_TIMEOUT_MS = 3000;

const TOOL = {
  name: "tui_review",
  description:
    "Open an interactive code review in the connected VS Code window and wait for the user to " +
    "submit feedback. Blocks until the user clicks Send Feedback or Cancel, then returns the " +
    "review comments (file:line, kind, note) to act on. Call this when the user asks for a review.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, isError) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

// ---------------------------------------------------------------------------
// The blocking review round-trip over the bridge socket
// ---------------------------------------------------------------------------

async function runReview() {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const target = bridge.resolveTarget(cwd);
  if (!target) {
    return textResult(
      "No VS Code TUI Companion is listening for this repository. Open the project in VS Code " +
        "(with the TUI Companion extension active) and try again.",
      true
    );
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    return textResult("Could not connect to the VS Code TUI Companion bridge.", true);
  }

  const id = crypto.randomUUID();
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        conn.sock.destroy();
        resolve(value);
      }
    };
    conn.sock.on("close", () => finish(textResult("Review session closed.", false)));
    bridge.readMessages(conn.sock, conn.residual, (msg) => {
      if (msg && msg.t === "review.await.response" && msg.id === id) {
        if (msg.status === "submitted" && msg.feedback) {
          finish(textResult(msg.feedback, false));
        } else {
          finish(textResult("Review approved — proceeding with no changes.", false));
        }
      }
    });
    bridge.sendLine(conn.sock, {
      t: "review.await.request",
      v: bridge.PROTOCOL_VERSION,
      id,
      ts: bridge.nowIso(),
      cwd,
      repoRoot: target.repoRoot,
      // Best-effort agent attribution: Claude Code may expose the session id to MCP servers via env.
      // If absent the extension falls back to the most-recently-active session in this repo.
      sessionId: process.env.CLAUDE_SESSION_ID || undefined,
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
      return; // notification, no reply
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: [TOOL] });
      return;
    case "tools/call": {
      if (!params || params.name !== TOOL.name) {
        replyError(id, -32602, `Unknown tool: ${params && params.name}`);
        return;
      }
      try {
        reply(id, await runReview());
      } catch (err) {
        reply(id, textResult(`Review failed: ${(err && err.message) || err}`, true));
      }
      return;
    }
    default:
      if (id !== undefined) {
        replyError(id, -32601, `Method not found: ${method}`);
      }
  }
}

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === "") {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void handle(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main();
