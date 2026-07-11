#!/usr/bin/env node
"use strict";

// Codex liveness MCP stdio server bundled with the paireto Codex adapter.
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
// everywhere (no socket / no handoff -> serve MCP quietly, no liveness). Minimal MCP: answer
// initialize + tools/list (empty) so codex keeps us alive; no tools exposed (Codex reviews via the
// on-stop-gate hook, not an MCP tool).
//
// MCP stdio transport = newline-delimited JSON-RPC 2.0 (no embedded newlines in a message).

const fs = require("node:fs");
const path = require("node:path");

const bridge = require("../scripts/bridge.js");

const SERVER_INFO = { name: "paireto-codex", version: bridge.PLUGIN_VERSION };
const CONNECT_TIMEOUT_MS = 3000;
const HANDOFF_POLL_MS = 500; // fs.watch is flaky on macOS rename; poll as the reliable backstop

// ---------------------------------------------------------------------------
// Minimal MCP JSON-RPC over stdio
// ---------------------------------------------------------------------------

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function handle(msg) {
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
      reply(id, { tools: [] }); // liveness-only; no tools exposed
      return;
    default:
      if (id !== undefined) {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

// ---------------------------------------------------------------------------
// Attach lifecycle — hold one bridge socket open for the active session
// ---------------------------------------------------------------------------

let currentSessionId = null;
let currentSock = null;
let connecting = false;

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

function attach(sessionId, repoRoot) {
  const socketPath = bridge.socketPathFor(repoRoot);
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
function sync(sessionId, repoRoot) {
  if (sessionId !== currentSessionId) {
    detach();
    currentSessionId = sessionId;
    attach(sessionId, repoRoot);
    return;
  }
  if (!currentSock && !connecting) {
    attach(sessionId, repoRoot); // same session, not yet attached (no window earlier) — retry
  }
}

function readHandoff(pid) {
  try {
    const h = JSON.parse(fs.readFileSync(bridge.handoffPath(pid), "utf8"));
    if (h && typeof h.sessionId === "string" && typeof h.repoRoot === "string") {
      return h;
    }
  } catch {
    /* not written yet / mid-rename — poll again */
  }
  return null;
}

function watchHandoff() {
  const pid = bridge.codexPid();
  const tick = () => {
    const h = readHandoff(pid);
    if (h) {
      sync(h.sessionId, h.repoRoot);
    }
  };
  tick(); // the handoff may already exist (a UserPromptSubmit could precede our first tick)
  const timer = setInterval(tick, HANDOFF_POLL_MS);
  if (timer.unref) {
    timer.unref();
  }
  // fs.watch is a best-effort accelerator on top of the poll; the dir may not exist yet.
  try {
    const dir = path.dirname(bridge.handoffPath(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.watch(dir, () => tick());
  } catch {
    /* poll still covers it */
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown() {
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
      handle(msg);
    }
  });
  process.stdin.on("end", shutdown); // SIGKILL of codex orphans us but closes stdin (~34 ms)
}

main();
