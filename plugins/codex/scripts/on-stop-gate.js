#!/usr/bin/env node
"use strict";

// The Codex turn-end fork, registered on the Stop hook (alongside the passive on-event.js). Codex
// has no ExitPlanMode/PermissionRequest plan event and no separate review gate, so ONE script serves
// both surfaces off the Stop payload. Fails OPEN everywhere (any socket / timeout / malformed error
// lets the agent stop) so a normal turn-end is never stalled.
//
// Codex Stop decision shape (empirically CONFIRMED Claude-identical, codex-cli 0.144.1):
//   allow: exit 0 with no output.
//   block: {"decision":"block","reason":"..."} -> Codex keeps going and addresses the feedback;
//          the follow-up Stop then carries stop_hook_active:true.
//
// Fork:
//   - readPlanTurn().isPlanTurn === true   -> PLAN GATE: the ONLY plan-mode signal is the rollout
//                                             transcript (permission_mode is approval-policy-only and
//                                             never "plan", last_assistant_message is null, update_plan
//                                             is rejected in plan mode — see codex-plangate findings).
//                                             Send plan.review.request with the adapter-injected
//                                             plan_markdown (the transcript's Plan item); allow -> emit
//                                             nothing (stop proceeds, Codex stays in plan mode; the
//                                             user exits it manually); deny -> block with the feedback
//                                             (agent revises the plan).
//   - otherwise                            -> REVIEW GATE: stop.gate.request, block/allow like the
//                                             Claude adapter's on-review-gate.js.

const crypto = require("node:crypto");

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
    // allow -> emit nothing; Codex stays in plan mode (nextMode is ignored — Codex has no settable
    // approve mode). deny -> block with the feedback so the agent revises the plan.
    if (msg.decision === "deny") {
      finish(() => block(msg.reason || "Plan changes requested."));
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
