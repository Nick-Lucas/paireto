#!/usr/bin/env node
"use strict";

// Blocking plan-gate hook entry. Registered on PermissionRequest matching ExitPlanMode.
// Sends the plan markdown to the extension and BLOCKS until the user approves or requests
// changes, then emits the PermissionRequest decision. Falls back per config on any failure.
//
// PermissionRequest decision shape (confirmed against the plannotator plugin):
//   allow: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
//   deny:  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}}
//   ask:   emit nothing (exit 0) -> defers to Claude Code's native plan-approval prompt.

const crypto = require("node:crypto");
const bridge = require("./bridge.js");

const CONNECT_TIMEOUT_MS = 3000;
const SOFT_TIMEOUT_BUFFER_MS = 5000;

function emitAllow(nextMode) {
  // On allow, optionally set the permission mode the session enters next (e.g. "auto"). Claude Code
  // otherwise restores whatever mode was active before plan mode; `updatedPermissions` overrides that.
  const decision = { behavior: "allow" };
  if (nextMode) {
    decision.updatedPermissions = [{ type: "setMode", mode: nextMode, destination: "session" }];
  }
  writeAndExit(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision,
      },
    })
  );
}

function emitDeny(message) {
  writeAndExit(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message },
      },
    })
  );
}

/** "ask": no decision -> Claude Code shows its native plan-approval prompt. */
function emitAsk() {
  writeAndExit("");
}

function writeAndExit(text) {
  if (text === "") {
    process.exit(0);
    return;
  }
  process.stdout.write(text + "\n", () => process.exit(0));
}

/** Apply a configured fail mode ("fail-open" -> allow, "fail-visible" -> ask). */
function applyFailMode(mode, denyMessage) {
  if (mode === "fail-open") {
    emitAllow();
  } else if (mode === "deny") {
    emitDeny(denyMessage || "Plan review unavailable.");
  } else {
    emitAsk(); // fail-visible
  }
}

async function main() {
  const config = bridge.loadConfig();
  const gate = config.planGate;

  const raw = await bridge.readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    applyFailMode(gate.onMalformed);
    return;
  }

  const toolInput = event.tool_input || {};
  const plan = typeof toolInput.plan === "string" ? toolInput.plan : "";
  const cwd = event.cwd || process.cwd();

  const target = bridge.resolveTarget(cwd);
  if (!target) {
    applyFailMode(gate.onUnavailable);
    return;
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    applyFailMode(gate.onUnavailable);
    return;
  }

  const id = crypto.randomUUID();
  let resolved = false;

  const softTimeoutMs = Math.max(1000, gate.timeoutSeconds * 1000 - SOFT_TIMEOUT_BUFFER_MS);
  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      conn.sock.destroy();
      applyFailMode(gate.onTimeout);
    }
  }, softTimeoutMs);

  conn.sock.on("close", () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      applyFailMode(gate.onTimeout); // socket dropped before a decision arrived
    }
  });

  bridge.readMessages(conn.sock, conn.residual, (msg) => {
    if (resolved) {
      return;
    }
    if (msg && msg.__parseError) {
      resolved = true;
      clearTimeout(timer);
      conn.sock.destroy();
      applyFailMode(gate.onMalformed);
      return;
    }
    if (msg && msg.t === "plan.review.response" && msg.id === id) {
      resolved = true;
      clearTimeout(timer);
      conn.sock.destroy();
      if (msg.decision === "allow") {
        emitAllow(msg.nextMode);
      } else {
        emitDeny(msg.reason || "Plan changes requested.");
      }
    }
  });

  bridge.sendLine(conn.sock, {
    t: "plan.review.request",
    v: bridge.PROTOCOL_VERSION,
    id,
    ts: bridge.nowIso(),
    sessionId: event.session_id,
    agentId: event.agent_id,
    cwd,
    repoRoot: target.repoRoot,
    permissionMode: event.permission_mode,
    toolName: event.tool_name || "ExitPlanMode",
    plan,
  });
}

main().catch(() => {
  // Last-resort: defer to native prompt rather than hang.
  emitAsk();
});
