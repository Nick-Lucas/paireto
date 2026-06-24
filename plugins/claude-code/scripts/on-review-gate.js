#!/usr/bin/env node
"use strict";

// Blocking review gate on turn-end. Registered on the Stop hook (alongside the passive on-event.js
// telemetry hook). On every turn-end it asks the extension whether a code review should happen
// before the agent finishes; the extension resolves "allow" instantly unless a review for this
// session is in progress or the turn touched files, in which case it blocks until the user resolves
// the review. Fails OPEN (lets the agent stop) on any error so normal turn-ends are never stalled.
//
// Stop decision shape:
//   allow: exit 0 with no output.
//   block: {"decision":"block","reason":"..."} -> Claude keeps going and addresses the feedback.

const crypto = require("node:crypto");
const bridge = require("./bridge.js");

const CONNECT_TIMEOUT_MS = 1500;

/** Allow the agent to stop (no review pending) — emit nothing. */
function allow() {
  process.exit(0);
}

/** Block the stop and feed the review back to Claude so it keeps going. */
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n", () => process.exit(0));
}

async function main() {
  const raw = await bridge.readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    allow();
    return;
  }

  const cwd = event.cwd || process.cwd();
  const target = bridge.resolveTarget(cwd);
  if (!target) {
    allow(); // no extension listening — never block
    return;
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    allow(); // unreachable — fail open
    return;
  }

  const id = crypto.randomUUID();
  let resolved = false;
  const finish = (fn) => {
    if (!resolved) {
      resolved = true;
      conn.sock.destroy();
      fn();
    }
  };

  // If the connection drops before a decision, let the agent stop (fail open).
  conn.sock.on("close", () => finish(allow));

  bridge.readMessages(conn.sock, conn.residual, (msg) => {
    if (resolved || !msg || msg.t !== "stop.gate.response" || msg.id !== id) {
      return;
    }
    if (msg.decision === "block" && msg.reason) {
      finish(() => block(msg.reason));
    } else {
      finish(allow);
    }
  });

  bridge.sendLine(conn.sock, {
    t: "stop.gate.request",
    v: bridge.PROTOCOL_VERSION,
    id,
    ts: bridge.nowIso(),
    cwd,
    repoRoot: target.repoRoot,
    sessionId: event.session_id,
    agentId: event.agent_id,
  });
}

main().catch(() => {
  // Last-resort: let the agent stop rather than hang.
  allow();
});
