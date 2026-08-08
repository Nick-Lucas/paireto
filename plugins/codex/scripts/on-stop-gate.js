#!/usr/bin/env node
"use strict";

// The Codex turn-end fork for Paireto, registered on Stop alongside the passive on-event.js. Codex
// has no ExitPlanMode/PermissionRequest plan event and no separate review gate, so ONE script serves
// both surfaces off the Stop payload. Fails OPEN everywhere (any socket / timeout / malformed error
// lets the agent stop) so a normal turn-end is never stalled.
//
// Codex Stop decision shape (official Hooks reference + live verification):
//   allow: exit 0 with no output -> the Plan turn finishes and Codex owns the next UI state.
//   block: {"decision":"block","reason":"..."} -> Codex creates a new continuation prompt from
//          reason; the follow-up Stop carries stop_hook_active:true.
// Stop receives permission_mode as INPUT, but has no output field for changing collaboration mode.
// PermissionRequest can approve tool escalations only. Neither hook can select native Plan mode's
// "Implement this plan?" approve-and-switch action.
//
// Fork:
//   - readPlanTurn().isPlanTurn === true   -> PLAN GATE: recover the native Plan item from the rollout
//                                             transcript (permission_mode is not a usable signal).
//                                             Feedback blocks Stop so the continuation prompt revises
//                                             the plan. Approval allows Stop; Codex then presents its
//                                             native approve-and-switch selector to the user.
//   - otherwise                            -> REVIEW GATE: stop.gate.request, block/allow like the
//                                             Claude adapter's on-review-gate.js.

const crypto = require("node:crypto");

const bridge = require("./bridge.js");
const { planGateOutcome } = require("./plan-flow.js");

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

/** PLAN GATE: present the plan (recovered from the rollout transcript) and block until the user
 *  approves or requests changes. */
async function planGate(event, target, planMarkdown) {
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
    const outcome = planGateOutcome(msg);
    if (outcome.decision === "block") {
      finish(() => block(outcome.reason));
    } else {
      finish(allow);
    }
  });

  bridge.sendLine(conn.sock, {
    t: "plan.review.request",
    v: bridge.PLUGIN_VERSION,
    id,
    ts: bridge.nowIso(),
    harness: "codex",
    repoRoot: target.repoRoot,
    event,
    meta: { planMarkdown: planMarkdown ?? "" },
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

  const cwd = event.cwd || process.cwd();
  const target = bridge.resolveTarget(cwd);
  if (!target) {
    allow(); // no window listening -> fail open
    return;
  }

  // The rollout transcript is the ONLY reliable plan-mode discriminator (see readPlanTurn / the
  // codex-plangate findings). Fail-closed there means fail-open here: any transcript doubt -> review.
  const { isPlanTurn, planMarkdown } = bridge.readPlanTurn(event.transcript_path, event.turn_id);
  if (isPlanTurn) {
    await planGate(event, target, planMarkdown);
  } else {
    await reviewGate(event, target);
  }
}

main().catch(() => {
  // Last-resort: let the agent stop rather than hang.
  allow();
});
