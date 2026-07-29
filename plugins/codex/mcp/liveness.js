#!/usr/bin/env node
"use strict";

// Codex bridge MCP stdio server bundled with the Paireto Codex plugin.
//
// Codex gives MCP servers NO session identity in env (the env is stripped to a fixed allowlist), so
// this server learns the active session_id from a PPID-keyed handoff file the SessionStart/
// UserPromptSubmit hooks write (the hooks and this server share the same codex process as their
// DIRECT parent — empirically pinned, codex-cli 0.144.1). It holds ONE bridge socket open per
// attached session; when codex dies this process ends and the socket close is the extension's signal
// to clear the agent row:
//   - SIGKILL of codex -> we are orphaned but stdin closes (EOF ~34 ms) -> exit on stdin 'end';
//   - graceful codex exit -> codex actively SIGTERMs us -> exit on SIGTERM.
// On a `/new` the handoff's session_id changes -> detach the old socket, attach the new. Fail-open
// everywhere (no socket / no handoff -> serve MCP quietly, with liveness unavailable).
//
// Also exposes `paireto_review`. MCP servers run outside Codex's command sandbox, so this process can
// use the same Unix socket as the hooks. A skill helper launched as a shell command cannot: Codex
// rejects its connection to ~/.local/state with EPERM even though socket discovery succeeds.
//
// MCP stdio transport = newline-delimited JSON-RPC 2.0 (no embedded newlines in a message).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const bridge = require("../scripts/bridge.js");

const SERVER_INFO = { name: "paireto-codex", version: bridge.PLUGIN_VERSION };
const CONNECT_TIMEOUT_MS = 3000;
const HANDOFF_POLL_MS = 500; // fs.watch is flaky on macOS rename; poll as the reliable backstop

