#!/usr/bin/env node
"use strict";

// Blocking plan-gate hook entry. Registered on PermissionRequest matching ExitPlanMode.
// Sends the plan markdown to the extension and BLOCKS until the user approves or requests
// changes, then emits the PermissionRequest decision.
//
// Failure behavior is fixed (no longer configurable): if no VS Code window is listening we ALLOW
// (fail-open, so a missing extension never blocks the agent); on a timeout or a malformed response
// we defer to Claude Code's native plan prompt (fail-visible).
//
// PermissionRequest decision shape, per the Claude Code hooks API:
//   allow: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
//   deny:  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}}
//   ask:   emit nothing (exit 0) -> defers to Claude Code's native plan-approval prompt.

const crypto = require("node:crypto");
const bridge = require("./bridge.js");

const CONNECT_TIMEOUT_MS = 3000;
const SOFT_TIMEOUT_BUFFER_MS = 5000;
// Max time the gate blocks waiting for a decision before deferring to the native prompt (~4 days).
const GATE_TIMEOUT_MS = 345600 * 1000;

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

async function main() {
  const raw = await bridge.readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    emitAsk(); // malformed input -> defer to the native prompt
    return;
  }

  const toolInput = event.tool_input || {};
  const plan = typeof toolInput.plan === "string" ? toolInput.plan : "";
  const cwd = event.cwd || process.cwd();

  const target = bridge.resolveTarget(cwd);
  if (!target) {
    emitAllow(); // no window listening -> fail open
    return;
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    emitAllow(); // couldn't reach the window -> fail open
    return;
  }

  const id = crypto.randomUUID();
  let resolved = false;

  const softTimeoutMs = Math.max(1000, GATE_TIMEOUT_MS - SOFT_TIMEOUT_BUFFER_MS);
  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      conn.sock.destroy();
      emitAsk(); // timed out -> defer to the native prompt
    }
  }, softTimeoutMs);

  conn.sock.on("close", () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      emitAsk(); // socket dropped before a decision arrived -> defer to the native prompt
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
      emitAsk(); // malformed response -> defer to the native prompt
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
