#!/usr/bin/env node
"use strict";

// The Codex turn-end fork, registered on the Stop hook (alongside the passive on-event.js). Codex
// has no ExitPlanMode/PermissionRequest plan event and no separate review gate, so ONE script keys
// off the Stop payload's permission_mode to serve both surfaces. Fails OPEN everywhere (any socket
// / timeout / malformed error lets the agent stop) so a normal turn-end is never stalled.
//
// Codex Stop decision shape (empirically CONFIRMED Claude-identical, codex-cli 0.144.1):
//   allow: exit 0 with no output.
//   block: {"decision":"block","reason":"..."} -> Codex keeps going and addresses the feedback;
//          the follow-up Stop then carries stop_hook_active:true (guards re-entry).
//
// Fork:
//   - stop_hook_active === true            -> allow (this Stop is our own block's re-injected follow-up).
//   - permission_mode === "plan"           -> PLAN GATE: send plan.review.request with the composed
//                                             plan markdown (last_assistant_message prose + the
//                                             stashed update_plan checklist); allow -> emit nothing
//                                             (stop proceeds, Codex stays in plan mode; the user exits
//                                             it manually); deny -> block with the feedback (agent
//                                             revises the plan).
//   - otherwise                            -> REVIEW GATE: stop.gate.request, block/allow like the
//                                             Claude adapter's on-review-gate.js.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const bridge = require("./bridge.js");

const CONNECT_TIMEOUT_MS = 1500;
const PLAN_CONNECT_TIMEOUT_MS = 3000;
// Max time the plan gate blocks waiting for a decision before failing open (~4 days).
const PLAN_GATE_TIMEOUT_MS = 345600 * 1000;

/** Allow the agent to stop — emit nothing. */
function allow() {
  process.exit(0);
}

/** Block the stop and feed the reason back to Codex so it keeps going. */
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n", () => process.exit(0));
}

/** Best-effort read of the update_plan checklist stashed by on-plan-stash.js. */
function readStashedPlan(sessionId) {
  try {
    const file = path.join(bridge.stateDir(), "codex-plans", `${sessionId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed.plan_markdown === "string" ? parsed.plan_markdown : "";
  } catch {
    return "";
  }
}

/**
 * Compose the plan markdown shown in the gate. The Stop payload's `last_assistant_message` is the
 * plan PROSE (empirically the primary plan text); the stashed `update_plan` array is a structured
 * step CHECKLIST. Prefer the prose, appending the checklist under a heading when both exist; fall
 * back to whichever is present (stash-only when the model never wrote a closing message). Composition
 * stays plugin-side so the gate event is self-contained (plan_markdown unchanged on the wire).
 */
function composePlanText(lastAssistantMessage, stashMarkdown) {
  const prose = typeof lastAssistantMessage === "string" ? lastAssistantMessage.trim() : "";
  const checklist = typeof stashMarkdown === "string" ? stashMarkdown.trim() : "";
  if (prose && checklist) {
    return `${prose}\n\n## Plan\n\n${checklist}`;
  }
  return prose || checklist;
}

/** REVIEW GATE: ask the extension whether a turn-end review should block; fail open on any error. */
async function reviewGate(event, target) {
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
    v: bridge.PLUGIN_VERSION,
    id,
    ts: bridge.nowIso(),
    harness: "codex",
    repoRoot: target.repoRoot,
    event,
  });
}

/** PLAN GATE: present the stashed plan and block until the user approves or requests changes. */
async function planGate(event, target) {
  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, PLAN_CONNECT_TIMEOUT_MS);
  } catch {
    allow(); // couldn't reach the window -> fail open (stop proceeds)
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

  const timer = setTimeout(() => finish(allow), PLAN_GATE_TIMEOUT_MS);
  conn.sock.on("close", () => {
    clearTimeout(timer);
    finish(allow); // socket dropped before a decision -> fail open
  });

  bridge.readMessages(conn.sock, conn.residual, (msg) => {
    if (resolved || !msg || msg.t !== "plan.review.response" || msg.id !== id) {
      return;
    }
    clearTimeout(timer);
    // allow -> emit nothing; Codex stays in plan mode (nextMode is ignored — Codex has no settable
    // approve mode). deny -> block with the feedback so the agent revises the plan.
    if (msg.decision === "deny") {
      finish(() => block(msg.reason || "Plan changes requested."));
    } else {
      finish(allow);
    }
  });

  // Self-contained gate event per the seam invariant: the raw Stop payload plus the adapter-injected
  // plan_markdown (Codex's Stop carries no plan of its own) composed from the message prose + stash.
  const planText = composePlanText(event.last_assistant_message, readStashedPlan(event.session_id));
  bridge.sendLine(conn.sock, {
    t: "plan.review.request",
    v: bridge.PLUGIN_VERSION,
    id,
    ts: bridge.nowIso(),
    harness: "codex",
    repoRoot: target.repoRoot,
    event: { ...event, plan_markdown: planText },
  });
}

async function main() {
  const raw = await bridge.readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    allow(); // malformed input -> fail open
    return;
  }

  if (event.stop_hook_active === true) {
    allow(); // our own block's re-injected follow-up Stop
    return;
  }

  const cwd = event.cwd || process.cwd();
  const target = bridge.resolveTarget(cwd);
  if (!target) {
    allow(); // no window listening -> fail open
    return;
  }

  if (event.permission_mode === "plan") {
    await planGate(event, target);
  } else {
    await reviewGate(event, target);
  }
}

main().catch(() => {
  // Last-resort: let the agent stop rather than hang.
  allow();
});