const REVIEW_TOOL = {
  name: "paireto_review",
  description:
    "Open an interactive code review in the connected VS Code window and wait for the user to " +
    "submit feedback. Blocks until the user clicks Send Feedback or Cancel, then returns the " +
    "review comments (file:line, kind, note) to act on. Call this when the user asks for a review.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

// ---------------------------------------------------------------------------
// Minimal MCP JSON-RPC over stdio
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

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

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
      reply(id, { tools: [REVIEW_TOOL] });
      return;
    case "tools/call": {
      if (!params || params.name !== REVIEW_TOOL.name) {
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

// ---------------------------------------------------------------------------
// Attach lifecycle — hold one bridge socket open for the active session
// ---------------------------------------------------------------------------

let currentSessionId = null;
let currentSock = null;
let connecting = false;
let handoffPid = null;
let latestHandoff = null;
let handoffWatcher = null;

function detach() {
  if (currentSock) {
    try {
      currentSock.destroy();
    } catch {
      /* already gone */
    }
    currentSock = null;
  }
}

function attach(sessionId, repoRoot, socketPath) {
  if (!fs.existsSync(socketPath)) {
    return; // no listening window yet — a later poll tick retries
  }
  connecting = true;
  const key = bridge.repoKey(repoRoot);
  bridge
    .connectAndHandshake(socketPath, key, CONNECT_TIMEOUT_MS)
    .then((conn) => {
      connecting = false;
      // The active session may have changed while we were connecting — drop a now-stale connection.
      if (sessionId !== currentSessionId) {
        try {
          conn.sock.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      currentSock = conn.sock;
      conn.sock.on("error", () => {});
      conn.sock.on("close", () => {
        if (currentSock === conn.sock) {
          currentSock = null; // window went away — a later tick re-attaches if it returns
        }
      });
      bridge.sendLine(conn.sock, {
        t: "session.attach",
        v: bridge.PLUGIN_VERSION,
        ts: bridge.nowIso(),
        sessionId,
        repoRoot,
      });
      // Hold open for the session lifetime — its close is the death signal.
    })
    .catch(() => {
      connecting = false; // no window listening — liveness unavailable, poll retries
    });
}

/** Reconcile the held socket with the latest handoff: re-attach on a session change, and retry the
 *  attach when we saw the session but no window was up yet. */
function sync(sessionId, repoRoot, socketPath) {
  if (sessionId !== currentSessionId) {
    detach();
    currentSessionId = sessionId;
    attach(sessionId, repoRoot, socketPath);
    return;
  }
  if (!currentSock && !connecting) {
    attach(sessionId, repoRoot, socketPath); // same session, not yet attached (no window earlier) — retry
  }
}

function readHandoff(pid) {
  try {
    const h = JSON.parse(fs.readFileSync(bridge.handoffPath(pid), "utf8"));
    if (
      h &&
      typeof h.sessionId === "string" &&
      typeof h.repoRoot === "string" &&
      typeof h.socketPath === "string"
    ) {
      return h;
    }
  } catch {
    /* not written yet / mid-rename — poll again */
  }
  return null;
}

// Use the hook handoff for reviews too. Besides carrying the session id, it contains the exact
// socket path that successfully received this Codex process's hook traffic, avoiding any ambiguity
// between a worktree and its main checkout.
async function runReview() {
  const handoff =
    (handoffPid !== null ? readHandoff(handoffPid) : null) || latestHandoff;
  if (!handoff) {
    return textResult(
      "Paireto could not identify this Codex session. Send another prompt after the Paireto " +
        "extension and plugin are active, then try the review again.",
      true,
    );
  }
  latestHandoff = handoff;
  if (!fs.existsSync(handoff.socketPath)) {
    return textResult(
      "No VS Code Paireto is listening for this repository. Open the project in VS Code " +
        "with the Paireto extension active and try again.",
      true,
    );
  }

  let conn;
  try {
    conn = await bridge.connectAndHandshake(
      handoff.socketPath,
      bridge.repoKey(handoff.repoRoot),
      CONNECT_TIMEOUT_MS,
    );
  } catch (err) {
    const detail = err && err.message ? ` (${err.message})` : "";
    return textResult(`Could not connect to the VS Code Paireto bridge${detail}.`, true);
  }

  const id = crypto.randomUUID();
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      conn.sock.destroy();
      resolve(result);
    };
    conn.sock.on("close", () => finish(textResult("Review session closed.")));
    bridge.readMessages(conn.sock, conn.residual, (msg) => {
      if (!msg || msg.t !== "review.await.response" || msg.id !== id) {
        return;
      }
      if (msg.status === "submitted" && msg.feedback) {
        finish(textResult(msg.feedback));
      } else {
        finish(textResult("Review approved — proceeding with no changes."));
      }
    });
    bridge.sendLine(conn.sock, {
      t: "review.await.request",
      v: bridge.PLUGIN_VERSION,
      id,
      ts: bridge.nowIso(),
      cwd: handoff.repoRoot,
      repoRoot: handoff.repoRoot,
      sessionId: handoff.sessionId,
    });
  });
}

function watchHandoff() {
  handoffPid = bridge.codexPid();
  const tick = () => {
    const h = readHandoff(handoffPid);
    if (h) {
      latestHandoff = h;
      sync(h.sessionId, h.repoRoot, h.socketPath);
    }
  };
  tick(); // the handoff may already exist (a UserPromptSubmit could precede our first tick)
  const timer = setInterval(tick, HANDOFF_POLL_MS);
  if (timer.unref) {
    timer.unref();
  }
  // fs.watch is a best-effort accelerator on top of the poll; the dir may not exist yet.
  try {
    const dir = path.dirname(bridge.handoffPath(handoffPid));
    fs.mkdirSync(dir, { recursive: true });
    handoffWatcher = fs.watch(dir, () => tick());
    // Resource exhaustion can arrive asynchronously after fs.watch returns. Polling remains the
    // reliable path, so swallow that accelerator-only failure instead of crashing the MCP server.
    handoffWatcher.on("error", () => {
      handoffWatcher = null;
    });
  } catch {
    /* poll still covers it */
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown() {
  if (handoffWatcher) {
    handoffWatcher.close();
    handoffWatcher = null;
  }
  process.exit(0); // ends the process -> held socket closes -> extension clears the agent row
}

function main() {
  watchHandoff();
  process.on("SIGTERM", shutdown); // graceful codex exit SIGTERMs its MCP children
  process.on("SIGHUP", shutdown);
  process.on("SIGINT", shutdown);
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
  process.stdin.on("end", shutdown); // SIGKILL of codex orphans us but closes stdin (~34 ms)
}

main();
