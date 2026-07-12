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
//   allow: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{...}}}}
//   deny:  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}}
//   ask:   emit nothing (exit 0) -> defers to Claude Code's native plan-approval prompt.
//
// since ~2.1.199 the CLI silently DISCARDS an allow
// decision for ExitPlanMode unless the decision carries
// `updatedInput` — a bare `{behavior:"allow"}`, or one carrying only `updatedPermissions`, falls
// back to the native "Would you like to proceed?" plan prompt (anthropics/claude-code#74256). With
// the tool's own `tool_input` echoed back UNCHANGED as `updatedInput` (a schema-valid no-op edit),
// the allow is honored AND any `updatedPermissions:[{type:"setMode",...}]` riding alongside is
// applied — the two fields COMPOSE (same fix as backnotprop/plannotator#1008 and
// macintacos/caret#192, which pin exactly this wire shape). So the approve→mode-switch
// (`nextMode` -> setMode) works again as long as the echo is always present. deny was never
// affected (no such field).

const crypto = require("node:crypto");
const bridge = require("./bridge.js");

const CONNECT_TIMEOUT_MS = 3000;
const SOFT_TIMEOUT_BUFFER_MS = 5000;
// Max time the gate blocks waiting for a decision before deferring to the native prompt (~4 days).
const GATE_TIMEOUT_MS = 345600 * 1000;

function emitAllow(toolInput, nextMode) {
  const decision = { behavior: "allow", updatedInput: toolInput || {} };
  if (nextMode) {
    decision.updatedPermissions = [{ type: "setMode", mode: nextMode, destination: "session" }];
  }
  writeAndExit(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision,
      },
    }),
  );
}

function emitDeny(message) {
  writeAndExit(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message },
      },
    }),
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

  const cwd = event.cwd || process.cwd();

  const target = bridge.resolveTarget(cwd);
  if (!target) {
    emitAllow(event.tool_input); // no window listening -> fail open
    return;
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    emitAllow(event.tool_input); // couldn't reach the window -> fail open
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
        emitAllow(event.tool_input, msg.nextMode);
      } else {
        emitDeny(msg.reason || "Plan changes requested.");
      }
    }
  });

  // Pass the raw hook payload through as-is (the plan markdown lives at event.tool_input.plan) —
  // field-specific processing happens in the extension, not here.
  bridge.sendLine(conn.sock, {
    t: "plan.review.request",
    v: bridge.PLUGIN_VERSION,
    id,
    ts: bridge.nowIso(),
    harness: "claudecode",
    repoRoot: target.repoRoot,
    event,
  });
}

main().catch(() => {
  // Last-resort: defer to native prompt rather than hang.
  emitAsk();
});
